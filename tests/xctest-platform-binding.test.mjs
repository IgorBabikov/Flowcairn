import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashObject, sha256 } from '../scripts/ai-graph/lib/io.mjs';
import { captureCheckVerification, finishCheckVerification, boundCheckVerification } from '../scripts/ai-graph/lib/check-verification.mjs';
import { XCTEST_SCHEMA_HASHES } from '../scripts/ai-graph/lib/xctest-verification-report.mjs';

const H = 'a'.repeat(64);
const IDS = ['NativeControlUITests/testBlankInputButtonShowsError()',
  'NativeControlUITests/testInvalidCharactersShowErrorWithoutResult()',
  'NativeControlUITests/testKeyboardReturnAndButtonShowsResult()'];

// Redacted native-control export shape, constructed for host-binding tests only.
// A passing synthetic envelope is not a native run, SDK/device or feature proof.
function envelope(platforms) {
  const devices = platforms.map((platform, index) => ({ architecture: 'arm64', deviceId: `fixture-device-${index}`,
    deviceName: 'Fixture Device', modelName: 'Fixture Model', osVersion: '26.5', platform }));
  return { format: 'flowcairn-xctest/v1', schemaHashes: { ...XCTEST_SCHEMA_HASHES }, artifact: { kind: 'xcresult-bundle', hash: H },
    summary: { title: 'Fixture', environmentDescription: 'Fixture', expectedFailures: 0, failedTests: 0, passedTests: 3,
      result: 'Passed', skippedTests: 0, totalTestCount: 3, statistics: [], topInsights: [], testFailures: [], devicesAndConfigurations: [] },
    tests: { devices, testPlanConfigurations: [{ configurationId: 'fixture-config', configurationName: 'Fixture' }],
      testNodes: [{ name: 'Fixture', nodeType: 'Test Plan', result: 'Passed', children: IDS.map(id => ({
        name: id.split('/')[1], nodeIdentifier: id, nodeType: 'Test Case', result: 'Passed' })) }] } };
}

function fixture(t, { workflowPolicy = 'developer-v2', skills = ['domain-mobile'],
  materialRegistration = workflowPolicy === 'developer-v2' } = {}) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-xctest-platform-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'reports'));
  const definition = { id: 'native', outputPaths: ['reports'], report: { version: 1, format: 'flowcairn-xctest/v1',
    path: 'reports/native.json', requiredScenarios: IDS,
    ...(materialRegistration ? { xctest: { artifactRoot: 'reports/runs', resultName: 'tests.xcresult',
      applicationRelativePath: 'DerivedData/Build/Products/Debug-iphonesimulator/NativeControl.app', algorithm: 'sha256-tree-v1' } } : {}) } };
  const resultPath = 'reports/runs/current/tests.xcresult';
  const appPath = 'reports/runs/current/DerivedData/Build/Products/Debug-iphonesimulator/NativeControl.app';
  if (materialRegistration) {
    mkdirSync(path.join(root, resultPath), { recursive: true });
    mkdirSync(path.join(root, appPath), { recursive: true });
    writeFileSync(path.join(root, resultPath, 'Info.plist'), 'result');
    writeFileSync(path.join(root, appPath, 'Info.plist'), 'application');
  }
  const binding = { id: 'native', definitionHash: hashObject(definition), toolchainHash: H };
  const node = { id: 'check-native-final', action: { id: 'check-native' } };
  const work = { id: 'work-native', action: { id: 'ai-implement' }, skills };
  const checks = { definitions: [definition], bindings: [binding] };
  const plan = { nodes: [work, node], checks, checkRegistryHash: hashObject(checks), runtimeHash: H,
    ...(workflowPolicy ? { workflowPolicy } : {}), taskContract: { requirements: [{ id: 'req-001', mandatory: true,
      workIds: [work.id], verification: { method: 'check', checkIds: ['check-native'] } }] } };
  const previous = captureCheckVerification(root, plan, node);
  assert.equal(previous, null);
  const finish = (platforms, change = () => {}) => {
    const value = envelope(platforms);
    if (materialRegistration) {
      value.artifact = { kind: 'xcresult-bundle', path: resultPath,
        hash: hashObject({ 'Info.plist': sha256('result') }), algorithm: 'sha256-tree-v1' };
      value.applicationArtifact = { kind: 'ios-app-bundle', path: appPath,
        hash: hashObject({ 'Info.plist': sha256('application') }), algorithm: 'sha256-tree-v1' };
    }
    change(value);
    writeFileSync(path.join(root, definition.report.path), JSON.stringify(value));
    const result = finishCheckVerification(root, plan, node, previous, H, { hash: H });
    assert.equal(boundCheckVerification(plan, node, { inputHash: H, verification: result }), true);
    assert.equal(result.countsConfirmed, true);
    assert.deepEqual(result.counts, { total: 3, completed: 3, passed: 3, failed: 0, skipped: 0 });
    assert.equal(result.scenarioIds.length, 3);
    return result;
  };
  return { finish, root, definition, resultPath, appPath };
}

for (const platform of ['iOS', 'iOS Simulator']) test(`developer-v2 mobile binding accepts reported ${platform} without changing case counts`, t => {
  const result = fixture(t).finish([platform]);
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.reasonCodes, []);
});

for (const platform of ['macOS', 'tvOS', 'watchOS Simulator', 'visionOS']) test(`developer-v2 mobile binding refuses ${platform} report as iOS verification`, t => {
  const result = fixture(t).finish([platform]);
  assert.equal(result.status, 'unverified');
  assert(result.reasonCodes.includes('NATIVE_PLATFORM_MISMATCH'));
});

test('one non-iOS device in an otherwise valid device list leaves native iOS binding unverified', t => {
  const result = fixture(t).finish(['iOS Simulator', 'macOS']);
  assert.equal(result.status, 'unverified');
  assert(result.reasonCodes.includes('NATIVE_PLATFORM_MISMATCH'));
});

test('unknown reported environment cannot inherit iOS from work domain or passed counters', t => {
  const result = fixture(t).finish([]);
  assert.equal(result.status, 'unverified');
  assert(result.reasonCodes.includes('NATIVE_PLATFORM_MISMATCH'));
  assert(result.reasonCodes.includes('NATIVE_IDENTITY_UNVERIFIED'));
});

test('markerless historical XCTest retains general Apple platform normalization', t => {
  for (const platform of ['macOS', 'tvOS']) {
    const result = fixture(t, { workflowPolicy: null }).finish([platform]);
    assert.equal(result.status, 'passed');
    assert(!result.reasonCodes.includes('NATIVE_PLATFORM_MISMATCH'));
  }
});

test('developer-v2 nonmobile Apple work does not acquire a new iOS platform obligation', t => {
  const result = fixture(t, { skills: ['domain-engineering'] }).finish(['macOS']);
  assert.equal(result.status, 'passed');
  assert(!result.reasonCodes.includes('NATIVE_PLATFORM_MISMATCH'));
});

test('developer-v1 historical mobile report retains its prior platform behavior', t => {
  const result = fixture(t, { workflowPolicy: 'developer-v1' }).finish(['tvOS']);
  assert.equal(result.status, 'passed');
  assert(!result.reasonCodes.includes('NATIVE_PLATFORM_MISMATCH'));
});

test('developer-v2 mobile XCTest without owner-pinned app and result registration is unverified', t => {
  const result = fixture(t, { materialRegistration: false }).finish(['iOS Simulator']);
  assert.equal(result.status, 'unverified');
  assert(result.reasonCodes.includes('REPORT_XCTEST_MATERIAL_REGISTRATION_MISSING'));
});

test('opted-in native report must bind both owner paths, tree hashes and the explicit algorithm', t => {
  for (const change of [
    value => { value.artifact.hash = H; },
    value => { value.applicationArtifact.hash = H; },
    value => { value.applicationArtifact.path = 'reports/runs/other/DerivedData/Build/Products/Debug-iphonesimulator/NativeControl.app'; },
    value => { value.applicationArtifact.algorithm = 'unknown'; },
    value => { delete value.applicationArtifact; },
  ]) {
    const result = fixture(t).finish(['iOS Simulator'], change);
    assert.equal(result.status, 'unverified');
    assert.equal(Object.hasOwn(result, 'artifactPath'), false);
    assert.equal(Object.hasOwn(result, 'applicationArtifactPath'), false);
  }
});
