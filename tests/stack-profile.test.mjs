import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, symlinkSync, linkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { parseStackManifest, discoverStackProfile, verifyStackProfile } from '../scripts/ai-graph/lib/stack-profile.mjs';
import { discoverProjectContext, verifyProjectContext } from '../scripts/ai-graph/lib/project-context.mjs';
import { sha256 } from '../scripts/ai-graph/lib/io.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-stack-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('/usr/bin/git', ['init', '--initial-branch=main'], { cwd: root, stdio: 'ignore' });
  const write = (file, text) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), text); };
  const pkg = (file, dependencies = {}, extra = {}) => write(file, JSON.stringify({ dependencies, ...extra }));
  return { root, write, pkg };
}
const fact = (pkg, id, role = undefined) => pkg.frameworks.find((entry) => entry.id === id && (!role || entry.role === role));
const parsePackage = (dependencies, extra = {}) => parseStackManifest('package.json', JSON.stringify({ dependencies, ...extra }));

test('package facts distinguish exact, same-major and unresolved version declarations', () => {
  const pkg = parsePackage({ react: '^19.2.0', next: '15.4.2', fastify: '>=5 <7', vue: 'workspace:*' });
  assert.deepEqual(pkg.domains, ['backend', 'frontend']);
  assert.deepEqual(fact(pkg, 'react').version, { specifier: '^19.2.0', major: 19, status: 'range' });
  assert.deepEqual(fact(pkg, 'next').version, { specifier: '15.4.2', major: 15, status: 'exact' });
  assert.deepEqual(fact(pkg, 'fastify').version, { specifier: '>=5 <7', major: null, status: 'unknown' });
  assert.deepEqual(fact(pkg, 'vue').version, { specifier: null, major: null, status: 'unknown' });
  assert.equal(pkg.path, 'package.json');
  assert.equal(pkg.hash.length, 64);
});

test('version uncertainty never guesses a major from tags, URLs, unions or open ranges', () => {
  for (const raw of ['*', 'latest', '18 || 19', '>=19.0.0', 'git+https://secret.invalid/react', '/private/secret/react', 'npm:react@19', '19.0.0-private-token', '19.x.1', '19.0.0.0', '~=19']) {
    const entry = fact(parsePackage({ react: raw }), 'react');
    assert.equal(entry.version.major, null, raw);
    assert.equal(entry.version.status, 'unknown', raw);
    assert.equal(JSON.stringify(entry).includes('secret'), false);
    assert.equal(JSON.stringify(entry).includes('private'), false);
  }
  for (const raw of ['~19.2.0', '19', '19.x', '^0.4.2']) assert.notEqual(fact(parsePackage({ react: raw }), 'react').version.major, null);
});

test('dependency roles and conflicting declarations remain distinct facts', () => {
  const pkg = parsePackage({ react: '18.3.1' }, { devDependencies: { react: '19.2.0' }, peerDependencies: { react: '^18 || ^19' } });
  assert.equal(pkg.frameworks.length, 3);
  assert.equal(fact(pkg, 'react', 'dependency').version.major, 18);
  assert.equal(fact(pkg, 'react', 'development').version.major, 19);
  assert.equal(fact(pkg, 'react', 'peer').version.major, null);
  assert.throws(() => parsePackage({ react: { version: '19' } }), { code: 'STACK_MANIFEST_INVALID' });
});

test('React Native does not imply browser; explicit browser dependencies remain visible', () => {
  const mobile = parsePackage({ react: '19.1.0', 'react-native': '0.81.0', expo: '~54.0.0' });
  assert.deepEqual(mobile.domains, ['mobile']);
  assert.equal(fact(mobile, 'react').domain, 'mobile');
  assert.deepEqual(parsePackage({ react: '19', 'react-native': '0.81', 'react-dom': '19' }).domains, ['frontend', 'mobile']);
  assert.deepEqual(parsePackage({ flowcairn: '*', typescript: '5.9.3' }).domains, ['engineering']);
});

test('pyproject PEP 621 preserves declared versions and does not assume optional or conditional dependencies', () => {
  const pkg = parseStackManifest('api/pyproject.toml', `[project]\nname = "private project name"\ndependencies = ["FastAPI[standard]>=0.115,<1", "flask==3.1.0; python_version < '3.14'"]\n[project.optional-dependencies]\nadmin = ["django~=5.2.0"]\n`);
  assert.deepEqual(pkg.domains, ['backend']);
  assert.equal(fact(pkg, 'fastapi').version.major, null);
  assert.equal(fact(pkg, 'flask').role, 'conditional');
  assert.equal(fact(pkg, 'flask').domain, 'engineering');
  assert.equal(fact(pkg, 'django').role, 'optional');
  assert.equal(fact(pkg, 'django').version.major, 5);
  assert.equal(JSON.stringify(pkg).includes('private project name'), false);
  assert.deepEqual(parseStackManifest('pyproject.toml', '[project]\ndependencies = ["django==5.2; sys_platform == \'win32\'"]\n').domains, ['engineering']);
});

test('Poetry version facts never expose path/git dependencies or execute hooks', () => {
  const pkg = parseStackManifest('pyproject.toml', `[tool.poetry.dependencies]\npython = "^3.12"\ndjango = "^5.2.1"\nfastapi = { version = ">=0.115", git = "https://private.invalid/token" }\nflask = { version = "3.1.0", optional = true }\n[build-system]\nrequires = ["a-private-build-hook"]\n`);
  assert.equal(fact(pkg, 'django').version.major, 5);
  assert.equal(fact(pkg, 'fastapi').version.specifier, null);
  assert.equal(fact(pkg, 'flask').domain, 'engineering');
  assert.equal(JSON.stringify(pkg).includes('private'), false);
  assert.equal(JSON.stringify(pkg).includes('build-hook'), false);
});

test('pubspec requires a production Flutter SDK declaration, with unknown target platforms', () => {
  const pkg = parseStackManifest('mobile/pubspec.yaml', 'name: private_name\nenvironment:\n  flutter: ">=3.35.0 <4.0.0"\ndependencies:\n  flutter:\n    sdk: flutter\n');
  assert.deepEqual(pkg.domains, ['mobile']);
  assert.equal(fact(pkg, 'flutter').version.major, null);
  assert.ok(pkg.limitations.includes('flutter-target-platforms-unknown'));
  for (const text of ['{}\n# flutter:\n#  sdk: flutter\n', 'dependencies:\n  flutter: ^3.0.0\n', 'dev_dependencies:\n  flutter:\n    sdk: flutter\n'])
    assert.deepEqual(parseStackManifest('pubspec.yaml', text || '{}').domains, ['engineering']);
});

test('structured manifests reject duplicate keys, tags and aliases with sanitized errors', () => {
  for (const [file, text] of [['package.json', '{broken secret-content'], ['pyproject.toml', '[project]\nname="one"\nname="private"'],
    ['pubspec.yaml', 'dependencies: {}\ndependencies: {}'], ['pubspec.yaml', 'dependencies: !exec private-secret'],
    ['pubspec.yaml', 'dependencies: &deps {}\ndev_dependencies: *deps'], ['pyproject.toml', '__proto__.x = "private"']]) {
    assert.throws(() => parseStackManifest(file, text), (error) => error.code === 'STACK_MANIFEST_INVALID' && !error.message.includes('private') && !error.message.includes('secret'));
  }
});

test('native Android plugin evidence keeps AGP version separate from Android platform', () => {
  const pkg = parseStackManifest('app/build.gradle.kts', 'plugins {\n id("com.android.application") version "8.7.2"\n kotlin("android") version "2.1.0"\n}\nandroid { compileSdk = 35 }\n');
  assert.deepEqual(pkg.domains, ['mobile']);
  assert.equal(fact(pkg, 'android-gradle-plugin').version.major, 8);
  assert.equal(fact(pkg, 'android').version.major, null);
  assert.equal(fact(pkg, 'kotlin-android').version.major, 2);
  const groovy = parseStackManifest('build.gradle', "plugins { id 'com.android.library' version '8.7.2' }");
  assert.deepEqual(groovy.domains, ['mobile']);
});

test('JVM Kotlin, unapplied Android, version catalogs and conditional plugins stay engineering', () => {
  for (const text of ['plugins { kotlin("jvm") version "2.1.0" }', 'plugins { id("com.android.application") version "8.7.2" apply false }',
    'plugins { alias(libs.plugins.android.application) }', 'if (enabled) { plugins { id("com.android.application") } }',
    '// plugins { id("com.android.application") }', 'val note = "plugins { id(\\"com.android.application\\") }"',
    'plugins {\n val note = """\n id("com.android.application")\n """\n}',
    '/* plugins { id("com.android.application") }', 'plugins {\n val note = """\n id("com.android.application")\n}'])
    assert.deepEqual(parseStackManifest('build.gradle.kts', text).domains, ['engineering'], text);
  const dynamic = parseStackManifest('build.gradle.kts', 'plugins { id("com.android.application") version versions.android }');
  assert.deepEqual(dynamic.domains, ['mobile']);
  assert.equal(fact(dynamic, 'android-gradle-plugin').version.major, null);
  assert.deepEqual(parseStackManifest('build.gradle', "plugins { id 'org.springframework.boot' version '3.5.0' }").domains, ['backend']);
});

test('a Swift package is not an iOS app; literal deployment target is labeled separately', () => {
  const library = '// swift-tools-version: 6.0\nimport PackageDescription\nlet package = Package(name: "Private", platforms: [.macOS(.v14)], targets: [.target(name: "Core")])';
  assert.deepEqual(parseStackManifest('Package.swift', library).domains, ['engineering']);
  const mobile = parseStackManifest('ios/Package.swift', library.replace('.macOS(.v14)', '.iOS(.v17), .macOS(.v14)'));
  assert.deepEqual(mobile.domains, ['mobile']);
  assert.equal(fact(mobile, 'ios').version.major, 17);
  assert.equal(fact(mobile, 'ios').role, 'deployment-target');
  assert.equal(fact(mobile, 'swift-package').role, 'tools-requirement');
  assert.ok(mobile.limitations.includes('swift-package-is-not-an-ios-app'));
  for (const text of ['// .iOS(.v17)\nlet package = Package(name: "Core")', 'let fake = Other(platforms: [.iOS(.v17)])',
    'let package = Package(name: "platforms: [.iOS(.v17)]")', 'if enabled {\nlet package = Package(platforms: [.iOS(.v17)])\n}',
    'let package = Package(platforms: [enabled ? .iOS(.v17) : .macOS(.v14)])'])
    assert.deepEqual(parseStackManifest('Package.swift', text).domains, ['engineering'], text);
});

test('Xcode marker alone does not imply iOS; explicit SDK target does', () => {
  const ios = parseStackManifest('apps/Phone/Phone.xcodeproj/project.pbxproj', '{ objects = { A = { buildSettings = { SDKROOT = iphoneos; IPHONEOS_DEPLOYMENT_TARGET = 17.2; }; }; }; }');
  assert.equal(ios.scope, 'apps/Phone');
  assert.deepEqual(ios.domains, ['mobile']);
  assert.equal(fact(ios, 'ios').version.major, 17);
  for (const text of ['{ objects = {}; }', '{ buildSettings = { SDKROOT = macosx; }; }', '/* buildSettings = { SDKROOT = iphoneos; }; */',
    '{ note = "SDKROOT = iphoneos;"; }', '{ note = "SUPPORTED_PLATFORMS = \\"iphoneos iphonesimulator\\";"; }'])
    assert.deepEqual(parseStackManifest('App.xcodeproj/project.pbxproj', text).domains, ['engineering']);
});

test('.NET Web SDK, targets and conditional MSBuild state remain distinct', () => {
  const web = parseStackManifest('api/Api.csproj', '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>');
  assert.deepEqual(web.domains, ['backend']);
  assert.equal(fact(web, 'dotnet').version.major, 9);
  assert.equal(fact(web, 'aspnet-core').version.major, null);
  assert.deepEqual(parseStackManifest('api/Api.csproj', '<Project Sdk="Microsoft.NET.Sdk.Web" />').domains, ['backend']);
  const mobile = parseStackManifest('Phone.csproj', '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFrameworks>net9.0-ios;net9.0-android</TargetFrameworks></PropertyGroup></Project>');
  assert.deepEqual(mobile.domains, ['mobile']);
  assert.ok(fact(mobile, 'ios')); assert.ok(fact(mobile, 'android'));
  for (const body of ['<PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup>',
    '<PropertyGroup Condition="true"><TargetFramework>net9.0-ios</TargetFramework></PropertyGroup>',
    '<PropertyGroup><TargetFramework Condition="true">net9.0-ios</TargetFramework></PropertyGroup>',
    '<Choose><When Condition="true"><PropertyGroup><TargetFramework>net9.0-ios</TargetFramework></PropertyGroup></When></Choose>',
    '<Target Name="fake"><PropertyGroup><TargetFramework>net9.0-ios</TargetFramework></PropertyGroup></Target>',
    '<PropertyGroup><TargetFramework>$(PrivateTarget)</TargetFramework></PropertyGroup>',
    '<Unknown><PropertyGroup><TargetFramework>net9.0-ios</TargetFramework></PropertyGroup></Unknown>'])
    assert.deepEqual(parseStackManifest('Lib.csproj', `<Project Sdk="Microsoft.NET.Sdk">${body}</Project>`).domains, ['engineering'], body);
  assert.deepEqual(parseStackManifest('Lib.csproj', '<!DOCTYPE Project [<!ENTITY sdk "Microsoft.NET.Sdk.Web">]><Project Sdk="&sdk;"/>').domains, ['engineering']);
});

for (const [file, text, domain] of [
  ['requirements.txt', 'fastapi[standard]>=0.115\n', 'backend'],
  ['go.mod', 'module example.invalid/api\nrequire github.com/gin-gonic/gin v1.10.0\n', 'backend'],
  ['pom.xml', '<project><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>', 'backend'],
  ['composer.json', '{"require":{"laravel/framework":"^12"}}', 'backend'],
  ['index.html', '<!doctype html><html></html>', 'frontend'],
]) {
  test(`legacy ${file} retains scoped ${domain} guidance without guessed framework versions`, (t) => {
    const f = fixture(t); f.write(`app/${file}`, text); f.write('app/src/new.txt', '');
    const profile = discoverStackProfile(f.root, { scope: ['app/src'] });
    assert.deepEqual(profile.domains, [domain]);
    assert.deepEqual(profile.packages.map((pkg) => pkg.path), [`app/${file}`]);
    assert.deepEqual(profile.packages[0].frameworks, []);
    assert.ok(profile.packages[0].limitations.includes('legacy-domain-only-no-framework-version-facts'));
    assert.equal(profile.packages[0].hash, sha256(text));
    assert.deepEqual(discoverProjectContext(f.root, { scope: ['app/src'] }).domains, profile.domains);
  });
}

test('legacy domain-only parsing preserves negative dependency, profile and entity cases', () => {
  for (const [file, text] of [
    ['requirements.txt', '# fastapi>=1\nnumpy>=2\n-r private.txt'],
    ['go.mod', 'module example.invalid/lib\n// require github.com/gin-gonic/gin v1.10.0'],
    ['composer.json', '{"require":{"php":"^8.4"}}'],
    ['pom.xml', '<project><profiles><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency></profiles></project>'],
    ['pom.xml', '<!DOCTYPE project [<!ENTITY framework "spring-boot-starter-web">]><project/>'],
  ]) assert.deepEqual(parseStackManifest(file, text).domains, ['engineering']);
});

test('per-scope manifests choose nearest package, excluding root and sibling frameworks', (t) => {
  const f = fixture(t); f.pkg('package.json', { express: '5.1.0' }, { workspaces: ['apps/*'] });
  f.pkg('apps/web/package.json', { react: '19.2.0' }); f.write('apps/web/src/main.js', '');
  f.pkg('apps/api/package.json', { fastify: '5.6.0' });
  const profile = discoverStackProfile(f.root, { scope: ['apps/web/src/new/auth.ts'] });
  assert.equal(profile.version, 1); assert.equal(profile.guidanceOnly, true);
  assert.deepEqual(profile.domains, ['frontend']);
  assert.deepEqual(profile.packages.map((pkg) => pkg.path), ['apps/web/package.json']);
  assert.ok(!profile.evidence.some((entry) => entry.path.includes('apps/api/')));
  assert.equal(profile.packages[0].hash, profile.evidence.find((entry) => entry.path === 'apps/web/package.json').hash);
  assert.deepEqual(verifyStackProfile(f.root, profile), profile);
});

test('automatic ancestor native filenames and explicit paths exclude sibling native projects', (t) => {
  const f = fixture(t); f.write('apps/Phone/Phone.csproj', '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net9.0-ios</TargetFramework></PropertyGroup></Project>');
  f.write('apps/Phone/Phone.xcodeproj/project.pbxproj', '{ buildSettings = { SDKROOT = iphoneos; }; }');
  f.write('apps/Phone/src/main.swift', ''); f.write('apps/Other/Broken.csproj', 'invalid private source');
  const scope = ['apps/Phone/src'];
  const automatic = discoverStackProfile(f.root, { scope });
  assert.deepEqual(automatic.domains, ['mobile']);
  assert.equal(automatic.packages.length, 2);
  const profile = discoverStackProfile(f.root, { scope, manifestPaths: ['apps/Phone/Phone.csproj', 'apps/Phone/Phone.xcodeproj/project.pbxproj', 'apps/Other/Broken.csproj'] });
  assert.deepEqual(profile.domains, ['mobile']);
  assert.equal(profile.packages.length, 2);
  assert.ok(!profile.evidence.some((entry) => entry.path === 'apps/Other/Broken.csproj'));
  assert.equal(JSON.stringify(profile).includes(f.root), false);
  assert.equal(JSON.stringify(profile).includes('invalid private source'), false);
});

test('known ancestor manifests and explicit multi-ecosystem manifests are deterministic', (t) => {
  const f = fixture(t); f.write('api/pyproject.toml', '[project]\ndependencies = ["django==5.2.1"]');
  f.write('mobile/pubspec.yaml', 'dependencies:\n  flutter:\n    sdk: flutter\n');
  const options = { scope: ['mobile/lib/main.dart', 'api/new.py'], manifestPaths: ['mobile/pubspec.yaml', 'api/pyproject.toml'] };
  const profile = discoverStackProfile(f.root, options);
  assert.deepEqual(profile.domains, ['backend', 'mobile']);
  assert.deepEqual(discoverStackProfile(f.root, { scope: options.scope.toReversed(), manifestPaths: options.manifestPaths.toReversed() }), profile);
  assert.equal(profile.evidence.find((entry) => entry.path === 'api/pyproject.toml').hash, sha256('[project]\ndependencies = ["django==5.2.1"]'));
});

test('shared pnpm workspace inventory respects excluded children', (t) => {
  const f = fixture(t); f.pkg('package.json'); f.write('pnpm-workspace.yaml', 'packages:\n - apps/**\n - "!apps/ignored"\n');
  f.pkg('apps/web/package.json', { vue: '^3.5.0' }); f.pkg('apps/ignored/package.json', { expo: '^54' });
  const profile = discoverStackProfile(f.root, { scope: ['apps'] });
  assert.deepEqual(profile.domains, ['frontend']);
  assert.ok(profile.evidence.find((entry) => entry.path === 'pnpm-workspace.yaml').hash);
  assert.ok(!profile.packages.some((pkg) => pkg.path.includes('ignored')));
});

test('changed, removed, newly present or tampered evidence fails verification', (t) => {
  const f = fixture(t); f.pkg('package.json', { react: '^19' });
  const profile = discoverStackProfile(f.root, { scope: ['src/new.js'] });
  f.pkg('package.json', { react: '^18' }); assert.throws(() => verifyStackProfile(f.root, profile), { code: 'STACK_PROFILE_DRIFT' });
  f.pkg('package.json', { react: '^19' }); f.write('src/pyproject.toml', '[project]\ndependencies = ["django==5.2"]');
  assert.throws(() => verifyStackProfile(f.root, profile), { code: 'STACK_PROFILE_DRIFT' });
  rmSync(path.join(f.root, 'src/pyproject.toml')); rmSync(path.join(f.root, 'package.json'));
  assert.throws(() => verifyStackProfile(f.root, profile), { code: 'STACK_PROFILE_DRIFT' });
  assert.throws(() => verifyStackProfile(f.root, { ...profile, domains: ['mobile'] }), { code: 'STACK_PROFILE_DRIFT' });
  assert.throws(() => verifyStackProfile(f.root, { ...profile, version: 2 }), { code: 'STACK_PROFILE_INVALID' });
});

test('source hashes include comments and declarations without changing legacy v1 context', (t) => {
  const f = fixture(t); f.pkg('package.json', { react: '19' });
  const legacy = discoverProjectContext(f.root);
  f.write('pyproject.toml', '[project]\ndependencies = ["flask==3.1.0"]\n');
  const profile = discoverStackProfile(f.root);
  assert.deepEqual(verifyProjectContext(f.root, legacy), legacy);
  f.write('pyproject.toml', '[project]\ndependencies = ["flask==3.1.0"]\n# changed\n');
  assert.throws(() => verifyStackProfile(f.root, profile), { code: 'STACK_PROFILE_DRIFT' });
  assert.deepEqual(verifyProjectContext(f.root, legacy), legacy);
});

test('secret/traversal paths, roots and symlink components fail closed', (t) => {
  const f = fixture(t); f.write('real/package.json', '{}');
  for (const entry of ['../outside', '/tmp', '.env/config', '.ssh/package.json', 'credentials.json', 'src//file', 'C:/private']) {
    assert.throws(() => discoverStackProfile(f.root, { scope: [entry] }), { code: 'CONTEXT_PATH_UNSAFE' });
    assert.throws(() => discoverStackProfile(f.root, { manifestPaths: [entry] }), { code: 'CONTEXT_PATH_UNSAFE' });
  }
  symlinkSync(path.join(f.root, 'real'), path.join(f.root, 'linked'));
  assert.throws(() => discoverStackProfile(f.root, { scope: ['linked/new/deep/file'] }), { code: 'CONTEXT_LINK_UNSAFE' });
  assert.throws(() => discoverStackProfile(path.join(f.root, 'linked')), { code: 'CONTEXT_ROOT_UNSAFE' });
  symlinkSync(path.join(f.root, 'real/package.json'), path.join(f.root, 'package.json'));
  assert.throws(() => discoverStackProfile(f.root), { code: 'CONTEXT_LINK_UNSAFE' });
});

test('hardlinks, directories masquerading as manifests and missing declared manifests are rejected', (t) => {
  const f = fixture(t); f.write('real/data.json', '{}'); linkSync(path.join(f.root, 'real/data.json'), path.join(f.root, 'package.json'));
  assert.throws(() => discoverStackProfile(f.root), { code: 'CONTEXT_FILE_UNSAFE' });
  rmSync(path.join(f.root, 'package.json')); mkdirSync(path.join(f.root, 'pyproject.toml'));
  assert.throws(() => discoverStackProfile(f.root), { code: 'CONTEXT_FILE_UNSAFE' });
  rmSync(path.join(f.root, 'pyproject.toml'), { recursive: true });
  assert.throws(() => discoverStackProfile(f.root, { manifestPaths: ['missing/Lib.csproj'] }), { code: 'CONTEXT_FILE_MISSING' });
});

test('unknown executable configs and lockfiles are not read or executed', (t) => {
  const f = fixture(t); f.write('settings.py', 'raise Exception("private source")'); f.write('package-lock.json', 'invalid');
  f.write('setup.py', 'raise Exception("must not execute")');
  const profile = discoverStackProfile(f.root, { manifestPaths: ['settings.py', 'setup.py', 'package-lock.json'] });
  assert.deepEqual(profile.domains, ['engineering']);
  assert.equal(profile.packages.length, 0);
  assert.ok(!profile.evidence.some((entry) => ['settings.py', 'setup.py', 'package-lock.json'].includes(entry.path)));
  assert.equal(parseStackManifest('settings.py', 'private source'), null);
});

test('reader and pure parser enforce size and UTF-8 limits without returning raw manifests', (t) => {
  const f = fixture(t); const text = JSON.stringify({ private: 'x'.repeat(262144) }); f.write('package.json', text);
  assert.throws(() => discoverStackProfile(f.root), { code: 'CONTEXT_LIMIT' });
  assert.throws(() => parseStackManifest('package.json', text), { code: 'STACK_PROFILE_LIMIT' });
  f.write('package.json', Buffer.from([0xff, 0xfe]));
  assert.throws(() => discoverStackProfile(f.root), { code: 'CONTEXT_ENCODING' });
  assert.throws(() => discoverStackProfile(f.root, { scope: Array.from({ length: 65 }, (_, i) => `module-${i}`) }), { code: 'STACK_PROFILE_LIMIT' });
});

test('the complete 64-path task scope is retained without truncation', (t) => {
  const f = fixture(t); const scope = Array.from({ length: 64 }, (_, index) => `module-${index}/src/new.ts`);
  f.pkg('module-42/package.json', { vue: '^3.5.0' });
  const profile = discoverStackProfile(f.root, { scope });
  assert.deepEqual(profile.scope, scope.sort());
  assert.deepEqual(profile.domains, ['frontend']);
  assert.deepEqual(profile.packages.map((pkg) => pkg.path), ['module-42/package.json']);
  assert.deepEqual(verifyStackProfile(f.root, profile), profile);
});
