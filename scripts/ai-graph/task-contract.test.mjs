import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskSpecSchema } from './lib/schemas.mjs';
import { hashObject } from './lib/io.mjs';
import { buildTaskContract, selectTaskRigor, validateTaskContract } from './lib/task-contract.mjs';
import { boundPriorEvidence, taskContractForNode } from './lib/bounded-context.mjs';
import { buildPrompt } from './lib/codex.mjs';

const task = TaskSpecSchema.parse({ schemaVersion: 2, sourceHash: hashObject('source'), id: 'TASK-PROOF',
  goal: 'Экспортировать заметки', instructions: 'Добавить экспорт заметок с заголовками', scope: ['src', 'tests'],
  acceptance: ['Экспорт содержит заголовки всех заметок'], checks: ['tests'] });
const step = { id: 'export', paths: ['src/export.mjs'], requirementIds: ['req-001'] };
const proposal = { requirements: [{ id: 'req-001', title: task.acceptance[0], mandatory: true,
  verification: { method: 'check', checkIds: ['check-tests'], criterion: task.acceptance[0], paths: ['src/export.mjs', 'tests/export.test.mjs'] } }],
optionalImprovements: [], constraints: [], assumptions: [], unknowns: [] };
const compile = (options = {}) => buildTaskContract(task, options);

test('contract preserves every original obligation with human fallback until a verifier is selected', () => {
  const contract = compile({ analysis: { requirements: ['Экспорт работает без сети'], constraints: ['Текстовый формат'], risks: ['Формат переносов не согласован'] } });
  assert.equal(contract.goal, task.goal);
  assert.equal(contract.instructionsHash, hashObject(task.instructions));
  assert.equal(contract.requirements.length, 2);
  assert.equal(contract.requirements[0].id, 'req-001');
  assert.equal(contract.requirements[0].mandatory, true);
  assert.equal(contract.requirements[0].verification.method, 'human');
  assert.deepEqual(contract.unknowns, ['Формат переносов не согласован']);
  assert.equal(contract.requirements[1].id, compile({ analysis: { requirements: ['Экспорт работает без сети'] } }).requirements[1].id);
});

test('contract chooses only configured checks and links exact work nodes', () => {
  const contract = compile({ proposal, steps: [step] });
  assert.deepEqual(contract.requirements[0].workIds, ['step-export']);
  assert.deepEqual(compile({ steps: [{ ...step, id: 'step-export' }] }).requirements[0].workIds, ['step-step-export']);
  assert.deepEqual(compile({ steps: [{ ...step, id: 'implement', nodeId: 'implement' }] }).requirements[0].workIds, ['implement']);
  assert.deepEqual(contract.requirements[0].verification.checkIds, ['check-tests']);
  assert.deepEqual(validateTaskContract(contract, task, [
    { id: 'step-export', action: { id: 'ai-implement' } }, { id: 'tests', action: { id: 'check-tests' } },
  ]), contract);
  const unavailable = structuredClone(proposal);
  unavailable.requirements[0].verification.checkIds = ['check-browser'];
  assert.throws(() => compile({ proposal: unavailable }), { code: 'CONTRACT_CHECK_UNAVAILABLE' });
  const outside = structuredClone(proposal);
  outside.requirements[0].verification.paths = ['private/secret.mjs'];
  assert.throws(() => compile({ proposal: outside }), { code: 'CONTRACT_VERIFICATION_SCOPE' });
});

test('a final proposal owns enduring constraints instead of inheriting analysis-stage restrictions', () => {
  const analysis = { requirements: task.acceptance, constraints: ['Current analysis is read-only; edits=[]'] };
  const contract = compile({ analysis, proposal: { ...proposal, constraints: ['Preserve the public data format'] }, steps: [step] });
  assert.deepEqual(contract.constraints, ['Preserve the public data format']);
  assert.deepEqual(compile({ analysis, proposal }).constraints, []);
  assert.deepEqual(compile({ analysis }).constraints, analysis.constraints);
  assert.equal(contract.instructionsHash, hashObject(task.instructions));
  assert.equal(contract.goal, task.goal);
  assert.deepEqual(contract.scope, task.scope);
  assert.deepEqual(contract.forbiddenPaths, task.forbiddenPaths);
  assert.equal(contract.requirements[0].title, task.acceptance[0]);
  assert.equal(contract.requirements[0].mandatory, true);
});

test('known anchored analysis references reuse original requirements, including grouped IDs', () => {
  const input = { ...task, acceptance: ['First result', 'Second result', 'Third result'] };
  const original = buildTaskContract(input);
  const contract = buildTaskContract(input, { analysis: { requirements: [
    'req-001/002: Shared explanation for the first two results',
    'req-003: Explanation for the third result',
    'req-001 / req-002: Another explanation',
    'A separate required result',
  ] } });
  assert.deepEqual(contract.requirements.slice(0, 3), original.requirements);
  assert.equal(contract.requirements.length, 4);
  assert.equal(contract.requirements[3].title, 'A separate required result');
  assert.equal(contract.requirements[3].mandatory, true);
});

test('natural task description keeps each analyzed criterion separately linked and checked', () => {
  const description = 'Изменить форму регистрации: отклонять неверный email и сохранять валидный email.';
  const input = { ...task, intakeKind: 'natural', instructions: description, acceptance: [description] };
  const details = ['Отклонять неверный email', 'Сохранять валидный email'];
  const criteria = [{ id: 'req-001', title: description },
    ...details.map((title, index) => ({ id: `req-00${index + 2}`, title }))];
  const proposed = { ...proposal, requirements: criteria.map(({ id, title }) => ({ id, title, mandatory: true,
    verification: { method: 'check', checkIds: ['check-tests'], criterion: title, paths: ['src/form.mjs'] } })) };
  const steps = details.map((title, index) => ({ id: `fix-${index + 1}`, paths: ['src/form.mjs'],
    requirementIds: ['req-001', `req-00${index + 2}`] }));
  const contract = buildTaskContract(input, { proposal: proposed, analysis: {
    requirements: details.map((title) => `req-001: ${title}`),
  }, steps });
  assert.deepEqual(contract.requirements.map((item) => item.title), details);
  assert.equal(contract.acceptanceHash, hashObject(input.acceptance));
  assert.ok(contract.requirements.every((item) => item.mandatory && item.workIds.length > 0));
  assert.deepEqual(buildTaskContract(input, { previousContract: contract }).requirements, contract.requirements);
  assert.throws(() => buildTaskContract(input, { proposal: { ...proposed, requirements: proposed.requirements.slice(0, 2) },
    analysis: { requirements: details.map((title) => `req-001: ${title}`) }, steps }),
  { code: 'CONTRACT_ANALYSIS_COVERAGE' });
});

test('structured task keeps its one explicit criterion even when instructions use the same wording', () => {
  const input = { ...task, instructions: task.acceptance[0] };
  const contract = buildTaskContract(input);
  assert.equal(contract.requirements.length, 1);
  assert.equal(contract.requirements[0].origin, 'acceptance');
  assert.equal(contract.acceptanceHash, undefined);
});

test('unknown or unanchored analysis references never silently lose requirements', () => {
  const titles = ['req-999: Unknown requirement', 'req-001/999: Partly unknown reference', 'Additional behavior related to req-001: retain this requirement'];
  const contract = compile({ analysis: { requirements: titles } });
  assert.equal(contract.requirements.length, 1 + titles.length);
  assert.deepEqual(contract.requirements.slice(1).map((item) => item.title), titles);
  assert.ok(contract.requirements.every((item) => item.mandatory));
});

test('a configured future check can verify a planned test before any check receipt exists', () => {
  const planned = structuredClone(proposal);
  planned.requirements[0].verification.paths = ['tests/new-scenario.test.mjs'];
  const contract = compile({ proposal: planned, steps: [{ ...step, paths: ['tests/new-scenario.test.mjs'] }] });
  assert.equal(contract.requirements[0].verification.method, 'check');
  assert.deepEqual(contract.requirements[0].verification.checkIds, ['check-tests']);
  assert.deepEqual(contract.requirements[0].workIds, ['step-export']);
  assert.equal(Object.hasOwn(contract.requirements[0], 'proven'), false);
});

test('planner cannot weaken initial acceptance or relabel analysis as optional', () => {
  for (const mutation of [
    (value) => { value.requirements[0].mandatory = false; },
    (value) => { value.requirements[0].title = 'Создан файл'; },
    (value) => { value.requirements[0].verification.criterion = 'Тесты прошли'; },
  ]) {
    const invalid = structuredClone(proposal); mutation(invalid);
    assert.throws(() => compile({ proposal: invalid }), { code: 'CONTRACT_ACCEPTANCE_WEAKENED' });
  }
  const optional = structuredClone(proposal);
  optional.requirements.push({ id: 'offline-export', title: 'Экспорт без сети', mandatory: false,
    verification: { method: 'human', checkIds: [], criterion: 'Экспорт без сети', paths: ['src'] } });
  assert.throws(() => compile({ proposal: optional, analysis: { requirements: ['Экспорт без сети'] } }), { code: 'CONTRACT_ACCEPTANCE_WEAKENED' });
});

test('repair preserves IDs and verification, refusing goal or acceptance drift', () => {
  const previousContract = compile({ proposal, steps: [step] });
  const repaired = compile({ previousContract, steps: [{ ...step, id: 'repair-export' }] });
  assert.deepEqual(repaired.requirements[0].verification, previousContract.requirements[0].verification);
  assert.deepEqual(repaired.requirements[0].workIds, ['step-repair-export']);
  assert.throws(() => buildTaskContract({ ...task, goal: 'Другой результат' }, { previousContract }), { code: 'CONTRACT_DRIFT' });
  assert.throws(() => buildTaskContract({ ...task, acceptance: ['Только создать файл'] }, { previousContract }), { code: 'CONTRACT_DRIFT' });
  assert.throws(() => compile({ steps: [{ ...step, requirementIds: ['nonexistent'] }] }), { code: 'CONTRACT_REQUIREMENT_UNKNOWN' });
});

test('rigor reflects complexity and risk without removing verification or granting permissions', () => {
  assert.equal(selectTaskRigor(task).level, 'standard');
  assert.equal(selectTaskRigor({ ...task, goal: 'Исправить опечатку', instructions: 'Исправить опечатку в заголовке', scope: ['README.md'] }).level, 'light');
  assert.equal(selectTaskRigor({ ...task, instructions: 'Изменить авторизацию пользователей' }).level, 'high');
  assert.equal(selectTaskRigor(task, { requirements: task.acceptance, risks: ['a', 'b', 'c', 'd'] }).level, 'high');
});

test('bounded context excludes unrelated graph outputs and retains planner analysis', () => {
  const contract = compile({ proposal, steps: [step] });
  const node = { id: 'step-export', action: { id: 'ai-implement' }, needs: ['analyze'], resources: { reads: ['src', 'tests'], writes: ['src/export.mjs'] } };
  const plan = { nodes: [{ id: 'analyze', needs: [], action: { id: 'ai-analyze' } }, { id: 'unrelated', needs: [], action: { id: 'ai-implement' } }, node], taskContract: contract };
  const state = { nodes: { analyze: { artifacts: ['analysis-hash'], receipts: ['analysis-receipt'] }, unrelated: { artifacts: ['unrelated-hash'], receipts: ['unrelated-receipt'] } }, planningArtifacts: [] };
  const priorEvidence = { analysis: { artifactId: 'analysis-hash', result: { analysis: { requirements: task.acceptance, projectFacts: [{ path: 'src/export.mjs', fact: 'Export target' }, { path: 'src/unrelated.mjs', fact: 'unrelated' }] } } },
    receipts: ['analysis-receipt', 'unrelated-receipt'], workspaceFiles: [{ path: 'src/export.mjs' }, { path: 'src/unrelated.mjs' }],
    artifacts: [{ id: 'analysis-hash', excerpt: 'analysis' }, { id: 'unrelated-hash', excerpt: 'secret unnecessary history' }], reviewFindings: [{ path: 'src/unrelated.mjs', message: 'unrelated' }] };
  const bounded = boundPriorEvidence({ task, plan, node, state, priorEvidence });
  assert.equal(bounded.analysis, undefined);
  assert.deepEqual(bounded.receipts, ['analysis-receipt']);
  assert.deepEqual(bounded.workspaceFiles, [{ path: 'src/export.mjs' }]);
  assert.equal(bounded.artifacts.length, 1);
  assert.equal(bounded.projectFacts.length, 1);
  assert.deepEqual(bounded.contextSelection.requirementIds, ['req-001']);
  const planner = { ...node, id: 'plan-task', action: { id: 'ai-plan' } };
  assert.deepEqual(boundPriorEvidence({ task, plan, node: planner, state, priorEvidence }).analysis, priorEvidence.analysis);
  assert.equal(taskContractForNode(task, plan, node).requirements.length, 1);
});

test('planner prompt supplies stable requirement IDs and review requires specific cited assessments', () => {
  const taskContract = compile({ proposal, steps: [step] });
  const planner = { id: 'plan-task', action: { id: 'ai-plan' }, resources: { reads: ['src'], writes: [] } };
  const review = { ...planner, id: 'review', action: { id: 'ai-review' } };
  const plan = { taskContract, nodes: [planner, review] };
  assert.match(buildPrompt({ nodeId: planner.id, task, plan, skills: '', priorEvidence: null }), /contractProposal/);
  const prompt = buildPrompt({ nodeId: review.id, task, plan, skills: '', priorEvidence: null });
  assert.match(prompt, /requirementAssessments/);
  assert.match(prompt, /check-tests/);
  assert.match(prompt, /startLine/);
});
