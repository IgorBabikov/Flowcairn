import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { TaskSpecSchema } from '../scripts/ai-graph/lib/schemas.mjs';
import { validatePlan } from '../scripts/ai-graph/lib/validator.mjs';
import { compilePlanningPlan, compileTaskProposal } from '../scripts/ai-graph/lib/planning.mjs';
import { projectSemanticCorrectionFeedback, validateSemanticCorrectionFeedback, buildSemanticCorrectionInput,
  validateSemanticCorrectionInput, MAX_SEMANTIC_CORRECTION_BYTES } from '../scripts/ai-graph/lib/semantic-correction-feedback.mjs';
import { hashObject, sha256 } from '../scripts/ai-graph/lib/io.mjs';
import { SKILL_ROUTES } from '../scripts/ai-graph/lib/config.mjs';
import { RUNNER_TESTING, runRegisteredAction } from '../scripts/ai-graph/lib/runner.mjs';
import { taskContractForNode, boundPriorEvidence } from '../scripts/ai-graph/lib/bounded-context.mjs';

const H = 'a'.repeat(64), skillText = 'fixture instructions';
const skills = [...new Set(Object.values(SKILL_ROUTES).flat())].map(id => ({ id, path: `skills/${id}/SKILL.md`, hash: sha256(skillText) }));
function context(workflowPolicy) { return { runtimeHash: H, skills, workflow: 'autonomous', workflowPolicy }; }
function task() { return TaskSpecSchema.parse({ schemaVersion: 2, id: 'MOBILE-RETRY', goal: 'Native control', instructions: 'No retries of scenario checks.',
  scope: ['src'], contextPaths: [], acceptance: ['Native scenario preserves original behavior.'], checks: ['tests'], sourceHash: H }); }
const proposal = { summary: 'План', verdict: 'pass', skillsUsed: [], findings: [], changedFiles: [], edits: [], plan: [],
  steps: [{ id: 'native', title: 'Native behavior', outcome: 'Native behavior', needs: [], paths: ['src'], requirementIds: ['req-001'] }] };
function review() {
  const citation = { path: 'src/test.mjs', startLine: 1, quote: 'observable assertion' };
  return { summary: 'Retry policy blocked', verdict: 'fail', skillsUsed: [], changedFiles: [], edits: [], moves: [], jsonTransfers: [], plan: [],
    findings: [{ severity: 'blocking', message: 'Retry maxAttempts=2 violates retries=0.', path: 'src/test.mjs' }],
    inputHash: H, reviewEvidenceHash: H,
    dimensions: Object.fromEntries(['verifier','source','interfaces','unknowns','capabilities'].map(key => [key,
      { status: key === 'verifier' ? 'fail' : 'pass', reason: 'original policy' }])),
    requirementAssessments: [{ requirementId: 'req-001', criterion: 'Original exact criterion', workIds: ['step-native'], checkIds: ['check-tests'],
      verdict: 'pass', citations: [citation], planReferences: [], reason: 'Original exact criterion stays mandatory' }],
    unknownAssessments: [{ unknown: 'original risk', disposition: 'nonblocking-risk', reason: 'Addressed in original plan', citations: [citation], planReferences: [] }] };
}
const artifact = value => ({ kind: 'analysis', mediaType: 'application/json', content: JSON.stringify(value) });
function feedback(value = review()) { return projectSemanticCorrectionFeedback({ artifactId: H, receiptId: H, artifact: artifact(value), sourceRunId: 'source-run', sourcePlanHash: H, sourceTaskHash: H }); }
const reference = bundle => ({ role: 'semantic-correction-input', hash: bundle.hash, bytes: bundle.bytes, artifactIds: bundle.input.feedback.map(item => item.artifactId) });

test('only current developer-v2 check nodes compile to one attempt; V1/markerless/historical retain old bounds', () => {
  const original = task();
  for (const policy of [undefined, 'developer-v1', 'developer-v2']) {
    const compiled = compileTaskProposal(original, proposal, context(policy)).plan;
    const check = compiled.nodes.find(n => n.action.id === 'check-tests');
    assert.equal(check.retry.maxAttempts, policy === 'developer-v2' ? 1 : 2);
    const changed = structuredClone(compiled); changed.nodes.find(n => n.action.id === 'check-tests').retry.maxAttempts = 2;
    if (policy === 'developer-v2') assert.throws(() => validatePlan(changed, original, context(policy)), { code: 'UNSAFE_RETRY_POLICY' });
    else validatePlan(changed, original, context(policy));
    const before = hashObject(changed);
    validatePlan(changed, original, { mode: 'historical' });
    assert.equal(hashObject(changed), before, 'historical bytes cannot be normalized');
    assert.equal(compiled.nodes.find(n => n.action.id === 'workspace-check').retry.maxAttempts, 2);
  }
});

test('fresh repaired compilation retains one check per source revision, never same-node retry', () => {
  const original = task(), prior = compileTaskProposal(original, proposal, context('developer-v2')).plan;
  const nextTask = { ...original, sourceHash: 'b'.repeat(64) };
  const successor = compileTaskProposal(nextTask, proposal, { ...context('developer-v2'), version: 2,
    parentPlanHash: hashObject(prior), taskContract: prior.taskContract, repairReadPaths: { native: ['src'] } }).plan;
  assert.notEqual(hashObject(prior), hashObject(successor)); assert.equal(successor.sourceHash, nextTask.sourceHash);
  assert.equal(successor.nodes.find(n => n.action.id === 'check-tests').retry.maxAttempts, 1);
  assert.deepEqual(successor.taskContract.requirements, prior.taskContract.requirements);
  assert.deepEqual(successor.nodes.find(n => n.action.id === 'ai-implement').permissions, prior.nodes.find(n => n.action.id === 'ai-implement').permissions);
});

test('semantic projection keeps real corrective data and immutable refs without copying successful review bodies', () => {
  const value = review(), result = feedback(value);
  assert.deepEqual(result.findings, value.findings); assert.deepEqual(result.dimensions, { verifier: value.dimensions.verifier });
  assert.deepEqual(result.requirementAssessments, []); assert.deepEqual(result.unknownAssessments, []);
  assert.equal(result.artifactValueHash, hashObject(value)); assert.equal(result.artifactId, H);
  const bad = structuredClone(result); bad.findings[0].message = 'new invented finding';
  assert.throws(() => validateSemanticCorrectionFeedback(bad, { readArtifact: () => artifact(value) }), { code: 'PLAN_REVIEW_FEEDBACK_INVALID' });
  for (const data of [{ role: 'plan-review-output-digest' }, { role: 'plan-citation-resolution' }, { verdict: 'fail' }])
    assert.throws(() => feedback(data), { code: 'PLAN_REVIEW_FEEDBACK_INVALID' });
});

function largeFeedback() {
  const value = review(); value.requirementAssessments[0].verdict = 'uncertain';
  value.requirementAssessments[0].citations = Array.from({ length: 20 }, () => ({ path: 'src/test.mjs', startLine: 1, quote: 'q'.repeat(3500) }));
  value.unknownAssessments[0].unknown = 'material-original-unknown'.repeat(40);
  value.unknownAssessments[0].disposition = 'unresolved-material';
  value.unknownAssessments[0].citations = structuredClone(value.requirementAssessments[0].citations);
  return feedback(value);
}
function planningInput() {
  const original = task(), plan = compilePlanningPlan(original, context('developer-v2')).plan;
  const node = plan.nodes.find(n => n.action.id === 'ai-plan');
  const bundle = buildSemanticCorrectionInput({ task: original, plan, feedback: [largeFeedback()] });
  const priorEvidence = { semanticCorrectionReference: reference(bundle), reviewFindings: [] };
  return { task: original, plan, node, bundle, priorEvidence };
}

test('full mandatory feedback above 24KiB stays lossless in an exact hash-bound role-specific input', () => {
  const c = planningInput(); assert.ok(c.bundle.bytes > 24 * 1024); assert.ok(c.bundle.bytes < MAX_SEMANTIC_CORRECTION_BYTES);
  validateSemanticCorrectionInput(c.bundle.input, c);
  assert.equal(c.bundle.input.feedback[0].requirementAssessments[0].citations.length, 20);
  assert.equal(c.bundle.input.feedback[0].unknownAssessments[0].citations.length, 20);
  assert.equal(c.bundle.input.feedback[0].requirementAssessments[0].criterion, 'Original exact criterion');
  assert.deepEqual(c.bundle.input.taskContract, c.plan.taskContract);
  const changes = [v => { v.role = 'review-evidence'; }, v => { v.planHash = 'b'.repeat(64); },
    v => { v.taskHash = 'b'.repeat(64); }, v => { v.taskContract.unknowns.push('forged risk'); },
    v => { v.feedback[0].findings[0].message = 'forged finding'; }];
  for (const change of changes) {
    const bad = structuredClone(c.bundle.input); change(bad);
    assert.throws(() => validateSemanticCorrectionInput(bad, c), { code: 'PLAN_REVIEW_FEEDBACK_INVALID' });
  }
  const stale = { ...c, priorEvidence: { semanticCorrectionReference: { ...reference(c.bundle), hash: 'b'.repeat(64) } } };
  assert.throws(() => validateSemanticCorrectionInput(c.bundle.input, stale), { code: 'PLAN_REVIEW_FEEDBACK_INVALID' });
  const wrongRole = { ...c, priorEvidence: { semanticCorrectionReference: { ...reference(c.bundle), role: 'final-review' } } };
  assert.throws(() => validateSemanticCorrectionInput(c.bundle.input, wrongRole), { code: 'PLAN_REVIEW_FEEDBACK_INVALID' });
});

test('existing private-file transport exposes one readonly full file, compact prompt and unchanged project bytes', t => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'flowcairn-correction-file-')));
  t.after(() => rmSync(root, { recursive: true, force: true })); mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src/test.mjs'), 'unchanged source'); const before = readFileSync(path.join(root, 'src/test.mjs'));
  const c = planningInput();
  const prepared = RUNNER_TESTING.makeAiCommand({ ...c, worktree: root, root, skills: [], reviewBundle: c.bundle,
    outputPath: root, toolchain: { node: realpathSync(process.execPath), codexEntry: '/trusted/test-codex.js', digest: H },
    dependencyToolchain: { dependencyPaths: [], hash: H }, profile: { workspaceMode: 'direct', outputPaths: [], ai: { provider: 'codex', model: 'fixture-model' } } });
  try {
    const read = readFileSync(prepared.reviewFile.path, 'utf8');
    assert.equal(read, c.bundle.content); assert.equal(sha256(read), c.bundle.hash);
    assert.equal(JSON.parse(read).feedback[0].unknownAssessments[0].citations.length, 20);
    assert.ok(Buffer.byteLength(prepared.input) < 128 * 1024); assert.equal(prepared.input.includes('q'.repeat(3500)), false);
    assert.ok(prepared.input.includes('dedicated semantic-correction-input')); assert.ok(prepared.input.includes('целиком до EOF'));
    const filesystem = prepared.command.args.find(arg => arg.startsWith('permissions.graph-ai-plan.filesystem='));
    assert.ok(filesystem.includes(JSON.stringify(prepared.reviewFile.path)));
    assert.equal(filesystem.includes(`${JSON.stringify(path.dirname(prepared.reviewFile.path))}="read"`), false);
  } finally { RUNNER_TESTING.cleanupPrepared(prepared); }
  assert.equal(existsSync(prepared.reviewFile.path), false); assert.deepEqual(readFileSync(path.join(root, 'src/test.mjs')), before);
});

test('public runner rejects stale correction hash before toolchain, storage or process allocation', async () => {
  const c = planningInput(); c.priorEvidence.semanticCorrectionReference.hash = 'b'.repeat(64);
  await assert.rejects(runRegisteredAction({ root: '/missing-closed-root', worktree: '/missing-closed-root', ...c,
    reviewEvidence: c.bundle.input, onStart: () => assert.fail('no process may start'),
    skills: c.node.skills.map(name => ({ name, path: `skills/${name}/SKILL.md`, hash: sha256(skillText), text: skillText })) }),
  { code: 'PLAN_REVIEW_FEEDBACK_INVALID' });
});

test('overbounded mandatory feedback fails closed without truncation or budget enlargement', () => {
  const c = planningInput();
  assert.throws(() => buildSemanticCorrectionInput({ task: c.task, plan: c.plan,
    feedback: Array.from({ length: 4 }, () => largeFeedback()) }), { code: 'FIX_EVIDENCE_LIMIT' });
});

test('canonical locked developer-v2 planning contract wins over fresh analysis in prompt and context selection', () => {
  const c = planningInput(), original = { ...c.plan.taskContract, constraints: ['Retries forbidden'], unknowns: ['Original material risk'] };
  const plan = { ...c.plan, planningContractLocked: true, taskContract: original };
  const priorEvidence = { analysis: { result: { analysis: { requirements: ['New unrelated requirement'], acceptance: [],
    constraints: [], projectFacts: [], risks: [] } } }, reviewFindings: [], artifacts: [], receipts: [], workspaceFiles: [] };
  assert.deepEqual(taskContractForNode(c.task, plan, c.node, priorEvidence), original);
  const bounded = boundPriorEvidence({ task: c.task, plan, node: c.node,
    state: { nodes: Object.fromEntries(plan.nodes.map(n => [n.id, { artifacts: [], receipts: [] }])), planningArtifacts: [] }, priorEvidence });
  assert.deepEqual(bounded.contextSelection.requirementIds, original.requirements.map(r => r.id));
  assert.notDeepEqual(taskContractForNode(c.task, { ...plan, workflowPolicy: 'developer-v1' }, c.node, priorEvidence), original);
});
