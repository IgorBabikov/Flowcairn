import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, realpathSync, rmSync, symlinkSync, linkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectProjectSource, fingerprintProjectSource, readProjectSourcePage, listProjectSourcePage } from './lib/project-source-access.mjs';

function fixture(t) {
  const holder = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'project-source-test-')));
  const root = path.join(holder, 'project');
  mkdirSync(root);
  t.after(() => rmSync(holder, { recursive: true, force: true }));
  return { holder, root };
}

test('index uses current project, creates no copies and withholds whole private files', (t) => {
  const { holder, root } = fixture(t);
  writeFileSync(path.join(root, '.gitignore'), 'ignored.md');
  writeFileSync(path.join(root, 'ignored.md'), 'safe');
  writeFileSync(path.join(root, '.env'), 'private');
  writeFileSync(path.join(root, 'ordinary.json'), JSON.stringify({ value: 'ghp_' + 'A'.repeat(36) }));
  writeFileSync(path.join(root, 'internal.md'), 'private by policy');
  for (const name of ['node_modules', 'dist', '.git']) mkdirSync(path.join(root, name));
  const before = readdirSync(root);
  const index = inspectProjectSource(root, { denyGlobs: ['internal.*'] });
  assert.equal(index.root, root);
  assert.deepEqual(readdirSync(holder), ['project']);
  assert.deepEqual(readdirSync(root), before);
  assert.deepEqual(index.files.map((file) => file.path), ['.gitignore', 'ignored.md']);
  assert.deepEqual(index.excludedPaths, ['.env', '.git', 'dist', 'internal.md', 'node_modules', 'ordinary.json']);
  assert.equal(JSON.stringify(index).includes('ordinary.json'), false);
  assert.throws(() => readProjectSourcePage(index, { path: '.env' }));
  assert.throws(() => readProjectSourcePage(index, { path: '../project/.env' }));
  assert.equal(readProjectSourcePage(index, { path: 'ignored.md' }).text, 'safe');
});

test('live mutation changes source hash and invalidates page reads', (t) => {
  const { root } = fixture(t);
  writeFileSync(path.join(root, 'source.txt'), 'before');
  const index = inspectProjectSource(root);
  assert.deepEqual(fingerprintProjectSource(root), { files: index.files, hash: index.hash, privateHash: index.privateHash });
  writeFileSync(path.join(root, 'source.txt'), 'after');
  assert.notEqual(inspectProjectSource(root).hash, index.hash);
  assert.throws(() => readProjectSourcePage(index, { path: 'source.txt' }));
  assert.equal(readProjectSourcePage(inspectProjectSource(root), { path: 'source.txt' }).text, 'after');
});

test('large Unicode pages cover any admitted file and return explicit end', (t) => {
  const { root } = fixture(t);
  const text = 'Привет! '.repeat(20000);
  writeFileSync(path.join(root, 'large.txt'), text);
  writeFileSync(path.join(root, 'other.txt'), 'other');
  const index = inspectProjectSource(root);
  let result = '', offset = 0;
  do {
    const page = readProjectSourcePage(index, { path: 'large.txt', offset });
    result += page.text;
    if (page.eof) break;
    offset = page.next;
  } while (offset < Buffer.byteLength(text));
  assert.equal(result, text);
  const first = listProjectSourcePage(index, { limit: 1 });
  assert.equal(first.eof, false);
  assert.equal(listProjectSourcePage(index, { offset: first.next }).eof, true);
  assert.equal(readProjectSourcePage(index, { path: 'other.txt' }).text, 'other');
});

test('source aliases, hardlinks and post-index symlink swaps fail closed', (t) => {
  const { root } = fixture(t);
  const source = path.join(root, 'source.txt'), alias = path.join(root, 'alias.txt');
  writeFileSync(source, 'safe');
  const index = inspectProjectSource(root);
  linkSync(source, alias);
  assert.throws(() => inspectProjectSource(root));
  assert.throws(() => readProjectSourcePage(index, { path: 'source.txt' }));
  rmSync(alias);
  symlinkSync(source, alias);
  const linked = inspectProjectSource(root);
  assert.ok(linked.excludedPaths.includes('alias.txt'));
  assert.throws(() => readProjectSourcePage(linked, { path: 'alias.txt' }));
  rmSync(alias);
  writeFileSync(path.join(root, 'ｓｏｕｒｃｅ.txt'), 'safe');
  assert.throws(() => inspectProjectSource(root));
});

test('private mutation changes opaque freshness without disclosing names in JSON', (t) => {
  const { root } = fixture(t);
  writeFileSync(path.join(root, '.env'), 'first');
  const first = inspectProjectSource(root);
  writeFileSync(path.join(root, '.env'), 'second');
  const second = inspectProjectSource(root);
  assert.notEqual(first.privateHash, second.privateHash);
  assert.notEqual(first.hash, second.hash);
  assert.equal(JSON.stringify(second).includes('.env'), false);
});


test('installed instruction control directories are excluded without following their links', (t) => {
  const { root } = fixture(t);
  writeFileSync(path.join(root, 'safe.txt'), 'safe');
  for (const name of ['.agents', '.codex', '.claude', '.cursor']) {
    mkdirSync(path.join(root, name));
    symlinkSync(path.join(root, 'nonexistent-private-file'), path.join(root, name, 'installed'));
  }
  const index = inspectProjectSource(root);
  assert.deepEqual(index.files.map((file) => file.path), ['safe.txt']);
  assert.deepEqual(index.excludedPaths, ['.agents', '.claude', '.codex', '.cursor']);
});
