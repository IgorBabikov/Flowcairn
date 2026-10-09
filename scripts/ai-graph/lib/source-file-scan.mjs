import { createHash } from 'node:crypto';
import { openSync, closeSync, readSync, realpathSync } from 'node:fs';
import { lstatHostSync as lstatSync, fstatHostSync as fstatSync, noFollowReadFlags, crossStatIdentity, sameHostPath } from './host-filesystem.mjs';
import { GraphError } from './io.mjs';
import { createSecretContentScanner } from './stream-secret-policy.mjs';

export const SOURCE_SCAN_CHUNK_BYTES = 64 * 1024;
/** Hash every byte and classify the complete text without retaining it. Optional
 * byte window is collected during the same validated read, never from a later
 * unverified descriptor. Memory: working buffer + requested window + policy tail.
 */
export function scanSourceFile(file, { expected = lstatSync(file, { bigint: true }), signal = undefined, window = undefined, onChunk = undefined, classify = true } = {}) {
  const fail = (message) => { throw new GraphError('SOURCE_FILE_CHANGED', message); };
  const cancelled = () => { if (signal?.aborted) throw new GraphError('SOURCE_SCAN_CANCELLED', 'Source scan cancelled.'); };
  cancelled();
  if (!expected.isFile() || expected.isSymbolicLink() || expected.nlink !== 1n || !sameHostPath(realpathSync(file), file)) fail('Source must be a regular unlinked file.');
  const fd = openSync(file, noFollowReadFlags());
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (crossStatIdentity(opened) !== crossStatIdentity(expected)) fail('Source changed before reading.');
    const size = Number(expected.size);
    if (!Number.isSafeInteger(size)) fail('Source size cannot be represented exactly.');
    const buffer = Buffer.alloc(SOURCE_SCAN_CHUNK_BYTES), hash = createHash('sha256');
    const utf8 = new TextDecoder('utf-8', { fatal: true }), text = new TextDecoder('utf-8'), secrets = createSecretContentScanner();
    let bytes = 0, binary = false;
    const pages = [];
    while (true) {
      cancelled();
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, size - bytes + 1), null);
      if (!count) break;
      const chunk = buffer.subarray(0, count), start = bytes; bytes += count;
      if (bytes > size) fail('Source grew during reading.');
      hash.update(chunk);
      if (classify) {
        binary ||= chunk.includes(0);
        if (!binary) { try { utf8.decode(chunk, { stream: true }); } catch { binary = true; } }
        secrets.update(text.decode(chunk, { stream: true }));
      }
      if (window && bytes > window.offset && start < window.offset + window.bytes) {
        pages.push(Buffer.from(chunk.subarray(Math.max(0, window.offset - start), Math.min(count, window.offset + window.bytes - start))));
      }
      onChunk?.(chunk);
    }
    if (classify && !binary) { try { utf8.decode(); } catch { binary = true; } }
    if (classify) secrets.update(text.decode());
    const secret = classify && secrets.finish(); cancelled();
    if (bytes !== size || crossStatIdentity(fstatSync(fd, { bigint: true })) !== crossStatIdentity(opened)
      || crossStatIdentity(lstatSync(file, { bigint: true })) !== crossStatIdentity(expected) || !sameHostPath(realpathSync(file), file)) fail('Source changed during reading.');
    return { hash: hash.digest('hex'), size, mode: expected.mode & 0o111n ? '100755' : '100644', binary, secret,
      ...(window ? { window: Buffer.concat(pages) } : {}) };
  } finally { closeSync(fd); }
}
