import { createHash } from 'node:crypto';
import { openSync, readSync, closeSync } from 'node:fs';
import { TextDecoder } from 'node:util';
import { lstatHostSync as lstatSync, fstatHostSync as fstatSync, noFollowReadFlags, crossStatIdentity } from './host-filesystem.mjs';
import { GraphError } from './io.mjs';

// A working buffer, never a limit on the complete file.
export const INSTRUCTION_READ_CHUNK_BYTES = 64 * 1024;
const fail = (code, message) => { throw new GraphError(code, message); };

/** Full byte hash and UTF-8 validation with bounded body memory. No source text is logged.
 * Callbacks receive a borrowed buffer; callers retaining bytes must copy it.
 * Cancellation/error closes the descriptor; retry starts a fresh verified scan.
 */
export function streamInstructionFile(file, { maxBytes = undefined, signal = undefined, currentPath = () => file, onChunk = undefined, collectFrontmatter = false } = {}) {
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) fail('INSTRUCTION_LIMIT', 'Invalid explicit read budget.');
  const cancelled = () => { if (signal?.aborted) fail('INSTRUCTION_CANCELLED', 'Instruction scan cancelled; inventory is incomplete.'); };
  cancelled();
  const expected = lstatSync(file, { bigint: true });
  if (!expected.isFile() || expected.isSymbolicLink() || expected.nlink !== 1n) fail('INSTRUCTION_UNSAFE_FILE', 'Instruction file must be regular and have one link.');
  if (maxBytes !== undefined && expected.size > BigInt(maxBytes)) fail('INSTRUCTION_LIMIT', 'Instruction file exceeds explicit read budget.');
  const fd = openSync(file, noFollowReadFlags());
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || crossStatIdentity(before) !== crossStatIdentity(expected)) fail('INSTRUCTION_CHANGED', 'Instruction file changed before reading.');
    const buffer = Buffer.alloc(INSTRUCTION_READ_CHUNK_BYTES), hash = createHash('sha256');
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    let size = 0, nonempty = false, managedMarker = false, markerTail = '';
    let prefix = '', headerEnd = null, textBytes = 0, headerTail = '', bodyNonempty = false;
    const textChunk = (text, eof = false) => {
      if (text.includes('\0')) fail('BINARY_INSTRUCTION', 'Instruction contains binary data.');
      nonempty ||= /\S/u.test(text);
      const markers = markerTail + text;
      managedMarker ||= markers.includes('<!-- FLOWCAIRN:');
      markerTail = markers.slice(-14);
      if (!collectFrontmatter) return;
      prefix = (prefix + text).slice(0, 5);
      const headerStart = /^---\r?\n/.exec(prefix)?.[0].length;
      if (headerEnd !== null) { bodyNonempty ||= /\S/u.test(text); return; }
      const joined = headerTail + text, base = textBytes - Buffer.byteLength(headerTail);
      textBytes += Buffer.byteLength(text);
      if (headerStart !== undefined) {
        const closing = (eof ? /\r?\n---(?:\r?\n|$)/u : /\r?\n---\r?\n/u).exec(joined);
        if (closing) {
          headerEnd = base + Buffer.byteLength(joined.slice(0, closing.index));
          bodyNonempty ||= /\S/u.test(joined.slice(closing.index + closing[0].length));
        }
      }
      headerTail = joined.slice(-8);
    };
    let count;
    while ((count = readSync(fd, buffer, 0, Math.min(buffer.length, Number(before.size) - size + 1), null)) > 0) {
      cancelled(); size += count;
      if (BigInt(size) > before.size) fail('INSTRUCTION_CHANGED', 'Instruction file grew during reading.');
      if (!Number.isSafeInteger(size) || maxBytes !== undefined && size > maxBytes) fail('INSTRUCTION_LIMIT', 'Instruction file exceeds explicit read budget.');
      const bytes = buffer.subarray(0, count); hash.update(bytes);
      let text;
      try { text = decoder.decode(bytes, { stream: true }); } catch { fail('INVALID_UTF8', 'Instruction must be UTF-8.'); }
      textChunk(text); onChunk?.(bytes, text);
    }
    try { textChunk(decoder.decode(), true); } catch (error) { if (error instanceof GraphError) throw error; fail('INVALID_UTF8', 'Instruction must be UTF-8.'); }
    cancelled();
    let frontmatter = null;
    const headerStart = /^---\r?\n/.exec(prefix)?.[0].length;
    const confirmedEnd = headerEnd ?? -1;
    if (collectFrontmatter && headerStart !== undefined && confirmedEnd >= headerStart) {
      // Collect only a confirmed metadata range, never an unterminated body.
      const pieces = [];
      for (let offset = headerStart; offset < confirmedEnd;) {
        cancelled();
        const count = readSync(fd, buffer, 0, Math.min(buffer.length, confirmedEnd - offset), offset);
        if (!count) fail('INSTRUCTION_CHANGED', 'Instruction metadata changed during reading.');
        pieces.push(Buffer.from(buffer.subarray(0, count))); offset += count;
      }
      try { frontmatter = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(pieces)); }
      catch { fail('INVALID_UTF8', 'Instruction metadata must be UTF-8.'); }
    }
    const after = fstatSync(fd, { bigint: true }), live = lstatSync(currentPath(), { bigint: true });
    if (BigInt(size) !== before.size || crossStatIdentity(after) !== crossStatIdentity(before) || crossStatIdentity(live) !== crossStatIdentity(before)) fail('INSTRUCTION_CHANGED', 'Instruction file changed during reading.');
    return { sha256: hash.digest('hex'), size, mode: Number(before.mode & 0o777n), identity: `${before.dev}:${before.ino}:${Number(before.ctimeNs) / 1e6}`,
      nonempty, managedMarker, frontmatter, bodyNonempty };
  } finally { closeSync(fd); }
}

/** Content loading is explicit and separate from metadata discovery. */
export function collectInstructionFile(file, options = {}) {
  const chunks = [];
  const result = streamInstructionFile(file, { ...options, onChunk: (bytes) => chunks.push(Buffer.from(bytes)) });
  return { ...result, bytes: Buffer.concat(chunks, result.size) };
}
