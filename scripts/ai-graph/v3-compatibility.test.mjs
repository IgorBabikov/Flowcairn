import assert from 'node:assert/strict';
import test from 'node:test';
import { hashObject } from './lib/io.mjs';
import {
  TaskInputSchema, TaskInputV2Schema, TaskInputV3Schema, TaskSpecSchema, TaskSpecV2Schema,
  GraphPlanSchema, GraphPlanV2Schema, RunStateSchema, RunStateV2Schema,
  PlanningEnvelopeSchema, PlanningEnvelopeV2Schema, PendingBindingSchema, Status,
} from './lib/schemas.mjs';
import { CheckProfileSchema, RegisteredCheckSchema, PlanChecksSchema } from './lib/check-schemas.mjs';
import {
  ContinueLearningSchema, LearningSnapshotSchema, LessonMaterialSchema, SourceAnchorSchema,
} from './lib/learning-schemas.mjs';

const hash = 'a'.repeat(64);
const date = '2026-10-08T00:00:00.000Z';
const input = {
  id: 'TASK-OLD', goal: 'Проверить результат', instructions: 'Сохранить поведение',
  scope: ['src'], contextPaths: [], forbiddenPaths: [], includeUntracked: [], acceptance: ['Работает'],
  checks: ['tests'], resources: [], limits: { maxAttempts: 2, maxReplans: 2, timeoutMs: 600000 },
};
const task = { ...input, schemaVersion: 2, sourceHash: hash };
const node = (id) => ({
  id, title: 'Проверка', outcome: 'Проверено', needs: [], action: { id: 'check-tests', version: 1, inputs: {} },
  success: { kind: 'checks', requiredArtifacts: ['test-report'] }, permissions: ['workspace.output.write'], skills: [],
  resources: { reads: ['src'], writes: [], exclusive: [] }, retry: { maxAttempts: 1, backoffMs: 0 },
});
const plan = {
  schemaVersion: 2, taskHash: hash, version: 1, parentPlanHash: null,
  sourceHash: hash, runtimeHash: hash, registryHash: hash, policyHash: hash,
  skills: [], nodes: [node('check-one'), node('check-two')],
};
const envelope = {
  schemaVersion: 2, taskHash: hash, sourceHash: hash, runtimeHash: hash, registryHash: hash, policyHash: hash,
  skills: [], readPaths: ['src'], provider: 'codex', timeoutMs: 600000,
};
const run = {
  schemaVersion: 2, runId: 'run-old', revision: 0, taskHash: hash, planHash: hash, envelopeHash: hash,
  sourceHash: hash, sourceBundle: 'bundles/example', planVersion: 1, maxReplans: 2, supersedesRunId: null,
  createdAt: date, updatedAt: date, status: 'pending', finalDisposition: null, nodes: {}, permissions: [],
  binding: null, workspaceFingerprint: null, initialFingerprint: null, activeOperation: null, operations: {},
  planningArtifacts: [], actor: 'local-user', intakeHash: hash, createOperationId: 'create-example', setupPending: false,
};
const check = {
  id: 'python-tests', title: 'Python tests', purpose: 'Run project assertions',
  command: { executable: 'python3', argv: ['-m', 'unittest'], cwd: '.' },
  inputPaths: ['pyproject.toml'], outputPaths: [], timeoutMs: 10000, maxOutputBytes: 65536,
};
const checks = {
  version: 1, profileHash: hash, definitions: [check],
  bindings: [{ id: check.id, definitionHash: hash, executableHash: hash, invocationHash: hash, inputManifestHash: hash, toolchainHash: hash }],
};
const stage = {
  id: 'stage-01', title: 'Результат', outcome: 'Работает', implementationNodeIds: ['implement'], requirementIds: [],
  scopeCheckNodeId: 'scope-check', checkNodeIds: ['check-one'], boundaryNodeId: 'handoff',
};
const stages = { version: 1, stages: [stage], finalCheckNodeIds: ['check-one'], finalReviewNodeId: 'review', handoffNodeId: 'handoff' };
const planV3 = { ...plan, schemaVersion: 3, stage: 'execution', checkRegistryHash: hash, checks,
  learning: { version: 1, initialMode: 'after-stage' }, executionStages: stages };
const runV3 = { ...run, schemaVersion: 3, continuation: { kind: 'open' },
  learning: { version: 1, mode: 'after-stage', stages: {}, eventIds: [], jobs: {}, progress: {} } };

test('strict V2 readers and dual readers preserve historical objects byte-for-byte canonically', () => {
  assert.equal(TaskInputSchema, TaskInputV2Schema);
  for (const [value, legacy, reader, expectedHash] of [
    [task, TaskSpecV2Schema, TaskSpecSchema, '2c4df0c0f7ad076d55d2d76d134e3ed172930dd8d05b02e5febc800ec03021e3'],
    [plan, GraphPlanV2Schema, GraphPlanSchema, '616fc6be12808d97449baa1e20dbb4015e3f4e08f9bd9e0d42b08471cad39987'],
    [envelope, PlanningEnvelopeV2Schema, PlanningEnvelopeSchema, '08cf772942290cdff7c9ffc53ab5264514e34f1d4a313c53f58c6d315b9555ba'],
    [run, RunStateV2Schema, RunStateSchema, '79d888758274dd6078f83ef2921da712e59b107f60f7801e1ad31723d83fb893'],
  ]) {
    const before = structuredClone(value);
    assert.deepEqual(reader.parse(value), before);
    assert.deepEqual(legacy.parse(value), before);
    assert.equal(hashObject(reader.parse(value)), expectedHash);
    assert.equal(hashObject(legacy.parse(value)), expectedHash);
    assert.deepEqual(value, before);
    assert.equal(reader.safeParse({ ...value, unknownFutureField: true }).success, false);
  }
});

test('new task input accepts arbitrary bounded check IDs without changing V2 intake', () => {
  const generic = { ...input, checks: ['python-tests', 'rust-check', 'custom-verifier'] };
  assert.equal(TaskInputSchema.safeParse(generic).success, false);
  assert.deepEqual(TaskInputV3Schema.parse(generic), generic);
  assert.equal(TaskInputV3Schema.safeParse({ ...generic, checks: Array(7).fill('tests') }).success, false);
  assert.equal(TaskInputV3Schema.safeParse({ ...generic, checks: ['../shell'] }).success, false);
  assert.equal(TaskInputV3Schema.safeParse({ ...generic, command: 'arbitrary' }).success, false);
  const next = { ...generic, schemaVersion: 3, sourceHash: hash, learningMode: 'after-task' };
  assert.deepEqual(TaskSpecSchema.parse(next), next);
  assert.equal(TaskSpecV2Schema.safeParse(next).success, false);
});

test('V3 execution requires stage metadata, planning permits null, old readers reject both', () => {
  assert.deepEqual(GraphPlanSchema.parse(planV3), planV3);
  const planning = { ...planV3, stage: 'planning', executionStages: null };
  assert.deepEqual(GraphPlanSchema.parse(planning), planning);
  assert.equal(GraphPlanSchema.safeParse({ ...planV3, executionStages: null }).success, false);
  assert.equal(GraphPlanSchema.safeParse({ ...planning, executionStages: stages }).success, false);
  assert.equal(GraphPlanV2Schema.safeParse(planV3).success, false);
  assert.equal(GraphPlanV2Schema.safeParse(planning).success, false);
  const nextEnvelope = { ...envelope, schemaVersion: 3, checkRegistryHash: hash };
  assert.deepEqual(PlanningEnvelopeSchema.parse(nextEnvelope), nextEnvelope);
  assert.equal(PlanningEnvelopeV2Schema.safeParse(nextEnvelope).success, false);
  assert.equal(PlanningEnvelopeSchema.safeParse({ ...nextEnvelope, checkRegistryHash: undefined }).success, false);
});

test('a persisted V3 plan with no verifier remains readable without inventing checks or execution readiness', () => {
  const unexecutable = {
    ...planV3,
    checks: { ...checks, definitions: [], bindings: [] },
    executionStages: { ...stages, stages: [{ ...stage, checkNodeIds: [] }], finalCheckNodeIds: [] },
  };
  assert.deepEqual(GraphPlanSchema.parse(unexecutable), unexecutable);
  // Parsing grants no capability, proof, or substitute verifier. The service owns denial.
  assert.equal('capabilities' in GraphPlanSchema.parse(unexecutable), false);
  assert.equal(GraphPlanSchema.safeParse({ ...unexecutable, executionReady: true }).success, false);
});

test('unknown persisted versions fail closed and V3 fields cannot be smuggled into V2', () => {
  for (const [reader, value] of [[TaskSpecSchema, task], [GraphPlanSchema, plan], [PlanningEnvelopeSchema, envelope], [RunStateSchema, run]]) {
    for (const version of [0, 1, 4, '3', null, undefined])
      assert.equal(reader.safeParse({ ...value, schemaVersion: version }).success, false);
  }
  assert.equal(RunStateSchema.safeParse({ ...run, continuation: { kind: 'open' } }).success, false);
  assert.equal(TaskSpecSchema.safeParse({ ...task, learningMode: 'after-stage' }).success, false);
});

test('hold is a V3 run state and cannot be a node status, stop, or acceptance', () => {
  assert.deepEqual(RunStateSchema.parse(runV3), runV3);
  assert.equal(RunStateV2Schema.safeParse(runV3).success, false);
  assert.equal(Status.safeParse('learning-hold').success, false);
  const hold = { ...runV3, status: 'learning-hold', continuation: {
    kind: 'learning-hold', holdId: hash, stageId: 'stage-01', boundaryReceiptId: hash,
    resultHash: hash, createdAt: date, materialHash: null,
  } };
  assert.deepEqual(RunStateSchema.parse(hold), hold);
  for (const patch of [{ status: 'cancelled' }, { status: 'passed' }, { stopRequested: true }, { finalDisposition: 'accepted' }, { continuation: { kind: 'open' } }])
    assert.equal(RunStateSchema.safeParse({ ...hold, ...patch }).success, false);
  assert.equal(RunStateSchema.safeParse({ ...runV3, learning: undefined }).success, false);
  assert.equal(PendingBindingSchema.safeParse(null).success, true);
  assert.equal(PendingBindingSchema.safeParse(undefined).success, true);
});

test('registered commands use strict bounded argv and contained paths for any language', () => {
  const profile = { version: 1, requiredCheckIds: [check.id], definitions: [check], environment: [] };
  assert.deepEqual(CheckProfileSchema.parse(profile), profile);
  assert.deepEqual(PlanChecksSchema.parse(checks), checks);
  for (const patch of [{ id: 'check-python-tests' }, { command: { ...check.command, shell: true } },
    { command: { ...check.command, cwd: '../outside' } }, { inputPaths: ['.ai-orchestrator/state.json'] },
    { command: { ...check.command, argv: ['bad\0argument'] } }, { outputPaths: ['/tmp/result'] }])
    assert.equal(RegisteredCheckSchema.safeParse({ ...check, ...patch }).success, false);
  assert.equal(CheckProfileSchema.safeParse({ ...profile, definitions: [check, check] }).success, false);
  assert.equal(CheckProfileSchema.safeParse({ ...profile, requiredCheckIds: ['unregistered'] }).success, false);
  assert.equal(CheckProfileSchema.safeParse({ ...profile, environment: [{ name: 'MODE', value: 'one' }, { name: 'MODE', value: 'two' }] }).success, false);
});

test('learning DTOs retain exact source anchors and reject implementation output fields', () => {
  const anchor = { sourceId: 'source-one', fileHash: hash, startLine: 1, endLine: 1, quote: 'value = 1' };
  const lesson = { version: 1, materialHash: hash, methodHash: hash, title: 'Вход и результат', scope: 'Один этап',
    steps: [{ id: 'step-one', title: 'Присваивание', caller: 'Точка входа', anchors: [anchor], input: '1',
      transformations: ['Сохранение значения'], output: 'value = 1', next: null, purpose: 'Получить результат',
      changeConsequence: 'Без присваивания нет значения', alternatives: [],
      origin: { kind: 'teaching-example', label: 'Учебный пример', receiptId: null, artifactId: null, anchor: null } }],
    questions: [], wholeFlow: 'Вход -> результат', takeaways: ['Есть значение'], limitations: ['Учебный пример'] };
  assert.deepEqual(LessonMaterialSchema.parse(lesson), lesson);
  for (const extra of [{ edits: [] }, { commands: [] }, { permissions: [] }, { html: '<div>raw</div>' }])
    assert.equal(LessonMaterialSchema.safeParse({ ...lesson, ...extra }).success, false);
  assert.equal(LessonMaterialSchema.safeParse({ ...lesson, steps: Array(33).fill(lesson.steps[0]) }).success, false);
  assert.equal(LessonMaterialSchema.safeParse({ ...lesson, takeaways: Array(20).fill('a'.repeat(4000)) }).success, false);
  assert.equal(SourceAnchorSchema.safeParse({ ...anchor, startLine: 2, endLine: 1 }).success, false);
  assert.equal(SourceAnchorSchema.safeParse({ ...anchor, quote: 'я'.repeat(4097) }).success, false);
  const request = { operationId: 'continue-one', expectedRevision: 3, planHash: hash, holdId: hash, disposition: 'defer' };
  assert.deepEqual(ContinueLearningSchema.parse(request), request);
  assert.equal(ContinueLearningSchema.safeParse({ ...request, disposition: 'studied' }).success, false);
  const snapshot = { version: 1, mode: 'after-stage', stages: [{ ...stage, status: 'verified', checkedResultHash: hash,
    freshness: 'stale', materialHash: hash, materialStatus: 'complete', lessonHash: null, lessonStatus: 'absent', progress: 'unread', reason: null }],
    finalMaterialHash: null, activeJob: null };
  for (const key of ['implementationNodeIds', 'scopeCheckNodeId', 'checkNodeIds', 'boundaryNodeId']) delete snapshot.stages[0][key];
  assert.deepEqual(LearningSnapshotSchema.parse(snapshot), snapshot, 'historical verified and stale are independent');
});
