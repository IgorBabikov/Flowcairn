import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, symlinkSync, linkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverProjectContext, verifyProjectContext, readContextFile } from '../scripts/ai-graph/lib/project-context.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-context-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, text) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), text); };
  const pkg = (file, dependencies = {}, extra = {}) => write(file, JSON.stringify({ dependencies, ...extra }));
  return { root, write, pkg };
}

for (const [domain, deps] of [['frontend', { react: '*' }], ['backend', { fastify: '*' }], ['mobile', { react: '*', 'react-native': '*' }], ['engineering', {}]]) {
  test(`discovers ${domain} from scoped package evidence`, (t) => {
    const f = fixture(t); f.pkg('package.json', deps); f.write('src/main.txt', 'source');
    const result = discoverProjectContext(f.root, { scope: ['src'] });
    assert.deepEqual(result.domains, [domain]);
    assert.equal(result.evidence.find((file) => file.path === 'package.json').hash.length, 64);
    assert.equal(JSON.stringify(result).includes(f.root), false);
    assert.equal(JSON.stringify(result).includes('dependencies'), false);
    assert.deepEqual(verifyProjectContext(f.root, result), result);
  });
}

test('fullstack package selects both domains; react-native does not imply browser', (t) => {
  const f = fixture(t); f.pkg('package.json', { 'react-dom': '*', express: '*' });
  assert.deepEqual(discoverProjectContext(f.root).domains, ['backend', 'frontend']);
  f.pkg('package.json', { react: '*', 'react-native': '*' });
  assert.deepEqual(discoverProjectContext(f.root).domains, ['mobile']);
});

test('mixed workspace selects nearest package and does not inherit root or sibling norms', (t) => {
  const f = fixture(t); f.pkg('package.json', { express: '*' }, { workspaces: ['apps/*'] });
  f.pkg('apps/web/package.json', { vue: '*' }); f.write('apps/web/src/index.js', '');
  f.pkg('apps/api/package.json', { fastify: '*' }); f.pkg('apps/mobile/package.json', { expo: '*' });
  const web = discoverProjectContext(f.root, { scope: ['apps/web/src'] });
  assert.deepEqual(web.domains, ['frontend']);
  assert.ok(!web.evidence.some((file) => file.path.includes('/api/') || file.path.includes('/mobile/')));
  assert.deepEqual(discoverProjectContext(f.root, { scope: ['apps/api'] }).domains, ['backend']);
  assert.deepEqual(discoverProjectContext(f.root, { scope: ['apps'] }).domains, ['backend', 'frontend', 'mobile']);
  assert.deepEqual(discoverProjectContext(f.root, { scope: ['apps/web', 'apps/api'] }).domains, ['backend', 'frontend']);
});

test('explicit manifest paths support workspace layouts without recursive scans', (t) => {
  const f = fixture(t); f.pkg('packages/web/package.json', { svelte: '*' });
  f.pkg('packages/api/package.json', { koa: '*' });
  const result = discoverProjectContext(f.root, { scope: ['packages'], manifestPaths: ['packages/web/package.json', 'packages/api/package.json'] });
  assert.deepEqual(result.domains, ['backend', 'frontend']);
  assert.throws(() => discoverProjectContext(f.root, { manifestPaths: ['missing/package.json'] }), { code: 'CONTEXT_FILE_MISSING' });
});

test('Flutter manifest is mobile; unidentified code remains engineering', (t) => {
  const f = fixture(t); f.write('pubspec.yaml', 'dependencies:\n  flutter:\n    sdk: flutter\n');
  assert.deepEqual(discoverProjectContext(f.root).domains, ['mobile']);
  rmSync(path.join(f.root, 'pubspec.yaml'));
  f.write('main.py', 'print("hello")');
  assert.deepEqual(discoverProjectContext(f.root, { scope: ['main.py'] }).domains, ['engineering']);
});

test('changed, removed, newly appearing manifests and tampered classifications fail closed', (t) => {
  const f = fixture(t); f.pkg('package.json', { react: '*' }); f.write('src/index.js', '');
  const original = discoverProjectContext(f.root, { scope: ['src'] });
  f.pkg('package.json', { vue: '*' });
  assert.throws(() => verifyProjectContext(f.root, original), { code: 'CONTEXT_DRIFT' });
  f.pkg('package.json', { react: '*' }); f.pkg('src/package.json', { fastify: '*' });
  assert.throws(() => verifyProjectContext(f.root, original), { code: 'CONTEXT_DRIFT' });
  rmSync(path.join(f.root, 'src/package.json')); rmSync(path.join(f.root, 'package.json'));
  assert.throws(() => verifyProjectContext(f.root, original), { code: 'CONTEXT_DRIFT' });
  assert.throws(() => verifyProjectContext(f.root, { ...original, domains: ['mobile'] }), { code: 'CONTEXT_DRIFT' });
});

test('scope and file reader reject traversal, secrets, missing parents and all link components', (t) => {
  const f = fixture(t); f.write('real/package.json', '{}');
  for (const scope of ['../outside', '/tmp', '.env', 'credentials.json', '.ssh/config', 'src//file'])
    assert.throws(() => discoverProjectContext(f.root, { scope: [scope] }), { code: 'CONTEXT_PATH_UNSAFE' });
  assert.throws(() => discoverProjectContext(f.root, { scope: ['missing/deeper/file'] }), { code: 'CONTEXT_SCOPE_UNKNOWN' });
  symlinkSync(path.join(f.root, 'real'), path.join(f.root, 'linked'));
  assert.throws(() => discoverProjectContext(f.root, { scope: ['linked/package.json'] }), { code: 'CONTEXT_LINK_UNSAFE' });
  symlinkSync(path.join(f.root, 'real/package.json'), path.join(f.root, 'package.json'));
  assert.throws(() => discoverProjectContext(f.root), { code: 'CONTEXT_LINK_UNSAFE' });
  linkSync(path.join(f.root, 'real/package.json'), path.join(f.root, 'hard.json'));
  assert.throws(() => readContextFile(f.root, 'hard.json'), { code: 'CONTEXT_FILE_UNSAFE' });
});

test('size, manifest syntax and workspace pattern limits fail explicitly', (t) => {
  const f = fixture(t); f.write('package.json', 'x'.repeat(65537));
  assert.throws(() => discoverProjectContext(f.root), { code: 'CONTEXT_LIMIT' });
  f.write('package.json', '{bad');
  assert.throws(() => discoverProjectContext(f.root), { code: 'CONTEXT_MANIFEST_INVALID' });
  f.pkg('package.json', {}, { workspaces: ['apps/**'] });
  assert.throws(() => discoverProjectContext(f.root), { code: 'CONTEXT_WORKSPACE_UNSUPPORTED' });
  f.pkg('package.json', {}, { workspaces: ['apps/*'] });
  for (let i = 0; i < 129; i++) mkdirSync(path.join(f.root, 'apps', `p${i}`), { recursive: true });
  assert.throws(() => discoverProjectContext(f.root), { code: 'CONTEXT_LIMIT' });
});


test('Flowcairn installation metadata does not imply frontend or a JavaScript product', (t) => {
  const f = fixture(t); f.pkg('package.json', { flowcairn: '*' }); f.write('main.py', 'print("hello")');
  const context = discoverProjectContext(f.root, { scope: ['main.py'] });
  assert.deepEqual(context.domains, ['engineering']);
});

test('declared unrelated workspace manifests are not read for a narrow node', (t) => {
  const f = fixture(t); f.pkg('apps/web/package.json', { vue: '*' }); f.write('apps/web/src/index.js', '');
  f.write('apps/api/package.json', 'invalid JSON in unrelated package');
  const result = discoverProjectContext(f.root, { scope: ['apps/web/src'], manifestPaths: ['apps/web/package.json', 'apps/api/package.json'] });
  assert.deepEqual(result.domains, ['frontend']);
  assert.ok(!result.evidence.some((item) => item.path === 'apps/api/package.json'));
});
