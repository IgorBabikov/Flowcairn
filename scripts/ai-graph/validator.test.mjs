import assert from 'node:assert/strict';
import test from 'node:test';
import { hashObject } from './lib/io.mjs';
import { TaskSpecSchema } from './lib/schemas.mjs';
import { compilePlan, validatePlan, assertPlanHash } from './lib/validator.mjs';
import { REQUIRED_AI_CONTEXT_PATHS, resolveAction } from './lib/registry.mjs';

const hash = 'a'.repeat(64);
const skills = [
  'project-context',
  'clean-implementation',
  'testing',
  'delivery-pipeline',
  'code-review',
].map((id) => ({ id, path: `.agents/skills/${id}/SKILL.md`, hash }));
function fixture() {
  const task = TaskSpecSchema.parse({
    schemaVersion: 2,
    id: 'ORCH-DOCS',
    goal: 'Описать запуск',
    instructions: 'Написать проверяемую инструкцию запуска',
    scope: ['docs/ai/examples/'],
    acceptance: ['Есть команда и наблюдаемый результат'],
    checks: [],
    contextPaths: ['AGENTS.md'],
    sourceHash: hash,
  });
  return { task, ...compilePlan(task, { runtimeHash: hash, skills }) };
}
function mutate(fn, code) {
  const { task, plan } = fixture();
  const candidate = structuredClone(plan);
  fn(candidate);
  assert.throws(
    () => validatePlan(candidate, task),
    (e) => e.code === code,
  );
}
test('compiler produces immutable executable DAG with two required gates', () => {
  const value = fixture();
  assert.equal(value.order[0], 'approve-plan');
  assert.equal(value.order.at(-1), 'accept-result');
  assertPlanHash(value.plan, value.hash);
  assert.throws(() => {
    value.plan.nodes[0].title = 'changed';
  }, TypeError);
});
test('compiler gives AI declared context without expanding its write scope', () => {
  const { task } = fixture();
  task.contextPaths = ['docs/PROJECT-MAP.md'];
  const { plan } = compilePlan(task, { runtimeHash: hash, skills });
  const aiNodes = plan.nodes.filter((node) => node.action.id.startsWith('ai-'));
  assert.ok(aiNodes.length > 0);
  for (const node of aiNodes) {
    assert.ok(node.resources.reads.includes('docs/PROJECT-MAP.md'));
    assert.ok(REQUIRED_AI_CONTEXT_PATHS.every((path) => node.resources.reads.includes(path)));
  }
  assert.deepEqual(plan.nodes.find((node) => node.id === 'implement').resources.writes, task.scope);
  assert.deepEqual(
    plan.nodes.find((node) => node.id === 'workspace-check').resources.reads,
    task.scope,
  );
});
test('current policy denies forbidden, sensitive, and missing mandatory AI context', () => {
  const { task } = fixture();
  task.contextPaths = ['docs/private'];
  task.forbiddenPaths = ['docs/private'];
  assert.throws(
    () => compilePlan(task, { runtimeHash: hash, skills }),
    (error) => error.code === 'PATH_SCOPE',
  );

  const sensitive = fixture().task;
  sensitive.contextPaths = ['.env'];
  assert.throws(
    () => compilePlan(sensitive, { runtimeHash: hash, skills }),
    (error) => error.code === 'PATH_SCOPE',
  );

  mutate((plan) => {
    const analyze = plan.nodes.find((node) => node.id === 'analyze');
    analyze.resources.reads = analyze.resources.reads.filter((path) => path !== 'AGENTS.md');
  }, 'AI_CONTEXT_MISSING');
});
test('rejects cycles, missing dependencies and duplicate node identifiers', () => {
  mutate((p) => (p.nodes[0].needs = ['accept-result']), 'CYCLE');
  mutate((p) => (p.nodes[1].needs = ['unknown-node']), 'MISSING_DEPENDENCY');
  mutate((p) => p.nodes.push(p.nodes[1]), 'DUPLICATE_NODE');
});
test('denies unknown actions, injected argv, altered permissions and unknown skills', () => {
  mutate((p) => (p.nodes[2].action.id = 'shell-exec'), 'UNKNOWN_ACTION');
  mutate((p) => (p.nodes[2].action.inputs = { argv: ['rm', '-rf', '/'] }), 'INVALID_ACTION_INPUT');
  mutate((p) => (p.nodes[2].permissions = []), 'PERMISSION_MISMATCH');
  mutate((p) => (p.nodes[2].skills = ['invented-skill']), 'SKILL_POLICY');
  assert.throws(
    () => resolveAction('commit'),
    (e) => e.code === 'UNKNOWN_ACTION',
  );
});
test('approval cannot be bypassed and every node must feed final acceptance', () => {
  mutate((p) => {
    p.nodes[2].needs = [];
    p.nodes.at(-1).needs.push('analyze');
  }, 'APPROVAL_BYPASS');
  mutate(
    (p) => (p.nodes.find((n) => n.id === 'review').needs = ['implement']),
    'ACCEPTANCE_BYPASS',
  );
});
test('rejects success weakening, unsafe retry and scope escape', () => {
  mutate((p) => (p.nodes[2].success.requiredArtifacts = []), 'INVALID_SUCCESS_CONTRACT');
  mutate((p) => (p.nodes[2].retry.maxAttempts = 3), 'UNSAFE_RETRY_POLICY');
  mutate((p) => (p.nodes[2].resources.writes = ['apps/api/']), 'PATH_SCOPE');
  mutate((p) => (p.nodes[2].resources.writes = ['../outside']), 'INVALID_PLAN');
});
test('accepts independent read branches and rejects unordered resource writers', () => {
  const { task, plan } = fixture();
  const branch = structuredClone(plan);
  const source = branch.nodes.find((n) => n.id === 'workspace-check');
  const second = { ...structuredClone(source), id: 'check-second' };
  branch.nodes.push(second);
  branch.nodes.find((n) => n.id === 'review').needs.push(second.id);
  assert.doesNotThrow(() => validatePlan(branch, task));
  const a = branch.nodes.find((n) => n.id === 'implement'),
    b = { ...structuredClone(a), id: 'implement-second' };
  branch.nodes.push(b);
  source.needs.push(b.id);
  second.needs.push(b.id);
  assert.throws(
    () => validatePlan(branch, task),
    (e) => e.code === 'RESOURCE_CONFLICT',
  );
});
test('task-specific mandatory checks cannot be removed by draft JSON', () => {
  const { task } = fixture();
  task.scope = ['src/'];
  task.checks = ['typecheck', 'lint', 'tests', 'build'];
  const value = compilePlan(task, { runtimeHash: hash, skills });
  const candidate = structuredClone(value.plan);
  candidate.nodes.find((n) => n.id === 'typecheck').action.id = 'workspace-check';
  candidate.nodes.find((n) => n.id === 'typecheck').permissions = [];
  assert.throws(
    () => validatePlan(candidate, task),
    (e) => e.code === 'MISSING_REQUIRED_CHECK',
  );
});
test('plan hash, runtime and skill drift are rejected', () => {
  const { task, plan, hash: planHash } = fixture();
  const changed = structuredClone(plan);
  changed.nodes[0].title = 'changed';
  assert.throws(
    () => assertPlanHash(changed, planHash),
    (e) => e.code === 'PLAN_INTEGRITY',
  );
  assert.throws(
    () => validatePlan(plan, task, { runtimeHash: 'b'.repeat(64) }),
    (e) => e.code === 'RUNTIME_DRIFT',
  );
  assert.throws(
    () => validatePlan(plan, task, { skills: [] }),
    (e) => e.code === 'SKILL_DRIFT',
  );
});
test('historical validation reads inert old actions without granting current authorization', () => {
  const { task, plan } = fixture();
  const old = structuredClone(plan);
  old.registryHash = 'b'.repeat(64);
  old.policyHash = 'c'.repeat(64);
  old.runtimeHash = 'd'.repeat(64);
  const retired = old.nodes.find((node) => node.id === 'analyze');
  retired.action.id = 'retired-analysis';
  retired.resources.reads.push('legacy/retired-context.md');
  assert.throws(
    () => validatePlan(old, task),
    (e) => e.code === 'POLICY_DRIFT',
  );
  const currentUnknown = structuredClone(plan);
  currentUnknown.nodes.find((node) => node.id === 'analyze').action.id = 'retired-analysis';
  assert.throws(
    () => validatePlan(currentUnknown, task),
    (e) => e.code === 'UNKNOWN_ACTION',
  );
  assert.doesNotThrow(() =>
    validatePlan(old, task, {
      mode: 'historical',
      runtimeHash: hash,
      skills: [],
    }),
  );
  assert.throws(
    () => validatePlan(old, task, { mode: 'historic' }),
    (e) => e.code === 'INVALID_VALIDATION_MODE',
  );

  const legacyTask = structuredClone(task);
  delete legacyTask.contextPaths;
  const legacy = structuredClone(old);
  legacy.taskHash = hashObject(legacyTask);
  assert.doesNotThrow(() => validatePlan(legacy, legacyTask, { mode: 'historical' }));
});
test('historical validation still rejects task mismatch and broken DAG structure', () => {
  const { task, plan } = fixture();
  const mismatched = structuredClone(plan);
  mismatched.taskHash = 'b'.repeat(64);
  assert.throws(
    () => validatePlan(mismatched, task, { mode: 'historical' }),
    (e) => e.code === 'PLAN_TASK_MISMATCH',
  );
  const cyclic = structuredClone(plan);
  cyclic.nodes[0].needs = ['accept-result'];
  assert.throws(
    () => validatePlan(cyclic, task, { mode: 'historical' }),
    (e) => e.code === 'CYCLE',
  );
});
test('deep untrusted inputs fail before recursive schema parsing', () => {
  const { task, plan } = fixture();
  const candidate = structuredClone(plan);
  let nested = {};
  candidate.nodes[0].action.inputs = nested;
  for (let i = 0; i < 100; i++) {
    nested.next = {};
    nested = nested.next;
  }
  assert.throws(
    () => validatePlan(candidate, task),
    (e) => e.code === 'INPUT_LIMIT',
  );
});

test('compiled operator stages are Russian while check identifiers stay stable', () => {
  const { task } = fixture();
  task.checks = ['typecheck', 'lint', 'tests', 'build'];
  const { plan } = compilePlan(task, { runtimeHash: hash, skills });
  for (const node of plan.nodes) assert.match(node.title, /[А-Яа-я]/u);
  for (const check of task.checks)
    assert.equal(plan.nodes.find((node) => node.id === check).action.id, `check-${check}`);
  assertPlanHash(plan, hashObject(plan));
});
