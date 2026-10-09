import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GraphStore } from './lib/store.mjs';
import { GraphError, hashObject, sha256 } from './lib/io.mjs';
import { GraphPlanV3Schema, TaskSpecV3Schema, ReceiptSchema } from './lib/schemas.mjs';
import { captureLearningSources } from './lib/learning-sources.mjs';
import { createLearningMaterial } from './lib/learning-material.mjs';
import { learningMaterial, learningSnapshot, learningSource, learningUnavailable } from './lib/learning-view.mjs';
import { projectSnapshot } from './lib/task-snapshot.mjs';
import { loadProjectProfile } from './lib/project.mjs';

const hash = hashObject('learning-view-fixture'), stamp = '2026-10-08T12:00:00.000Z';
const termination = { stopped: true, uncertain: false, timedOut: false, outputLimit: false, signal: null, ticketHash: null, execution: null };

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-learning-view-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new GraphStore(root);
  const task = TaskSpecV3Schema.parse({ schemaVersion: 3, id: 'LEARNING-VIEW', goal: 'Изменить результат', instructions: 'Локальный тест проекции',
    scope: ['main.py'], acceptance: ['Результат изменен'], checks: ['verify-code'], sourceHash: hash });
  const taskHash = store.putObject('tasks', task);
  const node = (id, action, kind) => ({ id, title: id, outcome: id, needs: [], action: { id: action, version: 1, inputs: {} },
    success: { kind, requiredArtifacts: [] }, permissions: [], skills: [], resources: { reads: ['main.py'], writes: [], exclusive: [] }, retry: { maxAttempts: 1, backoffMs: 0 } });
  const checks = { version: 1, profileHash: hash, definitions: [], bindings: [] };
  const plan = GraphPlanV3Schema.parse({ schemaVersion: 3, stage: 'execution', taskHash, version: 1, parentPlanHash: null,
    sourceHash: hash, runtimeHash: hash, registryHash: hash, policyHash: hash, skills: [], checkRegistryHash: hashObject(checks), checks,
    learning: { version: 1, initialMode: 'after-stage' },
    taskContract: { version: 1, goal: task.goal, instructionsHash: hash, requirements: [{ id: 'req-change', title: task.goal, mandatory: true, origin: 'acceptance',
      verification: { method: 'check', checkIds: ['verify-code'], criterion: 'Результат изменен', paths: ['main.py'] }, workIds: ['implement'] }],
      optionalImprovements: [], constraints: [], assumptions: [], unknowns: [], scope: ['main.py'], forbiddenPaths: [], rigor: { level: 'light', reasons: ['Локальная проверка'] } },
    nodes: [node('implement', 'ai-implement', 'implementation'), node('scope-check', 'workspace-check', 'checks'), node('check-code', 'check-verify-code', 'checks'),
      node('review', 'ai-review', 'review'), node('handoff', 'artifact-handoff', 'handoff')],
    executionStages: { version: 1, stages: [{ id: 'stage-one', title: 'Изменение', outcome: 'Результат изменен', implementationNodeIds: ['implement'], requirementIds: ['req-change'],
      scopeCheckNodeId: 'scope-check', checkNodeIds: ['check-code'], boundaryNodeId: 'handoff' }], finalCheckNodeIds: ['check-code'], finalReviewNodeId: 'review', handoffNodeId: 'handoff' } });
  const planHash = store.putObject('plans', plan), binding = { runId: 'run-view', planHash, taskHash };
  const capture = (text, role, sourceHash) => {
    writeFileSync(path.join(root, 'main.py'), text);
    return captureLearningSources({ store, projectRoot: root, sourceHash, files: [{ path: 'main.py', role,
      expected: { hash: sha256(text), size: Buffer.byteLength(text), mode: '100644' } }] });
  };
  const before = capture('value = 1\n', 'before', hash), resultHash = hashObject('view-result');
  const after = capture('value = 2\n', 'after', resultHash);
  const receipt = (definition, beforeFingerprint = resultHash, extras = {}) => store.putObject('receipts', ReceiptSchema.parse({
    schemaVersion: 2, ...binding, nodeId: definition.id, attemptId: 'attempt-one', attempt: 1, phase: 'finished', actionId: definition.action.id, actionVersion: 1, planVersion: 1,
    sourceHash: hash, runtimeHash: hash, instructionsHash: hash, skills: [], permissions: [], grantedPermissions: [], termination,
    startedAt: stamp, finishedAt: stamp, durationMs: 0, exitCode: 0, verdict: 'pass', checks: [], artifacts: [], changedFiles: [], failureReason: null,
    beforeFingerprint, afterFingerprint: resultHash, actor: 'local-test', operationId: 'operation-one', previousReceipt: null, ...extras }));
  const receipts = Object.fromEntries(plan.nodes.map(definition => [definition.id, receipt(definition, definition.id === 'implement' ? hash : resultHash)]));
  const materialOptions = { store, binding, stageId: 'stage-one', before, after,
    implementationReceiptIds: [receipts.implement], checkReceiptIds: [receipts['scope-check'], receipts['check-code']], reviewReceiptIds: [receipts.review], createdAt: stamp };
  const saved = createLearningMaterial(materialOptions);
  const state = { schemaVersion: 3, ...binding, revision: 4, status: 'passed', activeOperation: null, setupPending: false, finalDisposition: null,
    workspaceFingerprint: { hash: resultHash }, continuation: { kind: 'open' },
    nodes: Object.fromEntries(plan.nodes.map(definition => [definition.id, { status: 'passed', receipts: [receipts[definition.id]], attempts: 1 }])),
    learning: { version: 1, mode: 'after-stage', stages: { 'stage-one': { boundaryReceiptId: receipts.handoff, materialHash: saved.id, materialError: null } },
      captures: { 'stage-one': { before, after } }, eventIds: [], jobs: {}, progress: {} } };
  const reads = [], historical = [], loaded = { state, task, plan };
  const runs = new Map([[state.runId, loaded]]);
  const host = { store, adapters: { project: { aiDenyGlobs: [], outputPaths: [] }, fingerprint: () => assert.fail('GET must not fingerprint live project') },
    read: (runId, options) => { reads.push([runId, options]); const run = runs.get(runId); if (!run) throw new GraphError('RUN_NOT_FOUND', 'Запуск не найден'); return run; },
    executionHistory: () => historical };
  return { root, store, state, task, plan, saved, host, reads, historical, runs, loaded, resultHash, receipts, receipt, materialOptions };
}

test('material/source reads use committed saved bytes with no writes, source scans or progress changes', t => {
  const f = fixture(t), before = JSON.stringify(f.state);
  f.store.putObject = () => assert.fail('GET must not write immutable objects');
  writeFileSync(path.join(f.root, 'main.py'), 'live code changed');
  const material = learningMaterial(f.host, f.state.runId, f.saved.id);
  const source = material.sources.find(item => item.role === 'after');
  assert.equal(material.id, f.saved.id);
  assert.equal(material.progress, 'unread');
  assert.equal(material.lessonHash, null);
  assert.equal(material.capabilities.generateLesson.allowed, false);
  assert.match(material.capabilities.generateLesson.reason, /еще не подключен/);
  assert.equal(material.capabilities.askLesson.allowed, false);
  assert.equal(material.capabilities.setLearningProgress.allowed, true);
  assert.equal(learningSource(f.host, f.state.runId, f.saved.id, source.id, { startLine: 1, lineCount: 1 }).text, 'value = 2');
  assert.equal(JSON.stringify(f.state), before);
  for (const [, options] of f.reads) assert.deepEqual(options, { current: false, verifySource: false, verifyBinding: false });
});

test('trusted history binds owning run/plan/task while comparing material with requested persisted version', t => {
  const f = fixture(t);
  const next = structuredClone(f.loaded); next.state.runId = 'run-next'; next.state.planHash = hashObject('next-plan');
  next.state.taskHash = hashObject('next-task'); next.state.learning.stages = {}; next.state.workspaceFingerprint.hash = hash;
  f.runs.set(next.state.runId, next); f.historical.push(f.loaded);
  const material = learningMaterial(f.host, next.state.runId, f.saved.id);
  assert.equal(material.material.runId, f.state.runId);
  assert.equal(material.material.planHash, f.state.planHash);
  assert.equal(material.freshness.state, 'stale');
  assert.equal(material.capabilities.setLearningProgress.allowed, true);
  next.task.forbiddenPaths = ['main.py'];
  assert.throws(() => learningMaterial(f.host, next.state.runId, f.saved.id), { code: 'LEARNING_SOURCE_DENIED' });
  next.task.forbiddenPaths = []; f.task.forbiddenPaths = ['main.py'];
  assert.throws(() => learningMaterial(f.host, next.state.runId, f.saved.id), { code: 'LEARNING_SOURCE_DENIED' });
});

test('material progress is a pure projection: requested override, historical owner, then unread', t => {
  const f = fixture(t), next = structuredClone(f.loaded);
  next.state.runId = 'run-progress'; next.state.learning.stages = {};
  f.runs.set(next.state.runId, next); f.historical.push(f.loaded);
  const materialBefore = f.store.readObject('learning-materials', f.saved.id);
  const catalogBefore = f.store.readObject('learning-sources', materialBefore.sourceCatalogHash);
  const read = () => learningMaterial(f.host, next.state.runId, f.saved.id);
  assert.equal(read().progress, 'unread');
  f.state.learning.progress[f.saved.id] = 'read';
  assert.equal(read().progress, 'read');
  for (const progress of ['deferred', 'unread', 'read']) {
    next.state.learning.progress[f.saved.id] = progress;
    const before = JSON.stringify([f.state, next.state]);
    assert.equal(read().progress, progress);
    assert.equal(JSON.stringify([f.state, next.state]), before);
  }
  assert.equal(f.state.learning.progress[f.saved.id], 'read');
  assert.deepEqual(f.store.readObject('learning-materials', f.saved.id), materialBefore);
  assert.deepEqual(f.store.readObject('learning-sources', materialBefore.sourceCatalogHash), catalogBefore);
  assert.equal('progress' in materialBefore, false);
  next.state.learning.progress[f.saved.id] = 'invalid';
  assert.throws(read); // Invalid metadata is not silently presented as unread.
});

test('uncommitted object hashes and foreign sources cannot be accessed through jobs, captures or request options', t => {
  const f = fixture(t), source = learningMaterial(f.host, f.state.runId, f.saved.id).sources[0];
  assert.throws(() => learningSource(f.host, f.state.runId, f.saved.id, 'source-other'), { code: 'LEARNING_SOURCE_DENIED' });
  f.state.learning.stages = {};
  f.state.learning.jobs['job-one'] = f.saved.id;
  f.state.learning.progress[f.saved.id] = 'read';
  assert.throws(() => learningMaterial(f.host, f.state.runId, f.saved.id), { code: 'LEARNING_MATERIAL_DENIED' });
  assert.throws(() => learningSource(f.host, f.state.runId, f.saved.id, source.id, { binding: { materialHashes: [f.saved.id] } }), { code: 'LEARNING_MATERIAL_DENIED' });
});

test('current project deny/output rules block pinned sources and cannot be overridden by paging options', t => {
  const f = fixture(t), source = learningMaterial(f.host, f.state.runId, f.saved.id).sources[0];
  for (const key of ['aiDenyGlobs', 'outputPaths']) {
    f.host.adapters.project[key] = ['main.py'];
    assert.throws(() => learningMaterial(f.host, f.state.runId, f.saved.id), { code: 'LEARNING_SOURCE_DENIED' });
    assert.throws(() => learningSource(f.host, f.state.runId, f.saved.id, source.id, { policy: {} }), { code: 'LEARNING_SOURCE_DENIED' });
    f.host.adapters.project[key] = [];
  }
});

test('policy callback reloads edited project restrictions without restart and leaves saved bytes immutable', t => {
  const f = fixture(t), file = path.join(f.root, '.flowcairn.json');
  const profile = { version: 2, workspaceMode: 'direct', integrationBranch: 'main', contextPaths: [], checks: [], checkMode: 'trusted-local',
    checkProfile: { version: 1, requiredCheckIds: [], definitions: [], environment: [] }, manifests: [], outputPaths: [], aiDenyGlobs: [],
    ai: { provider: 'codex', model: 'fixture' } };
  writeFileSync(file, JSON.stringify(profile));
  f.host.adapters.learningSourcePolicy = () => {
    const current = loadProjectProfile(f.root);
    return { denyGlobs: current.aiDenyGlobs ?? [], outputPaths: current.outputPaths };
  };
  const material = learningMaterial(f.host, f.state.runId, f.saved.id);
  const source = material.sources.find(item => item.role === 'after');
  assert.equal(learningSource(f.host, f.state.runId, f.saved.id, source.id).text, 'value = 2\n');
  const objectFiles = [path.join(f.root, '.ai-orchestrator/graph/learning-materials', `${f.saved.id}.json`),
    ...source.chunkHashes.map(id => path.join(f.root, '.ai-orchestrator/graph/learning-source-chunks', `${id}.json`))];
  const savedBytes = objectFiles.map(name => readFileSync(name));
  f.store.putObject = () => assert.fail('Policy updates must not rewrite saved learning objects');
  writeFileSync(file, JSON.stringify({ ...profile, aiDenyGlobs: ['main.py'] }));
  assert.deepEqual(f.host.adapters.project.aiDenyGlobs, []); // The cached adapter remains unchanged.
  assert.throws(() => learningMaterial(f.host, f.state.runId, f.saved.id), { code: 'LEARNING_SOURCE_DENIED' });
  assert.throws(() => learningSource(f.host, f.state.runId, f.saved.id, source.id), { code: 'LEARNING_SOURCE_DENIED' });
  writeFileSync(file, '{broken');
  assert.throws(() => learningMaterial(f.host, f.state.runId, f.saved.id), { code: 'PROJECT_PROFILE_INVALID' });
  assert.throws(() => learningSource(f.host, f.state.runId, f.saved.id, source.id), { code: 'PROJECT_PROFILE_INVALID' });
  for (let index = 0; index < objectFiles.length; index++) assert.deepEqual(readFileSync(objectFiles[index]), savedBytes[index]);
});

test('snapshot separates verified history, freshness and self-reported progress', t => {
  const f = fixture(t), view = drift => learningSnapshot(f.host, f.state, f.task, f.plan, drift);
  assert.equal(view().stages[0].status, 'verified');
  assert.equal(view().stages[0].freshness, 'current');
  assert.equal(view().stages[0].checkedResultHash, f.resultHash);
  assert.equal(view().stages[0].progress, 'unread');
  f.state.workspaceFingerprint.hash = hash; f.state.learning.progress[f.saved.id] = 'deferred';
  assert.equal(view().stages[0].status, 'verified');
  assert.equal(view().stages[0].freshness, 'stale');
  assert.equal(view().stages[0].progress, 'deferred');
  assert.equal(view('RUNTIME_DRIFT: runtime changed').stages[0].freshness, 'unknown');
  assert.equal(view().stages[0].lessonStatus, 'absent');
  assert.equal(view().activeJob, null);
});

test('passed nodes without a boundary or registered verifier never become verified', t => {
  const f = fixture(t), view = () => learningSnapshot(f.host, f.state, f.task, f.plan);
  f.state.learning.stages = {};
  assert.equal(view().stages[0].status, 'uncertain');
  assert.equal(view().stages[0].checkedResultHash, null);
  assert.equal(view().stages[0].materialStatus, 'pending');
  f.plan.executionStages.stages[0].checkNodeIds = [];
  assert.notEqual(view().stages[0].status, 'verified');
  for (const node of Object.values(f.state.nodes)) { node.status = 'pending'; node.attempts = 0; }
  for (const [nodeStatus, status] of [['pending', 'pending'], ['running', 'running'], ['failed', 'failed'], ['uncertain', 'uncertain']]) {
    f.state.nodes.implement.status = nodeStatus;
    assert.equal(view().stages[0].status, status);
  }
  f.state.nodes.implement.status = 'passed';
  assert.equal(view().stages[0].status, 'running');
  f.state.nodes.review.status = 'failed';
  assert.equal(view().stages[0].status, 'failed');
  f.state.nodes.review.status = 'pending';
  f.state.nodes.implement.status = 'pending';
  f.state.learning.failure = { stageId: 'stage-one', code: 'LEARNING_CAPTURE_UNAVAILABLE', reason: 'Безопасность capture не подтверждена' };
  assert.equal(view().stages[0].status, 'failed');
  assert.equal(view().stages[0].materialStatus, 'unavailable');
});

test('read capabilities deny active operation, setup and run locks without hiding saved material', t => {
  const f = fixture(t), read = () => learningMaterial(f.host, f.state.runId, f.saved.id);
  f.state.activeOperation = { id: 'operation-one' };
  assert.equal(read().capabilities.setLearningProgress.allowed, false);
  assert.equal(read().freshness.state, 'unknown');
  f.state.activeOperation = null; f.state.setupPending = true;
  assert.equal(read().capabilities.setLearningProgress.allowed, false);
  f.state.setupPending = false; f.store.inspectLock = () => ({ status: 'live' });
  assert.equal(read().capabilities.setLearningProgress.allowed, false);
  f.store.inspectLock = () => null; f.state.status = 'failed';
  assert.equal(read().capabilities.setLearningProgress.allowed, true);
  f.state.operations = { 'operation-old': { status: 'creating' } };
  assert.equal(read().capabilities.setLearningProgress.allowed, false);
});

test('final material is a distinct committed reference and invalid pinned links fail closed', t => {
  const f = fixture(t), final = createLearningMaterial({ ...f.materialOptions, kind: 'task', stageId: null });
  assert.throws(() => learningMaterial(f.host, f.state.runId, final.id), { code: 'LEARNING_MATERIAL_DENIED' });
  f.state.learning.finalMaterialHash = final.id;
  assert.equal(learningMaterial(f.host, f.state.runId, final.id).material.kind, 'task');
  assert.equal(learningSnapshot(f.host, f.state, f.task, f.plan).finalMaterialHash, final.id);
  f.state.learning.stages['stage-one'].materialHash = final.id;
  assert.throws(() => learningSnapshot(f.host, f.state, f.task, f.plan), { code: 'LEARNING_BOUNDARY_INTEGRITY' });
});

test('contradictory boundary receipt and malformed pinned material are hard failures', t => {
  const f = fixture(t);
  const bad = f.receipt(f.plan.nodes.at(-1), f.resultHash, { termination: { ...termination, timedOut: true } });
  f.state.nodes.handoff.receipts = [bad]; f.state.learning.stages['stage-one'].boundaryReceiptId = bad;
  assert.throws(() => learningSnapshot(f.host, f.state, f.task, f.plan), { code: 'LEARNING_BOUNDARY_INTEGRITY' });
  const malformed = f.store.putObject('learning-materials', { ...f.saved.material, kind: 'unexpected' });
  f.state.learning.stages['stage-one'].materialHash = malformed;
  assert.throws(() => learningMaterial(f.host, f.state.runId, malformed), { code: 'LEARNING_MATERIAL_INTEGRITY' });
});

test('unavailable learning objects return concrete not-found without fake jobs or provider effects', t => {
  const f = fixture(t);
  for (const kind of ['lesson', 'answer', 'job'])
    assert.throws(() => learningUnavailable(f.host, f.state.runId, kind, kind === 'job' ? 'job-one' : hash), error => error.code === 'NOT_FOUND' && /еще не подключен/.test(error.message));
  assert.throws(() => learningUnavailable(f.host, 'run-missing', 'lesson', hash), { code: 'RUN_NOT_FOUND' });
  assert.throws(() => learningUnavailable(f.host, f.state.runId, 'job', '../../source'), { code: 'INVALID_REQUEST' });
});

test('learning hold projects idle execution while boundary operation bookkeeping remains', t => {
  const f = fixture(t);
  Object.assign(f.state, { status: 'learning-hold', activeOperation: { id: 'operation-boundary' }, stopRequested: true,
    operations: {}, planningArtifacts: [], continuation: { kind: 'learning-hold', holdId: hash, stageId: 'stage-one',
      boundaryReceiptId: f.receipts.handoff, resultHash: f.resultHash, createdAt: stamp, materialHash: f.saved.id } });
  for (const node of Object.values(f.state.nodes)) Object.assign(node, { artifacts: [], checks: [], changedFiles: [] });
  const host = { ...f.host, adapters: { ...f.host.adapters, runner: { ai: { available: false }, checks: { available: true } } },
    sanitizeText: value => value, safeReason: error => error.message, caps: () => ({ run: { requestReplan: { allowed: false } }, nodes: {} }),
    artifactMetadata: () => assert.fail('No artifacts in this fixture'), delivery: () => null, taskProof: () => ({}), workflowProgress: () => null };
  const snapshot = projectSnapshot(host, f.state.runId, false);
  assert.deepEqual(snapshot.execution, { state: 'idle', stopRequested: false });
  assert.equal(snapshot.learning.stages[0].status, 'verified');
  assert.equal(snapshot.continuation.kind, 'learning-hold');
});
