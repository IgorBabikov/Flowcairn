import { hashObject, sha256 } from './io.mjs';
import { assertJsonBounds } from './schemas.mjs';

const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const countKeys = ['tests', 'suites', 'passed', 'failed', 'cancelled', 'skipped', 'todo', 'topLevel'];
const outcomes = ['passed', 'failed', 'cancelled', 'skipped', 'todo'];
const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const consistent = (counts) => counts && countKeys.every((key) => integer(counts[key])) &&
  counts.tests === outcomes.reduce((sum, key) => sum + counts[key], 0);
const requireFact = (value) => { if (!value) throw new Error('NODE_REPORT_INVALID'); };

/** Normalize only the bundled Node22 reporter's event-derived facts; no diagnostic text inference. */
export function parseNodeVerificationReport(value, { requiredScenarios = [] } = {}) {
  const result = { version: 1, format: 'flowcairn-node-test/v1', status: 'unverified',
    counts: { total: null, completed: null, passed: null, failed: null, skipped: null }, countsConfirmed: false,
    assertionFailures: 0, scenarios: [], reasons: [], limitations: ['event-report-is-not-semantic-requirement-proof'] };
  try {
    assertJsonBounds(value, 100000);
    requireFact(value?.format === result.format && value.runner?.name === 'node:test' && /^22\./.test(value.runner.nodeVersion) &&
      typeof value.completed === 'boolean' && ['passed', 'failed', 'incomplete'].includes(value.status) &&
      consistent(value.summary?.counts) && typeof value.summary.success === 'boolean' &&
      integer(value.registeredTests) && Array.isArray(value.cases) && Array.isArray(value.fileSummaries) && Array.isArray(value.issues));
    const counts = value.summary.counts;
    const observed = Object.fromEntries(countKeys.map((key) => [key, 0]));
    const ids = new Set();
    for (const item of value.cases) {
      requireFact(hash(item.id) && hash(item.fileHash) && hash(item.nameHash) && !ids.has(item.id) &&
        ['test', 'suite'].includes(item.type) && outcomes.includes(item.status) &&
        ['test:pass', 'test:fail'].includes(item.event) && integer(item.nesting) && integer(item.testNumber) && item.testNumber >= 1 &&
        integer(item.occurrence) && item.occurrence >= 1 &&
        (item.line === null || integer(item.line) && item.line >= 1) && (item.column === null || integer(item.column) && item.column >= 1));
      requireFact(item.id === sha256(JSON.stringify({ fileHash: item.fileHash, nameHash: item.nameHash, line: item.line, column: item.column,
        nesting: item.nesting, testNumber: item.testNumber, type: item.type, occurrence: item.occurrence })));
      ids.add(item.id);
      if (item.nesting === 0) observed.topLevel++;
      if (item.type === 'suite') observed.suites++;
      else {
        observed.tests++; observed[item.status]++;
        result.scenarios.push({ id: item.id, nameHash: item.nameHash, status: item.status });
        if (item.status === 'failed' && item.event === 'test:fail' && item.failure?.kind === 'assertion' &&
            item.failure.failureType === 'testCodeFailure' && [item.failure.errorCode, item.failure.causeCode].includes('ERR_ASSERTION'))
          result.assertionFailures++;
      }
      if (item.status === 'passed') requireFact(item.event === 'test:pass' && item.failure === null);
    }
    const fileIds = new Set(), totals = Object.fromEntries(countKeys.map((key) => [key, 0]));
    for (const item of value.fileSummaries) {
      requireFact(hash(item.fileHash) && !fileIds.has(item.fileHash) && consistent(item.counts) && typeof item.success === 'boolean');
      fileIds.add(item.fileHash);
      for (const key of countKeys) totals[key] += item.counts[key];
    }
    result.countsConfirmed = value.completed && value.issues.length === 0 && value.registeredTests > 0 &&
      value.registeredTests === totals.tests && countKeys.every((key) => observed[key] === counts[key] && totals[key] === counts[key]) &&
      value.cases.every((item) => fileIds.has(item.fileHash));
    const failureObserved = counts.failed > 0 || counts.cancelled > 0;
    const contradictorySuccess = value.summary.success === true && (failureObserved || value.fileSummaries.some((item) => !item.success)) ||
      value.fileSummaries.some((item) => item.success === true && (item.counts.failed > 0 || item.counts.cancelled > 0)) ||
      value.status === 'passed' && !value.summary.success;
    if (contradictorySuccess) { result.countsConfirmed = false; result.reasons.push({ code: 'NODE_REPORT_STATUS_MISMATCH', kind: 'unverified' }); }
    result.counts = { total: counts.tests, completed: counts.passed + counts.failed, passed: counts.passed, failed: counts.failed,
      skipped: counts.skipped + counts.todo + counts.cancelled };
    if (!result.countsConfirmed) result.reasons.push({ code: 'NODE_REPORT_INCOMPLETE', kind: 'unverified' });
    if (!result.counts.completed) result.reasons.push({ code: 'REPORT_ZERO_COMPLETED_TESTS', kind: 'unverified' });
    for (const selector of requiredScenarios) {
      requireFact(typeof selector === 'string' && selector.length > 0);
      const nameHash = sha256(selector);
      const matches = result.scenarios.filter((item) => item.id === selector || item.nameHash === selector || item.nameHash === nameHash);
      if (matches.length !== 1) result.reasons.push({ code: matches.length ? 'REPORT_REQUIRED_SCENARIO_AMBIGUOUS' : 'REPORT_REQUIRED_SCENARIO_MISSING', kind: 'unverified' });
      else if (matches[0].status !== 'passed') result.reasons.push({ code: 'REPORT_REQUIRED_SCENARIO_NOT_PASSED', kind: matches[0].status === 'failed' ? 'failed' : 'unverified' });
    }
    if (counts.cancelled || counts.skipped || counts.todo) result.reasons.push({ code: 'NODE_REPORT_NONCOMPLETED_CASE', kind: 'unverified' });
    const failed = counts.failed > 0 || !value.summary.success;
    if (failed) result.status = 'failed';
    else if (result.countsConfirmed && !result.reasons.length && value.status === 'passed' && counts.passed > 0) result.status = 'passed';
    if (!result.countsConfirmed) result.assertionFailures = 0;
    result.factsHash = hashObject({ counts: result.counts, countsConfirmed: result.countsConfirmed, scenarios: result.scenarios, assertionFailures: result.assertionFailures });
  } catch {
    result.status = 'unverified'; result.countsConfirmed = false; result.assertionFailures = 0;
    result.reasons.push({ code: 'REPORT_SHAPE_INVALID', kind: 'unverified' });
  }
  return result;
}
