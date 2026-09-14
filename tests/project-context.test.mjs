import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, symlinkSync, linkSync } from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { discoverProjectContext, verifyProjectContext, readContextFile } from '../scripts/ai-graph/lib/project-context.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-context-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('/usr/bin/git', ['init', '--initial-branch=main'], { cwd: root, stdio: 'ignore' });
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

for (const [file, content] of [
  ['requirements.txt', '# Backend dependencies\nfastapi[standard]>=0.115\n'],
  ['go.mod', 'module example.invalid/api\n\ngo 1.23\nrequire (\n github.com/gin-gonic/gin v1.10.0\n)\n'],
  ['pom.xml', '<project><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>'],
  ['composer.json', JSON.stringify({ require: { 'laravel/framework': '^12' } })],
]) {
  test(`backend evidence supports ${file} without executing configuration`, (t) => {
    const f = fixture(t); f.write(file, content); f.pkg('package.json', { flowcairn: '*' });
    const context = discoverProjectContext(f.root);
    assert.deepEqual(context.domains, ['backend']);
    assert.ok(context.evidence.find((item) => item.path === file)?.hash);
    assert.equal(JSON.stringify(context).includes(content), false);
    f.write(file, content + '\n');
    assert.throws(() => verifyProjectContext(f.root, context), { code: 'CONTEXT_DRIFT' });
  });
}

test('backend classification ignores dependency comments and unrelated manifests', (t) => {
  const f = fixture(t); f.write('requirements.txt', '# fastapi>=1\nnumpy>=2\n');
  f.write('go.mod', 'module example.invalid/lib\n// require github.com/gin-gonic/gin v1.10.0\n');
  f.write('pom.xml', '<project><!-- <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency> --></project>');
  assert.deepEqual(discoverProjectContext(f.root).domains, ['engineering']);
  f.pkg('apps/web/package.json', { vue: '*' }); f.write('apps/web/src/index.js', '');
  f.write('apps/api/requirements.txt', 'fastapi>=1\n');
  const context = discoverProjectContext(f.root, { scope: ['apps/web/src'], manifestPaths: ['apps/api/requirements.txt'] });
  assert.deepEqual(context.domains, ['frontend']);
  assert.ok(!context.evidence.some((item) => item.path === 'apps/api/requirements.txt'));
});

test('profile lockfiles and unsupported formats remain outside classification reads', (t) => {
  const f = fixture(t); f.write('settings.py', 'raise Exception("must not execute")');
  f.write('package-lock.json', 'x'.repeat(65537));
  const context = discoverProjectContext(f.root, { manifestPaths: ['settings.py', 'package-lock.json'] });
  assert.deepEqual(context.domains, ['engineering']);
  assert.ok(!context.evidence.some((item) => ['settings.py', 'package-lock.json'].includes(item.path)));
});

test('native HTML entry point selects frontend without framework dependencies and stays scoped', (t) => {
  const f = fixture(t); f.pkg('package.json', { flowcairn: '*' });
  f.write('index.html', '<!doctype html><html><body><form></form></body></html>');
  assert.deepEqual(discoverProjectContext(f.root).domains, ['frontend']);
  f.write('requirements.txt', 'fastapi>=1');
  assert.deepEqual(discoverProjectContext(f.root).domains, ['backend', 'frontend']);
  f.write('api/requirements.txt', 'flask>=3'); f.write('api/app.py', '');
  assert.deepEqual(discoverProjectContext(f.root, { scope: ['api/app.py'] }).domains, ['backend']);
  const context = discoverProjectContext(f.root, { scope: ['index.html'] });
  f.write('index.html', '<!doctype html><html><body>Changed</body></html>');
  assert.deepEqual(verifyProjectContext(f.root, context), context);
  assert.equal(context.evidence.find((item) => item.path === 'index.html').basis, 'entry-presence');
  rmSync(path.join(f.root, 'index.html'));
  assert.throws(() => verifyProjectContext(f.root, context), { code: 'CONTEXT_DRIFT' });
});

test('unresolved Maven profiles and managed or test dependencies do not imply backend', (t) => {
  const f = fixture(t);
  const dependency = '<dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency>';
  for (const section of ['profiles', 'dependencyManagement', 'build']) {
    f.write('pom.xml', `<project><${section}>${dependency}</${section}></project>`);
    assert.deepEqual(discoverProjectContext(f.root).domains, ['engineering']);
  }
  f.write('pom.xml', `<project><dependencies>${dependency.replace('</dependency>', '<scope>test</scope></dependency>')}</dependencies></project>`);
  assert.deepEqual(discoverProjectContext(f.root).domains, ['engineering']);
});

test('bounded absent manifest probes preserve multi-path task applicability', (t) => {
  const f = fixture(t);
  const scope = Array.from({ length: 8 }, (_, index) => `module-${index}/src/components/new.js`);
  const context = discoverProjectContext(f.root, { scope });
  assert.deepEqual(context.domains, ['engineering']);
  assert.deepEqual(context.scope, scope);
  f.write('module-3/requirements.txt', 'fastapi>=1');
  assert.throws(() => verifyProjectContext(f.root, context), { code: 'CONTEXT_DRIFT' });
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
  assert.deepEqual(discoverProjectContext(f.root, { scope: ['missing/deeper/file'] }).domains, ['engineering']);
  symlinkSync(path.join(f.root, 'real'), path.join(f.root, 'linked'));
  assert.throws(() => discoverProjectContext(f.root, { scope: ['linked/package.json'] }), { code: 'CONTEXT_LINK_UNSAFE' });
  symlinkSync(path.join(f.root, 'real/package.json'), path.join(f.root, 'package.json'));
  assert.throws(() => discoverProjectContext(f.root), { code: 'CONTEXT_LINK_UNSAFE' });
  linkSync(path.join(f.root, 'real/package.json'), path.join(f.root, 'hard.json'));
  assert.throws(() => readContextFile(f.root, 'hard.json'), { code: 'CONTEXT_FILE_UNSAFE' });
});

test('size, manifest syntax and unsafe workspace patterns fail explicitly', (t) => {
  const f = fixture(t); f.write('package.json', 'x'.repeat(65537));
  assert.throws(() => discoverProjectContext(f.root), { code: 'CONTEXT_LIMIT' });
  f.write('package.json', '{bad');
  assert.throws(() => discoverProjectContext(f.root), { code: 'CONTEXT_MANIFEST_INVALID' });
  f.pkg('package.json', {}, { workspaces: ['../outside'] });
  assert.throws(() => discoverProjectContext(f.root), { code: 'WORKSPACES_PATH' });
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


test('shared workspace discovery supports nested/excluded patterns and pnpm manifests', (t) => {
  const f = fixture(t); f.pkg('package.json', {}, { workspaces: ['apps/**', '!apps/ignored'] });
  f.pkg('apps/deep/web/package.json', { vue: '*' }); f.pkg('apps/ignored/package.json', { express: '*' });
  assert.deepEqual(discoverProjectContext(f.root, { scope: ['apps'] }).domains, ['frontend']);
  f.pkg('package.json'); f.write('pnpm-workspace.yaml', 'packages:\n  - apps/**\n  - "!apps/ignored"\n');
  const result = discoverProjectContext(f.root, { scope: ['apps'] });
  assert.deepEqual(result.domains, ['frontend']);
  assert.ok(result.evidence.find((e) => e.path === 'pnpm-workspace.yaml').hash);
});


test('task directory trailing slash and new nested files resolve through the nearest safe package', (t) => {
  const f = fixture(t); f.pkg('apps/web/package.json', { vue: '*' }); f.write('apps/web/src/main.js', '');
  const directory = discoverProjectContext(f.root, { scope: ['apps/web/src/'] });
  assert.deepEqual(directory.scope, ['apps/web/src']);
  assert.deepEqual(directory.domains, ['frontend']);
  const created = discoverProjectContext(f.root, { scope: ['apps/web/src/components/auth/Register.tsx'] });
  assert.deepEqual(created.domains, ['frontend']);
  assert.throws(() => discoverProjectContext(f.root, { scope: ['apps/web/src//'] }), { code: 'CONTEXT_PATH_UNSAFE' });
  assert.throws(() => discoverProjectContext(f.root, { scope: ['apps/web/src/new/../../escape'] }), { code: 'CONTEXT_PATH_UNSAFE' });
  symlinkSync(path.join(f.root, 'apps/web/src'), path.join(f.root, 'alias'));
  assert.throws(() => discoverProjectContext(f.root, { scope: ['alias/new/deep/file'] }), { code: 'CONTEXT_LINK_UNSAFE' });
});
