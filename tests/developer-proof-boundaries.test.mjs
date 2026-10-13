import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture, request } from '../scripts/ai-graph/test-support/provable-work.mjs';
import { GraphPlanSchema, TaskSpecSchema } from '../scripts/ai-graph/lib/schemas.mjs';
import { validatePlan } from '../scripts/ai-graph/lib/validator.mjs';
import { compileTaskProposal } from '../scripts/ai-graph/lib/planning.mjs';
import { hashObject } from '../scripts/ai-graph/lib/io.mjs';
import { parseNodeVerificationReport } from '../scripts/ai-graph/lib/node-verification-report.mjs';

test('contradictory file success and fractional case identity cannot certify a genuine Node report', async (t) => {
  const f = await fixture(t);
  await f.run();
  const report = JSON.parse(readFileSync(`${f.worktree}/reports/tests.json`, 'utf8'));
  assert.equal(parseNodeVerificationReport(report, { requiredScenarios: ['observable behavior'] }).status, 'passed');
  const contradictory = structuredClone(report);
  contradictory.fileSummaries[0].success = false;
  const rejected = parseNodeVerificationReport(contradictory, { requiredScenarios: ['observable behavior'] });
  assert.notEqual(rejected.status, 'passed');
  assert.equal(rejected.countsConfirmed, false);
  const fractional = structuredClone(report);
  fractional.cases[0].testNumber = 1.5;
  assert.equal(parseNodeVerificationReport(fractional).status, 'unverified');
  const forgedId = structuredClone(report); forgedId.cases[0].id = 'a'.repeat(64);
  assert.equal(parseNodeVerificationReport(forgedId).status, 'unverified');
});

test('developer direct draft is rejected before approval when declared work metadata is absent', async (t) => {
  const f = await fixture(t), adapters = f.service.adapters;
  adapters.workflowPolicy = 'developer-v1';
  let executions = 0, writes = 0;
  const execute = adapters.execute, apply = adapters.applyEdits;
  adapters.execute = async (input) => { executions++; return execute(input); };
  adapters.applyEdits = (...args) => { writes++; return apply(...args); };
  const input = { id: 'DIRECT-DRAFT-BOUNDARY', goal: 'Функция answer возвращает 42', instructions: 'Функция answer возвращает 42',
    acceptance: ['Функция answer возвращает 42'], scope: ['src/answer.mjs'], contextPaths: ['src/answer.test.mjs'], checks: ['tests'] };
  const task = TaskSpecSchema.parse({ ...input, schemaVersion: 2, sourceHash: f.fingerprint().hash });
  const context = { runtimeHash: adapters.identity(), skills: adapters.skills(task), checks: adapters.checkRegistry(),
    workflow: 'autonomous', workflowPolicy: 'developer-v1' };
  const compiled = compileTaskProposal(task, { summary: 'Boundary fixture', verdict: 'pass', findings: [], skillsUsed: [],
    changedFiles: [], edits: [], plan: [], steps: [{ id: 'answer', title: input.goal, outcome: input.goal,
      needs: [], paths: ['src/answer.mjs'], requirementIds: ['req-001'] }] }, context).plan;
  const nodes = structuredClone(compiled.nodes);
  delete nodes.find((node) => node.action.id === 'ai-implement').declaredNeeds;
  await assert.rejects(f.service.create(input, { runId: 'direct-draft-boundary', stage: 'execution', workflow: 'autonomous',
    draft: { nodes }, taskContract: compiled.taskContract }), { code: 'PLAN_WORK_DEPENDENCY' });
  assert.equal(executions, 0); assert.equal(writes, 0);
  assert.equal(f.service.store.listRunIds().includes('direct-draft-boundary'), false);
});

test('new developer check criteria cannot promote a registered zero-test command without a scenario report', async (t) => {
  const f = await fixture(t), a = f.service.adapters;
  a.workflowPolicy = 'developer-v1';
  const registry = a.checkRegistry(), definition = structuredClone(registry.definitions[0]);
  delete definition.report;
  definition.command = { executable: process.execPath, argv: ['-e', 'process.exit(0)'], cwd: '.' };
  a.checkRegistry = () => ({ ...registry, definitions: [definition],
    bindings: registry.bindings.map((binding) => ({ ...binding, definitionHash: hashObject(definition) })) });
  let implementationCalls = 0, checkCalls = 0;
  const execute = a.execute;
  a.execute = async (options) => {
    if (options.node.action.id === 'ai-implement') implementationCalls++;
    if (options.node.action.id.startsWith('check-')) checkCalls++;
    return execute(options);
  };
  let snapshot = await f.service.create({ id: 'NO-REPORT-BOUNDARY', goal: 'Функция answer возвращает 42',
    instructions: 'Функция answer возвращает 42', acceptance: ['Функция answer возвращает 42'], scope: ['src'], checks: ['tests'] },
  { runId: 'no-report-boundary', stage: 'planning', workflow: 'autonomous' });
  snapshot = await f.service.command(snapshot.runId, 'run', request(snapshot));
  snapshot = await f.settle(snapshot);
  assert.equal(snapshot.phase, 'planning');
  assert.equal(snapshot.status, 'failed');
  assert.ok(snapshot.nodes.some((node) => node.reason?.startsWith('PLAN_VERIFIER_MISSING:')));
  assert.equal(implementationCalls, 0); assert.equal(checkCalls, 0);
  for (const runId of f.service.store.listRunIds()) assert.notEqual(f.service.snapshot(runId).proof.status, 'PROVEN');
});

test('legacy unmarked proposals retain their previously explicit verification contract', async (t) => {
  const f = await fixture(t), registry = f.service.adapters.checkRegistry();
  const definition = structuredClone(registry.definitions[0]); delete definition.report;
  f.service.adapters.checkRegistry = () => ({ ...registry, definitions: [definition],
    bindings: registry.bindings.map((binding) => ({ ...binding, definitionHash: hashObject(definition) })) });
  const input = { id: 'LEGACY-BOUNDARY', goal: 'Функция answer возвращает 42', instructions: 'Функция answer возвращает 42',
    acceptance: ['Функция answer возвращает 42'], scope: ['src'], checks: ['tests'] };
  const snapshot = await f.service.create(input, { runId: 'legacy-boundary' });
  const plan = f.service.store.readObject('plans', snapshot.planHash);
  assert.equal(Object.hasOwn(plan, 'workflowPolicy'), false);
  assert.equal(snapshot.gates[0].type, 'approve-plan');
  assert.equal(request(snapshot).planHash, snapshot.planHash);
  const historical = structuredClone(plan);
  delete historical.checks; delete historical.checkRegistryHash;
  const oldHash = hashObject(historical);
  const state = f.service.store.readRun(snapshot.runId);
  const task = f.service.store.readObject('tasks', state.taskHash);
  assert.equal(hashObject(GraphPlanSchema.parse(historical)), oldHash);
  assert.equal(validatePlan(historical, task, { mode: 'historical' }).hash, oldHash);
});

test('an optional check criterion cannot invalidate a successful quality barrier for mandatory source-review work', async (t) => {
  const f = await fixture(t, { method: 'source-review' }), a = f.service.adapters;
  a.workflowPolicy = 'developer-v1';
  const registry = a.checkRegistry(), definition = structuredClone(registry.definitions[0]);
  delete definition.report;
  a.checkRegistry = () => ({ ...registry, definitions: [definition],
    bindings: registry.bindings.map((binding) => ({ ...binding, definitionHash: hashObject(definition) })) });
  const execute = a.execute;
  a.execute = async (options) => {
    const result = await execute(options);
    if (options.node.action.id === 'ai-plan') result.output.contractProposal.requirements.push({
      id: 'req-optional', title: 'Необязательная проверка', mandatory: false,
      verification: { method: 'check', checkIds: ['check-tests'], criterion: 'Необязательная проверка', paths: ['src/answer.test.mjs'] },
    });
    if (options.node.action.id === 'ai-review')
      result.output.requirementAssessments = result.output.requirementAssessments.filter((assessment) => assessment.requirementId === 'req-001');
    return result;
  };
  const snapshot = await f.run();
  assert.deepEqual(f.checkExitCodes(), [0]);
  assert.equal(snapshot.status, 'passed');
  assert.equal(snapshot.proof.status, 'PROVEN');
  assert.equal(snapshot.proof.coverage.required, 1);
  assert.equal(snapshot.proof.coverage.proven, 1);
  assert.equal(snapshot.proof.requirements.find((item) => item.id === 'req-optional').mandatory, false);
});
