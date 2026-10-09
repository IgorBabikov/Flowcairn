import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { noFollowReadFlags } from './host-filesystem.mjs';
import { GraphError, hashObject, sha256 } from './io.mjs';
import { isSensitivePath, hasSecretContent } from './source-policy.mjs';

const fail = (code, message) => { throw new GraphError(code, message); };
const identity = (s) => [s.dev, s.ino, s.mode, s.nlink, s.size, s.mtimeNs, s.ctimeNs].join(':');
const within = (root, file) => file === root || file.startsWith(root + path.sep);

/** Inspect bytes only. An executable --version is a command, never a discovery probe. */
export function checkFileIdentity(file, { executable = false, opaque = false, maxBytes = 16 * 1024 * 1024 } = {}) {
  const before = lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || (!executable && before.nlink !== 1n) || before.size > BigInt(maxBytes))
    fail('CHECK_INPUT_UNSAFE', 'Инструмент или вход проверки должен быть ограниченным обычным файлом.');
  if (executable && process.platform !== 'win32' && (!(before.mode & 0o111n) || (before.mode & 0o002n) ||
      process.getuid?.() !== undefined && before.uid !== 0n && before.uid !== BigInt(process.getuid())))
    fail('CHECK_EXECUTABLE_UNSAFE', 'Инструмент проверки имеет небезопасные права или владельца.');
  const fd = openSync(file, noFollowReadFlags());
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (identity(opened) !== identity(before)) fail('CHECK_INPUT_DRIFT', 'Вход проверки изменился до чтения.');
    const bytes = readFileSync(fd);
    if (BigInt(bytes.length) !== before.size || identity(fstatSync(fd, { bigint: true })) !== identity(before) ||
        identity(lstatSync(file, { bigint: true })) !== identity(before)) fail('CHECK_INPUT_DRIFT', 'Вход проверки изменился во время чтения.');
    if (!executable && !opaque && hasSecretContent(bytes.toString('utf8'))) fail('CHECK_INPUT_UNSAFE', 'Вход проверки исключен политикой секретов.');
    return { hash: sha256(bytes), bytes: bytes.length, mode: Number(before.mode & 0o777n) };
  } finally { closeSync(fd); }
}

export function containedCheckPath(root, relative, { missing = false } = {}) {
  const base = realpathSync(root);
  if (relative === '.') return base;
  if (!relative || path.isAbsolute(relative) || /[\\\0\r\n]/.test(relative) || relative.split('/').some((s) => !s || s === '.' || s === '..') || isSensitivePath(relative))
    fail('CHECK_PATH_UNSAFE', 'Путь проверки должен находиться в проекте вне закрытых каталогов.');
  let current = base;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) fail('CHECK_PATH_UNSAFE', 'Путь проверки не может проходить через ссылку.'); }
    catch (error) { if (missing && error.code === 'ENOENT') continue; throw error; }
  }
  if (!within(base, current)) fail('CHECK_PATH_UNSAFE', 'Путь проверки вышел за проект.');
  return current;
}

// Preserve the invoked name (venv and multicall programs use it), while binding
// every alias and physical ancestor separately from the canonical target bytes.
function executablePathIdentity(candidate) {
  const chain = [];
  let pending = path.resolve(candidate), links = 0;
  while (true) {
    let current = path.parse(pending).root;
    const parts = pending.slice(current.length).split(path.sep).filter(Boolean);
    let redirected = false;
    for (const [index, part] of parts.entries()) {
      current = path.join(current, part);
      const stat = lstatSync(current, { bigint: true });
      if (stat.isSymbolicLink()) {
        if (++links > 40) fail('CHECK_EXECUTABLE_UNSAFE', 'Цепочка ссылок инструмента превышает безопасный предел.');
        const target = readlinkSync(current);
        chain.push({ path: current, link: target, identity: identity(stat) });
        pending = path.resolve(path.dirname(current), target, ...parts.slice(index + 1));
        redirected = true;
        break;
      }
      // Child creation must not invalidate a directory identity; replacement must.
      chain.push({ path: current, identity: stat.isDirectory()
        ? [stat.dev, stat.ino, stat.mode, stat.uid].join(':') : identity(stat) });
      if (index < parts.length - 1 && !stat.isDirectory())
        fail('CHECK_EXECUTABLE_UNSAFE', 'Предок инструмента не является каталогом.');
    }
    if (!redirected) return { canonicalPath: current, chain };
  }
}

function relativeExecutablePath(root, requested) {
  if (!requested || path.isAbsolute(requested) || /[\\\0\r\n]/.test(requested) ||
      requested.split('/').some((part) => !part || part === '.' || part === '..') || isSensitivePath(requested))
    fail('CHECK_PATH_UNSAFE', 'Путь инструмента должен находиться в проекте вне закрытых каталогов.');
  // Only the explicit executable leaf may be an alias; project directories remain physical.
  return path.join(containedCheckPath(root, path.posix.dirname(requested)), path.posix.basename(requested));
}

export function resolveCheckExecutable(root, requested, env = process.env) {
  const projectRelative = requested?.startsWith('./');
  if (requested?.startsWith('./')) requested = requested.slice(2);
  if (!requested || /[\0\r\n]/.test(requested) || /\.(?:cmd|bat|ps1)$/i.test(requested))
    fail('CHECK_EXECUTABLE_UNSAFE', 'Shell launcher не является зарегистрированным executable.');
  const candidates = path.isAbsolute(requested) ? [requested]
    : projectRelative || /[/\\]/.test(requested) ? [relativeExecutablePath(root, requested)]
      : (env.PATH ?? '').split(path.delimiter).filter(path.isAbsolute).flatMap((dir) =>
        process.platform === 'win32' && !path.extname(requested) ? [path.join(dir, `${requested}.exe`)] : [path.join(dir, requested)]);
  for (const candidate of candidates) {
    let before;
    try { before = executablePathIdentity(candidate); } catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) continue; throw error; }
    if (/\.(?:cmd|bat|ps1)$/i.test(before.canonicalPath)) fail('CHECK_EXECUTABLE_UNSAFE', 'Shell launcher не поддерживается.');
    const file = checkFileIdentity(before.canonicalPath, { executable: true, maxBytes: 256 * 1024 * 1024 });
    if (hashObject(executablePathIdentity(candidate)) !== hashObject(before) || realpathSync(candidate) !== before.canonicalPath)
      fail('CHECK_INPUT_DRIFT', 'Цепочка ссылок инструмента изменилась во время проверки.');
    return { executable: path.resolve(candidate), canonicalPath: before.canonicalPath,
      invocationIdentityHash: hashObject(before), ...file };
  }
  fail('CHECK_EXECUTABLE_MISSING', `Не найден инструмент проверки: ${requested}`);
}

export function inspectCheckInputs(root, inputPaths) {
  const entries = []; let bytes = 0;
  const visit = (relative, depth = 0) => {
    if (depth > 24 || entries.length >= 2048) fail('CHECK_INPUT_LIMIT', 'Входы проверки превышают лимит.');
    const file = containedCheckPath(root, relative), stat = lstatSync(file);
    if (stat.isDirectory()) {
      const before = lstatSync(file, { bigint: true });
      entries.push({ path: relative, kind: 'directory' });
      for (const name of readdirSync(file).sort()) visit(`${relative}/${name}`, depth + 1);
      if (identity(lstatSync(file, { bigint: true })) !== identity(before)) fail('CHECK_INPUT_DRIFT', 'Каталог входов проверки изменился.');
    } else {
      const record = checkFileIdentity(file); bytes += record.bytes;
      if (bytes > 32 * 1024 * 1024) fail('CHECK_INPUT_LIMIT', 'Входы проверки превышают 32 MiB.');
      entries.push({ path: relative, ...record });
    }
  };
  for (const input of [...inputPaths].sort()) visit(input);
  return { hash: hashObject(entries),
    // Git worktrees preserve the executable bit, not all permission bits.
    portableHash: hashObject(entries.map((entry) => 'mode' in entry ? { ...entry, mode: entry.mode & 0o111 ? '100755' : '100644' } : entry)) };
}

export const checkInputManifest = (root, inputPaths) => inspectCheckInputs(root, inputPaths).hash;

/** Presence and opaque hashes only: private manager configuration never enters a prompt or receipt. */
export function packageCheckConfigHash(root, manager) {
  const names = { npm: ['.npmrc'], pnpm: ['.npmrc', 'pnpm-workspace.yaml', '.pnpmfile.cjs'],
    yarn: ['.yarnrc.yml', '.yarnrc', '.pnp.cjs', '.pnp.loader.mjs'] }[manager];
  if (!names) fail('CHECK_REGISTRY_DRIFT', 'Неизвестный менеджер проверки.');
  return hashObject(names.map((name) => {
    const file = path.join(root, name);
    try { lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return { name, absent: true }; throw error; }
    return { name, ...checkFileIdentity(file, { opaque: true, maxBytes: 256 * 1024 }) };
  }));
}
