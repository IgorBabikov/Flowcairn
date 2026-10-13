import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { inspectMobileWorkPreflight } from '../scripts/ai-graph/lib/mobile-work-preflight.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-mobile-work-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('/usr/bin/git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  mkdirSync(path.join(root, 'App.xcodeproj'));
  mkdirSync(path.join(root, 'App'));
  writeFileSync(path.join(root, 'App.xcodeproj/project.pbxproj'), '{ buildSettings = { SDKROOT = iphoneos; IPHONEOS_DEPLOYMENT_TARGET = 18.0; }; }');
  writeFileSync(path.join(root, 'App/App.swift'), '// app source\n');
  writeFileSync(path.join(root, 'oracle.mjs'), "throw new Error('Preflight must never execute this file');\n");
  const definition = { id: 'native', title: 'Native checks', purpose: 'Existing native build and scenario',
    command: { executable: process.execPath, argv: ['oracle.mjs'], cwd: '.' }, inputPaths: ['oracle.mjs'], outputPaths: ['out'],
    timeoutMs: 1000, maxOutputBytes: 1024, report: { version: 1, format: 'flowcairn-xctest/v1', path: 'out/report.json',
      xctest: { artifactRoot: 'out', resultName: 'tests.xcresult',
        applicationRelativePath: 'DerivedData/App.app', algorithm: 'sha256-tree-v1' }, requiredScenarios: ['keyboard'] } };
  const profile = { version: 2, manifests: ['App.xcodeproj/project.pbxproj'],
    developmentWorkflow: { version: 2, capabilities: ['build', 'scenario'].map(role => ({ id: `mobile-ios-${role}`, checkIds: ['native'], scope: ['App'] })) },
    checkProfile: { version: 1, requiredCheckIds: ['native'], definitions: [definition], environment: [] } };
  const node = { id: 'work-validation', action: { id: 'ai-implement' }, resources: { writes: ['App/App.swift'] } };
  const plan = { workflowPolicy: 'developer-v2', taskContract: { requirements: [
    { mandatory: true, workIds: [node.id], verification: { checkIds: ['check-native'] } }] } };
  const task = { scope: ['App/App.swift'] };
  return { input: { root, profile, node, plan, task }, definition };
}
test('registered native work statically binds its tools while live SDK facts remain unknown', t => {
  const { input } = fixture(t);
  const result = inspectMobileWorkPreflight(input);
  assert.equal(result.status, 'needs-probe');
  assert.equal(result.acceptance, 'unverified');
  assert(result.recipes[0].roles.every(role => role.checks[0].toolchainHash));
  assert(result.recipes[0].requirements.every(requirement => requirement.status === 'unknown'));
});
test('missing native executable and wrong report stop before any source proposal', t => {
  const { input, definition } = fixture(t);
  definition.command.executable = './missing-native-runner';
  assert.throws(() => inspectMobileWorkPreflight(input), { code: 'CHECK_EXECUTABLE_MISSING' });
  definition.command.executable = process.execPath;
  definition.report.format = 'jest-json';
  delete definition.report.xctest;
  assert.throws(() => inspectMobileWorkPreflight(input), { code: 'VERIFIER_MISSING' });
});
test('developer-v2 native iOS missing material registration stops before a source proposal; v1 stays historical', t => {
  const { input, definition } = fixture(t);
  delete definition.report.xctest;
  assert.throws(() => inspectMobileWorkPreflight(input), { code: 'VERIFIER_MISSING' });
  input.plan.workflowPolicy = 'developer-v1';
  assert.equal(inspectMobileWorkPreflight(input).status, 'needs-probe');
});
test('ordinary component/source review and legacy actions do not acquire native requirements', t => {
  const { input, definition } = fixture(t);
  input.profile.developmentWorkflow.capabilities = [];
  definition.report.format = 'jest-json';
  delete definition.report.xctest;
  assert.equal(inspectMobileWorkPreflight(input), null);
  input.node.action.id = 'ai-review';
  assert.equal(inspectMobileWorkPreflight(input), null);
  input.node.action.id = 'ai-implement';
  delete input.profile.developmentWorkflow;
  assert.equal(inspectMobileWorkPreflight(input), null);
});

test('explicit native requirement keeps its platform and unknowns without a recognized mobile manifest', t => {
  const { input, definition } = fixture(t);
  input.profile.manifests = [];
  rmSync(path.join(input.root, 'App.xcodeproj'), { recursive: true });
  writeFileSync(path.join(input.root, 'package.json'), JSON.stringify({ name: 'custom-native-build' }));
  assert.throws(() => inspectMobileWorkPreflight({ ...input, hostPlatform: 'win32' }), { code: 'SDK_MISSING' });
  const result = inspectMobileWorkPreflight(input);
  assert.equal(result.status, 'needs-probe');
  assert.equal(result.acceptance, 'unverified');
  assert(result.findings.some(finding => finding.code === 'MOBILE_FRAMEWORK_UNKNOWN'));
  definition.report.format = 'jest-json';
  delete definition.report.xctest;
  assert.throws(() => inspectMobileWorkPreflight(input), { code: 'VERIFIER_MISSING' });
  definition.report.format = 'flowcairn-xctest/v1';
  definition.report.xctest = { artifactRoot: 'out', resultName: 'tests.xcresult',
    applicationRelativePath: 'DerivedData/App.app', algorithm: 'sha256-tree-v1' };
  definition.command.executable = './missing-native-runner';
  assert.throws(() => inspectMobileWorkPreflight(input), { code: 'CHECK_EXECUTABLE_MISSING' });
});

test('a neighboring native capability cannot add a device obligation to shared component checks', t => {
  const { input, definition } = fixture(t);
  definition.report.format = 'jest-json';
  delete definition.report.xctest;
  input.profile.developmentWorkflow.capabilities.forEach(capability => { capability.scope = ['Other']; });
  assert.equal(inspectMobileWorkPreflight(input), null);
});
