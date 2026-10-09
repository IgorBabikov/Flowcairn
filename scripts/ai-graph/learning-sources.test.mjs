import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { GraphStore } from './lib/store.mjs';
import { hashObject, sha256 } from './lib/io.mjs';
import { SourceAnchorSchema, SourceChunkSchema } from './lib/learning-schemas.mjs';
import { captureLearningSources, readLearningSourceCatalog, readLearningSource, learningSourcePage, exactSourceAnchor } from './lib/learning-sources.mjs';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flowcairn-learning-source-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new GraphStore(root);
  const select = (name, text, role = 'after', mode = '100644') => {
    const bytes = Buffer.from(text);
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), bytes, { mode: mode === '100755' ? 0o755 : 0o644 });
    return { path: name, role, expected: { hash: sha256(bytes), size: bytes.length, mode } };
  };
  const capture = (files, policy = {}) => captureLearningSources({ store, projectRoot: root, sourceHash: hashObject(files), files, policy });
  const sources = (ref) => readLearningSourceCatalog(store, ref.sourceCatalogHash).sources;
  return { root, store, select, capture, sources };
}

test('BOM, Unicode, CRLF, empty file and trailing newline survive exact durable chunk round trip', (t) => {
  const fx = fixture(t);
  const text = '\ufeff' + '💡Привет\r\n'.repeat(3000) + 'последняя\r\n';
  const ref = fx.capture([fx.select('logic.py', text), fx.select('empty.unknown', ''), fx.select('main.go', 'package main\n', 'context', '100755')]);
  assert.deepEqual(ref.gaps, []);
  const sources = fx.sources(ref), saved = sources[0];
  assert.ok(saved.chunkHashes.length > 1);
  for (const id of saved.chunkHashes) assert.ok(Buffer.byteLength(fx.store.readObject('learning-source-chunks', id).text) <= 16384);
  const reopened = new GraphStore(fx.root);
  assert.equal(readLearningSource(reopened, saved), text);
  assert.equal(sha256(Buffer.from(readLearningSource(reopened, saved))), saved.fileHash);
  assert.equal(saved.fileHash, sha256(Buffer.from(text)));
  assert.equal(saved.lineCount, 3002);
  const page = learningSourcePage(saved, text, { lineCount: 2 });
  assert.equal(page.text, '\ufeff💡Привет\n💡Привет');
  assert.deepEqual(page.next, { startLine: 3, lineCount: 2 });
  const anchor = { sourceId: saved.id, fileHash: saved.fileHash, startLine: 1, endLine: 2, quote: page.text };
  assert.deepEqual(exactSourceAnchor(saved, text, anchor), anchor);
  assert.equal(exactSourceAnchor(saved, text, { ...anchor, quote: page.text.replaceAll('\n', '\r\n') }).sourceId, saved.id);
  assert.throws(() => exactSourceAnchor(saved, text, { ...anchor, quote: page.text.slice(1) }), { code: 'LEARNING_ANCHOR_INVALID' });
  assert.equal(sources[1].lineCount, 0); assert.deepEqual(sources[1].chunkHashes, []);
  assert.deepEqual(learningSourcePage(sources[1], ''), { sourceId: sources[1].id, fileHash: sources[1].fileHash, text: '', startLine: 1, endLine: 0, totalLines: 0, next: null });
  assert.equal(sources[2].lineCount, 2); assert.equal(sources[2].mode, '100755');
});

test('before bytes remain immutable after delete/rename and no live access is needed to read', (t) => {
  const fx = fixture(t), before = fx.capture([fx.select('old.rs', 'fn old() {}\n', 'before')]);
  fs.renameSync(path.join(fx.root, 'old.rs'), path.join(fx.root, 'new.rs'));
  const after = fx.capture([{ path: 'old.rs', role: 'after', expected: null }, { path: 'new.rs', role: 'after', expected: { hash: sha256('fn old() {}\n'), size: 12, mode: '100644' } }]);
  assert.equal(fx.sources(after).length, 1); assert.deepEqual(after.gaps, []);
  fs.unlinkSync(path.join(fx.root, 'new.rs'));
  assert.equal(readLearningSource(fx.store, fx.sources(before)[0]), 'fn old() {}\n');
  const absent = fx.capture([{ path: 'new.rs', role: 'before', expected: null }]);
  assert.deepEqual(fx.sources(absent), []); assert.deepEqual(absent.gaps, []);
  const newDirectory = fx.capture([{ path: 'new/deep/code.py', role: 'before', expected: null }]);
  assert.deepEqual(fx.sources(newDirectory), []); assert.deepEqual(newDirectory.gaps, []);
  assert.equal(fx.capture([{ path: 'missing.rs', role: 'context', expected: null }]).gaps[0].code, 'missing-context');
});

test('capture preserves complete files beyond old file/count/aggregate ceilings', (t) => {
  const fx = fixture(t), limit = { fileBytes: 256 * 1024 };
  const large = fx.capture([fx.select('large.txt', 'x'.repeat(limit.fileBytes + 1))]);
  assert.equal(fx.sources(large).length, 1); assert.deepEqual(large.gaps, []);
  assert.equal(readLearningSource(fx.store, fx.sources(large)[0]).length, limit.fileBytes + 1);
  const many = fx.capture([...Array.from({ length: 65 }, (_, index) => fx.select(`file-${index}.txt`, 'ok')), { path: 'absent.txt', role: 'before', expected: null }]);
  assert.equal(fx.sources(many).length, 65); assert.equal(many.gaps.length, 0);
  const total = fx.capture(Array.from({ length: 9 }, (_, index) => fx.select(`big-${index}.txt`, String(index).repeat(limit.fileBytes))));
  assert.equal(fx.sources(total).length, 9); assert.deepEqual(total.gaps, []);
  assert.equal(readLearningSource(fx.store, fx.sources(total)[0]).length, limit.fileBytes);
});

test('long lines are saved whole; page/quote limits never silently cut a line', (t) => {
  const fx = fixture(t), text = 'x'.repeat(65537);
  const source = fx.sources(fx.capture([fx.select('long.custom', text)]))[0];
  assert.equal(readLearningSource(fx.store, source), text);
  const first = learningSourcePage(source, text);
  assert.equal(first.partial, true); assert.ok(first.next.startColumn > 0);
  const last = learningSourcePage(source, text, first.next);
  assert.equal(first.text + last.text, text); assert.equal(last.next, null);
  const paged = 'a'.repeat(40000) + '\n' + 'b'.repeat(40000);
  const second = fx.sources(fx.capture([fx.select('paged.txt', paged)]))[0];
  const firstPage = learningSourcePage(second, paged);
  assert.equal(firstPage.endLine, 1); assert.deepEqual(firstPage.next, { startLine: 2, lineCount: 100 });
  assert.equal(learningSourcePage(second, paged, firstPage.next).text, 'b'.repeat(40000));
  assert.equal(SourceAnchorSchema.safeParse({ sourceId: source.id, fileHash: source.fileHash, startLine: 1, endLine: 1, quote: '💡'.repeat(2049) }).success, false);
  assert.equal(SourceChunkSchema.safeParse({ version: 1, text: '\ud800' }).success, false);
  assert.throws(() => learningSourcePage(second, paged, { lineCount: 201 }), { code: 'LEARNING_PAGE_INVALID' });
});

test('secret/path/binary policy rejects content without leaking excluded names', (t) => {
  const fx = fixture(t);
  const files = [fx.select('.env', 'HELLO=world'), fx.select('private/credentials.txt', 'hidden'), fx.select('deny.txt', 'hidden'),
    fx.select('forbidden/code.py', 'print(1)'), fx.select('ordinary.txt', 'token=' + 'abcd'.repeat(8)),
    fx.select('invalid.txt', Buffer.from([0xff])), fx.select('binary.txt', Buffer.from([0, 1])), fx.select('build/a.txt', 'output')];
  const ref = fx.capture(files, { denyGlobs: ['deny.*'], forbiddenPaths: ['forbidden'] });
  assert.equal(fx.sources(ref).length, 0); assert.equal(ref.gaps.length, files.length);
  for (const gap of ref.gaps) { assert.equal(gap.path, null); assert.equal(gap.code, 'excluded-source'); }
  const unknown = fx.capture([fx.select('main.unlistedlanguage', 'FLOW input => output\n')]);
  assert.equal(fx.sources(unknown).length, 1);
  for (const policy of [{ denyGlobs: ['**/*.unlistedlanguage'] }, { forbiddenPaths: ['main.unlistedlanguage'] }, { outputPaths: ['main.unlistedlanguage'] }])
    assert.throws(() => readLearningSource(fx.store, fx.sources(unknown)[0], policy), { code: 'LEARNING_SOURCE_DENIED' });
});

test('symlinks, hardlinks, ancestor symlinks and stale expected hashes cannot enter capture', (t) => {
  const fx = fixture(t), entry = fx.select('code.py', 'print(1)');
  fs.symlinkSync('code.py', path.join(fx.root, 'link.py'));
  fs.linkSync(path.join(fx.root, 'code.py'), path.join(fx.root, 'hard.py'));
  fs.mkdirSync(path.join(fx.root, 'actual')); fs.writeFileSync(path.join(fx.root, 'actual', 'code.py'), 'print(1)');
  fs.symlinkSync('actual', path.join(fx.root, 'alias'));
  const ref = fx.capture(['link.py', 'hard.py', 'code.py', 'alias/code.py'].map((name) => ({ ...entry, path: name })));
  assert.equal(fx.sources(ref).length, 0); assert.equal(ref.gaps.length, 4);
  assert.ok(ref.gaps.every((gap) => gap.code === 'capture-unavailable'));
  const drift = fx.select('drift.py', 'print(1)'); fs.writeFileSync(path.join(fx.root, 'drift.py'), 'print(2)');
  assert.equal(fx.capture([drift]).gaps[0].code, 'capture-unavailable');
  const unsafe = fx.capture([{ ...drift, path: '../outside.py' }, { ...drift, path: 'a/../b' }, { ...drift, path: 'a/CON.py' }]);
  assert.ok(unsafe.gaps.every((gap) => gap.path === null));
});

test('TOCTOU: a change during bounded fd reading yields a gap, not mismatched saved bytes', (t) => {
  const fx = fixture(t), entry = fx.select('race.py', 'print(1)');
  const original = fs.readSync;
  let changed = false;
  const mocked = t.mock.method(fs, 'readSync', (...args) => {
    const result = Reflect.apply(original, fs, args);
    if (!changed) { changed = true; fs.writeFileSync(path.join(fx.root, 'race.py'), 'print(2)'); }
    return result;
  });
  syncBuiltinESMExports();
  try { const ref = fx.capture([entry]); assert.equal(fx.sources(ref).length, 0); assert.equal(ref.gaps[0].code, 'capture-unavailable'); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test('catalog, chunk, hash, line count and ordering corruption are errors even under denied policy', (t) => {
  const fx = fixture(t), text = 'a'.repeat(16384) + 'b';
  const ref = fx.capture([fx.select('code.txt', text)]), source = fx.sources(ref)[0];
  for (const bad of [{ ...source, chunkHashes: [...source.chunkHashes].reverse() }, { ...source, lineCount: 99 }, { ...source, bytes: 1 }, { ...source, fileHash: 'f'.repeat(64) }])
    assert.throws(() => readLearningSource(fx.store, bad), { code: 'LEARNING_SOURCE_INTEGRITY' });
  const duplicate = fx.store.putObject('learning-sources', { version: 1, sources: [source, source] });
  assert.throws(() => readLearningSourceCatalog(fx.store, duplicate), { code: 'LEARNING_SOURCE_INTEGRITY' });
  const file = path.join(fx.root, '.ai-orchestrator/graph/learning-source-chunks', `${source.chunkHashes[0]}.json`);
  const wrapper = JSON.parse(fs.readFileSync(file, 'utf8')); wrapper.data.text = 'tampered'; fs.writeFileSync(file, JSON.stringify(wrapper));
  assert.throws(() => readLearningSource(fx.store, source, { denyGlobs: ['**'] }), { code: 'OBJECT_TAMPERED' });
});

test('selection does not scan unrelated trees, and durable-store faults are never downgraded to gaps', (t) => {
  const fx = fixture(t), entry = fx.select('selected.cs', 'class Example {}');
  fs.mkdirSync(path.join(fx.root, 'unrelated'));
  fs.writeFileSync(path.join(fx.root, 'unrelated', 'large.dat'), '');
  fs.truncateSync(path.join(fx.root, 'unrelated', 'large.dat'), 128 * 1024 * 1024);
  fs.symlinkSync('/not-available', path.join(fx.root, 'unrelated', 'link'));
  const ref = fx.capture([entry]);
  assert.deepEqual(ref.gaps, []); assert.equal(fx.sources(ref).length, 1);
  const events = [];
  const store = new GraphStore(fx.root, { fault: (stage, context) => {
    events.push([stage, context.kind]);
    if (stage === 'object.before-write' && context.kind === 'learning-sources') throw new Error('durable-write-fixture');
  } });
  const changed = fx.select('another.cs', 'class Another {}');
  assert.throws(() => captureLearningSources({ store, projectRoot: fx.root, sourceHash: hashObject('new'), files: [changed] }), /durable-write-fixture/);
  assert.ok(events.some(([stage, kind]) => stage === 'object.after-directory-fsync' && kind === 'learning-source-chunks'));
  assert.equal(readLearningSource(fx.store, fx.sources(ref)[0]), 'class Example {}');
});

test('длинная Unicode-строка читается до конца порциями без потери CRLF, BOM и хвоста', (t) => {
  const fx = fixture(t), text = '\ufeff' + 'Я💡'.repeat(23000) + '\r\nnext\r\n';
  const source = fx.sources(fx.capture([fx.select('large-unicode.txt', text)]))[0];
  let query = { startLine: 1, lineCount: 100 }, fragments = [], previous = -1;
  while (query) {
    const page = learningSourcePage(source, text, query);
    assert.ok(Buffer.byteLength(page.text) <= 65536);
    if (page.partial) {
      assert.equal(page.endLine, 1); assert.ok(page.next.startColumn > previous);
      previous = page.next.startColumn;
    }
    fragments.push(page.text);
    query = page.next;
  }
  assert.equal(fragments.join(''), text.replace(/\r\n/g, '\n'));
});

test('каталог больше 1000 исходников сохраняется страницами и сохраняет полный порядок и хеши', async (t) => {
  const fx = fixture(t);
  const { putLearningSourceCatalog } = await import('./lib/learning-source-storage.mjs');
  const sources = Array.from({ length: 1001 }, (_, index) => ({ id: `source-${index}`, path: `src/file-${index}.txt`,
    fileHash: sha256(''), bytes: 0, mode: '100644', role: 'context', chunkHashes: [], lineCount: 0 }));
  const hash = putLearningSourceCatalog(fx.store, { version: 1, sources });
  const manifest = fx.store.readObject('learning-sources', hash);
  assert.equal(manifest.version, 2); assert.equal(manifest.pageHashes.length, 2);
  assert.deepEqual(readLearningSourceCatalog(fx.store, hash).sources, sources);
  const wrong = fx.store.putObject('learning-sources', { ...manifest, pageHashes: [...manifest.pageHashes, manifest.pageHashes[0]] });
  assert.throws(() => readLearningSourceCatalog(fx.store, wrong), { code: 'LEARNING_SOURCE_INTEGRITY' });
});
