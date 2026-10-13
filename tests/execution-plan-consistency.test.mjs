import test from 'node:test';
import assert from 'node:assert/strict';
import { validateExecutionPlanConsistency } from '../scripts/ai-graph/lib/execution-plan-consistency.mjs';
import { buildTaskContract } from '../scripts/ai-graph/lib/task-contract.mjs';
import { TaskSpecSchema } from '../scripts/ai-graph/lib/schemas.mjs';
import { hashObject } from '../scripts/ai-graph/lib/io.mjs';

const task = TaskSpecSchema.parse({ schemaVersion: 2, sourceHash: hashObject('execution-gate'), id: 'TASK-EXECUTION-GATE',
  goal: 'Format export', instructions: 'Preserve the format', acceptance: ['The export preserves text'], scope: ['src'], contextPaths: [], checks: [] });
const work = (id, declaredNeeds, extra = {}) => ({ id, title: id, outcome: 'Preserve text', action: { id: 'ai-implement' },
  resources: { writes: [`src/${id}.mjs`] }, needs: declaredNeeds.length ? declaredNeeds : ['approve-plan'], declaredNeeds, ...extra });
const contract = buildTaskContract(task, { steps: [{ id: 'two', nodeId: 'two', paths: ['src/two.mjs'] }] });
const interfaceContract = 'TextV1 = { text: string }; preserve text';
const plan = { workflowPolicy: 'developer-v1', stage: 'execution', taskContract: contract, nodes: [
  work('one', [], { produces: [{ id: 'text', contract: interfaceContract }] }),
  work('two', ['one'], { consumes: [{ id: 'text', producerId: 'one', contract: interfaceContract }] }),
] };

test('the pre-write gate accepts a coherent declared interface chain without treating human acceptance as proven', () => {
  const result = validateExecutionPlanConsistency(plan);
  assert.equal(result.status, 'structurally-valid');
  assert.equal(result.verificationStatus, 'pending');
  assert.deepEqual(result.humanRequirementIds, ['req-001']);
});

test('direct draft cannot bypass coverage, interface or real dependency checks', () => {
  const uncovered = structuredClone(plan); uncovered.taskContract.requirements[0].workIds = [];
  assert.throws(() => validateExecutionPlanConsistency(uncovered), { code: 'PLAN_REQUIREMENT_COVERAGE' });
  const mismatch = structuredClone(plan); mismatch.nodes[1].consumes[0].contract = 'A different schema';
  assert.throws(() => validateExecutionPlanConsistency(mismatch), { code: 'PLAN_INTERFACE_MISMATCH' });
  const declared = structuredClone(plan); declared.nodes[1].declaredNeeds = [];
  declared.taskContract.requirements[0].workIds = ['one', 'two'];
  assert.throws(() => validateExecutionPlanConsistency(declared), { code: 'PLAN_INTERFACE_DEPENDENCY' });
  const missingEdge = structuredClone(plan); missingEdge.nodes[1].needs = ['approve-plan'];
  assert.throws(() => validateExecutionPlanConsistency(missingEdge), { code: 'PLAN_WORK_DEPENDENCY' });
});

test('developer direct draft needs declared work metadata while inert legacy plans retain their previous semantics', () => {
  const missing = structuredClone(plan); delete missing.nodes[1].declaredNeeds;
  assert.throws(() => validateExecutionPlanConsistency(missing), { code: 'PLAN_WORK_DEPENDENCY' });
  delete missing.workflowPolicy;
  assert.equal(validateExecutionPlanConsistency(missing), null);
  assert.equal(validateExecutionPlanConsistency({ ...plan, stage: 'planning' }), null);
});

test('a mandatory behavior check cannot use unreported exit zero as requirement evidence', () => {
  const unsupported = structuredClone(plan);
  unsupported.taskContract.requirements[0].verification = { method: 'check', checkIds: ['check-tests'], criterion: 'The export preserves text', paths: ['src/test.mjs'] };
  unsupported.checks = { definitions: [{ id: 'tests', command: { executable: 'node', argv: ['-e', 'process.exit(0)'] } }] };
  assert.throws(() => validateExecutionPlanConsistency(unsupported), { code: 'PLAN_VERIFIER_MISSING' });
});
