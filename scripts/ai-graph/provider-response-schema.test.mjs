import test from 'node:test';
import assert from 'node:assert/strict';
import { AIPlanningResultSchema, AIReviewResultSchema } from './lib/schemas.mjs';
import { RUNNER_TESTING } from './lib/runner.mjs';

const nodeFor = (action) => ({ action: { id: action }, skills: ['project-context'], resources: { writes: action === 'ai-implement' ? ['src/value.mjs'] : [] } });

function assertStrictObjects(value, location = '$') {
  if (!value || typeof value !== 'object') return 0;
  let count = 0;
  if (value.properties) {
    count++;
    assert.deepEqual([...value.required].sort(), Object.keys(value.properties).sort(), `${location}: every property is required`);
    assert.equal(value.additionalProperties, false, `${location}: no additional properties`);
  }
  for (const [key, entry] of Object.entries(value)) {
    if (Array.isArray(entry)) count += entry.reduce((total, item, index) => total + assertStrictObjects(item, `${location}.${key}[${index}]`), 0);
    else if (entry && typeof entry === 'object') count += assertStrictObjects(entry, `${location}.${key}`);
  }
  return count;
}

for (const action of ['ai-analyze', 'ai-plan', 'ai-implement', 'ai-review']) {
  test(`${action} provider schema meets strict object requirements recursively`, () => {
    const schema = RUNNER_TESTING.aiResponseSchema(nodeFor(action), { workflow: 'autonomous' });
    assert.ok(assertStrictObjects(schema) >= 5, 'nested mutation/result structures are checked too');
    assert.deepEqual(schema.properties.skillsUsed.items.enum, ['project-context']);
    if (action !== 'ai-implement')
      for (const name of ['edits', 'moves', 'jsonTransfers', 'changedFiles']) assert.equal(schema.properties[name].maxItems, 0);
  });
}

test('planner and reviewer optional runtime fields become typed required provider fields without null alternatives', () => {
  const planner = RUNNER_TESTING.aiResponseSchema(nodeFor('ai-plan'), { workflow: 'autonomous' });
  assert.ok(planner.required.includes('contractProposal'));
  assert.equal(planner.properties.contractProposal.type, 'object');
  const step = planner.properties.steps.items;
  for (const name of ['readPaths', 'requirementIds']) {
    assert.ok(step.required.includes(name));
    assert.equal(step.properties[name].type, 'array');
  }
  const reviewer = RUNNER_TESTING.aiResponseSchema(nodeFor('ai-review'), {});
  assert.ok(reviewer.required.includes('requirementAssessments'));
  assert.equal(reviewer.properties.requirementAssessments.type, 'array');
});

test('strict provider generation does not break legacy stored planner or reviewer responses', () => {
  const base = { summary: 'Legacy response', verdict: 'pass', skillsUsed: [], findings: [], changedFiles: [], plan: [] };
  const planning = AIPlanningResultSchema.parse({ ...base,
    steps: [{ id: 'legacy-step', title: 'Legacy step', outcome: 'Existing outcome', needs: [], paths: ['src/value.mjs'] }] });
  assert.equal(planning.contractProposal, undefined);
  assert.equal(planning.steps[0].readPaths, undefined);
  assert.equal(planning.steps[0].requirementIds, undefined);
  const review = AIReviewResultSchema.parse({ ...base, reviewEvidenceHash: 'a'.repeat(64) });
  assert.equal(review.requirementAssessments, undefined);
});

test('strict normalization preserves existing nullable values and exact write scope constraints', () => {
  const schema = RUNNER_TESTING.aiResponseSchema(nodeFor('ai-implement'), {});
  assert.ok(schema.properties.reviewEvidenceHash.anyOf.some((variant) => variant.type === 'null'));
  const pathPattern = new RegExp(schema.properties.edits.items.properties.path.pattern);
  assert.equal(pathPattern.test('src/value.mjs'), true);
  assert.equal(pathPattern.test('src/other.mjs'), false);
});
