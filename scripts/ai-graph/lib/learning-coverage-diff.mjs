import { createHash } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifiedSourceText } from './learning-source-storage.mjs';

const DIGEST_BYTES = 32;

/** Write fixed-size line digests to a private temporary index. This avoids
 * retaining one JS string/object per line while still allowing an exact suffix
 * comparison. The saved source iterator is exhausted, so EOF/hash/policy are
 * verified before the index is used. */
function writeLineHashIndex(store, source, file) {
  const fd = openSync(file, 'w+', 0o600);
  const output = Buffer.allocUnsafe(32 * DIGEST_BYTES); let outputOffset = 0;
  let line = createHash('sha256'); let count = 0;
  const flush = () => {
    let written = 0;
    while (written < outputOffset) {
      const count = writeSync(fd, output, written, outputOffset - written);
      if (!count) throw new Error('Coverage digest index write made no progress.');
      written += count;
    }
    outputOffset = 0;
  };
  const writeDigest = () => {
    line.digest().copy(output, outputOffset); outputOffset += DIGEST_BYTES;
    if (outputOffset === output.length) flush();
    line = createHash('sha256'); count++;
  };
  try {
    for (const text of verifiedSourceText(store, source)) {
      let start = 0;
      for (;;) {
        const end = text.indexOf('\n', start);
        if (end < 0) { line.update(text.slice(start)); break; }
        line.update(text.slice(start, end + 1)); writeDigest(); start = end + 1;
      }
    }
    if (source.bytes > 0) writeDigest();
    flush();
    return { fd, count };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function digestAt(fd, index) {
  const buffer = Buffer.allocUnsafe(DIGEST_BYTES);
  let offset = 0;
  while (offset < DIGEST_BYTES) {
    const count = readSync(fd, buffer, offset, DIGEST_BYTES - offset, index * DIGEST_BYTES + offset);
    if (!count) throw new Error('Coverage digest index ended before the expected line.');
    offset += count;
  }
  return buffer;
}

/** One conservative envelope in FINAL before/after coordinates. Disjoint edits
 * may include unchanged middle lines; these are not claimed as semantic units. */
export function savedChangedRanges(store, before, after) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'flowcairn-coverage-diff-'));
  let left, right;
  try {
    left = writeLineHashIndex(store, before, path.join(directory, 'before'));
    right = writeLineHashIndex(store, after, path.join(directory, 'after'));
    let prefix = 0, suffix = 0;
    while (prefix < left.count && prefix < right.count
      && digestAt(left.fd, prefix).equals(digestAt(right.fd, prefix))) prefix++;
    while (suffix < left.count - prefix && suffix < right.count - prefix
      && digestAt(left.fd, left.count - suffix - 1).equals(digestAt(right.fd, right.count - suffix - 1))) suffix++;
    const range = count => count - suffix > prefix ? { startLine: prefix + 1, endLine: count - suffix } : null;
    return { before: range(left.count), after: range(right.count) };
  } finally {
    if (left) closeSync(left.fd);
    if (right) closeSync(right.fd);
    rmSync(directory, { recursive: true, force: true });
  }
}
