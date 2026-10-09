import test from 'node:test';
import assert from 'node:assert/strict';
import { contractForPrompt } from './lib/contract-prompt.mjs';
import { buildTaskContract } from './lib/task-contract.mjs';
import { buildPrompt } from './lib/codex.mjs';

test('planning contracts preserve every criterion while sharing identical verification scopes', () => {
  const task = { goal: 'Finish a real task', instructions: 'Preserve every required outcome',
    scope: Array.from({ length: 25 }, (_, n) => `src/components/component-${n}/localization/implementation.test.ts`),
    contextPaths: [], forbiddenPaths: [], checks: ['tests'],
    acceptance: Array.from({ length: 15 }, (_, n) => `Required behavior ${n}`) };
  const contract = buildTaskContract(task), before = structuredClone(contract);
  const compressed = contractForPrompt(contract, true);
  assert.ok(JSON.stringify(compressed).length < JSON.stringify(contract).length / 3);
  const expanded = structuredClone(compressed);
  for (const requirement of expanded.requirements) {
    if (requirement.verification.paths.sameAs === 'scope') requirement.verification.paths = [...expanded.scope];
    if (requirement.verification.criterion.sameAs === 'title') requirement.verification.criterion = requirement.title;
  }
  assert.deepEqual(expanded, contract);
  assert.deepEqual(contract, before);
  assert.strictEqual(contractForPrompt(contract, false), contract);
  const node = { id: 'plan-task', action: { id: 'ai-plan' }, skills: [], resources: { reads: ['src'], writes: [] } };
  const prompt = buildPrompt({ nodeId: node.id, task, plan: { stage: 'planning', nodes: [node] }, skills: '', priorEvidence: null });
  assert.ok(prompt.includes('"sameAs":"scope"'));
  for (const requirement of contract.requirements) {
    assert.ok(prompt.includes(requirement.id));
    assert.ok(prompt.includes(requirement.title));
  }
});

test('a narrower verification scope is never expanded or replaced by a reference', () => {
  const contract = { scope: ['src', 'tests'], requirements: [{ id: 'R1', mandatory: true,
    verification: { method: 'check', checkIds: ['check-tests'], criterion: 'Specific behavior', paths: ['tests/behavior.test.ts'] } }] };
  assert.deepEqual(contractForPrompt(contract, true), contract);
});
