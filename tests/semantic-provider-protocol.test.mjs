import test from 'node:test';
import assert from 'node:assert/strict';
import { aiResponseSchema } from '../scripts/ai-graph/lib/runner-ai-command.mjs';

test('plan-review generation distinguishes compiled work/check action IDs from proposal and registry IDs', () => {
  const node = { planReview: true, action: { id: 'ai-analyze' }, skills: [] };
  const plan = { nodes: [{ id: 'step-fix', action: { id: 'ai-implement' } }], taskContract: {
    requirements: [{ id: 'req-001', verification: { criterion: 'Точное исходное поведение', checkIds: ['check-api-scenarios'] } }], unknowns: [],
  } };
  const schema = aiResponseSchema(node, plan);
  const properties = schema.properties.requirementAssessments.items.properties;
  assert.deepEqual(properties.workIds.items.enum, ['step-fix']);
  assert.deepEqual(properties.checkIds.items.enum, ['check-api-scenarios']);
  assert.deepEqual(properties.requirementId.enum, ['req-001']);
  assert.deepEqual(properties.criterion.enum, ['Точное исходное поведение']);
  for (const refs of [properties.planReferences, schema.properties.unknownAssessments.items.properties.planReferences]) {
    assert.deepEqual(refs.items.properties.workId.enum, ['step-fix']);
    assert.deepEqual(refs.items.properties.checkIds.items.enum, ['check-api-scenarios']);
    assert.equal(refs.items.properties.creationPaths.minItems, 0, 'linked known verifier reference does not invent creation');
    assert.equal(refs.minItems, undefined, 'existing source citations permit no creation references');
  }
  assert.equal(schema.properties.unknownAssessments.maxItems, 0, 'no invented unknowns');
});

test('a human plan review cannot invent check IDs while original unknowns stay exact', () => {
  const node = { planReview: true, action: { id: 'ai-analyze' }, skills: [] };
  const plan = { nodes: [{ id: 'step-human-result', action: { id: 'ai-implement' } }], taskContract: {
    requirements: [{ id: 'req-001', verification: { criterion: 'Приемка владельца', checkIds: [] } }], unknowns: ['Существенный выбор владельца'],
  } };
  const schema = aiResponseSchema(node, plan);
  assert.equal(schema.properties.requirementAssessments.items.properties.checkIds.maxItems, 0);
  assert.equal(schema.properties.requirementAssessments.items.properties.planReferences.items.properties.checkIds.maxItems, 0);
  assert.equal(schema.properties.requirementAssessments.items.properties.planReferences.items.properties.creationPaths.minItems, 1);
  assert.deepEqual(schema.properties.unknownAssessments.items.properties.unknown.enum, ['Существенный выбор владельца']);
});
