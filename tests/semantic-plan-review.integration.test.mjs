import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, request } from '../scripts/ai-graph/test-support/provable-work.mjs';
import { hashObject } from '../scripts/ai-graph/lib/io.mjs';
import { TaskSpecSchema } from '../scripts/ai-graph/lib/schemas.mjs';
import { compileTaskProposal } from '../scripts/ai-graph/lib/planning.mjs';

async function setup(t, { repair = false, reviewMutation = null, analysisRisk = null } = {}) {
  const f = await fixture(t, { repair });
  const adapters = f.service.adapters, execute = adapters.execute;
  adapters.workflowPolicy = 'developer-v2';
  const reviews = [], calls = [];
  let writes = 0; const apply = adapters.applyEdits;
  adapters.applyEdits = (...args) => { writes++; return apply(...args); };
  adapters.execute = async (args) => {
    calls.push({ action: args.node.action.id, planReview: Boolean(args.node.planReview) });
    if (!args.node.planReview) {
      const result = await execute(args);
      if (analysisRisk && args.node.action.id === 'ai-analyze') result.output.analysis.risks.push(analysisRisk);
      return result;
    }
    await args.onStart({ ticket: 'semantic-fixture', pid: process.pid });
    const input = args.reviewEvidence;
    reviews.push(input);
    const citation = { path: 'src/answer.test.mjs', startLine: 5, quote: 'assert.equal(answer(), 42);' };
    const output = { summary: 'Точный план проверен, реализация еще не принята.', verdict: 'pass', skillsUsed: args.node.skills,
      findings: [], changedFiles: [], edits: [], moves: [], jsonTransfers: [], plan: [],
      inputHash: hashObject(input), reviewEvidenceHash: hashObject(input),
      requirementAssessments: input.taskContract.requirements.map((item) => ({ requirementId: item.id,
        criterion: item.verification.criterion, workIds: item.workIds, checkIds: item.verification.checkIds,
        verdict: 'pass', citations: [citation], planReferences: [], reason: 'Oracle соответствует исходному критерию.' })),
      unknownAssessments: input.taskContract.unknowns.map(unknown => ({ unknown, disposition: 'nonblocking-risk',
        reason: 'Сохранена проверка настоящего сценария.', citations: [citation], planReferences: [] })),
      dimensions: Object.fromEntries(['verifier', 'source', 'interfaces', 'unknowns', 'capabilities']
        .map(id => [id, { status: 'pass', reason: 'Проверена соответствующая граница плана.' }])) };
    if (reviewMutation) reviewMutation(output, reviews.length, args);
    return { exitCode: 0, stopped: true, uncertain: false, output };
  };
  const prepare = async () => {
    let s = await f.service.create({ id: 'TASK-SEMANTIC', goal: 'Функция answer возвращает 42', instructions: 'Функция answer возвращает 42',
      acceptance: ['Функция answer возвращает 42'], scope: ['src'], checks: ['tests'] },
    { runId: 'semantic-fixture', operationId: 'create-semantic', stage: 'planning', workflow: 'autonomous' });
    s = await f.service.command(s.runId, 'run', request(s));
    s = await f.service.command(s.runId, 'replan', request(s));
    s = await f.service.command(s.runId, 'run', request(s));
    return f.settle(s);
  };
  const approve = s => {
    const gate = s.gates.find(item => item.type === 'approve-plan');
    return f.service.command(s.runId, 'gate', request(s, { nodeId: gate.nodeId, decision: 'approve',
      permissions: gate.requiredPermissions, challenge: gate.challenge }));
  };
  return { f, prepare, approve, reviews, calls, writes: () => writes };
}

test('developer-v2 runs an independent readonly assessment before approval and source effects', async t => {
  const c = await setup(t, { analysisRisk: 'Риск задержки API' });
  const s = await c.prepare();
  assert.equal(s.status, 'waiting-for-human', JSON.stringify(s.nodes.map(n => ({ id: n.id, reason: n.reason }))));
  assert.equal(c.writes(), 0);
  assert.equal(c.reviews.length, 1);
  assert.equal(c.reviews[0].proposal.steps.length, 1);
  assert.ok(c.reviews[0].planningArtifactHash);
  assert.ok(c.reviews[0].plan.nodes.some(node => node.planReview));
  assert.deepEqual(c.calls.map(c => [c.action, c.planReview]), [['ai-analyze', false], ['ai-plan', false], ['ai-analyze', true]]);
  assert.notEqual(s.proof.status, 'PROVEN');
  await c.f.restart();
  const result = await c.f.settle(await c.approve(c.f.service.snapshot(s.runId)));
  assert.equal(result.status, 'passed');
  assert.equal(result.proof.status, 'PROVEN');
  assert.equal(c.reviews.length, 1);
});

test('a bounded assertion repair obtains a fresh review of its changed source and candidate', async t => {
  const c = await setup(t, { repair: true });
  const approved = await c.prepare();
  const result = await c.f.settle(await c.approve(approved));
  assert.equal(result.status, 'passed', JSON.stringify({ failure: result.failureReason, nodes: result.nodes.map(n => ({ id: n.id, reason: n.reason })) }));
  assert.equal(result.proof.status, 'PROVEN');
  assert.equal(c.reviews.length, 2);
  assert.notEqual(c.reviews[0].planHash, c.reviews[1].planHash);
  assert.notEqual(c.reviews[0].sourceHash, c.reviews[1].sourceHash);
  assert.equal(c.f.service.store.readRun(result.runId).policyGrant.cycle, 1);
  assert.equal(c.f.service.store.readRun(result.runId).policyGrant.runId, approved.runId);
});

for (const [name, mutate] of [
  ['forged input', output => { output.inputHash = hashObject('forged'); }],
  ['weakened criterion', output => { output.requirementAssessments[0].criterion = 'Файл существует'; }],
  ['fabricated quote', output => { output.requirementAssessments[0].citations[0].quote = 'assert.equal(answer(), 999);'; }],
  ['unresolved material choice', output => { output.verdict = 'uncertain'; output.dimensions.unknowns.status = 'uncertain'; }],
]) test(`${name} cannot authorize or write source`, async t => {
  const c = await setup(t, { reviewMutation: mutate });
  const result = await c.prepare();
  assert.notEqual(result.status, 'waiting-for-human');
  assert.notEqual(result.status, 'passed');
  assert.equal(c.writes(), 0);
  assert.equal(c.calls.some(call => call.action === 'ai-implement'), false);
  assert.notEqual(result.proof.status, 'PROVEN');
  assert.ok(result.nodes.some(node => node.reason?.startsWith(name === 'unresolved material choice' ? 'PLAN_REVIEW_UNCERTAIN' : 'PLAN_REVIEW_INVALID')),
    JSON.stringify(result.nodes.map(node => ({ id: node.id, reason: node.reason }))));
});

test('direct draft cannot drop the mandatory review and restore a zero-dependency approval', async t => {
  const c = await setup(t), adapters = c.f.service.adapters;
  const input = { id: 'DIRECT-SEMANTIC', goal: 'Функция answer возвращает 42', instructions: 'Функция answer возвращает 42',
    acceptance: ['Функция answer возвращает 42'], scope: ['src'], checks: ['tests'] };
  const task = TaskSpecSchema.parse({ ...input, schemaVersion: 2, sourceHash: c.f.fingerprint().hash });
  const plan = compileTaskProposal(task, { summary: 'План', verdict: 'pass', skillsUsed: [], findings: [], changedFiles: [], edits: [], plan: [],
    steps: [{ id: 'one', title: 'answer', outcome: task.goal, needs: [], paths: ['src/answer.mjs'] }] },
  { runtimeHash: adapters.identity(), skills: adapters.skills(task), workflow: 'autonomous', workflowPolicy: 'developer-v2', checks: adapters.checkRegistry() }).plan;
  const draft = { nodes: structuredClone(plan.nodes).filter(node => !node.planReview) };
  draft.nodes.find(node => node.action.id === 'human-approve').needs = [];
  await assert.rejects(c.f.service.create(input, { draft, workflow: 'autonomous', stage: 'execution' }), { code: 'PLAN_REVIEW_INVALID' });
  assert.equal(c.calls.length, 0); assert.equal(c.writes(), 0);
});

test('a swapped otherwise valid review receipt cannot issue source authorization', async t => {
  const c = await setup(t), s = await c.prepare();
  const state = c.f.service.store.readRun(s.runId), node = state.nodes['plan-review'];
  const receipt = c.f.service.store.readObject('receipts', node.receipts.at(-1));
  const forged = c.f.service.store.putObject('receipts', { ...receipt, reviewEvidenceHash: hashObject('foreign review') });
  const changed = c.f.service.store.updateRun(s.runId, state.revision, current => ({ ...current,
    nodes: { ...current.nodes, 'plan-review': { ...current.nodes['plan-review'], receipts: [...node.receipts.slice(0, -1), forged] } } }));
  const snapshot = c.f.service.snapshot(s.runId);
  assert.equal(snapshot.integrity.valid, true);
  assert.equal(snapshot.revision, changed.revision);
  await assert.rejects(c.approve(snapshot), { code: 'PLAN_REVIEW_INVALID' });
  assert.equal(c.writes(), 0);
});

test('review receipt is revalidated before implementation after approval without another AI call', async t => {
  const c = await setup(t), s = await c.prepare(), adapters = c.f.service.adapters;
  adapters.runner.ai.available = false;
  let approved = await c.approve(s);
  await Promise.all([...c.f.service.drives.values()]);
  approved = c.f.service.snapshot(approved.runId);
  assert.equal(c.writes(), 0);
  const state = c.f.service.store.readRun(approved.runId), node = state.nodes['plan-review'];
  const receipt = c.f.service.store.readObject('receipts', node.receipts.at(-1));
  const stale = c.f.service.store.putObject('receipts', { ...receipt, reviewEvidenceHash: hashObject('stale candidate') });
  c.f.service.store.updateRun(approved.runId, state.revision, current => ({ ...current,
    nodes: { ...current.nodes, 'plan-review': { ...current.nodes['plan-review'], receipts: [...node.receipts.slice(0, -1), stale] } } }));
  adapters.runner.ai.available = true;
  let current = c.f.service.snapshot(approved.runId);
  assert.equal(current.integrity.valid, true);
  current = await c.f.service.command(current.runId, 'run', request(current));
  current = await c.f.settle(current);
  assert.equal(c.writes(), 0);
  assert.equal(c.reviews.length, 1);
  assert.equal(c.calls.some(call => call.action === 'ai-implement'), false);
  assert.ok(current.nodes.some(node => node.reason?.startsWith('PLAN_REVIEW_INVALID')));
  assert.notEqual(current.proof.status, 'PROVEN');
});

test('a blocked preapproval plan is corrected once with original criteria and full findings', async t => {
  const c = await setup(t, { reviewMutation: (output, attempt) => {
    if (attempt === 1) { output.verdict = 'fail'; output.dimensions.interfaces.status = 'fail';
      output.findings = [{ severity: 'blocking', message: 'Нужна точная связь observable oracle и outcome.', path: 'src/answer.test.mjs' }]; }
  } });
  const s = await c.prepare();
  assert.equal(s.status, 'waiting-for-human', JSON.stringify({ failure: s.failureReason, nodes: s.nodes.map(n => ({ id: n.id, reason: n.reason })) }));
  assert.equal(c.reviews.length, 2);
  assert.equal(c.writes(), 0);
  assert.equal(c.f.service.store.readRun(s.runId).planCorrectionCycles, 1);
  assert.deepEqual(c.reviews[1].taskContract.requirements.map(r => r.verification.criterion),
    c.reviews[0].taskContract.requirements.map(r => r.verification.criterion));
  assert.deepEqual(c.reviews[1].taskContract.constraints, c.reviews[0].taskContract.constraints);
  assert.equal(c.calls.filter(c => c.action === 'ai-plan').length, 2);
});

test('preapproval blocking review stops after two durable corrections without source effects', async t => {
  const c = await setup(t, { reviewMutation: output => { output.verdict = 'fail'; output.dimensions.interfaces.status = 'fail'; } });
  const s = await c.prepare();
  assert.equal(s.status, 'failed'); assert.equal(c.reviews.length, 3);
  assert.equal(c.f.service.store.readRun(s.runId).planCorrectionCycles, 2);
  assert.equal(c.calls.filter(c => c.action === 'ai-plan').length, 3);
  assert.equal(c.writes(), 0);
  await c.f.restart();
  assert.equal(c.f.service.store.readRun(s.runId).planCorrectionCycles, 2);
});

test('a blocked already granted repair is held for explicit replan without changing authorization', async t => {
  const c = await setup(t, { repair: true, reviewMutation: (output, attempt) => {
    if (attempt === 2) { output.verdict = 'fail'; output.dimensions.verifier.status = 'fail'; }
  } });
  const approved = await c.prepare();
  const s = await c.f.settle(await c.approve(approved));
  assert.equal(s.status, 'failed'); assert.equal(c.reviews.length, 2); assert.equal(c.writes(), 1);
  const state = c.f.service.store.readRun(s.runId);
  assert.equal(state.policyGrant.cycle, 1); assert.equal(state.policyGrant.runId, approved.runId);
  assert.equal(state.nodes['approve-plan'].status, 'pending');
  assert.equal(s.capabilities.requestReplan.allowed, true);
  assert.equal(s.proof.status === 'PROVEN', false);
});

test('host anchor relocation retains original digest and a separate canonical resolution artifact', async t => {
  let reported;
  const c = await setup(t, { reviewMutation: output => {
    output.requirementAssessments[0].citations[0].startLine = 999;
    reported = structuredClone(output);
  } });
  const s = await c.prepare();
  assert.equal(s.status, 'waiting-for-human'); assert.equal(c.writes(), 0);
  const state = c.f.service.store.readRun(s.runId), receipt = c.f.service.store.readObject('receipts', state.nodes['plan-review'].receipts.at(-1));
  const data = receipt.artifacts.map(id => JSON.parse(c.f.service.artifact(s.runId, id).content));
  const canonical = data.find(item => item.requirementAssessments), resolution = data.find(item => item.role === 'plan-citation-resolution');
  const digest = data.find(item => item.role === 'plan-review-output-digest');
  assert.equal(digest.reportedOutputHash, hashObject(reported));
  assert.equal(resolution.reportedOutputHash, digest.reportedOutputHash);
  assert.equal(resolution.verifiedOutputHash, hashObject(canonical));
  assert.equal(canonical.requirementAssessments[0].citations[0].startLine, 5);
  assert.equal(resolution.entries[0].reportedStartLine, 999);
  assert.equal(resolution.entries[0].verifiedStartLine, 5);
  assert.equal(resolution.entries[0].method, 'unique-anchor');
  const result = await c.f.settle(await c.approve(s));
  assert.equal(result.proof.status, 'PROVEN');
});

test('summary and findings sanitization keeps raw digest separate while canonical gate hashes agree', async t => {
  let rawHash;
  const c = await setup(t, { reviewMutation: (output, _attempt, args) => {
    output.summary = `План проверен в ${args.worktree}; password=example-only-placeholder`;
    output.findings = [{ severity: 'info', message: `Контекст ${args.worktree}; secret=example-only-placeholder`, path: null }];
    rawHash = hashObject(output);
  } });
  const s = await c.prepare();
  assert.equal(s.status, 'waiting-for-human');
  const state = c.f.service.store.readRun(s.runId), receipt = c.f.service.store.readObject('receipts', state.nodes['plan-review'].receipts.at(-1));
  const data = receipt.artifacts.map(id => JSON.parse(c.f.service.artifact(s.runId, id).content));
  const canonical = data.find(item => item.requirementAssessments), resolution = data.find(item => item.role === 'plan-citation-resolution');
  assert.equal(resolution.reportedOutputHash, rawHash);
  assert.notEqual(resolution.verifiedOutputHash, rawHash);
  assert.equal(resolution.verifiedOutputHash, hashObject(canonical));
  assert.match(canonical.summary, /\[host-path\]/); assert.match(canonical.summary, /\[redacted\]/);
  assert.match(canonical.findings[0].message, /\[redacted\]/);
  const result = await c.f.settle(await c.approve(s));
  assert.equal(result.proof.status, 'PROVEN');
});

test('known verifier references can ground every original risk without a fictitious file creation', async t => {
  const c = await setup(t, { analysisRisk: 'Риск конкурентного запроса', reviewMutation: output => {
    for (const assessment of output.unknownAssessments) {
      assessment.citations = [];
      assessment.planReferences = [{ workId: output.requirementAssessments[0].workIds[0],
        checkIds: output.requirementAssessments[0].checkIds, creationPaths: [] }];
    }
  } });
  const s = await c.prepare();
  assert.equal(s.status, 'waiting-for-human'); assert.equal(c.writes(), 0);
  const result = await c.f.settle(await c.approve(s));
  assert.equal(result.proof.status, 'PROVEN');
});

test('an after-approval swapped resolution source identity blocks source effects', async t => {
  const c = await setup(t), s = await c.prepare(), adapters = c.f.service.adapters;
  adapters.runner.ai.available = false;
  let approved = await c.approve(s); await Promise.all([...c.f.service.drives.values()]);
  approved = c.f.service.snapshot(approved.runId);
  const state = c.f.service.store.readRun(approved.runId), node = state.nodes['plan-review'];
  const receipt = c.f.service.store.readObject('receipts', node.receipts.at(-1));
  const resolutionId = receipt.artifacts.find(id => JSON.parse(c.f.service.artifact(approved.runId, id).content).role === 'plan-citation-resolution');
  const artifact = c.f.service.store.readObject('artifacts', resolutionId), data = JSON.parse(artifact.parts.join(''));
  data.entries[0].sourceHash = hashObject('another source');
  const forgedArtifact = c.f.service.store.putObject('artifacts', { ...artifact, parts: [JSON.stringify(data)] });
  const forgedReceipt = c.f.service.store.putObject('receipts', { ...receipt,
    artifacts: receipt.artifacts.map(id => id === resolutionId ? forgedArtifact : id) });
  c.f.service.store.updateRun(approved.runId, state.revision, current => ({ ...current, nodes: { ...current.nodes,
    'plan-review': { ...node, receipts: [...node.receipts.slice(0, -1), forgedReceipt], artifacts: node.artifacts.map(id => id === resolutionId ? forgedArtifact : id) } } }));
  adapters.runner.ai.available = true;
  const current = c.f.service.snapshot(approved.runId);
  assert.equal(current.integrity.valid, true);
  await c.f.settle(await c.f.service.command(current.runId, 'run', request(current)));
  assert.equal(c.writes(), 0); assert.equal(c.calls.some(call => call.action === 'ai-implement'), false);
  assert.notEqual(c.f.service.snapshot(approved.runId).proof.status, 'PROVEN');
});
