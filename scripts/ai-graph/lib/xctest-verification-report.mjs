import path from 'node:path';
import { hashObject, sha256 } from './io.mjs';
import { assertJsonBounds } from './schemas.mjs';

export const XCTEST_REPORT_FORMAT = 'flowcairn-xctest/v1';
export const XCTEST_SCHEMA_HASHES = Object.freeze({
  summary: 'b58076b9fd20285fba040974e56514ae6b5754cd28944939aa9eab6e636ddc59',
  tests: '18adcaa0c1bb43c466c0e0587816dbbe127c86e69e0f07fcde601ab7398d47da',
});
const RESULTS = ['Passed', 'Failed', 'Skipped', 'Expected Failure', 'unknown'];
const NODE_TYPES = ['Test Plan', 'Unit test bundle', 'UI test bundle', 'Test Suite', 'Test Case', 'Device',
  'Test Plan Configuration', 'Arguments', 'Repetition', 'Test Case Run', 'Failure Message',
  'Source Code Reference', 'Attachment', 'Expression', 'Test Value', 'Runtime Warning'];
const COUNTERS = ['totalTestCount', 'passedTests', 'failedTests', 'skippedTests', 'expectedFailures'];
const PLATFORMS = ['iOS', 'iOS Simulator', 'macOS', 'tvOS', 'tvOS Simulator', 'watchOS', 'watchOS Simulator', 'visionOS', 'visionOS Simulator'];
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.length > 0 && value.length <= 4096;
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const expect = (condition) => { if (!condition) throw new Error('XCTEST_REPORT_SHAPE'); };

function state() {
  return { version: 1, format: XCTEST_REPORT_FORMAT, status: 'unverified',
    counts: { total: null, completed: null, passed: null, failed: null, skipped: null }, countsConfirmed: false,
    scenarios: [], reasons: [], limitations: ['case-results-do-not-prove-arbitrary-requirement-semantics',
      'case-environment-binding-and-current-source-not-proven', 'observed-xcresulttool-export-subset-not-full-schema-validation'],
    environment: { status: 'unknown', identity: null, devices: [], configurations: [] },
    artifact: { status: 'unknown', identity: null, kind: null }, schema: { status: 'unknown', version: null, summaryHash: null, testsHash: null } };
}

function issue(report, code, kind = 'unverified', scenarioId = undefined) {
  report.reasons.push({ code, kind, ...(scenarioId ? { scenarioId } : {}) });
}

function scenarioId(value) {
  return text(value) && value === value.trim() && !path.posix.isAbsolute(value) && !/^[a-z][a-z\d+.-]*:/i.test(value) &&
    !value.includes('\\') && ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
    !value.split('/').some((part) => !part || ['.', '..'].includes(part));
}

function environmentFacts(tests) {
  const devices = tests.devices.map((device) => {
    expect(object(device) && ['deviceId', 'deviceName', 'architecture', 'modelName', 'osVersion'].every((key) => text(device[key])));
    return { identity: sha256(device.deviceId), platform: PLATFORMS.includes(device.platform) ? device.platform : null,
      architecture: ['arm64', 'arm64e', 'x86_64', 'i386'].includes(device.architecture) ? device.architecture : null,
      osVersion: /^\d+(?:\.\d+){0,3}$/.test(device.osVersion) ? device.osVersion : null };
  }).sort((a, b) => a.identity.localeCompare(b.identity));
  const configurations = tests.testPlanConfigurations.map((configuration) => {
    expect(object(configuration) && text(configuration.configurationId) && text(configuration.configurationName));
    return { identity: sha256(configuration.configurationId) };
  }).sort((a, b) => a.identity.localeCompare(b.identity));
  const known = devices.length > 0 && configurations.length > 0 && devices.every((device) => device.platform && device.architecture && device.osVersion);
  return { status: known ? 'reported' : 'unknown', identity: known ? hashObject({ devices, configurations }) : null, devices, configurations };
}

/**
 * Pure normalization of xcresulttool `get test-results summary` and `tests` JSON.
 * No file/tool/device access. Producer/caller owns bundle hashes, source freshness and execution receipts.
 * @param {any} value
 * @param {{requiredScenarios?: string[]}} [options]
 */
export function parseXCTestVerificationReport(value, options = {}) {
  const report = state();
  try {
    assertJsonBounds(value, 100000); assertJsonBounds(options);
    expect(object(value) && object(options) && Object.keys(options).every((key) => key === 'requiredScenarios'));
    const required = Object.hasOwn(options, 'requiredScenarios') ? options.requiredScenarios : [];
    expect(Array.isArray(required) && required.every(scenarioId) && new Set(required).size === required.length);
    if (value.format !== XCTEST_REPORT_FORMAT) { issue(report, 'REPORT_FORMAT_UNSUPPORTED'); return report; }
    if (value.schemaVersion !== undefined || (value.schemaHashes !== undefined && (!object(value.schemaHashes) ||
      value.schemaHashes.summary !== XCTEST_SCHEMA_HASHES.summary || value.schemaHashes.tests !== XCTEST_SCHEMA_HASHES.tests))) {
      issue(report, 'REPORT_SCHEMA_UNSUPPORTED'); return report;
    }
    if (value.schemaHashes !== undefined) report.schema = { status: 'declared', version: null,
      summaryHash: value.schemaHashes.summary, testsHash: value.schemaHashes.tests };
    report.limitations.push('xcresulttool-outputs-do-not-report-schema-version');
    expect(object(value.summary) && object(value.tests));
    const summary = value.summary, tests = value.tests;
    expect(RESULTS.includes(summary.result) && COUNTERS.every((key) => count(summary[key])) &&
      typeof summary.title === 'string' && typeof summary.environmentDescription === 'string' &&
      ['topInsights', 'statistics', 'devicesAndConfigurations', 'testFailures'].every((key) => Array.isArray(summary[key])) &&
      ['testNodes', 'devices', 'testPlanConfigurations'].every((key) => Array.isArray(tests[key])));
    report.environment = environmentFacts(tests);
    if (report.environment.status === 'unknown') report.limitations.push('environment-identity-unknown');
    if (value.artifact !== undefined) {
      expect(object(value.artifact) && value.artifact.kind === 'xcresult-bundle' && hash(value.artifact.hash));
      report.artifact = { status: 'reported', identity: value.artifact.hash, kind: 'xcresult-bundle' };
    } else report.limitations.push('artifact-identity-unknown');
    const observed = { totalTestCount: 0, passedTests: 0, failedTests: 0, skippedTests: 0, expectedFailures: 0 };
    let unresolved = false;
    const ids = new Map();
    const visit = (node) => {
      expect(object(node) && NODE_TYPES.includes(node.nodeType) && typeof node.name === 'string');
      if (node.children !== undefined) expect(Array.isArray(node.children));
      if (node.result !== undefined) expect(RESULTS.includes(node.result));
      if (node.nodeType === 'Test Case') {
        expect(scenarioId(node.nodeIdentifier));
        observed.totalTestCount++;
        const result = node.result ?? 'unknown';
        const status = result === 'Passed' ? 'passed' : result === 'Failed' ? 'failed' : result === 'Skipped' ? 'skipped' : 'unverified';
        report.scenarios.push({ id: node.nodeIdentifier, status, nativeResult: result });
        ids.set(node.nodeIdentifier, (ids.get(node.nodeIdentifier) ?? 0) + 1);
        if (result === 'Passed') observed.passedTests++;
        else if (result === 'Failed') { observed.failedTests++; issue(report, 'REPORT_CASE_FAILED', 'failed', node.nodeIdentifier); }
        else if (result === 'Skipped') { observed.skippedTests++; issue(report, 'REPORT_CASE_SKIPPED', 'unverified', node.nodeIdentifier); }
        else if (result === 'Expected Failure') { observed.expectedFailures++; issue(report, 'REPORT_EXPECTED_FAILURE_IS_NOT_PASS', 'unverified', node.nodeIdentifier); }
        else { unresolved = true; issue(report, 'REPORT_CASE_RESULT_UNKNOWN', 'unverified', node.nodeIdentifier); }
      } else if (node.result === 'Failed') issue(report, 'REPORT_NON_CASE_FAILURE', 'failed');
      else if (['Skipped', 'Expected Failure', 'unknown'].includes(node.result)) issue(report, 'REPORT_NON_CASE_RESULT_UNCONFIRMED');
      for (const child of node.children ?? []) visit(child);
    };
    for (const node of tests.testNodes) visit(node);
    const duplicates = [...ids].filter(([, occurrences]) => occurrences > 1);
    if (duplicates.length) issue(report, 'REPORT_DUPLICATE_SCENARIO_ID');
    const matches = COUNTERS.every((key) => observed[key] === summary[key]);
    const declaredTotal = summary.passedTests + summary.failedTests + summary.skippedTests + summary.expectedFailures;
    if (!matches || declaredTotal !== summary.totalTestCount) issue(report, 'REPORT_COUNTER_MISMATCH');
    report.countsConfirmed = matches && declaredTotal === summary.totalTestCount && !unresolved && !duplicates.length;
    report.counts = { total: observed.totalTestCount, completed: observed.passedTests + observed.failedTests,
      passed: observed.passedTests, failed: observed.failedTests, skipped: observed.skippedTests + observed.expectedFailures };
    if (!report.counts.total || !report.counts.completed) issue(report, 'REPORT_ZERO_COMPLETED_TESTS');
    if (summary.testFailures.length) issue(report, 'REPORT_RUN_FAILURES', 'failed');
    if (summary.result === 'Failed') issue(report, 'REPORT_NATIVE_SUMMARY_FAILED', 'failed');
    else if (summary.result !== 'Passed') issue(report, 'REPORT_NATIVE_STATUS_UNCONFIRMED');
    if (summary.result === 'Passed' && (observed.failedTests || summary.testFailures.length)) issue(report, 'REPORT_STATUS_MISMATCH');
    for (const id of required) {
      const cases = report.scenarios.filter((scenario) => scenario.id === id);
      if (!cases.length) issue(report, 'REPORT_REQUIRED_SCENARIO_MISSING');
      else if (cases.length !== 1) issue(report, 'REPORT_REQUIRED_SCENARIO_AMBIGUOUS');
      else if (cases[0].status !== 'passed') issue(report, 'REPORT_REQUIRED_SCENARIO_NOT_PASSED', cases[0].status === 'failed' ? 'failed' : 'unverified', id);
    }
    report.status = report.reasons.some((reason) => reason.kind === 'failed') ? 'failed' :
      report.reasons.length || !report.countsConfirmed ? 'unverified' : 'passed';
    report.factsHash = hashObject({ counts: report.counts, countsConfirmed: report.countsConfirmed, scenarios: report.scenarios,
      environment: report.environment, artifact: report.artifact, schema: report.schema });
    return report;
  } catch {
    const rejected = state(); issue(rejected, 'REPORT_MALFORMED'); return rejected;
  }
}
