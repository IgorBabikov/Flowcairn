import { lstatHostSync as lstatSync, fstatHostSync as fstatSync } from './host-filesystem.mjs';
import { fsyncParentDirectory } from './host-filesystem.mjs';
import { classifySource, assertSafeText } from './source-policy.mjs';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
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
import { JSON_TRANSFER_LIMITS, prepareJsonTransfers, validateJsonTransfers } from './json-transfers.mjs';

const MAX_EDITS = 100;
const MAX_MOVES = 100;
const MAX_EDIT_BYTES = 128 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

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
  if (classifySource(normalized, undefined).reason) deny('Patch затрагивает protected path');
  return normalized;
}

function fileMode(stat) {
  return stat.mode & 0o111 ? '100755' : '100644';
}

function fsyncDirectory(directory) {
  fsyncParentDirectory(directory);
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
  const body = readFileSync(handle);
  assertSafeText(body.toString('utf8'));
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.size !== expected.size ||
    fileMode(stat) !== expected.mode ||
    sha256(body) !== expected.hash
  ) {
    deny('Файл изменился после начала попытки');
  }
  return { dev: stat.dev, ino: stat.ino };
}

function verifyExisting(target, expected) {
  const handle = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
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
  if (edit.content !== null) assertSafeText(edit.content);
  const size = edit.content === null ? 0 : Buffer.byteLength(edit.content);
  if (size > MAX_EDIT_BYTES) deny('Один edit превышает 128 KiB');
  return { ...edit, path: editPath, size };
}

function validateMove(move) {
  if (!move || typeof move !== 'object' || Array.isArray(move)) deny('Move должен быть объектом');
  if (Object.keys(move).sort().join(',') !== 'from,previousHash,to') deny('Move содержит недопустимые поля');
  const from = safeEditPath(move.from);
  const to = safeEditPath(move.to);
  if (from === to) deny('Move не может указывать один и тот же путь');
  if (!HASH_PATTERN.test(move.previousHash)) deny('Move previousHash недопустим');
  return { from, to, previousHash: move.previousHash };
}

function preflight(root, before, node, task, edits, moves, jsonTransfers, denyGlobs) {
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
  if (!Array.isArray(moves) || moves.length > MAX_MOVES) deny('Moves должны быть bounded массивом');
  const normalizedMoves = moves.map(validateMove);
  const normalizedTransfers = validateJsonTransfers(jsonTransfers, safeEditPath);
  const claimedPaths = [
    ...normalized.map((edit) => edit.path),
    ...normalizedMoves.flatMap((move) => [move.from, move.to]),
  ];
  if ([...claimedPaths, ...normalizedTransfers.flatMap((item) => [item.from, item.to])].some((file) => classifySource(file, undefined, { denyGlobs }).reason)) deny('Patch запрещен локальной политикой');
  if (new Set(claimedPaths).size !== claimedPaths.length)
    deny('Edits и moves не могут использовать один путь дважды');
  const transferredPaths = new Set(normalizedTransfers.flatMap((transfer) => [transfer.from, transfer.to]));
  if ([...transferredPaths].some((file) => claimedPaths.some((claimed) => isWithin(file, claimed) || isWithin(claimed, file))))
    deny('JsonTransfers не могут затрагивать paths из edits или moves');
  if (normalizedTransfers.length && new Set([...claimedPaths, ...transferredPaths]).size > 100) deny('JsonTransfers затрагивают слишком много файлов');
  if ([...transferredPaths].some((file) => [...transferredPaths].some((other) => file !== other && isWithin(file, other))))
    deny('JsonTransfers содержат конфликт file/ancestor paths');
  if (normalized.reduce((total, edit) => total + edit.size, 0) > MAX_TOTAL_BYTES) {
    deny('Patch превышает 1 MiB; разделите задачу');
  }

  const preparedEdits = normalized.map((edit) => {
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
  const preparedMoves = normalizedMoves.map((move) => {
    if (!pathAllowed(move.from, task) || !pathAllowed(move.to, task) ||
        !writeScopes.some((scope) => isWithin(move.from, scope)) ||
        !writeScopes.some((scope) => isWithin(move.to, scope)))
      deny('Move выходит за approved scope');
    inspectParents(root, move.from);
    inspectParents(root, move.to);
    const source = targetPath(root, move.from);
    const target = targetPath(root, move.to);
    const expected = files.get(move.from) ?? null;
    if (!expected || expected.hash !== move.previousHash) deny('Move previousHash не совпадает с началом попытки');
    if (!inspectTarget(source) || inspectTarget(target)) deny('Move source или target изменился');
    verifyExisting(source, expected);
    return { move, expected, source, target };
  });
  const transferredFiles = prepareJsonTransfers(normalizedTransfers, (file, previousHash) => {
    if (!pathAllowed(file, task) || !writeScopes.some((scope) => isWithin(file, scope))) deny('JsonTransfer выходит за approved scope');
    inspectParents(root, file);
    const target = targetPath(root, file), current = inspectTarget(target), expected = files.get(file) ?? null;
    if (previousHash !== (expected?.hash ?? null)) deny('JsonTransfer BEFORE hash не совпадает');
    if (!expected) {
      if (current) deny('JsonTransfer target существует вне BEFORE fingerprint');
      return null;
    }
    if (!current || expected.size > JSON_TRANSFER_LIMITS.fileBytes) deny('JsonTransfer source отсутствует или превышает 8 MiB');
    const handle = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fstatSync(handle);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== expected.size || fileMode(stat) !== expected.mode) deny('JsonTransfer source изменился');
      const bytes = readFileSync(handle);
      assertSafeText(bytes.toString('utf8'));
      if (bytes.length !== expected.size || sha256(bytes) !== expected.hash) deny('JsonTransfer source bytes изменились');
      verifyIdentity(target, { dev: stat.dev, ino: stat.ino });
      return bytes;
    } finally { closeSync(handle); }
  }).map((edit) => ({ edit: { ...edit, executable: files.get(edit.path)?.mode === '100755' }, expected: files.get(edit.path) ?? null, target: targetPath(root, edit.path) }));
  return { edits: preparedEdits, moves: preparedMoves, transferredFiles };
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
  const handle = openSync(item.target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
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

function applyMove(root, item) {
  inspectParents(root, item.move.from);
  inspectParents(root, item.move.to);
  const identity = verifyExisting(item.source, item.expected);
  if (inspectTarget(item.target)) deny('Move target появился перед применением');
  ensureParents(root, item.move.to);
  verifyIdentity(item.source, identity);
  renameSync(item.source, item.target);
  fsyncDirectory(path.dirname(item.source));
  if (path.dirname(item.target) !== path.dirname(item.source)) fsyncDirectory(path.dirname(item.target));
}

/** AI has no write access. Only this trusted handler applies schema-validated, hash-bound edits. */
export function applyProposedEdits(worktree, before, node, task, edits, moves = [], jsonTransfers = [], { denyGlobs = [] } = {}) {
  const requested = lstatSync(worktree);
  if (!requested.isDirectory() || requested.isSymbolicLink())
    deny('Worktree должен быть директорией');
  const root = realpathSync(worktree);
  const batch = preflight(root, before, node, task, edits, moves, jsonTransfers, denyGlobs);
  // Every edit is preflighted before the first write. A later I/O/race failure remains uncertain.
  for (const item of batch.moves) applyMove(root, item);
  for (const item of batch.edits) {
    if (item.edit.content === null) applyDelete(root, item);
    else applyWrite(root, item);
  }
  for (const item of batch.transferredFiles) applyWrite(root, item);
}
