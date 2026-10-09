import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GraphStore } from './lib/store.mjs';
import { hashObject, GraphError } from './lib/io.mjs';
import { ReceiptSchema, RunStateSchema } from './lib/schemas.mjs';
import { recoverRun } from './lib/service-recovery.mjs';

const hash = (value) => hashObject(value);
const date = '2026-10-08T00:00:00.000Z';
const processInfo = { pid: 999999, ticket: 'stage-boundary-process' };
const termination = { stopped: true, uncertain: false, timedOut: false, outputLimit: false,
  signal: null, ticketHash: hash(processInfo), execution: null };
const definition = (id, actionId) => ({ id, action: { id: actionId, version: 1 } });
const plan = { schemaVersion: 3, version: 1, runtimeHash: hash('runtime'),
  nodes: [definition('step-one', 'ai-implement'), definition('s01-workspace-check', 'workspace-check'),
    definition('s01-check-tests', 'check-tests'), definition('step-two', 'ai-implement'),
    definition('workspace-check', 'workspace-check'), definition('tests', 'check-tests'),
    definition('review', 'ai-review'), definition('handoff', 'artifact-handoff')],
  executionStages: { version: 1, stages: [
    { id: 'stage-01', implementationNodeIds: ['step-one'], scopeCheckNodeId: 's01-workspace-check', checkNodeIds: ['s01-check-tests'], boundaryNodeId: 's01-check-tests' },
    { id: 'stage-02', implementationNodeIds: ['step-two'], scopeCheckNodeId: 'workspace-check', checkNodeIds: ['tests'], boundaryNodeId: 'handoff' },
  ], finalCheckNodeIds: ['tests'], finalReviewNodeId: 'review', handoffNodeId: 'handoff' } };

function fixture(t, { mutateState = () => {}, mutateReceipt = () => {}, orphan = () => true,
  currentHash = hash('result'), inspectProcess = () => termination, failAtFinish = null } = {}) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-stage-recovery-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new GraphStore(root);
  const task = { id: 'TASK-RECOVERY' };
  const runId = 'run-stage-recovery';
  const boundary = ReceiptSchema.parse({ schemaVersion: 2, runId, nodeId: 's01-check-tests', attemptId: 'attempt-one', attempt: 1,
    phase: 'finished', actionId: 'check-tests', actionVersion: 1, planVersion: 1, planHash: hash(plan), taskHash: hash(task),
    sourceHash: hash('source'), runtimeHash: plan.runtimeHash, instructionsHash: hash('instructions'), skills: [], permissions: [],
    grantedPermissions: [], termination, startedAt: date, finishedAt: date, durationMs: 0, exitCode: 0, verdict: 'pass',
    checks: [], artifacts: [], changedFiles: [], failureReason: null, beforeFingerprint: hash('result'), afterFingerprint: hash('result'),
    actor: 'fixture', operationId: 'execution-operation', previousReceipt: null });
  mutateReceipt(boundary);
  const boundaryReceiptId = store.putObject('receipts', boundary);
  const node = (status, receipts = []) => ({ status, attempts: status === 'passed' ? 1 : 0, receipts,
    artifacts: [], checks: [], changedFiles: [], reason: null, startedAt: status === 'passed' ? date : null,
    finishedAt: status === 'passed' ? date : null, durationMs: status === 'passed' ? 0 : null, retrySafe: false });
  const nodes = Object.fromEntries(plan.nodes.map((entry, index) => [entry.id, node(index < 3 ? 'passed' : 'pending', index === 2 ? [boundaryReceiptId] : [])]));
  const hold = { kind: 'learning-hold', holdId: hash('hold'), stageId: 'stage-01', boundaryReceiptId, resultHash: hash('result'), createdAt: date, materialHash: hash('material') };
  let initial = { schemaVersion: 3, runId, revision: 0, taskHash: hash(task), planHash: hash(plan), envelopeHash: hash('envelope'),
    sourceHash: hash('source'), sourceBundle: 'bundles/source', planVersion: 1, maxReplans: 2, supersedesRunId: null, createdAt: date,
    updatedAt: date, status: 'learning-hold', finalDisposition: null, nodes, permissions: ['ai.read', 'workspace.source.write'],
    binding: { worktree: root, taskId: task.id, attemptId: 1, leaseId: 'lease-one', sourceHash: hash('source'), runId },
    workspaceFingerprint: { hash: hash('result') }, initialFingerprint: { hash: hash('source') },
    activeOperation: { id: 'execution-operation', digest: hash('execution'), ownerPid: 999999, ownerStart: hash('old-owner'),
      nodeId: 's01-check-tests', process: processInfo, startedAt: date },
    operations: { 'execution-operation': { digest: hash('execution'), status: 'running' } }, planningArtifacts: [], actor: 'fixture',
    intakeHash: hash('intake'), createOperationId: 'create-operation', setupPending: false, stopRequested: false, stopResult: null,
    continuation: hold, learning: { version: 1, mode: 'after-stage', stages: { 'stage-01': { boundaryReceiptId, materialHash: hold.materialHash, materialError: null } },
      eventIds: [], jobs: {}, progress: { [hold.materialHash]: 'unread' } } };
  mutateState(initial);
  initial = RunStateSchema.parse(initial);
  store.createRun(runId, initial);
  let inspected = 0, orphanChecks = 0, recoveryReceipts = 0;
  const digest = hash('recovery');
  const request = { operationId: 'recovery-operation', expectedRevision: 0, planHash: hash(plan) };
  const host = {
    store, ownerStart: hash('new-owner'),
    orphan: (state) => { orphanChecks++; return orphan(state, orphanChecks); },
    adapters: { inspectProcess: async (info) => { inspected++; return inspectProcess(info); }, fingerprint: () => ({ hash: currentHash }) },
    write: (previous, patch) => {
      if (failAtFinish === 'before' && patch.activeOperation === null) throw new GraphError('INJECTED_WRITE_FAILURE', 'Before committed recovery');
      const result = store.updateRun(previous.runId, previous.revision, (current) => RunStateSchema.parse({ ...current, ...patch }));
      if (failAtFinish === 'after' && patch.activeOperation === null) throw new GraphError('INJECTED_WRITE_FAILURE', 'After committed recovery');
      return result;
    },
    snapshot: (id) => RunStateSchema.parse(store.readRun(id)),
    persistFingerprint: (value) => value,
    finishReplan: () => { throw new Error('A hold must not finish successor bookkeeping'); },
    receipt: (_state, _task, _plan, def, data) => { recoveryReceipts++;
      return store.putObject('receipts', { ...boundary, ...data, nodeId: def.id, actionId: def.action.id }); },
  };
  return { store, initial, host, boundaryReceiptId, runId, current: () => store.readRun(runId),
    calls: () => ({ inspected, orphanChecks, recoveryReceipts }),
    recover: () => recoverRun(host, { state: store.readRun(runId), task, plan, request, digest, actor: 'fixture' }) };
}

function assertHoldUnchanged(fx, current = fx.current()) {
  assert.equal(current.status, 'learning-hold');
  assert.deepEqual(current.continuation, fx.initial.continuation);
  assert.deepEqual(current.learning, fx.initial.learning);
  assert.deepEqual(current.nodes, fx.initial.nodes);
  assert.deepEqual(current.workspaceFingerprint, fx.initial.workspaceFingerprint);
  assert.deepEqual(current.permissions, fx.initial.permissions);
}

test('a committed hold recovers only bookkeeping, reusing durable process-stop evidence', async (t) => {
  const fx = fixture(t);
  const recovered = await fx.recover();
  assertHoldUnchanged(fx, recovered);
  assert.equal(recovered.activeOperation, null);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.operations['recovery-operation'].status, 'finished');
  assert.equal(recovered.operations['execution-operation'].status, 'failed');
  assert.equal(recovered.revision, 2);
  assert.equal(fx.calls().inspected, 0);
  assert.equal(fx.calls().recoveryReceipts, 0);
  assert.ok(fx.calls().orphanChecks >= 1);
});

test('recorded child stop does not substitute for proof that the displaced owner is dead', async (t) => {
  const fx = fixture(t, { orphan: () => false });
  await assert.rejects(fx.recover(), { code: 'PROCESS_UNCERTAIN' });
  assertHoldUnchanged(fx);
  assert.deepEqual(fx.current(), fx.initial);
  assert.equal(fx.calls().inspected, 0);
});

test('owner death is rechecked after awaited process inspection', async (t) => {
  const fx = fixture(t, { orphan: (_state, calls) => calls === 1,
    mutateReceipt: (receipt) => { receipt.termination.ticketHash = null; } });
  await assert.rejects(fx.recover(), { code: 'PROCESS_UNCERTAIN' });
  assertHoldUnchanged(fx);
  assert.deepEqual(fx.current().activeOperation, fx.initial.activeOperation);
  assert.equal(fx.current().operations['recovery-operation'].status, 'failed');
  assert.equal(fx.calls().inspected, 1);
});

test('a stopped process inspected from its metadata can preserve an independently committed hold', async (t) => {
  const fx = fixture(t, { mutateReceipt: (receipt) => { receipt.termination.ticketHash = null; } });
  await fx.recover();
  assertHoldUnchanged(fx);
  assert.equal(fx.calls().inspected, 1);
});

test('missing process metadata still requires a dead displaced owner', async (t) => {
  const fx = fixture(t, { mutateState: (state) => { state.activeOperation.process = null; } });
  await fx.recover();
  assertHoldUnchanged(fx);
  assert.equal(fx.current().activeOperation, null);
  assert.ok(fx.calls().orphanChecks >= 1);
});

test('workspace drift preserves the hold and restores the stale active operation', async (t) => {
  const fx = fixture(t, { currentHash: hash('changed-files') });
  await assert.rejects(fx.recover(), { code: 'LEARNING_HOLD_RECOVERY_UNSAFE' });
  assertHoldUnchanged(fx);
  assert.deepEqual(fx.current().activeOperation, fx.initial.activeOperation);
  assert.equal(fx.current().operations['execution-operation'].status, 'running');
  assert.equal(fx.current().operations['recovery-operation'].status, 'failed');
  assert.equal(fx.calls().recoveryReceipts, 0);
});

for (const status of ['running', 'uncertain', 'failed', 'cancelled']) test(`a ${status} node cannot be recovered into a successful hold`, async (t) => {
  const fx = fixture(t, { mutateState: (state) => { state.nodes['step-two'].status = status; } });
  await assert.rejects(fx.recover(), { code: 'LEARNING_HOLD_RECOVERY_UNSAFE' });
  assertHoldUnchanged(fx);
  assert.deepEqual(fx.current().activeOperation, fx.initial.activeOperation);
  assert.equal(fx.calls().recoveryReceipts, 0);
});

for (const [name, mutateState] of [
  ['uncommitted loose boundary receipt', (state) => { state.nodes['s01-check-tests'].receipts = []; }],
  ['pending prior implementation', (state) => { state.nodes['step-one'].status = 'pending'; }],
  ['missing saved stage', (state) => { delete state.learning.stages['stage-01']; }],
  ['different saved material', (state) => { state.learning.stages['stage-01'].materialHash = null; }],
  ['different stored result', (state) => { state.workspaceFingerprint.hash = hash('other-result'); }],
  ['final stage', (state) => { state.continuation.stageId = 'stage-02'; }],
  ['failure state', (state) => { state.failureReason = 'Unresolved capture failure'; }],
  ['stop bookkeeping', (state) => { state.stopResult = { operationId: 'stop-operation', requestedAt: date, state: 'stopped', reason: null }; }],
  ['successor preparation', (state) => { state.operations.successor = { digest: hash('successor'), status: 'creating', resultRunId: 'run-next', preparationHash: hash('preparation') }; }],
]) test(`recovery fails closed for ${name} without erasing a committed hold`, async (t) => {
  const fx = fixture(t, { mutateState });
  await assert.rejects(fx.recover(), { code: 'LEARNING_HOLD_RECOVERY_UNSAFE' });
  assertHoldUnchanged(fx);
  assert.deepEqual(fx.current().activeOperation, fx.initial.activeOperation);
  assert.equal(fx.calls().recoveryReceipts, 0);
});

for (const [name, mutateReceipt] of [
  ['another run', (receipt) => { receipt.runId = 'run-other'; }],
  ['another plan', (receipt) => { receipt.planHash = hash('other-plan'); }],
  ['another task', (receipt) => { receipt.taskHash = hash('other-task'); }],
  ['another source', (receipt) => { receipt.sourceHash = hash('other-source'); }],
  ['another runtime', (receipt) => { receipt.runtimeHash = hash('other-runtime'); }],
  ['another node', (receipt) => { receipt.nodeId = 'step-two'; }],
  ['another action', (receipt) => { receipt.actionId = 'check-lint'; }],
  ['another attempt', (receipt) => { receipt.attempt = 2; }],
  ['non-final receipt', (receipt) => { receipt.phase = 'recovery'; }],
  ['failed verdict', (receipt) => { receipt.verdict = 'fail'; }],
  ['failed exit code', (receipt) => { receipt.exitCode = 1; }],
  ['unproven stop', (receipt) => { receipt.termination.stopped = false; }],
  ['uncertain termination', (receipt) => { receipt.termination.uncertain = true; }],
  ['different result fingerprint', (receipt) => { receipt.afterFingerprint = hash('other-result'); }],
  ['source-writing boundary', (receipt) => { receipt.beforeFingerprint = hash('earlier-result'); }],
]) test(`boundary evidence from ${name} cannot preserve recovery success`, async (t) => {
  const fx = fixture(t, { mutateReceipt });
  await assert.rejects(fx.recover(), { code: 'LEARNING_HOLD_RECOVERY_UNSAFE' });
  assertHoldUnchanged(fx);
  assert.deepEqual(fx.current().activeOperation, fx.initial.activeOperation);
});

for (const failAtFinish of ['before', 'after']) test(`a recovery write fault ${failAtFinish} commit cannot remove the durable hold`, async (t) => {
  const fx = fixture(t, { failAtFinish });
  await assert.rejects(fx.recover(), { code: 'INJECTED_WRITE_FAILURE' });
  assertHoldUnchanged(fx);
  assert.equal(fx.current().operations['recovery-operation'].status, failAtFinish === 'before' ? 'failed' : 'finished');
  assert.deepEqual(fx.current().activeOperation, failAtFinish === 'before' ? fx.initial.activeOperation : null);
});

test('an interrupted open run never adopts an uncommitted hold or promotes receipt success', async (t) => {
  const fx = fixture(t, { mutateState: (state) => {
    state.continuation = { kind: 'open' }; state.status = 'uncertain'; state.learning.stages = {};
    state.nodes['s01-check-tests'].status = 'uncertain';
    state.nodes['s01-check-tests'].process = processInfo;
  } });
  const recovered = await fx.recover();
  assert.equal(recovered.status, 'uncertain');
  assert.equal(recovered.continuation.kind, 'open');
  assert.equal(recovered.nodes['s01-check-tests'].status, 'uncertain');
  assert.equal(recovered.nodes['step-two'].status, 'pending');
  assert.equal(recovered.activeOperation, null);
  assert.equal(fx.calls().recoveryReceipts, 1);
});
