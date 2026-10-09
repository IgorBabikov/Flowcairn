import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GraphStore } from './lib/store.mjs';
import { GraphPlanV3Schema, TaskSpecV3Schema } from './lib/schemas.mjs';
import { StageMaterialSchema } from './lib/learning-schemas.mjs';
import { hashObject, sha256 } from './lib/io.mjs';
import { captureLearningSources, readLearningSourceCatalog } from './lib/learning-sources.mjs';
import { readLearningMethod, buildLearningPrompt, learningOutputSchema, validateLearningOutput } from './lib/learning-prompt.mjs';
import { learningProviderCapability, prepareLearningProvider, learningProviderCommand, readPreparedLearningInput, parseLearningProviderOutput, disposeLearningProvider } from './lib/learning-provider.mjs';

const hash = hashObject('learning-provider-fixture');
const complete = () => ({ exitCode: 0, stopped: true, uncertain: false, timedOut: false, outputLimit: false, signal: null, failureReason: null });

function fixture(t, text = 'count = 2\n') {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-learning-input-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new GraphStore(root), methodHash = readLearningMethod().hash;
  writeFileSync(path.join(root, 'counter.custom'), text);
  const capture = captureLearningSources({ store, projectRoot: root, sourceHash: hash, files: [
    { path: 'counter.custom', role: 'after', expected: { hash: sha256(text), size: Buffer.byteLength(text), mode: '100644' } },
  ] });
  const source = readLearningSourceCatalog(store, capture.sourceCatalogHash).sources[0];
  const task = TaskSpecV3Schema.parse({ schemaVersion: 3, id: 'LESSON-INPUT', goal: 'Объяснить преобразование', instructions: 'Объяснить сохраненный код',
    scope: ['counter.custom'], acceptance: ['Понятен поток'], checks: [], sourceHash: hash });
  const taskHash = store.putObject('tasks', task);
  const node = (id) => ({ id, title: id, outcome: id, needs: [], action: { id: 'ai-implement', version: 1, inputs: {} },
    success: { kind: 'implementation', requiredArtifacts: [] }, permissions: [], skills: [], resources: { reads: [], writes: [], exclusive: [] }, retry: { maxAttempts: 1, backoffMs: 0 } });
  const contract = { version: 1, goal: task.goal, instructionsHash: hash, requirements: [{ id: 'req-read', title: 'Прочитать код', mandatory: true, origin: 'acceptance',
    verification: { method: 'source-review', checkIds: [], criterion: 'Понятен поток', paths: ['counter.custom'] }, workIds: ['implement'] }],
    optionalImprovements: [], constraints: [], assumptions: [], unknowns: [], scope: ['counter.custom'], forbiddenPaths: [], rigor: { level: 'light', reasons: ['Fixture'] } };
  // Synthetic stored host plan/material: these tests do not claim execution proof.
  const plan = GraphPlanV3Schema.parse({ schemaVersion: 3, stage: 'execution', taskHash, version: 1, parentPlanHash: null, sourceHash: hash,
    runtimeHash: hash, registryHash: hash, policyHash: hash, skills: [], nodes: [node('implement'), node('verify')], taskContract: contract,
    checks: { version: 1, profileHash: hash, definitions: [], bindings: [] }, checkRegistryHash: hash,
    learning: { version: 1, initialMode: 'after-task' }, executionStages: { version: 1,
      stages: [{ id: 'stage-one', title: 'Этап', outcome: 'Счетчик', implementationNodeIds: ['implement'], requirementIds: ['req-read'], scopeCheckNodeId: 'verify', checkNodeIds: ['verify'], boundaryNodeId: 'verify' }],
      finalCheckNodeIds: ['verify'], finalReviewNodeId: 'verify', handoffNodeId: 'verify' } });
  const planHash = store.putObject('plans', plan), runId = 'run-lesson';
  const material = StageMaterialSchema.parse({ version: 1, kind: 'stage', runId, planHash, taskHash, contractHash: hashObject(contract), stageId: 'stage-one',
    goal: task.goal, outcome: 'Счетчик', requirementIds: ['req-read'], beforeHash: hash, resultHash: hash, createdAt: '2026-10-08T12:00:00.000Z',
    sourceCatalogHash: capture.sourceCatalogHash, implementationReceiptIds: [], checkReceiptIds: [], reviewReceiptIds: [], diffArtifactIds: [], findingsArtifactIds: [],
    status: 'complete', gaps: [] });
  const materialHash = store.putObject('learning-materials', material);
  const input = { store, materialHash, methodHash, binding: { runId, planHash, taskHash, materialHashes: [materialHash] }, policy: {} };
  const anchor = { sourceId: source.id, fileHash: source.fileHash, startLine: 1, endLine: 1, quote: text.split('\n')[0] };
  const body = { title: 'Счетчик', scope: 'counter.custom', steps: [{ id: 'step-count', title: 'Присваивание', caller: 'Пример', anchors: [anchor], input: 'Учебное значение 2',
    transformations: ['Присвоить count значение 2'], output: 'count = 2', next: null, purpose: 'Сохранить значение', changeConsequence: 'Значение изменится', alternatives: [],
    origin: { kind: 'teaching-example', label: 'Учебный пример', receiptId: null, artifactId: null, anchor: null } }],
    questions: [], wholeFlow: 'Вход → присваивание', takeaways: ['Проследить значение'], limitations: ['Пример не запускался.'] };
  const prepare = (extra = {}) => {
    const prepared = prepareLearningProvider({ ...input, provider: 'codex', cliVersion: '0.156.1', model: 'configured-test-model', ...extra });
    t.after(() => { if (existsSync(prepared.scratch)) rmSync(prepared.scratch, { recursive: true, force: true }); });
    return prepared;
  };
  return { root, input, body, anchor, source, prepare };
}

test('prompt includes complete saved bytes and immutable IDs, without live project reads or inherited instructions', (t) => {
  const fx = fixture(t, '\ufeffcount = 2\r\n'), expected = readFileSync(path.join(fx.root, 'counter.custom'), 'utf8');
  writeFileSync(path.join(fx.root, 'counter.custom'), 'count = 99');
  writeFileSync(path.join(fx.root, 'AGENTS.md'), 'UNRELATED_MARKER_FROM_LIVE_PROJECT');
  const input = buildLearningPrompt(fx.input);
  assert.ok(input.prompt.includes(JSON.stringify(expected)));
  assert.ok(input.prompt.includes(fx.source.fileHash));
  assert.equal(input.prompt.includes('UNRELATED_MARKER_FROM_LIVE_PROJECT'), false);
  assert.equal(input.prompt.includes(fx.root), false);
  assert.equal(input.inputHash, sha256(input.prompt));
  assert.equal(input.methodHash, readLearningMethod().hash);
  assert.equal(readFileSync(path.join(fx.root, 'counter.custom'), 'utf8'), 'count = 99');
  assert.throws(() => buildLearningPrompt({ ...fx.input, methodHash: hash }), { code: 'LEARNING_METHOD_DRIFT' });
});

test('prompt refuses oversized full context, revoked source policy, foreign binding and secret-bearing questions', (t) => {
  const large = fixture(t, 'x'.repeat(256 * 1024));
  assert.throws(() => buildLearningPrompt(large.input), { code: 'LEARNING_INPUT_LIMIT' });
  const fx = fixture(t);
  assert.throws(() => buildLearningPrompt({ ...fx.input, policy: { denyGlobs: ['**'] } }), { code: 'LEARNING_SOURCE_DENIED' });
  assert.throws(() => buildLearningPrompt({ ...fx.input, binding: { ...fx.input.binding, materialHashes: [] } }), { code: 'LEARNING_MATERIAL_DENIED' });
  assert.throws(() => buildLearningPrompt({ ...fx.input, question: { lessonHash: hash, anchor: fx.anchor, text: 'password=' + 'abcdefgh'.repeat(4) } }), { code: 'UNSAFE_SOURCE' });
});

test('provider schema excludes host metadata and imperative fields; host attaches identities and validates exact anchors', (t) => {
  const fx = fixture(t), schema = learningOutputSchema('lesson');
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.materialHash, undefined);
  assert.equal(schema.properties.methodHash, undefined);
  assert.equal(schema.properties.commands, undefined);
  assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
  const lesson = validateLearningOutput({ ...fx.input, output: JSON.stringify(fx.body) });
  assert.equal(lesson.materialHash, fx.input.materialHash); assert.equal(lesson.methodHash, fx.input.methodHash); assert.equal(lesson.version, 1);
  const wrong = structuredClone(fx.body); wrong.steps[0].anchors[0].quote = 'invented';
  assert.throws(() => validateLearningOutput({ ...fx.input, output: JSON.stringify(wrong) }), { code: 'LEARNING_ANCHOR_INVALID' });
  const fake = structuredClone(fx.body); fake.steps[0].origin.kind = 'runtime-evidence';
  assert.throws(() => validateLearningOutput({ ...fx.input, output: JSON.stringify(fake) }), { code: 'LEARNING_RUNTIME_EVIDENCE_UNAVAILABLE' });
  for (const output of [JSON.stringify({ ...fx.body, commands: [] }), JSON.stringify({ ...fx.body, materialHash: hash }), '```json\n{}\n```', '{} {}'])
    assert.throws(() => validateLearningOutput({ ...fx.input, output }), { code: 'LEARNING_OUTPUT_INVALID' });
  assert.throws(() => validateLearningOutput({ ...fx.input, output: 'x'.repeat(65537) }), { code: 'LEARNING_OUTPUT_LIMIT' });
});

test('question uses the saved validated lesson and selected anchor; answer binding is attached only by host', (t) => {
  const fx = fixture(t), lesson = validateLearningOutput({ ...fx.input, output: JSON.stringify(fx.body) });
  const lessonHash = fx.input.store.putObject('lessons', lesson);
  const input = { ...fx.input, question: { lessonHash, anchor: fx.anchor, text: 'Какое значение получает count?' } };
  assert.equal(buildLearningPrompt(input).kind, 'question');
  const body = { text: 'В учебном примере count получает 2.', anchors: [fx.anchor], limitations: ['Код не запускался.'] };
  const answer = validateLearningOutput({ ...input, output: JSON.stringify(body) });
  assert.equal(answer.lessonHash, lessonHash); assert.equal(answer.question, input.question.text); assert.deepEqual(answer.anchor, fx.anchor);
  const invalid = { ...body, anchors: [{ ...fx.anchor, fileHash: hash }] };
  assert.throws(() => validateLearningOutput({ ...input, output: JSON.stringify(invalid) }), { code: 'LEARNING_ANCHOR_INVALID' });
  assert.throws(() => buildLearningPrompt({ ...input, question: { ...input.question, text: 'x'.repeat(4001) } }), { code: 'LEARNING_QUESTION_INVALID' });
});

test('unverified provider modes are explicit denials with no runnable command or unsafe flags', (t) => {
  const fx = fixture(t);
  for (const provider of ['codex', 'claude', 'cursor']) {
    const capability = learningProviderCapability({ provider, cliVersion: 'unverified-version' });
    assert.equal(capability.allowed, false);
    const prepared = fx.prepare({ provider });
    assert.equal(prepared.command, null);
    assert.throws(() => learningProviderCommand(prepared), { code: capability.code });
    assert.equal('env' in prepared, false); assert.equal('args' in prepared, false);
    disposeLearningProvider(prepared, { stopped: true });
  }
  assert.throws(() => fx.prepare({ provider: 'unknown-provider' }), { code: 'LEARNING_PROVIDER_UNSUPPORTED' });
  assert.throws(() => fx.prepare({ model: 'provider-default' }), { code: 'LEARNING_MODEL_INVALID' });
});

test('private preparation binds input/schema, propagates completion/policy errors and disposes only after a confirmed stop', (t) => {
  const fx = fixture(t), prepared = fx.prepare();
  if (process.platform !== 'win32') {
    assert.equal(lstatSync(prepared.scratch).mode & 0o077, 0);
    assert.equal(lstatSync(prepared.schemaFile).mode & 0o077, 0);
  }
  assert.notEqual(prepared.scratch, fx.root);
  assert.equal(prepared.maxOutputBytes, 2 * 1024 * 1024);
  assert.equal(prepared.maxResultBytes, 64 * 1024);
  assert.ok(readPreparedLearningInput(prepared).includes(fx.source.fileHash));
  const result = { output: JSON.stringify(fx.body), policy: {}, completion: complete() };
  assert.equal(parseLearningProviderOutput(prepared, result).materialHash, fx.input.materialHash);
  assert.throws(() => parseLearningProviderOutput(prepared, { ...result, completion: { ...complete(), uncertain: true } }), { code: 'LEARNING_PROVIDER_INCOMPLETE' });
  assert.throws(() => parseLearningProviderOutput(prepared, { ...result, policy: { forbiddenPaths: ['counter.custom'] } }), { code: 'LEARNING_SOURCE_DENIED' });
  assert.throws(() => disposeLearningProvider(prepared, { stopped: false }), { code: 'LEARNING_PROCESS_UNCERTAIN' });
  assert.ok(existsSync(prepared.scratch));
  // A provider output-limit failure must still allow safe cleanup after stop.
  writeFileSync(prepared.resultFile, 'x'.repeat(65537));
  disposeLearningProvider(prepared, { stopped: true });
  assert.equal(existsSync(prepared.scratch), false);
  disposeLearningProvider(prepared, { stopped: true });
  assert.throws(() => readPreparedLearningInput(prepared), { code: 'LEARNING_PREPARATION_INVALID' });
});

test('tampered preparation and linked cleanup targets are refused without touching the linked file', (t) => {
  const fx = fixture(t), first = fx.prepare();
  writeFileSync(path.join(first.scratch, 'input.txt'), 'changed');
  assert.throws(() => readPreparedLearningInput(first), { code: 'LEARNING_PREPARATION_CHANGED' });
  disposeLearningProvider(first, { stopped: true });
  const second = fx.prepare(), target = path.join(fx.root, 'keep.txt');
  writeFileSync(target, 'preserve'); unlinkSync(second.resultFile); symlinkSync(target, second.resultFile);
  assert.throws(() => disposeLearningProvider(second, { stopped: true }), { code: 'LEARNING_SCRATCH_CHANGED' });
  assert.equal(readFileSync(target, 'utf8'), 'preserve');
  unlinkSync(second.resultFile); writeFileSync(second.resultFile, '', { mode: 0o600 });
  disposeLearningProvider(second, { stopped: true });
});
