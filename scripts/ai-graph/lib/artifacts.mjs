import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';
import { GraphError, sha256 } from './io.mjs';
import { isWithin } from './registry.mjs';
import { compareWorkspaces } from './workspace.mjs';

const MAX_BYTES = 32 * 1024 * 1024;
function content(root, entry) {
  const file = path.join(root, entry.path);
  if (!file.startsWith(`${root}${path.sep}`))
    throw new GraphError('ARTIFACT_PATH', 'Artifact path выходит за workspace');
  for (let cursor = file; cursor !== root; cursor = path.dirname(cursor))
    if (lstatSync(cursor).isSymbolicLink())
      throw new GraphError('ARTIFACT_PATH', 'Artifact path содержит ссылку');
  const handle = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(handle);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== entry.size || stat.size > MAX_BYTES)
      throw new GraphError('ARTIFACT_SOURCE', 'Artifact source изменился или слишком велик');
    const bytes = readFileSync(handle);
    if (sha256(bytes) !== entry.hash)
      throw new GraphError('ARTIFACT_DRIFT', 'Artifact bytes не совпадают с fingerprint');
    return bytes;
  } finally {
    closeSync(handle);
  }
}

/** Ephemeral bytes for exact attempt diff, scoped and hash-bound. Never written to run state/logs. */
export function captureBeforeContents(worktree, fingerprint, definition) {
  const root = realpathSync(worktree),
    result = new Map();
  let size = 0;
  if (!definition.permissions.includes('workspace.source.write')) return result;
  for (const entry of fingerprint.files)
    if (definition.resources.writes.some((prefix) => isWithin(entry.path, prefix))) {
      size += entry.size;
      if (size > MAX_BYTES)
        throw new GraphError(
          'ARTIFACT_SCOPE_LIMIT',
          'Write scope превышает 32 MiB; разделите задачу',
        );
      result.set(entry.path, content(root, entry));
    }
  return result;
}

function text(bytes) {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
function sensitive(value) {
  return /-----BEGIN .*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{16,}|\b(?:Bearer\s+[A-Za-z0-9._-]{12,})/i.test(
    value,
  );
}
function lines(value, prefix) {
  if (!value) return '';
  const split = value.split('\n'),
    newline = split.at(-1) === '';
  if (newline) split.pop();
  return (
    split.map((line) => `${prefix}${line}\n`).join('') +
    (newline ? '' : '\\ No newline at end of file\n')
  );
}
const count = (value) => (value ? value.split('\n').length - (value.endsWith('\n') ? 1 : 0) : 0);

/** Complete bounded unified diff against bytes captured before this exact attempt, not Git HEAD. */
export function buildAttemptDiff(worktree, before, after, beforeContents) {
  const root = realpathSync(worktree),
    old = new Map(before.files.map((e) => [e.path, e])),
    next = new Map(after.files.map((e) => [e.path, e]));
  const patches = [];
  let size = 0,
    complete = true;
  for (const file of compareWorkspaces(before, after)) {
    if (file.startsWith('@git/')) {
      complete = false;
      patches.push(`Git metadata changed: ${file}\n`);
      continue;
    }
    const previous = old.get(file),
      current = next.get(file),
      oldBytes = previous ? beforeContents.get(file) : Buffer.alloc(0),
      newBytes = current ? content(root, current) : Buffer.alloc(0);
    if (!oldBytes || (previous && sha256(oldBytes) !== previous.hash))
      throw new GraphError('DIFF_BEFORE_MISSING', 'Отсутствуют проверенные bytes начала попытки');
    const a = text(oldBytes),
      b = text(newBytes),
      header = `diff --git ${JSON.stringify(`a/${file}`)} ${JSON.stringify(`b/${file}`)}\n${!previous ? `new file mode ${current.mode}\n` : !current ? `deleted file mode ${previous.mode}\n` : previous.mode !== current.mode ? `old mode ${previous.mode}\nnew mode ${current.mode}\n` : ''}`;
    let patch;
    if (a === null || b === null)
      patch = `${header}Binary evidence: ${previous?.hash ?? 'absent'} -> ${current?.hash ?? 'absent'}; sizes ${oldBytes.length} -> ${newBytes.length}\n`;
    else if (sensitive(a) || sensitive(b)) {
      patch = `${header}Content withheld: sensitive marker; hashes ${previous?.hash ?? 'absent'} -> ${current?.hash ?? 'absent'}\n`;
      complete = false;
    } else
      patch = `${header}--- ${previous ? JSON.stringify(`a/${file}`) : '/dev/null'}\n+++ ${current ? JSON.stringify(`b/${file}`) : '/dev/null'}\n@@ -${count(a) ? 1 : 0},${count(a)} +${count(b) ? 1 : 0},${count(b)} @@\n${lines(a, '-')}${lines(b, '+')}`;
    size += Buffer.byteLength(patch);
    if (size > 3 * 1024 * 1024) {
      patches.push('Diff exceeds 3 MiB; split this task.\n');
      complete = false;
      break;
    }
    patches.push(patch);
  }
  return { content: patches.join(''), complete };
}
