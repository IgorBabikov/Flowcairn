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
import { MAX_DIFF_BYTES, unifiedDiff } from './unified-diff.mjs';
import { CHANGE_EVIDENCE_FORMAT, STRUCTURAL_FILE_BYTES, deletionEvidence, encodeChangeEvidence, fileVersion, jsonEntryEvidence } from './change-evidence.mjs';

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
const incomplete = (reason) => ({ content: `${reason}\n`, complete: false, mediaType: 'text/x-diff' });

/** Exact attempt operations. Structural records are deterministic evidence, never an AI summary. */
export function buildAttemptDiff(worktree, before, after, beforeContents) {
  const root = realpathSync(worktree);
  const old = new Map(before.files.map((entry) => [entry.path, entry]));
  const next = new Map(after.files.map((entry) => [entry.path, entry]));
  const changedPaths = compareWorkspaces(before, after);
  if (changedPaths.some((file) => file.startsWith('@git/')))
    return incomplete('Git metadata changed: attempt evidence is incomplete');
  const records = [];
  let bytesRead = 0;
  for (const file of changedPaths) {
    const previous = old.get(file), current = next.get(file);
    const oldBytes = previous ? beforeContents.get(file) : Buffer.alloc(0);
    const newBytes = current ? content(root, current) : Buffer.alloc(0);
    if (!oldBytes || previous && (oldBytes.length !== previous.size || sha256(oldBytes) !== previous.hash))
      throw new GraphError('DIFF_BEFORE_MISSING', 'Отсутствуют проверенные bytes начала попытки');
    bytesRead += newBytes.length;
    if (bytesRead > MAX_BYTES) throw new GraphError('ARTIFACT_SCOPE_LIMIT', 'Измененный результат превышает 32 MiB');
    // Scan raw bytes before move/JSON/delete optimization, including binary files.
    if (sensitive(oldBytes.toString('utf8')) || sensitive(newBytes.toString('utf8')))
      return incomplete('Content withheld: sensitive marker; attempt evidence is incomplete');
    records.push({ file, previous, current, oldBytes, newBytes });
  }
  const operations = [], consumed = new Set();
  for (const removed of records.filter((record) => record.previous && !record.current)) {
    const added = records.find((record) => !consumed.has(record.file) && !record.previous && record.current &&
      record.current.hash === removed.previous.hash && record.current.size === removed.previous.size &&
      record.current.mode === removed.previous.mode && record.newBytes.equals(removed.oldBytes));
    if (!added) continue;
    consumed.add(removed.file); consumed.add(added.file);
    operations.push({ kind: 'move', from: removed.file, to: added.file,
      before: fileVersion(removed.previous), after: fileVersion(added.current), byteIdentical: true });
  }
  for (const record of records) {
    const { file, previous, current, oldBytes, newBytes } = record;
    if (consumed.has(file)) continue;
    if (!current && previous.size >= STRUCTURAL_FILE_BYTES) {
      operations.push(deletionEvidence(file, previous, oldBytes));
      continue;
    }
    const json = jsonEntryEvidence(file, previous, current, oldBytes, newBytes);
    if (json) { operations.push(json); continue; }
    if (text(oldBytes) === null || text(newBytes) === null)
      return incomplete('Binary evidence: changed binary content requires a dedicated verifier');
    try {
      operations.push({ kind: 'text', path: file, before: fileVersion(previous), after: fileVersion(current),
        patch: unifiedDiff(file, previous, current, oldBytes, newBytes) });
    } catch (error) {
      if (error instanceof GraphError && error.code === 'DIFF_UNAVAILABLE')
        return incomplete('Diff exceeds available time or output budget; exact hunks unavailable');
      throw error;
    }
  }
  const structural = operations.some((operation) => operation.kind !== 'text');
  if (!structural) {
    const patch = operations.map((operation) => 'patch' in operation ? operation.patch : '').join('');
    return Buffer.byteLength(patch) <= MAX_DIFF_BYTES ? { content: patch, complete: true, mediaType: 'text/x-diff' }
      : incomplete('Diff exceeds 3 MiB; split this task');
  }
  try {
    return { content: encodeChangeEvidence(before, after, changedPaths, operations), complete: true,
      mediaType: 'application/json', format: CHANGE_EVIDENCE_FORMAT };
  } catch (error) {
    if (error instanceof GraphError && error.code === 'REVIEW_EVIDENCE_INVALID')
      return incomplete('Diff exceeds structural evidence limits or contains unsupported operations');
    throw error;
  }
}
