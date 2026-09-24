import { constants, openSync, fsyncSync, closeSync } from 'node:fs';
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
