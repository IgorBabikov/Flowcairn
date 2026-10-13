import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { discoverStackProfile } from '../scripts/ai-graph/lib/stack-profile.mjs';
import { MOBILE_RECIPES, evaluateMobilePreflight, inspectMobilePreflight, inspectMobileRecipeOwners, selectMobileRecipes } from '../scripts/ai-graph/lib/mobile-recipes.mjs';
import { resolveNodeSkills } from '../scripts/ai-graph/lib/skills.mjs';
import { hashObject } from '../scripts/ai-graph/lib/io.mjs';
import { doctorProject } from '../bin/flowcairn.mjs';

const H = 'a'.repeat(64);
const manifests = {
  'react-native-expo': ['package.json', JSON.stringify({ dependencies: { 'react-native': '0.81.0', expo: '54.0.0' } })],
  flutter: ['pubspec.yaml', 'environment:\n  flutter: "3.35.0"\ndependencies:\n  flutter:\n    sdk: flutter\n'],
  'native-android': ['build.gradle.kts', 'plugins {\n id("com.android.application") version "8.7.2"\n}\nandroid { compileSdk = 35 }\n'],
  'native-ios': ['Control.xcodeproj/project.pbxproj', '{ buildSettings = { SDKROOT = iphoneos; IPHONEOS_DEPLOYMENT_TARGET = 18.0; }; }'],
};
function fixture(t, family) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-mobile-recipes-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('/usr/bin/git', ['init', '--initial-branch=main'], { cwd: root, stdio: 'ignore' });
  const write = (file, text) => { const target = path.join(root, file); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, text); };
  if (family) write(...manifests[family]);
  const stack = (scope = ['.'], manifestPaths = family ? [manifests[family][0]] : []) => discoverStackProfile(root, { scope, manifestPaths });
  return { root, write, stack };
}
function registry(platform = 'ios', format = 'flowcairn-xctest/v1') {
  const definition = { id: 'native', title: 'Existing native suite', purpose: 'Build current app and test native UI',
    command: { executable: process.execPath, argv: ['oracle.mjs'], cwd: '.' }, inputPaths: ['oracle.mjs'], outputPaths: ['out'],
    timeoutMs: 1000, maxOutputBytes: 1024,
    report: { version: 1, format, path: 'out/report.json', requiredScenarios: ['keyboard', 'button', 'error'] } };
  return { checkDefinitions: [definition], checkBindings: [{ id: 'native', definitionHash: hashObject(definition), toolchainHash: H }],
    availableCheckIds: ['native'], capabilities: ['build', 'scenario'].map((role) => ({ id: `mobile-${platform}-${role}`, checkIds: ['native'] })),
    checkProfile: { version: 1, definitions: [definition], requiredCheckIds: ['native'], environment: [] } };
}
const codes = (report) => report.recipes.flatMap(({ findings }) => findings.map(({ code }) => code)).concat(report.findings.map(({ code }) => code));
function observations(stack, report, extra = {}) {
  return report.recipes.flatMap(({ requirements }) => requirements.map(({ id, platform }) => ({ id, platform, status: 'available',
    stackHash: stack.hash, evidenceHash: H, checkId: 'native', toolchainHash: H,
    hostPlatform: 'darwin', completion: 'completed', exitCode: 0, ...extra })));
}

test('four recipes preserve distinct installed runners and contain no executable/installation choice', () => {
  assert.deepEqual(MOBILE_RECIPES.map(({ id }) => id), Object.keys(manifests));
  assert.equal(new Set(MOBILE_RECIPES.map(({ runner }) => runner)).size, 4);
  for (const recipe of MOBILE_RECIPES) {
    assert(Object.isFrozen(recipe));
    assert(Object.isFrozen(recipe.frameworks));
    assert(!Object.hasOwn(recipe, 'command'));
    assert(!Object.hasOwn(recipe, 'executable'));
  }
});

for (const family of Object.keys(manifests)) test(`scoped ${family} source selects its own recipe and preserves version declarations`, (t) => {
  const f = fixture(t, family), stack = f.stack(), selected = selectMobileRecipes(stack);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].id, family);
  assert.equal(selected[0].manifestHash, stack.packages[0].hash);
  assert.deepEqual(selected[0].frameworks, stack.packages[0].frameworks.filter(({ domain }) => domain === 'mobile').map(({ id, version }) => ({ id, version })));
  const report = evaluateMobilePreflight({ stack, ...registry(family === 'native-android' ? 'android' : 'ios'), hostPlatform: 'darwin' });
  assert.equal(report.acceptance, 'unverified');
  assert.equal(report.guidanceOnly, true);
  assert.equal(report.recipes[0].acceptance, 'unverified');
  assert(report.recipes[0].requirements.every(({ status }) => status === 'unknown'));
  assert(codes(report).includes('MOBILE_PREREQUISITE_UNKNOWN'));
});

test('cross-platform family owns native subprojects while independent scoped app remains distinct', (t) => {
  const f = fixture(t);
  f.write('package.json', JSON.stringify({ workspaces: ['apps/*'] }));
  f.write('apps/rn/package.json', JSON.stringify({ dependencies: { 'react-native': '0.81.0' } }));
  f.write('apps/rn/android/build.gradle.kts', manifests['native-android'][1]);
  f.write('apps/native/Control.xcodeproj/project.pbxproj', manifests['native-ios'][1]);
  const paths = ['apps/rn/android/build.gradle.kts', 'apps/native/Control.xcodeproj/project.pbxproj'];
  assert.deepEqual(selectMobileRecipes(f.stack(['.'], paths)).map(({ id, scope }) => [id, scope]),
    [['native-ios', 'apps/native'], ['react-native-expo', 'apps/rn']]);
  assert.deepEqual(selectMobileRecipes(f.stack(['apps/native'], paths)).map(({ id }) => id), ['native-ios']);
});

test('generic React, Flutter dev-only, unapplied Android and Swift package do not invent native app recipes', (t) => {
  const f = fixture(t);
  f.write('package.json', JSON.stringify({ dependencies: { react: '19.0.0' } }));
  f.write('pubspec.yaml', 'dev_dependencies:\n  flutter:\n    sdk: flutter\n');
  f.write('build.gradle.kts', 'plugins { id("com.android.application") version "8.7.2" apply false }');
  f.write('Package.swift', '// swift-tools-version: 6.0\nlet package = Package(name: "Control")\n');
  assert.deepEqual(selectMobileRecipes(f.stack()), []);
  assert.equal(evaluateMobilePreflight({ stack: f.stack() }).status, 'not-applicable');
});

test('scoped native child recovers its known RN ancestor without expanding discovery and rejects owner drift', (t) => {
  const f = fixture(t, 'react-native-expo');
  f.write('android/build.gradle.kts', manifests['native-android'][1]);
  f.write('android/src/Main.kt', '// existing source\n');
  const stack = f.stack(['android/src/Main.kt'], ['android/build.gradle.kts']);
  assert(!stack.packages.some(({ frameworks }) => frameworks.some(({ id }) => id === 'expo')));
  const owners = inspectMobileRecipeOwners(f.root, stack);
  assert.equal(owners[0].path, 'package.json');
  assert.deepEqual(selectMobileRecipes(stack, owners).map(({ id }) => id), ['react-native-expo']);
  const registered = registry('android'); f.write('oracle.mjs', '// existing suite\n');
  const report = inspectMobilePreflight(f.root, { stack, capabilities: registered.capabilities, checkProfile: registered.checkProfile });
  assert.equal(report.recipes[0].id, 'react-native-expo');
  const sibling = registry('ios'); sibling.capabilities.forEach((capability) => capability.scope = ['ios']);
  assert(codes(evaluateMobilePreflight({ stack, ownerPackages: owners, ...sibling })).includes('MOBILE_TARGET_UNRESOLVED'));
  f.write('package.json', JSON.stringify({ dependencies: { flutter: '1.0.0' } }));
  assert.throws(() => inspectMobileRecipeOwners(f.root, stack), { code: 'MOBILE_STACK_DRIFT' });
});

test('.NET mobile target is unsupported rather than silently rewritten to a native Android recipe', (t) => {
  const f = fixture(t);
  f.write('Control.csproj', '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net9.0-android</TargetFramework></PropertyGroup></Project>');
  const report = evaluateMobilePreflight({ stack: f.stack(['.'], ['Control.csproj']) });
  assert.equal(report.status, 'blocked');
  assert.deepEqual(report.findings, [{ code: 'MOBILE_RECIPE_UNSUPPORTED' }]);
});

test('iOS host mismatch blocks every family targeting iOS; Android does not inherit this mismatch', (t) => {
  for (const family of ['react-native-expo', 'flutter', 'native-ios']) {
    const f = fixture(t, family), report = evaluateMobilePreflight({ stack: f.stack(), ...registry(), hostPlatform: 'win32' });
    assert(codes(report).includes('MOBILE_HOST_INCOMPATIBLE'), family);
    assert.equal(report.status, 'blocked');
  }
  const f = fixture(t, 'native-android');
  assert(!codes(evaluateMobilePreflight({ stack: f.stack(), ...registry('android'), hostPlatform: 'win32' })).includes('MOBILE_HOST_INCOMPATIBLE'));
});

test('Android adapter gap remains explicit with bound tools and available fixture SDK observations', (t) => {
  const f = fixture(t, 'native-android'), stack = f.stack(), registered = registry('android');
  const baseline = evaluateMobilePreflight({ stack, ...registered, hostPlatform: 'darwin' });
  const report = evaluateMobilePreflight({ stack, ...registered, hostPlatform: 'darwin', observations: observations(stack, baseline) });
  assert.equal(report.status, 'blocked');
  assert(codes(report).includes('MOBILE_REPORT_ADAPTER_MISSING'));
  assert(!codes(report).includes('MOBILE_PREREQUISITE_MISSING'));
  assert(!codes(report).includes('MOBILE_PREREQUISITE_UNKNOWN'));
});

test('RN/Expo and Flutter retain owner native XCTest UI flow, without claiming component/native equivalence', (t) => {
  for (const family of ['react-native-expo', 'flutter']) {
    const f = fixture(t, family), stack = f.stack(), registered = registry();
    const baseline = evaluateMobilePreflight({ stack, ...registered, hostPlatform: 'darwin' });
    assert(!codes(baseline).includes('MOBILE_REPORT_ADAPTER_MISSING'));
    const ready = evaluateMobilePreflight({ stack, ...registered, hostPlatform: 'darwin', observations: observations(stack, baseline) });
    assert.equal(ready.status, 'registered-unverified');
    assert.equal(ready.acceptance, 'unverified');
    for (const format of ['jest-json', 'flowcairn-node-test/v1', 'xcresult-summary-json', 'unknown-native-format']) {
      const report = evaluateMobilePreflight({ stack, ...registry('ios', format), hostPlatform: 'darwin' });
      assert(codes(report).includes('MOBILE_REPORT_ADAPTER_MISSING'), format);
      assert.equal(report.status, 'blocked');
    }
  }
});

test('target and capability absence stay distinct from SDK absence, with scope filtering', (t) => {
  const f = fixture(t, 'flutter'), stack = f.stack();
  const unresolved = evaluateMobilePreflight({ stack });
  assert(codes(unresolved).includes('MOBILE_TARGET_UNRESOLVED'));
  const scopedAway = registry(); scopedAway.capabilities.forEach((capability) => capability.scope = ['other']);
  assert(codes(evaluateMobilePreflight({ stack: { ...stack, packages: stack.packages.map((pkg) => ({ ...pkg, scope: 'app' })) }, ...scopedAway })).includes('MOBILE_TARGET_UNRESOLVED'));
  const native = fixture(t, 'native-ios');
  const missing = evaluateMobilePreflight({ stack: native.stack() });
  assert(codes(missing).includes('MOBILE_CAPABILITY_MISSING'));
  assert(!codes(missing).includes('MOBILE_PREREQUISITE_MISSING'));
});

test('unknown or stale SDK observations never establish availability or version compatibility', (t) => {
  const f = fixture(t, 'native-ios'), stack = f.stack(), registered = registry();
  const baseline = evaluateMobilePreflight({ stack, ...registered, hostPlatform: 'darwin' });
  for (const extra of [{ stackHash: 'b'.repeat(64) }, { evidenceHash: null }, { toolchainHash: 'b'.repeat(64) },
    { checkId: 'model-picked-tool' }, { exitCode: null }, { completion: 'uncertain' }, { exitCode: 127 }, { hostPlatform: 'win32' }]) {
    const report = evaluateMobilePreflight({ stack, ...registered, hostPlatform: 'darwin', observations: observations(stack, baseline, extra) });
    assert(report.recipes[0].requirements.every(({ status }) => status === 'unknown'));
    assert.equal(report.status, 'needs-probe');
    assert.equal(report.acceptance, 'unverified');
  }
  for (const status of ['missing', 'incompatible']) {
    const facts = observations(stack, baseline); facts.find(({ id }) => id === 'ios-sdk').status = status;
    const report = evaluateMobilePreflight({ stack, ...registered, hostPlatform: 'darwin', observations: facts });
    assert(codes(report).includes(status === 'missing' ? 'MOBILE_PREREQUISITE_MISSING' : 'MOBILE_PREREQUISITE_INCOMPATIBLE'));
    assert.equal(report.status, 'blocked');
  }
});

test('production inspector reads registered bytes, never executes a discovery or accepts injected SDK claims', (t) => {
  const f = fixture(t, 'native-ios'), registered = registry();
  f.write('oracle.mjs', "import fs from 'node:fs'; fs.writeFileSync('executed-sentinel', 'unexpected');\n");
  const stack = f.stack(), projected = inspectMobilePreflight(f.root, { stack, capabilities: registered.capabilities, checkProfile: registered.checkProfile, hostPlatform: 'darwin',
    observations: [{ id: 'ios-sdk', status: 'available' }] });
  assert.equal(existsSync(path.join(f.root, 'executed-sentinel')), false);
  assert.equal(projected.status, 'needs-probe');
  assert(projected.recipes[0].roles.every(({ checks }) => checks[0].toolchainHash?.length === 64));
  assert(projected.recipes[0].requirements.every(({ status }) => status === 'unknown'));
  assert(!JSON.stringify(projected).includes(f.root));
  f.write('oracle.mjs', '// changed registered runner\n');
  const changed = inspectMobilePreflight(f.root, { stack, capabilities: registered.capabilities, checkProfile: registered.checkProfile, hostPlatform: 'darwin' });
  assert.notEqual(changed.hash, projected.hash);
  assert.notEqual(changed.recipes[0].roles[0].checks[0].toolchainHash, projected.recipes[0].roles[0].checks[0].toolchainHash);
});

test('production missing executable and identity file block with exact toolchain cause, not invented SDK diagnosis', (t) => {
  const f = fixture(t, 'native-ios'), stack = f.stack(), registered = registry(); f.write('oracle.mjs', '// existing runner\n');
  registered.checkProfile.definitions[0].command.executable = './missing-runner';
  let report = inspectMobilePreflight(f.root, { stack, capabilities: registered.capabilities, checkProfile: registered.checkProfile });
  assert.equal(report.status, 'blocked');
  assert(report.recipes[0].findings.some(({ code, cause }) => code === 'MOBILE_TOOLCHAIN_UNAVAILABLE' && cause === 'CHECK_EXECUTABLE_MISSING'));
  registered.checkProfile.definitions[0].command.executable = process.execPath;
  registered.checkProfile.definitions[0].identityFiles = ['sdk/version.json'];
  report = inspectMobilePreflight(f.root, { stack, capabilities: registered.capabilities, checkProfile: registered.checkProfile });
  assert(report.recipes[0].findings.some(({ code, cause }) => code === 'MOBILE_TOOLCHAIN_UNAVAILABLE' && cause === 'ENOENT'));
  assert(!codes(report).includes('MOBILE_PREREQUISITE_MISSING'));
  assert(!JSON.stringify(report).includes('sdk/version.json'));
});

test('unsafe registered input is refused by the existing inspector before it can be read', (t) => {
  const f = fixture(t, 'native-ios'), registered = registry(); f.write('oracle.mjs', '// existing runner\n');
  f.write('sdk.json', '{}'); chmodSync(path.join(f.root, 'sdk.json'), 0o600);
  registered.checkProfile.definitions[0].identityFiles = ['../sdk.json'];
  const report = inspectMobilePreflight(f.root, { stack: f.stack(), capabilities: registered.capabilities, checkProfile: registered.checkProfile });
  assert.equal(report.status, 'blocked');
  assert(report.recipes[0].findings.some(({ code, cause }) => code === 'MOBILE_TOOLCHAIN_UNAVAILABLE' && cause === 'CHECK_PATH_UNSAFE'));
});

test('real skill resolver projects hashed scoped mobile guidance while retaining legacy/nonmobile context', (t) => {
  const f = fixture(t, 'react-native-expo'), registered = registry();
  const input = { action: 'ai-implement', scope: ['.'], task: { checks: ['native'], goal: 'Fix native keyboard behavior', scope: ['.'] },
    developmentWorkflow: { version: 2, capabilities: registered.capabilities }, availableCheckIds: ['native'], checkDefinitions: registered.checkDefinitions };
  const selected = resolveNodeSkills(f.root, input);
  assert.equal(selected.context.mobile.recipes[0].id, 'react-native-expo');
  assert.equal(selected.context.mobile.acceptance, 'unverified');
  assert.equal(selected.context.mobile.status, 'needs-probe');
  assert(selected.ids.includes('domain-mobile'));
  assert(!selected.ids.includes('domain-frontend'));
  assert.notEqual(selected.context.hash, resolveNodeSkills(f.root, { ...input, availableCheckIds: [] }).context.hash);
  assert(!Object.hasOwn(resolveNodeSkills(f.root, { action: 'ai-implement', scope: ['.'] }).context, 'mobile'));
  f.write('package.json', JSON.stringify({ dependencies: { react: '19.0.0' } }));
  assert(!Object.hasOwn(resolveNodeSkills(f.root, input).context, 'mobile'));
});

test('doctor exposes all four static recipes without launching the registered native suite', async (t) => {
  for (const family of Object.keys(manifests)) {
    const f = fixture(t, family), registered = registry(family === 'native-android' ? 'android' : 'ios');
    f.write('oracle.mjs', "import fs from 'node:fs'; fs.writeFileSync('executed-sentinel', 'unexpected');\n");
    // Retired provider is intentionally unavailable, so this diagnostics fixture cannot invoke AI.
    f.write('.flowcairn.json', JSON.stringify({ version: 2, integrationBranch: 'main', workspaceMode: 'direct',
      contextPaths: [], manifests: [manifests[family][0]], checks: ['native'], checkProfile: registered.checkProfile,
      checkMode: 'none', outputPaths: ['out'], ai: { provider: 'openai', model: 'fixture' },
      developmentWorkflow: { version: 2, capabilities: registered.capabilities } }));
    const report = await doctorProject(f.root);
    assert.equal(report.ai.available, false);
    assert.equal(report.mobile.recipes[0].id, family);
    assert.equal(report.mobile.acceptance, 'unverified');
    assert.equal(report.mobile.status, family === 'native-android' ? 'blocked' : 'needs-probe');
    assert.equal(existsSync(path.join(f.root, 'executed-sentinel')), false);
  }
});
