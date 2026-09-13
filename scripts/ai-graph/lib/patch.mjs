import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { GraphError, sha256 } from './io.mjs';
import { isWithin, pathAllowed } from './registry.mjs';

const MAX_EDITS = 100;
const MAX_EDIT_BYTES = 128 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const PROTECTED_SEGMENTS = new Set([
  '.git',
  '.ai-orchestrator',
  '.next',
  'dist',
  'node_modules',
  '.npmrc',
  '.pypirc',
  '.netrc',
  'credentials',
  'credentials.json',
  'id_rsa',
  'id_ed25519',
]);

function deny(message) {
  throw new GraphError('PATCH_DENIED', message);
}

function existsNoFollow(candidate) {
  try {
    lstatSync(candidate);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function relativePath(value, { scope = false } = {}) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 512 ||
    Buffer.byteLength(value) > 4096 ||
    value.includes('\0') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[a-z]:/i.test(value)
  ) {
    deny('Patch path недопустим');
  }
  const normalized = scope && value.endsWith('/') ? value.slice(0, -1) : value;
  const parts = normalized.split('/');
  if (!normalized || parts.some((part) => !part || part === '.' || part === '..')) {
    deny('Patch path содержит пустой или небезопасный сегмент');
  }
  return normalized;
}

function safeEditPath(value) {
  const normalized = relativePath(value);
  for (const original of normalized.split('/')) {
    const part = original.toLowerCase();
    const allowedEnvironmentTemplate = /^\.env(?:\.[^/]+)*\.(?:example|sample|template)$/.test(
      part,
    );
    if (
      PROTECTED_SEGMENTS.has(part) ||
      (!allowedEnvironmentTemplate && (part === '.env' || part.startsWith('.env.'))) ||
      /(?:^|[._-])secrets?(?:[._-](?:json|ya?ml|toml|txt))?$/.test(part) ||
      /\.(?:key|pem|p12|pfx)$/.test(part)
    ) {
      deny('Patch затрагивает protected path');
    }
  }
  return normalized;
}

function fileMode(stat) {
  return stat.mode & 0o111 ? '100755' : '100644';
}

function fsyncDirectory(directory) {
  const handle = openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

function ensureParents(root, relativePath) {
  const parts = relativePath.split('/');
  let cursor = root;
  for (const part of parts.slice(0, -1)) {
    const parent = cursor;
    cursor = path.join(cursor, part);
    if (!existsNoFollow(cursor)) {
      mkdirSync(cursor, { mode: 0o700 });
      fsyncDirectory(parent);
    }
    const stat = lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      deny('Patch ancestor должен быть физической директорией');
    }
  }
}

function targetPath(root, relativePath) {
  const target = path.resolve(root, ...relativePath.split('/'));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    deny('Patch выходит за workspace');
  }
  return target;
}

function inspectParents(root, relativePath) {
  const parts = relativePath.split('/');
  let cursor = root;
  let missing = false;
  for (const part of parts.slice(0, -1)) {
    cursor = path.join(cursor, part);
    if (missing || !existsNoFollow(cursor)) {
      missing = true;
      continue;
    }
    const stat = lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      deny('Patch ancestor содержит ссылку или не является директорией');
    }
  }
}

function inspectTarget(target) {
  if (!existsNoFollow(target)) return null;
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    deny('Patch target должен быть regular file без ссылок');
  }
  return stat;
}

function verifyDescriptor(handle, expected) {
  const stat = fstatSync(handle);
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.size !== expected.size ||
    fileMode(stat) !== expected.mode ||
    sha256(readFileSync(handle)) !== expected.hash
  ) {
    deny('Файл изменился после начала попытки');
  }
  return { dev: stat.dev, ino: stat.ino };
}

function verifyExisting(target, expected) {
  const handle = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return verifyDescriptor(handle, expected);
  } finally {
    closeSync(handle);
  }
}

function verifyIdentity(target, identity) {
  const stat = inspectTarget(target);
  if (!stat || stat.dev !== identity.dev || stat.ino !== identity.ino) {
    deny('Patch target сменился во время применения');
  }
}

function validateEdit(edit) {
  if (!edit || typeof edit !== 'object' || Array.isArray(edit)) deny('Edit должен быть объектом');
  const keys = Object.keys(edit).sort();
  if (keys.join(',') !== 'content,executable,path,previousHash') {
    deny('Edit содержит недопустимые поля');
  }
  const editPath = safeEditPath(edit.path);
  if (edit.previousHash !== null && !HASH_PATTERN.test(edit.previousHash)) {
    deny('previousHash недопустим');
  }
  if (edit.content !== null && typeof edit.content !== 'string') deny('content недопустим');
  if (typeof edit.executable !== 'boolean') deny('executable недопустим');
  if (edit.content === null && edit.executable) deny('Удаление не может менять executable mode');
  const size = edit.content === null ? 0 : Buffer.byteLength(edit.content);
  if (size > MAX_EDIT_BYTES) deny('Один edit превышает 128 KiB');
  return { ...edit, path: editPath, size };
}

function preflight(root, before, node, task, edits) {
  if (!Array.isArray(node?.permissions) || !node.permissions.includes('workspace.source.write')) {
    deny('Нет разрешения source.write');
  }
  if (!Array.isArray(node?.resources?.writes) || !node.resources.writes.length) {
    deny('Отсутствует approved write scope');
  }
  if (!Array.isArray(task?.scope) || !Array.isArray(task?.forbiddenPaths)) {
    deny('Task scope недопустим');
  }
  const writeScopes = node.resources.writes.map((value) => relativePath(value, { scope: true }));
  task.scope.forEach((value) => relativePath(value, { scope: true }));
  task.forbiddenPaths.forEach((value) => relativePath(value, { scope: true }));
  if (!Array.isArray(edits) || edits.length > MAX_EDITS) deny('Edits должны быть bounded массивом');
  if (!before || !Array.isArray(before.files) || before.files.length > 20_000) {
    deny('Before fingerprint недопустим');
  }

  const files = new Map();
  for (const file of before.files) {
    if (
      !file ||
      typeof file !== 'object' ||
      typeof file.path !== 'string' ||
      !HASH_PATTERN.test(file.hash) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      !['100644', '100755'].includes(file.mode) ||
      files.has(file.path)
    ) {
      deny('Before fingerprint содержит недопустимый file record');
    }
    files.set(relativePath(file.path), file);
  }

  const normalized = edits.map(validateEdit);
  if (new Set(normalized.map((edit) => edit.path)).size !== normalized.length) {
    deny('Один файл указан несколько раз');
  }
  if (normalized.reduce((total, edit) => total + edit.size, 0) > MAX_TOTAL_BYTES) {
    deny('Patch превышает 1 MiB; разделите задачу');
  }

  return normalized.map((edit) => {
    if (!pathAllowed(edit.path, task) || !writeScopes.some((scope) => isWithin(edit.path, scope))) {
      deny('Patch выходит за approved scope');
    }
    inspectParents(root, edit.path);
    const target = targetPath(root, edit.path);
    const current = inspectTarget(target);
    const expected = files.get(edit.path) ?? null;
    if (edit.previousHash !== (expected?.hash ?? null)) {
      deny('Previous hash не совпадает с началом попытки');
    }
    if (expected) {
      if (!current) deny('Файл исчез после начала попытки');
      verifyExisting(target, expected);
    } else if (current || edit.content === null) {
      deny('Нельзя перезаписать неизвестный файл или удалить отсутствующий');
    }
    return { edit, expected, target };
  });
}

function recheck(root, item) {
  inspectParents(root, item.edit.path);
  const current = inspectTarget(item.target);
  if (!item.expected) {
    if (current) deny('Новый Patch target уже существует');
    return null;
  }
  if (!current) deny('Patch target исчез перед применением');
  return verifyExisting(item.target, item.expected);
}

function applyDelete(root, item) {
  const identity = recheck(root, item);
  const handle = openSync(item.target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const current = verifyDescriptor(handle, item.expected);
    if (current.dev !== identity.dev || current.ino !== identity.ino) {
      deny('Patch target сменился перед удалением');
    }
    verifyIdentity(item.target, identity);
    fsyncSync(handle);
    unlinkSync(item.target);
  } finally {
    closeSync(handle);
  }
  fsyncDirectory(path.dirname(item.target));
}

function applyWrite(root, item) {
  inspectParents(root, item.edit.path);
  ensureParents(root, item.edit.path);
  const temporary = path.join(path.dirname(item.target), `.graph-patch-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = openSync(temporary, 'wx', item.edit.executable ? 0o755 : 0o644);
    writeFileSync(handle, item.edit.content);
    fsyncSync(handle);
    closeSync(handle);
    handle = undefined;
    const identity = recheck(root, item);
    if (identity) verifyIdentity(item.target, identity);
    renameSync(temporary, item.target);
    fsyncDirectory(path.dirname(item.target));
  } catch (error) {
    if (handle !== undefined) closeSync(handle);
    if (existsNoFollow(temporary)) unlinkSync(temporary);
    throw error;
  }
}

/** AI has no write access. Only this trusted handler applies schema-validated, hash-bound edits. */
export function applyProposedEdits(worktree, before, node, task, edits) {
  const requested = lstatSync(worktree);
  if (!requested.isDirectory() || requested.isSymbolicLink())
    deny('Worktree должен быть директорией');
  const root = realpathSync(worktree);
  const batch = preflight(root, before, node, task, edits);
  // Every edit is preflighted before the first write. A later I/O/race failure remains uncertain.
  for (const item of batch) {
    if (item.edit.content === null) applyDelete(root, item);
    else applyWrite(root, item);
  }
}
