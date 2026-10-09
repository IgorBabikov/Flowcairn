import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { inspectCheckProfile, inspectProjectChecks, validateCheckProfile } from './lib/check-profile.mjs';
import { resolveCheckExecutable } from './lib/check-toolchain.mjs';
import { makeRegisteredCheckCommand } from './lib/check-command.mjs';
import { ProjectProfileSchema, trustedLocalChecksHash } from './lib/project.mjs';
import { TaskSpecV3Schema, TaskSpecV2Schema } from './lib/schemas.mjs';
import { compilePlan, validatePlan } from './lib/validator.mjs';
import { hashObject, sha256 } from './lib/io.mjs';
import { SKILL_ROUTES } from './lib/config.mjs';
import { fingerprintDirectWorkspace } from './lib/direct-workspace.mjs';
import { prepareToolchain } from './lib/toolchain.mjs';
import { runRegisteredAction, probeLocalChecks } from './lib/runner.mjs';
import { WorkflowService } from './lib/service.mjs';
import { captureBeforeContents, buildAttemptDiff } from './lib/artifacts.mjs';
import { inspectDirectChanges } from './lib/direct-fingerprint.mjs';
import { createTask } from './lib/task-registration.mjs';

const hash = hashObject('generic-check-fixture');
const skills = [...new Set(Object.values(SKILL_ROUTES).flat())].map((id) => ({ id, path: `skills/${id}/SKILL.md`, hash }));
const checkFor = (executable = process.execPath, argv = ['verify.mjs']) => ({ id: 'verify-project', title: 'Проверить проект', purpose: 'Проверить результат локальным инструментом',
  command: { executable, argv, cwd: '.' }, inputPaths: [], outputPaths: [], timeoutMs: 5000, maxOutputBytes: 64 * 1024 });
const profileFor = (check) => ({ version: 1, requiredCheckIds: [check.id], definitions: [check], environment: [] });

function fixture(t, { check = checkFor(), files = { 'verify.mjs': 'if (1 + 1 !== 2) process.exit(1);\n' } } = {}) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-generic-check-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [file, body] of Object.entries(files)) writeFileSync(path.join(root, file), body);
  const profile = ProjectProfileSchema.parse({ version: 2, workspaceMode: 'direct', integrationBranch: 'main', contextPaths: [], checks: [check.id], checkMode: 'trusted-local',
    checkProfile: profileFor(check), outputPaths: check.outputPaths, manifests: [], ai: { provider: 'codex', model: 'fixture' } });
  writeFileSync(path.join(root, '.flowcairn.json'), JSON.stringify(profile));
  mkdirSync(path.join(root, '.ai-orchestrator', 'graph', 'runner-tickets'), { recursive: true, mode: 0o700 });
  for (const file of ['.ai-orchestrator', '.ai-orchestrator/graph']) chmodSync(path.join(root, file), 0o700);
  writeFileSync(path.join(root, '.ai-orchestrator', 'flowcairn-install.json'), JSON.stringify({ tool: 'flowcairn', owner: `flowcairn-${randomUUID()}`, trustedLocalChecksHash: trustedLocalChecksHash(root, profile) }), { mode: 0o600 });
  const checks = inspectProjectChecks(root, profile);
  const task = TaskSpecV3Schema.parse({ schemaVersion: 3, id: 'GENERIC-CHECK', goal: 'Проверить проект', instructions: 'Выполнить зарегистрированную проверку.',
    scope: Object.keys(files), acceptance: ['Результат проверен.'], checks: [check.id], sourceHash: fingerprintDirectWorkspace(root).hash,
    limits: { maxAttempts: 1, maxReplans: 0, timeoutMs: 5000 } });
  const context = { runtimeHash: hash, skills, checks };
  const plan = compilePlan(task, context).plan;
  const node = plan.nodes.find((node) => node.action.id === `check-${check.id}`);
  const execute = (options = {}) => {
    const outputDirectory = path.join(root, '.ai-orchestrator', 'graph', `output-${randomUUID()}`);
    mkdirSync(outputDirectory, { mode: 0o700 });
    return runRegisteredAction({ root, worktree: root, node, task, plan, skills: [], toolchain: prepareToolchain({ root, worktree: root }), outputDirectory, onStart: () => {}, ...options });
  };
  return { root, profile, checks, task, plan, node, context, execute };
}

test('registered arbitrary IDs compile into a bound V3 plan; unknown actions and changed bindings fail', (t) => {
  const fx = fixture(t);
  assert.equal(fx.plan.schemaVersion, 3);
  assert.equal(fx.plan.executionStages.stages.length, 1);
  assert.equal(TaskSpecV2Schema.safeParse(fx.task).success, false);
  const tampered = structuredClone(fx.plan);
  tampered.nodes.find((node) => node.id === fx.node.id).action.id = 'check-not-registered';
  assert.throws(() => validatePlan(tampered, fx.task, fx.context));
  const changed = structuredClone(fx.checks); changed.bindings[0].executableHash = 'f'.repeat(64);
  assert.throws(() => validatePlan(fx.plan, fx.task, { ...fx.context, checks: changed }), { code: 'CHECK_REGISTRY_DRIFT' });
});

test('public task registration accepts only enabled generic check IDs without the npm whitelist', async (t) => {
  const fx = fixture(t);
  const service = { adapters: { dataVersion: 3, skills: () => [], registerTask: async (_root, task) => task } };
  const input = { id: 'GENERIC-PUBLIC', goal: 'Проверить', instructions: 'Проверить', scope: ['verify.mjs'], acceptance: ['Проверено'], checks: ['verify-project'] };
  const result = await createTask(fx.root, input, { service });
  assert.deepEqual(result.checks, ['verify-project']);
  await assert.rejects(createTask(fx.root, { ...input, checks: ['unregistered-check'] }, { service }), { code: 'CHECK_UNSUPPORTED' });
});

test('registered check names do not collide with reserved graph node names', (t) => {
  for (const id of ['analyze', 'implement', 'review', 'approve-plan', 'workspace-check']) {
    const fx = fixture(t, { check: { ...checkFor(), id } });
    assert.equal(fx.node.id, `check-${id}`);
  }
});

test('disabled registered tools do not require an installed SDK or receive a plan binding', (t) => {
  const fx = fixture(t);
  const profile = { ...profileFor(checkFor()), definitions: [checkFor(), { ...checkFor('missing-optional-tool', []), id: 'optional-check' }] };
  assert.deepEqual(inspectCheckProfile(fx.root, profile).definitions.map((check) => check.id), ['verify-project']);
});

test('shell metacharacters stay argv data and no ambient secret environment is inherited', (t) => {
  const fx = fixture(t, { check: checkFor(process.execPath, ['verify.mjs', '$(touch injected)', '; exit 1']) });
  const prepared = makeRegisteredCheckCommand({ ...fx, worktree: fx.root });
  assert.deepEqual(prepared.command.args, ['verify.mjs', '$(touch injected)', '; exit 1']);
  assert.equal(prepared.command.env.HOME, undefined);
  assert.equal(prepared.command.env.NODE_OPTIONS, undefined);
  assert.equal(existsSync(path.join(fx.root, 'injected')), false);
});

test('static inspection never runs an executable; explicit project-relative executable is hash bound', (t) => {
  const fx = fixture(t);
  const script = path.join(fx.root, 'verify-tool');
  writeFileSync(script, '#!/bin/sh\ntouch should-not-exist\n'); chmodSync(script, 0o755);
  const profile = profileFor(checkFor('./verify-tool', []));
  const first = inspectCheckProfile(fx.root, profile);
  assert.equal(existsSync(path.join(fx.root, 'should-not-exist')), false);
  writeFileSync(script, '#!/bin/sh\nexit 1\n');
  assert.notEqual(inspectCheckProfile(fx.root, profile).bindings[0].executableHash, first.bindings[0].executableHash);
});

test('profile rejects environment injection, overlapping outputs, secret data and missing tools', (t) => {
  const fx = fixture(t), profile = profileFor(checkFor());
  assert.throws(() => validateCheckProfile({ ...profile, environment: [{ name: 'NODE_OPTIONS', value: '--eval=1' }] }), { code: 'CHECK_ENV_UNSAFE' });
  assert.throws(() => validateCheckProfile({ ...profile, environment: [{ name: 'API_KEY', value: 'synthetic-value' }] }), { code: 'CHECK_ENV_UNSAFE' });
  assert.throws(() => validateCheckProfile({ ...profile, definitions: [{ ...profile.definitions[0], inputPaths: ['source.txt'], outputPaths: ['source.txt'] }] }), { code: 'CHECK_OUTPUT_UNSAFE' });
  assert.throws(() => inspectCheckProfile(fx.root, profileFor(checkFor('flowcairn-does-not-exist', []))), { code: 'CHECK_EXECUTABLE_MISSING' });
  assert.throws(() => resolveCheckExecutable(fx.root, 'tool.cmd'), { code: 'CHECK_EXECUTABLE_UNSAFE' });
  assert.throws(() => validateCheckProfile({ ...profile, environment: [{ name: 'VALUE', value: 'Bearer ' + 'a'.repeat(32) }] }), { code: 'CHECK_PROFILE_UNSAFE' });
});

test('declared input, cwd and output links cannot escape the project', (t) => {
  const fx = fixture(t);
  symlinkSync(os.tmpdir(), path.join(fx.root, 'outside'));
  for (const check of [
    { ...checkFor(), inputPaths: ['outside'] },
    { ...checkFor(), command: { ...checkFor().command, cwd: 'outside' } },
    { ...checkFor(), outputPaths: ['outside/result'] },
  ]) assert.throws(() => inspectCheckProfile(fx.root, profileFor(check)), { code: 'CHECK_PATH_UNSAFE' });
});

test('Node check executes through the existing supervisor without package.json', async (t) => {
  const fx = fixture(t);
  assert.equal(probeLocalChecks({ root: fx.root }).available, true);
  assert.equal(existsSync(path.join(fx.root, 'package.json')), false);
  const result = await fx.execute();
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.equal(result.stopped, true); assert.equal(result.uncertain, false);
  assert.equal(result.execution.kind, 'registered-check');
  assert.equal(result.execution.checkRegistryHash, fx.plan.checkRegistryHash);
});

test('known nonzero check remains failed, not unavailable or successful', async (t) => {
  const fx = fixture(t, { files: { 'verify.mjs': 'process.exit(7);\n' } });
  const result = await fx.execute();
  assert.equal(result.exitCode, 7); assert.equal(result.stopped, true); assert.equal(result.uncertain, false);
});

test('changed pinned input after supervisor reservation cannot start the check', async (t) => {
  const fx = fixture(t, { check: { ...checkFor(), inputPaths: ['verify.mjs'] } });
  const result = await fx.execute({ onStart: () => writeFileSync(path.join(fx.root, 'verify.mjs'), 'throw Error("changed");\n') });
  assert.equal(result.failureReason, 'CHECK_REGISTRY_DRIFT');
  assert.equal(result.stopped, true); assert.equal(result.uncertain, false);
});

test('revoked local check registration after reservation prevents GO', async (t) => {
  const fx = fixture(t, { files: { 'verify.mjs': 'process.exit(19);\n' } });
  const result = await fx.execute({ onStart: () => rmSync(path.join(fx.root, '.ai-orchestrator', 'flowcairn-install.json')) });
  assert.equal(result.failureReason, 'CHECK_LOCAL_BINDING_REQUIRED');
  assert.notEqual(result.exitCode, 19);
  assert.equal(result.stopped, true);
});

test('Python project runs its registered interpreter without npm checks', async (t) => {
  let interpreter;
  try { interpreter = resolveCheckExecutable(os.tmpdir(), 'python3').executable; } catch { t.skip('Python не установлен; SDK не устанавливается.'); return; }
  const fx = fixture(t, { check: checkFor(interpreter, ['-B', 'verify.py']), files: { 'verify.py': 'assert sum([1, 2]) == 3\n' } });
  const result = await fx.execute();
  assert.equal(result.exitCode, 0, JSON.stringify(result)); assert.equal(result.stopped, true); assert.equal(result.uncertain, false);
});

test('unknown source language uses its explicit verifier instead of stack detection', async (t) => {
  const fx = fixture(t, { files: { 'program.customlang': 'answer := 42\n',
    'verify.mjs': "import { readFileSync } from 'node:fs';\nif (readFileSync('program.customlang','utf8').trim() !== 'answer := 42') process.exit(1);\n" } });
  const result = await fx.execute();
  assert.equal(result.exitCode, 0, JSON.stringify(result)); assert.equal(result.stopped, true); assert.equal(result.uncertain, false);
});

test('installed C compiler runs a registered syntax check without package.json', async (t) => {
  const compiler = '/Library/Developer/CommandLineTools/usr/bin/clang';
  if (!existsSync(compiler)) { t.skip('Этот C toolchain не установлен; ничего не скачивается.'); return; }
  const fx = fixture(t, { check: checkFor(compiler, ['-fsyntax-only', 'answer.c']), files: { 'answer.c': 'int answer(void) { return 42; }\n' } });
  const result = await fx.execute();
  assert.equal(result.exitCode, 0, JSON.stringify(result)); assert.equal(result.stopped, true); assert.equal(result.uncertain, false);
});

test('V3 service persists an empty-verifier task but denies approval and execution', async (t) => {
  const fx = fixture(t), empty = { version: 1, profileHash: hash, definitions: [], bindings: [] };
  const service = await WorkflowService.open({ root: fx.root, adapters: { dataVersion: 3,
    identity: () => hash, skills: () => skills, checkRegistry: () => empty,
    capture: () => ({ manifest: { sourceHash: hash }, bundlePath: 'fixture-only' }),
    runner: { ai: { available: true }, checks: { available: true } },
  } });
  t.after(() => service.close());
  const snapshot = await service.create({ id: 'EMPTY-CHECK', goal: 'Сохранить задачу', instructions: 'Пока нет проверки.', acceptance: ['Проверить позже'], scope: ['verify.mjs'], checks: [] },
    { runId: 'empty-check', operationId: 'create-empty' });
  assert.equal(snapshot.schemaVersion, 3);
  assert.equal(snapshot.capabilities.approve.allowed, false);
  assert.equal(snapshot.capabilities.run.allowed, false);
  assert.notEqual(snapshot.proof.status, 'PROVEN');
  assert.equal(snapshot.learning.mode, 'after-stage');
});

test('missing bound input preserves V3 history while denying execution', async (t) => {
  const fx = fixture(t, { check: { ...checkFor(), inputPaths: ['verify.mjs'] } });
  const service = await WorkflowService.open({ root: fx.root, adapters: { dataVersion: 3,
    identity: () => hash, skills: () => skills, checkRegistry: () => inspectProjectChecks(fx.root, fx.profile),
    capture: () => ({ manifest: { sourceHash: hash }, bundlePath: 'fixture-only' }),
    runner: { ai: { available: true }, checks: { available: true } },
  } });
  t.after(() => service.close());
  let snapshot = await service.create({ id: 'MISSING-INPUT', goal: 'Проверить', instructions: 'Проверить', acceptance: ['Проверить'], scope: ['verify.mjs'], checks: ['verify-project'] },
    { runId: 'missing-input', operationId: 'create-missing' });
  const nodeCount = snapshot.nodes.length;
  rmSync(path.join(fx.root, 'verify.mjs'));
  snapshot = service.snapshot(snapshot.runId);
  assert.equal(snapshot.schemaVersion, 3); assert.equal(snapshot.nodes.length, nodeCount);
  assert.equal(snapshot.integrity.valid, false); assert.match(snapshot.integrity.reason, /CHECK_REGISTRY_DRIFT/);
  assert.equal(snapshot.capabilities.run.allowed, false);
});

test('explicit V2 build replan creates V3 without changing the historical artifact contract', async (t) => {
  const fx = fixture(t, { check: { ...checkFor(), id: 'build' } });
  const adapters = { identity: () => hash, skills: () => skills,
    capture: () => ({ manifest: { sourceHash: hash }, bundlePath: 'fixture-only' }),
    runner: { ai: { available: true }, checks: { available: true } } };
  let service = await WorkflowService.open({ root: fx.root, adapters });
  t.after(() => service.close());
  let snapshot = await service.create({ id: 'OLD-BUILD', goal: 'Проверить', instructions: 'Проверить', acceptance: ['Проверить'], scope: ['verify.mjs'], checks: ['build'] },
    { runId: 'old-build', operationId: 'create-old', stage: 'execution' });
  const oldPlanHash = snapshot.planHash;
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(service.close(), true);
  service = await WorkflowService.open({ root: fx.root, adapters: { ...adapters, dataVersion: 3, checkRegistry: () => fx.checks } });
  snapshot = await service.command(snapshot.runId, 'replan', { operationId: 'upgrade-build', expectedRevision: snapshot.revision, planHash: oldPlanHash });
  assert.equal(snapshot.schemaVersion, 3, JSON.stringify(snapshot));
  assert.equal(snapshot.integrity.valid, true);
  const plan = service.plan(snapshot.runId);
  assert.deepEqual(plan.nodes.find((node) => node.action.id === 'check-build').success.requiredArtifacts, ['build-report']);
  assert.equal(service.snapshot('old-build').planHash, oldPlanHash);
});

test('V3 planning promotion, approval, real generic check, review and restart preserve PROVEN', async (t) => {
  const assertion = "if (readFileSync('answer.txt', 'utf8').trim() !== '42') process.exit(1);";
  const fx = fixture(t, { files: { 'answer.txt': '0\n', 'verify.mjs': `import { readFileSync } from 'node:fs';\n${assertion}\n` } });
  let actualChecks = 0;
  const fingerprint = () => fingerprintDirectWorkspace(fx.root);
  const adapters = { dataVersion: 3, project: fx.profile,
    identity: () => hash, skills: () => skills, checkRegistry: () => inspectProjectChecks(fx.root, fx.profile), hasReadConsent: () => true,
    capture: () => ({ manifest: { sourceHash: fingerprint().hash }, bundlePath: 'fixture-source' }),
    allocate: ({ task, runId }) => ({ mode: 'direct', worktree: fx.root, taskId: task.id, attemptId: 1, leaseId: 'fixture', sourceHash: fingerprint().hash, runId }),
    replaceBinding: ({ binding, newRunId, sourceHash }) => ({ ...binding, runId: newRunId, sourceHash }), verifyBinding: () => true,
    prepareToolchain: () => prepareToolchain({ root: fx.root, worktree: fx.root }),
    fingerprint, inspectChanges: inspectDirectChanges, captureBefore: captureBeforeContents, diff: buildAttemptDiff,
    applyEdits: (_root, _before, _node, _task, edits) => { for (const edit of edits) writeFileSync(path.join(fx.root, edit.path), edit.content); },
    runner: { ai: { available: true }, checks: { available: true } },
    loadSkills: (ids) => ids.map((name) => ({ name, text: 'fixture', hash, path: `skills/${name}/SKILL.md` })),
    execute: async (input) => {
      if (input.node.action.id.startsWith('check-')) { actualChecks++; return runRegisteredAction(input); }
      input.onStart({ ticket: 'fixture-ai', pid: process.pid });
      const output = { summary: 'Подготовлено', verdict: 'pass', skillsUsed: input.node.skills, findings: [], changedFiles: [], edits: [], plan: [] };
      if (input.node.action.id === 'ai-analyze') output.analysis = { requirements: ['Ответ равен 42'], constraints: [], projectFacts: [{ path: 'answer.txt', fact: 'Ответ сохранен в тексте' }], acceptance: ['Ответ равен 42'], risks: [] };
      if (input.node.action.id === 'ai-plan') {
        output.steps = [{ id: 'answer', title: 'Сохранить ответ', outcome: 'Ответ равен 42', needs: [], paths: ['answer.txt'], readPaths: ['verify.mjs'], requirementIds: ['req-001'] }];
        output.contractProposal = { requirements: [{ id: 'req-001', title: 'Ответ равен 42', mandatory: true, verification: { method: 'check', checkIds: ['check-verify-project'], criterion: 'Ответ равен 42', paths: ['verify.mjs'] } }], optionalImprovements: [], constraints: [], assumptions: [], unknowns: [] };
      }
      if (input.node.action.id === 'ai-implement') { output.changedFiles = ['answer.txt']; output.edits = [{ path: 'answer.txt', previousHash: sha256(readFileSync(path.join(fx.root, 'answer.txt'))), content: '42\n', executable: false }]; }
      if (input.node.action.id === 'ai-review') {
        output.reviewEvidenceHash = hashObject(input.reviewEvidence);
        output.requirementAssessments = [{ requirementId: 'req-001', criterion: 'Ответ равен 42', checkIds: ['check-verify-project'], verdict: 'pass', reason: 'Проверка прочитала фактический ответ.', citations: [{ path: 'verify.mjs', startLine: 2, quote: assertion }] }];
      }
      return { exitCode: 0, stopped: true, uncertain: false, output };
    },
  };
  let service = await WorkflowService.open({ root: fx.root, adapters });
  t.after(() => service.close());
  const request = (s, rest = {}) => ({ operationId: `op-${randomUUID()}`, expectedRevision: s.revision, planHash: s.planHash, ...rest });
  let snapshot = await service.create({ id: 'TASK-GENERIC', goal: 'Ответ равен 42', instructions: 'Ответ равен 42', acceptance: ['Ответ равен 42'], scope: ['answer.txt'], contextPaths: ['verify.mjs'], checks: ['verify-project'] },
    { runId: 'generic-proof', operationId: 'create-generic', stage: 'planning', workflow: 'autonomous' });
  snapshot = await service.command(snapshot.runId, 'run', request(snapshot));
  await Promise.all([...service.drives.values()]);
  snapshot = service.snapshot(snapshot.runId);
  if (snapshot.successorRunId) snapshot = service.snapshot(snapshot.successorRunId);
  else snapshot = await service.command(snapshot.runId, 'replan', request(snapshot));
  assert.equal(snapshot.integrity.valid, true, JSON.stringify(snapshot));
  const gate = snapshot.gates.find((item) => item.type === 'approve-plan');
  assert.ok(gate, JSON.stringify(snapshot));
  await service.command(snapshot.runId, 'gate', request(snapshot, { nodeId: gate.nodeId, decision: 'approve', permissions: gate.requiredPermissions, challenge: gate.challenge }));
  await Promise.all([...service.drives.values()]);
  snapshot = service.snapshot(snapshot.runId);
  assert.equal(snapshot.proof.status, 'PROVEN', JSON.stringify(snapshot));
  assert.equal(actualChecks, 1);
  assert.equal(service.close(), true);
  service = await WorkflowService.open({ root: fx.root, adapters });
  assert.equal(service.snapshot(snapshot.runId).proof.status, 'PROVEN');
});
