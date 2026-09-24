import { lstatHostSync as lstatSync, fstatHostSync as fstatSync } from './host-filesystem.mjs';
import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { isPathWithin, sameHostPath, noFollowReadFlags, crossStatIdentity } from './host-filesystem.mjs';
import { GraphError } from './io.mjs';
import { classifySource, normalizeSourcePath } from './source-policy.mjs';

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 100000;
const MAX_DEPTH = 64;
function portableName(name) {
  const normalized = name.normalize('NFKC');
  if ([...normalized].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || /[\\:]/u.test(normalized) || /[. ]$/.test(normalized)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(normalized)) fail();
}
const indexes = new WeakSet();
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = () => { throw new GraphError('UNSAFE_PROJECT_SOURCE', 'Не удалось безопасно прочитать стабильные исходники проекта.'); };
const identity = (stat) => `${stat.dev}:${stat.ino}:${stat.mode}:${stat.nlink}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
const isWithin = isPathWithin;

function safeRead(file, expected, root) {
  if (!expected.isFile() || expected.nlink !== 1n || expected.size > BigInt(MAX_FILE_BYTES)) fail();
  if (!sameHostPath(realpathSync(file), file) || !isWithin(root, file)) fail();
  const fd = openSync(file, noFollowReadFlags());
  try {
    const before = fstatSync(fd, { bigint: true });
    if (crossStatIdentity(before) !== crossStatIdentity(expected)) fail();
    const bytes = readFileSync(fd);
    if (bytes.length > MAX_FILE_BYTES || identity(fstatSync(fd, { bigint: true })) !== identity(before)
      || identity(lstatSync(file, { bigint: true })) !== identity(expected) || !sameHostPath(realpathSync(file), file)) fail();
    return bytes;
  } finally { closeSync(fd); }
}

function scan(root, options) {
  const entries = [];
  const excludedPaths = [];
  const fingerprints = [];
  const privateFingerprints = [];
  let total = 0;
  let count = 0;
  const aliases = new Set();
  function opaque(absolute, depth) {
    if (depth > MAX_DEPTH) fail();
    if (++count > MAX_ENTRIES) fail();
    const stat = lstatSync(absolute, { bigint: true });
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1n)) fail();
    if (stat.isFile()) {
      const bytes = safeRead(absolute, stat, root);
      total += bytes.length;
      if (total > MAX_TOTAL_BYTES) fail();
      return digest(bytes);
    }
    if (!stat.isDirectory() || !sameHostPath(realpathSync(absolute), absolute)) fail();
    const opaqueAliases = new Set();
    const hashes = readdirSync(absolute).sort().map((name) => {
      portableName(name);
      const alias = normalizeSourcePath(name);
      if (opaqueAliases.has(alias)) fail();
      opaqueAliases.add(alias);
      return digest(JSON.stringify([name, opaque(path.join(absolute, name), depth + 1)]));
    });
    if (identity(lstatSync(absolute, { bigint: true })) !== identity(stat)) fail();
    return digest(JSON.stringify(hashes));
  }
  function visit(directory, relative = '', depth = 0) {
    if (depth > MAX_DEPTH) fail();
    const before = lstatSync(directory, { bigint: true });
    if (!before.isDirectory() || !sameHostPath(realpathSync(directory), directory)) fail();
    for (const name of readdirSync(directory).sort()) {
      portableName(name);
      if (++count > MAX_ENTRIES) fail();
      const rel = relative ? `${relative}/${name}` : name;
      const normalized = normalizeSourcePath(rel);
      if (aliases.has(normalized)) fail();
      aliases.add(normalized);
      const absolute = path.join(directory, name);
      const stat = lstatSync(absolute, { bigint: true });
      if (stat.isSymbolicLink()) {
        excludedPaths.push(rel);
        privateFingerprints.push(digest(JSON.stringify([rel, 'symbolic-link', identity(stat)])));
        continue;
      }
      const output = options.outputPaths.some((item) => normalized === item || normalized.startsWith(`${item}/`));
      const reason = output ? 'output' : classifySource(rel, undefined, options).reason;
      if (reason) {
        excludedPaths.push(rel);
        // Control/dependency/output trees cannot influence source evidence. Other
        // excluded material binds freshness without exposing names or contents.
        const control = ['.git', '.ai', '.ai-orchestrator', '.agents', '.codex', '.claude', '.cursor'].includes(normalized.split('/').at(-1));
        const exempt = control || ['dependency', 'output', 'binary'].includes(reason);
        if (exempt) continue;
        const excludedHash = opaque(absolute, depth + 1);
        privateFingerprints.push(digest(JSON.stringify([rel, reason, excludedHash])));
        continue;
      }
      if (stat.isDirectory()) { visit(absolute, rel, depth + 1); continue; }
      if (!stat.isFile() || stat.nlink !== 1n) fail();
      const bytes = safeRead(absolute, stat, root);
      total += bytes.length;
      if (total > MAX_TOTAL_BYTES) fail();
      const hash = digest(bytes);
      const contentReason = classifySource(rel, bytes, options).reason;
      const mode = stat.mode & 0o111n ? '100755' : '100644';
      (contentReason ? privateFingerprints : fingerprints).push(digest(JSON.stringify([rel, hash, mode, contentReason])));
      if (contentReason) excludedPaths.push(rel);
      if (!contentReason) entries.push({ path: rel, hash, size: bytes.length, mode: stat.mode & 0o111n ? '100755' : '100644' });
    }
    if (identity(lstatSync(directory, { bigint: true })) !== identity(before) || !sameHostPath(realpathSync(directory), directory)) fail();
  }
  visit(root);
  const privateHash = digest(JSON.stringify(privateFingerprints.sort()));
  return { entries, excludedPaths: excludedPaths.sort(), privateHash, hash: digest(JSON.stringify([fingerprints.sort(), privateHash])) };
}

function stableScan(root, { outputPaths = [], denyGlobs = [] } = {}) {
  const options = { denyGlobs, outputPaths: outputPaths.map((item) => {
    const rel = path.isAbsolute(item) ? path.relative(root, item) : item;
    if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`)
      || rel.split(/[\\/]/).some((part) => part === '.' || part === '..')) fail();
    return normalizeSourcePath(rel).replace(/\/$/, '');
  }) };
  const first = scan(root, options);
  const second = scan(root, options);
  if (first.hash !== second.hash || JSON.stringify(first.excludedPaths) !== JSON.stringify(second.excludedPaths)) fail();
  return second;
}

/** Host index for native project access. No directories or files are created.
 * excludedPaths is host-only, non-enumerable metadata: never send it to AI. */
export function inspectProjectSource(projectRoot, options = {}) {
  try {
    const root = realpathSync(projectRoot);
    if (lstatSync(path.resolve(projectRoot)).isSymbolicLink()) fail();
    const result = stableScan(root, options);
    const index = { root, files: Object.freeze(result.entries.map((entry) => Object.freeze(entry))),
      hash: result.hash, privateHash: result.privateHash, excludedPaths: Object.freeze(result.excludedPaths) };
    Object.defineProperty(index, 'excludedPaths', { enumerable: false });
    indexes.add(index);
    return Object.freeze(index);
  } catch { fail(); }
}

/** Compatibility receipt without a directory allocation or file copy. */
export function fingerprintProjectSource(projectRoot, options = {}) {
  const { files, hash, privateHash } = inspectProjectSource(projectRoot, options);
  return Object.freeze({ files, hash, privateHash });
}

function bounds(index, offset, limit, maximum) {
  if (!indexes.has(index) || !Number.isSafeInteger(offset) || offset < 0
    || !Number.isSafeInteger(limit) || limit < 1 || limit > maximum) fail();
}

export function listProjectSourcePage(index, { offset = 0, limit = 128 } = {}) {
  bounds(index, offset, limit, 1024);
  const files = index.files.slice(offset, offset + limit);
  const eof = offset + files.length >= index.files.length;
  return { files, next: eof ? null : offset + files.length, eof };
}

/** Read current project bytes only if the whole file still matches this index.
 * Byte offsets end at UTF-8 boundaries; excluded files have no page access. */
export function readProjectSourcePage(index, { path: relative, offset = 0, limit = 32768 }) {
  try {
    bounds(index, offset, limit, 1024 * 1024);
    const entry = index.files.find((file) => file.path === relative);
    if (!entry) fail();
    const target = path.join(index.root, entry.path);
    const bytes = safeRead(target, lstatSync(target, { bigint: true }), index.root);
    if (digest(bytes) !== entry.hash || classifySource(relative, bytes).reason) fail();
    if (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) fail();
    let end = Math.min(bytes.length, offset + limit);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    if (end <= offset && offset < bytes.length) fail();
    const eof = end >= bytes.length;
    return { path: relative, text: bytes.subarray(offset, end).toString('utf8'), next: eof ? null : end, eof, size: bytes.length, hash: entry.hash };
  } catch { fail(); }
}
