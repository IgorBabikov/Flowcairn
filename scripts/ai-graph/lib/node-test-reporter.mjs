import { createHash } from 'node:crypto';
import path from 'node:path';

export const NODE_TEST_REPORT_FORMAT = 'flowcairn-node-test/v1';
const COUNT_KEYS = ['tests', 'suites', 'passed', 'failed', 'cancelled', 'skipped', 'todo', 'topLevel'];
const OUTCOME_KEYS = ['passed', 'failed', 'cancelled', 'skipped', 'todo'];
const FAILURE_TYPES = new Set(['testCodeFailure', 'subtestsFailed', 'cancelledByParent', 'testAborted',
  'testTimeoutFailure', 'hookFailed', 'parentAlreadyFinished', 'callbackAndPromisePresent', 'uncaughtException', 'unhandledRejection']);
const CANCELLATIONS = new Set(['cancelledByParent', 'testAborted', 'testTimeoutFailure']);
const ERROR_CODES = new Set(['ERR_TEST_FAILURE', 'ERR_ASSERTION', 'ABORT_ERR', 'ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND']);
const MAX_RECORDS = 100000;
const digest = (text) => createHash('sha256').update(text).digest('hex');
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const numberOrNull = (value, minimum = 0) => integer(value, minimum) ? value : null;
const marked = (value) => value === true || typeof value === 'string';

// Exception objects are user controlled. Never call their getters/toJSON or serialize them.
function errorField(value, key) {
  if (!value || typeof value !== 'object') return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function failure(details) {
  const error = errorField(details, 'error');
  const cause = errorField(error, 'cause');
  const rawType = errorField(error, 'failureType');
  const rawCode = errorField(error, 'code');
  const rawCauseCode = errorField(cause, 'code');
  const failureType = FAILURE_TYPES.has(rawType) ? rawType : null;
  const errorCode = ERROR_CODES.has(rawCode) ? rawCode : null;
  const causeCode = ERROR_CODES.has(rawCauseCode) ? rawCauseCode : null;
  return { kind: failureType === 'testCodeFailure' && [errorCode, causeCode].includes('ERR_ASSERTION') ? 'assertion' : 'unknown',
    failureType, errorCode, causeCode };
}

function fileIdentity(file) {
  if (typeof file !== 'string' || !file || file.length > 4096) return null;
  // Hash the relative spelling so independent copies of the same project have stable scenario IDs.
  return digest(path.relative(process.cwd(), file).split(path.sep).join('/'));
}

function caseRecord(type, data, occurrences) {
  const fileHash = fileIdentity(data.file);
  const nameHash = typeof data.name === 'string' && data.name.length <= 65536 ? digest(data.name) : null;
  const record = { fileHash, nameHash, line: numberOrNull(data.line, 1), column: numberOrNull(data.column, 1),
    nesting: numberOrNull(data.nesting), testNumber: numberOrNull(data.testNumber, 1),
    type: ['test', 'suite'].includes(data.details?.type) ? data.details.type : 'unknown' };
  const base = JSON.stringify(record), occurrence = (occurrences.get(base) ?? 0) + 1;
  occurrences.set(base, occurrence);
  const result = type === 'test:fail' ? failure(data.details) : null;
  const status = marked(data.skip) ? 'skipped' : marked(data.todo) ? 'todo' : result && CANCELLATIONS.has(result.failureType)
    ? 'cancelled' : type === 'test:pass' ? 'passed' : 'failed';
  return { id: digest(JSON.stringify({ ...record, occurrence })), ...record, occurrence, event: type, status, failure: result };
}

function summaryRecord(data) {
  if (typeof data.success !== 'boolean' || !COUNT_KEYS.every((key) => integer(data.counts?.[key]))) return null;
  return { success: data.success, counts: Object.fromEntries(COUNT_KEYS.map((key) => [key, data.counts[key]])) };
}

function consistentCounts(counts) {
  return counts.tests === OUTCOME_KEYS.reduce((sum, key) => sum + counts[key], 0);
}

/** Consume only official Node TestsStream facts. This function never launches or controls a test run. */
export async function collectNodeTestReport(source) {
  const cases = [], fileSummaries = [], issues = new Set(), occurrences = new Map();
  let summary = null, finalSummaries = 0, streamEnded = false;
  try {
    for await (const event of source) {
      if (!['test:pass', 'test:fail', 'test:summary'].includes(event?.type)) continue;
      if (cases.length + fileSummaries.length >= MAX_RECORDS) { issues.add('report-limit'); continue; }
      const data = event.data;
      if (!data || typeof data !== 'object') { issues.add('invalid-event'); continue; }
      if (event.type === 'test:summary') {
        const record = summaryRecord(data);
        if (!record) { issues.add('invalid-summary'); continue; }
        if (data.file === undefined) { summary = record; finalSummaries++; }
        else {
          const fileHash = fileIdentity(data.file);
          if (!fileHash) { issues.add('invalid-file-identity'); continue; }
          fileSummaries.push({ fileHash, ...record });
        }
      } else {
        const record = caseRecord(event.type, data, occurrences);
        if (!record.fileHash || !record.nameHash || record.nesting === null || record.testNumber === null || record.type === 'unknown')
          issues.add('invalid-case-identity');
        cases.push(record);
      }
    }
    streamEnded = true;
  } catch { issues.add('event-stream-error'); }
  if (!summary) issues.add('summary-missing');
  if (finalSummaries > 1) issues.add('multiple-final-summaries');
  if (!process.versions.node.startsWith('22.')) issues.add('unsupported-node-major');
  const completed = streamEnded && finalSummaries === 1;
  let registeredTests = fileSummaries.reduce((sum, record) => sum + record.counts.tests, 0);
  if (!Number.isSafeInteger(registeredTests)) { registeredTests = null; issues.add('counts-overflow'); }
  if (!registeredTests) issues.add('zero-registered-tests');
  if (new Set(fileSummaries.map((record) => record.fileHash)).size !== fileSummaries.length) issues.add('duplicate-file-summary');
  if (summary) {
    if (!consistentCounts(summary.counts) || fileSummaries.some((record) => !consistentCounts(record.counts))) issues.add('counts-inconsistent');
    const observed = Object.fromEntries(COUNT_KEYS.map((key) => [key, 0]));
    for (const record of cases) {
      if (record.nesting === 0) observed.topLevel++;
      if (record.type === 'suite') observed.suites++;
      else if (record.type === 'test') { observed.tests++; observed[record.status]++; }
    }
    if (COUNT_KEYS.some((key) => observed[key] !== summary.counts[key])) issues.add('case-counts-inconsistent');
    const totals = Object.fromEntries(COUNT_KEYS.map((key) => [key, 0]));
    for (const record of fileSummaries) for (const key of COUNT_KEYS) totals[key] += record.counts[key];
    if (COUNT_KEYS.some((key) => totals[key] !== summary.counts[key])) issues.add('file-counts-inconsistent');
    const files = new Set(fileSummaries.map((record) => record.fileHash));
    if (cases.some((record) => !files.has(record.fileHash))) issues.add('case-file-summary-missing');
  }
  const failed = summary?.success === false || (summary && (summary.counts.failed > 0 || summary.counts.cancelled > 0)) ||
    cases.some((record) => ['failed', 'cancelled'].includes(record.status));
  const partial = !completed || issues.size > 0 || (summary && (summary.counts.skipped > 0 || summary.counts.todo > 0)) ||
    cases.some((record) => ['skipped', 'todo'].includes(record.status));
  const status = failed ? 'failed' : partial ? 'incomplete' : 'passed';
  return { format: NODE_TEST_REPORT_FORMAT, runner: { name: 'node:test', nodeVersion: process.versions.node }, completed, status,
    summary, registeredTests, cases, fileSummaries, issues: [...issues].sort() };
}

/** Official custom reporter API: Node owns execution, exit status and destination-file handling. */
export default async function* nodeTestReporter(source) {
  yield `${JSON.stringify(await collectNodeTestReport(source))}\n`;
}
