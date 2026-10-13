import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PLAN_CORRECTIONS, planningCorrection } from '../scripts/ai-graph/lib/plan-correction.mjs';
import { RunStateSchema } from '../scripts/ai-graph/lib/schemas.mjs';

const plan = { workflowPolicy: 'developer-v1', stage: 'planning', nodes: [{ id: 'plan-task', action: { id: 'ai-plan' } }] };
const state = { nodes: { 'plan-task': { status: 'failed', reason: 'PLAN_REQUIREMENT_COVERAGE: Missing required work' } } };
const receipt = { nodeId: 'plan-task', phase: 'finished', changedFiles: [], beforeFingerprint: 'same', afterFingerprint: 'same', termination: { stopped: true, uncertain: false } };
const decide = (extra = {}) => planningCorrection({ state, plan, receipt, ...extra });

test('plan corrections have an independent two-cycle budget and preserve original intent in feedback', () => {
  assert.equal(MAX_PLAN_CORRECTIONS, 2);
  assert.equal(decide().nextCycle, 1);
  assert.match(decide().feedback, /сохрани все обязательные требования/);
  assert.equal(decide({ state: { ...state, planCorrectionCycles: 1 } }).nextCycle, 2);
  assert.equal(decide({ state: { ...state, planCorrectionCycles: 2 } }).reason, 'PLAN_CORRECTION_BUDGET_EXHAUSTED');
  assert.equal(decide({ state: { ...state, planningTransitions: 7 } }).nextCycle, 1, 'context discovery and promotion do not consume this budget');
});

test('unknown process, changed source, another node, unknown failure and execution do not auto-correct plans', () => {
  for (const candidate of [null, { ...receipt, phase: 'started' }, { ...receipt, nodeId: 'other' },
    { ...receipt, afterFingerprint: 'changed' }, { ...receipt, changedFiles: ['src/index.mjs'] },
    { ...receipt, termination: { stopped: false, uncertain: true } },
  ]) assert.equal(decide({ receipt: candidate }).allowed, false);
  assert.equal(decide({ plan: { ...plan, stage: 'execution' } }).allowed, false);
  assert.equal(decide({ state: { nodes: { 'plan-task': { status: 'failed', reason: 'Unknown text' } } } }).allowed, false);
});

test('durable state accepts only a bounded optional counter without a historical default', () => {
  const shape = RunStateSchema.options[0].shape;
  assert.equal(shape.planCorrectionCycles.parse(undefined), undefined);
  assert.equal(shape.planCorrectionCycles.parse(2), 2);
  assert.equal(shape.planCorrectionCycles.safeParse(3).success, false);
});
