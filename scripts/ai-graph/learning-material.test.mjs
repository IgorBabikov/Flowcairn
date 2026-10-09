import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GraphStore } from './lib/store.mjs';
import { sha256, hashObject } from './lib/io.mjs';
import { GraphPlanV3Schema, TaskSpecV3Schema, ReceiptSchema } from './lib/schemas.mjs';
import { captureLearningSources } from './lib/learning-sources.mjs';
import { createLearningMaterial, readLearningMaterial, readLearningSourcePage, validateLearningSourceAnchor } from './lib/learning-material.mjs';
import { validateLessonMaterial } from './lib/lesson-validation.mjs';

const hash = hashObject('learning-fixture'), stamp = '2026-10-08T12:00:00.000Z';
const successfulTermination = () => ({ stopped: true, uncertain: false, timedOut: false, outputLimit: false, signal: null, ticketHash: null, execution: null });
function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-learning-material-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new GraphStore(root);
  const task = TaskSpecV3Schema.parse({ schemaVersion: 3, id: 'LEARNING-TEST', goal: 'Изменить преобразование входа', instructions: 'Пример для локального теста',
    scope: ['main.py'], contextPaths: ['helper.py'], acceptance: ['Вход преобразуется'], checks: ['verify-code'], sourceHash: hash });
  const taskHash = store.putObject('tasks', task);
  const node = (id, action, kind) => ({ id, title: id, outcome: id, needs: [], action: { id: action, version: 1, inputs: {} },
    success: { kind, requiredArtifacts: [] }, permissions: [], skills: [], resources: { reads: ['main.py'], writes: [], exclusive: [] }, retry: { maxAttempts: 1, backoffMs: 0 } });
  const checks = { version: 1, profileHash: hash, definitions: [], bindings: [] };
  const plan = GraphPlanV3Schema.parse({ schemaVersion: 3, stage: 'execution', taskHash, version: 1, parentPlanHash: null,
    sourceHash: hash, runtimeHash: hash, registryHash: hash, policyHash: hash, skills: [], checkRegistryHash: hashObject(checks), checks,
    learning: { version: 1, initialMode: 'after-stage' },
    taskContract: { version: 1, goal: task.goal, instructionsHash: hash, requirements: [{ id: 'req-change', title: task.goal, mandatory: true, origin: 'acceptance',
      verification: { method: 'check', checkIds: ['verify-code'], criterion: 'Вход преобразуется', paths: ['main.py'] }, workIds: ['implement'] }],
      optionalImprovements: [], constraints: [], assumptions: [], unknowns: [], scope: ['main.py'], forbiddenPaths: [], rigor: { level: 'light', reasons: ['Локальная проверка'] } },
    nodes: [node('implement', 'ai-implement', 'implementation'), node('scope-check', 'workspace-check', 'checks'), node('check-code', 'check-verify-code', 'checks'),
      node('review', 'ai-review', 'review'), node('handoff', 'artifact-handoff', 'handoff')],
    executionStages: { version: 1, stages: [{ id: 'stage-one', title: 'Изменение', outcome: 'Вход преобразуется', implementationNodeIds: ['implement'], requirementIds: ['req-change'],
      scopeCheckNodeId: 'scope-check', checkNodeIds: ['check-code'], boundaryNodeId: 'handoff' }], finalCheckNodeIds: ['check-code'], finalReviewNodeId: 'review', handoffNodeId: 'handoff' } });
  const planHash = store.putObject('plans', plan), binding = { runId: 'run-learning', planHash, taskHash };
  const save = (name, text, role) => {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); writeFileSync(path.join(root, name), text);
    return { path: name, role, expected: { hash: sha256(text), size: Buffer.byteLength(text), mode: '100644' } };
  };
  const capture = (entries, sourceHash) => captureLearningSources({ store, projectRoot: root, sourceHash, files: entries });
  const before = capture([save('main.py', 'def inc(x):\n    return x + 1\n', 'before')], hash);
  // Simulate durable caller reference before performing the source write.
  const operationHash = store.putObject('operations', { learningBefore: before });
  const resultHash = hashObject('final-source');
  const after = capture([save('main.py', 'def inc(x):\n    return x + 2\n', 'after'), save('helper.py', 'OFFSET = 2\n', 'context')], resultHash);
  const receipt = (nodeId, actionId, beforeFingerprint = resultHash, afterFingerprint = resultHash, extras = {}) => store.putObject('receipts', ReceiptSchema.parse({
    schemaVersion: 2, ...binding, nodeId, attemptId: 'attempt-one', attempt: 1, phase: 'finished', actionId, actionVersion: 1, planVersion: 1,
    sourceHash: hash, runtimeHash: hash, instructionsHash: hash, skills: [], permissions: [], grantedPermissions: [], termination: successfulTermination(),
    startedAt: stamp, finishedAt: stamp, durationMs: 0, exitCode: 0, verdict: 'pass', checks: [], artifacts: [], changedFiles: [], failureReason: null,
    beforeFingerprint, afterFingerprint, actor: 'local-test', operationId: 'operation-one', previousReceipt: null, ...extras }));
  const implementationReceiptIds = [receipt('implement', 'ai-implement', hash, resultHash)];
  const checkReceiptIds = [receipt('scope-check', 'workspace-check'), receipt('check-code', 'check-verify-code')];
  const reviewReceiptIds = [receipt('review', 'ai-review')];
  const input = { store, binding, stageId: 'stage-one', before: new GraphStore(root).readObject('operations', operationHash).learningBefore,
    after, implementationReceiptIds, checkReceiptIds, reviewReceiptIds, createdAt: stamp };
  const create = (overrides = {}) => createLearningMaterial({ ...input, ...overrides });
  const options = (material) => ({ store, materialHash: material.id, binding: { ...binding, materialHashes: [material.id] } });
  return { root, store, task, plan, binding, save, capture, before, after, input, create, options, receipt, resultHash };
}

test('stage material binds real GraphStore refs, before bytes and unchanged helper context; reads are immutable', (t) => {
  const fx = fixture(t), saved = fx.create(), options = fx.options(saved);
  assert.equal(saved.material.status, 'complete'); assert.deepEqual(saved.material.requirementIds, ['req-change']);
  assert.equal(saved.material.contractHash, hashObject(fx.plan.taskContract));
  const material = readLearningMaterial(options), after = material.sources.find((source) => source.role === 'after'), before = material.sources.find((source) => source.role === 'before');
  assert.equal(material.sources.find((source) => source.role === 'context').path, 'helper.py');
  writeFileSync(path.join(fx.root, 'main.py'), 'drift');
  const page = readLearningSourcePage({ ...options, sourceId: after.id, startLine: 2, lineCount: 1 });
  assert.equal(page.text, '    return x + 2');
  assert.equal(readLearningSourcePage({ ...options, sourceId: before.id, startLine: 2, lineCount: 1 }).text, '    return x + 1');
  const anchor = { sourceId: after.id, fileHash: after.fileHash, startLine: 2, endLine: 2, quote: page.text };
  assert.deepEqual(validateLearningSourceAnchor({ ...options, anchor }), anchor);
  for (const change of [{ quote: '    return x + 3' }, { startLine: 1 }, { fileHash: hash }, { endLine: 999 }])
    assert.throws(() => validateLearningSourceAnchor({ ...options, anchor: { ...anchor, ...change } }), { code: 'LEARNING_ANCHOR_INVALID' });
  assert.equal(readFileSync(path.join(fx.root, 'main.py'), 'utf8'), 'drift');
  assert.equal(fx.store.listRunIds().length, 0); // helpers never create or change execution state
});

test('reading rejects foreign run, unregistered material, foreign source, changed policy and pinned corruption', (t) => {
  const fx = fixture(t), saved = fx.create(), options = fx.options(saved);
  assert.throws(() => readLearningMaterial({ ...options, binding: { ...options.binding, materialHashes: [] } }), { code: 'LEARNING_MATERIAL_DENIED' });
  assert.throws(() => readLearningMaterial({ ...options, binding: { ...options.binding, runId: 'other-run' } }), { code: 'LEARNING_MATERIAL_DENIED' });
  assert.throws(() => readLearningSourcePage({ ...options, sourceId: 'source-foreign' }), { code: 'LEARNING_SOURCE_DENIED' });
  assert.throws(() => readLearningMaterial({ ...options, policy: { forbiddenPaths: ['main.py'] } }), { code: 'LEARNING_SOURCE_DENIED' });
  const file = path.join(fx.root, '.ai-orchestrator/graph/learning-materials', `${saved.id}.json`);
  const data = JSON.parse(readFileSync(file, 'utf8')); data.data.goal = 'changed'; writeFileSync(file, JSON.stringify(data));
  assert.throws(() => readLearningMaterial(options), { code: 'OBJECT_TAMPERED' });
});

test('receipt/task/stage/source and artifact references cannot be mixed across executions', (t) => {
  const fx = fixture(t);
  const otherTaskHash = fx.store.putObject('tasks', { ...fx.task, id: 'OTHER-TASK' });
  assert.throws(() => fx.create({ binding: { ...fx.binding, taskHash: otherTaskHash } }), { code: 'LEARNING_BINDING_INVALID' });
  assert.throws(() => fx.create({ stageId: 'stage-missing' }), { code: 'LEARNING_STAGE_INVALID' });
  assert.throws(() => fx.create({ before: { ...fx.before, sourceHash: fx.resultHash } }), { code: 'LEARNING_RECEIPT_INVALID' });
  assert.throws(() => fx.create({ after: { ...fx.after, sourceHash: hash } }), { code: 'LEARNING_RECEIPT_INVALID' });
  const foreign = fx.receipt('check-code', 'check-verify-code', fx.resultHash, fx.resultHash, { runId: 'other-run' });
  assert.throws(() => fx.create({ checkReceiptIds: [foreign] }), { code: 'LEARNING_RECEIPT_INVALID' });
  const failed = fx.receipt('check-code', 'check-verify-code', fx.resultHash, fx.resultHash, { verdict: 'fail' });
  assert.throws(() => fx.create({ checkReceiptIds: [failed] }), { code: 'LEARNING_RECEIPT_INVALID' });
  assert.throws(() => fx.create({ checkReceiptIds: [] }), { code: 'LEARNING_RECEIPT_INVALID' });
  assert.throws(() => fx.create({ checkReceiptIds: [fx.input.checkReceiptIds[1]] }), { code: 'LEARNING_RECEIPT_INVALID' });
  const wrongAction = fx.receipt('check-code', 'ai-implement');
  assert.throws(() => fx.create({ checkReceiptIds: [wrongAction] }), { code: 'LEARNING_RECEIPT_INVALID' });
  assert.throws(() => fx.create({ diffArtifactIds: [hash] }), { code: 'LEARNING_ARTIFACT_INVALID' });
  assert.throws(() => fx.create({ before: { ...fx.before, sourceCatalogHash: fx.after.sourceCatalogHash } }), { code: 'LEARNING_CAPTURE_INVALID' });
});

test('check receipts reject contradictory completion facts before material persistence', (t) => {
  const fx = fixture(t);
  const cases = [
    { exitCode: 7 }, { exitCode: null }, { failureReason: 'CHECK_FAILED' }, { failureReason: '' }, { finishedAt: null },
    { termination: null },
    ...[{ stopped: false }, { uncertain: true }, { timedOut: true }, { outputLimit: true }, { signal: 'SIGTERM' }]
      .map((flags) => ({ termination: { ...successfulTermination(), ...flags } })),
    { checks: [{ id: 'check-code', passed: false, exitCode: 0, durationMs: 1, summary: 'Failed', inputHash: fx.resultHash }] },
    { checks: [{ id: 'check-code', passed: true, exitCode: 7, durationMs: 1, summary: 'Contradictory', inputHash: fx.resultHash }] },
  ];
  for (const extra of cases) {
    const invalid = fx.receipt('check-code', 'check-verify-code', fx.resultHash, fx.resultHash, extra);
    assert.throws(() => fx.create({ checkReceiptIds: [fx.input.checkReceiptIds[0], invalid] }), { code: 'LEARNING_RECEIPT_INVALID' }, JSON.stringify(extra));
  }
  const invalidScope = fx.receipt('scope-check', 'workspace-check', fx.resultHash, fx.resultHash, { failureReason: 'SCOPE_FAILED' });
  assert.throws(() => fx.create({ checkReceiptIds: [invalidScope, fx.input.checkReceiptIds[1]] }), { code: 'LEARNING_RECEIPT_INVALID' });
  assert.equal(existsSync(path.join(fx.root, '.ai-orchestrator/graph/learning-materials')), false);
});

test('internal scope needs no process ticket; successful check and historical source reads remain usable', (t) => {
  const fx = fixture(t);
  const scope = fx.store.readObject('receipts', fx.input.checkReceiptIds[0]);
  assert.deepEqual(scope.termination, successfulTermination());
  assert.deepEqual(scope.checks, []);
  const successfulCheck = fx.receipt('check-code', 'check-verify-code', fx.resultHash, fx.resultHash, {
    termination: { ...successfulTermination(), ticketHash: hash },
    checks: [{ id: 'check-code', passed: true, exitCode: 0, durationMs: 1, summary: 'Успех', inputHash: fx.resultHash }],
  });
  const saved = fx.create({ checkReceiptIds: [fx.input.checkReceiptIds[0], successfulCheck] });
  assert.equal(saved.material.status, 'complete');
  // Reading an immutable historical material is not new success acceptance.
  const olderCheck = fx.receipt('check-code', 'check-verify-code', fx.resultHash, fx.resultHash, { termination: null });
  const historical = { ...saved.material, checkReceiptIds: [fx.input.checkReceiptIds[0], olderCheck] };
  const id = fx.store.putObject('learning-materials', historical);
  const options = fx.options({ id });
  const result = readLearningMaterial(options);
  const source = result.sources.find((item) => item.role === 'after');
  assert.equal(readLearningSourcePage({ ...options, sourceId: source.id, startLine: 2, lineCount: 1 }).text, '    return x + 2');
  assert.deepEqual(result.material, historical);
});

test('final task material captures the current final version, not old stage code', (t) => {
  const fx = fixture(t), stage = fx.create();
  const finalHash = hashObject('later-stage-final');
  const after = fx.capture([fx.save('main.py', 'def inc(x):\n    return x + 3\n', 'after'), fx.save('helper.py', 'OFFSET = 3\n', 'context')], finalHash);
  const implementationReceiptIds = [fx.receipt('implement', 'ai-implement', hash, finalHash)];
  const checkReceiptIds = [fx.receipt('check-code', 'check-verify-code', finalHash, finalHash)];
  const reviewReceiptIds = [fx.receipt('review', 'ai-review', finalHash, finalHash)];
  const final = fx.create({ kind: 'task', stageId: null, after, implementationReceiptIds, checkReceiptIds, reviewReceiptIds });
  const current = readLearningMaterial(fx.options(final)).sources.find((source) => source.role === 'after');
  assert.equal(readLearningSourcePage({ ...fx.options(final), sourceId: current.id, startLine: 2, lineCount: 1 }).text, '    return x + 3');
  const old = readLearningMaterial(fx.options(stage)).sources.find((source) => source.role === 'after');
  assert.equal(readLearningSourcePage({ ...fx.options(stage), sourceId: old.id, startLine: 2, lineCount: 1 }).text, '    return x + 2');
  assert.throws(() => fx.create({ kind: 'task', stageId: null, after, implementationReceiptIds, checkReceiptIds, reviewReceiptIds: [] }), { code: 'LEARNING_RECEIPT_INVALID' });
  assert.throws(() => fx.create({ kind: 'task', stageId: null, after: fx.after, implementationReceiptIds, checkReceiptIds, reviewReceiptIds }), { code: 'LEARNING_RECEIPT_INVALID' });
});

test('combined before+after limits produce explicit partial material; excluded context produces unavailable', (t) => {
  const fx = fixture(t);
  const before = fx.capture(Array.from({ length: 5 }, (_, index) => fx.save(`large-${index}.txt`, 'a'.repeat(256 * 1024), 'before')), hash);
  const after = fx.capture(Array.from({ length: 5 }, (_, index) => fx.save(`large-${index}.txt`, 'b'.repeat(256 * 1024), 'after')), fx.resultHash);
  const saved = fx.create({ before, after });
  const material = readLearningMaterial(fx.options(saved));
  assert.equal(material.material.status, 'partial'); assert.equal(material.sources.length, 8);
  assert.equal(material.sources.reduce((sum, source) => sum + source.bytes, 0), 2 * 1024 * 1024);
  assert.equal(material.material.gaps.length, 2); assert.ok(material.material.gaps.every((gap) => gap.code === 'size-limit'));
  const hidden = fx.create({ policy: { denyGlobs: ['**'] } });
  assert.equal(hidden.material.status, 'unavailable'); assert.ok(hidden.material.gaps.every((gap) => gap.path === null));
  const incomplete = fx.create({ gaps: [{ code: 'missing-context', path: 'dependency.custom', reason: 'Зависимость не входит в объявленный контекст.' }] });
  assert.equal(incomplete.material.status, 'partial');
  const manyBefore = fx.capture(Array.from({ length: 33 }, (_, index) => fx.save(`small-${index}.txt`, 'old', 'before')), hash);
  const manyAfter = fx.capture(Array.from({ length: 33 }, (_, index) => fx.save(`small-${index}.txt`, 'new', 'after')), fx.resultHash);
  const many = fx.create({ before: manyBefore, after: manyAfter });
  assert.equal(readLearningMaterial(fx.options(many)).sources.length, 64);
  assert.equal(many.material.status, 'partial'); assert.equal(many.material.gaps.length, 2);
});

test('lesson validation checks every saved anchor and distinguishes source fixtures from invented runtime evidence', (t) => {
  const fx = fixture(t), saved = fx.create(), options = fx.options(saved);
  const source = readLearningMaterial(options).sources.find((item) => item.role === 'after');
  const anchor = { sourceId: source.id, fileHash: source.fileHash, startLine: 2, endLine: 2, quote: '    return x + 2' };
  const lesson = { version: 1, materialHash: saved.id, methodHash: hash, title: 'Преобразование', scope: 'main.py',
    steps: [{ id: 'step-one', title: 'Возврат', caller: 'inc(x)', anchors: [anchor], input: 'Учебный пример: x = 1', transformations: ['1 + 2 = 3'],
      output: '3', next: null, purpose: 'Преобразовать вход', changeConsequence: 'Результат изменится', alternatives: [],
      origin: { kind: 'manual-trace', label: 'Ручная трассировка', receiptId: null, artifactId: null, anchor: null } }],
    questions: [{ id: 'question-one', text: 'Что вернется при x = 2?', anchors: [anchor] }], wholeFlow: 'Вход → сложение → возврат',
    takeaways: ['Прочитать выражение return'], limitations: ['Трассировка не является запуском.'] };
  const validate = (value) => validateLessonMaterial({ ...options, methodHash: hash, lesson: value });
  assert.deepEqual(validate(lesson), lesson);
  const fixtureLesson = structuredClone(lesson); fixtureLesson.steps[0].origin = { kind: 'test-fixture', label: 'Fixture', receiptId: null, artifactId: null, anchor };
  assert.deepEqual(validate(fixtureLesson), fixtureLesson);
  for (const modify of [
    (value) => { value.steps[0].anchors[0].quote = 'return 999'; },
    (value) => { value.questions[0].anchors[0].fileHash = hash; },
    (value) => { value.steps[0].origin.anchor = { ...anchor, sourceId: 'foreign-source' }; },
  ]) { const invalid = structuredClone(lesson); modify(invalid); assert.throws(() => validate(invalid), { code: 'LEARNING_ANCHOR_INVALID' }); }
  const fake = structuredClone(lesson); fake.steps[0].origin.kind = 'runtime-evidence'; fake.steps[0].origin.receiptId = fx.input.checkReceiptIds[0];
  assert.throws(() => validate(fake), { code: 'LEARNING_RUNTIME_EVIDENCE_UNAVAILABLE' });
  const unattached = structuredClone(fixtureLesson); unattached.steps[0].origin.artifactId = hash;
  assert.throws(() => validate(unattached), { code: 'LEARNING_ORIGIN_INVALID' });
  const missing = structuredClone(fixtureLesson); missing.steps[0].origin.anchor = null;
  assert.throws(() => validate(missing), { code: 'LEARNING_ORIGIN_INVALID' });
});
