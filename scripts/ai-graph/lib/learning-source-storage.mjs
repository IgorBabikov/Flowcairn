import { mkdtempSync, realpathSync, openSync, closeSync, readSync, writeSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Hash } from './schema-primitives.mjs';
import { SourceChunkSchema, SourceCatalogSchema } from './learning-schemas.mjs';
import { scanSourceFile } from './source-file-scan.mjs';
import { GraphError } from './io.mjs';
import { createSecretContentScanner } from './stream-secret-policy.mjs';

const Index = z.strictObject({ version: z.literal(1), hashes: z.array(Hash).min(1).max(1000), next: Hash.nullable() });
const Pages = z.strictObject({ version: z.literal(2), pageHashes: z.array(Hash) });
const fail = (code, text) => { throw new GraphError(code, text); };

/** Chunk references form immutable linked pages; an individual stored record is
 * bounded while complete file/catalog totals have no fixed count/byte ceiling. */
export function putSourceChunkIndex(store, hashes) {
  let next = null;
  try {
    for (let end = hashes.length; end > 0; end -= 1000)
      next = store.putObject('learning-source-indexes', Index.parse({ version: 1, hashes: hashes.slice(Math.max(0, end - 1000), end), next }));
  } catch (error) { error.capturePersistenceFailure = true; throw error; }
  return next;
}
export function* savedSourceChunkHashes(store, source) {
  if (source.chunkHashes) { yield* source.chunkHashes; return; }
  const seen = new Set(); let next = source.chunkIndexHash;
  while (next) {
    if (seen.has(next)) fail('LEARNING_SOURCE_INTEGRITY', 'Chunk index contains a cycle.');
    seen.add(next);
    const parsed = Index.safeParse(store.readObject('learning-source-indexes', next));
    if (!parsed.success) fail('LEARNING_SOURCE_INTEGRITY', 'Source chunk index is corrupt.');
    yield* parsed.data.hashes; next = parsed.data.next;
  }
}
export function putLearningSourceCatalog(store, catalog) {
  if (catalog.sources.length <= 1000) return store.putObject('learning-sources', catalog);
  const pageHashes = [];
  for (let offset = 0; offset < catalog.sources.length; offset += 1000)
    pageHashes.push(store.putObject('learning-source-pages', SourceCatalogSchema.parse({ version: 1, sources: catalog.sources.slice(offset, offset + 1000) })));
  return store.putObject('learning-sources', { version: 2, pageHashes });
}
export function loadLearningSourceCatalog(store, hash) {
  const value = store.readObject('learning-sources', hash);
  if (value.version === 1) {
    const parsed = SourceCatalogSchema.safeParse(value);
    if (!parsed.success) fail('LEARNING_SOURCE_INTEGRITY', 'Source catalog is corrupt.');
    return parsed.data;
  }
  const pages = Pages.safeParse(value);
  if (!pages.success || new Set(pages.data.pageHashes).size !== pages.data.pageHashes.length)
    fail('LEARNING_SOURCE_INTEGRITY', 'Source catalog pages are corrupt.');
  const sources = [];
  for (const id of pages.data.pageHashes) sources.push(...SourceCatalogSchema.parse(store.readObject('learning-source-pages', id)).sources);
  return SourceCatalogSchema.parse({ version: 1, sources });
}

/** Snapshot first, verify the WHOLE file/hash/policy, then persist immutable chunks.
 * A secret, changed source or interrupted snapshot never publishes chunk data.
 */
export function saveLearningSourceBytes(store, file, expected, { beforePersist = () => {} } = {}) {
  const scratch = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'flowcairn-learning-source-'));
  let fd;
  try {
    const snapshot = path.join(scratch, 'source'); fd = openSync(snapshot, 'wx+', 0o600);
    const scanned = scanSourceFile(file, { onChunk: (bytes) => {
      for (let offset = 0; offset < bytes.length;) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    } });
    if (scanned.hash !== expected.hash || scanned.size !== expected.size || scanned.mode !== expected.mode)
      fail('LEARNING_CAPTURE_UNSAFE', 'Selected source changed during capture.');
    if (scanned.binary || scanned.secret) fail('LEARNING_SOURCE_DENIED', 'Source excluded by text/secret policy.');
    beforePersist();
    const put = (kind, data) => {
      try { return store.putObject(kind, data); }
      catch (error) { error.capturePersistenceFailure = true; throw error; }
    };
    const buffer = Buffer.alloc(16 * 1024 - 4), decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    const hashes = []; let offset = 0, lineCount = scanned.size === 0 ? 0 : 1;
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, offset);
      if (!count) break;
      offset += count;
      const text = decoder.decode(buffer.subarray(0, count), { stream: true });
      lineCount += (text.match(/\n/gu) ?? []).length;
      if (text) hashes.push(put('learning-source-chunks', SourceChunkSchema.parse({ version: 1, text })));
    }
    const tail = decoder.decode();
    if (tail) hashes.push(put('learning-source-chunks', SourceChunkSchema.parse({ version: 1, text: tail })));
    return { bytes: scanned.size, fileHash: scanned.hash, lineCount,
      ...(hashes.length <= 16 ? { chunkHashes: hashes } : { chunkIndexHash: putSourceChunkIndex(store, hashes) }) };
  } finally { if (fd !== undefined) closeSync(fd); rmSync(scratch, { recursive: true, force: true }); }
}

/** Iterate exact saved text and verify the complete hash/policy at EOF.
 * Consumers returning a page must exhaust this iterator before returning it.
 */
export function* verifiedSourceText(store, source) {
  const hash = createHash('sha256'), secrets = createSecretContentScanner();
  let bytes = 0, lines = source.bytes === 0 ? 0 : 1;
  for (const id of savedSourceChunkHashes(store, source)) {
    const parsed = SourceChunkSchema.safeParse(store.readObject('learning-source-chunks', id));
    if (!parsed.success) fail('LEARNING_SOURCE_INTEGRITY', 'Saved chunk is corrupt.');
    const text = parsed.data.text;
    hash.update(text, 'utf8'); bytes += Buffer.byteLength(text); lines += (text.match(/\n/gu) ?? []).length;
    secrets.update(text);
    if (text.includes('\0')) fail('LEARNING_SOURCE_INTEGRITY', 'Saved source contains binary data.');
    yield text;
  }
  if (bytes !== source.bytes || hash.digest('hex') !== source.fileHash || lines !== source.lineCount)
    fail('LEARNING_SOURCE_INTEGRITY', 'Saved bytes/hash/lines do not match.');
  if (secrets.finish()) fail('LEARNING_SOURCE_DENIED', 'Source excluded by current secret policy.');
}
