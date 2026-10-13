import test from 'node:test';
import assert from 'node:assert/strict';
import { parseXCTestVerificationReport, XCTEST_SCHEMA_HASHES } from '../scripts/ai-graph/lib/xctest-verification-report.mjs';
import { sha256 } from '../scripts/ai-graph/lib/io.mjs';

// Redacted projection of the saved native control summary and compact tests export.
// Tree shape/results/three case IDs follow the real run; device identity/name, title and durations are redacted.
const IDS = ['NativeControlUITests/testBlankInputButtonShowsError()',
  'NativeControlUITests/testInvalidCharactersShowErrorWithoutResult()',
  'NativeControlUITests/testKeyboardReturnAndButtonShowsResult()'];
function fixture() {
  const device = { architecture: 'arm64', deviceId: 'fixture-device-id', deviceName: 'Fixture Device',
    modelName: 'Fixture Model', osBuildNumber: 'fixture-build', osVersion: '26.5', platform: 'iOS Simulator' };
  const configuration = { configurationId: '1', configurationName: 'Test Scheme Action' };
  const leaf = (id) => ({ duration: '1 s', durationInSeconds: 1, name: id.split('/')[1], nodeIdentifier: id,
    nodeIdentifierURL: `test://com.apple.xcode/Fixture/NativeControlUITests/${id.replace('()', '')}`, nodeType: 'Test Case', result: 'Passed' });
  return { format: 'flowcairn-xctest/v1',
    summary: { title: 'Fixture', environmentDescription: 'Fixture environment', expectedFailures: 0, failedTests: 0,
      passedTests: 3, result: 'Passed', skippedTests: 0, totalTestCount: 3, startTime: 1, finishTime: 4,
      statistics: [], topInsights: [], testFailures: [], devicesAndConfigurations: [{ device, testPlanConfiguration: configuration,
        passedTests: 3, failedTests: 0, skippedTests: 0, expectedFailures: 0 }] },
    tests: { devices: [device], testPlanConfigurations: [configuration], testNodes: [{ name: 'Fixture', nodeType: 'Test Plan', result: 'Passed',
      children: [{ name: 'NativeControlUITests', nodeType: 'UI test bundle', result: 'Passed',
        children: [{ name: 'NativeControlUITests', nodeType: 'Test Suite', result: 'Passed', children: IDS.map(leaf) }] }] }] } };
}
const leaves = (value) => value.tests.testNodes[0].children[0].children[0].children;
const hasReason = (report, code) => report.reasons.some((reason) => reason.code === code);

test('redacted real 3/3 export confirms enumerated exact cases with unknown bundle identity', () => {
  const report = parseXCTestVerificationReport(fixture(), { requiredScenarios: IDS });
  assert.equal(report.version, 1); assert.equal(report.format, 'flowcairn-xctest/v1');
  assert.equal(report.status, 'passed'); assert.equal(report.countsConfirmed, true);
  assert.deepEqual(report.counts, { total: 3, completed: 3, passed: 3, failed: 0, skipped: 0 });
  assert.deepEqual(report.scenarios.map((scenario) => scenario.id), IDS);
  assert.ok(report.scenarios.every((scenario) => scenario.status === 'passed'));
  assert.deepEqual(report.artifact, { status: 'unknown', identity: null, kind: null });
  assert.deepEqual(report.schema, { status: 'unknown', version: null, summaryHash: null, testsHash: null });
  assert.deepEqual(report.reasons, []); assert.equal(report.factsHash.length, 64);
  assert.ok(report.limitations.includes('artifact-identity-unknown'));
});

test('only explicit matching schema snapshot hashes and valid artifact identity are reported', () => {
  const value = fixture(); value.schemaHashes = { ...XCTEST_SCHEMA_HASHES }; value.artifact = { kind: 'xcresult-bundle', hash: 'a'.repeat(64) };
  const report = parseXCTestVerificationReport(value, { requiredScenarios: IDS });
  assert.equal(report.status, 'passed'); assert.deepEqual(report.schema, { status: 'declared', version: null,
    summaryHash: XCTEST_SCHEMA_HASHES.summary, testsHash: XCTEST_SCHEMA_HASHES.tests });
  assert.deepEqual(report.artifact, { status: 'reported', identity: 'a'.repeat(64), kind: 'xcresult-bundle' });
  for (const artifact of [{ kind: 'xcresult-bundle', hash: '/absolute/private' }, { kind: 'other', hash: 'a'.repeat(64) }, null]) {
    value.artifact = artifact;
    assert.equal(parseXCTestVerificationReport(value).status, 'unverified');
  }
});

test('environment uses direct reported fields with hashed identities and no names', () => {
  const report = parseXCTestVerificationReport(fixture());
  assert.equal(report.environment.status, 'reported'); assert.equal(report.environment.identity.length, 64);
  assert.deepEqual(report.environment.devices, [{ identity: sha256('fixture-device-id'), platform: 'iOS Simulator', architecture: 'arm64', osVersion: '26.5' }]);
  const raw = JSON.stringify(report);
  for (const privateField of ['fixture-device-id', 'Fixture Device', 'Fixture Model', 'Fixture environment', 'Test Scheme Action'])
    assert.equal(raw.includes(privateField), false);
  assert.ok(report.limitations.includes('case-environment-binding-and-current-source-not-proven'));
});

test('missing environment metadata stays explicitly unknown without invented target or bundle facts', () => {
  const value = fixture(); value.tests.devices = []; value.tests.testPlanConfigurations = [];
  const report = parseXCTestVerificationReport(value);
  assert.equal(report.status, 'passed'); assert.equal(report.countsConfirmed, true);
  assert.deepEqual(report.environment, { status: 'unknown', identity: null, devices: [], configurations: [] });
  assert.equal(report.artifact.status, 'unknown'); assert.equal(report.artifact.identity, null);
});

test('required scenarios match exact nodeIdentifier, never title, URL, prefix or hash', () => {
  for (const selector of ['testBlankInputButtonShowsError()', 'NativeControlUITests/testBlankInputButtonShowsError',
    'NativeControlUITests/testBlankInput', sha256(IDS[0]), 'NativeControlUITests']) {
    const report = parseXCTestVerificationReport(fixture(), { requiredScenarios: [selector] });
    assert.equal(report.status, 'unverified', selector); assert.equal(report.countsConfirmed, true);
    assert.ok(hasReason(report, 'REPORT_REQUIRED_SCENARIO_MISSING'));
  }
  const url = leaves(fixture())[0].nodeIdentifierURL;
  assert.equal(parseXCTestVerificationReport(fixture(), { requiredScenarios: [url] }).status, 'unverified');
});

test('missing case cannot be replaced by summary passed counters', () => {
  const value = fixture(); leaves(value).pop();
  const report = parseXCTestVerificationReport(value, { requiredScenarios: IDS });
  assert.equal(report.status, 'unverified'); assert.equal(report.countsConfirmed, false);
  assert.deepEqual(report.counts, { total: 2, completed: 2, passed: 2, failed: 0, skipped: 0 });
  assert.ok(hasReason(report, 'REPORT_COUNTER_MISMATCH')); assert.ok(hasReason(report, 'REPORT_REQUIRED_SCENARIO_MISSING'));
});

for (const key of ['totalTestCount', 'passedTests', 'failedTests', 'skippedTests', 'expectedFailures']) {
  test(`independent ${key} mismatch never confirms counters`, () => {
    const value = fixture(); value.summary[key]++;
    const report = parseXCTestVerificationReport(value, { requiredScenarios: IDS });
    assert.notEqual(report.status, 'passed'); assert.equal(report.countsConfirmed, false);
    assert.ok(hasReason(report, 'REPORT_COUNTER_MISMATCH'));
  });
}

test('failed Test Case produces failed status only from explicit result, without parsing failure text', () => {
  const value = fixture(); leaves(value)[1].result = 'Failed';
  value.summary.passedTests = 2; value.summary.failedTests = 1; value.summary.result = 'Failed';
  const report = parseXCTestVerificationReport(value, { requiredScenarios: IDS });
  assert.equal(report.status, 'failed'); assert.equal(report.countsConfirmed, true);
  assert.deepEqual(report.counts, { total: 3, completed: 3, passed: 2, failed: 1, skipped: 0 });
  assert.equal(report.scenarios[1].status, 'failed'); assert.ok(hasReason(report, 'REPORT_CASE_FAILED'));
});

test('a skipped case is not a passed mandatory scenario, even if aggregate result is Passed', () => {
  const value = fixture(); leaves(value)[1].result = 'Skipped'; value.summary.passedTests = 2; value.summary.skippedTests = 1;
  const report = parseXCTestVerificationReport(value, { requiredScenarios: IDS });
  assert.equal(report.status, 'unverified'); assert.equal(report.countsConfirmed, true);
  assert.deepEqual(report.counts, { total: 3, completed: 2, passed: 2, failed: 0, skipped: 1 });
  assert.ok(hasReason(report, 'REPORT_REQUIRED_SCENARIO_NOT_PASSED'));
});

test('expected failure remains non-passing rather than an accepted test', () => {
  const value = fixture(); leaves(value)[1].result = 'Expected Failure';
  value.summary.passedTests = 2; value.summary.expectedFailures = 1; value.summary.result = 'Expected Failure';
  const report = parseXCTestVerificationReport(value, { requiredScenarios: IDS });
  assert.equal(report.status, 'unverified'); assert.equal(report.countsConfirmed, true);
  assert.equal(report.counts.completed, 2); assert.equal(report.counts.skipped, 1);
  assert.ok(hasReason(report, 'REPORT_EXPECTED_FAILURE_IS_NOT_PASS'));
});

test('unknown or missing case result never inherits a parent Passed', () => {
  for (const result of ['unknown', undefined]) {
    const value = fixture(); leaves(value)[0].result = result;
    const report = parseXCTestVerificationReport(value, { requiredScenarios: IDS });
    assert.equal(report.status, 'unverified'); assert.equal(report.countsConfirmed, false);
    assert.equal(report.scenarios[0].status, 'unverified'); assert.ok(hasReason(report, 'REPORT_CASE_RESULT_UNKNOWN'));
  }
});

test('duplicate IDs are ambiguous even when counters agree and names differ', () => {
  const value = fixture(); const duplicate = structuredClone(leaves(value)[0]); duplicate.name = 'Different display name';
  leaves(value).push(duplicate); value.summary.totalTestCount = 4; value.summary.passedTests = 4;
  const report = parseXCTestVerificationReport(value, { requiredScenarios: [IDS[0]] });
  assert.equal(report.status, 'unverified'); assert.equal(report.countsConfirmed, false);
  assert.ok(hasReason(report, 'REPORT_DUPLICATE_SCENARIO_ID')); assert.ok(hasReason(report, 'REPORT_REQUIRED_SCENARIO_AMBIGUOUS'));
});

test('suite and aggregate identifiers cannot inflate test counts or satisfy required test IDs', () => {
  const value = fixture(); const suite = value.tests.testNodes[0].children[0].children[0]; suite.nodeIdentifier = 'AggregateTests/all()';
  suite.name = '10000 tests passed';
  const valid = parseXCTestVerificationReport(value);
  assert.equal(valid.status, 'passed'); assert.equal(valid.scenarios.length, 3); assert.equal(valid.counts.total, 3);
  const required = parseXCTestVerificationReport(value, { requiredScenarios: ['AggregateTests/all()'] });
  assert.equal(required.status, 'unverified'); assert.ok(hasReason(required, 'REPORT_REQUIRED_SCENARIO_MISSING'));
  value.summary.totalTestCount = 4; value.summary.passedTests = 4;
  assert.equal(parseXCTestVerificationReport(value).countsConfirmed, false);
});

test('zero Test Cases cannot become passing evidence from empty successful aggregates', () => {
  const value = fixture(); leaves(value).length = 0; value.summary.totalTestCount = 0; value.summary.passedTests = 0;
  const report = parseXCTestVerificationReport(value);
  assert.equal(report.status, 'unverified'); assert.equal(report.countsConfirmed, true);
  assert.deepEqual(report.counts, { total: 0, completed: 0, passed: 0, failed: 0, skipped: 0 });
  assert.ok(hasReason(report, 'REPORT_ZERO_COMPLETED_TESTS'));
});

test('failed summary, failed aggregate and failed Test Case Run prevent hidden successful acceptance', () => {
  const summary = fixture(); summary.summary.result = 'Failed';
  assert.equal(parseXCTestVerificationReport(summary).status, 'failed');
  const aggregate = fixture(); aggregate.tests.testNodes[0].result = 'Failed';
  assert.equal(parseXCTestVerificationReport(aggregate).status, 'failed');
  const run = fixture(); leaves(run)[0].children = [{ nodeType: 'Test Case Run', name: 'Run 1', result: 'Failed' }];
  const report = parseXCTestVerificationReport(run);
  assert.equal(report.status, 'failed'); assert.equal(report.scenarios.length, 3);
  assert.equal(report.counts.failed, 0); assert.ok(hasReason(report, 'REPORT_NON_CASE_FAILURE'));
});

test('unknown format/schema version/node type/result or legacy shape is rejected', () => {
  const variants = [
    value => { value.format = 'flowcairn-xctest/v2'; },
    value => { value.schemaVersion = '0.2.0'; },
    value => { value.schemaHashes = { summary: 'a'.repeat(64), tests: 'b'.repeat(64) }; },
    value => { value.tests.testNodes[0].nodeType = 'Aggregate'; },
    value => { leaves(value)[0].result = 'Not Executed'; },
    value => { delete value.tests.testNodes; value.tests._type = { _name: 'LegacyResult' }; },
    value => { leaves(value)[0].nodeIdentifier = '/absolute/private/secret'; },
    value => { leaves(value)[0].children = {}; },
  ];
  for (const change of variants) {
    const value = fixture(); change(value); const report = parseXCTestVerificationReport(value);
    assert.equal(report.status, 'unverified'); assert.equal(report.countsConfirmed, false);
  }
});

test('diagnostics, private metadata and unsupported environment values do not escape normalization', () => {
  const value = fixture(); value.summary.title = 'SECRET_TITLE'; value.summary.environmentDescription = '/absolute/private/secret';
  leaves(value)[0].name = 'SECRET_NAME'; leaves(value)[0].details = 'SECRET_DETAILS';
  value.tests.devices[0].deviceName = 'SECRET_DEVICE'; value.tests.devices[0].modelName = 'SECRET_MODEL';
  value.tests.devices[0].platform = 'SECRET_PLATFORM'; value.tests.devices[0].osVersion = 'SECRET_VERSION';
  const report = parseXCTestVerificationReport(value);
  assert.equal(report.status, 'passed'); assert.equal(report.environment.status, 'unknown');
  assert.equal(report.environment.identity, null); assert.equal(JSON.stringify(report).includes('SECRET_'), false);
  assert.equal(JSON.stringify(report).includes('/absolute/private'), false);
});

test('invalid options, non-JSON accessors and cyclic inputs fail without effects', () => {
  for (const requiredScenarios of [[''], [IDS[0], IDS[0]], 'test', [1], null, undefined])
    assert.equal(parseXCTestVerificationReport(fixture(), { requiredScenarios }).status, 'unverified');
  assert.equal(parseXCTestVerificationReport(fixture(), { arbitrary: true }).status, 'unverified');
  let invoked = false; const getter = fixture(); Object.defineProperty(getter, 'summary', { get: () => { invoked = true; return {}; } });
  assert.equal(parseXCTestVerificationReport(getter).status, 'unverified'); assert.equal(invoked, false);
  const cycle = fixture(); cycle.tests.testNodes[0].children.push(cycle.tests.testNodes[0]);
  assert.equal(parseXCTestVerificationReport(cycle).status, 'unverified');
});
