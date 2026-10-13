import { assertJsonBounds } from './schemas.mjs';

export const VERIFICATION_REPORT_FORMATS = Object.freeze([
  'playwright-json', 'jest-json', 'vitest-json', 'xcresult-summary-json',
]);

const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const expect = (condition) => { if (!condition) throw new Error('REPORT_SHAPE'); };
const nullCounts = () => ({ total: null, completed: null, passed: null, failed: null, skipped: null });

function state(format) {
  return { version: 1, format, status: 'unverified', counts: nullCounts(), countsConfirmed: false,
    scenarios: [], reasons: [], limitations: [] };
}

function issue(report, code, kind = 'unverified', scenarioId = undefined) {
  report.reasons.push({ code, kind, ...(scenarioId ? { scenarioId } : {}) });
}

function compareCounters(report, actual, declared) {
  for (const key of Object.keys(actual)) expect(count(declared[key]));
  const matches = Object.keys(actual).every((key) => actual[key] === declared[key]);
  if (!matches) issue(report, 'REPORT_COUNTER_MISMATCH');
  return matches;
}

function finish(report, required) {
  const cases = report.scenarios;
  if (report.format !== 'xcresult-summary-json') {
    const passed = cases.filter((item) => item.status === 'passed').length;
    const failed = cases.filter((item) => item.status === 'failed').length;
    const skipped = cases.filter((item) => item.status === 'skipped').length;
    report.counts = { total: cases.length, completed: passed + failed, passed, failed, skipped };
    if (!cases.length || !report.counts.completed) issue(report, 'REPORT_ZERO_COMPLETED_TESTS');
  }
  const ids = new Map(), titles = new Map();
  for (const scenario of cases) {
    ids.set(scenario.id, [...(ids.get(scenario.id) ?? []), scenario]);
    titles.set(scenario.fullTitle, [...(titles.get(scenario.fullTitle) ?? []), scenario]);
  }
  if ([...ids.values()].some((items) => items.length > 1)) issue(report, 'REPORT_DUPLICATE_SCENARIO_ID');
  for (const selector of required) {
    const matches = [...new Set([...(ids.get(selector) ?? []), ...(titles.get(selector) ?? [])])];
    if (!matches.length) issue(report, 'REPORT_REQUIRED_SCENARIO_MISSING');
    else if (matches.length !== 1) issue(report, 'REPORT_REQUIRED_SCENARIO_AMBIGUOUS');
    else if (matches[0].status === 'skipped') issue(report, 'REPORT_REQUIRED_SCENARIO_SKIPPED', 'unverified', matches[0].id);
    else if (matches[0].status !== 'passed') issue(report, 'REPORT_REQUIRED_SCENARIO_NOT_PASSED',
      matches[0].status === 'failed' ? 'failed' : 'unverified', matches[0].id);
  }
  // Ambiguous titles may be selected only through their exact documented identity.
  for (const matches of titles.values()) if (matches.length > 1 &&
    !matches.every((item) => required.includes(item.id))) issue(report, 'REPORT_AMBIGUOUS_FULL_TITLE');
  report.status = report.reasons.some((reason) => reason.kind === 'failed') || cases.some((item) => item.status === 'failed')
    ? 'failed' : report.reasons.length || !report.countsConfirmed ? 'unverified' : 'passed';
  return report;
}

function playwright(report, value) {
  expect(object(value) && Array.isArray(value.suites) && Array.isArray(value.errors) && object(value.stats));
  const counters = { expected: 0, unexpected: 0, flaky: 0, skipped: 0 };
  if (value.errors.length) issue(report, 'REPORT_RUN_ERRORS', 'failed');
  const visit = (suite, parents) => {
    expect(object(suite) && text(suite.title) && text(suite.file) && Array.isArray(suite.specs));
    const titles = [...parents, suite.title];
    if (suite.suites !== undefined) expect(Array.isArray(suite.suites));
    for (const spec of suite.specs) {
      expect(object(spec) && text(spec.title) && text(spec.file) && text(spec.id) &&
        typeof spec.ok === 'boolean' && Array.isArray(spec.tests) && spec.tests.length > 0);
      let specOk = true;
      for (const test of spec.tests) {
        expect(object(test) && typeof test.projectName === 'string' && typeof test.projectId === 'string' &&
          ['passed', 'failed', 'skipped', 'timedOut', 'interrupted'].includes(test.expectedStatus) &&
          Object.hasOwn(counters, test.status) && Array.isArray(test.results));
        counters[test.status]++;
        if (test.status === 'unexpected') specOk = false;
        const id = JSON.stringify(['playwright', test.projectId, spec.id]);
        let outcome = test.status === 'skipped' ? 'skipped' : test.status === 'expected' ? 'passed' : 'failed';
        if (test.status === 'flaky') issue(report, 'REPORT_FLAKY_TEST', 'failed', id);
        if (test.status === 'unexpected') issue(report, 'REPORT_UNEXPECTED_OUTCOME', 'failed', id);
        if (!test.results.length && test.status !== 'skipped') {
          outcome = 'unverified'; issue(report, 'REPORT_CASE_NOT_COMPLETED', 'unverified', id);
        }
        for (const [index, result] of test.results.entries()) {
          expect(object(result) && ['passed', 'failed', 'timedOut', 'skipped', 'interrupted'].includes(result.status) &&
            count(result.retry) && Array.isArray(result.errors));
          if (result.retry !== index) issue(report, 'REPORT_RETRY_HISTORY_INCOMPLETE', 'unverified', id);
          if (result.status === 'passed' && (result.errors.length || result.error)) {
            outcome = 'unverified'; issue(report, 'REPORT_CASE_STATUS_ERROR_MISMATCH', 'unverified', id);
          }
          if (result.status === 'interrupted') {
            outcome = 'unverified'; issue(report, 'REPORT_CASE_INTERRUPTED', 'unverified', id);
          }
        }
        const last = test.results.at(-1);
        if (test.status === 'expected' && test.expectedStatus !== 'passed') {
          outcome = 'failed'; issue(report, 'REPORT_EXPECTED_FAILURE_IS_NOT_PASS', 'failed', id);
        }
        if (test.status === 'expected' && test.expectedStatus === 'passed' && last?.status !== 'passed') {
          outcome = 'unverified'; issue(report, 'REPORT_CASE_STATUS_MISMATCH', 'unverified', id);
        }
        if (test.status === 'skipped' && test.results.some((result) => result.status !== 'skipped')) {
          outcome = 'unverified'; issue(report, 'REPORT_CASE_STATUS_MISMATCH', 'unverified', id);
        }
        if (test.results.length > 1 && test.results.some((result) => ['failed', 'timedOut'].includes(result.status))) {
          outcome = 'failed'; issue(report, 'REPORT_FAILED_ATTEMPT', 'failed', id);
        }
        report.scenarios.push({ id, fullTitle: `[${test.projectName}] ${[...titles, spec.title].join(' > ')}`,
          file: spec.file, project: test.projectId, status: outcome, attempts: test.results.length });
      }
      if (spec.ok !== specOk) issue(report, 'REPORT_SPEC_STATUS_MISMATCH');
    }
    for (const child of suite.suites ?? []) visit(child, titles);
  };
  for (const suite of value.suites) visit(suite, []);
  report.countsConfirmed = compareCounters(report, counters, value.stats);
}

function jestLike(report, value) {
  expect(object(value) && typeof value.success === 'boolean' && Array.isArray(value.testResults));
  const isJest = report.format === 'jest-json';
  const counters = { numTotalTests: 0, numPassedTests: 0, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0 };
  if (!value.success) issue(report, 'REPORT_RUN_NOT_SUCCESSFUL', 'failed');
  if (isJest) {
    expect(typeof value.wasInterrupted === 'boolean' && count(value.numRuntimeErrorTestSuites));
    if (value.wasInterrupted) issue(report, 'REPORT_RUN_INTERRUPTED');
    if (value.numRuntimeErrorTestSuites > 0 || value.runExecError) issue(report, 'REPORT_RUN_ERRORS', 'failed');
  }
  if (value.snapshot?.failure !== undefined) {
    expect(typeof value.snapshot.failure === 'boolean');
    if (value.snapshot.failure) issue(report, 'REPORT_SNAPSHOT_FAILED', 'failed');
  }
  for (const suite of value.testResults) {
    expect(object(suite) && text(suite.name) && Array.isArray(suite.assertionResults) &&
      ['passed', 'failed', ...(isJest ? ['skipped', 'focused'] : [])].includes(suite.status));
    if (suite.status === 'failed') issue(report, 'REPORT_SUITE_FAILED', 'failed');
    if (suite.testExecError) issue(report, 'REPORT_RUN_ERRORS', 'failed');
    if (suite.message !== undefined) expect(typeof suite.message === 'string');
    if (suite.message) issue(report, 'REPORT_SUITE_MESSAGE_UNCONFIRMED');
    for (const assertion of suite.assertionResults) {
      expect(object(assertion) && text(assertion.title) && text(assertion.fullName) &&
        Array.isArray(assertion.ancestorTitles) && assertion.ancestorTitles.every((title) => typeof title === 'string') &&
        ['passed', 'failed', 'skipped', 'pending', 'todo', 'disabled'].includes(assertion.status) &&
        (assertion.failureMessages === null || Array.isArray(assertion.failureMessages)));
      expect((assertion.failureMessages ?? []).every((message) => typeof message === 'string'));
      const id = JSON.stringify([report.format, suite.name, assertion.fullName]);
      counters.numTotalTests++;
      const reported = assertion.status === 'passed' ? 'passed' : assertion.status === 'failed' ? 'failed' : 'skipped';
      if (reported === 'passed') counters.numPassedTests++;
      else if (reported === 'failed') counters.numFailedTests++;
      else if (assertion.status === 'todo') counters.numTodoTests++;
      else counters.numPendingTests++;
      let outcome = reported;
      if (assertion.fullName !== [...assertion.ancestorTitles, assertion.title].join(' '))
        issue(report, 'REPORT_FULL_TITLE_MISMATCH', 'unverified', id);
      if (reported === 'failed') issue(report, 'REPORT_CASE_FAILED', 'failed', id);
      if (reported === 'passed' && assertion.failureMessages?.length) {
        outcome = 'unverified'; issue(report, 'REPORT_CASE_STATUS_ERROR_MISMATCH', 'unverified', id);
      }
      if (suite.status === 'skipped' && reported !== 'skipped') issue(report, 'REPORT_SUITE_STATUS_MISMATCH');
      if (suite.status === 'passed' && reported === 'failed') issue(report, 'REPORT_SUITE_STATUS_MISMATCH');
      let attempts = null;
      if (isJest) {
        if (assertion.invocations !== undefined) {
          expect(count(assertion.invocations)); attempts = assertion.invocations;
          if (reported !== 'skipped' && attempts === 0) {
            outcome = 'unverified'; issue(report, 'REPORT_CASE_NOT_COMPLETED', 'unverified', id);
          }
          if (attempts > 1) { outcome = 'failed'; issue(report, 'REPORT_RETRIED_TEST', 'failed', id); }
        } else if (reported === 'passed') issue(report, 'REPORT_RETRY_HISTORY_UNAVAILABLE', 'unverified', id);
        if (assertion.retryReasons !== undefined) {
          expect(Array.isArray(assertion.retryReasons) && assertion.retryReasons.every((reason) => typeof reason === 'string'));
          if (assertion.retryReasons.length) { outcome = 'failed'; issue(report, 'REPORT_FAILED_ATTEMPT', 'failed', id); }
        }
        if (assertion.failing !== undefined) {
          expect(typeof assertion.failing === 'boolean');
          if (assertion.failing) { outcome = 'unverified'; issue(report, 'REPORT_EXPECTED_FAILURE_IS_NOT_PASS', 'unverified', id); }
        } else if (reported === 'passed') issue(report, 'REPORT_EXPECTED_FAILURE_PROVENANCE_UNAVAILABLE', 'unverified', id);
      }
      report.scenarios.push({ id, fullTitle: assertion.fullName, file: suite.name, project: null,
        status: outcome, attempts });
    }
  }
  report.countsConfirmed = compareCounters(report, counters, value);
  const suiteCounters = ['numTotalTestSuites', 'numPassedTestSuites', 'numFailedTestSuites', 'numPendingTestSuites'];
  for (const key of suiteCounters) expect(count(value[key]));
  if (value.numTotalTestSuites !== value.numPassedTestSuites + value.numFailedTestSuites + value.numPendingTestSuites ||
      (isJest && value.numTotalTestSuites !== value.testResults.length)) {
    report.countsConfirmed = false; issue(report, 'REPORT_SUITE_COUNTER_MISMATCH');
  }
  if (value.numFailedTestSuites > 0) issue(report, 'REPORT_SUITE_FAILED', 'failed');
  if (isJest && value.numFailedTestSuites < value.numRuntimeErrorTestSuites) {
    report.countsConfirmed = false; issue(report, 'REPORT_SUITE_COUNTER_MISMATCH');
  }
  if (isJest) {
    const suites = { numTotalTestSuites: value.testResults.length,
      numPassedTestSuites: value.testResults.filter((suite) => ['passed', 'focused'].includes(suite.status)).length,
      numFailedTestSuites: value.testResults.filter((suite) => suite.status === 'failed').length,
      numPendingTestSuites: value.testResults.filter((suite) => suite.status === 'skipped').length };
    report.countsConfirmed = compareCounters(report, suites, value) && report.countsConfirmed;
  }
  if (!isJest) {
    // The official JSON reporter omits retry history and test.fails provenance.
    // Final pass counters alone cannot certify a first-attempt successful scenario.
    issue(report, 'REPORT_RETRY_AND_EXPECTED_FAILURE_PROVENANCE_UNAVAILABLE');
    report.limitations.push('vitest-json-does-not-export-retry-history-or-test-fails');
  }
}

function xcresultSummary(report, value) {
  expect(object(value) && ['Passed', 'Failed', 'Skipped', 'Expected Failure', 'unknown'].includes(value.result));
  for (const key of ['totalTestCount', 'passedTests', 'failedTests', 'skippedTests', 'expectedFailures']) expect(count(value[key]));
  report.counts = { total: value.totalTestCount, completed: null, passed: value.passedTests,
    failed: value.failedTests, skipped: value.skippedTests };
  if (value.result === 'Failed' && value.failedTests > 0) issue(report, 'REPORT_NATIVE_SUMMARY_FAILED', 'failed');
  if (value.result === 'unknown') issue(report, 'REPORT_NATIVE_STATUS_UNKNOWN');
  issue(report, 'REPORT_NATIVE_SCENARIO_EVIDENCE_UNAVAILABLE');
  report.limitations.push('xcresulttool-summary-schema-0.1.0-does-not-enumerate-passed-scenarios');
}

/**
 * Parse decoded JSON from a trusted registered reporter; no file reads or effects.
 * A passed report covers observed scenarios only, never arbitrary requirement semantics.
 * @param {string} format
 * @param {any} value
 * @param {{requiredScenarios?: string[]}} [options]
 */
export function parseVerificationReport(format, value, options = {}) {
  const report = state(typeof format === 'string' ? format : null);
  if (!VERIFICATION_REPORT_FORMATS.includes(format)) {
    issue(report, 'REPORT_FORMAT_UNSUPPORTED'); return report;
  }
  try {
    assertJsonBounds(value, 100000);
    assertJsonBounds(options);
    expect(object(options) && Object.keys(options).every((key) => key === 'requiredScenarios'));
    const required = Object.hasOwn(options, 'requiredScenarios') ? options.requiredScenarios : [];
    expect(Array.isArray(required) && required.every(text) && new Set(required).size === required.length);
    if (format === 'playwright-json') playwright(report, value);
    else if (format === 'xcresult-summary-json') xcresultSummary(report, value);
    else jestLike(report, value);
    return finish(report, required);
  } catch {
    const rejected = state(format); issue(rejected, 'REPORT_MALFORMED'); return rejected;
  }
}
