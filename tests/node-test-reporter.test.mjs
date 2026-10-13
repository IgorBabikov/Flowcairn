import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const reporterPath = fileURLToPath(new URL('../scripts/ai-graph/lib/node-test-reporter.mjs', import.meta.url));
const digest = (value) => createHash('sha256').update(value).digest('hex');
const counts = (tests, passed, failed = 0, skipped = 0, cancelled = 0, todo = 0, suites = 0, topLevel = tests) =>
  ({ tests, suites, passed, failed, cancelled, skipped, todo, topLevel });

function fixture(t) {
  assert.match(process.versions.node, /^22\./, 'Acceptance fixtures must run using Node 22');
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-node-reporter-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, write: (file, source) => writeFileSync(path.join(root, file), source) };
}

function invoke(f, files = [], extra = []) {
  const output = path.join(f.root, 'report.json');
  const env = { ...process.env, PRIVATE_REPORTER_TOKEN: 'private-env-value' };
  // A nested --test process must not inherit the outer runner's child-v8 execution mode.
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  delete env.NODE_V8_COVERAGE;
  const args = ['--test', `--test-reporter=${reporterPath}`, `--test-reporter-destination=${output}`, ...extra, ...files];
  const execution = spawnSync(process.execPath, args, { cwd: f.root, env, encoding: 'utf8', timeout: 10000 });
  assert.equal(execution.error, undefined, 'Real Node test runner must complete within the fixture timeout');
  const raw = readFileSync(output, 'utf8');
  const report = JSON.parse(raw);
  assert.equal(report.format, 'flowcairn-node-test/v1');
  assert.equal(report.runner.name, 'node:test');
  assert.equal(report.runner.nodeVersion, process.versions.node);
  assert.equal(raw.trim().split('\n').length, 1, 'Exactly one JSON document is written');
  assert.equal(execution.stdout, '', 'The custom reporter does not forward stdout records');
  assert.equal(raw.includes(f.root), false);
  return { ...execution, report, raw };
}

test('real passing run records cases and one cumulative summary without leaking diagnostics', (t) => {
  const f = fixture(t);
  f.write('pass.test.mjs', `import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('private-case-title', t => { console.log('private-stdout'); console.error('private-stderr'); t.diagnostic('private-diagnostic'); assert.equal(1,1); });\ntest('second', () => assert.equal(2,2));\n`);
  const { status, report, raw } = invoke(f, ['pass.test.mjs']);
  assert.equal(status, 0); assert.equal(report.completed, true); assert.equal(report.status, 'passed');
  assert.deepEqual(report.summary, { success: true, counts: counts(2, 2) });
  assert.equal(report.registeredTests, 2); assert.equal(report.fileSummaries.length, 1); assert.equal(report.cases.length, 2);
  assert.deepEqual(report.issues, []);
  assert.equal(report.cases[0].nameHash, digest('private-case-title'));
  assert.equal(report.cases[0].fileHash, digest('pass.test.mjs'));
  for (const value of ['private-case-title', 'private-stdout', 'private-stderr', 'private-diagnostic', 'private-env-value']) assert.equal(raw.includes(value), false);
});

test('real assertion failure exposes only documented failure codes, never error payloads', (t) => {
  const f = fixture(t);
  f.write('failure.test.mjs', `import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('assertion', () => assert.equal('private-actual', 'private-expected', 'private-error-message'));\n`);
  const { status, report, raw } = invoke(f, ['failure.test.mjs']);
  assert.equal(status, 1); assert.equal(report.status, 'failed'); assert.equal(report.completed, true);
  assert.deepEqual(report.summary, { success: false, counts: counts(1, 0, 1) });
  assert.deepEqual(report.cases[0].failure, { kind: 'assertion', failureType: 'testCodeFailure', errorCode: 'ERR_TEST_FAILURE', causeCode: 'ERR_ASSERTION' });
  for (const value of ['private-actual', 'private-expected', 'private-error-message', 'stack', 'message', 'expected', 'actual']) assert.equal(raw.includes(value), false);
});

test('arbitrary exception metadata cannot become an assertion or leak secrets through error codes', (t) => {
  const f = fixture(t);
  f.write('throw.test.mjs', `import test from 'node:test';\ntest('unknown cause', () => { const error = new Error('private-secret'); error.code = 'PRIVATE_EXCEPTION_CODE'; error.env = process.env; throw error; });\n`);
  const { status, report, raw } = invoke(f, ['throw.test.mjs']);
  assert.equal(status, 1); assert.equal(report.status, 'failed'); assert.equal(report.cases[0].failure.kind, 'unknown');
  assert.equal(report.cases[0].failure.causeCode, null);
  for (const value of ['PRIVATE_EXCEPTION_CODE', 'private-secret', 'PRIVATE_REPORTER_TOKEN', 'private-env-value']) assert.equal(raw.includes(value), false);
});

test('isolated module-load failure stays failed with unknown cause and missing registered-test evidence', (t) => {
  const f = fixture(t); f.write('load.test.mjs', 'import "./private-missing-module.mjs";\n');
  const { status, report, raw } = invoke(f, ['load.test.mjs']);
  assert.equal(status, 1); assert.equal(report.status, 'failed'); assert.equal(report.registeredTests, 0);
  assert.equal(report.cases[0].failure.kind, 'unknown');
  assert.equal(raw.includes('private-missing-module'), false);
});

test('an empty test directory reports zero tests, never passed acceptance', (t) => {
  const f = fixture(t); const { status, report } = invoke(f);
  assert.equal(status, 0); assert.equal(report.completed, true); assert.equal(report.status, 'incomplete');
  assert.deepEqual(report.summary, { success: true, counts: counts(0, 0) });
  assert.equal(report.registeredTests, 0); assert.equal(report.cases.length, 0);
  assert.ok(report.issues.includes('zero-registered-tests'));
});

test('an empty test file passes the Node wrapper but cannot stand in for registered tests', (t) => {
  const f = fixture(t); f.write('empty.test.mjs', 'export const value = 1;\n');
  const { status, report } = invoke(f, ['empty.test.mjs']);
  assert.equal(status, 0); assert.equal(report.summary.success, true);
  assert.equal(report.summary.counts.tests, 1); assert.equal(report.summary.counts.passed, 1);
  assert.equal(report.fileSummaries.length, 0); assert.equal(report.registeredTests, 0);
  assert.equal(report.status, 'incomplete');
  assert.ok(report.issues.includes('case-file-summary-missing'));
});

test('skipped mandatory cases remain skipped even when the Node process exits zero', (t) => {
  const f = fixture(t);
  f.write('skip.test.mjs', `import test from 'node:test';\ntest('skipped case', {skip: 'private-skip-reason'}, () => { throw new Error('must never execute'); });\n`);
  const { status, report, raw } = invoke(f, ['skip.test.mjs']);
  assert.equal(status, 0); assert.equal(report.status, 'incomplete');
  assert.deepEqual(report.summary, { success: true, counts: counts(1, 0, 0, 1) });
  assert.equal(report.cases[0].event, 'test:pass'); assert.equal(report.cases[0].status, 'skipped');
  assert.equal(raw.includes('private-skip-reason'), false);
});

test('TODO failures remain TODO, not a passed mandatory scenario or a source defect', (t) => {
  const f = fixture(t);
  f.write('todo.test.mjs', `import test from 'node:test';\ntest('todo case', {todo: 'private-todo'}, () => { throw new Error('private-detail'); });\n`);
  const { status, report, raw } = invoke(f, ['todo.test.mjs']);
  assert.equal(status, 0); assert.equal(report.status, 'incomplete');
  assert.deepEqual(report.summary, { success: true, counts: counts(1, 0, 0, 0, 0, 1) });
  assert.equal(report.cases[0].event, 'test:fail'); assert.equal(report.cases[0].status, 'todo');
  assert.equal(raw.includes('private-todo'), false); assert.equal(raw.includes('private-detail'), false);
});

test('AbortSignal cancellation is a real failed invocation, with cancelled counts', (t) => {
  const f = fixture(t);
  f.write('abort.test.mjs', `import test from 'node:test';\ntest('aborted case', {signal: AbortSignal.abort(new Error('private-abort-reason'))}, () => {});\n`);
  const { status, report, raw } = invoke(f, ['abort.test.mjs']);
  assert.equal(status, 1); assert.equal(report.status, 'failed'); assert.equal(report.completed, true);
  assert.deepEqual(report.summary, { success: false, counts: counts(1, 0, 0, 0, 1) });
  assert.equal(report.cases[0].status, 'cancelled'); assert.equal(report.cases[0].failure.failureType, 'testAborted');
  assert.equal(report.cases[0].failure.kind, 'unknown'); assert.equal(raw.includes('private-abort-reason'), false);
});

test('unfinished subtest cancellation preserves parent failure and real summary totals', (t) => {
  const f = fixture(t);
  f.write('cancel.test.mjs', `import test from 'node:test';\ntest('parent', t => { t.test('child', () => new Promise(() => {})); });\n`);
  const { status, report } = invoke(f, ['cancel.test.mjs']);
  assert.equal(status, 1); assert.equal(report.status, 'failed');
  assert.deepEqual(report.summary, { success: false, counts: counts(2, 0, 1, 0, 1, 0, 0, 1) });
  assert.equal(report.cases[0].failure.failureType, 'cancelledByParent'); assert.equal(report.cases[0].status, 'cancelled');
  assert.equal(report.cases[1].failure.failureType, 'subtestsFailed'); assert.equal(report.cases[1].status, 'failed');
  assert.deepEqual(report.issues, []);
});

test('real timeout reports cancelled tests without inventing an assertion cause', (t) => {
  const f = fixture(t);
  f.write('timeout.test.mjs', `import { test, after } from 'node:test';\nconst alive = setInterval(() => {}, 1000);\nafter(() => clearInterval(alive));\ntest('timeout', {timeout: 25}, () => new Promise(() => {}));\n`);
  const { status, report } = invoke(f, ['timeout.test.mjs']);
  assert.equal(status, 1); assert.equal(report.status, 'failed'); assert.equal(report.completed, true);
  assert.deepEqual(report.summary, { success: false, counts: counts(1, 0, 0, 0, 1) });
  assert.equal(report.cases[0].status, 'cancelled'); assert.equal(report.cases[0].failure.failureType, 'testTimeoutFailure');
  assert.equal(report.cases[0].failure.kind, 'unknown'); assert.deepEqual(report.issues, []);
});

test('nested describe suites are records, not duplicated test counts', (t) => {
  const f = fixture(t);
  f.write('nested.test.mjs', `import { describe, it } from 'node:test';\nimport assert from 'node:assert/strict';\ndescribe('outer', () => { describe('inner', () => { it('pass', () => assert.equal(1,1)); it('fail', () => assert.equal(1,2)); }); });\n`);
  const { status, report } = invoke(f, ['nested.test.mjs']);
  assert.equal(status, 1); assert.deepEqual(report.summary, { success: false, counts: counts(2, 1, 1, 0, 0, 0, 2, 1) });
  assert.equal(report.cases.length, 4); assert.equal(report.cases.filter(record => record.type === 'test').length, 2);
  assert.equal(report.cases.filter(record => record.type === 'suite').length, 2);
  assert.equal(report.registeredTests, 2); assert.deepEqual(report.issues, []);
});

test('multiple file summaries are retained separately from the one cumulative summary', (t) => {
  const f = fixture(t);
  f.write('one.test.mjs', `import test from 'node:test';\ntest('first', () => {});\ntest('second', () => {});\n`);
  f.write('two.test.mjs', `import test from 'node:test';\ntest('third', () => {});\n`);
  const { status, report } = invoke(f, ['one.test.mjs', 'two.test.mjs']);
  assert.equal(status, 0); assert.equal(report.status, 'passed');
  assert.deepEqual(report.summary, { success: true, counts: counts(3, 3) });
  assert.equal(report.fileSummaries.length, 2); assert.equal(report.registeredTests, 3); assert.equal(report.cases.length, 3);
  assert.deepEqual(report.issues, []);
});

test('scenario IDs stay stable between isolated roots and disambiguate repeated helper cases', (t) => {
  const source = `import test from 'node:test';\nconst child = t => t.test('same title', () => {});\ntest('one', async t => { await child(t); });\ntest('two', async t => { await child(t); });\n`;
  const first = fixture(t), second = fixture(t); first.write('stable.test.mjs', source); second.write('stable.test.mjs', source);
  const a = invoke(first, ['stable.test.mjs']).report, b = invoke(second, ['stable.test.mjs']).report;
  assert.equal(a.status, 'passed'); assert.equal(b.status, 'passed');
  assert.deepEqual(a.cases, b.cases); assert.equal(new Set(a.cases.map(record => record.id)).size, a.cases.length);
  const children = a.cases.filter(record => record.nameHash === digest('same title'));
  assert.equal(children.length, 2); assert.deepEqual(children.map(record => record.occurrence), [1, 2]);
  for (const record of a.cases) {
    const { fileHash, nameHash, line, column, nesting, testNumber, type, occurrence } = record;
    assert.equal(record.id, digest(JSON.stringify({ fileHash, nameHash, line, column, nesting, testNumber, type, occurrence })));
  }
});

test('abrupt isolated test-process termination remains failed with unknown cause', (t) => {
  const f = fixture(t); f.write('terminated.test.mjs', 'process.exit(7);\n');
  const { status, report } = invoke(f, ['terminated.test.mjs']);
  assert.equal(status, 1); assert.equal(report.status, 'failed'); assert.equal(report.registeredTests, 0);
  assert.equal(report.cases[0].failure.kind, 'unknown');
  assert.ok(report.issues.includes('case-file-summary-missing'));
});
