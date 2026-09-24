import { constants, openSync, fsyncSync, closeSync, Stats, lstatSync as nativeLstatSync, statSync as nativeStatSync, fstatSync as nativeFstatSync, realpathSync as nativeRealpathSync } from 'node:fs';
import path from 'node:path';

/** Windows stat mode bits do not describe NTFS ACLs. On Windows callers rely on
 * the current user's inherited directory ACL; this is not an ACL audit or isolation. */
export function isPrivateMode(stat, platform = process.platform) {
  return platform === 'win32' || (typeof stat.mode === 'bigint'
    ? (stat.mode & 0o077n) === 0n : (stat.mode & 0o077) === 0);
}

/** POSIX writable-by-group/world check; Windows uses inherited OS ACL trust. */
export function isTrustedMode(stat, platform = process.platform) {
  return platform === 'win32' || (typeof stat.mode === 'bigint'
    ? (stat.mode & 0o022n) === 0n : (stat.mode & 0o022) === 0);
}

export function assertPrivateMode(stat, platform = process.platform) {
  if (!isPrivateMode(stat, platform)) {
    const error = new Error('Private filesystem record has unsafe permissions');
    Object.assign(error, { code: 'UNSAFE_PRIVATE_MODE' });
    throw error;
  }
}

/** Callers still validate lstat and opened descriptor identities and nlink.
 * O_NOFOLLOW is not available on every host and does not protect ancestors. */
export function noFollowReadFlags() {
  return constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
}

function comparable(value, platform) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  let normalized = paths.resolve(value);
  if (platform === 'win32') {
    // Normalize extended-length DOS/UNC spellings without losing root identity.
    if (normalized.startsWith('\\\\?\\UNC\\')) normalized = `\\\\${normalized.slice(8)}`;
    else if (normalized.startsWith('\\\\?\\')) normalized = normalized.slice(4);
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

/** Existing-path canonicalization via the native Windows handle API expands
 * 8.3 aliases as well as junctions. Keep it explicit: lexical alias guards must
 * not accidentally begin treating a symlink as its destination. */
export function realpathHostSync(value) {
  return process.platform === 'win32' ? nativeRealpathSync.native(value) : nativeRealpathSync(value);
}

export function sameHostPath(left, right, platform = process.platform) {
  return typeof left === 'string' && typeof right === 'string'
    && comparable(left, platform) === comparable(right, platform);
}

/** Component-based containment prevents sibling-prefix and different-drive escapes. */
export function isPathWithin(root, candidate, platform = process.platform) {
  if (typeof root !== 'string' || typeof candidate !== 'string') return false;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const relative = paths.relative(comparable(root, platform), comparable(candidate, platform));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative));
}

/** Pass the parent directory itself. File fsync must be done independently.
 * Windows does not offer the POSIX directory-fsync guarantee through Node fs. */
export function fsyncParentDirectory(directory, platform = process.platform) {
  if (platform === 'win32') return { synced: false, reason: 'directory-fsync-unsupported' };
  const fd = openSync(directory, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
  return { synced: true, reason: null };
}

/** Node 22.13.1/libuv Windows path stat exposes a 64-bit volume serial while
 * handle fstat exposes its low 32 bits. Match upstream libuv fix 82cdfb75f:
 * https://github.com/libuv/libuv/commit/82cdfb75f
 * Use bigint stats: a rounded 64-bit Number has already lost identity bits. */
export function canonicalStatDevice(stat, platform = process.platform) {
  if (typeof stat.dev !== 'bigint' && !Number.isSafeInteger(stat.dev))
    throw new Error('Filesystem identity requires bigint stats');
  const device = BigInt(stat.dev);
  return platform === 'win32' ? BigInt.asUintN(32, device) : device;
}

/** For path-stat versus handle-stat comparisons only. Same-origin stability
 * checks must retain every original device bit. */
export function crossStatIdentity(stat, platform = process.platform) {
  return `${canonicalStatDevice(stat, platform)}:${stat.ino}:${stat.mode}:${stat.nlink}:${stat.size}:${stat.mtimeNs ?? stat.mtimeMs}:${stat.ctimeNs ?? stat.ctimeMs}`;
}


// Node 22.13.1's Windows lstat fast path exposes a 64-bit volume serial while
// fstat exposes LowPart. Match libuv's upstream fix using exact bigint input.
// https://github.com/libuv/libuv/commit/82cdfb75f
function windowsStats(raw, bigint) {
  if (!raw) return raw;
  raw.dev = BigInt.asUintN(32, raw.dev);
  if (bigint) return raw;
  const result = Object.create(Stats.prototype);
  for (const [key, value] of Object.entries(raw)) {
    if (key.endsWith('Ns')) continue;
    result[key] = typeof value === 'bigint' ? Number(value) : value;
  }
  for (const name of ['atime', 'mtime', 'ctime', 'birthtime']) {
    const ns = raw[`${name}Ns`];
    result[`${name}Ms`] = Number(ns / 1000000n) + Number(ns % 1000000n) / 1000000;
  }
  return result;
}

// Some Windows hosts on Node22.13.1/libuv1.49.2 return dev=0 from the
// GetFileInformationByName path API. Obtain the missing volume from a handle;
// never treat zero as a wildcard in an identity comparison. Only regular files
// need this bridge: directory guards use path/path stat, lstat links stay links.
function completeWindowsFileStat(file, initial, pathStat, {
  open = openSync, handleStat = nativeFstatSync, close = closeSync,
} = {}) {
  if (!initial?.isFile() || initial.dev !== 0n) return initial;
  const fields = ['ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs', 'birthtimeNs'];
  const same = (left, right) => fields.every((field) => left[field] === right[field]);
  const changed = () => { throw Object.assign(new Error('Filesystem identity changed during inspection'), { code: 'ESTALE' }); };
  const fd = open(file, noFollowReadFlags());
  try {
    const opened = handleStat(fd, { bigint: true });
    if (!opened.isFile() || !same(initial, opened)) changed();
    const live = pathStat(file, { bigint: true });
    const after = handleStat(fd, { bigint: true });
    if (!live?.isFile() || live.dev !== initial.dev || !same(initial, live)
      || after.dev !== opened.dev || !same(opened, after)) changed();
    // initial is a new native Stats instance; preserve its type predicates and
    // timestamps while repairing only the missing device value from the handle.
    initial.dev = opened.dev;
    return initial;
  } finally { close(fd); }
}

export const HOST_FILESYSTEM_TESTING = Object.freeze({ completeWindowsFileStat });

/** @returns {any} */
export function lstatHostSync(file, options = {}) {
  if (process.platform !== 'win32') return nativeLstatSync(file, options);
  const raw = nativeLstatSync(file, { ...options, bigint: true });
  return windowsStats(completeWindowsFileStat(file, raw, nativeLstatSync), Reflect.get(options, 'bigint') === true);
}
/** @returns {any} */
export function statHostSync(file, options = {}) {
  if (process.platform !== 'win32') return nativeStatSync(file, options);
  const raw = nativeStatSync(file, { ...options, bigint: true });
  return windowsStats(completeWindowsFileStat(file, raw, nativeStatSync), Reflect.get(options, 'bigint') === true);
}
/** @returns {any} */
export function fstatHostSync(fd, options = {}) {
  if (process.platform !== 'win32') return nativeFstatSync(fd, options);
  return windowsStats(nativeFstatSync(fd, { ...options, bigint: true }), Reflect.get(options, 'bigint') === true);
}
