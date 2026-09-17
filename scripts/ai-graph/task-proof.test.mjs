import test from 'node:test';
import assert from 'node:assert/strict';
import { hashObject } from './lib/io.mjs';
import { deriveTaskProof } from './lib/task-proof.mjs';

function fixture({ count = 1, method = 'check', result = 'result', runId = 'run-proof', version = 1, finish = true } = {}) {
  const objects = new Map();
  const currentFingerprint = { hash: hashObject(result) };
  const requirements = Array.from({ length: count }, (_, index) => ({ id: `req-${index + 1}`, title: `Требование ${index + 1}`,
    mandatory: true, origin: 'acceptance', workIds: ['implement'], verification: { method,
      checkIds: method === 'check' ? ['check-tests'] : [], criterion: `Результат ${index + 1} соответствует условию`, paths: ['src'] } }));
  const contract = { version: 1, goal: 'Работающий результат', instructionsHash: hashObject('instructions'), requirements,
    optionalImprovements: [], constraints: [], assumptions: [], unknowns: [], scope: ['src'], forbiddenPaths: [], rigor: { level: 'standard', reasons: [] } };
  const node = (id, actionId) => ({ id, action: { id: actionId, version: 1 } });
  const task = { id: 'TASK-PROOF', goal: contract.goal, instructions: 'instructions', checks: method === 'check' ? ['tests'] : [] };
  const plan = { version, stage: 'execution', taskContract: contract, nodes: [node('implement', 'ai-implement'), ...(method === 'check' ? [node('tests', 'check-tests')] : []), node('review', 'ai-review')] };
  const state = { runId, taskHash: hashObject(task), planHash: hashObject(plan), status: 'passed', activeOperation: null, finalDisposition: null,
    nodes: Object.fromEntries(plan.nodes.map((item) => [item.id, { status: 'passed', receipts: [] }])) };
  const artifact = (kind, data) => {
    const value = { schemaVersion: 2, kind, title: kind, mediaType: 'application/json', content: JSON.stringify(data) };
    const { content, ...metadata } = value;
    const parts = []; for (let offset = 0; offset < content.length; offset += 8000) parts.push(content.slice(offset, offset + 8000));
    const id = hashObject({ ...metadata, parts }); objects.set(id, value); return id;
  };
  const receipt = (nodeId, fields = {}) => {
    const definition = plan.nodes.find((item) => item.id === nodeId);
    const attempt = state.nodes[nodeId].receipts.length + 1;
    const value = { schemaVersion: 2, runId, nodeId, actionId: definition.action.id, actionVersion: 1,
      taskHash: state.taskHash, planHash: state.planHash, planVersion: version, phase: 'finished', attempt,
      beforeFingerprint: currentFingerprint.hash, afterFingerprint: currentFingerprint.hash,
      startedAt: `2026-09-17T10:00:0${attempt}.000Z`, finishedAt: `2026-09-17T10:00:0${attempt + 1}.000Z`,
      exitCode: 0, verdict: 'pass', checks: [], artifacts: [], durationMs: 10,
      termination: { stopped: true, uncertain: false, execution: null }, ...fields };
    const id = hashObject(value); objects.set(id, value); state.nodes[nodeId].receipts.push(id);
    state.nodes[nodeId].status = value.verdict === 'pass' ? 'passed' : value.verdict === 'fail' ? 'failed' : 'uncertain';
    return id;
  };
  const check = (passed = true, fields = {}) => {
    const result = { id: 'tests', passed, exitCode: passed ? 0 : 1, summary: passed ? 'Тест пройден' : 'Неверный результат теста', inputHash: currentFingerprint.hash, ...fields };
    return receipt('tests', { exitCode: result.exitCode, verdict: passed ? 'pass' : 'fail', checks: [result], artifacts: [artifact('test-report', result)] });
  };
  const review = ({ omit = [], fail = [], findings = [], assessments: supplied = null, fields = {} } = {}) => {
    const reviewEvidenceHash = hashObject('full reviewed state');
    const assessments = supplied ?? requirements.filter((item) => !omit.includes(item.id)).map((item) => ({ requirementId: item.id,
      criterion: item.verification.criterion, verdict: fail.includes(item.id) ? 'fail' : 'pass', checkIds: item.verification.checkIds,
      citations: [{ path: 'src/result.mjs', startLine: 2, quote: 'return expected;' }], reason: `Проверено ${item.id}` }));
    const output = { reviewEvidenceHash, verdict: fail.length ? 'fail' : 'pass', requirementAssessments: assessments, findings };
    return receipt('review', { reviewEvidenceHash, verdict: output.verdict, artifacts: [artifact('review-findings', output)], ...fields });
  };
  const accept = (requirementId = 'req-1', fields = {}) => {
    const value = { schemaVersion: 2, phase: 'requirement', runId, planHash: state.planHash, taskHash: state.taskHash,
      contractHash: hashObject(contract), requirementId, decision: 'accept', actor: 'operator', acceptedAt: '2026-09-17T10:01:00.000Z',
      resultHash: currentFingerprint.hash, reason: 'Лично проверен ожидаемый результат', operationId: 'accept-requirement', previousReceipt: null, artifacts: [], ...fields };
    const id = hashObject(value); objects.set(id, value); state.requirementReceipts ??= []; state.requirementReceipts.push(id); return id;
  };
  if (finish) { receipt('implement'); if (method === 'check') check(); review(); }
  const derive = (overrides = {}) => deriveTaskProof({ state, task, plan, currentFingerprint, readReceipt: (id) => objects.get(id), readArtifact: (id) => objects.get(id), ...overrides });
  return { objects, currentFingerprint, requirements, contract, task, plan, state, artifact, receipt, check, review, accept, derive };
}

test('actual check plus mapped assessment and performed work proves each requirement deterministically', () => {
  const f = fixture({ count: 2 });
  const proof = f.derive();
  assert.equal(proof.status, 'PROVEN'); assert.deepEqual(proof.coverage, { required: 2, proven: 2 });
  assert.equal(proof.certificate.resultHash, f.currentFingerprint.hash);
  assert.equal(proof.certificate.evidenceIds.length, 3);
  assert.deepEqual(proof, f.derive());
  assert.equal(proof.requirements.every((item) => item.artifactIds.length > 0 && item.evidenceIds.length > 0), true);
});

test('nine proven requirements out of ten cannot produce PROVEN or a certificate', () => {
  const f = fixture({ count: 10, finish: false }); f.receipt('implement'); f.check(); f.review({ omit: ['req-10'] });
  const proof = f.derive();
  assert.equal(proof.coverage.proven, 9); assert.notEqual(proof.status, 'PROVEN'); assert.equal(proof.certificate, null);
});

test('an optional failed assessment does not become a mandatory blocker', () => {
  const f = fixture({ count: 2, finish: false });
  f.requirements[1].mandatory = false;
  f.receipt('implement'); f.check();
  f.review({ assessments: f.requirements.map((item) => ({ requirementId: item.id,
    criterion: item.verification.criterion, verdict: item.mandatory ? 'pass' : 'fail', checkIds: item.verification.checkIds,
    citations: [{ path: 'src/result.mjs', startLine: 2, quote: 'return expected;' }], reason: 'Проверен отдельный критерий' })) });
  const proof = f.derive();
  assert.deepEqual(proof.coverage, { required: 1, proven: 1 });
  assert.equal(proof.status, 'PROVEN');
  assert.equal(proof.requirements[1].status, 'failed');
  assert.ok(proof.findings.some((item) => item.status === 'open' && !item.blocking));
});

test('a passed check and a general AI claim cannot prove unmapped requirements', () => {
  const f = fixture({ finish: false }); f.receipt('implement'); f.check(); f.review({ assessments: [] });
  assert.equal(f.derive().coverage.proven, 0);
});

test('a missing or unavailable verifier never passes even with positive review', () => {
  const f = fixture({ finish: false }); f.receipt('implement'); f.review();
  assert.notEqual(f.derive().status, 'PROVEN');
  f.check(true, { inputHash: hashObject('different input') });
  assert.notEqual(f.derive().status, 'PROVEN');
  assert.equal(f.derive().evidence.find((item) => item.method === 'check').status, 'unavailable');
});

test('failed verification opens an actionable finding and prevents requirement proof', () => {
  const f = fixture({ finish: false }); f.receipt('implement'); f.check(false); f.review(); f.state.status = 'failed';
  const proof = f.derive();
  assert.equal(proof.status, 'FAILED'); assert.equal(proof.coverage.proven, 0);
  assert.equal(proof.findings[0].blocking, true); assert.deepEqual(proof.findings[0].requirementIds, ['req-1']);
});

test('repair followed by fresh verification resolves historical failure; repair alone does not', () => {
  const old = fixture({ finish: false, runId: 'run-old' }); old.receipt('implement'); old.check(false); old.state.status = 'failed';
  const f = fixture({ result: 'repaired', runId: 'run-new', version: 2, finish: false }); f.receipt('implement');
  const objects = new Map([...old.objects, ...f.objects]);
  const options = () => ({ previousExecutions: [{ state: old.state, task: old.task, plan: old.plan }], readReceipt: (id) => f.objects.get(id) ?? objects.get(id), readArtifact: (id) => f.objects.get(id) ?? objects.get(id) });
  assert.equal(f.derive(options()).findings[0].status, 'open');
  f.check(); f.review();
  const proof = f.derive(options());
  assert.equal(proof.status, 'PROVEN'); assert.equal(proof.findings[0].status, 'resolved');
  assert.deepEqual(proof.findings[0].repairNodeIds, ['implement']);
  assert.equal(proof.evidence.find((item) => item.runId === 'run-old').freshness, 'stale');
});

test('live result drift makes evidence stale and missing live fingerprint fails closed', () => {
  const f = fixture();
  assert.equal(f.derive({ currentFingerprint: { hash: hashObject('changed') } }).status, 'STALE');
  assert.equal(f.derive({ currentFingerprint: null }).certificate, null);
  assert.notEqual(f.derive({ currentReason: 'Runtime integrity changed' }).status, 'PROVEN');
});

test('source review requires scoped citations and exact criterion; confident text is not evidence', () => {
  const f = fixture({ method: 'source-review', finish: false }); f.receipt('implement');
  const assessment = { requirementId: 'req-1', verdict: 'pass', criterion: f.requirements[0].verification.criterion, checkIds: [], citations: [], reason: 'Все работает' };
  f.review({ assessments: [assessment] }); assert.equal(f.derive().coverage.proven, 0);
  f.review({ assessments: [{ ...assessment, citations: [{ path: 'outside/file', startLine: 1, quote: 'true' }] }] });
  assert.equal(f.derive().coverage.proven, 0);
  f.review(); assert.equal(f.derive().status, 'PROVEN');
});

test('human requirements need separate immutable acceptance bound to exact result and contract', () => {
  const f = fixture({ method: 'human' });
  assert.notEqual(f.derive().status, 'PROVEN'); f.accept(); assert.equal(f.derive().status, 'PROVEN');
  assert.equal(f.derive({ currentFingerprint: { hash: hashObject('changed') } }).status, 'STALE');
  const rejected = fixture({ method: 'human' }); rejected.accept('req-1', { contractHash: hashObject('other contract') });
  assert.notEqual(rejected.derive().status, 'PROVEN');
});

test('receipt or artifact tampering and mismatched binding cannot create proof', () => {
  const f = fixture(); const id = f.state.nodes.tests.receipts[0];
  f.objects.get(id).exitCode = 1;
  assert.notEqual(f.derive().status, 'PROVEN');
  const other = fixture(); const reviewId = other.state.nodes.review.receipts[0];
  other.objects.get(other.objects.get(reviewId).artifacts[0]).content += ' ';
  assert.notEqual(other.derive().status, 'PROVEN');
});

test('a successful verifier does not replace missing work coverage or unfinished execution', () => {
  const f = fixture(); f.state.nodes.implement.status = 'pending';
  assert.notEqual(f.derive().status, 'PROVEN');
  const running = fixture(); running.state.activeOperation = { id: 'running-now' }; running.state.status = 'running';
  assert.equal(running.derive().status, 'RUNNING');
});

test('recovery derives the same proof from persisted objects without model memory', () => {
  const f = fixture();
  const restored = JSON.parse(JSON.stringify({ state: f.state, task: f.task, plan: f.plan, currentFingerprint: f.currentFingerprint }));
  const objects = new Map(JSON.parse(JSON.stringify([...f.objects])));
  assert.deepEqual(f.derive(), deriveTaskProof({ ...restored, readReceipt: (id) => objects.get(id), readArtifact: (id) => objects.get(id) }));
});

test('AI usage stays unknown without provider data and aggregates only real reported values', () => {
  const f = fixture(); const unknown = f.derive().usage;
  assert.equal(unknown.aiCalls, 2); assert.equal(unknown.totalTokens, null); assert.equal(unknown.costUsd, null);
  for (const id of ['implement', 'review']) {
    const oldId = f.state.nodes[id].receipts[0]; const receipt = structuredClone(f.objects.get(oldId));
    receipt.termination.execution = { usage: { source: 'provider', inputTokens: 100, cachedInputTokens: 20, outputTokens: 50, totalTokens: 150, costUsd: 0.001 }, context: { promptBytes: 1000 } };
    const nextId = hashObject(receipt); f.objects.set(nextId, receipt); f.state.nodes[id].receipts = [nextId];
  }
  const usage = f.derive().usage;
  assert.equal(usage.totalTokens, 300); assert.equal(usage.tokensPerProvenRequirement, 300); assert.equal(usage.contextBytes, 2000);
  assert.equal(usage.costUsd, 0.002); assert.equal(usage.unknownCalls, 0);
});

test('changed review criterion, wrong evidence hash and duplicate assessments cannot prove a requirement', () => {
  for (const variant of ['criterion', 'hash', 'duplicate']) {
    const f = fixture({ finish: false }); f.receipt('implement'); f.check();
    const assessment = { requirementId: 'req-1', verdict: 'pass', criterion: f.requirements[0].verification.criterion,
      checkIds: ['check-tests'], citations: [], reason: 'Проверено' };
    f.review({ assessments: variant === 'duplicate' ? [assessment, assessment] : [{ ...assessment, ...(variant === 'criterion' ? { criterion: 'Другое условие' } : {}) }],
      ...(variant === 'hash' ? { fields: { reviewEvidenceHash: hashObject('wrong bundle') } } : {}) });
    assert.notEqual(f.derive().status, 'PROVEN', variant);
  }
});

test('interrupted check with exit zero remains unavailable without stopped process evidence', () => {
  const f = fixture({ finish: false }); f.receipt('implement');
  f.receipt('tests', { termination: { stopped: false, uncertain: true }, checks: [{ id: 'tests', passed: true, exitCode: 0, inputHash: f.currentFingerprint.hash }] });
  f.review(); assert.notEqual(f.derive().status, 'PROVEN');
});

test('later blocking review finding cannot be resolved by an older successful assessment', () => {
  const f = fixture(); f.review({ assessments: [], findings: [{ severity: 'blocking', path: 'src/result.mjs', message: 'Обнаружена новая ошибка' }], fields: { verdict: 'fail' } });
  const proof = f.derive(); assert.equal(proof.findings[0].status, 'open'); assert.equal(proof.status, 'FAILED');
});

test('human acceptance cannot stand in for a configured objective verification', () => {
  const f = fixture({ finish: false }); f.receipt('implement'); f.accept();
  const proof = f.derive(); assert.equal(proof.coverage.proven, 0); assert.equal(proof.evidence.some((item) => item.method === 'human'), false);
});

test('check coverage still needs a cited requirement assessment if the outer validator fails to reject it', () => {
  const f = fixture({ finish: false }); f.receipt('implement'); f.check();
  f.review({ assessments: [{ requirementId: 'req-1', criterion: f.requirements[0].verification.criterion, verdict: 'pass',
    checkIds: ['check-tests'], citations: [], reason: 'Заявление без проверяемой ссылки' }] });
  assert.equal(f.derive().coverage.proven, 0);
});

test('a later valid review does not erase corrupt duplicate requirement assessments', () => {
  const f = fixture({ finish: false }); f.receipt('implement'); f.check();
  const assessment = { requirementId: 'req-1', verdict: 'pass', criterion: f.requirements[0].verification.criterion,
    checkIds: ['check-tests'], citations: [{ path: 'src/result.mjs', startLine: 2, quote: 'return expected;' }], reason: 'Проверено' };
  f.review({ assessments: [assessment, assessment] }); f.review();
  const proof = f.derive(); assert.notEqual(proof.status, 'PROVEN'); assert.equal(proof.certificate, null);
  assert.equal(proof.blockers.some((reason) => reason.includes('повторяющееся')), true);
});

test('historical human acceptance cannot resolve a subsequently discovered blocking finding', () => {
  const old = fixture({ method: 'human', runId: 'run-before' }); old.accept();
  const f = fixture({ method: 'human', runId: 'run-after', version: 2 });
  f.review({ assessments: [], findings: [{ severity: 'blocking', path: 'src/result.mjs', message: 'После приемки обнаружен дефект' }] });
  const objects = new Map([...old.objects, ...f.objects]);
  const proof = f.derive({ previousExecutions: [{ state: old.state, task: old.task, plan: old.plan }], readReceipt: (id) => objects.get(id), readArtifact: (id) => objects.get(id) });
  assert.equal(proof.findings[0].status, 'open'); assert.equal(proof.status, 'FAILED');
});

test('analysis findings survive planning lineage and usage counts each real AI call', () => {
  const old = fixture({ runId: 'run-planning', finish: false });
  old.plan.nodes.push({ id: 'analyze', action: { id: 'ai-analyze', version: 1 } });
  old.state.nodes.analyze = { status: 'passed', receipts: [] };
  old.state.planHash = hashObject(old.plan);
  old.receipt('analyze', { artifacts: [old.artifact('analysis', { findings: [{ severity: 'warning', path: 'src/result.mjs', message: 'Допущение анализа' }] })] });
  const f = fixture({ runId: 'run-execution', version: 2 });
  const objects = new Map([...old.objects, ...f.objects]);
  const proof = f.derive({ previousExecutions: [{ state: old.state, task: old.task, plan: old.plan }], readReceipt: (id) => objects.get(id), readArtifact: (id) => objects.get(id) });
  assert.equal(proof.status, 'PROVEN'); assert.equal(proof.findings.length, 1); assert.equal(proof.findings[0].title, 'Допущение анализа');
  assert.equal(proof.usage.aiCalls, 3); assert.equal(proof.usage.totalTokens, null);
});

test('a new check cannot close a later semantic finding by reusing an older requirement assessment', () => {
  const old = fixture({ runId: 'run-before' });
  old.review({ assessments: [], findings: [{ severity: 'blocking', path: 'src/result.mjs', message: 'Сценарий не покрыт проверкой' }], fields: { verdict: 'fail' } });
  const f = fixture({ runId: 'run-after', version: 2, finish: false }); f.receipt('implement'); f.check(); f.review({ assessments: [] });
  const objects = new Map([...old.objects, ...f.objects]);
  const proof = f.derive({ previousExecutions: [{ state: old.state, task: old.task, plan: old.plan }], readReceipt: (id) => objects.get(id), readArtifact: (id) => objects.get(id) });
  assert.equal(proof.findings[0].status, 'open'); assert.equal(proof.status, 'FAILED');
});

test('duplicate requirement results across artifacts in the same receipt are also corruption', () => {
  const f = fixture();
  const previous = f.objects.get(f.state.nodes.review.receipts[0]);
  f.receipt('review', { reviewEvidenceHash: previous.reviewEvidenceHash, artifacts: [...previous.artifacts, ...previous.artifacts] });
  const proof = f.derive(); assert.notEqual(proof.status, 'PROVEN');
  assert.equal(proof.blockers.some((reason) => reason.includes('повторяющееся')), true);
});
