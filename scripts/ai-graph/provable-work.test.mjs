import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fixture, request, identity } from './test-support/provable-work.mjs';

test('real check → requirement evidence → PROVEN → live source change → stale, including restart', async (t) => {
  const f = await fixture(t);
  let result = await f.run();
  assert.equal(result.proof.status, 'PROVEN', JSON.stringify(result.proof.blockers));
  assert.deepEqual(result.proof.coverage, { required: 1, proven: 1 });
  assert.equal(f.checks(), 1);
  assert.deepEqual(f.checkExitCodes(), [0]);
  const certificate = result.proof.certificate;
  await f.restart();
  result = f.service.snapshot(result.runId);
  assert.deepEqual(result.proof.certificate, certificate);
  writeFileSync(path.join(f.worktree, 'src/answer.mjs'), 'export const answer = () => 13;\n');
  result = f.service.snapshot(result.runId);
  assert.equal(result.proof.status, 'STALE');
  assert.equal(result.proof.certificate, null);
  assert.equal(result.proof.coverage.proven, 0);
  assert.ok(result.proof.evidence.every((item) => item.freshness === 'stale'));
});

test('real failing check produces a finding, bounded repair runs it again and resolves with new evidence', async (t) => {
  const f = await fixture(t, { repair: true });
  const result = await f.run();
  assert.equal(result.proof.status, 'PROVEN', JSON.stringify(result.proof.blockers));
  assert.equal(f.checks(), 2);
  assert.deepEqual(f.checkExitCodes(), [1, 0]);
  assert.ok(result.proof.findings.some((item) => item.blocking && item.status === 'resolved'));
  assert.ok(result.proof.evidence.some((item) => item.status === 'failed' && item.freshness === 'stale'));
  assert.equal(f.service.store.readRun(result.runId).policyGrant.cycle, 1);
});

test('generic review pass and actual passing tests cannot prove missing requirement coverage', async (t) => {
  const f = await fixture(t, { missingAssessment: true });
  const result = await f.run();
  assert.equal(result.status, 'failed');
  assert.notEqual(result.proof.status, 'PROVEN');
  assert.equal(result.proof.certificate, null);
});

test('failed requirement assessment overrides overall pass and enters bounded repair', async (t) => {
  const f = await fixture(t, { reviewFailures: 1 });
  const result = await f.run();
  assert.equal(result.proof.status, 'PROVEN', JSON.stringify(result.proof.blockers));
  assert.equal(f.checks(), 2);
  assert.equal(f.service.store.readRun(result.runId).policyGrant.cycle, 1);
  assert.ok(result.proof.findings.some((item) => item.blocking && item.status === 'resolved'));
});

test('fabricated source citation is rejected at the real execution boundary', async (t) => {
  const f = await fixture(t, { badCitation: true });
  const result = await f.run();
  assert.notEqual(result.proof.status, 'PROVEN');
  assert.equal(result.nodes.find((item) => item.action.id === 'ai-review').status, 'failed');
  assert.match(result.nodes.find((item) => item.action.id === 'ai-review').reason, /REQUIREMENT_EVIDENCE_INVALID/);
});

test('human acceptance is explicit, state-bound, idempotent and durable', async (t) => {
  const f = await fixture(t, { method: 'human' });
  let result = await f.run();
  assert.notEqual(result.proof.status, 'PROVEN');
  assert.equal(result.proof.acceptance.allowed, true);
  const body = request(result, { requirementId: 'req-001', resultHash: result.proof.resultHash, reason: 'Я запустил функцию и наблюдал 42', decision: 'accept', challenge: result.proof.acceptance.challenge });
  await assert.rejects(f.service.command(result.runId, 'verify-requirement', { ...body, resultHash: identity }), (error) => error.code === 'REQUIREMENT_RESULT_CHANGED');
  result = await f.service.command(result.runId, 'verify-requirement', body);
  assert.equal(result.proof.status, 'PROVEN', JSON.stringify(result.proof.blockers));
  const again = await f.service.command(result.runId, 'verify-requirement', body);
  assert.deepEqual(again.proof.certificate, result.proof.certificate);
  await f.restart();
  assert.deepEqual(f.service.snapshot(result.runId).proof.certificate, result.proof.certificate);
});
