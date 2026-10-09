import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { GraphStore } from './lib/store.mjs';
import { GraphError, hashObject, sha256 } from './lib/io.mjs';
import { GraphPlanV3Schema, TaskSpecV3Schema, ReceiptSchema } from './lib/schemas.mjs';
import { captureLearningSources } from './lib/learning-sources.mjs';
import { createLearningMaterial, readLearningMaterial } from './lib/learning-material.mjs';
import { prepareLearningProvider, readPreparedLearningInput, parseLearningProviderOutput, disposeLearningProvider } from './lib/learning-provider.mjs';
import { readLearningMethod } from './lib/learning-prompt.mjs';
import { LearningJobs } from './lib/learning-jobs.mjs';
import { LearningJobRecordSchema, readLearningJobs } from './lib/learning-job-state.mjs';

const hash = hashObject('learning-jobs-fixture');
const stamp = '2026-10-08T12:00:00.000Z';
const complete = (extra = {}) => ({ exitCode: 0, stopped: true, uncertain: false, timedOut: false,
  outputLimit: false, signal: null, failureReason: null, ...extra });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const executionPart = ({ learning: _learning, operations: _operations, revision: _revision, ...state }) => state;

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-learning-jobs-'))), store = new GraphStore(root);
  const preparedHandles = [], calls = { prepared: 0, executed: 0, dispatched: 0, disposed: 0, inspected: 0 };
  const runtime = { output: null, completion: null, throwAfterStart: false, beforeGo: null, prepareGate: null,
    policy: { denyGlobs: [], outputPaths: [], forbiddenPaths: [] }, orphan: false, stopProof: { stopped: true, uncertain: false } };
  const task = TaskSpecV3Schema.parse({ schemaVersion: 3, id: 'LEARNING-JOBS', goal: 'Объяснить счетчик', instructions: 'Объяснить сохраненный код',
    scope: ['counter.custom'], acceptance: ['Счетчик обновляется'], checks: ['verify-code'], sourceHash: hash });
  const taskHash = store.putObject('tasks', task);
  const node = (id, action, kind) => ({ id, title: id, outcome: id, needs: [], action: { id: action, version: 1, inputs: {} },
    success: { kind, requiredArtifacts: [] }, permissions: [], skills: [], resources: { reads: ['counter.custom'], writes: [], exclusive: [] }, retry: { maxAttempts: 1, backoffMs: 0 } });
  const checks = { version: 1, profileHash: hash, definitions: [], bindings: [] };
  // Executor evidence is a fixture, not a claim that a real task/provider ran. L1 validates the actual bindings and receipts.
  const plan = GraphPlanV3Schema.parse({ schemaVersion: 3, stage: 'execution', taskHash, version: 1, parentPlanHash: null,
    sourceHash: hash, runtimeHash: hash, registryHash: hash, policyHash: hash, skills: [], checkRegistryHash: hashObject(checks), checks,
    learning: { version: 1, initialMode: 'after-stage' },
    taskContract: { version: 1, goal: task.goal, instructionsHash: hash, requirements: [{ id: 'req-count', title: task.goal, mandatory: true, origin: 'acceptance',
      verification: { method: 'check', checkIds: ['verify-code'], criterion: 'Счетчик обновляется', paths: ['counter.custom'] }, workIds: ['implement'] }],
    optionalImprovements: [], constraints: [], assumptions: [], unknowns: [], scope: task.scope, forbiddenPaths: [], rigor: { level: 'light', reasons: ['Fixture'] } },
    nodes: [node('implement', 'ai-implement', 'implementation'), node('scope-check', 'workspace-check', 'checks'), node('check-code', 'check-verify-code', 'checks'),
      node('review', 'ai-review', 'review'), node('handoff', 'artifact-handoff', 'handoff')],
    executionStages: { version: 1, stages: [{ id: 'stage-one', title: 'Счетчик', outcome: 'Счетчик обновлен', implementationNodeIds: ['implement'], requirementIds: ['req-count'],
      scopeCheckNodeId: 'scope-check', checkNodeIds: ['check-code'], boundaryNodeId: 'handoff' }], finalCheckNodeIds: ['check-code'], finalReviewNodeId: 'review', handoffNodeId: 'handoff' } });
  const planHash = store.putObject('plans', plan), runId = 'run-learning', binding = { runId, planHash, taskHash };
  const capture = (text, role, sourceHash) => {
    writeFileSync(path.join(root, 'counter.custom'), text);
    return captureLearningSources({ store, projectRoot: root, sourceHash, files: [{ path: 'counter.custom', role,
      expected: { hash: sha256(text), size: Buffer.byteLength(text), mode: '100644' } }] });
  };
  const before = capture('count = 1\n', 'before', hash), resultHash = hashObject('count-2');
  store.putObject('operations', { before });
  const after = capture('count = 2\n', 'after', resultHash);
  const receipt = (nodeId, actionId, beforeFingerprint = resultHash) => store.putObject('receipts', ReceiptSchema.parse({
    schemaVersion: 2, ...binding, nodeId, attemptId: 'attempt-one', attempt: 1, phase: 'finished', actionId, actionVersion: 1, planVersion: 1,
    sourceHash: hash, runtimeHash: hash, instructionsHash: hash, skills: [], permissions: [], grantedPermissions: [],
    termination: { stopped: true, uncertain: false, timedOut: false, outputLimit: false, signal: null, ticketHash: null, execution: null },
    startedAt: stamp, finishedAt: stamp, durationMs: 0, exitCode: 0, verdict: 'pass', checks: [], artifacts: [], changedFiles: [], failureReason: null,
    beforeFingerprint, afterFingerprint: resultHash, actor: 'fixture', operationId: 'execution-one', previousReceipt: null }));
  const implementation = receipt('implement', 'ai-implement', hash), scope = receipt('scope-check', 'workspace-check'), check = receipt('check-code', 'check-verify-code');
  const saved = createLearningMaterial({ store, binding, stageId: 'stage-one', before, after,
    implementationReceiptIds: [implementation], checkReceiptIds: [scope, check], reviewReceiptIds: [] });
  const options = { store, materialHash: saved.id, binding: { ...binding, materialHashes: [saved.id] }, policy: runtime.policy };
  const source = readLearningMaterial(options).sources.find((entry) => entry.role === 'after');
  const anchor = { sourceId: source.id, fileHash: source.fileHash, startLine: 1, endLine: 1, quote: 'count = 2' };
  const body = { title: 'Счетчик', scope: 'counter.custom', steps: [{ id: 'count', title: 'Присваивание', caller: 'Учебный пример', anchors: [anchor], input: 'Значение 2',
    transformations: ['Записать значение в count'], output: 'count = 2', next: null, purpose: 'Сохранить значение', changeConsequence: 'Изменится значение count', alternatives: [],
    origin: { kind: 'teaching-example', label: 'Учебный пример', receiptId: null, artifactId: null, anchor: null } }],
    questions: [], wholeFlow: 'Присваивание сохраняет значение', takeaways: ['Проследить вход и результат'], limitations: ['Это fixture, код не запускался.'] };
  const initial = { schemaVersion: 3, ...binding, revision: 0, setupPending: false, status: 'learning-hold', permissions: ['workspace.source.write'],
    nodes: { implement: { status: 'passed', receipts: [implementation] }, 'check-code': { status: 'passed', receipts: [check] } },
    workspaceFingerprint: { hash: resultHash }, activeOperation: null, operations: {}, proof: { status: 'UNPROVEN', fixture: true },
    continuation: { kind: 'learning-hold', holdId: hashObject('hold'), stageId: 'stage-one', boundaryReceiptId: check, resultHash, createdAt: stamp, materialHash: saved.id },
    learning: { version: 1, mode: 'after-stage', stages: { 'stage-one': { boundaryReceiptId: check, materialHash: saved.id, materialError: null } },
      captures: { 'stage-one': { before, after } }, eventIds: [], jobs: {}, progress: {} } };
  store.createRun(runId, initial);
  const read = (id) => {
    const state = store.readRun(id);
    return { state, plan: store.readObject('plans', state.planHash), task: store.readObject('tasks', state.taskHash) };
  };
  const host = { root, store, read,
    write: (state, update) => store.updateRun(state.runId, state.revision, (current) => ({ ...current, ...update })),
    snapshot: (id) => store.readRun(id), ownerStart: hashObject('owner-current'),
    executionHistory: (state) => { const history = []; while (state.supersedesRunId) { const source = read(state.supersedesRunId); history.push(source); state = source.state; } return history; },
    adapters: { learningSourcePolicy: () => runtime.policy },
    orphan: () => runtime.orphan,
    inspectProcess: async () => { calls.inspected++; return runtime.stopProof; },
    safeReason: (error) => error instanceof Error ? error.message : String(error), runner: () => runner };
  const runner = {
    capability: () => ({ allowed: true, reason: null }),
    prepare: async (input) => {
      calls.prepared++;
      if (runtime.prepareGate) await runtime.prepareGate.promise;
      const prepared = prepareLearningProvider({ ...input, provider: 'codex', model: 'fixture-model' });
      const handle = { prepared, input: readPreparedLearningInput(prepared), inputHash: prepared.inputHash, schemaHash: prepared.schemaHash,
        methodHash: prepared.methodHash, materialHash: prepared.materialHash, preparationHash: prepared.preparationHash, kind: prepared.kind,
        providerBinding: { provider: 'fixture', model: 'fixture-model', toolchainHash: hashObject('toolchain'), preflightHash: hashObject('preflight'), policyHash: hashObject('sandbox-policy') },
        command: { executable: process.execPath, args: ['fixture-only-no-spawn'], cwd: prepared.scratch, env: {} },
        output: runtime.output ?? JSON.stringify(input.question ? { text: 'Значение счетчика равно 2.', anchors: [anchor], limitations: ['Fixture'] } : body), wait: deferred() };
      preparedHandles.push(handle);
      return handle;
    },
    beforeGo: (handle) => { assert.equal(readPreparedLearningInput(handle.prepared), handle.input); },
    execute: async (handle, callbacks) => {
      calls.executed++;
      const reopened = new GraphStore(root), state = reopened.readRun(runId);
      const record = readLearningJobs(reopened, state).find(({ job }) => job.inputHash === handle.inputHash && job.status === 'running');
      assert.ok(record, 'A complete immutable job must be durable before runner execution');
      const pinned = reopened.readObject('operations', record.job.inputObjectHash);
      assert.equal(sha256(pinned.promptParts.join('')), handle.inputHash);
      assert.equal(hashObject(pinned.control), record.job.digest);
      assert.equal(record.job.commandHash, hashObject(handle.command));
      assert.equal(record.job.methodHash, readLearningMethod().hash);
      assert.equal(record.job.schemaHash, handle.schemaHash);
      assert.equal(record.job.sourcePolicyHash, hashObject(runtime.policy));
      assert.deepEqual(record.job.providerBinding, handle.providerBinding);
      assert.deepEqual(record.job.materialBinding, binding);
      const event = reopened.readObject('learning-events', state.learning.eventIds.at(-1));
      assert.equal(record.job.consentHash, hashObject({ request: event.request, actor: event.actor, inputObjectHash: record.job.inputObjectHash,
        providerBinding: handle.providerBinding, commandHash: hashObject(handle.command) }));
      callbacks.onStart({ pid: process.pid, ticket: 'fixture-learning-process' });
      if (runtime.throwAfterStart) throw new Error('Transport failed after process reservation');
      runtime.beforeGo?.(handle);
      try { callbacks.beforeGo(); } catch (error) { return complete({ exitCode: 1, failureReason: error.code ?? 'PREFLIGHT_FAILED' }); }
      calls.dispatched++;
      return runtime.completion ?? await handle.wait.promise;
    },
    parse: (handle, completion, policy) => parseLearningProviderOutput(handle.prepared, { output: handle.output, completion, policy }),
    dispose: (handle, result) => { calls.disposed++; disposeLearningProvider(handle.prepared, result); },
  };
  const jobs = new LearningJobs(host);
  t.after(async () => {
    for (const handle of preparedHandles) handle.wait.resolve(complete({ stopped: false, uncertain: true }));
    await Promise.allSettled([...jobs.tasks.values()]);
    for (const handle of preparedHandles) if (existsSync(handle.prepared.scratch)) rmSync(handle.prepared.scratch, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  const state = () => store.readRun(runId);
  const request = (extra = {}, id = runId) => ({ operationId: `op-${randomUUID()}`, expectedRevision: store.readRun(id).revision,
    planHash: store.readRun(id).planHash, materialHash: saved.id, ...extra });
  const settle = async () => { await tick(); await Promise.allSettled([...jobs.tasks.values()]); await tick(); };
  const finish = async (completion = complete()) => { await tick(); preparedHandles.at(-1).wait.resolve(completion); await settle(); };
  const replaceJob = (id, update) => {
    const current = state(), oldHash = current.learning.jobs[id], job = store.readObject('learning-jobs', oldHash);
    const nextHash = store.putObject('learning-jobs', LearningJobRecordSchema.parse({ ...job, ...update }));
    host.write(current, { learning: { ...current.learning, jobs: { ...current.learning.jobs, [id]: nextHash } } });
    return nextHash;
  };
  return { root, store, host, runtime, runner, jobs, runId, plan, task, materialHash: saved.id, binding, body, anchor, calls, preparedHandles,
    state, request, settle, finish, replaceJob, record: (id) => readLearningJobs(store, state()).find(({ job }) => job.id === id).job };
}

async function generate(fx) {
  const started = await fx.jobs.start(fx.runId, 'generate-lesson', fx.request(), 'operator');
  await fx.finish();
  const job = fx.record(started.jobId);
  assert.equal(job.status, 'ready', JSON.stringify(job));
  return { started, job, lessonHash: job.result.lessonHash };
}

test('start returns a durable 202-style job before execute; exact replay never invokes a second provider', async (t) => {
  const fx = fixture(t), request = fx.request(), before = executionPart(fx.state());
  const response = await fx.jobs.start(fx.runId, 'generate-lesson', request, 'operator');
  assert.deepEqual(Object.keys(response).sort(), ['jobId', 'snapshot']);
  assert.equal(fx.calls.executed, 0);
  assert.equal(fx.record(response.jobId).status, 'running');
  assert.equal(fx.record(response.jobId).process, null);
  assert.deepEqual(executionPart(fx.state()), before);
  const replay = await fx.jobs.start(fx.runId, 'generate-lesson', request, 'operator');
  assert.equal(replay.jobId, response.jobId);
  assert.equal(fx.calls.prepared, 1);
  await fx.finish();
  assert.equal(fx.record(response.jobId).status, 'ready');
  assert.equal(fx.calls.dispatched, 1);
  assert.equal(fx.calls.disposed, 1);
  const revision = fx.state().revision;
  await fx.jobs.start(fx.runId, 'generate-lesson', request, 'operator');
  assert.equal(fx.state().revision, revision);
  assert.equal(fx.calls.prepared, 1);
  await assert.rejects(fx.jobs.start(fx.runId, 'generate-lesson', { ...request, materialHash: hash }, 'operator'), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.deepEqual(executionPart(fx.state()), before);
});

test('one in-flight preparation or running job is allowed, including concurrent same-operation replay', async (t) => {
  const fx = fixture(t), request = fx.request();
  fx.runtime.prepareGate = deferred();
  const first = fx.jobs.start(fx.runId, 'generate-lesson', request, 'operator');
  const replay = fx.jobs.start(fx.runId, 'generate-lesson', request, 'operator');
  await assert.rejects(fx.jobs.start(fx.runId, 'generate-lesson', fx.request(), 'operator'), { code: 'CONTROL_DENIED' });
  fx.runtime.prepareGate.resolve();
  assert.equal((await first).jobId, (await replay).jobId);
  await tick();
  await assert.rejects(fx.jobs.start(fx.runId, 'generate-lesson', fx.request(), 'operator'), { code: 'CONTROL_DENIED' });
  assert.equal(fx.calls.prepared, 1);
  await fx.finish();
});

test('a revision change while preparation awaits rejects the stale reservation without execution', async (t) => {
  const fx = fixture(t);
  fx.runtime.prepareGate = deferred();
  const pending = fx.jobs.start(fx.runId, 'generate-lesson', fx.request(), 'operator');
  const current = fx.state();
  fx.host.write(current, { learning: { ...current.learning, progress: { [fx.materialHash]: 'read' } } });
  const fresh = fx.state();
  fx.runtime.prepareGate.resolve();
  await assert.rejects(pending, { code: 'REVISION_CONFLICT' });
  assert.deepEqual(fx.state(), fresh);
  assert.equal(fx.calls.executed, 0);
  assert.equal(fx.calls.disposed, 1);
  assert.equal(existsSync(fx.preparedHandles[0].prepared.scratch), false);
});

test('source policy drift during awaited preparation is rejected before committing a job', async (t) => {
  const fx = fixture(t), before = fx.state();
  fx.runtime.prepareGate = deferred();
  const pending = fx.jobs.start(fx.runId, 'generate-lesson', fx.request(), 'operator');
  fx.runtime.policy = { ...fx.runtime.policy, outputPaths: ['new-output'] };
  fx.runtime.prepareGate.resolve();
  await assert.rejects(pending, { code: 'LEARNING_POLICY_DRIFT' });
  assert.deepEqual(fx.state(), before);
  assert.equal(fx.calls.executed, 0);
  assert.equal(fx.calls.disposed, 1);
  assert.equal(existsSync(fx.preparedHandles[0].prepared.scratch), false);
});

for (const point of ['before', 'after']) test(`a storage failure ${point} reservation commit cannot dispatch or silently retry a job`, async (t) => {
  const fx = fixture(t), originalWrite = fx.host.write, request = fx.request(), before = fx.state();
  let injected = false;
  t.mock.method(fx.host, 'write', (state, update) => {
    const reservation = Object.values(update.learning?.jobs ?? {}).some((id) => {
      const job = fx.store.readObject('learning-jobs', id);
      return job.status === 'running' && job.process === null && job.previousJobHash === null;
    });
    if (!injected && reservation) {
      injected = true;
      if (point === 'after') originalWrite(state, update);
      throw new GraphError('INJECTED_RESERVATION_WRITE', `Injected ${point} reservation commit failure`);
    }
    return originalWrite(state, update);
  });
  await assert.rejects(fx.jobs.start(fx.runId, 'generate-lesson', request, 'operator'), { code: 'INJECTED_RESERVATION_WRITE' });
  await fx.settle();
  assert.equal(injected, true);
  assert.equal(fx.calls.prepared, 1);
  assert.equal(fx.calls.executed, 0);
  assert.equal(fx.calls.disposed, 1);
  assert.equal(existsSync(fx.preparedHandles[0].prepared.scratch), false);
  if (point === 'before') {
    assert.deepEqual(fx.state(), before);
    assert.deepEqual(fx.state().learning.jobs, {});
  } else {
    const [entry] = readLearningJobs(fx.store, fx.state());
    assert.equal(entry.job.status, 'failed');
    assert.equal(entry.job.error.code, 'LEARNING_RESERVATION_INTERRUPTED');
    assert.equal(entry.job.process, null);
    assert.equal(fx.state().operations[request.operationId].status, 'finished');
    const revision = fx.state().revision;
    const replay = await fx.jobs.start(fx.runId, 'generate-lesson', request, 'operator');
    assert.equal(replay.jobId, entry.job.id);
    assert.equal(fx.record(replay.jobId).status, 'failed');
    assert.equal(fx.state().revision, revision);
    assert.equal(fx.calls.prepared, 1);
    assert.equal(fx.calls.executed, 0);
    assert.deepEqual(executionPart(fx.state()), executionPart(before));
  }
});

for (const substitution of ['command', 'policy']) test(`pre-GO ${substitution} substitution is rejected against the durable authorization`, async (t) => {
  const fx = fixture(t);
  fx.runtime.beforeGo = (handle) => {
    if (substitution === 'command') handle.command.args = ['different-command'];
    else fx.runtime.policy = { ...fx.runtime.policy, outputPaths: ['other-output'] };
  };
  const started = await fx.jobs.start(fx.runId, 'generate-lesson', fx.request(), 'operator');
  await fx.settle();
  const job = fx.record(started.jobId);
  assert.equal(job.status, 'failed');
  assert.equal(job.termination.failureReason, substitution === 'command' ? 'LEARNING_PREPARATION_CHANGED' : 'LEARNING_POLICY_DRIFT');
  assert.equal(fx.calls.dispatched, 0);
  assert.equal(fx.calls.disposed, 1);
});

test('three explicit lesson attempts are allowed; a fourth is denied without preparation', async (t) => {
  const fx = fixture(t);
  for (let attempt = 0; attempt < 3; attempt++) await generate(fx);
  assert.equal(fx.calls.prepared, 3);
  await assert.rejects(fx.jobs.start(fx.runId, 'generate-lesson', fx.request(), 'operator'), { code: 'CONTROL_DENIED' });
  assert.equal(fx.calls.prepared, 3);
  const current = fx.state(), nextPlanHash = fx.store.putObject('plans', { ...fx.plan, version: 2, parentPlanHash: fx.binding.planHash });
  fx.store.createRun('successor', { ...current, runId: 'successor', revision: 0, planHash: nextPlanHash, supersedesRunId: fx.runId,
    operations: {}, learning: { ...current.learning, jobs: {}, eventIds: [], stages: {} } });
  await assert.rejects(fx.jobs.start('successor', 'generate-lesson', fx.request({}, 'successor'), 'operator'), { code: 'CONTROL_DENIED' });
  assert.equal(fx.calls.prepared, 3, 'Moving to a successor cannot reset the same material regeneration budget');
});

test('late completion merges only fresh learning state after a concurrent Continue and execution revision', async (t) => {
  const fx = fixture(t);
  const started = await fx.jobs.start(fx.runId, 'generate-lesson', fx.request(), 'operator');
  await tick();
  const current = fx.state();
  fx.host.write(current, { continuation: { kind: 'open' }, status: 'running', permissions: [],
    nodes: { ...current.nodes, next: { status: 'running', receipts: [] } }, proof: { status: 'UNPROVEN', newerEvidence: hash },
    operations: { ...current.operations, continue: { digest: hashObject('continue'), status: 'finished' } },
    learning: { ...current.learning, mode: 'after-task', progress: { [fx.materialHash]: 'deferred' } } });
  const fresh = fx.state();
  await fx.finish();
  assert.equal(fx.record(started.jobId).status, 'ready');
  assert.deepEqual(executionPart(fx.state()), executionPart(fresh));
  assert.deepEqual(fx.state().operations, fresh.operations);
  assert.equal(fx.state().learning.mode, 'after-task');
  assert.deepEqual(fx.state().learning.progress, fresh.learning.progress);
  assert.deepEqual(fx.state().learning.stages, fresh.learning.stages);
});

test('completion retries a CAS conflict against fresh state without losing concurrent progress', async (t) => {
  const fx = fixture(t), originalWrite = fx.host.write;
  let conflicted = false;
  t.mock.method(fx.host, 'write', (state, update) => {
    const jobHashes = Object.values(update.learning?.jobs ?? {});
    if (!conflicted && jobHashes.some((id) => fx.store.readObject('learning-jobs', id).status === 'ready')) {
      conflicted = true;
      originalWrite(state, { learning: { ...state.learning, progress: { [fx.materialHash]: 'read' } } });
      throw new GraphError('REVISION_CONFLICT', 'Concurrent progress committed first');
    }
    return originalWrite(state, update);
  });
  const result = await generate(fx);
  assert.equal(conflicted, true);
  assert.equal(result.job.status, 'ready');
  assert.equal(fx.state().learning.progress[fx.materialHash], 'read');
  assert.equal(fx.calls.executed, 1);
});

for (const failure of ['nonzero', 'invalid-anchor']) test(`${failure} lesson failure preserves executor state and does not retry`, async (t) => {
  const fx = fixture(t), before = executionPart(fx.state());
  if (failure === 'invalid-anchor') {
    const invalid = structuredClone(fx.body); invalid.steps[0].anchors[0].quote = 'count = 99'; fx.runtime.output = JSON.stringify(invalid);
  }
  const started = await fx.jobs.start(fx.runId, 'generate-lesson', fx.request(), 'operator');
  await fx.finish(failure === 'nonzero' ? complete({ exitCode: 7 }) : complete());
  const job = fx.record(started.jobId);
  assert.equal(job.status, 'failed');
  assert.equal(job.result, null);
  assert.equal(job.error.code, failure === 'nonzero' ? 'LEARNING_PROVIDER_INCOMPLETE' : 'LEARNING_ANCHOR_INVALID');
  assert.deepEqual(executionPart(fx.state()), before);
  assert.equal(fx.calls.prepared, 1); assert.equal(fx.calls.disposed, 1);
});

for (const failure of ['unknown-stop', 'transport-throw']) test(`${failure} retains uncertain job/scratch and blocks another job`, async (t) => {
  const fx = fixture(t), before = executionPart(fx.state());
  fx.runtime.throwAfterStart = failure === 'transport-throw';
  const started = await fx.jobs.start(fx.runId, 'generate-lesson', fx.request(), 'operator');
  if (failure === 'unknown-stop') await fx.finish(complete({ stopped: false, uncertain: true })); else await fx.settle();
  assert.equal(fx.record(started.jobId).status, 'uncertain');
  assert.equal(fx.calls.disposed, 0);
  assert.ok(existsSync(fx.preparedHandles[0].prepared.scratch));
  await assert.rejects(fx.jobs.start(fx.runId, 'generate-lesson', fx.request(), 'operator'), { code: 'CONTROL_DENIED' });
  assert.equal(fx.calls.prepared, 1);
  assert.deepEqual(executionPart(fx.state()), before);
});

for (const process of ['known-stopped', 'unknown', 'not-started']) test(`startup ${process} job is reconciled without automatic execution or cleanup`, async (t) => {
  const fx = fixture(t);
  const started = await fx.jobs.start(fx.runId, 'generate-lesson', fx.request(), 'operator');
  if (process !== 'not-started') await tick();
  const recorded = fx.record(started.jobId);
  assert.equal(recorded.status, 'running');
  assert.equal(recorded.process === null, process === 'not-started');
  // Copy the real durable reservation/onStart history before any completion. The isolated copy has no live controller.
  const crashRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-learning-crash-')));
  t.after(() => rmSync(crashRoot, { recursive: true, force: true }));
  cpSync(fx.root, crashRoot, { recursive: true });
  const secureControlCopy = (directory) => {
    chmodSync(directory, 0o700);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) secureControlCopy(file); else chmodSync(file, 0o600);
    }
  };
  secureControlCopy(path.join(crashRoot, '.ai-orchestrator'));
  const store = new GraphStore(crashRoot), state = () => store.readRun(fx.runId);
  const job = () => readLearningJobs(store, state()).find(({ job: entry }) => entry.id === started.jobId).job;
  let inspected = 0;
  const crashHost = { ...fx.host, root: crashRoot, store,
    read: (id) => { const current = store.readRun(id); return { state: current, plan: store.readObject('plans', current.planHash), task: store.readObject('tasks', current.taskHash) }; },
    write: (current, update) => store.updateRun(current.runId, current.revision, (fresh) => ({ ...fresh, ...update })),
    snapshot: (id) => store.readRun(id), executionHistory: () => [],
    orphan: ({ activeOperation }) => { assert.equal(activeOperation.ownerPid, recorded.ownerPid); assert.equal(activeOperation.ownerStart, recorded.ownerStart); return true; },
    inspectProcess: async (metadata) => {
      inspected++; assert.deepEqual(metadata, recorded.process);
      return process === 'unknown' ? { stopped: false, uncertain: true } : { stopped: true, uncertain: false };
    },
  };
  const before = executionPart(state()), calls = { ...fx.calls }, reopened = new LearningJobs(crashHost);
  await reopened.reconcileInterrupted();
  assert.equal(job().status, process === 'unknown' ? 'uncertain' : 'failed');
  assert.equal(job().error.code, 'LEARNING_INTERRUPTED');
  assert.deepEqual(job().process, recorded.process);
  assert.equal(fx.calls.prepared, calls.prepared); assert.equal(fx.calls.executed, calls.executed); assert.equal(fx.calls.disposed, calls.disposed);
  assert.equal(inspected, process === 'not-started' ? 0 : 1);
  assert.deepEqual(executionPart(state()), before);
  if (process === 'unknown') {
    for (let restart = 0; restart < 8; restart++) await new LearningJobs(crashHost).reconcileInterrupted();
    assert.equal(job().status, 'uncertain', 'Repeated startup must not exhaust job history or invent stop evidence');
    assert.equal(fx.calls.executed, calls.executed);
  }
  // Let the independent original fixture finish after recovery assertions; it cannot alter the copied crash state.
  await fx.finish();
});

test('saved lesson and answer GETs validate lineage, exact anchors and current source policy without effects', async (t) => {
  const fx = fixture(t), { lessonHash } = await generate(fx);
  const question = fx.request({ lessonHash, anchor: fx.anchor, question: 'Какое значение получает count?' });
  const started = await fx.jobs.start(fx.runId, 'ask-lesson', question, 'operator');
  await fx.finish();
  const job = fx.record(started.jobId);
  assert.equal(job.status, 'ready', JSON.stringify(job));
  const before = fx.state(), calls = { ...fx.calls };
  assert.equal(fx.jobs.readObject(fx.runId, 'lesson', lessonHash).lesson.steps[0].anchors[0].quote, 'count = 2');
  const answer = fx.jobs.readObject(fx.runId, 'answer', job.result.answerHash);
  assert.equal(answer.question, question.question); assert.deepEqual(answer.anchor, fx.anchor);
  assert.deepEqual(fx.state(), before); assert.deepEqual(fx.calls, calls);
  const nextPlanHash = fx.store.putObject('plans', { ...fx.plan, version: 2, parentPlanHash: fx.binding.planHash });
  const next = { ...before, runId: 'next-run', revision: 0, planHash: nextPlanHash, supersedesRunId: fx.runId, operations: {},
    learning: { ...before.learning, stages: {}, jobs: {}, eventIds: [], progress: {} } };
  fx.store.createRun('next-run', next);
  assert.equal(fx.jobs.readObject('next-run', 'lesson', lessonHash).id, lessonHash);
  fx.store.createRun('foreign-run', { ...next, runId: 'foreign-run', supersedesRunId: null });
  assert.throws(() => fx.jobs.readObject('foreign-run', 'lesson', lessonHash), { code: 'NOT_FOUND' });
  assert.throws(() => fx.jobs.readObject(fx.runId, 'lesson', lessonHash, hash), { code: 'LEARNING_MATERIAL_DENIED' });
  fx.runtime.policy = { ...fx.runtime.policy, denyGlobs: ['counter.custom'] };
  assert.throws(() => fx.jobs.readObject('next-run', 'answer', job.result.answerHash), { code: 'LEARNING_SOURCE_DENIED' });
});

test('a stored result with a valid object hash but forged source anchor is rejected on GET', async (t) => {
  const fx = fixture(t), { started, lessonHash } = await generate(fx);
  const lesson = fx.store.readObject('lessons', lessonHash);
  lesson.steps[0].anchors[0].quote = 'count = 900';
  const forgedHash = fx.store.putObject('lessons', lesson);
  fx.replaceJob(started.jobId, { result: { lessonHash: forgedHash } });
  assert.throws(() => fx.jobs.readObject(fx.runId, 'lesson', forgedHash), { code: 'LEARNING_ANCHOR_INVALID' });
});

test('answer GET rejects forged question binding or output anchors even under a valid stored-object hash', async (t) => {
  const fx = fixture(t), { lessonHash } = await generate(fx);
  const started = await fx.jobs.start(fx.runId, 'ask-lesson', fx.request({ lessonHash, anchor: fx.anchor, question: 'Чему равен count?' }), 'operator');
  await fx.finish();
  const job = fx.record(started.jobId), answer = fx.store.readObject('lessons', job.result.answerHash);
  for (const kind of ['question', 'anchor']) {
    const forged = structuredClone(answer);
    if (kind === 'question') forged.question = 'Другой вопрос';
    else forged.anchors[0].quote = 'count = 100';
    const answerHash = fx.store.putObject('lessons', forged);
    fx.replaceJob(started.jobId, { result: { answerHash } });
    assert.throws(() => fx.jobs.readObject(fx.runId, 'answer', answerHash), {
      code: kind === 'question' ? 'LEARNING_JOB_INTEGRITY' : 'LEARNING_ANCHOR_INVALID',
    });
  }
});

test('expired write approval and revoked execution permissions do not block reading saved material for explicit generation', async (t) => {
  const fx = fixture(t), current = fx.state();
  fx.host.write(current, { permissions: [], approvalExpiresAt: '2000-01-01T00:00:00.000Z' });
  const before = executionPart(fx.state());
  assert.equal(fx.jobs.capability(fx.state(), fx.materialHash).allowed, true);
  await generate(fx);
  assert.deepEqual(executionPart(fx.state()), before);
});
