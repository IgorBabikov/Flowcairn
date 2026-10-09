import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GraphStore } from '../scripts/ai-graph/lib/store.mjs';
import { hashObject, sha256 } from '../scripts/ai-graph/lib/io.mjs';
import { GraphPlanV3Schema, ReceiptSchema, TaskSpecV3Schema } from '../scripts/ai-graph/lib/schemas.mjs';
import { captureLearningSources } from '../scripts/ai-graph/lib/learning-sources.mjs';
import { createLearningMaterial, readLearningMaterial, readLearningSourcePage } from '../scripts/ai-graph/lib/learning-material.mjs';
import { validateLessonMaterial } from '../scripts/ai-graph/lib/lesson-validation.mjs';

const hash = hashObject('qa-learning'), stamp = '2026-10-08T15:00:00.000Z';

// Real immutable storage and file capture; the plan/receipts are explicit synthetic host data.
function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-qa-learning-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new GraphStore(root);
  const beforeText = 'count = 1\n';
  const beforeHash = hashObject({ 'counter.custom': sha256(beforeText) });
  const task = TaskSpecV3Schema.parse({ schemaVersion: 3, id: 'QA-LEARNING', goal: 'Изменить счетчик', instructions: 'Сохранить новое значение',
    scope: ['counter.custom'], contextPaths: [], acceptance: ['Счетчик изменен'], checks: ['verify-counter'], sourceHash: beforeHash });
  const taskHash = store.putObject('tasks', task);
  const node = (id, actionId, kind) => ({ id, title: id, outcome: id, needs: [], action: { id: actionId, version: 1, inputs: {} },
    success: { kind, requiredArtifacts: [] }, permissions: [], skills: [], resources: { reads: ['counter.custom'], writes: [], exclusive: [] }, retry: { maxAttempts: 1, backoffMs: 0 } });
  const checks = { version: 1, profileHash: hash, definitions: [], bindings: [] };
  const plan = GraphPlanV3Schema.parse({ schemaVersion: 3, stage: 'execution', version: 1, parentPlanHash: null, taskHash, sourceHash: beforeHash,
    runtimeHash: hash, registryHash: hash, policyHash: hash, skills: [], checkRegistryHash: hashObject(checks), checks,
    learning: { version: 1, initialMode: 'after-stage' },
    taskContract: { version: 1, goal: task.goal, instructionsHash: hash, requirements: [{ id: 'req-counter', title: task.goal, mandatory: true, origin: 'acceptance',
      verification: { method: 'check', checkIds: ['check-verify-counter'], criterion: 'Значение изменено', paths: ['counter.custom'] }, workIds: ['implement'] }],
      optionalImprovements: [], constraints: [], assumptions: [], unknowns: [], scope: task.scope, forbiddenPaths: [], rigor: { level: 'light', reasons: ['Fixture'] } },
    nodes: [node('implement', 'ai-implement', 'implementation'), node('scope', 'workspace-check', 'checks'), node('verify', 'check-verify-counter', 'checks'),
      node('review', 'ai-review', 'review'), node('handoff', 'artifact-handoff', 'handoff')],
    executionStages: { version: 1, stages: [{ id: 'stage-counter', title: task.goal, outcome: task.goal, implementationNodeIds: ['implement'], requirementIds: ['req-counter'],
      scopeCheckNodeId: 'scope', checkNodeIds: ['verify'], boundaryNodeId: 'handoff' }], finalCheckNodeIds: ['verify'], finalReviewNodeId: 'review', handoffNodeId: 'handoff' } });
  const planHash = store.putObject('plans', plan);
  const capture = (text, role, sourceHash) => {
    writeFileSync(path.join(root, 'counter.custom'), text);
    return captureLearningSources({ store, projectRoot: root, sourceHash, files: [{ path: 'counter.custom', role,
      expected: { hash: sha256(text), size: Buffer.byteLength(text), mode: '100644' } }] });
  };
  const before = capture(beforeText, 'before', beforeHash);
  const pinned = store.putObject('operations', { before });
  function prepare(runId, text = 'count = 2\n') {
    const binding = { runId, planHash, taskHash }, resultHash = hashObject({ 'counter.custom': sha256(text) });
    const after = capture(text, 'after', resultHash);
    const receipt = (nodeId, beforeFingerprint, afterFingerprint, extra = {}) => {
      const definition = plan.nodes.find(item => item.id === nodeId);
      return store.putObject('receipts', ReceiptSchema.parse({ schemaVersion: 2, ...binding, nodeId, attemptId: 'attempt-one', attempt: 1, phase: 'finished',
        actionId: definition.action.id, actionVersion: 1, planVersion: 1, sourceHash: beforeHash, runtimeHash: hash, instructionsHash: hash,
        skills: [], permissions: [], grantedPermissions: [], termination: { stopped: true, uncertain: false, timedOut: false, outputLimit: false, signal: null, ticketHash: hash, execution: null },
        startedAt: stamp, finishedAt: stamp, durationMs: 1, exitCode: 0, verdict: 'pass', checks: [], artifacts: [], changedFiles: [], failureReason: null,
        beforeFingerprint, afterFingerprint, actor: 'qa-synthetic-host', operationId: 'operation-one', previousReceipt: null, ...extra }));
    };
    const input = { store, binding, stageId: 'stage-counter', before: new GraphStore(root).readObject('operations', pinned).before, after,
      implementationReceiptIds: [receipt('implement', beforeHash, resultHash)], checkReceiptIds: [receipt('scope', resultHash, resultHash), receipt('verify', resultHash, resultHash)],
      createdAt: stamp };
    return { binding, resultHash, receipt, input, create: (overrides = {}) => createLearningMaterial({ ...input, ...overrides }) };
  }
  return { root, store, prepare };
}

test('committed material and source ownership survive reopen without substituting another run or live bytes', t => {
  const f = fixture(t), a = f.prepare('run-alpha'), savedA = a.create();
  const committed = f.store.putObject('operations', { binding: { ...a.binding, materialHashes: [savedA.id] } });
  const b = f.prepare('run-bravo', 'count = 99\n'), savedB = b.create();
  const store = new GraphStore(f.root), binding = store.readObject('operations', committed).binding;
  const options = { store, binding, materialHash: savedA.id };
  const sourceA = readLearningMaterial(options).sources.find(source => source.role === 'after');
  const sourceB = readLearningMaterial({ store, materialHash: savedB.id, binding: { ...b.binding, materialHashes: [savedB.id] } }).sources.find(source => source.role === 'after');
  const bytesBeforeReads = readFileSync(path.join(f.root, 'counter.custom'));
  assert.equal(readLearningSourcePage({ ...options, sourceId: sourceA.id }).text, 'count = 2\n');
  assert.throws(() => readLearningMaterial({ ...options, binding: { ...binding, materialHashes: [] } }), { code: 'LEARNING_MATERIAL_DENIED' });
  assert.throws(() => readLearningMaterial({ ...options, binding: { ...binding, runId: b.binding.runId } }), { code: 'LEARNING_MATERIAL_DENIED' });
  assert.throws(() => readLearningSourcePage({ ...options, sourceId: sourceB.id }), { code: 'LEARNING_SOURCE_DENIED' });
  assert.deepEqual(readFileSync(path.join(f.root, 'counter.custom')), bytesBeforeReads);
  assert.equal(store.listRunIds().length, 0, 'Pure helpers must not create executor state');
});

test('lesson rejects false quotes and borrowed provenance even when all referenced objects exist', t => {
  const f = fixture(t), a = f.prepare('run-alpha'), saved = a.create();
  const b = f.prepare('run-bravo', 'count = 99\n'); b.create();
  const options = { store: f.store, materialHash: saved.id, binding: { ...a.binding, materialHashes: [saved.id] }, methodHash: hash };
  const source = readLearningMaterial(options).sources.find(item => item.role === 'after');
  const anchor = { sourceId: source.id, fileHash: source.fileHash, startLine: 1, endLine: 1, quote: 'count = 2' };
  const lesson = { version: 1, materialHash: saved.id, methodHash: hash, title: 'Счетчик', scope: 'counter.custom', steps: [{ id: 'step-counter', title: 'Присваивание',
    caller: 'Fixture', anchors: [anchor], input: 'Учебное значение 2', transformations: ['Сохранить 2'], output: '2', next: null, purpose: 'Обновить значение',
    changeConsequence: 'Значение изменится', alternatives: [], origin: { kind: 'test-fixture', label: 'Синтетический пример', anchor, receiptId: a.input.checkReceiptIds[1], artifactId: null } }],
    questions: [], wholeFlow: 'Присваивание значения', takeaways: [], limitations: ['Источник — тестовые данные, не запуск программы.'] };
  assert.deepEqual(validateLessonMaterial({ ...options, lesson }), lesson);
  for (const [change, code] of [
    [value => { value.steps[0].anchors[0].quote = 'count = 99'; }, 'LEARNING_ANCHOR_INVALID'],
    [value => { value.steps[0].origin.receiptId = b.input.checkReceiptIds[1]; }, 'LEARNING_ORIGIN_INVALID'],
    [value => { value.steps[0].origin.kind = 'manual-trace'; }, 'LEARNING_ORIGIN_INVALID'],
    [value => { value.steps[0].origin.kind = 'runtime-evidence'; }, 'LEARNING_RUNTIME_EVIDENCE_UNAVAILABLE'],
  ]) {
    const invalid = structuredClone(lesson); change(invalid);
    assert.throws(() => validateLessonMaterial({ ...options, lesson: invalid }), { code });
  }
});

test('ordinary partial context is explicit, but material assembly rejects a contradictory successful receipt', t => {
  const f = fixture(t), a = f.prepare('run-alpha');
  const partial = a.create({ gaps: [{ code: 'missing-context', path: 'dependency.custom', reason: 'Контекст не включен в выборку.' }] });
  assert.equal(partial.material.status, 'partial');
  assert.equal(partial.material.gaps[0].code, 'missing-context');
  const invalidCheck = a.receipt('verify', a.resultHash, a.resultHash, { exitCode: 7, failureReason: 'CHECK_FAILED' });
  assert.throws(() => {
    const accepted = a.create({ checkReceiptIds: [a.input.checkReceiptIds[0], invalidCheck] });
    const receipt = f.store.readObject('receipts', invalidCheck);
    t.diagnostic(JSON.stringify({ verdict: receipt.verdict, exitCode: receipt.exitCode,
      failureReason: receipt.failureReason, materialStatus: accepted.material.status, materialPersisted: Boolean(accepted.id) }));
  }, { code: 'LEARNING_RECEIPT_INVALID' });
});
