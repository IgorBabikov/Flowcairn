import test from 'node:test';
import assert from 'node:assert/strict';
import { hashObject } from '../scripts/ai-graph/lib/io.mjs';
import { TaskSpecSchema } from '../scripts/ai-graph/lib/schemas.mjs';
import { SKILL_ROUTES } from '../scripts/ai-graph/lib/config.mjs';
import { compileTaskProposal } from '../scripts/ai-graph/lib/planning.mjs';
import { planningCorrection } from '../scripts/ai-graph/lib/plan-correction.mjs';
import { aiResponseSchema } from '../scripts/ai-graph/lib/runner-ai-command.mjs';
import { AIPlanReviewResultSchema, buildSemanticPlanReviewInput, assessSemanticPlanReview,
  validateSemanticPlanReview, validateSemanticPlanReviewInput } from '../scripts/ai-graph/lib/semantic-plan-review.mjs';

function fixture(method = 'source-review') {
  const hash = hashObject('semantic-review-fixture');
  const task = TaskSpecSchema.parse({ id: 'TASK-REVIEW', goal: 'Сохранить объявление', instructions: 'Сохранить объявление.',
    scope: ['src'], acceptance: ['Объявление сохранено'], checks: method === 'check' ? ['tests'] : [], schemaVersion: 2, sourceHash: hash });
  const skills = [...new Set(Object.values(SKILL_ROUTES).flat())].map(id => ({ id, path: `skills/${id}/SKILL.md`, hash }));
  const proposal = { summary: 'План', verdict: 'pass', skillsUsed: [], findings: [], changedFiles: [], edits: [], plan: [],
    steps: [{ id: 'one', title: 'Объявление', outcome: 'Объявление сохранено', needs: [], paths: ['src/file.mjs'], requirementIds: ['req-001'] }],
    contractProposal: { requirements: [{ id: 'req-001', title: task.acceptance[0], mandatory: true,
      verification: { method, criterion: task.acceptance[0], checkIds: method === 'check' ? ['check-tests'] : [], paths: ['src/file.mjs'] } }],
    optionalImprovements: [], constraints: [], assumptions: [], unknowns: [] } };
  const plan = structuredClone(compileTaskProposal(task, proposal, { runtimeHash: hash, skills, workflow: 'autonomous' }).plan);
  const bundle = buildSemanticPlanReviewInput({ task, plan, proposal, planningArtifactHash: hashObject(proposal) });
  const output = { summary: 'План согласован, результат еще не проверен.', verdict: 'pass', skillsUsed: [], findings: [],
    inputHash: bundle.inputHash, reviewEvidenceHash: bundle.inputHash,
    changedFiles: [], edits: [], moves: [], jsonTransfers: [], plan: [],
    requirementAssessments: [{ requirementId: 'req-001', criterion: task.acceptance[0], workIds: ['step-one'], checkIds: method === 'check' ? ['check-tests'] : [],
      verdict: 'pass', citations: method === 'human' ? [] : [{ path: 'src/file.mjs', startLine: 1, quote: 'export const x = 1;' }], planReferences: [], reason: 'План сохраняет точный критерий.' }],
    unknownAssessments: [],
    dimensions: Object.fromEntries(['verifier', 'source', 'interfaces', 'unknowns', 'capabilities'].map(id => [id, { status: 'pass', reason: 'Проверена соответствующая граница плана.' }])) };
  return { ...bundle, output, task, plan, proposal };
}

test('full review input preserves bytes/absent fields and binds complete candidate identity', () => {
  const { input, inputHash, content, plan, proposal } = fixture();
  assert.equal(hashObject(input), inputHash);
  assert.deepEqual(JSON.parse(content), input);
  assert.equal(Object.hasOwn(proposal, 'moves'), false);
  assert.equal(Object.hasOwn(input.proposal, 'moves'), false);
  assert.deepEqual(input.plan, plan);
  const changed = structuredClone(input); changed.plan.nodes[0].title = 'Другой план';
  assert.throws(() => validateSemanticPlanReviewInput(changed), { code: 'PLAN_REVIEW_INVALID' });
});

test('consistent plan has a distinct role and pending verification, never PROVEN', () => {
  const { input, output } = fixture();
  const assessment = validateSemanticPlanReview(input, output);
  assert.equal(assessment.status, 'consistent');
  assert.equal(assessment.role, 'plan-consistency');
  assert.equal(assessment.verificationStatus, 'pending');
  assert.equal(Object.hasOwn(assessment, 'proof'), false);
});

test('prospective references respect a declared directory boundary without accepting its sibling', () => {
  const f = fixture();
  f.plan.nodes.find(node => node.id === 'step-one').resources.writes = ['src'];
  const bundle = buildSemanticPlanReviewInput({ task: f.task, plan: f.plan, proposal: f.proposal, planningArtifactHash: hashObject(f.proposal) });
  f.output.inputHash = f.output.reviewEvidenceHash = bundle.inputHash;
  f.output.requirementAssessments[0].citations = [];
  f.output.requirementAssessments[0].planReferences = [{ workId: 'step-one', checkIds: [], creationPaths: ['src/new-api.mjs'] }];
  assert.equal(validateSemanticPlanReview(bundle.input, f.output).status, 'consistent');
  f.output.requirementAssessments[0].planReferences[0].creationPaths = ['src-sibling/new-api.mjs'];
  assert.throws(() => validateSemanticPlanReview(bundle.input, f.output), { code: 'PLAN_REVIEW_INVALID' });
});

for (const [name, change] of [
  ['missing input hash', f => { delete f.output.inputHash; }],
  ['wrong input hash', f => { f.output.inputHash = hashObject('another run'); }],
  ['wrong transport hash', f => { f.output.reviewEvidenceHash = hashObject('wrong bundle'); }],
  ['omitted requirement', f => { f.output.requirementAssessments = []; }],
  ['unknown requirement', f => { f.output.requirementAssessments[0].requirementId = 'req-unknown'; }],
  ['duplicate requirement', f => { f.output.requirementAssessments.push(structuredClone(f.output.requirementAssessments[0])); }],
  ['weakened criterion', f => { f.output.requirementAssessments[0].criterion = 'Файл существует'; }],
  ['unrelated work', f => { f.output.requirementAssessments[0].workIds = ['handoff']; }],
  ['missing work', f => { f.output.requirementAssessments[0].workIds = []; }],
  ['different check', f => { f.output.requirementAssessments[0].checkIds = ['check-other']; }],
  ['empty source reference', f => { f.output.requirementAssessments[0].citations = []; }],
  ['whitespace quote', f => { f.output.requirementAssessments[0].citations[0].quote = '  '; }],
  ['fractional source line', f => { f.output.requirementAssessments[0].citations[0].startLine = 1.5; }],
  ['blocking finding with global pass', f => { f.output.findings.push({ severity: 'blocking', message: 'Не согласован API', path: 'src/file.mjs' }); }],
  ['negative dimension with global pass', f => { f.output.dimensions.interfaces.status = 'fail'; }],
  ['uncertain assessment with global pass', f => { f.output.requirementAssessments[0].verdict = 'uncertain'; }],
  ['missing dimension', f => { delete f.output.dimensions.capabilities; }],
  ['unconfirmed dimension status', f => { f.output.dimensions.verifier.status = 'supported'; }],
  ['scope or rights attempt', f => { f.output.permissions = ['workspace.source.write']; }],
  ['proposed edit', f => { f.output.edits.push({ path: 'src/file.mjs', previousHash: null, content: 'x', executable: false }); }],
]) test(`semantic gate rejects ${name}`, () => {
  const f = fixture(); change(f);
  assert.throws(() => validateSemanticPlanReview(f.input, f.output), { code: 'PLAN_REVIEW_INVALID' });
});

test('negative and unresolved review have distinct bounded routes', () => {
  const f = fixture(); f.output.verdict = 'fail'; f.output.dimensions.source.status = 'fail';
  assert.equal(assessSemanticPlanReview(f.input, f.output).status, 'blocked');
  assert.throws(() => validateSemanticPlanReview(f.input, f.output), { code: 'PLAN_REVIEW_BLOCKED' });
  f.output.verdict = 'uncertain'; f.output.dimensions.source.status = 'uncertain';
  assert.throws(() => validateSemanticPlanReview(f.input, f.output), { code: 'PLAN_REVIEW_UNCERTAIN' });
});

test('material contract unknown cannot be fabricated as semantic pass', () => {
  const f = fixture(); f.plan.taskContract.unknowns.push('Не выбран публичный способ миграции.');
  const bundle = buildSemanticPlanReviewInput({ task: f.task, plan: f.plan });
  f.output.inputHash = f.output.reviewEvidenceHash = bundle.inputHash;
  assert.throws(() => validateSemanticPlanReview(bundle.input, f.output), { code: 'PLAN_REVIEW_INVALID' });
});

test('planned human acceptance is allowed only as pending final verification', () => {
  const { input, output } = fixture('human');
  const assessment = validateSemanticPlanReview(input, output);
  assert.deepEqual(assessment.humanRequirementIds, ['req-001']);
  assert.equal(assessment.verificationStatus, 'pending');
});

test('direct candidate has full immutable plan without invented planner evidence', () => {
  const { task, plan } = fixture();
  const bundle = buildSemanticPlanReviewInput({ task, plan });
  assert.equal(bundle.input.proposal, null);
  assert.equal(bundle.input.planningArtifactHash, null);
  const partial = structuredClone(bundle.input); partial.plan.nodes.pop();
  assert.throws(() => validateSemanticPlanReviewInput(partial), { code: 'PLAN_REVIEW_INVALID' });
  assert.ok(AIPlanReviewResultSchema.safeParse(fixture().output).success);
});

test('a source-backed nonblocking analysis risk can be assessed without removing it', () => {
  const f = fixture(); f.plan.taskContract.unknowns.push('Есть риск задержки API.');
  const bundle = buildSemanticPlanReviewInput({ task: f.task, plan: f.plan });
  f.output.inputHash = f.output.reviewEvidenceHash = bundle.hash;
  f.output.unknownAssessments = [{ unknown: 'Есть риск задержки API.', disposition: 'nonblocking-risk',
    reason: 'В плане предусмотрено сохранение существующей обработки.', planReferences: [],
    citations: f.output.requirementAssessments[0].citations }];
  assert.equal(validateSemanticPlanReview(bundle.input, f.output).status, 'consistent');
  assert.deepEqual(bundle.input.taskContract.unknowns, ['Есть риск задержки API.']);
  f.output.unknownAssessments[0].disposition = 'unresolved-material'; f.output.verdict = 'uncertain';
  assert.throws(() => validateSemanticPlanReview(bundle.input, f.output), { code: 'PLAN_REVIEW_UNCERTAIN' });
});

test('new files may use exact authorized creation references instead of invented source quotes', () => {
  const f = fixture(); f.output.requirementAssessments[0].citations = [];
  f.output.requirementAssessments[0].planReferences = [{ workId: 'step-one', checkIds: [], creationPaths: ['src/file.mjs'] }];
  assert.equal(validateSemanticPlanReview(f.input, f.output).status, 'consistent');
  f.output.requirementAssessments[0].planReferences[0].creationPaths = ['src/unplanned-api.mjs'];
  assert.throws(() => validateSemanticPlanReview(f.input, f.output), { code: 'PLAN_REVIEW_INVALID' });
  f.output.requirementAssessments[0].planReferences[0].creationPaths = ['private/secret.mjs'];
  assert.throws(() => validateSemanticPlanReview(f.input, f.output), { code: 'PLAN_REVIEW_INVALID' });
});

test('the existing action has a dedicated strict provider result only under the trusted marker', () => {
  const { task, plan } = fixture();
  const schema = aiResponseSchema({ action: { id: 'ai-analyze' }, planReview: true, skills: [] }, plan, task);
  assert.ok(schema.required.includes('inputHash'));
  assert.ok(schema.required.includes('unknownAssessments'));
  assert.equal(schema.properties.analysis, undefined);
  assert.equal(schema.additionalProperties, false);
  for (const key of ['edits', 'moves', 'jsonTransfers', 'changedFiles', 'plan']) assert.equal(schema.properties[key].maxItems, 0);
});

test('semantic correction cannot repeat a timed-out, signaled or uncertain process as plan failure', () => {
  const plan = { stage: 'execution', workflowPolicy: 'developer-v2', nodes: [{ id: 'plan-review', planReview: true }] };
  const state = { nodes: { 'approve-plan': { status: 'pending' }, 'plan-review': { status: 'failed', reason: 'PLAN_REVIEW_BLOCKED' } } };
  const receipt = { nodeId: 'plan-review', actionId: 'ai-analyze', phase: 'finished', verdict: 'fail', exitCode: 0,
    beforeFingerprint: 'same', afterFingerprint: 'same', changedFiles: [],
    termination: { stopped: true, uncertain: false, timedOut: false, outputLimit: false, signal: null } };
  assert.equal(planningCorrection({ state, plan, receipt }).allowed, true);
  for (const [key, value] of [['timedOut', true], ['outputLimit', true], ['signal', 'SIGTERM'], ['uncertain', true]]) {
    const changed = structuredClone(receipt); changed.termination[key] = value;
    assert.equal(planningCorrection({ state, plan, receipt: changed }).allowed, false);
  }
});

test('known work and its exact linked verifier ground a risk without invented creation', () => {
  const f = fixture('check'); f.plan.taskContract.unknowns.push('Риск конкурентного запроса.');
  const bundle = buildSemanticPlanReviewInput({ task: f.task, plan: f.plan });
  f.output.inputHash = f.output.reviewEvidenceHash = bundle.hash;
  const ref = { workId: 'step-one', checkIds: ['check-tests'], creationPaths: [] };
  f.output.unknownAssessments = [{ unknown: 'Риск конкурентного запроса.', disposition: 'resolved-in-plan',
    reason: 'Объявленная работа и точная проверка сохраняют concurrency criterion.', citations: [], planReferences: [ref] }];
  f.output.requirementAssessments[0].citations = [];
  f.output.requirementAssessments[0].planReferences = [ref];
  assert.equal(validateSemanticPlanReview(bundle.input, f.output).status, 'consistent');
  f.output.unknownAssessments[0].planReferences = [];
  assert.throws(() => validateSemanticPlanReview(bundle.input, f.output), { code: 'PLAN_REVIEW_INVALID' });
  f.output.unknownAssessments[0].planReferences = [{ ...ref, checkIds: [] }];
  assert.throws(() => validateSemanticPlanReview(bundle.input, f.output), { code: 'PLAN_REVIEW_INVALID' });
  f.output.unknownAssessments[0].planReferences = [{ ...ref, checkIds: ['check-unrelated'] }];
  assert.throws(() => validateSemanticPlanReview(bundle.input, f.output), { code: 'PLAN_REVIEW_INVALID' });
});

test('a source-review/no-check assessment cannot borrow an executable verifier from another requirement', () => {
  const f = fixture('check');
  f.plan.taskContract.requirements.push({ ...structuredClone(f.plan.taskContract.requirements[0]), id: 'req-static',
    title: 'Статическая декларация', verification: { method: 'source-review', criterion: 'Статическая декларация', checkIds: [], paths: ['src/file.mjs'] } });
  const bundle = buildSemanticPlanReviewInput({ task: f.task, plan: f.plan });
  f.output.inputHash = f.output.reviewEvidenceHash = bundle.hash;
  f.output.requirementAssessments.push({ requirementId: 'req-static', criterion: 'Статическая декларация', workIds: ['step-one'], checkIds: [],
    verdict: 'pass', reason: 'Декларация', citations: [], planReferences: [{ workId: 'step-one', checkIds: ['check-tests'], creationPaths: [] }] });
  assert.throws(() => validateSemanticPlanReview(bundle.input, f.output), { code: 'PLAN_REVIEW_INVALID' });
});
