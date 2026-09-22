import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskSpecSchema } from './lib/schemas.mjs';
import { compilePlan } from './lib/validator.mjs';
import { initialNodes, reconcile, calculateCapabilities } from './lib/state.mjs';
const hash = 'a'.repeat(64);
const skills = [
  'project-context',
  'clean-implementation',
  'testing',
  'delivery-pipeline',
  'code-review',
].map((id) => ({ id, path: `.agents/skills/${id}/SKILL.md`, hash }));
function fixture() {
  const task = TaskSpecSchema.parse({
    schemaVersion: 2,
    id: 'ORCH-STATE',
    goal: 'Документ',
    instructions: 'Создать документ',
    scope: ['docs/'],
    acceptance: ['Есть документ'],
    checks: [],
    sourceHash: hash,
  });
  const { plan } = compilePlan(task, { runtimeHash: hash, skills });
  const state = {
    runId: 'run-state',
    revision: 0,
    status: 'pending',
    finalDisposition: null,
    activeOperation: null,
    operations: {},
    recovered: false,
    permissions: [],
    nodes: initialNodes(plan),
    planVersion: 1,
    maxReplans: 2,
  };
  return { plan, state };
}
const runner = { ai: { available: true }, checks: { available: true } };
test('dependency readiness and permission gates are owned by reducer', () => {
  const { state, plan } = fixture();
  const waiting = reconcile(state, plan);
  assert.equal(waiting.nodes['approve-plan'].status, 'waiting-for-human');
  assert.equal(waiting.nodes.analyze.status, 'pending');
  waiting.nodes['approve-plan'].status = 'passed';
  assert.equal(reconcile(waiting, plan).nodes.analyze.status, 'pending');
  waiting.permissions = ['ai.read'];
  assert.equal(reconcile(waiting, plan).nodes.analyze.status, 'ready');
  assert.equal(state.nodes['approve-plan'].status, 'pending');
});
test('failed and uncertain do not unblock dependencies or unsafe retry', () => {
  const { state, plan } = fixture();
  state.nodes['approve-plan'].status = 'passed';
  state.permissions = ['ai.read', 'workspace.source.write'];
  state.nodes.analyze.status = 'failed';
  const failed = reconcile(state, plan);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.nodes.implement.status, 'pending');
  assert.equal(calculateCapabilities(failed, plan, { runner }).nodes.analyze.retry.allowed, false);
  failed.status = 'uncertain';
  failed.nodes.analyze.status = 'uncertain';
  assert.equal(calculateCapabilities(failed, plan, { runner }).run.run.allowed, false);
  assert.equal(calculateCapabilities(failed, plan, { runner }).run.recover.allowed, true);
});
test('retry requires backend retrySafe, budget, dependencies and runner availability', () => {
  const { state, plan } = fixture();
  state.status = 'failed';
  state.nodes.implement.status = 'passed';
  const node = state.nodes['workspace-check'];
  node.status = 'failed';
  node.attempts = 1;
  assert.equal(
    calculateCapabilities(state, plan, { runner }).nodes['workspace-check'].retry.allowed,
    false,
  );
  node.retrySafe = true;
  assert.equal(
    calculateCapabilities(state, plan, { runner }).nodes['workspace-check'].retry.allowed,
    true,
  );
  node.attempts = 2;
  assert.equal(
    calculateCapabilities(state, plan, { runner }).nodes['workspace-check'].retry.allowed,
    false,
  );
});
test('stale, active operation and missing integrity suppress controls', () => {
  const { state, plan } = fixture();
  const waiting = reconcile(state, plan);
  assert.equal(calculateCapabilities(waiting, plan, { runner }).run.approve.allowed, true);
  waiting.activeOperation = 'operation-busy';
  assert.equal(calculateCapabilities(waiting, plan, { runner }).run.approve.allowed, false);
  assert.equal(calculateCapabilities(waiting, plan, { runner }).run.stop.allowed, true);
  waiting.activeOperation = null;
  waiting.status = 'stale';
  assert.equal(calculateCapabilities(waiting, plan, { runner }).run.approve.allowed, false);
  assert.equal(
    calculateCapabilities(reconcile(state, plan), plan, { runner, integrity: false }).run.approve
      .allowed,
    false,
  );
});

test('cancelled run cannot resume the old plan but can prepare a new one', () => {
  const { state: cancelled, plan } = fixture();
  cancelled.status = 'cancelled';
  const capabilities = calculateCapabilities(cancelled, plan, { runner });
  assert.equal(capabilities.run.run.allowed, false);
  assert.equal(capabilities.run.retry.allowed, false);
  assert.equal(capabilities.run.requestReplan.allowed, true);
});

test('orphan ownership allows only recovery until stop proof is persisted', () => {
  const { state, plan } = fixture();
  const waiting = reconcile(state, plan);
  waiting.activeOperation = {
    id: 'op-orphan',
    digest: 'a'.repeat(64),
    ownerPid: 123,
    ownerStart: null,
    nodeId: 'workspace-check',
    process: null,
    startedAt: new Date().toISOString(),
  };
  waiting.operations['op-orphan'] = { digest: 'a'.repeat(64), status: 'running' };
  waiting.nodes['workspace-check'].status = 'running';
  waiting.status = 'running';
  let capabilities = calculateCapabilities(waiting, plan, { runner, orphan: true });
  assert.equal(capabilities.run.recover.allowed, true);
  assert.equal(capabilities.run.stop.allowed, false);
  assert.equal(capabilities.run.requestReplan.allowed, false);
  assert.equal(capabilities.nodes['workspace-check'].requestReplan.allowed, false);

  waiting.activeOperation.id = 'op-recovery-owner';
  waiting.activeOperation.ownerStart = 'b'.repeat(64);
  waiting.operations['op-orphan'].status = 'failed';
  waiting.operations['op-recovery-owner'] = { digest: 'b'.repeat(64), status: 'running' };
  capabilities = calculateCapabilities(waiting, plan, { runner, orphan: true });
  assert.equal(capabilities.run.recover.allowed, true, 'crashed recovery remains recoverable');

  waiting.activeOperation = null;
  waiting.operations['op-orphan'].status = 'failed';
  waiting.operations['op-recovery-owner'].status = 'failed';
  waiting.nodes['workspace-check'].status = 'uncertain';
  waiting.status = 'uncertain';
  waiting.recovered = false;
  capabilities = calculateCapabilities(waiting, plan, { runner });
  assert.equal(capabilities.run.requestReplan.allowed, false);
  waiting.recovered = true;
  capabilities = calculateCapabilities(waiting, plan, { runner });
  assert.equal(capabilities.run.requestReplan.allowed, true);
  waiting.planVersion = waiting.maxReplans + 1;
  capabilities = calculateCapabilities(waiting, plan, { runner });
  assert.equal(capabilities.run.requestReplan.allowed, true,
    'после подтвержденной остановки можно создать новый план с новым human gate');
  waiting.recovered = false;
  capabilities = calculateCapabilities(waiting, plan, { runner });
  assert.equal(capabilities.run.requestReplan.allowed, false);
  capabilities = calculateCapabilities(waiting, plan, { runner, semanticUncertainty: true });
  assert.equal(capabilities.run.requestReplan.allowed, true,
    'Завершенная неопределенная проверка допускает новый согласуемый план');
});

test('superseded run exposes only terminal recovery for an orphan recovery owner', () => {
  const { state, plan } = fixture();
  const waiting = reconcile(state, plan);
  waiting.status = 'stale';
  waiting.finalDisposition = 'superseded';
  waiting.activeOperation = {
    id: 'op-recovery-terminal',
    digest: 'b'.repeat(64),
    ownerPid: 123,
    ownerStart: 'b'.repeat(64),
    nodeId: null,
    process: null,
    startedAt: new Date().toISOString(),
  };
  waiting.operations['op-replan'] = {
    digest: 'a'.repeat(64),
    status: 'finished',
    resultRunId: 'run-successor',
    preparationHash: 'c'.repeat(64),
  };
  waiting.operations['op-recovery-terminal'] = {
    digest: 'b'.repeat(64),
    status: 'running',
  };
  let capabilities = calculateCapabilities(waiting, plan, { runner, orphan: true });
  assert.equal(capabilities.run.recover.allowed, false);
  capabilities = calculateCapabilities(waiting, plan, {
    runner,
    orphan: true,
    terminalRecovery: true,
  });
  assert.equal(capabilities.run.recover.allowed, true);
  assert.equal(capabilities.run.run.allowed, false);
  assert.equal(capabilities.run.stop.allowed, false);
  assert.equal(capabilities.run.requestReplan.allowed, false);
});
