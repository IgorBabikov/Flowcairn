import test from 'node:test';
import assert from 'node:assert/strict';
import { hashObject } from './lib/io.mjs';
import { SKILL_ROUTES } from './lib/config.mjs';
import { TaskSpecSchema, GraphPlanSchema } from './lib/schemas.mjs';
import { compilePlanningPlan, compileTaskProposal } from './lib/planning.mjs';
import { compilePlan, validatePlan } from './lib/validator.mjs';
import { buildExecutionStages, planningStepLimit } from './lib/stage-plan.mjs';
import { singleExecutionStage } from './lib/plan-checks.mjs';
import { buildPrompt } from './lib/codex.mjs';
import { aiResponseSchema } from './lib/runner-ai-command.mjs';

const hash = hashObject('stage-planning-fixture');
const skills = [...new Set(Object.values(SKILL_ROUTES).flat())].map((id) => ({ id, path: `skills/${id}/SKILL.md`, hash }));
const proposal = (steps) => ({ summary: 'План по исходникам', verdict: 'pass', skillsUsed: ['project-context'], findings: [], changedFiles: [], edits: [], plan: [], steps });
const steps = [
  { id: 'format', title: 'Формат экспорта', outcome: 'Формат сохраняет текст', needs: [], paths: ['src/format.mjs'], requirementIds: ['req-001'] },
  { id: 'export', title: 'Экспорт заметок', outcome: 'Заметки экспортируются', needs: [], paths: ['src/export.mjs'], requirementIds: ['req-002'] },
];
function fixture(checkIds = ['tests', 'python-tests'], options = {}) {
  const task = TaskSpecSchema.parse({ schemaVersion: options.schemaVersion ?? 3, sourceHash: hash,
    id: 'TASK-STAGES', goal: 'Добавить экспорт заметок', instructions: 'Экспортировать заметки в текстовый файл с проверкой формата',
    scope: ['src'], contextPaths: ['AGENTS.md'], acceptance: ['Формат сохраняет текст', 'Заметки экспортируются'], checks: checkIds });
  const definitions = checkIds.map((id) => ({ id, title: `Проверить ${id}`, purpose: 'Проверить результат локальным инструментом',
    command: { executable: 'verifier', argv: [id], cwd: '.' }, inputPaths: [], outputPaths: [], timeoutMs: 5000, maxOutputBytes: 65536 }));
  const checks = { version: 1, profileHash: hash, definitions,
    bindings: definitions.map((check) => ({ id: check.id, definitionHash: hashObject(check), executableHash: hash,
      invocationHash: hash, inputManifestHash: hash, toolchainHash: hash })) };
  const context = { runtimeHash: hash, skills, checks, ...options };
  const compile = (input = steps) => compileTaskProposal(task, proposal(input), context);
  return { task, context, compile };
}
const removeNode = (plan, id) => {
  const removed = plan.nodes.find((node) => node.id === id);
  plan.nodes = plan.nodes.filter((node) => node.id !== id);
  for (const node of plan.nodes) node.needs = [...new Set(node.needs.flatMap((dependency) => dependency === id ? removed.needs : [dependency]))];
};

test('V3 compiles each independent semantic step through all checks before the next writer', () => {
  const { task, context, compile } = fixture();
  const compiled = compile(), { plan, ancestors } = compiled;
  const stages = plan.executionStages;
  assert.equal(stages.stages.length, 2);
  assert.deepEqual(stages.stages.map((stage) => stage.implementationNodeIds), [['step-format'], ['step-export']]);
  assert.deepEqual(stages.stages.map((stage) => stage.requirementIds), [['req-001'], ['req-002']]);
  assert.deepEqual(stages.stages[0].checkNodeIds, ['s01-check-tests', 's01-check-python-tests']);
  assert.equal(stages.stages[0].boundaryNodeId, 's01-check-python-tests');
  assert.deepEqual(plan.nodes.find((node) => node.id === 'step-export').needs, ['s01-check-python-tests']);
  assert.deepEqual(stages.finalCheckNodeIds, ['tests', 'check-python-tests']);
  assert.equal(stages.stages[1].boundaryNodeId, 'handoff');
  for (const id of ['workspace-check', 'tests', 'check-python-tests', 'review', 'handoff'])
    assert.equal(plan.nodes.filter((node) => node.id === id).length, 1, `${id} must not be duplicated`);
  assert.equal(ancestors.get('review').has('s01-check-python-tests'), true);
  assert.equal(Object.isFrozen(stages.stages[0]), true);
  assert.deepEqual(buildExecutionStages(plan.nodes, plan.taskContract), stages);
  assert.deepEqual(singleExecutionStage(plan.nodes, plan.taskContract), stages);
  assert.equal(validatePlan(plan, task, context).hash, compiled.hash);
});

test('declared dependencies, read scope, and requirement rebinding survive stage compilation', () => {
  const { compile } = fixture();
  const plan = compile([{ ...steps[0], readPaths: ['src/types.mjs'] }, { ...steps[1], needs: ['format'] }]).plan;
  assert.deepEqual(plan.nodes.find((node) => node.id === 'step-export').needs, ['s01-check-python-tests', 'step-format']);
  assert.deepEqual(plan.nodes.find((node) => node.id === 'step-export').resources.reads,
    ['src/export.mjs', 'src/format.mjs', 'src/types.mjs', 'AGENTS.md']);
  const contract = structuredClone(plan.taskContract);
  contract.requirements[0].workIds.push('step-export');
  assert.deepEqual(buildExecutionStages(plan.nodes, contract).stages[1].requirementIds, ['req-001', 'req-002']);
});

for (const [name, mutate] of [
  ['missing stage', (plan) => plan.executionStages.stages.pop()],
  ['duplicate stage ID', (plan) => { plan.executionStages.stages[1].id = plan.executionStages.stages[0].id; }],
  ['shared implementation', (plan) => { plan.executionStages.stages[1].implementationNodeIds = ['step-format']; }],
  ['swapped scope', (plan) => { plan.executionStages.stages[0].scopeCheckNodeId = 'workspace-check'; }],
  ['foreign stage check', (plan) => { plan.executionStages.stages[0].checkNodeIds[0] = 'tests'; }],
  ['foreign requirement', (plan) => { plan.executionStages.stages[0].requirementIds = ['req-002']; }],
  ['missing final check reference', (plan) => plan.executionStages.finalCheckNodeIds.pop()],
  ['wrong review reference', (plan) => { plan.executionStages.finalReviewNodeId = 'step-export'; }],
  ['scope as verified boundary', (plan) => { plan.executionStages.stages[0].boundaryNodeId = 's01-workspace-check'; }],
]) test(`stage metadata rejects ${name} in current and historical validation`, () => {
  const { compile, task, context } = fixture();
  const plan = structuredClone(compile().plan); mutate(plan);
  for (const mode of ['current', 'historical']) assert.throws(() => validatePlan(plan, task, { ...context, mode }));
});

for (const [name, mutate] of [
  ['removed intermediate scope', (plan) => removeNode(plan, 's01-workspace-check')],
  ['removed intermediate required check', (plan) => removeNode(plan, 's01-check-tests')],
  ['removed final required check', (plan) => removeNode(plan, 'tests')],
  ['removed final review', (plan) => removeNode(plan, 'review')],
  ['unregistered replacement action', (plan) => { plan.nodes.find((node) => node.id === 's01-check-tests').action.id = 'check-foreign'; }],
  ['second writer before boundary', (plan) => { plan.nodes.find((node) => node.id === 'step-export').needs = ['step-format']; }],
  ['scope before implementation', (plan) => { plan.nodes.find((node) => node.id === 's01-workspace-check').needs = ['approve-plan']; }],
  ['check before scope', (plan) => { plan.nodes.find((node) => node.id === 's01-check-tests').needs = ['step-format']; }],
  ['boundary bypasses a check', (plan) => { plan.nodes.find((node) => node.id === 's01-check-python-tests').needs = ['s01-workspace-check']; }],
  ['review before final checks', (plan) => { plan.nodes.find((node) => node.id === 'review').needs = ['step-export']; }],
  ['handoff before review', (plan) => { plan.nodes.find((node) => node.id === 'handoff').needs = ['check-python-tests']; }],
  ['writer order reversed', (plan) => { const first = plan.nodes.findIndex((node) => node.id === 'step-format'); const second = plan.nodes.findIndex((node) => node.id === 'step-export'); [plan.nodes[first], plan.nodes[second]] = [plan.nodes[second], plan.nodes[first]]; }],
]) test(`host rejects ${name} even when metadata is regenerated`, () => {
  const { compile, task, context } = fixture();
  const plan = structuredClone(compile().plan); mutate(plan);
  assert.throws(() => {
    plan.executionStages = buildExecutionStages(plan.nodes, plan.taskContract);
    validatePlan(plan, task, context);
  });
});

test('duplicate nodes, uncovered writers, and widened permissions cannot enter stage execution', () => {
  const { compile, task, context } = fixture();
  for (const mutate of [
    (plan) => plan.nodes.push(structuredClone(plan.nodes.find((node) => node.id === 'step-format'))),
    (plan) => plan.nodes.push({ ...structuredClone(plan.nodes.find((node) => node.id === 'step-format')), id: 'extra-writer' }),
    (plan) => plan.nodes.find((node) => node.id === 's01-check-tests').permissions.push('workspace.source.write'),
  ]) {
    const plan = structuredClone(compile().plan); mutate(plan);
    assert.throws(() => validatePlan(plan, task, context));
  }
});

test('registered check names cannot collide with internal stage nodes', () => {
  const ids = ['workspace-check', 'review', 'implement', 'approve-plan', 's01-tests', 'x'.repeat(40)];
  const { compile } = fixture(ids);
  const plan = compile().plan;
  assert.equal(new Set(plan.nodes.map((node) => node.id)).size, plan.nodes.length);
  assert.deepEqual(plan.executionStages.stages[0].checkNodeIds, ids.map((id) => `s01-check-${id}`));
  assert.equal(plan.nodes.every((node) => node.id.length <= 80), true);
});

test('plans continue beyond former 12-step/64-node ceilings without dropping mandatory checks', () => {
  const checkIds = ['tests', 'lint', 'typecheck'];
  const pieces = Array.from({ length: 30 }, (_, index) => ({ ...steps[index % 2], id: `piece-${index + 1}`, needs: [] }));
  for (const extra of [{}, { provider: 'claude' }, { provider: 'claude', workflow: 'autonomous' }]) {
    const current = fixture(checkIds, extra);
    assert.equal(planningStepLimit(current.task, current.context), null);
    const plan = current.compile(pieces).plan;
    assert.equal(plan.executionStages.stages.length, 30);
    assert.ok(plan.nodes.length > 64);
    for (const stage of plan.executionStages.stages) assert.equal(stage.checkNodeIds.length, checkIds.length);
    assert.equal(validatePlan(plan, current.task, current.context).hash, hashObject(plan));
  }
});

test('provider schema and prompt receive the calculated stage limit before a provider call', () => {
  const { task, context } = fixture(['tests', 'lint', 'typecheck'], { provider: 'cursor' });
  const plan = compilePlanningPlan(task, context).plan;
  const planner = plan.nodes.find((node) => node.action.id === 'ai-plan');
  assert.equal(aiResponseSchema(planner, plan, task).properties.steps.maxItems, undefined);
  const prompt = buildPrompt({ task, plan, nodeId: planner.id, skills: [], priorEvidence: {} });
  assert.match(prompt, /необходимые task-specific/);
  assert.match(prompt, /все обязательные проверки до следующего шага/);
  assert.equal(plan.executionStages, null);
});

test('a zero-verifier single stage remains readable, but never grows a verified intermediate boundary', () => {
  const { task, context, compile } = fixture([]);
  const plan = compile([{ ...steps[0], requirementIds: ['req-001', 'req-002'] }]).plan;
  assert.deepEqual(plan.executionStages.stages[0].checkNodeIds, []);
  assert.deepEqual(GraphPlanSchema.parse(plan), plan);
  assert.equal(validatePlan(plan, task, { ...context, mode: 'historical' }).hash, hashObject(plan));
  assert.equal(planningStepLimit(task, context), 1);
  assert.throws(() => compile(), { code: 'STAGE_VERIFIER_REQUIRED' });
});

test('V2 current and historical plans preserve the previous graph and planner limits', () => {
  const { task, context, compile } = fixture(['tests'], { schemaVersion: 2 });
  const { plan, hash: planHash } = compile();
  assert.deepEqual(plan.nodes.map((node) => node.id), ['approve-plan', 'step-format', 'step-export', 'workspace-check', 'tests', 'review', 'handoff', 'accept-result']);
  assert.deepEqual(plan.nodes.find((node) => node.id === 'step-export').needs, ['step-format']);
  assert.equal('executionStages' in plan, false);
  assert.equal(planningStepLimit(task, context), null);
  assert.equal(validatePlan(plan, task, context).hash, planHash);
  assert.equal(validatePlan(plan, task, { ...context, mode: 'historical', runtimeHash: 'b'.repeat(64) }).hash, planHash);
  const baseline = compilePlan(task, context).plan;
  assert.equal('executionStages' in baseline, false);
});
