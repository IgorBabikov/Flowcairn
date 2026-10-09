import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, openSync, closeSync, writeSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { scanSourceFile, SOURCE_SCAN_CHUNK_BYTES } from '../scripts/ai-graph/lib/source-file-scan.mjs';
import { fingerprintDirectWorkspace } from '../scripts/ai-graph/lib/direct-workspace.mjs';
import { GraphStore } from '../scripts/ai-graph/lib/store.mjs';
import { hashObject } from '../scripts/ai-graph/lib/io.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-large-project-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('файл выше прежних 32/64 MiB проходит полный hash и чтение страницы при малой heap', (t) => {
  const root = fixture(t), file = path.join(root, 'large.txt');
  const buffer = Buffer.alloc(SOURCE_SCAN_CHUNK_BYTES, 120), hash = createHash('sha256');
  const fd = openSync(file, 'wx');
  const size = 64 * 1024 * 1024 + 17;
  try { for (let bytes = 0; bytes < size;) { const part = buffer.subarray(0, Math.min(buffer.length, size - bytes)); writeSync(fd, part); hash.update(part); bytes += part.length; } }
  finally { closeSync(fd); }
  const expected = hash.digest('hex');
  const sourceUrl = pathToFileURL(path.resolve('scripts/ai-graph/lib/project-source-access.mjs')).href;
  const directUrl = pathToFileURL(path.resolve('scripts/ai-graph/lib/direct-workspace.mjs')).href;
  const script = `
    import { inspectProjectSource, readProjectSourcePage } from ${JSON.stringify(sourceUrl)};
    import { fingerprintDirectWorkspace } from ${JSON.stringify(directUrl)};
    const root = process.argv[1], index = inspectProjectSource(root);
    const page = readProjectSourcePage(index, { path:'large.txt', offset:${size - 17}, limit:17 });
    const direct = fingerprintDirectWorkspace(root);
    process.stdout.write(JSON.stringify({ hash:index.files[0].hash, directHash:direct.files[0].hash,
      size:index.files[0].size, text:page.text, eof:page.eof, next:page.next, heap:process.memoryUsage().heapUsed }));`;
  const child = spawnSync(process.execPath, ['--max-old-space-size=64', '--input-type=module', '-e', script, root], { encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 });
  assert.equal(child.status, 0, child.stderr); assert.equal(child.error, undefined);
  const result = JSON.parse(child.stdout);
  assert.equal(result.hash, expected); assert.equal(result.directHash, expected); assert.equal(result.size, size);
  assert.equal(result.text, 'x'.repeat(17)); assert.equal(result.eof, true); assert.equal(result.next, null);
  assert.ok(result.heap < 64 * 1024 * 1024);
});

test('порции чтения ограничены; отмена и подмена не возвращают успешный hash', (t) => {
  const root = fixture(t), file = path.join(root, 'source.txt');
  writeFileSync(file, 'x'.repeat(200000));
  let maximum = 0;
  scanSourceFile(file, { onChunk: (bytes) => { maximum = Math.max(maximum, bytes.length); } });
  assert.ok(maximum <= SOURCE_SCAN_CHUNK_BYTES);
  const abort = new AbortController();
  assert.throws(() => scanSourceFile(file, { signal: abort.signal, onChunk: () => abort.abort() }), { code: 'SOURCE_SCAN_CANCELLED' });
  assert.equal(scanSourceFile(file).size, 200000);
  assert.throws(() => scanSourceFile(file, { onChunk: () => writeFileSync(file, 'changed') }), { code: 'SOURCE_FILE_CHANGED' });
  assert.equal(scanSourceFile(file).size, 7);
});

test('более 20 тысяч файлов и глубокий проект не отбрасываются; fingerprint восстанавливается из chunks', (t) => {
  const root = fixture(t), count = 20001;
  mkdirSync(path.join(root, 'files'));
  for (let i = 0; i < count; i++) writeFileSync(path.join(root, 'files', `${i}.txt`), '');
  const deep = path.join(root, ...Array(140).fill('d'));
  mkdirSync(deep, { recursive: true }); writeFileSync(path.join(deep, 'leaf.txt'), 'leaf');
  const fingerprint = fingerprintDirectWorkspace(root);
  assert.equal(fingerprint.files.length, count + 1);
  const store = new GraphStore(root);
  const reference = store.putFingerprint(fingerprint);
  assert.deepEqual(store.readFingerprint(reference.hash), fingerprint);
});

test('проверка сохраненного fingerprint не навязывает прежние пределы общего объема', (t) => {
  const root = fixture(t), store = new GraphStore(root);
  const files = [{ path: 'large.txt', hash: hashObject('bytes'), size: 600 * 1024 * 1024, mode: '100644' }];
  const body = { files, git: { head: null, indexHash: hashObject('index') } }, fingerprint = { ...body, hash: hashObject(body) };
  store.putFingerprint(fingerprint);
  assert.deepEqual(store.readFingerprint(fingerprint.hash), fingerprint);
});
