import { lstatHostSync as lstatSync, fstatHostSync as fstatSync } from './host-filesystem.mjs';
import { gitExecutable, hostNullDevice, hostSystemEnvironment } from './host-executables.mjs';
import { isPrivateMode } from './host-filesystem.mjs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { GraphError, canonicalJson, sha256 } from './io.mjs';
import { hasSecretContent, isSensitivePath } from './source-policy.mjs';
import { fingerprintProjectSource } from './project-source-access.mjs';

const GIT_EXECUTABLE = gitExecutable();
const SOURCE_BUNDLE_VERSION = 2;
const MAX_ENTRIES = 20_000;
const MAX_PATH_BYTES = 4_096;
const MAX_SYMLINK_BYTES = 4_096;
const MAX_OBJECT_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const OID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const FILE_MODES = new Set(['100644', '100755']);
const ALL_MODES = new Set([...FILE_MODES, '120000']);
const utf8 = new TextDecoder('utf-8', { fatal: true });

function fail(code, message, details) {
  throw new GraphError(code, message, details);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_SOURCE_BUNDLE', `${label} должен быть объектом`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail('INVALID_SOURCE_BUNDLE', `${label} содержит недопустимые поля`);
  }
}

function decodePath(buffer, label = 'Git path') {
  let value;
  try {
    value = utf8.decode(buffer);
  } catch {
    fail('UNSAFE_SOURCE_PATH', `${label} должен быть корректным UTF-8`);
  }
  return assertSafePath(value);
}

function assertSafePath(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    Buffer.byteLength(value) > MAX_PATH_BYTES ||
    value.includes('\0') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[a-zA-Z]:/.test(value)
  ) {
    fail('UNSAFE_SOURCE_PATH', 'Source path недопустим');
  }
  const components = value.split('/');
  if (components.some((part) => !part || part === '.' || part === '..')) {
    fail('UNSAFE_SOURCE_PATH', 'Source path содержит небезопасный сегмент');
  }
  if (components.some((part) => part.toLowerCase() === '.git')) {
    fail('UNSAFE_SOURCE_PATH', 'Source path не может указывать на .git');
  }
  if (components[0].toLowerCase() === '.ai-orchestrator') {
    fail('UNSAFE_SOURCE_PATH', 'Source path не может указывать на control storage');
  }
  return value;
}

export function isSensitiveSourcePath(relativePath) {
  // Host-only control profile is required to reconstruct the executor workspace.
  // AI snapshots independently reject it through the shared policy.
  return relativePath !== '.flowcairn.json' && isSensitivePath(relativePath);
}

function assertNotSensitivePath(relativePath) {
  if (isSensitiveSourcePath(relativePath))
    fail('SENSITIVE_SOURCE_PATH', 'Source bundle отклоняет чувствительный path.');
}

function comparePath(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseNulRecords(buffer) {
  const records = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    records.push(buffer.subarray(start, index));
    start = index + 1;
  }
  if (start !== buffer.length) fail('GIT_FAILED', 'Git вернул незавершенный NUL record');
  return records.filter((record) => record.length > 0);
}

/**
 * @param {string} root
 * @param {string[]} args
 * @param {{allowFailure?: boolean, maxBuffer?: number, input?: string}} options
 */
function runGit(
  root,
  args,
  { allowFailure = false, maxBuffer = MAX_TOTAL_BYTES + MAX_MANIFEST_BYTES, input } = {},
) {
  const environment = {};
  for (const key of [
    'TMPDIR',
    'TMP',
    'TEMP',
    'SystemRoot',
    'WINDIR',
    'ComSpec',
    'PATHEXT',
    'LANG',
    'LC_CTYPE',
  ]) {
    if (typeof process.env[key] === 'string') environment[key] = process.env[key];
  }
  if (!['darwin', 'linux', 'win32'].includes(process.platform)) {
    fail('UNSUPPORTED_PLATFORM', 'Source bundle поддерживает только macOS/Linux system Git');
  }
  let gitStat;
  try {
    gitStat = lstatSync(GIT_EXECUTABLE);
  } catch {
    fail('GIT_FAILED', 'System Git не найден');
  }
  if (!gitStat.isFile() || gitStat.isSymbolicLink() || (gitStat.mode & 0o111) === 0) {
    fail('GIT_FAILED', 'System Git executable недопустим');
  }
  const result = spawnSync(
    GIT_EXECUTABLE,
    ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args],
    {
      cwd: root,
      encoding: 'buffer',
      input: input === undefined ? undefined : Buffer.from(input),
      shell: false,
      timeout: 120_000,
      maxBuffer,
      env: { ...hostSystemEnvironment(),
        ...environment,
        GIT_OPTIONAL_LOCKS: '0',
        GIT_NO_LAZY_FETCH: '1',
        GIT_NO_REPLACE_OBJECTS: '1',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: hostNullDevice,
        GIT_ATTR_NOSYSTEM: '1',
        LC_ALL: 'C',
      },
    },
  );
  if (result.error || result.signal || (!allowFailure && result.status !== 0)) {
    fail('GIT_FAILED', `git ${args[0]} завершился с ошибкой`, {
      status: result.status,
      error: result.error?.message ?? null,
      stderr: result.stderr?.toString('utf8').trim().slice(0, 2_000) ?? '',
    });
  }
  return result;
}

function repositoryRoot(root) {
  const requested = realpathSync(root);
  const top = runGit(requested, ['rev-parse', '--show-toplevel']).stdout.toString('utf8').trim();
  if (realpathSync(top) !== requested) {
    fail('NOT_REPOSITORY_ROOT', '--root должен быть корнем Git');
  }
  return requested;
}

function readHead(root) {
  const result = runGit(root, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true });
  if (result.status === 0) {
    const head = result.stdout.toString('ascii').trim();
    if (!OID_PATTERN.test(head)) fail('GIT_FAILED', 'Git вернул недопустимый HEAD');
    return head;
  }
  const symbolic = runGit(root, ['symbolic-ref', '-q', 'HEAD'], { allowFailure: true });
  if (symbolic.status !== 0) fail('GIT_FAILED', 'HEAD поврежден или не разрешается');
  const reference = symbolic.stdout.toString('utf8').trim();
  if (!/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(reference) || reference.includes('..')) {
    fail('GIT_FAILED', 'HEAD содержит недопустимую symbolic ref');
  }
  const exists = runGit(root, ['show-ref', '--verify', '--quiet', reference], {
    allowFailure: true,
  });
  if (exists.status === 1) return null;
  fail('GIT_FAILED', 'Symbolic HEAD существует, но не разрешается');
}

function readHeadEntries(root, head) {
  if (head === null) return new Map();
  const result = runGit(root, ['ls-tree', '-r', '-z', '--full-tree', head]);
  const entries = new Map();
  for (const record of parseNulRecords(result.stdout)) {
    const tab = record.indexOf(9);
    if (tab < 0) fail('GIT_FAILED', 'git ls-tree вернул недопустимый record');
    const prefix = record.subarray(0, tab).toString('ascii');
    const match = /^(\d{6}) ([a-z]+) ([a-f0-9]{40}|[a-f0-9]{64})$/.exec(prefix);
    if (!match || match[2] !== 'blob' || !ALL_MODES.has(match[1])) {
      fail('UNSUPPORTED_SOURCE_ENTRY', 'Source bundle поддерживает только Git files и symlinks');
    }
    const relativePath = decodePath(record.subarray(tab + 1));
    entries.set(relativePath, { mode: match[1], gitOid: match[3] });
  }
  return entries;
}

function readIndex(root) {
  const raw = runGit(root, ['ls-files', '--stage', '-z']).stdout;
  const entries = new Map();
  for (const record of parseNulRecords(raw)) {
    const tab = record.indexOf(9);
    if (tab < 0) fail('GIT_FAILED', 'git ls-files вернул недопустимый record');
    const prefix = record.subarray(0, tab).toString('ascii');
    const match = /^(\d{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([0-3])$/.exec(prefix);
    if (!match || match[3] !== '0') {
      fail('UNMERGED_INDEX', 'Source bundle не поддерживает unmerged index');
    }
    if (!ALL_MODES.has(match[1]) || /^0+$/.test(match[2])) {
      fail('UNSUPPORTED_SOURCE_ENTRY', 'Index содержит неподдерживаемую запись');
    }
    const relativePath = decodePath(record.subarray(tab + 1));
    if (entries.has(relativePath)) fail('UNMERGED_INDEX', 'Index содержит повторяющийся path');
    entries.set(relativePath, { mode: match[1], gitOid: match[2] });
  }
  return { raw, entries };
}

function readUntracked(root) {
  const raw = runGit(root, ['ls-files', '--others', '--exclude-standard', '-z']).stdout;
  return new Set(parseNulRecords(raw).map((record) => decodePath(record, 'Untracked path')));
}

function gitObjectsBatch(root, entries) {
  const ids = [...new Set(entries.filter(Boolean).map(entry => entry.gitOid))];
  const objects = new Map();
  if (!ids.length) return objects;
  const input = ids.join('\n') + '\n';
  const info = runGit(root, ['cat-file', '--batch-check'], {
    input, maxBuffer: ids.length * 100 + 1024,
  }).stdout.toString('ascii').split('\n');
  if (info.pop() !== '' || info.length !== ids.length)
    fail('GIT_FAILED', 'Git batch inventory имеет недопустимый формат');
  const sizes = info.map((line, index) => {
    const match = /^([a-f0-9]{40}|[a-f0-9]{64}) blob ([0-9]+)$/.exec(line);
    const size = match ? Number(match[2]) : NaN;
    if (!match || match[1] !== ids[index] || !Number.isSafeInteger(size) || size < 0)
      fail('GIT_FAILED', 'Git batch object имеет недопустимый тип или размер');
    if (size > MAX_OBJECT_BYTES) fail('SOURCE_LIMIT_EXCEEDED', 'Git object превышает лимит размера');
    return size;
  });
  if (sizes.reduce((sum, size) => sum + size, 0) > MAX_TOTAL_BYTES)
    fail('SOURCE_LIMIT_EXCEEDED', 'Git objects превышают общий лимит размера');
  // Bound each response, while avoiding thousands of per-file Git processes.
  for (let start = 0; start < ids.length;) {
    let end = start, bytes = 0;
    do { bytes += sizes[end] + 100; end++; }
    while (end < ids.length && bytes + sizes[end] + 100 <= 16 * 1024 * 1024);
    const output = runGit(root, ['cat-file', '--batch'], {
      input: ids.slice(start, end).join('\n') + '\n', maxBuffer: bytes + 1024,
    }).stdout;
    let cursor = 0;
    for (let index = start; index < end; index++) {
      const newline = output.indexOf(10, cursor);
      const header = output.subarray(cursor, newline).toString('ascii');
      if (newline < cursor || header !== `${ids[index]} blob ${sizes[index]}`)
        fail('GIT_FAILED', 'Git batch header не соответствует inventory');
      cursor = newline + 1;
      const finish = cursor + sizes[index];
      if (finish >= output.length || output[finish] !== 10)
        fail('SOURCE_CHANGED', 'Git batch content имеет неполный размер');
      objects.set(ids[index], output.subarray(cursor, finish));
      cursor = finish + 1;
    }
    if (cursor !== output.length) fail('GIT_FAILED', 'Git batch содержит лишние данные');
    start = end;
  }
  return objects;
}

function statIdentity(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(
    ':',
  );
}

function ancestorState(root, relativePath) {
  const parts = relativePath.split('/');
  const identities = [];
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    let stat;
    try {
      stat = lstatSync(current, { bigint: true });
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { available: false, identity: `${identities.join('|')}|missing:${part}` };
      }
      throw error;
    }
    if (stat.isSymbolicLink()) fail('UNSAFE_ANCESTOR_LINK', 'Source path имеет symlink-ancestor');
    if (!stat.isDirectory()) fail('UNSAFE_SOURCE_PATH', 'Source path имеет не-directory ancestor');
    identities.push(statIdentity(stat));
  }
  return { available: true, identity: identities.join('|') };
}

function decodeSymlinkTarget(buffer) {
  if (buffer.length === 0 || buffer.length > MAX_SYMLINK_BYTES || buffer.includes(0)) {
    fail('UNSAFE_SYMLINK', 'Symlink target недопустим');
  }
  try {
    return utf8.decode(buffer);
  } catch {
    fail('UNSAFE_SYMLINK', 'Symlink target должен быть корректным UTF-8');
  }
}

function assertSafeSymlink(relativePath, buffer) {
  const target = decodeSymlinkTarget(buffer);
  if (target.includes('\\') || target.startsWith('/') || /^[a-zA-Z]:/.test(target)) {
    fail('UNSAFE_SYMLINK', 'Абсолютный или platform-specific symlink запрещен');
  }
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relativePath), target));
  if (resolved === '..' || resolved.startsWith('../')) {
    fail('UNSAFE_SYMLINK', 'Symlink выходит за source root');
  }
  assertSafePath(resolved);
  return target;
}

function readWorktreeEntry(root, relativePath) {
  const ancestorsBefore = ancestorState(root, relativePath);
  if (!ancestorsBefore.available) {
    return { data: null, mode: null, statIdentity: `${ancestorsBefore.identity}|absent` };
  }
  const absolute = path.join(root, ...relativePath.split('/'));
  let before;
  try {
    before = lstatSync(absolute, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      return { data: null, mode: null, statIdentity: `${ancestorsBefore.identity}|absent` };
    }
    throw error;
  }
  if (before.isSymbolicLink()) {
    const data = readlinkSync(absolute, { encoding: 'buffer' });
    assertSafeSymlink(relativePath, data);
    const after = lstatSync(absolute, { bigint: true });
    if (statIdentity(before) !== statIdentity(after))
      fail('SOURCE_CHANGED', 'Symlink изменился во время capture');
    if (ancestorState(root, relativePath).identity !== ancestorsBefore.identity)
      fail('SOURCE_CHANGED', 'Source ancestor изменился во время capture');
    try {
      const resolved = realpathSync(absolute);
      if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
        fail('UNSAFE_SYMLINK', 'Symlink выходит за source root');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return {
      data,
      mode: '120000',
      statIdentity: `${ancestorsBefore.identity}|${statIdentity(after)}:${sha256(data)}`,
    };
  }
  if (!before.isFile())
    fail('UNSUPPORTED_SOURCE_ENTRY', 'Source bundle поддерживает только files и symlinks');
  if (before.nlink !== 1n) fail('UNSAFE_HARDLINK', 'Hardlinked source file запрещен');
  if (before.size > BigInt(MAX_OBJECT_BYTES))
    fail('SOURCE_LIMIT_EXCEEDED', 'Source file превышает лимит размера');
  let handle;
  try {
    handle = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(handle, { bigint: true });
    if (statIdentity(before) !== statIdentity(opened))
      fail('SOURCE_CHANGED', 'Source file изменился до чтения');
    const data = readFileSync(handle);
    const after = fstatSync(handle, { bigint: true });
    if (statIdentity(opened) !== statIdentity(after) || BigInt(data.length) !== after.size) {
      fail('SOURCE_CHANGED', 'Source file изменился во время чтения');
    }
    const current = lstatSync(absolute, { bigint: true });
    if (statIdentity(after) !== statIdentity(current))
      fail('SOURCE_CHANGED', 'Source path был заменен во время capture');
    if (ancestorState(root, relativePath).identity !== ancestorsBefore.identity)
      fail('SOURCE_CHANGED', 'Source ancestor изменился во время capture');
    return {
      data,
      mode: (Number(after.mode) & 0o111) === 0 ? '100644' : '100755',
      statIdentity: `${ancestorsBefore.identity}|${statIdentity(current)}`,
    };
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

function currentWorktreeIdentity(root, relativePath) {
  const ancestors = ancestorState(root, relativePath);
  if (!ancestors.available) return `${ancestors.identity}|absent`;
  const absolute = path.join(root, ...relativePath.split('/'));
  let stat;
  try {
    stat = lstatSync(absolute, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return `${ancestors.identity}|absent`;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    const data = readlinkSync(absolute, { encoding: 'buffer' });
    assertSafeSymlink(relativePath, data);
    return `${ancestors.identity}|${statIdentity(stat)}:${sha256(data)}`;
  }
  if (!stat.isFile())
    fail('UNSUPPORTED_SOURCE_ENTRY', 'Source path изменился на неподдерживаемый type');
  if (stat.nlink !== 1n) fail('UNSAFE_HARDLINK', 'Hardlinked source file запрещен');
  return `${ancestors.identity}|${statIdentity(stat)}`;
}

function descriptor(data, mode, gitOid) {
  const value = {
    type: mode === '120000' ? 'symlink' : 'file',
    mode,
    size: data.length,
    sha256: sha256(data),
  };
  return gitOid === undefined ? value : { ...value, gitOid };
}

function indexIdentity(entries) {
  return sha256(
    canonicalJson(
      entries
        .filter((entry) => entry.index !== null)
        .map((entry) => ({ path: entry.path, mode: entry.index.mode, gitOid: entry.index.gitOid })),
    ),
  );
}

function sourceHash(manifest) {
  const body = { ...manifest };
  delete body.sourceHash;
  return sha256(canonicalJson(body));
}

function ensurePrivateDirectory(directory) {
  // The allocator must provide an existing trusted parent; never create through links.
  assertDirectoryChain(path.dirname(directory), 'INSECURE_STORAGE');
  if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    fail('INSECURE_STORAGE', 'Bundle storage должен быть обычной directory');
  if (!isPrivateMode(stat))
    fail('INSECURE_STORAGE', 'Bundle storage должен быть private (0700)');
}

function assertOutputLocation(root, outputRoot) {
  const resolved = path.resolve(outputRoot);
  if (resolved === root)
    fail('INSECURE_STORAGE', 'Source root нельзя использовать как bundle storage');
  if (resolved.startsWith(`${root}${path.sep}`)) {
    const relative = path.relative(root, resolved).split(path.sep).join('/');
    if (relative === '.git' || relative.startsWith('.git/'))
      fail('INSECURE_STORAGE', 'Bundle storage запрещен внутри .git');
    const ignored = runGit(root, ['check-ignore', '-q', '--', relative], { allowFailure: true });
    if (ignored.status !== 0)
      fail('INSECURE_STORAGE', 'Bundle storage внутри repository должен быть ignored');
  }
  return resolved;
}

function writeBundle(outputRoot, manifest, objects, parentIdentity) {
  if (assertDirectoryChain(path.dirname(outputRoot), 'INSECURE_STORAGE') !== parentIdentity)
    fail('SOURCE_CHANGED', 'Bundle storage parent изменился во время capture');
  ensurePrivateDirectory(outputRoot);
  const bundlePath = path.join(outputRoot, manifest.sourceHash);
  if (existsSync(bundlePath)) {
    const existing = loadVerifiedBundle(bundlePath).manifest;
    if (existing.sourceHash !== manifest.sourceHash)
      fail('SOURCE_BUNDLE_COLLISION', 'Source bundle path collision');
    return bundlePath;
  }
  const temporary = path.join(outputRoot, `.${manifest.sourceHash}.${randomUUID()}.tmp`);
  mkdirSync(path.join(temporary, 'objects'), { recursive: true, mode: 0o700 });
  try {
    for (const [hash, data] of objects) {
      writeFileSync(path.join(temporary, 'objects', hash), data, { flag: 'wx', mode: 0o400 });
    }
    writeFileSync(path.join(temporary, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o400,
    });
    chmodSync(path.join(temporary, 'objects'), 0o500);
    chmodSync(temporary, 0o500);
    renameSync(temporary, bundlePath);
  } catch (error) {
    try {
      rmSync(temporary, { recursive: true, force: true });
    } catch {
      /* Preserve the original error when best-effort cleanup fails. */
    }
    if (existsSync(bundlePath)) {
      const existing = loadVerifiedBundle(bundlePath).manifest;
      if (existing.sourceHash === manifest.sourceHash) return bundlePath;
    }
    throw error;
  }
  return bundlePath;
}

function supplementalIgnoredSource(root, profile, tracked) {
  if (!profile) return null;
  const fingerprint = fingerprintProjectSource(root, {
    outputPaths: profile.outputPaths ?? [], denyGlobs: profile.aiDenyGlobs ?? [],
  });
  const candidates = fingerprint.files.filter((file) => !tracked.has(file.path)).map((file) => file.path);
  if (candidates.length > MAX_ENTRIES) fail('SOURCE_LIMIT_EXCEEDED', 'Supplemental source превышает лимит.');
  const ignored = new Set();
  for (let start = 0; start < candidates.length; start += 256) {
    const batch = candidates.slice(start, start + 256);
    const result = runGit(root, ['check-ignore', '--stdin', '-z'], {
      input: batch.join('\0') + '\0', allowFailure: true, maxBuffer: MAX_MANIFEST_BYTES,
    });
    if (result.status !== 0 && result.status !== 1) fail('SOURCE_CHANGED', 'Не удалось проверить supplemental source.');
    const accepted = new Set(batch);
    for (const record of parseNulRecords(result.stdout)) {
      const file = decodePath(record);
      if (!accepted.has(file)) fail('SOURCE_CHANGED', 'Не удалось проверить supplemental source.');
      ignored.add(file);
    }
  }
  return { hash: fingerprint.hash, files: fingerprint.files.filter((file) => ignored.has(file.path)) };
}

export function captureSourceBundle(root, outputRoot, { allowedUntracked = [], profile = null } = {}) {
  const repository = repositoryRoot(root);
  const storage = assertOutputLocation(repository, outputRoot);
  const storageParentIdentity = assertDirectoryChain(path.dirname(storage), 'INSECURE_STORAGE');
  if (!Array.isArray(allowedUntracked) || allowedUntracked.length > MAX_ENTRIES) {
    fail('INVALID_ALLOWED_UNTRACKED', 'allowedUntracked должен быть bounded массивом paths');
  }
  const allowed = [...new Set(allowedUntracked.map((entry) => assertSafePath(entry)))].sort(
    comparePath,
  );
  const allowedSet = new Set(allowed);
  for (const entry of allowed) assertNotSensitivePath(entry);

  const initialHead = readHead(repository);
  const headEntries = readHeadEntries(repository, initialHead);
  const initialIndex = readIndex(repository);
  const initialUntracked = readUntracked(repository);
  for (const relativePath of allowed) {
    if (!initialUntracked.has(relativePath)) {
      fail(
        'UNTRACKED_NOT_ALLOWED',
        `Path не является разрешенным non-ignored untracked file: ${relativePath}`,
      );
    }
  }

  const tracked = new Set([...headEntries.keys(), ...initialIndex.entries.keys()]);
  const supplemental = supplementalIgnoredSource(repository, profile, tracked);
  const supplementalFiles = new Map((supplemental?.files ?? []).map((file) => [file.path, file]));

  // Tracked credentials/configuration can be required locally, but must never be
  // copied into the isolated Graph worktree or included in the source bundle.
  const withheldPaths = [
    ...new Set([...headEntries.keys(), ...initialIndex.entries.keys()].filter(isSensitiveSourcePath)),
  ].sort(comparePath);
  const allPaths = [
    ...new Set([
      ...[...headEntries.keys(), ...initialIndex.entries.keys()].filter(
        (entry) => !isSensitiveSourcePath(entry),
      ),
      ...allowed,
      ...supplementalFiles.keys(),
    ]),
  ].sort(comparePath);
  if (allPaths.length > MAX_ENTRIES)
    fail('SOURCE_LIMIT_EXCEEDED', 'Source bundle содержит слишком много paths');
  const entries = [];
  const objects = new Map();
  const gitObjects = gitObjectsBatch(repository, allPaths.flatMap(file => [headEntries.get(file), initialIndex.entries.get(file)]));
  const worktreeStats = new Map();
  let totalBytes = 0;
  let worktreeLogicalBytes = 0;
  const addObject = (data) => {
    if (hasSecretContent(data.toString('utf8')))
      fail('SENSITIVE_SOURCE_CONTENT', 'Source bundle отклоняет чувствительное содержимое.');
    if (data.length > MAX_OBJECT_BYTES)
      fail('SOURCE_LIMIT_EXCEEDED', 'Source object превышает лимит размера');
    const hash = sha256(data);
    if (!objects.has(hash)) {
      totalBytes += data.length;
      if (totalBytes > MAX_TOTAL_BYTES)
        fail('SOURCE_LIMIT_EXCEEDED', 'Source bundle превышает общий лимит размера');
      objects.set(hash, data);
    }
    return hash;
  };
  const readGitObject = (gitEntry) => {
    return gitObjects.get(gitEntry.gitOid);
  };
  const addWorktreeBytes = (data) => {
    worktreeLogicalBytes += data.length;
    if (worktreeLogicalBytes > MAX_TOTAL_BYTES) {
      fail('SOURCE_LIMIT_EXCEEDED', 'Materialized worktree превышает общий лимит размера');
    }
  };

  for (const relativePath of allPaths) {
    assertNotSensitivePath(relativePath);
    const headEntry = headEntries.get(relativePath);
    const indexEntry = initialIndex.entries.get(relativePath);
    let head = null;
    let index = null;
    let worktree = null;
    if (headEntry) {
      const data = readGitObject(headEntry);
      const value = descriptor(data, headEntry.mode, headEntry.gitOid);
      if (value.type === 'symlink') assertSafeSymlink(relativePath, data);
      addObject(data);
      head = value;
    }
    if (indexEntry) {
      const data = readGitObject(indexEntry);
      const value = descriptor(data, indexEntry.mode, indexEntry.gitOid);
      if (value.type === 'symlink') assertSafeSymlink(relativePath, data);
      addObject(data);
      index = value;
      const current = readWorktreeEntry(repository, relativePath);
      worktreeStats.set(relativePath, current.statIdentity);
      if (current.data !== null) {
        addWorktreeBytes(current.data);
        addObject(current.data);
        worktree = descriptor(current.data, current.mode);
      }
    } else if (allowedSet.has(relativePath) || supplementalFiles.has(relativePath)) {
      const current = readWorktreeEntry(repository, relativePath);
      if (current.data === null)
        fail('SOURCE_CHANGED', `Разрешенный untracked path исчез: ${relativePath}`);
      const supplementalFile = supplementalFiles.get(relativePath);
      if (supplementalFile && (sha256(current.data) !== supplementalFile.hash || current.mode !== supplementalFile.mode))
        fail('SOURCE_CHANGED', 'Supplemental source изменился во время capture.');
      addWorktreeBytes(current.data);
      addObject(current.data);
      worktree = descriptor(current.data, current.mode);
      worktreeStats.set(relativePath, current.statIdentity);
    }
    entries.push({ path: relativePath, head, index, worktree });
  }

  const finalHead = readHead(repository);
  const finalIndex = readIndex(repository);
  const finalUntracked = readUntracked(repository);
  if (initialHead !== finalHead || !initialIndex.raw.equals(finalIndex.raw)) {
    fail('SOURCE_CHANGED', 'HEAD или index изменился во время capture');
  }
  for (const relativePath of allowed) {
    if (!finalUntracked.has(relativePath))
      fail('SOURCE_CHANGED', 'Untracked set изменился во время capture');
  }
  for (const [relativePath, identity] of worktreeStats) {
    try {
      if (currentWorktreeIdentity(repository, relativePath) !== identity)
        fail('SOURCE_CHANGED', 'Worktree изменился во время capture');
    } catch (error) {
      if (error instanceof GraphError && error.code !== 'SOURCE_CHANGED') {
        fail('SOURCE_CHANGED', 'Worktree path стал небезопасным во время capture');
      }
      throw error;
    }
  }

  if (supplemental) {
    const finalSupplemental = supplementalIgnoredSource(repository, profile, tracked);
    if (canonicalJson(supplemental) !== canonicalJson(finalSupplemental))
      fail('SOURCE_CHANGED', 'Supplemental source изменился во время capture.');
  }

  for (const layer of ['head', 'index', 'worktree']) {
    validateTopology(entries, layer);
    validateSymlinkChains(entries, layer, objects);
  }

  const manifest = {
    version: SOURCE_BUNDLE_VERSION,
    sourceHash: '',
    source: { head: initialHead, indexIdentity: indexIdentity(entries) },
    withheldPaths,
    entries,
  };
  manifest.sourceHash = sourceHash(manifest);
  const bundlePath = writeBundle(storage, manifest, objects, storageParentIdentity);
  verifySourceBundle(bundlePath);
  return { bundlePath, manifest };
}

function validateDescriptor(value, label, { gitLayer }) {
  const keys = gitLayer
    ? ['gitOid', 'mode', 'sha256', 'size', 'type']
    : ['mode', 'sha256', 'size', 'type'];
  exactKeys(value, keys, label);
  if (!['file', 'symlink'].includes(value.type) || !ALL_MODES.has(value.mode)) {
    fail('INVALID_SOURCE_BUNDLE', `${label} имеет недопустимый type/mode`);
  }
  if ((value.type === 'symlink') !== (value.mode === '120000')) {
    fail('INVALID_SOURCE_BUNDLE', `${label} type не соответствует mode`);
  }
  if (!Number.isSafeInteger(value.size) || value.size < 0 || value.size > MAX_OBJECT_BYTES) {
    fail('INVALID_SOURCE_BUNDLE', `${label} имеет недопустимый size`);
  }
  if (!HASH_PATTERN.test(value.sha256))
    fail('INVALID_SOURCE_BUNDLE', `${label} имеет недопустимый hash`);
  if (gitLayer && !OID_PATTERN.test(value.gitOid))
    fail('INVALID_SOURCE_BUNDLE', `${label} имеет недопустимый Git oid`);
}

function validateTopology(entries, layer) {
  const paths = new Set(
    entries.filter((entry) => entry[layer] !== null).map((entry) => entry.path),
  );
  for (const relativePath of paths) {
    const parts = relativePath.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      if (paths.has(parts.slice(0, index).join('/'))) {
        fail('INVALID_SOURCE_BUNDLE', `${layer} содержит path с file/symlink ancestor`);
      }
    }
  }
}

function validateSymlinkChains(entries, layer, objects) {
  const symlinkPaths = new Set(
    entries.filter((entry) => entry[layer]?.type === 'symlink').map((entry) => entry.path),
  );
  for (const entry of entries) {
    const value = entry[layer];
    if (value?.type !== 'symlink') continue;
    const target = decodeSymlinkTarget(objects.get(value.sha256));
    const traversed =
      path.posix.dirname(entry.path) === '.' ? [] : path.posix.dirname(entry.path).split('/');
    for (const segment of target.split('/')) {
      if (!segment || segment === '.') continue;
      if (segment === '..') traversed.pop();
      else traversed.push(segment);
      if (symlinkPaths.has(traversed.join('/'))) {
        fail('UNSAFE_SYMLINK', `${layer} symlink target пересекает другой symlink`);
      }
    }
  }
}

function readObject(objectPath, expected) {
  const stat = lstatSync(objectPath, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
    fail('INVALID_SOURCE_BUNDLE', 'Bundle object должен быть private regular file без hardlinks');
  }
  if (!isPrivateMode(stat))
    fail('INSECURE_SOURCE_BUNDLE', 'Bundle object должен быть private');
  if (stat.size !== BigInt(expected.size))
    fail('SOURCE_BUNDLE_TAMPERED', 'Bundle object size не совпадает');
  let handle;
  try {
    handle = openSync(objectPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(handle, { bigint: true });
    if (statIdentity(stat) !== statIdentity(opened))
      fail('SOURCE_BUNDLE_TAMPERED', 'Bundle object был заменен');
    const data = readFileSync(handle);
    const after = fstatSync(handle, { bigint: true });
    if (statIdentity(opened) !== statIdentity(after) || sha256(data) !== expected.sha256) {
      fail('SOURCE_BUNDLE_TAMPERED', 'Bundle object hash не совпадает');
    }
    return data;
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

function loadVerifiedBundle(bundlePath) {
  const root = path.resolve(bundlePath);
  assertDirectoryChain(path.dirname(root), 'INVALID_SOURCE_BUNDLE');
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    fail('INVALID_SOURCE_BUNDLE', 'Bundle path должен быть directory');
  if (!isPrivateMode(rootStat))
    fail('INSECURE_SOURCE_BUNDLE', 'Bundle path должен быть private');
  const rootNames = readdirSync(root).sort();
  if (rootNames.length !== 2 || rootNames[0] !== 'manifest.json' || rootNames[1] !== 'objects') {
    fail('INVALID_SOURCE_BUNDLE', 'Bundle содержит неизвестные entries');
  }
  const manifestPath = path.join(root, 'manifest.json');
  const manifestStat = lstatSync(manifestPath, { bigint: true });
  if (
    !manifestStat.isFile() ||
    manifestStat.isSymbolicLink() ||
    manifestStat.nlink !== 1n ||
    !isPrivateMode(manifestStat) ||
    manifestStat.size > BigInt(MAX_MANIFEST_BYTES)
  ) {
    fail('INVALID_SOURCE_BUNDLE', 'Manifest недопустим или превышает лимит');
  }
  let manifest;
  let manifestHandle;
  try {
    manifestHandle = openSync(manifestPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(manifestHandle, { bigint: true });
    if (statIdentity(manifestStat) !== statIdentity(opened)) {
      fail('SOURCE_BUNDLE_TAMPERED', 'Manifest был заменен до чтения');
    }
    const bytes = readFileSync(manifestHandle);
    const after = fstatSync(manifestHandle, { bigint: true });
    if (statIdentity(opened) !== statIdentity(after)) {
      fail('SOURCE_BUNDLE_TAMPERED', 'Manifest изменился во время чтения');
    }
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (error instanceof GraphError) throw error;
    fail('INVALID_SOURCE_BUNDLE', 'Manifest не является корректным JSON');
  } finally {
    if (manifestHandle !== undefined) closeSync(manifestHandle);
  }
  if (![1, SOURCE_BUNDLE_VERSION].includes(manifest.version) || !HASH_PATTERN.test(manifest.sourceHash)) {
    fail('INVALID_SOURCE_BUNDLE', 'Manifest version/hash недопустим');
  }
  exactKeys(
    manifest,
    manifest.version === 1
      ? ['entries', 'source', 'sourceHash', 'version']
      : ['entries', 'source', 'sourceHash', 'version', 'withheldPaths'],
    'manifest',
  );
  if (path.basename(root) !== manifest.sourceHash || sourceHash(manifest) !== manifest.sourceHash) {
    fail('SOURCE_BUNDLE_TAMPERED', 'Manifest content address не совпадает');
  }
  exactKeys(manifest.source, ['head', 'indexIdentity'], 'manifest.source');
  if (manifest.source.head !== null && !OID_PATTERN.test(manifest.source.head)) {
    fail('INVALID_SOURCE_BUNDLE', 'Manifest HEAD недопустим');
  }
  if (!HASH_PATTERN.test(manifest.source.indexIdentity))
    fail('INVALID_SOURCE_BUNDLE', 'Index identity недопустим');
  if (!Array.isArray(manifest.entries) || manifest.entries.length > MAX_ENTRIES) {
    fail('INVALID_SOURCE_BUNDLE', 'Manifest entries превышает лимит');
  }
  const withheldPaths = manifest.version === 1 ? [] : manifest.withheldPaths;
  if (!Array.isArray(withheldPaths) || withheldPaths.length > MAX_ENTRIES)
    fail('INVALID_SOURCE_BUNDLE', 'Manifest withheld paths превышает лимит');
  const objectsDirectory = path.join(root, 'objects');
  const objectDirectoryStat = lstatSync(objectsDirectory);
  if (!objectDirectoryStat.isDirectory() || objectDirectoryStat.isSymbolicLink()) {
    fail('INVALID_SOURCE_BUNDLE', 'Bundle objects должен быть directory');
  }
  if (!isPrivateMode(objectDirectoryStat))
    fail('INSECURE_SOURCE_BUNDLE', 'Bundle objects должен быть private');
  const seenPaths = new Set();
  const canonicalPaths = new Set();
  const expectedObjects = new Map();
  let worktreeLogicalBytes = 0;
  let priorPath = null;
  for (const [entryIndex, entry] of manifest.entries.entries()) {
    exactKeys(entry, ['head', 'index', 'path', 'worktree'], `entries[${entryIndex}]`);
    const relativePath = assertSafePath(entry.path);
    assertNotSensitivePath(relativePath);
    if (priorPath !== null && comparePath(priorPath, relativePath) >= 0)
      fail('INVALID_SOURCE_BUNDLE', 'Manifest paths должны быть unique и sorted');
    priorPath = relativePath;
    const canonical = relativePath.normalize('NFC').toLowerCase();
    if (seenPaths.has(relativePath) || canonicalPaths.has(canonical))
      fail('INVALID_SOURCE_BUNDLE', 'Manifest содержит path collision');
    seenPaths.add(relativePath);
    canonicalPaths.add(canonical);
    if (entry.head === null && entry.index === null && entry.worktree === null)
      fail('INVALID_SOURCE_BUNDLE', 'Manifest entry не содержит ни одного слоя');
    if (entry.head !== null)
      validateDescriptor(entry.head, `entries[${entryIndex}].head`, { gitLayer: true });
    if (entry.index !== null)
      validateDescriptor(entry.index, `entries[${entryIndex}].index`, { gitLayer: true });
    if (entry.worktree !== null)
      validateDescriptor(entry.worktree, `entries[${entryIndex}].worktree`, { gitLayer: false });
    if (entry.worktree !== null) {
      worktreeLogicalBytes += entry.worktree.size;
      if (worktreeLogicalBytes > MAX_TOTAL_BYTES) {
        fail('SOURCE_LIMIT_EXCEEDED', 'Materialized worktree превышает общий лимит размера');
      }
    }
    for (const layer of ['head', 'index', 'worktree']) {
      const value = entry[layer];
      if (value === null) continue;
      const previous = expectedObjects.get(value.sha256);
      if (previous && previous.size !== value.size)
        fail('INVALID_SOURCE_BUNDLE', 'Один hash имеет разные sizes');
      expectedObjects.set(value.sha256, value);
    }
  }
  let priorWithheldPath = null;
  for (const withheldPath of withheldPaths) {
    const relativePath = assertSafePath(withheldPath);
    if (!isSensitiveSourcePath(relativePath))
      fail('INVALID_SOURCE_BUNDLE', 'Withheld path должен быть чувствительным');
    if (priorWithheldPath !== null && comparePath(priorWithheldPath, relativePath) >= 0)
      fail('INVALID_SOURCE_BUNDLE', 'Withheld paths должны быть unique и sorted');
    priorWithheldPath = relativePath;
    const canonical = relativePath.normalize('NFC').toLowerCase();
    if (canonicalPaths.has(canonical))
      fail('INVALID_SOURCE_BUNDLE', 'Withheld path пересекается с source entry');
    canonicalPaths.add(canonical);
  }
  if (manifest.source.head === null && manifest.entries.some((entry) => entry.head !== null)) {
    fail('INVALID_SOURCE_BUNDLE', 'Unborn HEAD не может иметь entries');
  }
  if (indexIdentity(manifest.entries) !== manifest.source.indexIdentity) {
    fail('SOURCE_BUNDLE_TAMPERED', 'Index identity не совпадает');
  }
  for (const layer of ['head', 'index', 'worktree']) validateTopology(manifest.entries, layer);
  const actualObjectNames = readdirSync(objectsDirectory).sort();
  const expectedObjectNames = [...expectedObjects.keys()].sort();
  if (
    actualObjectNames.length !== expectedObjectNames.length ||
    actualObjectNames.some((name, index) => name !== expectedObjectNames[index])
  ) {
    fail('INVALID_SOURCE_BUNDLE', 'Bundle objects не совпадают с manifest');
  }
  const objects = new Map();
  let totalBytes = 0;
  for (const [hash, value] of expectedObjects) {
    totalBytes += value.size;
    if (totalBytes > MAX_TOTAL_BYTES)
      fail('SOURCE_LIMIT_EXCEEDED', 'Bundle превышает общий лимит размера');
    const data = readObject(path.join(objectsDirectory, hash), value);
    objects.set(hash, data);
  }
  for (const entry of manifest.entries) {
    for (const layer of ['head', 'index', 'worktree']) {
      const value = entry[layer];
      if (value?.type === 'symlink') assertSafeSymlink(entry.path, objects.get(value.sha256));
    }
  }
  for (const layer of ['head', 'index', 'worktree']) {
    validateSymlinkChains(manifest.entries, layer, objects);
  }
  return { manifest, objects };
}

export function verifySourceBundle(bundlePath) {
  return loadVerifiedBundle(bundlePath).manifest;
}

function createParentDirectories(root, relativePath) {
  let current = root;
  for (const part of relativePath.split('/').slice(0, -1)) {
    current = path.join(current, part);
    if (!existsSync(current)) mkdirSync(current, { mode: 0o700 });
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      fail('UNSAFE_MATERIALIZATION', 'Materialization ancestor недопустим');
  }
}

function inodeIdentity(stat) {
  return `${stat.dev}:${stat.ino}`;
}

function assertDirectoryChain(directory, code = 'UNSAFE_MATERIALIZATION') {
  const absolute = path.resolve(directory);
  const filesystemRoot = path.parse(absolute).root;
  let current = filesystemRoot;
  const identities = [];
  for (const part of path.relative(filesystemRoot, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      fail(code, 'Path имеет небезопасный ancestor');
    identities.push(inodeIdentity(stat));
  }
  return identities.join('|');
}

export function materializeSourceBundle(bundlePath, targetRoot) {
  const { manifest, objects } = loadVerifiedBundle(bundlePath);
  const target = path.resolve(targetRoot);
  if (existsSync(target)) fail('MATERIALIZATION_EXISTS', 'Materialization target уже существует');
  const parent = path.dirname(target);
  assertDirectoryChain(parent);
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink())
    fail('UNSAFE_MATERIALIZATION', 'Materialization parent недопустим');
  try {
    mkdirSync(target, { mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST')
      fail('MATERIALIZATION_EXISTS', 'Materialization target уже существует');
    throw error;
  }
  const targetIdentity = inodeIdentity(lstatSync(target, { bigint: true }));
  try {
    const worktreeEntries = manifest.entries.filter((entry) => entry.worktree !== null);
    for (const entry of worktreeEntries) createParentDirectories(target, entry.path);
    for (const entry of worktreeEntries) {
      const destination = path.join(target, ...entry.path.split('/'));
      const value = entry.worktree;
      const data = objects.get(value.sha256);
      if (value.type === 'symlink') {
        symlinkSync(assertSafeSymlink(entry.path, data), destination);
      } else {
        writeFileSync(destination, data, {
          flag: 'wx',
          mode: value.mode === '100755' ? 0o700 : 0o600,
        });
        chmodSync(destination, value.mode === '100755' ? 0o700 : 0o600);
      }
    }
    for (const entry of worktreeEntries) {
      const destination = path.join(target, ...entry.path.split('/'));
      const value = entry.worktree;
      const current =
        value.type === 'symlink'
          ? readlinkSync(destination, { encoding: 'buffer' })
          : readFileSync(destination);
      if (sha256(current) !== value.sha256)
        fail('SOURCE_BUNDLE_TAMPERED', 'Materialized object hash не совпадает');
      const stat = lstatSync(destination, { bigint: true });
      if (value.type === 'file' && (!stat.isFile() || stat.nlink !== 1n))
        fail('UNSAFE_MATERIALIZATION', 'Materialized file недопустим');
      if (
        value.type === 'file' &&
        ((Number(stat.mode) & 0o111) !== 0) !== (value.mode === '100755')
      ) {
        fail('SOURCE_BUNDLE_TAMPERED', 'Materialized executable mode не совпадает');
      }
      if (value.type === 'symlink' && !stat.isSymbolicLink())
        fail('UNSAFE_MATERIALIZATION', 'Materialized symlink недопустим');
    }
  } catch (error) {
    try {
      const current = lstatSync(target, { bigint: true });
      if (
        current.isDirectory() &&
        !current.isSymbolicLink() &&
        inodeIdentity(current) === targetIdentity
      ) {
        rmSync(target, { recursive: true, force: true });
      }
    } catch {
      /* Preserve the original error when best-effort cleanup fails. */
    }
    throw error;
  }
  const verified = [];
  for (const entry of manifest.entries.filter((item) => item.worktree !== null)) {
    const destination = path.join(target, ...entry.path.split('/'));
    const current =
      entry.worktree.type === 'symlink'
        ? readlinkSync(destination, { encoding: 'buffer' })
        : readFileSync(destination);
    if (sha256(current) !== entry.worktree.sha256)
      fail('SOURCE_BUNDLE_TAMPERED', 'Post-materialization hash не совпадает');
    const stat = lstatSync(destination, { bigint: true });
    if (
      entry.worktree.type === 'file' &&
      ((Number(stat.mode) & 0o111) !== 0) !== (entry.worktree.mode === '100755')
    ) {
      fail('SOURCE_BUNDLE_TAMPERED', 'Post-materialization executable mode не совпадает');
    }
    verified.push(entry.path);
  }
  return { sourceHash: manifest.sourceHash, targetRoot: target, paths: verified };
}

export const SOURCE_BUNDLE_LIMITS = Object.freeze({
  maxEntries: MAX_ENTRIES,
  maxObjectBytes: MAX_OBJECT_BYTES,
  maxTotalBytes: MAX_TOTAL_BYTES,
});
