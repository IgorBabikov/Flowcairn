import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, symlinkSync, linkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverScopedStackManifests } from '../scripts/ai-graph/lib/stack-manifest-discovery.mjs';
import { discoverStackProfile, verifyStackProfile } from '../scripts/ai-graph/lib/stack-profile.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-native-inventory-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, text) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), text); };
  return { root, write };
}
const web = '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>';
const ios = '{ objects = { A = { buildSettings = { SDKROOT = iphoneos; IPHONEOS_DEPLOYMENT_TARGET = 17.2; }; }; }; }';

test('root consent discovers child native and polyglot projects with declared versions and target uncertainty', (t) => {
  const f = fixture(t);
  f.write('services/api/Api.csproj', web);
  f.write('services/python/pyproject.toml', '[project]\ndependencies = ["fastapi==0.115.2"]\n');
  f.write('apps/flutter/pubspec.yaml', 'dependencies:\n  flutter:\n    sdk: flutter\n');
  f.write('apps/phone/Phone.xcodeproj/project.pbxproj', ios);
  f.write('apps/android/build.gradle.kts', 'plugins { id("com.android.application") version versions.android }');
  const inventory = discoverScopedStackManifests(f.root);
  assert.deepEqual(inventory.manifestPaths, ['apps/android/build.gradle.kts', 'apps/flutter/pubspec.yaml',
    'apps/phone/Phone.xcodeproj/project.pbxproj', 'services/api/Api.csproj', 'services/python/pyproject.toml']);
  const profile = discoverStackProfile(f.root);
  assert.equal(profile.manifestDiscovery, 1);
  assert.deepEqual(profile.domains, ['backend', 'mobile']);
  assert.equal(profile.packages.length, 5);
  const facts = profile.packages.flatMap((pkg) => pkg.frameworks);
  assert.equal(facts.find((fact) => fact.id === 'dotnet').version.major, 9);
  assert.equal(facts.find((fact) => fact.id === 'android-gradle-plugin').version.major, null);
  assert.ok(profile.packages.find((pkg) => pkg.ecosystem === 'dart').limitations.includes('flutter-target-platforms-unknown'));
  assert.deepEqual(verifyStackProfile(f.root, profile), profile);
});

test('directory and future file scopes do not read sibling manifests or mix frameworks', (t) => {
  const f = fixture(t);
  f.write('apps/phone/Phone.xcodeproj/project.pbxproj', ios);
  f.write('apps/phone/src/main.swift', '');
  f.write('apps/backend/pyproject.toml', 'invalid private sibling content');
  f.write('apps/web/package.json', '{"dependencies":{"vue":"^3.5.0"}}');
  const phone = discoverStackProfile(f.root, { scope: ['apps/phone/src/new/deep.swift'] });
  assert.deepEqual(phone.packages.map((pkg) => pkg.path), ['apps/phone/Phone.xcodeproj/project.pbxproj']);
  assert.deepEqual(phone.domains, ['mobile']);
  const browser = discoverStackProfile(f.root, { scope: ['apps/web'] });
  assert.deepEqual(browser.domains, ['frontend']);
  assert.ok(!browser.evidence.some((entry) => entry.path.startsWith('apps/backend/') || entry.path.startsWith('apps/phone/')));
  assert.deepEqual(discoverScopedStackManifests(f.root, { scope: ['apps/web'] }).manifestPaths, []);
});

test('new and modified child manifests invalidate current profiles while historical discovery hashes remain verifiable', (t) => {
  const f = fixture(t);
  f.write('package.json', '{"dependencies":{"react":"19.2.0"}}');
  const historical = discoverStackProfile(f.root, { manifestDiscovery: 0 });
  assert.equal(Object.hasOwn(historical, 'manifestDiscovery'), false);
  const current = discoverStackProfile(f.root);
  f.write('api/Api.csproj', web);
  assert.throws(() => verifyStackProfile(f.root, current), { code: 'STACK_PROFILE_DRIFT' });
  assert.deepEqual(verifyStackProfile(f.root, historical), historical);
  const updated = discoverStackProfile(f.root);
  f.write('api/Api.csproj', `${web}\n<!-- changed -->`);
  assert.throws(() => verifyStackProfile(f.root, updated), { code: 'STACK_PROFILE_DRIFT' });
  assert.throws(() => discoverStackProfile(f.root, { manifestDiscovery: 2 }), { code: 'STACK_PROFILE_INVALID' });
});

test('discovery never executes config, manifests, lifecycle scripts or tests and never exposes raw content', (t) => {
  const f = fixture(t), sentinel = path.join(f.root, 'executed');
  const js = `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(sentinel)}, 'private-content');`;
  f.write('package.json', JSON.stringify({ scripts: { postinstall: 'touch executed', test: 'touch executed' } }));
  f.write('vite.config.mjs', js); f.write('app/private.test.mjs', js);
  f.write('app/setup.py', `open(${JSON.stringify(sentinel)}, 'w').write('private-content')`);
  f.write('app/Package.swift', `// swift-tools-version: 6.0\nimport Foundation\ntry! "private-content".write(toFile: ${JSON.stringify(sentinel)}, atomically: true, encoding: .utf8)`);
  f.write('app/build.gradle.kts', `plugins { id("com.android.application") version versions.privateVersion }\nnew File(${JSON.stringify(sentinel)}).text = "private-content"`);
  const profile = discoverStackProfile(f.root);
  assert.equal(existsSync(sentinel), false);
  assert.equal(JSON.stringify(profile).includes('private-content'), false);
  assert.equal(JSON.stringify(profile).includes(f.root), false);
  assert.ok(!profile.evidence.some((entry) => /setup\.py|vite\.config|private\.test/.test(entry.path)));
  assert.equal(profile.packages.flatMap((pkg) => pkg.frameworks).find((fact) => fact.id === 'android-gradle-plugin').version.major, null);
});

test('generated, artifact, fixture, hidden and sensitive trees are excluded from automatic content reads', (t) => {
  const f = fixture(t);
  for (const directory of ['node_modules', 'vendor', 'Pods', 'DerivedData', 'build', 'dist', 'output', 'artifacts',
    '.flowcairn-test-artifacts', '.gradle', '.dart_tool', '.git/fixtures', '.env', '.ssh', 'credentials.json',
    'private', 'tests', 'fixtures', 'docs', 'secrets']) f.write(`${directory}/pyproject.toml`, 'invalid private content');
  assert.deepEqual(discoverScopedStackManifests(f.root).manifestPaths, []);
  assert.deepEqual(discoverStackProfile(f.root).domains, ['engineering']);
  assert.ok(discoverStackProfile(f.root).limitations.includes('excluded-trees-require-explicit-manifest-paths'));
  assert.throws(() => discoverScopedStackManifests(f.root, { scope: ['.ssh'] }), { code: 'CONTEXT_PATH_UNSAFE' });
});

test('automatic traversal skips directory links, known manifest links and hardlinks fail closed', (t) => {
  const f = fixture(t), outside = fixture(t);
  outside.write('pyproject.toml', 'invalid private external content');
  symlinkSync(outside.root, path.join(f.root, 'linked'));
  symlinkSync(outside.root, path.join(f.root, 'Linked.xcodeproj'));
  assert.deepEqual(discoverScopedStackManifests(f.root).manifestPaths, []);
  assert.deepEqual(discoverStackProfile(f.root).domains, ['engineering']);
  assert.throws(() => discoverStackProfile(f.root, { scope: ['linked'] }), { code: 'CONTEXT_LINK_UNSAFE' });
  f.write('actual.csproj', web);
  symlinkSync(path.join(f.root, 'actual.csproj'), path.join(f.root, 'alias.csproj'));
  assert.throws(() => discoverStackProfile(f.root), { code: 'CONTEXT_LINK_UNSAFE' });
  rmSync(path.join(f.root, 'alias.csproj'));
  linkSync(path.join(f.root, 'actual.csproj'), path.join(f.root, 'hard.csproj'));
  assert.throws(() => discoverStackProfile(f.root), { code: 'CONTEXT_FILE_UNSAFE' });
});

test('inventory bounds fail closed and a narrower consented scope can safely discover the project', (t) => {
  const f = fixture(t), deep = Array.from({ length: 10 }, (_, index) => `level${index}`).join('/');
  f.write(`${deep}/Api.csproj`, web);
  assert.throws(() => discoverScopedStackManifests(f.root), { code: 'STACK_PROFILE_LIMIT' });
  assert.throws(() => discoverStackProfile(f.root), { code: 'STACK_PROFILE_LIMIT' });
  assert.deepEqual(discoverStackProfile(f.root, { scope: [deep] }).domains, ['backend']);
  const many = fixture(t);
  for (let index = 0; index < 257; index++) many.write(`App${index}.csproj`, web);
  assert.throws(() => discoverScopedStackManifests(many.root), { code: 'STACK_PROFILE_LIMIT' });
});
