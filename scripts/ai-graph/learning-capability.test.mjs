import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GraphStore } from './lib/store.mjs';
import { GraphError, hashObject, sha256 } from './lib/io.mjs';
import { GraphPlanV3Schema, TaskSpecV3Schema } from './lib/schemas.mjs';
import { StageMaterialSchema } from './lib/learning-schemas.mjs';
import { learningMaterial, openLearningCapability } from './lib/learning-view.mjs';
import { projectSnapshot } from './lib/task-snapshot.mjs';

const hash = hashObject('learning-capability'), stamp = '2026-10-08T12:00:00.000Z';

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-learning-capability-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new GraphStore(root), runs = new Map(), reads = [];
  let history = [], drift = null, sourcePolicy = { denyGlobs: [], outputPaths: [] };
  function run(runId, file = 'main.py', pinned = true) {
    const task = TaskSpecV3Schema.parse({ schemaVersion: 3, id: runId.toUpperCase(), goal: 'Проверить изменение', instructions: 'Локальный тест доступа',
      scope: [file], acceptance: ['Изменение проверено'], checks: ['verify-code'], sourceHash: hash });
    const taskHash = store.putObject('tasks', task);
    const node = (id, action, kind) => ({ id, title: id, outcome: id, needs: [], action: { id: action, version: 1, inputs: {} },
      success: { kind, requiredArtifacts: [] }, permissions: [], skills: [], resources: { reads: [file], writes: [], exclusive: [] }, retry: { maxAttempts: 1, backoffMs: 0 } });
    const checks = { version: 1, profileHash: hash, definitions: [], bindings: [] };
    const plan = GraphPlanV3Schema.parse({ schemaVersion: 3, stage: 'execution', taskHash, version: 1, parentPlanHash: null,
      sourceHash: hash, runtimeHash: hash, registryHash: hash, policyHash: hash, skills: [], checkRegistryHash: hashObject(checks), checks,
      learning: { version: 1, initialMode: 'after-stage' },
      taskContract: { version: 1, goal: task.goal, instructionsHash: hash, requirements: [{ id: 'req-change', title: task.goal, mandatory: true, origin: 'acceptance',
        verification: { method: 'check', checkIds: ['verify-code'], criterion: 'Изменение проверено', paths: [file] }, workIds: ['implement'] }],
        optionalImprovements: [], constraints: [], assumptions: [], unknowns: [], scope: [file], forbiddenPaths: [], rigor: { level: 'light', reasons: ['Локальная проверка'] } },
      nodes: [node('implement', 'ai-implement', 'implementation'), node('scope-check', 'workspace-check', 'checks'), node('check-code', 'check-verify-code', 'checks'),
        node('review', 'ai-review', 'review'), node('handoff', 'artifact-handoff', 'handoff')],
      executionStages: { version: 1, stages: [{ id: 'stage-one', title: 'Изменение', outcome: 'Изменение проверено', implementationNodeIds: ['implement'], requirementIds: ['req-change'],
        scopeCheckNodeId: 'scope-check', checkNodeIds: ['check-code'], boundaryNodeId: 'handoff' }], finalCheckNodeIds: ['check-code'], finalReviewNodeId: 'review', handoffNodeId: 'handoff' } });
    const planHash = store.putObject('plans', plan), text = 'value = 2\n';
    const chunkHash = store.putObject('learning-source-chunks', { version: 1, text });
    const sourceCatalogHash = store.putObject('learning-sources', { version: 1, sources: [{ id: 'source-one', path: file, fileHash: sha256(text),
      bytes: Buffer.byteLength(text), mode: '100644', role: 'after', chunkHashes: [chunkHash], lineCount: 2 }] });
    // Historical read fixtures test pinned ownership/integrity; they do not assert new execution success.
    const material = StageMaterialSchema.parse({ version: 1, kind: 'stage', runId, planHash, taskHash, contractHash: hashObject(plan.taskContract),
      stageId: 'stage-one', goal: task.goal, outcome: task.goal, requirementIds: ['req-change'], beforeHash: hash, resultHash: hash,
      createdAt: stamp, sourceCatalogHash, implementationReceiptIds: [], checkReceiptIds: [], reviewReceiptIds: [], diffArtifactIds: [], findingsArtifactIds: [], status: 'complete', gaps: [] });
    const materialHash = store.putObject('learning-materials', material);
    const state = { schemaVersion: 3, runId, planHash, taskHash, revision: 1, status: 'pending', activeOperation: null, finalDisposition: null,
      nodes: Object.fromEntries(plan.nodes.map(definition => [definition.id, { status: 'pending', receipts: [], attempts: 0, artifacts: [], checks: [], changedFiles: [] }])),
      continuation: { kind: 'open' }, operations: {}, planningArtifacts: [], workspaceFingerprint: { hash },
      learning: { version: 1, mode: 'after-stage', stages: pinned ? { 'stage-one': { boundaryReceiptId: hash, materialHash, materialError: null } } : {},
        finalMaterialHash: null, eventIds: [], jobs: {}, progress: {} } };
    const loaded = { state, task, plan, materialHash, chunkHash };
    runs.set(runId, loaded);
    return loaded;
  }
  const host = { store, adapters: { project: { aiDenyGlobs: [], outputPaths: [] }, learningSourcePolicy: () => sourcePolicy,
    runner: { ai: { available: false }, checks: { available: false } }, fingerprint: () => assert.fail('No live source scans for read capability') },
    read: (runId, options = {}) => {
      reads.push([runId, options]);
      if (drift && options.current !== false) throw new GraphError(drift, 'Исполнитель изменился');
      const loaded = runs.get(runId);
      if (!loaded) throw new GraphError('RUN_NOT_FOUND', 'Запуск не найден');
      return loaded;
    },
    executionHistory: () => history,
    sanitizeText: value => value, safeReason: error => `${error.code}: ${error.message}`,
    artifactMetadata: () => assert.fail('No artifact reads'), delivery: () => null, taskProof: () => ({}), workflowProgress: () => null,
    caps: state => ({ run: { openLearning: openLearningCapability(host, state), openReceipt: { allowed: true, reason: null },
      continueLearning: { allowed: true, reason: null }, setLearningMode: { allowed: true, reason: null }, run: { allowed: true, reason: null },
      requestReplan: { allowed: false, reason: 'Нет перепланирования' } }, nodes: {} }),
  };
  return { root, store, host, run, reads, history: value => { history = value; }, drift: value => { drift = value; }, policy: value => { sourcePolicy = value; } };
}

test('current pinned material enables readonly learning despite unavailable execution without mutations', t => {
  const f = fixture(t), current = f.run('run-current'), before = JSON.stringify(current);
  f.store.putObject = () => assert.fail('Capability must not write');
  assert.deepEqual(openLearningCapability(f.host, current.state), { allowed: true, reason: null });
  assert.equal(JSON.stringify(current), before);
  assert.deepEqual(f.reads, [[current.state.runId, { current: false, verifySource: false, verifyBinding: false }]]);
});

test('ancestor material is readable using historical identity, while absent/uncommitted refs do not enable it', t => {
  const f = fixture(t), current = f.run('run-current', 'main.py', false), previous = f.run('run-previous');
  current.state.learning.jobs['job-not-material'] = current.materialHash;
  current.state.learning.stages['stage-empty'] = { boundaryReceiptId: hash, materialHash: null, materialError: 'Не сохранен' };
  assert.equal(openLearningCapability(f.host, current.state).allowed, false);
  delete current.state.learning.stages['stage-empty'];
  f.history([previous]);
  assert.equal(openLearningCapability(f.host, current.state).allowed, true);
  assert.equal(learningMaterial(f.host, current.state.runId, previous.materialHash).material.runId, previous.state.runId);
});

test('runtime/registry/binding drift preserves only learning reads and closes Continue, mode and Run', t => {
  const f = fixture(t), current = f.run('run-current', 'main.py', false), previous = f.run('run-previous');
  f.history([previous]);
  for (const drift of ['RUNTIME_DRIFT', 'CHECK_REGISTRY_DRIFT', 'POLICY_DRIFT', 'STALE_GRAPH_BINDING']) {
    f.drift(drift);
    const snapshot = projectSnapshot(f.host, current.state.runId, true);
    assert.equal(snapshot.status, 'stale');
    assert.equal(snapshot.capabilities.openLearning.allowed, true, drift);
    assert.equal(snapshot.capabilities.openReceipt.allowed, true, drift);
    for (const control of ['continueLearning', 'setLearningMode', 'run']) assert.equal(snapshot.capabilities[control].allowed, false, `${drift}:${control}`);
  }
});

test('current policy can deny one material while another permitted ancestor remains readable', t => {
  const f = fixture(t), current = f.run('run-current', 'private.py'), previous = f.run('run-previous', 'public.py');
  f.policy({ denyGlobs: ['private.py'], outputPaths: [] });
  assert.equal(openLearningCapability(f.host, current.state).allowed, false);
  f.history([previous]);
  assert.equal(openLearningCapability(f.host, current.state).allowed, true);
  f.policy({ denyGlobs: ['*.py'], outputPaths: [] });
  const denied = openLearningCapability(f.host, current.state);
  assert.equal(denied.allowed, false);
  assert.match(denied.reason, /LEARNING_SOURCE_DENIED/);
  f.host.adapters.learningSourcePolicy = () => { throw new GraphError('PROJECT_PROFILE_INVALID', 'Профиль недоступен'); };
  assert.match(openLearningCapability(f.host, current.state).reason, /PROJECT_PROFILE_INVALID/);
});

test('corrupt referenced metadata cannot be bypassed by choosing another readable material', t => {
  const f = fixture(t), current = f.run('run-current'), previous = f.run('run-previous', 'other.py');
  f.history([previous]);
  const file = path.join(f.root, '.ai-orchestrator/graph/learning-materials', `${previous.materialHash}.json`);
  const object = JSON.parse(readFileSync(file, 'utf8')); object.data.goal = 'Подменено'; writeFileSync(file, JSON.stringify(object));
  const denied = openLearningCapability(f.host, current.state);
  assert.equal(denied.allowed, false);
  assert.match(denied.reason, /OBJECT_TAMPERED/);
  assert.throws(() => learningMaterial(f.host, current.state.runId, previous.materialHash), { code: 'OBJECT_TAMPERED' });
  rmSync(file);
  assert.match(openLearningCapability(f.host, current.state).reason, /STORE_NOT_FOUND/);
});

test('unreadable saved sources and untrusted history fail closed rather than advertising read access', t => {
  const f = fixture(t), current = f.run('run-current');
  const file = path.join(f.root, '.ai-orchestrator/graph/learning-source-chunks', `${current.chunkHash}.json`);
  const original = readFileSync(file), object = JSON.parse(original.toString());
  object.data.text = 'Подмена'; writeFileSync(file, JSON.stringify(object));
  assert.match(openLearningCapability(f.host, current.state).reason, /OBJECT_TAMPERED/);
  writeFileSync(file, original);
  f.host.executionHistory = () => { throw new GraphError('EXECUTION_HISTORY', 'Цепочка повреждена'); };
  const denied = openLearningCapability(f.host, current.state);
  assert.equal(denied.allowed, false);
  assert.match(denied.reason, /EXECUTION_HISTORY/);
});

test('corrupt current plan/task read cannot be revived by the snapshot drift fallback', t => {
  const f = fixture(t), current = f.run('run-current', 'main.py', false);
  f.host.read = () => { throw new GraphError('OBJECT_TAMPERED', 'Поврежден план'); };
  const capability = openLearningCapability(f.host, current.state);
  assert.equal(capability.allowed, false);
  assert.match(capability.reason, /OBJECT_TAMPERED/);
  const snapshot = projectSnapshot(f.host, current.state.runId, true);
  for (const control of ['openLearning', 'continueLearning', 'setLearningMode', 'run']) assert.equal(snapshot.capabilities[control].allowed, false);
});
