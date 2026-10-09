import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspectProjectChecks } from '../scripts/ai-graph/lib/check-profile.mjs';
import { SKILL_ROUTES } from '../scripts/ai-graph/lib/config.mjs';
import { fingerprintDirectWorkspace } from '../scripts/ai-graph/lib/direct-workspace.mjs';
import { hashObject } from '../scripts/ai-graph/lib/io.mjs';
import { ProjectProfileSchema, trustedLocalChecksHash } from '../scripts/ai-graph/lib/project.mjs';
import { runRegisteredAction } from '../scripts/ai-graph/lib/runner.mjs';
import { TaskSpecV3Schema } from '../scripts/ai-graph/lib/schemas.mjs';
import { WorkflowService } from '../scripts/ai-graph/lib/service.mjs';
import { prepareToolchain } from '../scripts/ai-graph/lib/toolchain.mjs';
import { compilePlan } from '../scripts/ai-graph/lib/validator.mjs';

const identity = hashObject('independent-rpg-g1a-acceptance');
const skills = [...new Set(Object.values(SKILL_ROUTES).flat())].map(id => ({ id, path: `skills/${id}/SKILL.md`, hash: identity }));

function tempProject(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-qa-g1a-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, '.ai-orchestrator/graph/runner-tickets'), { recursive: true, mode: 0o700 });
  for (const name of ['.ai-orchestrator', '.ai-orchestrator/graph']) chmodSync(path.join(root, name), 0o700);
  writeFileSync(path.join(root, 'source.txt'), 'source\n');
  return root;
}

function register(root, profile) {
  writeFileSync(path.join(root, '.flowcairn.json'), JSON.stringify(profile));
  writeFileSync(path.join(root, '.ai-orchestrator/flowcairn-install.json'), JSON.stringify({
    tool: 'flowcairn', owner: `flowcairn-${randomUUID()}`, trustedLocalChecksHash: trustedLocalChecksHash(root, profile),
  }), { mode: 0o600 });
}

function planFor(root, profile) {
  const checks = inspectProjectChecks(root, profile);
  const task = TaskSpecV3Schema.parse({ schemaVersion: 3, id: 'QA-G1A', goal: 'Проверить фактическую команду',
    instructions: 'Проверить только source.txt', scope: ['source.txt'], acceptance: ['Проверка завершена'],
    checks: profile.checks, sourceHash: fingerprintDirectWorkspace(root, { outputPaths: profile.outputPaths }).hash,
    limits: { maxAttempts: 1, maxReplans: 0, timeoutMs: 5000 } });
  const plan = compilePlan(task, { runtimeHash: identity, skills, checks }).plan;
  return { task, plan, node: plan.nodes.find(node => node.action.id === `check-${profile.checks[0]}`) };
}

async function runCheck(root, worktree, input, onStart) {
  const outputDirectory = path.join(root, '.ai-orchestrator/graph', `qa-output-${randomUUID()}`);
  mkdirSync(outputDirectory, { mode: 0o700 });
  return runRegisteredAction({ root, worktree, ...input, skills: [], outputDirectory,
    toolchain: prepareToolchain({ root, worktree }), onStart });
}

test('V3 legacy-worktree check refuses a package script changed after reservation', async t => {
  const root = tempProject(t);
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, stdio: 'pipe' });
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'QA fixture'); git('config', 'user.email', 'qa@example.invalid');
  const pkg = { name: 'qa-worktree', version: '1.0.0', scripts: { test: 'node -e "process.exit(7)"' } };
  writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
  writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}');
  writeFileSync(path.join(root, '.gitignore'), '.ai-orchestrator/\nout/\n');
  const profile = ProjectProfileSchema.parse({ version: 1, integrationBranch: 'main', workspaceMode: 'worktree',
    packageManager: 'npm', contextPaths: [], checks: ['tests'], checkMode: 'trusted-local', checkScripts: { tests: 'test' },
    outputPaths: ['out'], manifests: ['package.json', 'package-lock.json'], ai: { provider: 'codex', model: 'fixture' } });
  register(root, profile);
  git('add', 'source.txt', 'package.json', 'package-lock.json', '.gitignore', '.flowcairn.json');
  git('commit', '-m', 'disposable QA fixture');
  const worktrees = path.join(root, '.ai-orchestrator/worktrees');
  mkdirSync(worktrees, { mode: 0o700 });
  const worktree = path.join(worktrees, 'qa-worktree');
  git('worktree', 'add', '--detach', worktree, 'HEAD');
  mkdirSync(path.join(worktree, 'out'));
  const input = planFor(root, profile);
  const result = await runCheck(root, worktree, input, () => {
    pkg.scripts.test = 'node -e "require(\'node:fs\').writeFileSync(\'out/unapproved-command\', \'ran\')"';
    writeFileSync(path.join(worktree, 'package.json'), JSON.stringify(pkg));
  });
  const unexpectedEffect = existsSync(path.join(worktree, 'out/unapproved-command'));
  t.diagnostic(JSON.stringify({ scenario: 'worktree script drift before GO', exitCode: result.exitCode,
    failureReason: result.failureReason ?? null, stopped: result.stopped, uncertain: result.uncertain, unexpectedEffect }));
  assert.equal(unexpectedEffect, false, 'The runner executed package.json bytes not covered by its root registry binding');
  assert.equal(result.failureReason, 'CHECK_REGISTRY_DRIFT');
});

test('renewed local registration cannot authorize changed argv in an already reserved V3 plan', async t => {
  const root = tempProject(t);
  writeFileSync(path.join(root, 'verify.mjs'), "throw new Error('must not start');\n");
  const definition = { id: 'verify-result', title: 'Проверка', purpose: 'Проверить исходник',
    command: { executable: process.execPath, argv: ['verify.mjs'], cwd: '.' }, inputPaths: ['verify.mjs'], outputPaths: [],
    timeoutMs: 5000, maxOutputBytes: 65536 };
  const profile = ProjectProfileSchema.parse({ version: 2, integrationBranch: 'main', workspaceMode: 'direct', contextPaths: [],
    checks: [definition.id], checkMode: 'trusted-local', checkProfile: { version: 1, requiredCheckIds: [definition.id], definitions: [definition], environment: [] },
    outputPaths: [], manifests: [], ai: { provider: 'codex', model: 'fixture' } });
  register(root, profile);
  const input = planFor(root, profile);
  const result = await runCheck(root, root, input, () => {
    const changed = structuredClone(profile);
    changed.checkProfile.definitions[0].command.argv = ['-e', 'process.exit(0)'];
    register(root, changed);
  });
  assert.equal(result.failureReason, 'CHECK_REGISTRY_DRIFT');
  assert.equal(result.stopped, true);
  assert.equal(result.uncertain, false);
  assert.notEqual(result.exitCode, 0);
});

test('an empty-verifier V3 task rejects direct approval/run commands and remains readable', async t => {
  const root = tempProject(t);
  let executions = 0;
  const service = await WorkflowService.open({ root, adapters: { dataVersion: 3,
    identity: () => identity, skills: () => skills,
    checkRegistry: () => ({ version: 1, profileHash: identity, definitions: [], bindings: [] }),
    capture: () => ({ manifest: { sourceHash: identity }, bundlePath: 'qa-synthetic-source' }),
    runner: { ai: { available: true }, checks: { available: true } },
    execute: async () => { executions += 1; throw Error('No verifier must never execute'); },
  } });
  t.after(() => service.close());
  const snapshot = await service.create({ id: 'QA-EMPTY', goal: 'Не принимать без verifier', instructions: 'Проверить исходник',
    scope: ['source.txt'], acceptance: ['Есть проверка'], checks: [] }, { runId: 'qa-empty', operationId: 'qa-create' });
  const before = hashObject(service.store.readRun(snapshot.runId));
  const request = { expectedRevision: snapshot.revision, planHash: snapshot.planHash };
  const gate = snapshot.gates.find(item => item.type === 'approve-plan');
  await assert.rejects(service.command(snapshot.runId, 'gate', { ...request, operationId: 'qa-approve', nodeId: gate.nodeId,
    decision: 'approve', permissions: gate.requiredPermissions, challenge: gate.challenge }), { code: 'CONTROL_DENIED' });
  await assert.rejects(service.command(snapshot.runId, 'run', { ...request, operationId: 'qa-run' }), { code: 'CONTROL_DENIED' });
  const after = service.snapshot(snapshot.runId);
  assert.equal(after.schemaVersion, 3);
  assert.equal(after.integrity.valid, true);
  assert.ok(after.nodes.length > 0);
  assert.notEqual(after.proof.status, 'PROVEN');
  assert.equal(hashObject(service.store.readRun(snapshot.runId)), before);
  assert.equal(executions, 0);
  assert.equal(service.plan(snapshot.runId).schemaVersion, 3);
  assert.equal(readFileSync(path.join(root, 'source.txt'), 'utf8'), 'source\n');
});
