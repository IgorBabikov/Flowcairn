import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { URL, fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

const output = await build({ stdin: { contents: "export * from './world-execution';",
  resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'esm' });
const { projectWorldExecution, selectWorldExecution } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
const connected = { connected: true };
const start = '2026-10-09T12:00:00.000Z', finish = '2026-10-09T12:01:00.000Z';
const artifact = { id: 'artifact-diff', kind: 'diff', title: 'Изменения', mediaType: 'text/plain', size: 10 };
function node(id, action, overrides = {}) {
  return { id, title: id, outcome: 'outcome', needs: [], action: { id: action, kind: 'implementation' },
    status: 'pending', mode: 'read', permissions: [], skills: [], attempt: 0, startedAt: null, finishedAt: null,
    durationMs: null, reason: null, receiptIds: [], artifacts: [], changedFiles: [], checks: [], capabilities: {}, ...overrides };
}
function snapshot(nodes = [], overrides = {}) {
  return { schemaVersion: 2, runId: 'run-1', planHash: 'plan-1', revision: 1, status: 'running',
    task: { id: 'task-1', goal: 'Сохранить результат' },
    integrity: { valid: true, reason: null }, nodes, edges: [], gates: [], capabilities: {}, ...overrides };
}
function before(overrides = {}) {
  return snapshot([node('work', 'ai-implement', { status: 'running', attempt: 1, startedAt: start, receiptIds: ['started'] }),
    node('verify', 'check-tests', { needs: ['work'] })], overrides);
}
function after(overrides = {}) {
  return snapshot([node('work', 'ai-implement', { status: 'passed', attempt: 1, startedAt: start, finishedAt: finish, receiptIds: ['started', 'passed'], artifacts: [artifact] }),
    node('verify', 'check-tests', { needs: ['work'], status: 'running', attempt: 1, startedAt: finish, receiptIds: ['check-started'] })], { revision: 2, ...overrides });
}
function proven(overrides = {}) {
  const resultHash = 'a'.repeat(64);
  return { status: 'PROVEN', resultHash,
    contract: { version: 1, goal: 'Сохранить результат', requirements: [{ id: 'req-1', mandatory: true }] },
    requirements: [{ id: 'req-1', mandatory: true, status: 'proven', evidenceIds: ['evidence-1'] }],
    evidence: [{ id: 'evidence-1', requirementIds: ['req-1'], receiptId: 'check-passed', status: 'passed', freshness: 'current', resultHash }],
    certificate: { version: 1, id: 'b'.repeat(64), contractHash: 'c'.repeat(64), resultHash, taskId: 'task-1',
      goal: 'Сохранить результат', requirementIds: ['req-1'], evidenceIds: ['evidence-1'], receiptIds: ['check-passed'] },
    coverage: { required: 1, proven: 1 }, findings: [], ...overrides };
}

// WorkflowService repair read model: a failed historical check remains in requirement.evidenceIds,
// while the certificate selects only the subsequent successful check and review.
function repairedProof() {
  const proof = proven();
  const current = proof.evidence[0];
  proof.requirements[0].evidenceIds = ['failed-check', current.id, 'review-current'];
  proof.evidence.unshift({ ...current, id: 'failed-check', receiptId: 'receipt-failed', status: 'failed',
    freshness: 'stale', resultHash: 'd'.repeat(64) });
  proof.evidence.push({ ...current, id: 'review-current', receiptId: 'review-passed' });
  proof.certificate.evidenceIds.push('review-current');
  proof.certificate.receiptIds.push('review-passed');
  return proof;
}

test('assignments reflect actual actions and scoped skills, without inventing tiny-task teams', () => {
  const skill = { id: 'domain-typescript', path: 'skills/typescript', hash: 'hash' };
  const view = projectWorldExecution(snapshot([node('only', 'ai-implement', { status: 'running', skills: [skill] })]), connected);
  assert.equal(view.workers.length, 1);
  assert.equal(view.workers[0].role, 'mage'); assert.equal(view.workers[0].station, 'bench');
  assert.equal(view.workers[0].active, true); assert.deepEqual(view.workers[0].skills, [skill]);
  assert.deepEqual(projectWorldExecution(null, connected).workers, []);
});
test('analysis, planning, checks, review and gates preserve factual action identities', () => {
  const actions = ['ai-analyze', 'ai-plan', 'workspace-check', 'check-custom-tests', 'ai-review', 'human-approve', 'artifact-handoff'];
  const workers = projectWorldExecution(snapshot(actions.map(action => node(action, action))), connected).workers;
  assert.deepEqual(workers.map(item => item.role), ['analyst', 'analyst', 'checker', 'checker', 'reviewer', 'mentor', 'mentor']);
  assert.deepEqual(workers.map(item => item.action), actions);
});
test('unknown actions remain unknown and cannot simulate work even with guessed skills', () => {
  const view = projectWorldExecution(snapshot([node('unregistered', 'imaginary-ai', { status: 'running', skills: [{ id: 'testing' }] })]), connected);
  assert.equal(view.workers[0].state, 'unknown'); assert.equal(view.workers[0].active, false);
});
test('freshness, stop and uncertain states cannot animate or grant completion', () => {
  for (const [options, changes, freshness] of [
    [{ connected: false }, {}, 'disconnected'], [connected, { status: 'stale' }, 'stale'],
    [{ ...connected, snapshotUnavailable: true }, {}, 'disconnected'],
    [connected, { integrity: { valid: false, reason: 'drift' } }, 'stale'],
    [{ ...connected, history: true }, {}, 'history'],
  ]) {
    const result = selectWorldExecution(before({ proof: proven(), ...changes }), options);
    assert.equal(result.view.freshness, freshness); assert.equal(result.cursor, null);
    assert.equal(result.view.completed, false); assert.ok(result.view.workers.every(item => !item.active));
  }
  for (const changes of [{ status: 'uncertain' }, { status: 'failed' }, { status: 'cancelled' },
    { execution: { state: 'stopping', stopRequested: true } }]) {
    assert.ok(projectWorldExecution(before(changes), connected).workers.every(item => !item.active));
  }
});
test('passed nodes or ready-for-review never imply PROVEN; mandatory coverage and blocking findings remain authoritative', () => {
  assert.equal(projectWorldExecution(after({ status: 'passed', completion: 'ready-for-review' }), connected).completed, false);
  assert.equal(projectWorldExecution(after({ proof: proven() }), connected).completed, true);
  for (const proof of [proven({ status: 'UNPROVEN' }), proven({ status: 'STALE' }),
    proven({ requirements: [] }), proven({ coverage: { required: 1, proven: 0 } }),
    proven({ requirements: [{ mandatory: true, status: 'stale' }] }),
    proven({ findings: [{ blocking: true, status: 'open' }] })]) {
    assert.equal(projectWorldExecution(after({ proof }), connected).completed, false);
  }
});
test('unknown run, node and progress statuses fail closed even alongside complete proof', () => {
  for (const mutate of [
    s => { s.status = 'future-unknown-state'; },
    s => { s.nodes[0].status = 'future-unknown-state'; },
    s => { s.workflowProgress = [{ nodeId: 'old', action: 'ai-plan', status: 'future-unknown-state', sourceRunId: 'old',
      planHash: 'old', receiptIds: [], artifacts: [], title: 'old' }]; },
  ]) {
    const candidate = after({ proof: proven() }); mutate(candidate);
    const result = selectWorldExecution(candidate, connected);
    assert.equal(result.view.freshness, 'unknown'); assert.equal(result.view.completed, false);
    assert.ok(result.view.workers.every(item => !item.active)); assert.equal(result.cursor, null);
  }
});
test('completion requires task-bound certificate, exact mandatory requirements and current receipt-linked evidence', () => {
  for (const mutate of [
    s => { delete s.proof.certificate; }, s => { s.proof.certificate = null; },
    s => { s.proof.certificate.version = 2; }, s => { s.proof.certificate.id = ''; },
    s => { s.proof.certificate.taskId = 'other-task'; }, s => { s.proof.certificate.goal = 'other-goal'; },
    s => { s.proof.certificate.resultHash = 'd'.repeat(64); }, s => { s.proof.resultHash = ''; },
    s => { s.proof.certificate.requirementIds = []; }, s => { s.proof.certificate.requirementIds.push('extra'); },
    s => { s.proof.certificate.requirementIds.push('req-1'); },
    s => { s.proof.contract.requirements.push({ id: 'missing', mandatory: true }); },
    s => { s.proof.requirements[0].evidenceIds = []; }, s => { s.proof.certificate.evidenceIds = []; },
    s => { s.proof.certificate.evidenceIds.push('unknown'); }, s => { s.proof.evidence = []; },
    s => { s.proof.evidence[0].freshness = 'stale'; }, s => { s.proof.evidence[0].status = 'uncertain'; },
    s => { s.proof.evidence[0].resultHash = 'd'.repeat(64); }, s => { s.proof.evidence[0].requirementIds = []; },
    s => { s.proof.evidence[0].receiptId = null; }, s => { s.proof.certificate.receiptIds = []; },
    s => { s.proof.evidence[0].requirementIds = null; },
    s => { s.proof.evidence[0].receiptId = 10; s.proof.certificate.receiptIds = [10]; },
  ]) {
    const candidate = after({ proof: proven() }); mutate(candidate);
    assert.equal(projectWorldExecution(candidate, connected).completed, false);
  }
});
test('successful repair tolerates historical failed/stale evidence outside the current certificate', () => {
  const proof = repairedProof();
  const original = JSON.parse(JSON.stringify(proof));
  assert.equal(projectWorldExecution(after({ status: 'passed', proof }), connected).completed, true);
  assert.deepEqual(proof, original);
  assert.equal(proof.requirements[0].evidenceIds.includes('failed-check'), true);
  assert.equal(proof.certificate.evidenceIds.includes('failed-check'), false);
  for (const history of [
    { status: 'failed', freshness: 'current' },
    { status: 'passed', freshness: 'stale' },
  ]) {
    const candidate = repairedProof(); Object.assign(candidate.evidence[0], history);
    assert.equal(projectWorldExecution(after({ proof: candidate }), connected).completed, true);
  }
});
test('historical evidence cannot replace missing/invalid current certificate evidence after repair', () => {
  for (const mutate of [
    p => { p.certificate.evidenceIds = ['failed-check']; p.certificate.receiptIds.push('receipt-failed'); },
    p => { p.evidence = p.evidence.filter(item => item.id === 'failed-check'); },
    p => { p.evidence.filter(item => p.certificate.evidenceIds.includes(item.id)).forEach(item => { item.freshness = 'stale'; }); },
    p => { p.evidence.filter(item => p.certificate.evidenceIds.includes(item.id)).forEach(item => { item.status = 'failed'; }); },
    p => { p.requirements[0].evidenceIds = ['failed-check']; },
    p => { p.certificate.evidenceIds.push('failed-check'); p.certificate.receiptIds.push('receipt-failed'); },
  ]) {
    const proof = repairedProof(); mutate(proof);
    assert.equal(projectWorldExecution(after({ proof }), connected).completed, false);
  }
});
test('each mandatory requirement needs its own linked current certificate evidence', () => {
  const proof = repairedProof();
  proof.contract.requirements.push({ id: 'req-2', mandatory: true });
  proof.requirements.push({ id: 'req-2', mandatory: true, status: 'proven', evidenceIds: ['failed-check'] });
  proof.certificate.requirementIds.push('req-2'); proof.coverage = { required: 2, proven: 2 };
  assert.equal(projectWorldExecution(after({ proof }), connected).completed, false);
  proof.requirements[1].evidenceIds.push('review-current');
  proof.evidence.find(item => item.id === 'review-current').requirementIds = ['req-1', 'req-2'];
  assert.equal(projectWorldExecution(after({ proof }), connected).completed, true);
});
test('initial load, reload and archive restore state without replaying historical handoffs', () => {
  for (const options of [connected, { ...connected, history: true }]) {
    assert.deepEqual(selectWorldExecution(after(), options).view.handoffs, []);
  }
  const first = selectWorldExecution(after(), connected);
  assert.deepEqual(selectWorldExecution(after(), connected, first.cursor).view.handoffs, []);
});
test('fresh terminal receipt followed by a factual dependent start emits stable dependency-start once', () => {
  const baseline = selectWorldExecution(before(), connected);
  const result = selectWorldExecution(after(), connected, baseline.cursor);
  assert.equal(result.view.handoffs.length, 1);
  const handoff = result.view.handoffs[0];
  assert.equal(handoff.kind, 'dependency-start'); assert.equal(handoff.fromNodeId, 'work'); assert.equal(handoff.toNodeId, 'verify');
  assert.equal(handoff.receiptId, 'passed'); assert.deepEqual(handoff.artifactRefs, [artifact]);
  assert.match(handoff.id, /run-1.*plan-1.*work.*passed.*verify/);
  assert.deepEqual(selectWorldExecution(after({ revision: 3 }), connected, result.cursor).view.handoffs, []);
});
test('same attempted start cannot replay an emitted edge after an intermediate ready snapshot', () => {
  const baseline = selectWorldExecution(before(), connected);
  const emitted = selectWorldExecution(after(), connected, baseline.cursor);
  const ready = after({ revision: 3 }); ready.nodes[1].status = 'ready';
  const intermediate = selectWorldExecution(ready, connected, emitted.cursor);
  assert.deepEqual(selectWorldExecution(after({ revision: 4 }), connected, intermediate.cursor).view.handoffs, []);
});
test('completion may precede consumer start by several snapshots', () => {
  let cursor = selectWorldExecution(before(), connected).cursor;
  const waiting = after(); waiting.nodes[1] = node('verify', 'check-tests', { needs: ['work'], status: 'ready' });
  const terminal = selectWorldExecution(waiting, connected, cursor); assert.deepEqual(terminal.view.handoffs, []); cursor = terminal.cursor;
  cursor = selectWorldExecution({ ...waiting, revision: 3 }, connected, cursor).cursor;
  assert.equal(selectWorldExecution(after({ revision: 4 }), connected, cursor).view.handoffs.length, 1);
});
test('pending/ready consumer, missing/newly-unproven receipts and invalid chronology never imply handoff', () => {
  const baseline = selectWorldExecution(before(), connected);
  for (const mutate of [
    s => { s.nodes[1].status = 'ready'; }, s => { s.nodes[1].startedAt = null; },
    s => { s.nodes[0].receiptIds = ['started']; }, s => { s.nodes[0].status = 'uncertain'; },
    s => { s.nodes[0].finishedAt = null; }, s => { s.nodes[0].finishedAt = 'bad'; },
    s => { s.nodes[1].startedAt = start; }, s => { s.nodes[1].needs = []; },
  ]) {
    const candidate = after(); mutate(candidate);
    assert.deepEqual(selectWorldExecution(candidate, connected, baseline.cursor).view.handoffs, []);
  }
});
test('old completion on baseline cannot produce handoff when a downstream consumer later starts', () => {
  const initial = after(); initial.nodes[1].status = 'ready'; initial.nodes[1].startedAt = null;
  const baseline = selectWorldExecution(initial, connected);
  assert.deepEqual(selectWorldExecution(after({ revision: 3 }), connected, baseline.cursor).view.handoffs, []);
});
test('reconnect, different run/plan and out-of-order revisions cannot replay or rewind transitions', () => {
  const baseline = selectWorldExecution(before(), connected);
  for (const changes of [{ runId: 'run-2' }, { planHash: 'plan-2' }]) {
    assert.deepEqual(selectWorldExecution(after(changes), connected, baseline.cursor).view.handoffs, []);
  }
  const gap = selectWorldExecution(before(), { connected: false }, baseline.cursor);
  assert.equal(gap.cursor, null); assert.deepEqual(selectWorldExecution(after(), connected, gap.cursor).view.handoffs, []);
  const current = selectWorldExecution(after({ revision: 10 }), connected, baseline.cursor);
  const late = selectWorldExecution(before({ proof: proven() }), connected, current.cursor);
  assert.equal(late.view.completed, false); assert.equal(late.view.freshness, 'unknown');
  assert.ok(late.view.workers.every(item => !item.active)); assert.equal(late.cursor.revision, 10);
});
test('retries retain attempt-bound handoff identity and edge memory is bounded', () => {
  let cursor = selectWorldExecution(before(), connected).cursor;
  const ids = new Set();
  for (let attempt = 1; attempt <= 40; attempt++) {
    const running = before({ revision: attempt * 3 }); running.nodes[0].attempt = attempt;
    cursor = selectWorldExecution(running, connected, cursor).cursor;
    const passed = after({ revision: attempt * 3 + 1 });
    passed.nodes[0].attempt = attempt; passed.nodes[0].receiptIds = [`pass-${attempt}`]; passed.nodes[1].attempt = attempt;
    const result = selectWorldExecution(passed, connected, cursor); cursor = result.cursor;
    assert.equal(result.view.handoffs.length, 1); ids.add(result.view.handoffs[0].id);
    assert.equal(Object.keys(cursor.emitted).length, 1); assert.equal(Object.keys(cursor.armed).length, 1);
  }
  assert.equal(ids.size, 40);
});
test('history refs and planning progress preserve original bindings without pretending live work', () => {
  const historical = node('analysis', 'ai-analyze', { sourceRunId: 'old-run', sourcePlanHash: 'old-plan', status: 'running', receiptIds: ['old-receipt'] });
  const view = projectWorldExecution(snapshot([historical], { workflowProgress: [{ nodeId: 'plan', action: 'ai-plan',
    sourceRunId: 'old-run', planHash: 'old-plan', title: 'План', status: 'passed', receiptIds: ['plan-receipt'], artifacts: [artifact] }] }), connected);
  assert.equal(view.workers.length, 2); assert.ok(view.workers.every(item => item.historical && !item.active && item.state === 'history'));
  assert.equal(view.workers[0].runId, 'old-run'); assert.equal(view.workers[1].receiptIds[0], 'plan-receipt');
});
test('projection never mutates input; revisions and attempt timestamps are required for live transitions', () => {
  const source = before(); const copy = JSON.parse(JSON.stringify(source));
  const baseline = selectWorldExecution(source, connected); selectWorldExecution(after(), connected, baseline.cursor);
  assert.deepEqual(source, copy);
  const projected = projectWorldExecution(source, connected); projected.workers[0].receiptIds.push('local-only');
  assert.deepEqual(source, copy);
  assert.equal(selectWorldExecution(before({ revision: undefined }), connected).cursor, null);
  assert.equal(selectWorldExecution(before({ planHash: undefined }), connected).cursor, null);
});
