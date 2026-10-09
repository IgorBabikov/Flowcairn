import test from 'node:test';
import assert from 'node:assert/strict';
import { hashObject } from './lib/io.mjs';
import { deriveTaskProof } from './lib/task-proof.mjs';

function fixture({ runId = 'run-staged-proof', version = 1, method = 'check', sameResult = false,
  finalCheck = true, finalReview = true, omittedAssessment = null, reviewFindings = [], schemaVersion = 3 } = {}) {
  const objects = new Map(), initialHash = hashObject('initial'), intermediateHash = hashObject(sameResult ? 'final' : 'intermediate');
  const currentFingerprint = { hash: hashObject('final') };
  const requirements = [1, 2].map((index) => ({ id: `req-${index}`, title: `Требование ${index}`, mandatory: true,
    origin: 'acceptance', workIds: [`step-${index}`], verification: { method, checkIds: method === 'check' ? ['check-tests'] : [],
      criterion: `Результат ${index} проверен`, paths: ['src'] } }));
  const contract = { version: 1, goal: 'Проверенный итог двух этапов', instructionsHash: hashObject('instructions'), requirements,
    optionalImprovements: [], constraints: [], assumptions: [], unknowns: [], scope: ['src'], forbiddenPaths: [], rigor: { level: 'standard', reasons: [] } };
  const definition = (id, actionId) => ({ id, action: { id: actionId, version: 1 } });
  const task = { schemaVersion, id: 'TASK-STAGE-PROOF', goal: contract.goal, instructions: 'instructions', checks: ['tests'] };
  const plan = { schemaVersion, version, stage: 'execution', taskContract: contract,
    nodes: [definition('step-1', 'ai-implement'), definition('s01-workspace-check', 'workspace-check'), definition('s01-check-tests', 'check-tests'),
      definition('step-2', 'ai-implement'), definition('workspace-check', 'workspace-check'), definition('tests', 'check-tests'),
      definition('review', 'ai-review'), definition('handoff', 'artifact-handoff')],
    ...(schemaVersion === 3 ? { executionStages: { version: 1, stages: [
      { id: 'stage-01', implementationNodeIds: ['step-1'], scopeCheckNodeId: 's01-workspace-check', checkNodeIds: ['s01-check-tests'], boundaryNodeId: 's01-check-tests' },
      { id: 'stage-02', implementationNodeIds: ['step-2'], scopeCheckNodeId: 'workspace-check', checkNodeIds: ['tests'], boundaryNodeId: 'handoff' },
    ], finalCheckNodeIds: ['tests'], finalReviewNodeId: 'review', handoffNodeId: 'handoff' } } : {}),
  };
  const state = { schemaVersion, runId, taskHash: hashObject(task), planHash: hashObject(plan), status: 'passed', activeOperation: null,
    finalDisposition: null, nodes: Object.fromEntries(plan.nodes.map((node) => [node.id, { status: 'passed', receipts: [] }])) };
  const artifact = (kind, data) => {
    const item = { schemaVersion: 2, kind, title: kind, mediaType: 'application/json', content: JSON.stringify(data) };
    const { content, ...metadata } = item, parts = [];
    for (let index = 0; index < content.length; index += 8000) parts.push(content.slice(index, index + 8000));
    const id = hashObject({ ...metadata, parts }); objects.set(id, item); return id;
  };
  const receipt = (nodeId, fields = {}) => {
    const node = plan.nodes.find((candidate) => candidate.id === nodeId);
    const item = { schemaVersion: 2, runId, nodeId, actionId: node.action.id, actionVersion: 1,
      taskHash: state.taskHash, planHash: state.planHash, planVersion: version, phase: 'finished', attempt: state.nodes[nodeId].receipts.length + 1,
      beforeFingerprint: currentFingerprint.hash, afterFingerprint: currentFingerprint.hash,
      startedAt: '2026-10-08T10:00:00.000Z', finishedAt: '2026-10-08T10:00:01.000Z', exitCode: 0, verdict: 'pass',
      checks: [], artifacts: [], durationMs: 1, termination: { stopped: true, uncertain: false }, ...fields };
    const id = hashObject(item); objects.set(id, item); state.nodes[nodeId].receipts.push(id);
    state.nodes[nodeId].status = item.verdict === 'pass' ? 'passed' : item.verdict === 'fail' ? 'failed' : 'uncertain';
    return id;
  };
  const check = (nodeId, resultHash, fields = {}) => {
    const value = { id: nodeId, passed: true, exitCode: 0, summary: 'Проверено локальным инструментом', inputHash: resultHash };
    return receipt(nodeId, { beforeFingerprint: resultHash, afterFingerprint: resultHash, checks: [value],
      artifacts: [artifact('test-report', value)], ...fields });
  };
  const review = ({ omit = omittedAssessment, findings = reviewFindings, fields = {} } = {}) => {
    const reviewEvidenceHash = hashObject('reviewed final implementation');
    const output = { verdict: 'pass', reviewEvidenceHash, findings,
      requirementAssessments: requirements.filter((requirement) => requirement.id !== omit).map((requirement) => ({
        requirementId: requirement.id, criterion: requirement.verification.criterion, checkIds: requirement.verification.checkIds,
        verdict: method === 'human' ? 'uncertain' : 'pass', reason: 'Проверен точный критерий',
        citations: method === 'human' ? [] : [{ path: 'src/result.mjs', startLine: 1, quote: 'return result;' }],
      })) };
    return receipt('review', { reviewEvidenceHash, artifacts: [artifact('review-findings', output)], ...fields });
  };
  const accept = () => {
    state.requirementReceipts = requirements.map((requirement) => {
      const item = { schemaVersion: 2, phase: 'requirement', runId, planHash: state.planHash, taskHash: state.taskHash,
        contractHash: hashObject(contract), requirementId: requirement.id, decision: 'accept', actor: 'operator',
        acceptedAt: '2026-10-08T11:00:00.000Z', resultHash: currentFingerprint.hash, reason: 'Проверено лично', artifacts: [] };
      const id = hashObject(item); objects.set(id, item); return id;
    });
  };
  receipt('step-1', { beforeFingerprint: initialHash, afterFingerprint: intermediateHash });
  receipt('s01-workspace-check', { beforeFingerprint: intermediateHash, afterFingerprint: intermediateHash });
  const intermediateReceipt = check('s01-check-tests', intermediateHash);
  receipt('step-2', { beforeFingerprint: intermediateHash, afterFingerprint: currentFingerprint.hash });
  receipt('workspace-check');
  if (finalCheck) check('tests', currentFingerprint.hash);
  if (finalReview) review();
  receipt('handoff');
  const derive = (overrides = {}) => deriveTaskProof({ state, task, plan, currentFingerprint,
    readReceipt: (id) => objects.get(id), readArtifact: (id) => objects.get(id), ...overrides });
  return { state, task, plan, objects, requirements, currentFingerprint, intermediateHash, intermediateReceipt, receipt, check, review, accept, derive };
}

test('different intermediate fingerprints remain historical while fresh final checks prove all requirements', () => {
  const fx = fixture(), proof = fx.derive();
  assert.notEqual(fx.intermediateHash, fx.currentFingerprint.hash);
  assert.equal(proof.status, 'PROVEN');
  assert.deepEqual(proof.coverage, { required: 2, proven: 2 });
  const intermediate = proof.evidence.find((item) => item.receiptId === fx.intermediateReceipt);
  assert.equal(intermediate.status, 'passed');
  assert.equal(intermediate.freshness, 'stale');
  assert.equal(proof.certificate.receiptIds.includes(fx.intermediateReceipt), false);
  assert.equal(proof.certificate.verifications.every((entry) => entry.resultHash === fx.currentFingerprint.hash), true);
  assert.equal(proof.certificate.receiptIds.includes(fx.state.nodes.review.receipts.at(-1)), true);
});

test('an intermediate pass at the identical fingerprint cannot replace a missing final check receipt', () => {
  const fx = fixture({ sameResult: true, finalCheck: false }), proof = fx.derive();
  assert.equal(proof.evidence.find((item) => item.receiptId === fx.intermediateReceipt).freshness, 'current');
  assert.equal(proof.coverage.proven, 0);
  assert.notEqual(proof.status, 'PROVEN');
  assert.equal(proof.certificate, null);
});

test('missing a mandatory requirement assessment in final review blocks full proof', () => {
  const fx = fixture({ omittedAssessment: 'req-2' }), proof = fx.derive();
  assert.deepEqual(proof.coverage, { required: 2, proven: 1 });
  assert.notEqual(proof.status, 'PROVEN');
  assert.equal(proof.certificate, null);
});

test('current-stage proof cannot reuse a previous run review even at the exact same final fingerprint', () => {
  const old = fixture({ runId: 'old-run' });
  const fx = fixture({ runId: 'new-run', version: 2, finalReview: false });
  const objects = new Map([...old.objects, ...fx.objects]);
  const proof = fx.derive({ previousExecutions: [{ state: old.state, task: old.task, plan: old.plan }],
    readReceipt: (id) => objects.get(id), readArtifact: (id) => objects.get(id) });
  assert.equal(proof.coverage.proven, 0);
  assert.notEqual(proof.status, 'PROVEN');
  assert.ok(proof.evidence.some((item) => item.runId === old.state.runId));
});

test('historical checks cannot substitute for a missing final registered node', () => {
  const old = fixture({ runId: 'old-run' });
  const fx = fixture({ runId: 'new-run', version: 2, finalCheck: false });
  const objects = new Map([...old.objects, ...fx.objects]);
  const proof = fx.derive({ previousExecutions: [{ state: old.state, task: old.task, plan: old.plan }],
    readReceipt: (id) => objects.get(id), readArtifact: (id) => objects.get(id) });
  assert.notEqual(proof.status, 'PROVEN');
  assert.equal(proof.coverage.proven, 0);
});

test('human acceptance cannot substitute for final review and does not become an AI acceptance', () => {
  const missing = fixture({ method: 'human', finalReview: false }); missing.accept();
  assert.notEqual(missing.derive().status, 'PROVEN');
  const complete = fixture({ method: 'human' });
  assert.notEqual(complete.derive().status, 'PROVEN');
  complete.accept();
  const proof = complete.derive();
  assert.equal(proof.status, 'PROVEN');
  assert.equal(proof.certificate.receiptIds.includes(complete.state.nodes.review.receipts.at(-1)), true);
});

for (const [name, fields] of [
  ['failed', { verdict: 'fail', exitCode: 1 }],
  ['uncertain', { verdict: 'uncertain', termination: { stopped: false, uncertain: true } }],
  ['stale', { beforeFingerprint: hashObject('old-result'), afterFingerprint: hashObject('old-result') }],
]) test(`${name} final check cannot be replaced by successful intermediate evidence`, () => {
  const fx = fixture({ sameResult: true });
  fx.check('tests', fx.currentFingerprint.hash, fields);
  assert.notEqual(fx.derive().status, 'PROVEN');
  assert.equal(fx.derive().certificate, null);
});

for (const [name, fields] of [
  ['failed', { verdict: 'fail', exitCode: 1 }],
  ['uncertain', { verdict: 'uncertain', termination: { stopped: false, uncertain: true } }],
  ['stale', { beforeFingerprint: hashObject('old-result'), afterFingerprint: hashObject('old-result') }],
  ['unbound', { reviewEvidenceHash: hashObject('different-review-bundle') }],
]) test(`${name} final review blocks proof despite complete final checks`, () => {
  const fx = fixture(); fx.review({ fields });
  assert.notEqual(fx.derive().status, 'PROVEN');
});

test('historical blocking findings remain until current final checks and assessments resolve them', () => {
  const old = fixture({ runId: 'old-run', reviewFindings: [{ severity: 'blocking', path: 'src/result.mjs', message: 'Дефект итогового сценария' }] });
  const fx = fixture({ runId: 'new-run', version: 2, finalReview: false });
  const options = () => { const objects = new Map([...old.objects, ...fx.objects]); return {
    previousExecutions: [{ state: old.state, task: old.task, plan: old.plan }],
    readReceipt: (id) => objects.get(id), readArtifact: (id) => objects.get(id),
  }; };
  assert.equal(fx.derive(options()).findings[0].status, 'open');
  fx.review();
  const proof = fx.derive(options());
  assert.equal(proof.status, 'PROVEN');
  assert.equal(proof.findings[0].status, 'resolved');
  assert.deepEqual(proof.findings[0].repairNodeIds, ['step-1', 'step-2']);
});

test('actual final workspace drift is still stale and never gets a certificate', () => {
  const fx = fixture();
  const proof = fx.derive({ currentFingerprint: { hash: hashObject('changed-after-final') } });
  assert.equal(proof.status, 'STALE');
  assert.equal(proof.certificate, null);
});

test('V2 final proof and historical evidence keep their existing selection behavior', () => {
  const fx = fixture({ schemaVersion: 2 });
  assert.equal(fx.derive().status, 'PROVEN');
  assert.equal(fx.derive().evidence.find((item) => item.receiptId === fx.intermediateReceipt).freshness, 'stale');
});
