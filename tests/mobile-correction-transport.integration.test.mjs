import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fixture, request } from '../scripts/ai-graph/test-support/provable-work.mjs';
import { hashObject, sha256 } from '../scripts/ai-graph/lib/io.mjs';
import { RUNNER_TESTING } from '../scripts/ai-graph/lib/runner.mjs';
import { validateSemanticCorrectionInput, validateSemanticCorrectionFeedback, projectSemanticCorrectionFeedback } from '../scripts/ai-graph/lib/semantic-correction-feedback.mjs';

async function setup(t, { alwaysBlocked = false, wrongEcho = false, large = true } = {}) {
  const f = await fixture(t), adapters = f.service.adapters, execute = adapters.execute;
  adapters.workflowPolicy = 'developer-v2';
  const anchor = '// preserved native-like oracle anchor ' + 'q'.repeat(3300);
  appendFileSync(path.join(f.worktree, 'src/answer.test.mjs'), anchor + '\n');
  const reviews = [], planners = [], correctionInputs = [], calls = [];
  let writes = 0; const apply = adapters.applyEdits;
  adapters.applyEdits = (...args) => { writes++; return apply(...args); };
  const originalUnknown = 'Original uncertainty must remain visible: ' + 'native environment note '.repeat(20);
  adapters.execute = async args => {
    calls.push({ action: args.node.action.id, planReview: Boolean(args.node.planReview) });
    if (!args.node.planReview) {
      if (args.node.action.id === 'ai-plan') planners.push({ plan: args.plan, priorEvidence: args.priorEvidence });
      if (args.reviewEvidence?.role === 'semantic-correction-input') {
        const bundle = validateSemanticCorrectionInput(args.reviewEvidence, args);
        const prepared = RUNNER_TESTING.makeAiCommand({ ...args, node: args.node, skills: [], reviewBundle: bundle,
          toolchain: { node: realpathSync(process.execPath), codexEntry: '/trusted/test-codex.js', digest: 'a'.repeat(64) },
          dependencyToolchain: { dependencyPaths: [], hash: 'a'.repeat(64) },
          profile: { workspaceMode: 'direct', outputPaths: ['reports'], ai: { provider: 'codex', model: 'fixture-model' } } });
        try {
          const complete = readFileSync(prepared.reviewFile.path, 'utf8');
          assert.equal(sha256(complete), args.priorEvidence.semanticCorrectionReference.hash);
          assert.ok(Buffer.byteLength(prepared.input) < 128 * 1024);
          assert.equal(prepared.input.includes(anchor), false);
          correctionInputs.push({ action: args.node.action.id, bytes: Buffer.byteLength(complete),
            input: JSON.parse(complete), hash: bundle.hash });
        } finally { RUNNER_TESTING.cleanupPrepared(prepared); }
      }
      const result = await execute(args);
      if (args.node.action.id === 'ai-analyze') {
        result.output.analysis.risks = [originalUnknown]; result.output.analysis.constraints = ['No same-node scenario retries.'];
      }
      if (args.reviewEvidence?.role === 'semantic-correction-input')
        result.output.reviewEvidenceHash = wrongEcho ? hashObject('wrong echo') : hashObject(args.reviewEvidence);
      return result;
    }
    await args.onStart({ ticket: 'semantic-correction-fixture', pid: process.pid });
    const input = args.reviewEvidence, attempt = reviews.push(input), blocked = alwaysBlocked || attempt === 1;
    const citation = { path: 'src/answer.test.mjs', startLine: 5, quote: 'assert.equal(answer(), 42);' };
    const copies = blocked && large ? Array.from({ length: 20 }, () => ({ path: 'src/answer.test.mjs', startLine: 7, quote: anchor })) : [citation];
    const output = { summary: 'Evaluate fresh candidate without source effects', verdict: blocked ? 'fail' : 'pass',
      skillsUsed: args.node.skills, findings: blocked ? [{ severity: 'blocking', message: 'Retain exact original criterion and resolve native verification plan.', path: citation.path }] : [],
      changedFiles: [], edits: [], moves: [], jsonTransfers: [], plan: [], inputHash: hashObject(input), reviewEvidenceHash: hashObject(input),
      requirementAssessments: input.taskContract.requirements.map(item => ({ requirementId: item.id, criterion: item.verification.criterion,
        workIds: item.workIds, checkIds: item.verification.checkIds, verdict: blocked ? 'uncertain' : 'pass',
        reason: 'Original criterion remains intact', citations: copies, planReferences: [] })),
      unknownAssessments: input.taskContract.unknowns.map(unknown => ({ unknown,
        disposition: blocked ? 'unresolved-material' : 'nonblocking-risk', reason: 'Original risk has an explicit disposition', citations: copies, planReferences: [] })),
      dimensions: Object.fromEntries(['verifier','source','interfaces','unknowns','capabilities'].map(id => [id,
        { status: blocked && id === 'verifier' ? 'fail' : blocked && id === 'unknowns' ? 'uncertain' : 'pass', reason: 'Original plan boundary' }])) };
    return { exitCode: 0, stopped: true, uncertain: false, output };
  };
  let s = await f.service.create({ id: 'MOBILE-CORRECTION', goal: 'Функция answer возвращает 42', instructions: 'Функция answer возвращает 42',
    acceptance: ['Функция answer возвращает 42'], scope: ['src'], checks: ['tests'] },
  { runId: 'mobile-correction-fixture', operationId: 'create-correction', stage: 'planning', workflow: 'autonomous' });
  s = await f.service.command(s.runId, 'run', request(s));
  s = await f.service.command(s.runId, 'replan', request(s));
  s = await f.service.command(s.runId, 'run', request(s));
  s = await f.settle(s);
  return { f, snapshot: s, calls, reviews, planners, correctionInputs, writes: () => writes, originalUnknown };
}

test('large blocked feedback reaches a fresh readonly planner whole, then fresh review and approval with zero writes', async t => {
  const c = await setup(t), s = c.snapshot;
  assert.equal(s.status, 'waiting-for-human', JSON.stringify(s.nodes.map(n => ({ id: n.id, reason: n.reason }))));
  assert.equal(c.writes(), 0); assert.equal(c.reviews.length, 2); assert.equal(c.planners.length, 2);
  assert.equal(c.f.service.store.readRun(s.runId).planCorrectionCycles, 1);
  const feedback = c.correctionInputs.find(input => input.action === 'ai-plan');
  assert.ok(feedback.bytes > 24 * 1024); assert.equal(feedback.input.feedback[0].requirementAssessments[0].citations.length, 20);
  assert.equal(feedback.input.feedback[0].unknownAssessments[0].citations.length, 20);
  assert.equal(feedback.input.feedback[0].unknownAssessments[0].unknown, c.originalUnknown);
  assert.deepEqual(c.reviews[1].taskContract.requirements.map(r => r.verification.criterion), c.reviews[0].taskContract.requirements.map(r => r.verification.criterion));
  assert.deepEqual(c.reviews[1].taskContract.constraints, c.reviews[0].taskContract.constraints);
  assert.deepEqual(c.reviews[1].taskContract.unknowns, c.reviews[0].taskContract.unknowns);
  assert.ok(c.reviews.every(input => input.plan.nodes.filter(n => n.action.id.startsWith('check-')).every(n => n.retry.maxAttempts === 1)));
  assert.equal(c.calls.some(call => call.action === 'ai-implement'), false); assert.notEqual(s.proof.status, 'PROVEN');
  const state = c.f.service.store.readRun(s.runId);
  const retained = state.planningArtifacts.map(id => JSON.parse(c.f.service.artifact(s.runId, id).content)).filter(data => data.reviewFindings);
  const records = retained.flatMap(data => data.reviewFindings);
  assert.ok(records.every(record => record.role === 'semantic-plan-correction-feedback'));
  assert.ok(records.every(record => !Object.hasOwn(record, 'content')));
  const correctiveRun = c.f.service.store.listRunIds().map(id => c.f.service.store.readRun(id))
    .find(run => run.planHash === feedback.input.planHash);
  const receipt = c.f.service.store.readObject('receipts', correctiveRun.nodes['plan-task'].receipts.at(-1));
  assert.equal(receipt.reviewEvidenceHash, feedback.hash);
  const complete = receipt.artifacts.map(id => JSON.parse(c.f.service.artifact(correctiveRun.runId, id).content))
    .find(data => data.role === 'semantic-correction-input');
  assert.deepEqual(complete, feedback.input); assert.equal(hashObject(complete), receipt.reviewEvidenceHash);
  await c.f.restart(); assert.equal(c.f.service.store.readRun(s.runId).planCorrectionCycles, 1);
});

test('canonical feedback cannot be transplanted to another source task, plan, receipt or candidate', async t => {
  const c = await setup(t, { large: false }), s = c.snapshot, state = c.f.service.store.readRun(s.runId);
  const record = state.planningArtifacts.map(id => JSON.parse(c.f.service.artifact(s.runId, id).content))
    .flatMap(data => data.reviewFindings ?? []).find(data => data.role === 'semantic-plan-correction-feedback');
  const access = { readArtifact: id => c.f.service.artifact(s.runId, id),
    readReceipt: id => c.f.service.store.readObject('receipts', id), readPlan: id => c.f.service.store.readObject('plans', id),
    currentPlan: c.f.service.store.readObject('plans', state.planHash) };
  validateSemanticCorrectionFeedback(record, access);
  for (const key of ['sourceTaskHash', 'sourcePlanHash', 'inputHash', 'artifactValueHash']) {
    const wrong = { ...record, [key]: hashObject('unrelated source identity') };
    assert.throws(() => validateSemanticCorrectionFeedback(wrong, access), { code: 'PLAN_REVIEW_FEEDBACK_INVALID' });
  }
  const swappedReceipt = { ...record, receiptId: state.nodes['plan-review'].receipts.at(-1) };
  assert.throws(() => validateSemanticCorrectionFeedback(swappedReceipt, access), { code: 'PLAN_REVIEW_FEEDBACK_INVALID' });
  const canonical = JSON.parse(access.readArtifact(record.artifactId).content);
  canonical.inputHash = canonical.reviewEvidenceHash = hashObject('another task candidate');
  const foreignId = hashObject(canonical), foreignArtifact = { kind: 'analysis', mediaType: 'application/json', content: JSON.stringify(canonical) };
  const transplanted = projectSemanticCorrectionFeedback({ ...record, artifactId: foreignId, artifact: foreignArtifact });
  assert.throws(() => validateSemanticCorrectionFeedback(transplanted, { ...access,
    readArtifact: id => id === foreignId ? foreignArtifact : access.readArtifact(id) }), { code: 'PLAN_REVIEW_FEEDBACK_INVALID' });
  assert.throws(() => validateSemanticCorrectionFeedback(record, { ...access,
    currentPlan: { ...access.currentPlan, parentPlanHash: null } }), { code: 'PLAN_REVIEW_FEEDBACK_INVALID' });
  assert.throws(() => validateSemanticCorrectionFeedback({ ...record, sourceRunId: 'unrelated-source-run' }, access),
    { code: 'PLAN_REVIEW_FEEDBACK_INVALID' });
  assert.equal(c.writes(), 0); assert.equal(c.calls.some(call => call.action === 'ai-implement'), false);
});

test('large feedback with a forged provider echo cannot authorize or execute implementation', async t => {
  const c = await setup(t, { wrongEcho: true });
  assert.equal(c.snapshot.status, 'failed'); assert.equal(c.writes(), 0);
  assert.ok(c.snapshot.nodes.some(n => n.reason?.startsWith('PLAN_REVIEW_FEEDBACK_INVALID')));
  assert.equal(c.calls.some(call => call.action === 'ai-implement'), false); assert.notEqual(c.snapshot.proof.status, 'PROVEN');
});

test('two durable large-feedback corrections remain bounded across restart with no source effects', async t => {
  const c = await setup(t, { alwaysBlocked: true });
  assert.equal(c.snapshot.status, 'failed'); assert.equal(c.reviews.length, 3); assert.equal(c.planners.length, 3);
  assert.equal(c.f.service.store.readRun(c.snapshot.runId).planCorrectionCycles, 2); assert.equal(c.writes(), 0);
  assert.equal(c.calls.some(call => call.action === 'ai-implement'), false);
  await c.f.restart(); assert.equal(c.f.service.store.readRun(c.snapshot.runId).planCorrectionCycles, 2);
});

test('small typed findings stay inline without private transport or digest/resolution bodies', async t => {
  const c = await setup(t, { large: false });
  assert.equal(c.snapshot.status, 'waiting-for-human'); assert.equal(c.correctionInputs.length, 0);
  const records = c.planners[1].priorEvidence.reviewFindings;
  assert.equal(records.length, 1); assert.equal(records[0].role, 'semantic-plan-correction-feedback');
  assert.equal(records[0].findings.length, 1); assert.equal(records[0].dimensions.verifier.status, 'fail');
  assert.equal(records[0].requirementAssessments[0].criterion, c.reviews[0].taskContract.requirements[0].verification.criterion);
  assert.equal(c.writes(), 0);
});
