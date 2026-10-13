import test from 'node:test';
import assert from 'node:assert/strict';
import { hashObject } from '../scripts/ai-graph/lib/io.mjs';
import { SKILL_ROUTES } from '../scripts/ai-graph/lib/config.mjs';
import { GraphPlanSchema, AIPlanningResultSchema, TaskSpecSchema } from '../scripts/ai-graph/lib/schemas.mjs';
import { compileTaskProposal } from '../scripts/ai-graph/lib/planning.mjs';
import { validatePlan } from '../scripts/ai-graph/lib/validator.mjs';
import { buildTaskContract } from '../scripts/ai-graph/lib/task-contract.mjs';
import { buildExecutionStages } from '../scripts/ai-graph/lib/stage-plan.mjs';
import { validatePlanConsistency } from '../scripts/ai-graph/lib/plan-consistency.mjs';
import { aiResponseSchema } from '../scripts/ai-graph/lib/runner-ai-command.mjs';
import { buildPrompt } from '../scripts/ai-graph/lib/codex.mjs';

const hash = hashObject('plan-consistency-fixture');
const interfaceContract = 'ExportV1 = { title: string, text: string }; text сохраняется без потерь.';
const steps = [
  { id: 'format', title: 'Формат', outcome: 'Формат сохраняет текст', needs: [], paths: ['src/format.mjs'],
    requirementIds: ['req-001'], produces: [{ id: 'export-v1', contract: interfaceContract }] },
  { id: 'export', title: 'Экспорт', outcome: 'Экспорт возвращает файл', needs: ['format'], paths: ['src/export.mjs'],
    requirementIds: ['req-002'], consumes: [{ id: 'export-v1', producerId: 'format', contract: interfaceContract }] },
];

function fixture(schemaVersion = 3) {
  const task = TaskSpecSchema.parse({ schemaVersion, sourceHash: hash,
    id: 'TASK-CONSISTENCY', goal: 'Добавить экспорт', instructions: 'Сохранить текст и поддержать экспорт.',
    scope: ['src'], contextPaths: [], acceptance: ['Формат сохраняет текст', 'Экспорт возвращает файл'], checks: ['tests'] });
  const definition = { id: 'tests', title: 'Тесты', purpose: 'Проверить экспорт',
    command: { executable: 'verifier', argv: [], cwd: '.' }, inputPaths: [], outputPaths: [], timeoutMs: 5000, maxOutputBytes: 65536 };
  const checks = { version: 1, profileHash: hash, definitions: [definition],
    bindings: [{ id: 'tests', definitionHash: hashObject(definition), executableHash: hash,
      invocationHash: hash, inputManifestHash: hash, toolchainHash: hash }] };
  const skills = [...new Set(Object.values(SKILL_ROUTES).flat())]
    .map((id) => ({ id, path: `skills/${id}/SKILL.md`, hash }));
  const context = { runtimeHash: hash, skills, ...(schemaVersion === 3 ? { checks } : {}) };
  const proposal = (work) => ({ summary: 'План экспорта', verdict: 'pass', skillsUsed: [], findings: [],
    changedFiles: [], edits: [], plan: [], steps: work });
  return { task, context, proposal, compile: (work = steps) => compileTaskProposal(task, proposal(work), context) };
}

test('compiler preserves exact interfaces in immutable nodes and transforms producer step IDs', () => {
  const { compile } = fixture();
  const original = structuredClone(steps);
  const { plan } = compile();
  const producer = plan.nodes.find((node) => node.id === 'step-format');
  const consumer = plan.nodes.find((node) => node.id === 'step-export');
  assert.deepEqual(producer.produces, original[0].produces);
  assert.deepEqual(consumer.consumes, [{ id: 'export-v1', producerId: 'step-format', contract: interfaceContract }]);
  assert.equal(Object.isFrozen(consumer.consumes[0]), true);
  const prompt = buildPrompt({ nodeId: consumer.id, task: fixture().task, plan, skills: '', priorEvidence: {} });
  assert.ok(prompt.includes(JSON.stringify(consumer.consumes)), 'the implementation prompt receives exact interface metadata');
  assert.deepEqual(steps, original, 'compilation must not mutate the proposal');
  assert.deepEqual(plan.executionStages.stages.map((stage) => stage.requirementIds), [['req-001'], ['req-002']]);
});

test('an unlinked technical bridge is allowed as an ancestor of requirement-linked work', () => {
  const { compile } = fixture();
  const work = [steps[0], { id: 'bridge', title: 'Связать транспорт', outcome: 'Транспорт сохраняет формат',
    needs: ['format'], paths: ['src/transport.mjs'], requirementIds: [] },
  { ...steps[1], needs: ['bridge'] }];
  const { plan } = compile(work);
  assert.equal(plan.nodes.filter((node) => node.action.id === 'ai-implement').length, 3);
  assert.equal(plan.nodes.find((node) => node.id === 'step-export').consumes[0].producerId, 'step-format');
  assert.deepEqual(plan.executionStages.stages[1].requirementIds, []);
});

test('an unrelated explicitly unlinked work is blocked while legacy path inference stays supported', () => {
  const { compile } = fixture();
  const unrelated = { id: 'unrelated', title: 'Несвязанная работа', outcome: 'Посторонняя правка',
    needs: [], paths: ['src/unrelated.mjs'], requirementIds: [] };
  assert.throws(() => compile([...steps, unrelated]), { code: 'PLAN_WORK_ORPHAN' });
  const { requirementIds: _, ...legacyWork } = unrelated;
  const legacyPlan = compile([...steps, legacyWork]).plan;
  assert.ok(legacyPlan.taskContract.requirements.every((requirement) => requirement.workIds.includes('step-unrelated')));
});

test('a serial compiler fence cannot substitute for the declared interface dependency', () => {
  const { compile } = fixture();
  assert.throws(() => compile([steps[0], { ...steps[1], needs: [] }]), { code: 'PLAN_INTERFACE_DEPENDENCY' });
  assert.throws(() => compile([{ ...steps[0], consumes: [{ id: 'export-v1', producerId: 'format', contract: interfaceContract }] },
    steps[1]]), { code: 'PLAN_INTERFACE_DEPENDENCY' });
});

for (const [name, consume] of [
  ['unknown producer', { id: 'export-v1', producerId: 'missing', contract: interfaceContract }],
  ['wrong producer', { id: 'export-v1', producerId: 'export', contract: interfaceContract }],
  ['unknown interface', { id: 'missing-v1', producerId: 'format', contract: interfaceContract }],
]) test(`compiler rejects ${name} before creating an execution plan`, () => {
  const { compile } = fixture();
  assert.throws(() => compile([steps[0], { ...steps[1], consumes: [consume] }]), { code: 'PLAN_INTERFACE_PRODUCER' });
});

test('a different consumer schema or invariant blocks dependent work', () => {
  const { compile } = fixture();
  assert.throws(() => compile([steps[0], { ...steps[1], consumes: [{ ...steps[1].consumes[0],
    contract: 'ExportV1 = { text: number }; заголовок отсутствует.' }] }]), { code: 'PLAN_INTERFACE_MISMATCH' });
});

test('ambiguous producer ownership and conflicting contracts are rejected', () => {
  const { compile } = fixture();
  assert.throws(() => compile([{ ...steps[0], produces: [...steps[0].produces, ...steps[0].produces] }, steps[1]]),
    { code: 'PLAN_INTERFACE_AMBIGUOUS' });
  assert.throws(() => compile([steps[0], { ...steps[1], produces: steps[0].produces }]),
    { code: 'PLAN_INTERFACE_AMBIGUOUS' });
  assert.throws(() => compile([steps[0], { ...steps[1], produces: [{ id: 'export-v1', contract: 'Несовместимый contract.' }] }]),
    { code: 'PLAN_INTERFACE_CONFLICT' });
  assert.throws(() => compile([steps[0], { ...steps[1], consumes: [...steps[1].consumes, ...steps[1].consumes] }]),
    { code: 'PLAN_INTERFACE_AMBIGUOUS' });
});

test('every new explicit mandatory requirement needs a work even without interface metadata', () => {
  for (const version of [2, 3]) {
    const { compile } = fixture(version);
    const { produces: _, ...onlyFormat } = steps[0];
    assert.throws(() => compile([onlyFormat]), { code: 'PLAN_REQUIREMENT_COVERAGE' });
  }
});

for (const [name, patch] of [
  ['unknown nested fields', { produces: [{ id: 'export-v1', contract: interfaceContract, permissions: ['workspace.source.write'] }] }],
  ['missing contract', { produces: [{ id: 'export-v1' }] }],
  ['missing producer ID', { consumes: [{ id: 'export-v1', contract: interfaceContract }] }],
  ['blank contract', { produces: [{ id: 'export-v1', contract: '  ' }] }],
  ['invalid interface ID', { produces: [{ id: 'Export.V1', contract: interfaceContract }] }],
  ['null metadata', { produces: null }],
]) test(`malformed interfaces are not ignored: ${name}`, () => {
  const { compile } = fixture();
  assert.throws(() => compile([{ ...steps[0], ...patch }, steps[1]]), { code: 'PLANNING_SCHEMA' });
});

test('the standalone gate rejects unknown requirement/work references and malformed data', () => {
  const { task } = fixture();
  const contract = buildTaskContract(task, { steps });
  const missing = structuredClone(contract); missing.requirements[0].workIds = ['step-missing'];
  assert.throws(() => validatePlanConsistency({ taskContract: missing, steps }), { code: 'PLAN_WORK_UNKNOWN' });
  assert.throws(() => validatePlanConsistency({ taskContract: contract,
    steps: [{ ...steps[0], requirementIds: ['req-unknown'] }, steps[1]] }), { code: 'PLAN_REQUIREMENT_UNKNOWN' });
  assert.throws(() => validatePlanConsistency({ taskContract: contract,
    steps: [{ ...steps[0], produces: [{ id: 'export-v1', contract: interfaceContract, ignored: true }] }, steps[1]] }),
    { code: 'PLAN_CONSISTENCY_SCHEMA' });
});

test('structural validity keeps human acceptance and material unknowns pending', () => {
  const { task } = fixture();
  const contract = buildTaskContract(task, { steps });
  contract.unknowns = ['Пользователь еще не выбрал формат имени файла.'];
  const assessment = validatePlanConsistency({ taskContract: contract, steps });
  assert.deepEqual(assessment, { status: 'structurally-valid', semanticStatus: 'unassessed', verificationStatus: 'pending',
    humanRequirementIds: ['req-001', 'req-002'], unknowns: contract.unknowns });
  assert.equal('verdict' in assessment, false);
  const noVerifier = structuredClone(contract);
  noVerifier.requirements[0].verification.method = 'check';
  assert.throws(() => validatePlanConsistency({ taskContract: noVerifier, steps }), { code: 'PLAN_VERIFIER_MISSING' });
});

test('historical plans keep their hashes and remain readable without interface or stricter coverage metadata', () => {
  for (const version of [2, 3]) {
    const { compile, task, context, proposal } = fixture(version);
    const legacySteps = steps.map(({ produces: _, consumes: __, ...step }) => step);
    const legacyOutput = AIPlanningResultSchema.parse(proposal(legacySteps));
    assert.equal(Object.hasOwn(legacyOutput.steps[0], 'produces'), false);
    assert.equal(Object.hasOwn(legacyOutput.steps[1], 'consumes'), false);
    const plan = structuredClone(compile(legacySteps).plan);
    assert.equal(plan.nodes.some((node) => Object.hasOwn(node, 'produces') || Object.hasOwn(node, 'consumes')), false);
    plan.taskContract.requirements[1].workIds = [];
    if (version === 3) plan.executionStages = buildExecutionStages(plan.nodes, plan.taskContract);
    const originalHash = hashObject(plan);
    assert.equal(hashObject(GraphPlanSchema.parse(plan)), originalHash);
    assert.equal(validatePlan(plan, task, { ...context, mode: 'historical' }).hash, originalHash);
  }
});

test('current provider schemas require strict interface arrays while old stored responses can omit them', () => {
  const schema = aiResponseSchema({ action: { id: 'ai-plan' }, skills: [], resources: { writes: [] } },
    { workflow: 'autonomous', schemaVersion: 3 }, fixture().task);
  const step = schema.properties.steps.items;
  for (const field of ['produces', 'consumes']) {
    assert.ok(step.required.includes(field));
    assert.equal(step.properties[field].type, 'array');
    const item = step.properties[field].items;
    assert.equal(item.additionalProperties, false);
    assert.deepEqual([...item.required].sort(), Object.keys(item.properties).sort());
  }
});
