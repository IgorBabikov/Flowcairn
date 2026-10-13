import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVerificationReport } from '../scripts/ai-graph/lib/verification-report.mjs';

const scenarioTitle = '[chromium] export.spec.ts > export > returns every note';
const jestTitle = 'export returns every note';
const reason = (report, code) => report.reasons.some((item) => item.code === code);

function pwFixture() {
  return { errors: [], stats: { expected: 1, unexpected: 0, flaky: 0, skipped: 0 },
    suites: [{ title: 'export.spec.ts', file: 'export.spec.ts', specs: [], suites: [
      { title: 'export', file: 'export.spec.ts', specs: [{ id: 'export-every-note', file: 'export.spec.ts',
        title: 'returns every note', ok: true, tests: [{ projectId: 'chromium', projectName: 'chromium',
          expectedStatus: 'passed', status: 'expected', results: [{ status: 'passed', retry: 0, errors: [] }] }] }] },
    ] }] };
}
const pwSpec = (value) => value.suites[0].suites[0].specs[0];
const pwCase = (value) => pwSpec(value).tests[0];

function jestFixture() {
  return { success: true, wasInterrupted: false, numRuntimeErrorTestSuites: 0,
    numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
    numTotalTestSuites: 1, numPassedTestSuites: 1, numFailedTestSuites: 0, numPendingTestSuites: 0,
    testResults: [{ name: 'tests/export.test.mjs', status: 'passed', message: '', assertionResults: [{
      title: 'returns every note', ancestorTitles: ['export'], fullName: jestTitle, status: 'passed',
      invocations: 1, retryReasons: [], failing: false, failureMessages: [],
    }] }] };
}
const jestCase = (value) => value.testResults[0].assertionResults[0];

test('Playwright JSON reconciles concrete completed tests and exact project/file/suite full titles', () => {
  const value = pwFixture();
  const original = structuredClone(value);
  const parsed = parseVerificationReport('playwright-json', value, { requiredScenarios: [scenarioTitle] });
  assert.equal(parsed.status, 'passed');
  assert.equal(parsed.countsConfirmed, true);
  assert.deepEqual(parsed.counts, { total: 1, completed: 1, passed: 1, failed: 0, skipped: 0 });
  assert.equal(parsed.scenarios[0].id, JSON.stringify(['playwright', 'chromium', 'export-every-note']));
  assert.equal(parsed.scenarios[0].fullTitle, scenarioTitle);
  assert.equal(parsed.scenarios[0].attempts, 1);
  assert.deepEqual(value, original);
});

test('unnamed Playwright project IDs remain explicit valid identities', () => {
  const value = pwFixture(); pwCase(value).projectId = ''; pwCase(value).projectName = '';
  assert.equal(parseVerificationReport('playwright-json', value,
    { requiredScenarios: ['[] export.spec.ts > export > returns every note'] }).status, 'passed');
});

test('Playwright nested suites are fully traversed and counted', () => {
  const value = pwFixture(), spec = structuredClone(pwSpec(value));
  spec.id = 'export-two'; spec.title = 'returns the title';
  value.suites[0].suites[0].suites = [{ title: 'unicode', file: 'export.spec.ts', specs: [spec] }];
  value.stats.expected = 2;
  const parsed = parseVerificationReport('playwright-json', value,
    { requiredScenarios: ['[chromium] export.spec.ts > export > unicode > returns the title'] });
  assert.equal(parsed.status, 'passed'); assert.equal(parsed.counts.total, 2);
});

test('Jest JSON requires reconciled assertions, terminal status and observed first invocation', () => {
  const value = jestFixture(), original = structuredClone(value);
  const parsed = parseVerificationReport('jest-json', value, { requiredScenarios: [jestTitle] });
  assert.equal(parsed.status, 'passed'); assert.equal(parsed.countsConfirmed, true);
  assert.deepEqual(parsed.counts, { total: 1, completed: 1, passed: 1, failed: 0, skipped: 0 });
  assert.equal(parsed.scenarios[0].id, JSON.stringify(['jest-json', 'tests/export.test.mjs', jestTitle]));
  assert.deepEqual(value, original);
});

for (const format of ['playwright-json', 'jest-json']) test(`${format} exact IDs can select a scenario without regex matching`, () => {
  const fixture = format === 'playwright-json' ? pwFixture : jestFixture;
  const parsed = parseVerificationReport(format, fixture());
  assert.equal(parseVerificationReport(format, fixture(), { requiredScenarios: [parsed.scenarios[0].id] }).status, 'passed');
  assert.equal(parseVerificationReport(format, fixture(), { requiredScenarios: ['.*every note.*'] }).status, 'unverified');
  assert.equal(parseVerificationReport(format, fixture(), { requiredScenarios: ['every note'] }).status, 'unverified');
  assert.equal(parseVerificationReport(format, fixture(), { requiredScenarios: ['another full title'] }).status, 'unverified');
});

test('zero test success flags do not confirm execution', () => {
  const pw = pwFixture(); pw.suites = []; pw.stats.expected = 0;
  const jest = jestFixture(); jest.testResults = []; jest.numTotalTests = 0; jest.numPassedTests = 0;
  jest.numTotalTestSuites = 0; jest.numPassedTestSuites = 0;
  for (const [format, value] of [['playwright-json', pw], ['jest-json', jest]]) {
    const parsed = parseVerificationReport(format, value);
    assert.equal(parsed.status, 'unverified'); assert.equal(parsed.counts.completed, 0);
    assert.ok(reason(parsed, 'REPORT_ZERO_COMPLETED_TESTS'));
  }
});

test('a skipped mandatory Playwright scenario blocks an otherwise successful report', () => {
  const value = pwFixture(), skipped = structuredClone(pwSpec(value));
  skipped.id = 'skipped-case'; skipped.title = 'preserves unicode';
  Object.assign(skipped.tests[0], { status: 'skipped', expectedStatus: 'skipped', results: [{ status: 'skipped', retry: 0, errors: [] }] });
  value.suites[0].suites[0].specs.push(skipped); value.stats.skipped = 1;
  assert.equal(parseVerificationReport('playwright-json', value, { requiredScenarios: [scenarioTitle] }).status, 'passed');
  const parsed = parseVerificationReport('playwright-json', value,
    { requiredScenarios: ['[chromium] export.spec.ts > export > preserves unicode'] });
  assert.equal(parsed.status, 'unverified'); assert.ok(reason(parsed, 'REPORT_REQUIRED_SCENARIO_SKIPPED'));
  assert.deepEqual(parsed.counts, { total: 2, completed: 1, passed: 1, failed: 0, skipped: 1 });
});

for (const status of ['pending', 'todo', 'skipped', 'disabled']) test(`Jest ${status} mandatory assertions do not become passed`, () => {
  const value = jestFixture(); jestCase(value).status = status; value.numPassedTests = 0;
  value[status === 'todo' ? 'numTodoTests' : 'numPendingTests'] = 1;
  const parsed = parseVerificationReport('jest-json', value, { requiredScenarios: [jestTitle] });
  assert.equal(parsed.status, 'unverified'); assert.equal(parsed.counts.skipped, 1);
  assert.ok(reason(parsed, 'REPORT_REQUIRED_SCENARIO_SKIPPED'));
});

test('duplicate IDs and ambiguous title matches cannot confirm mandatory execution', () => {
  const value = pwFixture(); value.suites[0].suites[0].specs.push(structuredClone(pwSpec(value))); value.stats.expected = 2;
  let parsed = parseVerificationReport('playwright-json', value, { requiredScenarios: [scenarioTitle] });
  assert.equal(parsed.status, 'unverified'); assert.ok(reason(parsed, 'REPORT_DUPLICATE_SCENARIO_ID'));
  pwSpec(value).id = 'different-test-id';
  parsed = parseVerificationReport('playwright-json', value, { requiredScenarios: [scenarioTitle] });
  assert.equal(parsed.status, 'unverified'); assert.ok(reason(parsed, 'REPORT_REQUIRED_SCENARIO_AMBIGUOUS'));
});

test('same full titles in different files require explicitly selecting both documented IDs', () => {
  const value = jestFixture(), other = structuredClone(value.testResults[0]);
  other.name = 'tests/other-export.test.mjs'; value.testResults.push(other);
  value.numTotalTests = 2; value.numPassedTests = 2; value.numTotalTestSuites = 2; value.numPassedTestSuites = 2;
  const ambiguous = parseVerificationReport('jest-json', value, { requiredScenarios: [jestTitle] });
  assert.equal(ambiguous.status, 'unverified');
  assert.equal(parseVerificationReport('jest-json', value,
    { requiredScenarios: ambiguous.scenarios.map((item) => item.id) }).status, 'passed');
});

for (const [name, mutate, expectedReason] of [
  ['flaky retry', (value) => { const item = pwCase(value); item.status = 'flaky';
    item.results = [{ status: 'failed', retry: 0, errors: [{ message: 'failure' }] }, { status: 'passed', retry: 1, errors: [] }];
    value.stats.expected = 0; value.stats.flaky = 1; }, 'REPORT_FLAKY_TEST'],
  ['hidden failed attempt under expected outcome', (value) => { pwCase(value).results.unshift({ status: 'failed', retry: 0, errors: [] });
    pwCase(value).results[1].retry = 1; }, 'REPORT_FAILED_ATTEMPT'],
  ['unexpected failure', (value) => { pwCase(value).status = 'unexpected'; pwSpec(value).ok = false;
    pwCase(value).results[0].status = 'failed'; value.stats.expected = 0; value.stats.unexpected = 1; }, 'REPORT_UNEXPECTED_OUTCOME'],
  ['expected failure', (value) => { pwCase(value).expectedStatus = 'failed'; pwCase(value).results[0].status = 'failed'; }, 'REPORT_EXPECTED_FAILURE_IS_NOT_PASS'],
  ['global error', (value) => { value.errors = [{ message: 'global teardown failure' }]; }, 'REPORT_RUN_ERRORS'],
]) test(`Playwright failure evidence is never hidden by aggregate expected counts: ${name}`, () => {
  const value = pwFixture(); mutate(value);
  const parsed = parseVerificationReport('playwright-json', value, { requiredScenarios: [scenarioTitle] });
  assert.equal(parsed.status, 'failed'); assert.ok(reason(parsed, expectedReason));
});

for (const [name, mutate, expectedReason] of [
  ['empty completed results', (value) => { pwCase(value).results = []; }, 'REPORT_CASE_NOT_COMPLETED'],
  ['missing first attempt', (value) => { pwCase(value).results[0].retry = 1; }, 'REPORT_RETRY_HISTORY_INCOMPLETE'],
  ['passed with errors', (value) => { pwCase(value).results[0].errors = [{}]; }, 'REPORT_CASE_STATUS_ERROR_MISMATCH'],
  ['interrupted attempt', (value) => { pwCase(value).results[0].status = 'interrupted'; }, 'REPORT_CASE_INTERRUPTED'],
  ['wrong spec ok', (value) => { pwSpec(value).ok = false; }, 'REPORT_SPEC_STATUS_MISMATCH'],
  ['mismatched outcome status', (value) => { pwCase(value).results[0].status = 'skipped'; }, 'REPORT_CASE_STATUS_MISMATCH'],
  ['incorrect counters', (value) => { value.stats.expected = 99; }, 'REPORT_COUNTER_MISMATCH'],
]) test(`Playwright incomplete or contradictory evidence remains unverified: ${name}`, () => {
  const value = pwFixture(); mutate(value);
  const parsed = parseVerificationReport('playwright-json', value);
  assert.equal(parsed.status, 'unverified'); assert.ok(reason(parsed, expectedReason));
});

for (const [name, mutate, expectedReason] of [
  ['failed assertion', (value) => { jestCase(value).status = 'failed'; value.numPassedTests = 0; value.numFailedTests = 1;
    value.testResults[0].status = 'failed'; value.numPassedTestSuites = 0; value.numFailedTestSuites = 1; value.success = false; }, 'REPORT_CASE_FAILED'],
  ['retry invocation', (value) => { jestCase(value).invocations = 2; }, 'REPORT_RETRIED_TEST'],
  ['retry error', (value) => { jestCase(value).retryReasons = ['first attempt failed']; }, 'REPORT_FAILED_ATTEMPT'],
  ['runtime error', (value) => { value.numRuntimeErrorTestSuites = 1; value.numPassedTestSuites = 0; value.numFailedTestSuites = 1;
    value.testResults[0].status = 'failed'; }, 'REPORT_RUN_ERRORS'],
  ['global failure', (value) => { value.success = false; }, 'REPORT_RUN_NOT_SUCCESSFUL'],
  ['snapshot failure', (value) => { value.snapshot = { failure: true }; }, 'REPORT_SNAPSHOT_FAILED'],
]) test(`Jest failure/retry evidence does not pass: ${name}`, () => {
  const value = jestFixture(); mutate(value);
  const parsed = parseVerificationReport('jest-json', value);
  assert.equal(parsed.status, 'failed'); assert.ok(reason(parsed, expectedReason));
});

for (const [name, mutate, expectedReason] of [
  ['unknown invocation history', (value) => { delete jestCase(value).invocations; }, 'REPORT_RETRY_HISTORY_UNAVAILABLE'],
  ['unknown expected failure provenance', (value) => { delete jestCase(value).failing; }, 'REPORT_EXPECTED_FAILURE_PROVENANCE_UNAVAILABLE'],
  ['zero invocation', (value) => { jestCase(value).invocations = 0; }, 'REPORT_CASE_NOT_COMPLETED'],
  ['expected failure inversion', (value) => { jestCase(value).failing = true; }, 'REPORT_EXPECTED_FAILURE_IS_NOT_PASS'],
  ['interruption', (value) => { value.wasInterrupted = true; }, 'REPORT_RUN_INTERRUPTED'],
  ['counter mismatch', (value) => { value.numPassedTests = 2; }, 'REPORT_COUNTER_MISMATCH'],
  ['suite counter mismatch', (value) => { value.numTotalTestSuites = 2; }, 'REPORT_SUITE_COUNTER_MISMATCH'],
  ['wrong full title', (value) => { jestCase(value).fullName = 'different title'; }, 'REPORT_FULL_TITLE_MISMATCH'],
  ['passed with failure messages', (value) => { jestCase(value).failureMessages = ['raw failure']; }, 'REPORT_CASE_STATUS_ERROR_MISMATCH'],
]) test(`Jest unconfirmed data cannot pass: ${name}`, () => {
  const value = jestFixture(); mutate(value);
  const parsed = parseVerificationReport('jest-json', value);
  assert.equal(parsed.status, 'unverified'); assert.ok(reason(parsed, expectedReason));
});

for (const [format, makeValue, mutate] of [
  ['playwright-json', pwFixture, (value) => { delete value.errors; }],
  ['playwright-json', pwFixture, (value) => { delete value.stats.expected; }],
  ['playwright-json', pwFixture, (value) => { value.stats.expected = '1'; }],
  ['playwright-json', pwFixture, (value) => { pwCase(value).status = 'unknown'; }],
  ['playwright-json', pwFixture, (value) => { pwCase(value).results[0].status = 'running'; }],
  ['playwright-json', pwFixture, (value) => { pwCase(value).results[0].retry = -1; }],
  ['playwright-json', pwFixture, (value) => { delete pwCase(value).results[0].errors; }],
  ['jest-json', jestFixture, (value) => { delete value.success; }],
  ['jest-json', jestFixture, (value) => { delete value.wasInterrupted; }],
  ['jest-json', jestFixture, (value) => { value.numTotalTests = -1; }],
  ['jest-json', jestFixture, (value) => { value.numPassedTests = 0.5; }],
  ['jest-json', jestFixture, (value) => { value.numTotalTests = Number.MAX_SAFE_INTEGER + 1; }],
  ['jest-json', jestFixture, (value) => { jestCase(value).status = 'flaky'; }],
  ['jest-json', jestFixture, (value) => { jestCase(value).failureMessages = 'error'; }],
  ['jest-json', jestFixture, (value) => { jestCase(value).ancestorTitles = [null]; }],
  ['jest-json', jestFixture, (value) => { jestCase(value).retryReasons = [123]; }],
]) test(`malformed mandatory fields reject ${format}: ${mutate.toString()}`, () => {
  const value = makeValue(); mutate(value);
  const parsed = parseVerificationReport(format, value);
  assert.equal(parsed.status, 'unverified'); assert.ok(reason(parsed, 'REPORT_MALFORMED'));
  assert.deepEqual(parsed.counts, { total: null, completed: null, passed: null, failed: null, skipped: null });
});

test('Vitest counters normalize without inventing missing retry or expected-failure provenance', () => {
  const value = jestFixture(); delete value.wasInterrupted; delete value.numRuntimeErrorTestSuites;
  delete jestCase(value).invocations; delete jestCase(value).retryReasons; delete jestCase(value).failing;
  const parsed = parseVerificationReport('vitest-json', value, { requiredScenarios: [jestTitle] });
  assert.equal(parsed.status, 'unverified'); assert.equal(parsed.countsConfirmed, true);
  assert.equal(parsed.counts.passed, 1);
  assert.ok(reason(parsed, 'REPORT_RETRY_AND_EXPECTED_FAILURE_PROVENANCE_UNAVAILABLE'));
  assert.ok(parsed.limitations.includes('vitest-json-does-not-export-retry-history-or-test-fails'));
  jestCase(value).status = 'failed'; value.numFailedTests = 1; value.numPassedTests = 0;
  value.testResults[0].status = 'failed'; value.numFailedTestSuites = 1; value.numPassedTestSuites = 0; value.success = false;
  assert.equal(parseVerificationReport('vitest-json', value).status, 'failed');
});

test('Vitest describe-suite counters are not falsely equated to the number of files', () => {
  const value = jestFixture(); value.numTotalTestSuites = 3; value.numPassedTestSuites = 3;
  const parsed = parseVerificationReport('vitest-json', value);
  assert.equal(parsed.countsConfirmed, true);
  assert.equal(reason(parsed, 'REPORT_SUITE_COUNTER_MISMATCH'), false);
});

test('xcresulttool summary counters cannot invent passed test identities', () => {
  const value = { result: 'Passed', totalTestCount: 3, passedTests: 3, failedTests: 0, skippedTests: 0, expectedFailures: 0 };
  const parsed = parseVerificationReport('xcresult-summary-json', value, { requiredScenarios: ['Target/Tests/testExport()'] });
  assert.equal(parsed.status, 'unverified'); assert.equal(parsed.countsConfirmed, false);
  assert.equal(parsed.counts.passed, 3); assert.equal(parsed.counts.completed, null);
  assert.deepEqual(parsed.scenarios, []); assert.ok(reason(parsed, 'REPORT_NATIVE_SCENARIO_EVIDENCE_UNAVAILABLE'));
  assert.ok(reason(parsed, 'REPORT_REQUIRED_SCENARIO_MISSING'));
  assert.equal(parseVerificationReport('xcresult-summary-json', { ...value, result: 'Failed', passedTests: 2, failedTests: 1 }).status, 'failed');
  assert.equal(parseVerificationReport('xcresult-summary-json', { ...value, result: 'SUCCESS' }).status, 'unverified');
});

for (const value of [undefined, null, [], 'not JSON', '{}', { success: true }, { numPassedTests: 1 }, true])
  test(`non-reports never pass: ${JSON.stringify(value)}`, () => {
    for (const format of ['playwright-json', 'jest-json', 'vitest-json', 'xcresult-summary-json'])
      assert.equal(parseVerificationReport(format, value).status, 'unverified');
  });

for (const options of [null, [], { requiredScenarios: null }, { requiredScenarios: 'title' },
  { requiredScenarios: [''] }, { requiredScenarios: [jestTitle, jestTitle] }, { regex: '.*' }])
  test(`malformed selectors never weaken verification: ${JSON.stringify(options)}`, () => {
    assert.equal(parseVerificationReport('jest-json', jestFixture(), options).status, 'unverified');
  });

test('unsupported formats explicitly stay unverified', () => {
  assert.ok(reason(parseVerificationReport('unknown-json', jestFixture()), 'REPORT_FORMAT_UNSUPPORTED'));
});

test('the parser rejects accessors/cycles/nonfinite and class instances without executing report code', () => {
  let getterCalls = 0;
  const accessor = jestFixture(); Object.defineProperty(accessor, 'private', { get() { getterCalls++; throw new Error('secret'); } });
  const cycle = jestFixture(); cycle.self = cycle;
  const nonfinite = jestFixture(); nonfinite.numPassedTests = Infinity;
  for (const value of [accessor, cycle, nonfinite, new Date()])
    assert.equal(parseVerificationReport('jest-json', value).status, 'unverified');
  assert.equal(getterCalls, 0);
});
