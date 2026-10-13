import test from 'node:test';
import assert from 'node:assert/strict';
import { hashObject } from '../scripts/ai-graph/lib/io.mjs';
import { ReceiptSchema } from '../scripts/ai-graph/lib/schemas.mjs';
import { classifyDevelopmentFailure } from '../scripts/ai-graph/lib/development-failure.mjs';
import { AutonomousDriver } from '../scripts/ai-graph/lib/service-driver.mjs';

const hash = hashObject('failure-routing-fixture');
const artifactId = hashObject('current-failure-artifact');

function fixture(actionId = 'check-tests') {
  const definition = { id: 'failed-work', action: { id: actionId, version: 1, inputs: {} } };
  const checkRegistry = { version: 1, profileHash: hash, definitions: [{
    id: 'tests', title: 'Behavior test', purpose: 'Verify behavior',
    command: { executable: process.execPath, argv: ['verify.mjs'], cwd: '.' },
    inputPaths: ['verify.mjs'], outputPaths: ['out'], timeoutMs: 5000, maxOutputBytes: 65536,
  }], bindings: [{ id: 'tests', definitionHash: hash, executableHash: hash,
    invocationHash: hash, inputManifestHash: hash, toolchainHash: hash }] };
  const plan = { workflowPolicy: 'developer-v1', schemaVersion: 3, version: 2, workflow: 'autonomous', stage: 'execution',
    checks: checkRegistry, checkRegistryHash: hashObject(checkRegistry), nodes: [definition],
    autonomy: { maxRepairCycles: 2, maxDurationMs: 60000 } };
  const node = { status: 'failed', receipts: ['failure-receipt'], artifacts: [], reason: null };
  const state = { schemaVersion: 3, runId: 'failure-run', planHash: hash, revision: 7,
    actor: 'operator', status: 'failed', learning: {}, continuation: { kind: 'open' },
    nodes: { [definition.id]: node, 'approve-plan': { status: 'passed', receipts: ['approval-receipt'] } },
    policyGrant: { runId: 'failure-run', planHash: hash, receiptId: 'approval-receipt',
      startedAt: new Date().toISOString(), cycle: 0 } };
  const receipt = ReceiptSchema.parse({ schemaVersion: 2, runId: state.runId, nodeId: definition.id,
    attemptId: 'attempt-1', attempt: 1, phase: 'finished', actionId, actionVersion: 1,
    planVersion: plan.version, planHash: hash, taskHash: hash, sourceHash: hash, runtimeHash: hash,
    instructionsHash: hash, skills: [], permissions: [], grantedPermissions: [],
    termination: { stopped: true, uncertain: false, timedOut: false, outputLimit: false,
      signal: null, ticketHash: hash, execution: { kind: 'registered-check', actionId, checkRegistryHash: plan.checkRegistryHash } },
    startedAt: '2026-10-12T10:00:00.000Z', finishedAt: '2026-10-12T10:00:00.010Z', durationMs: 10,
    exitCode: actionId.startsWith('check-') ? 1 : 0, verdict: 'fail',
    checks: actionId.startsWith('check-') ? [{ id: definition.id, passed: false, exitCode: 1,
      durationMs: 10, summary: 'Действие завершилось с ошибкой', inputHash: hash }] : [],
    artifacts: [], changedFiles: [], failureReason: null,
    beforeFingerprint: hash, afterFingerprint: hash, actor: 'operator', operationId: 'operation-1', previousReceipt: null });
  return { state, plan, definition, node, receipt, semanticReview: false, rejectedImplementation: false };
}

const negativeCases = [
  ['missing command exit 127', 'environment', f => { f.receipt.exitCode = f.receipt.checks[0].exitCode = 127; }],
  ['nonexecutable command exit 126', 'environment', f => { f.receipt.exitCode = f.receipt.checks[0].exitCode = 126; }],
  ['missing SDK', 'environment', f => { f.receipt.failureReason = 'SDK_MISSING: target SDK unavailable'; }],
  ['missing tool', 'environment', f => { f.receipt.failureReason = 'CHECK_EXECUTABLE_MISSING: tool unavailable'; }],
  ['missing verifier', 'verifier', f => { f.receipt.failureReason = 'VERIFIER_MISSING: no registered verifier'; }],
  ['missing plan verifier', 'verifier', f => { f.receipt.failureReason = 'PLAN_VERIFIER_MISSING: check absent'; }],
  ['check registry drift', 'verifier', f => { f.receipt.failureReason = 'CHECK_REGISTRY_DRIFT'; }],
  ['unregistered check', 'verifier', f => { f.plan.checks.definitions = []; f.plan.checkRegistryHash = hashObject(f.plan.checks); }],
  ['missing executable binding', 'verifier', f => { f.plan.checks.bindings = []; f.plan.checkRegistryHash = hashObject(f.plan.checks); }],
  ['receipt from another plan', 'verifier', f => { f.receipt.planHash = hashObject('different-plan'); }],
  ['receipt from another node', 'verifier', f => { f.receipt.nodeId = 'other-work'; }],
  ['receipt from another action', 'verifier', f => { f.receipt.actionId = 'check-build'; }],
  ['unfinished receipt', 'process', f => { f.receipt.phase = 'started'; f.receipt.finishedAt = null; }],
  ['missing termination', 'process', f => { f.receipt.termination = null; }],
  ['uncertain stop', 'process', f => { f.receipt.termination.uncertain = true; }],
  ['unconfirmed stop', 'process', f => { f.receipt.termination.stopped = false; }],
  ['timeout despite stopped child', 'process', f => { f.receipt.termination.timedOut = true; }],
  ['timeout reason despite exit 1', 'process', f => { f.receipt.failureReason = 'TIMEOUT'; }],
  ['truncated output', 'process', f => { f.receipt.termination.outputLimit = true; }],
  ['signal termination', 'process', f => { f.receipt.termination.signal = 'SIGTERM'; }],
  ['no exit despite confirmed stop', 'process', f => { f.receipt.exitCode = null; }],
  ['null check exit', 'verifier', f => { f.receipt.checks[0].exitCode = null; }],
  ['contradictory passed check', 'verifier', f => { f.receipt.checks[0].passed = true; }],
  ['contradictory successful check', 'verifier', f => { f.receipt.checks[0].exitCode = 0; }],
  ['missing check result', 'verifier', f => { f.receipt.checks = []; }],
  ['different check input', 'verifier', f => { f.receipt.checks[0].inputHash = hashObject('different-source'); }],
  ['check changed source', 'verifier', f => { f.receipt.afterFingerprint = hashObject('changed-source'); }],
  ['plan coverage defect', 'plan', f => { f.receipt.failureReason = 'PLAN_REQUIREMENT_COVERAGE: work is absent'; }],
  ['plan interface defect', 'plan', f => { f.receipt.failureReason = 'PLAN_INTERFACE_MISMATCH: incompatible interface'; }],
  ['generic exit 1', 'unknown', () => {}],
  ['counterfeit assertion summary', 'unknown', f => { f.receipt.checks[0].summary = 'AssertionError: expected false to equal true'; }],
  ['assertion-like failure reason', 'unknown', f => { f.receipt.failureReason = 'ASSERTION_FAILED: expected false'; }],
  ['receipt passed while node failed', 'unknown', f => { f.receipt.verdict = 'pass'; }],
];

for (const [name, category, change] of negativeCases) test(`failed check routes ${name} without source repair`, async () => {
  const f = fixture(); change(f);
  const before = structuredClone(f);
  ReceiptSchema.parse(f.receipt);
  const result = classifyDevelopmentFailure(f);
  assert.equal(result.category, category);
  assert.notEqual(result.route, 'source-repair');
  assert.deepEqual(f, before, 'classification cannot mutate evidence/status or mark PASS');
  const driven = await drive(f);
  assert.deepEqual(driven.replans, [], 'driver must not allocate a repair successor');
  assert.deepEqual(driven.writes, [], 'driver must not grant rights or upgrade the failed status');
  assert.equal(f.node.status, 'failed');
});

test('missing and malformed receipts stay process uncertainty', () => {
  for (const receipt of [null, undefined, {}, { ...fixture().receipt, exitCode: undefined }]) {
    const result = classifyDevelopmentFailure({ ...fixture(), receipt });
    assert.equal(result.category, 'process');
    assert.equal(result.route, 'recovery');
  }
});

test('actual uncertain node and receipt cannot become a source repair or PASS', () => {
  const f = fixture('ai-review');
  f.node.status = 'uncertain'; f.receipt.verdict = 'uncertain';
  f.receipt.exitCode = null; f.receipt.termination.uncertain = true;
  ReceiptSchema.parse(f.receipt);
  const result = classifyDevelopmentFailure({ ...f, semanticReview: true });
  assert.equal(result.category, 'process');
  assert.equal(result.route, 'recovery');
  assert.equal(f.receipt.verdict, 'uncertain');
  assert.equal(f.node.status, 'uncertain');
});

test('completed semantic uncertainty cannot upgrade failed assertions or receipt verdict', () => {
  const f = fixture('ai-review');
  f.node.status = 'uncertain'; f.receipt.verdict = 'uncertain';
  const result = classifyDevelopmentFailure({ ...f, semanticReview: true });
  assert.equal(result.category, 'unknown');
  assert.equal(result.route, 'diagnostic');
  assert.equal(f.receipt.verdict, 'uncertain');
});

function reviewFailure(f) {
  f.receipt.reviewEvidenceHash = hash;
  f.receipt.artifacts = [artifactId]; f.node.artifacts = [artifactId];
  return { kind: 'review-findings', content: JSON.stringify({ summary: 'Behavior is wrong', verdict: 'fail',
    skillsUsed: [], findings: [{ severity: 'blocking', path: 'src/value.mjs', message: 'Expected behavior is missing' }],
    changedFiles: [], edits: [], plan: [], reviewEvidenceHash: hash }) };
}

function implementationRejection(f) {
  f.receipt.artifacts = [artifactId]; f.node.artifacts = [artifactId];
  return { kind: 'review-findings', content: JSON.stringify({ summary: 'Proposal rejected', verdict: 'fail',
    findings: [{ severity: 'blocking', path: 'src/value.mjs', message: 'Proposal does not meet the criterion' }] }) };
}

async function drive(f, artifact = null) {
  const replans = [], writes = [], activations = [];
  const host = {
    listRunIds: () => [f.state.runId], readRun: () => f.state,
    read: () => ({ state: f.state, plan: f.plan, task: {} }),
    readReceipt: () => f.receipt, artifact: () => artifact,
    capabilities: () => ({ run: { run: { allowed: false }, requestReplan: { allowed: false } } }),
    executionDeadline: () => null, discoverPlanningContext: async () => null,
    write: (_state, patch) => writes.push(patch),
    activatePolicyGrant: runId => { activations.push(runId); return false; },
    replan: async input => { replans.push(input); f.state.stopRequested = true; return { runId: 'repair-successor' }; },
  };
  const driver = new AutonomousDriver(host);
  driver.schedule(f.state.runId); await driver.pending.get(f.state.runId);
  return { replans, writes, activations };
}

test('source-bound blocking semantic review keeps existing bounded authorized repair', async () => {
  const f = fixture('ai-review'), artifact = reviewFailure(f);
  const driven = await drive(f, artifact);
  assert.equal(driven.replans.length, 1);
  assert.equal(driven.replans[0].policyGrant.cycle, 1);
  assert.equal(driven.replans[0].policyGrant.startedAt, f.state.policyGrant.startedAt);
  assert.deepEqual(driven.writes, []);
  assert.deepEqual(driven.activations, ['repair-successor']);
});

test('unchanged-source implementation rejection keeps bounded repair before a write', async () => {
  const f = fixture('ai-implement');
  const driven = await drive(f, implementationRejection(f));
  assert.equal(driven.replans.length, 1);
  assert.equal(driven.replans[0].policyGrant.cycle, 1);
  assert.equal(f.receipt.changedFiles.length, 0);
});

test('known broker proposal rejection keeps repair without broadening permissions', async () => {
  const f = fixture('ai-implement'); f.receipt.failureReason = 'AI_SCOPE: rejected proposal path';
  const driven = await drive(f);
  assert.equal(driven.replans.length, 1);
  assert.deepEqual(f.receipt.grantedPermissions, []);
});

for (const cause of ['missing report', 'old report', 'wrong evidence hash', 'missing exit', 'timeout', 'failed process', 'budget exhausted'])
  test(`semantic review ${cause} cannot trigger source repair`, async () => {
    const f = fixture('ai-review'); let artifact = reviewFailure(f);
    if (cause === 'missing report') { f.node.artifacts = []; f.receipt.artifacts = []; artifact = null; }
    if (cause === 'old report') f.receipt.artifacts = [];
    if (cause === 'wrong evidence hash') f.receipt.reviewEvidenceHash = hashObject('other-evidence');
    if (cause === 'missing exit') f.receipt.exitCode = null;
    if (cause === 'timeout') f.receipt.termination.timedOut = true;
    if (cause === 'failed process') f.receipt.exitCode = 1;
    if (cause === 'budget exhausted') f.state.policyGrant.cycle = f.plan.autonomy.maxRepairCycles;
    assert.deepEqual((await drive(f, artifact)).replans, []);
  });

for (const reason of ['PATCH_HANDLER_MISSING', 'PLAN_INTERFACE_MISMATCH', 'INTERNAL_ERROR_TYPE', 'UNRECOGNIZED_FAILURE'])
  test(`implementation ${reason} cannot be guessed to be a source defect`, async () => {
    const f = fixture('ai-implement'); f.receipt.failureReason = `${reason}: unavailable or unknown outcome`;
    assert.notEqual(classifyDevelopmentFailure(f).route, 'source-repair');
    assert.deepEqual((await drive(f)).replans, []);
  });

test('multiple failed nodes do not allocate a guessed repair successor', async () => {
  const f = fixture('ai-review'), artifact = reviewFailure(f);
  f.plan.nodes.push({ id: 'other-failed', action: { id: 'check-build', version: 1 } });
  f.state.nodes['other-failed'] = { status: 'failed' };
  assert.deepEqual((await drive(f, artifact)).replans, []);
});

function scenarioFailure(format = 'playwright-json', reasonCodes = ['REPORT_UNEXPECTED_OUTCOME', 'REPORT_REQUIRED_SCENARIO_NOT_PASSED']) {
  const f = fixture(); f.plan.runtimeHash = hash;
  const registered = f.plan.checks.definitions[0];
  registered.report = { version: 1, format, path: 'out/result.json', requiredScenarios: ['actual scenario'] };
  f.plan.checks.bindings[0].definitionHash = hashObject(registered);
  f.plan.checkRegistryHash = hashObject(f.plan.checks);
  f.receipt.termination.execution.checkRegistryHash = f.plan.checkRegistryHash;
  f.receipt.checks[0].verification = {
    version: 1, format, status: 'failed', counts: { total: 1, completed: 1, passed: 0, failed: 1, skipped: 0 },
    countsConfirmed: true, assertionFailures: 0, scenarioIds: [hash], reasonCodes,
    reportHash: hash, specHash: hashObject(registered.report), inputHash: hash,
    adapterHash: hashObject({ runtimeHash: hash, format }), checkRegistryHash: f.plan.checkRegistryHash,
    definitionHash: f.plan.checks.bindings[0].definitionHash, toolchainHash: hash,
    ...(format === 'flowcairn-xctest/v1' ? { artifactHash: hash, environmentHash: hash } : {}),
  };
  f.receipt = ReceiptSchema.parse(f.receipt);
  return f;
}

test('verified browser/native scenario failure requests bounded diagnosis without claiming an implementation cause', async () => {
  for (const format of ['playwright-json', 'flowcairn-xctest/v1']) {
    const f = scenarioFailure(format);
    const result = classifyDevelopmentFailure(f);
    assert.equal(result.category, 'verification');
    assert.equal(result.route, 'diagnosis-repair');
    assert.equal((await drive(f)).replans.length, 1);
  }
});

test('run errors, missing native identity or changed report binding never allocate scenario source repair', async () => {
  const runError = scenarioFailure('playwright-json', ['REPORT_RUN_ERRORS']);
  assert.equal((await drive(runError)).replans.length, 0);
  const noArtifact = scenarioFailure('flowcairn-xctest/v1'); delete noArtifact.receipt.checks[0].verification.artifactHash;
  assert.equal((await drive(noArtifact)).replans.length, 0);
  const drift = scenarioFailure(); drift.receipt.checks[0].verification.specHash = hashObject('not-the-approved-report');
  assert.equal((await drive(drift)).replans.length, 0);
});
