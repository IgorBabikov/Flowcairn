import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { parseNodeVerificationReport } from '../scripts/ai-graph/lib/node-verification-report.mjs';

function fixture(t, source) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'flowcairn-node-normalization-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, 'behavior.test.mjs'), source);
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', `--test-reporter=${path.resolve('scripts/ai-graph/lib/node-test-reporter.mjs')}`, '--test-reporter-destination=report.json', 'behavior.test.mjs'],
    { cwd: root, env, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined);
  return { exitCode: result.status, report: JSON.parse(readFileSync(path.join(root, 'report.json'), 'utf8')) };
}
const header = "import test from 'node:test'; import assert from 'node:assert/strict';\n";

test('actual Node assertion report is distinct from a runner or process error', (t) => {
  const { report, exitCode } = fixture(t, header + "test('observable behavior',()=>assert.equal(41,42));\n");
  assert.equal(exitCode, 1);
  const result = parseNodeVerificationReport(report, { requiredScenarios: ['observable behavior'] });
  assert.equal(result.status, 'failed');
  assert.equal(result.countsConfirmed, true);
  assert.equal(result.counts.failed, 1);
  assert.equal(result.assertionFailures, 1);
});

test('a real completed named scenario is accepted; a missing or ambiguous selector is not', (t) => {
  const { report, exitCode } = fixture(t, header + "test('observable behavior',()=>assert.equal(42,42));\n");
  assert.equal(exitCode, 0);
  assert.equal(parseNodeVerificationReport(report, { requiredScenarios: ['observable behavior'] }).status, 'passed');
  assert.equal(parseNodeVerificationReport(report, { requiredScenarios: ['unexecuted behavior'] }).status, 'unverified');
  const tampered = structuredClone(report); tampered.summary.counts.passed = 999;
  assert.equal(parseNodeVerificationReport(tampered).countsConfirmed, false);
  assert.equal(parseNodeVerificationReport(tampered).status, 'unverified');
  const contradictory = structuredClone(report); contradictory.fileSummaries[0].success = false;
  assert.equal(parseNodeVerificationReport(contradictory).status, 'unverified', 'a failed file summary cannot become overall PASS');
  const fractional = structuredClone(report); fractional.cases[0].testNumber = 1.5;
  assert.equal(parseNodeVerificationReport(fractional).status, 'unverified');
  const forgedIdentity = structuredClone(report); forgedIdentity.cases[0].id = 'a'.repeat(64);
  assert.equal(parseNodeVerificationReport(forgedIdentity).status, 'unverified');
});

test('zero registration, mandatory skips and arbitrary exceptions cannot become passed assertion evidence', (t) => {
  const zero = fixture(t, '').report;
  assert.equal(parseNodeVerificationReport(zero).status, 'unverified');
  const skipped = fixture(t, header + "test.skip('observable behavior',()=>{});\n").report;
  assert.equal(parseNodeVerificationReport(skipped, { requiredScenarios: ['observable behavior'] }).status, 'unverified');
  const thrown = fixture(t, header + "test('observable behavior',()=>{throw new Error('dependency unavailable');});\n").report;
  const normalized = parseNodeVerificationReport(thrown, { requiredScenarios: ['observable behavior'] });
  assert.equal(normalized.status, 'failed');
  assert.equal(normalized.assertionFailures, 0);
});
