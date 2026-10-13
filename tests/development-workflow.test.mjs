import test from 'node:test';
import assert from 'node:assert/strict';
import { DevelopmentWorkflowSchema, DEVELOPMENT_CAPABILITIES, DEVELOPMENT_METHODS, classifyDevelopmentTask, selectDevelopmentSkills, validateDevelopmentWorkflow } from '../scripts/ai-graph/lib/development-workflow.mjs';
import { CORE_SKILL_ROUTES } from '../scripts/ai-graph/lib/config.mjs';
import { hashObject } from '../scripts/ai-graph/lib/io.mjs';

const task = { goal: 'Search results', instructions: 'Update the existing search behavior', scope: ['src/search.tsx'], checks: ['browser'] };
const skill = { id: 'project-react', actions: ['ai-implement'], scope: ['src'] };
const policy = { version: 1, capabilities: [{ id: 'browser-scenario', checkIds: ['browser'] }], specialists: [{
  skillId: skill.id, domains: ['frontend'], frameworks: ['react'], majors: [19], taskKinds: ['behavior', 'bugfix'], requires: ['browser-scenario'],
}] };
const stack = { hash: hashObject('react19'), scope: ['src'], domains: ['frontend'], packages: [{ frameworks: [{ id: 'react', domain: 'frontend', version: { major: 19 } }] }] };
const route = (extra = {}) => selectDevelopmentSkills({ action: 'ai-implement', stack, task, policy, projectSkills: [skill], availableCheckIds: ['browser'],
  checkDefinitions: [{ id: 'browser', report: { format: 'playwright-json' } }], ...extra });

test('versioned routing chooses a compatible specialist and records unverified capability acceptance', () => {
  const selected = route();
  assert.ok(selected.ids.includes(skill.id));
  assert.ok(selected.ids.includes('domain-frontend'));
  assert.ok(!selected.ids.includes('domain-backend'));
  assert.equal(selected.capabilities[0].status, 'registered');
  assert.equal(selected.capabilities[0].acceptance, 'unverified');
  assert.equal(selected.exclusions.length, 0);
  assert.ok(!selected.ids.includes('core-debugging'));
});

test('missing capability, unknown major and incompatible version cannot select a specialist', () => {
  for (const major of [null, 18, 20]) {
    const selected = route({ stack: { ...stack, packages: [{ frameworks: [{ id: 'react', domain: 'frontend', version: { major } }] }] } });
    assert.ok(!selected.ids.includes(skill.id));
    assert.equal(selected.exclusions[0].reason, 'framework-or-version-unknown-or-incompatible');
  }
  const missing = route({ availableCheckIds: [] });
  assert.ok(!missing.ids.includes(skill.id));
  assert.equal(missing.capabilities[0].status, 'unavailable');
  assert.deepEqual(missing.exclusions[0].missing, ['browser-scenario']);
  assert.ok(!route({ stack: { ...stack, domains: ['mobile'], packages: [{ frameworks: [{ id: 'react', domain: 'mobile', version: { major: 19 } }] }] } }).ids.includes(skill.id), 'React dependency in native mobile must not select a web specialist');
  assert.ok(!route({ stack: { ...stack, packages: [{ frameworks: [stack.packages[0].frameworks[0], { id: 'react', domain: 'frontend', version: { major: 18 } }] }] } }).ids.includes(skill.id), 'conflicting dependency roles cannot select a compatible specialist');
});

test('task kind and original risk select useful phases without weakening mandatory checks', () => {
  const original = structuredClone(task);
  assert.equal(classifyDevelopmentTask({ ...task, instructions: 'Fix an authorization defect' }).rigor, 'high-risk');
  const routineTask = { ...task, goal: 'Typo', instructions: 'Correct wording', scope: ['README.md'] };
  const routine = route({ task: routineTask, action: 'ai-plan', projectSkills: [] });
  assert.equal(routine.classification.rigor, 'routine');
  assert.ok(!routine.ids.includes('workflow-planning'));
  assert.ok(!routine.ids.includes('workflow-reuse'));
  const standard = route({ action: 'ai-plan', projectSkills: [] });
  assert.ok(standard.ids.includes('workflow-planning'));
  assert.ok(standard.ids.includes('workflow-reuse'));
  assert.ok(route({ failureClass: 'implementation' }).ids.includes('core-debugging'));
  assert.ok(!route({ failureClass: 'environment' }).ids.includes('core-debugging'));
  assert.deepEqual(task, original);
  assert.ok(CORE_SKILL_ROUTES['ai-implement'].includes('core-debugging'), 'legacy policy remains unchanged');
});

test('owner metadata rejects executable fields, unknown recipes and unregistered references', () => {
  validateDevelopmentWorkflow(policy, { projectSkills: [skill], checks: ['browser'] });
  for (const invalid of [
    { ...policy, executable: '/bin/sh' },
    { ...policy, capabilities: [{ id: 'shell-exec', checkIds: ['browser'] }] },
    { ...policy, specialists: [{ ...policy.specialists[0], executable: '/bin/sh' }] },
    { ...policy, specialists: [{ ...policy.specialists[0], majors: [19, 19] }] },
    { ...policy, capabilities: [...policy.capabilities, ...policy.capabilities] },
  ]) assert.equal(DevelopmentWorkflowSchema.safeParse(invalid).success, false);
  assert.throws(() => validateDevelopmentWorkflow(policy, { projectSkills: [skill], checks: [] }), { code: 'WORKFLOW_CHECK_UNREGISTERED' });
  assert.throws(() => validateDevelopmentWorkflow(policy, { projectSkills: [], checks: ['browser'] }), { code: 'WORKFLOW_SKILL_UNREGISTERED' });
});

test('behavior assertion method follows implementation and scoped risk/gap review without changing legacy routes', () => {
  assert.ok(route().ids.includes('workflow-test-quality'));
  assert.ok(!route({ action: 'ai-plan' }).ids.includes('workflow-test-quality'));
  assert.ok(!route({ action: 'ai-review' }).ids.includes('workflow-test-quality'));
  for (const instructions of ['Fix an error in search', 'Preserve authorization denials', 'Review test gaps for search'])
    assert.ok(route({ action: 'ai-review', task: { ...task, instructions } }).ids.includes('workflow-test-quality'));
  assert.ok(!route({ task: { ...task, scope: ['README.md'] } }).ids.includes('workflow-test-quality'));
  assert.ok(!CORE_SKILL_ROUTES['ai-implement'].includes('workflow-test-quality'));
});

test('routing identity covers catalogue, policy, selected facts and excludes unsupported actions', () => {
  const selected = route();
  assert.equal(selected.catalogHash, hashObject({ capabilities: DEVELOPMENT_CAPABILITIES, methods: DEVELOPMENT_METHODS }));
  assert.notEqual(selected.hash, route({ availableCheckIds: [] }).hash);
  assert.notEqual(selected.hash, route({ task: { ...task, instructions: 'Fix a bug' } }).hash);
  assert.throws(() => route({ action: 'shell-exec' }), { code: 'SKILL_ACTION_UNKNOWN' });
});

test('capabilities are scoped and component reports cannot claim native device or browser verification', () => {
  assert.equal(route({ checkDefinitions: [{ id: 'browser', report: { format: 'jest-json' } }] }).capabilities[0].status, 'unavailable');
  const elsewhere = { ...policy, capabilities: [{ ...policy.capabilities[0], scope: ['other'] }] };
  assert.equal(route({ policy: elsewhere }).capabilities[0].status, 'unavailable');
  const native = { version: 1, capabilities: [{ id: 'mobile-ios-scenario', checkIds: ['browser'] }] };
  assert.equal(route({ policy: native, projectSkills: [] }).capabilities[0].status, 'unavailable');
  const api = { version: 1, capabilities: [{ id: 'api-integration', checkIds: ['browser'], scope: ['src'] }] };
  const selected = route({ policy: api, projectSkills: [], stack: { ...stack, domains: ['engineering'], packages: [] }, checkDefinitions: [{ id: 'browser', report: { format: 'flowcairn-node-test/v1' } }] });
  assert.ok(selected.ids.includes('domain-backend'), 'explicit scoped owner capability supports native Node HTTP without inventing a framework');
});
