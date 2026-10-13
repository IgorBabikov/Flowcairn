import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inferDevelopmentCapabilities } from '../scripts/ai-graph/lib/stack-capabilities.mjs';
import { initializeProject } from '../bin/installation.mjs';
import { resolveNodeSkills } from '../scripts/ai-graph/lib/skills.mjs';

const provider = path.resolve(import.meta.dirname, 'fixtures/verified-claude/node_modules/@anthropic-ai/claude-code/bin/claude.exe');
const options = { provider: 'claude', 'provider-path': provider, 'read-consent': true, 'test-policy': 'keep' };
function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-stack-capabilities-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, text) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), text); };
  const pkg = (file, dependencies) => write(file, JSON.stringify({ dependencies }));
  return { root, write, pkg };
}
function check(id, format, cwd = '.') {
  return { id, title: id, purpose: 'Existing owner registered scenarios',
    command: { executable: process.execPath, argv: ['never-execute.mjs'], cwd }, inputPaths: [],
    outputPaths: [`reports/${id}.json`], timeoutMs: 1000, maxOutputBytes: 1024,
    ...(format ? { report: { version: 1, format, path: `reports/${id}.json`, requiredScenarios: ['original scenario'],
      ...(format === 'flowcairn-android-node/v1' ? { android: { sourcePaths: ['app/Main.java'] } } : {}) } } : {}),
  };
}
const profile = (...definitions) => ({ version: 1, requiredCheckIds: definitions.map(({ id }) => id), definitions, environment: [] });
const infer = (root, checks, extra = {}) => inferDevelopmentCapabilities(root, { checkProfile: checks, readConsent: true, ...extra });

test('fresh owner registration infers scoped formats without running their commands or granting acceptance', (t) => {
  const f = fixture(t);
  const checks = profile(check('browser', 'playwright-json'), check('ios', 'flowcairn-xctest/v1'), check('android', 'flowcairn-android-node/v1'));
  const original = structuredClone(checks);
  assert.deepEqual(infer(f.root, checks).map(({ id }) => id), ['browser-scenario', 'mobile-android-build', 'mobile-android-scenario', 'mobile-ios-build', 'mobile-ios-scenario']);
  assert.deepEqual(checks, original);
  assert.equal(existsSync(path.join(f.root, 'reports')), false);
});

test('polyglot check cwd selects its own domain, while root generic tests cannot guess a domain', (t) => {
  const f = fixture(t);
  f.pkg('package.json', {});
  f.pkg('web/package.json', { react: '19.2.7' });
  f.pkg('api/package.json', { hono: '4.13.13' });
  f.write('phone/pubspec.yaml', 'dependencies:\n  flutter:\n    sdk: flutter\n');
  const manifests = ['web/package.json', 'api/package.json', 'phone/pubspec.yaml'];
  const checks = profile(check('web', 'jest-json', 'web'), check('api', 'flowcairn-node-test/v1', 'api'), check('phone', 'jest-json', 'phone'), check('all', 'jest-json'));
  const capabilities = infer(f.root, checks, { manifestPaths: manifests });
  assert.deepEqual(capabilities, [
    { id: 'api-integration', checkIds: ['api'], scope: ['api'] },
    { id: 'component-test', checkIds: ['web'], scope: ['web'] },
    { id: 'mobile-component-test', checkIds: ['phone'], scope: ['phone'] },
  ]);
  const routing = resolveNodeSkills(f.root, { action: 'ai-implement', scope: ['api/new.js'], manifestPaths: manifests,
    developmentWorkflow: { version: 2, capabilities }, task: { goal: 'Fix API', checks: checks.requiredCheckIds },
    availableCheckIds: checks.requiredCheckIds, checkDefinitions: checks.definitions });
  assert.ok(routing.ids.includes('domain-backend'));
  assert.ok(!routing.ids.includes('domain-frontend'));
  assert.equal(routing.context.routing.capabilities.find(({ id }) => id === 'api-integration').acceptance, 'unverified');
  assert.equal(routing.context.routing.capabilities.find(({ id }) => id === 'component-test').status, 'unavailable');
});

test('unregistered checks, opaque reports, missing tools and unknown stack never invent recipes', (t) => {
  const f = fixture(t);
  f.pkg('package.json', {});
  const checks = profile(check('generic', 'jest-json'), check('opaque'), check('summary', 'xcresult-summary-json'), check('extra', 'playwright-json'));
  checks.requiredCheckIds = ['generic', 'opaque', 'summary'];
  assert.deepEqual(infer(f.root, checks), []);
  f.pkg('package.json', { 'react-native': '0.81.0', react: '19.1.0' });
  assert.deepEqual(infer(f.root, profile(check('mobile', 'jest-json'))), [{ id: 'mobile-component-test', checkIds: ['mobile'], scope: ['.'] }]);
  assert.ok(!infer(f.root, profile(check('mobile', 'jest-json'))).some(({ id }) => /build|scenario/.test(id)));
});

test('without read consent generic report inference does not read even malformed manifests', (t) => {
  const f = fixture(t);
  f.write('package.json', '{malformed: must not be read');
  assert.deepEqual(infer(f.root, profile(check('generic', 'jest-json')), { readConsent: false }), []);
});

test('fresh init imported check profile discovers actual native/polyglot manifests and is repeatable', (t) => {
  const f = fixture(t);
  f.pkg('package.json', { react: '19.2.7' });
  f.write('native/Phone.xcodeproj/project.pbxproj', '{ buildSettings = { SDKROOT = iphoneos; IPHONEOS_DEPLOYMENT_TARGET = 17.2; }; }');
  f.write('api/pyproject.toml', '[project]\ndependencies = ["fastapi==0.115.0"]\n');
  const checks = profile(check('browser', 'playwright-json'), check('ios', 'flowcairn-xctest/v1'));
  f.write('checks.json', JSON.stringify(checks));
  const init = initializeProject(f.root, { ...options, 'check-profile': 'checks.json' });
  assert.ok(init.profile.manifests.includes('native/Phone.xcodeproj/project.pbxproj'));
  assert.ok(init.profile.manifests.includes('api/pyproject.toml'));
  assert.ok(init.profile.manifests.includes('package.json'));
  assert.deepEqual(init.profile.developmentWorkflow.capabilities.map(({ id }) => id), ['browser-scenario', 'mobile-ios-build', 'mobile-ios-scenario']);
  assert.deepEqual(init.profile.checkProfile, checks);
  const saved = readFileSync(path.join(f.root, '.flowcairn.json'));
  assert.equal(initializeProject(f.root, options).created, false);
  assert.ok(readFileSync(path.join(f.root, '.flowcairn.json')).equals(saved));
});

test('explicit manifest list retains saved bytes and no consent prevents generic inference', (t) => {
  for (const mode of ['explicit', 'no-consent']) {
    const f = fixture(t);
    f.write('api/pyproject.toml', '[project]\ndependencies = ["flask==3.1.0"]\n');
    f.write('checks.json', JSON.stringify(profile(check('api', 'flowcairn-node-test/v1'))));
    const init = initializeProject(f.root, { ...options, 'check-profile': 'checks.json',
      ...(mode === 'explicit' ? { manifests: 'api/pyproject.toml' } : { 'read-consent': false }) });
    assert.deepEqual(init.profile.manifests, mode === 'explicit' ? ['api/pyproject.toml'] : []);
    assert.deepEqual(init.profile.developmentWorkflow.capabilities ?? [], mode === 'explicit' ? [{ id: 'api-integration', checkIds: ['api'], scope: ['.'] }] : []);
  }
});
