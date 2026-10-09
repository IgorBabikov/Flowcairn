import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCheckExecutable } from './lib/check-toolchain.mjs';
import { inspectProjectChecks } from './lib/check-profile.mjs';
import { makeRegisteredCheckCommand } from './lib/check-command.mjs';
import { ProjectProfileSchema, trustedLocalChecksHash } from './lib/project.mjs';
import { fingerprintDirectWorkspace } from './lib/direct-workspace.mjs';
import { fingerprintWorkspace } from './lib/workspace.mjs';
import { inspectProjectSource } from './lib/project-source-access.mjs';
import { gitExecutable } from './lib/host-executables.mjs';
import { SKILL_ROUTES } from './lib/config.mjs';
import { hashObject } from './lib/io.mjs';
import { TaskSpecV3Schema } from './lib/schemas.mjs';
import { compilePlan } from './lib/validator.mjs';
import { prepareToolchain } from './lib/toolchain.mjs';
import { runRegisteredAction } from './lib/runner.mjs';

const hash = hashObject('generic-invocation');
const skills = [...new Set(Object.values(SKILL_ROUTES).flat())].map((id) => ({ id, path: `skills/${id}/SKILL.md`, hash }));
const shell = '#!/bin/sh\nprintf "%s" "${0##*/}" > out/argv0\n';
function temp(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-invocation-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function aliasTool(t) {
  const directory = temp(t), target = path.join(directory, 'real-tool'), alias = path.join(directory, 'alias-tool');
  writeFileSync(target, shell, { mode: 0o755 }); symlinkSync('real-tool', alias);
  return { directory, target, alias };
}
function fixture(t, { root = temp(t), executable, argv = [], inputPaths = [] }) {
  mkdirSync(path.join(root, 'out'), { recursive: true });
  if (!existsSync(path.join(root, 'verify.py'))) writeFileSync(path.join(root, 'verify.py'), 'assert 1 + 1 == 2\n');
  const definition = { id: 'verify-project', title: 'Проверить проект', purpose: 'Проверить локальный результат',
    command: { executable, argv, cwd: '.' }, inputPaths, outputPaths: ['out'], timeoutMs: 5000, maxOutputBytes: 65536 };
  const profile = ProjectProfileSchema.parse({ version: 2, workspaceMode: 'direct', integrationBranch: 'main', contextPaths: [],
    checks: [definition.id], checkMode: 'trusted-local', outputPaths: ['out'], manifests: [], ai: { provider: 'codex', model: 'fixture' },
    checkProfile: { version: 1, requiredCheckIds: [definition.id], definitions: [definition], environment: [] } });
  writeFileSync(path.join(root, '.flowcairn.json'), JSON.stringify(profile));
  mkdirSync(path.join(root, '.ai-orchestrator/graph/runner-tickets'), { recursive: true, mode: 0o700 });
  for (const file of ['.ai-orchestrator', '.ai-orchestrator/graph']) chmodSync(path.join(root, file), 0o700);
  writeFileSync(path.join(root, '.ai-orchestrator/flowcairn-install.json'), JSON.stringify({ tool: 'flowcairn',
    owner: `flowcairn-${randomUUID()}`, trustedLocalChecksHash: trustedLocalChecksHash(root, profile) }), { mode: 0o600 });
  const checks = inspectProjectChecks(root, profile);
  const task = TaskSpecV3Schema.parse({ schemaVersion: 3, sourceHash: fingerprintDirectWorkspace(root, { outputPaths: profile.outputPaths }).hash,
    id: 'GENERIC-INVOCATION', goal: 'Проверить проект', instructions: 'Выполнить согласованную локальную проверку', scope: ['verify.py'],
    acceptance: ['Проверка завершена'], checks: [definition.id], limits: { maxAttempts: 1, maxReplans: 0, timeoutMs: 5000 } });
  const plan = compilePlan(task, { runtimeHash: hash, skills, checks }).plan;
  const node = plan.nodes.find((node) => node.action.id === 'check-verify-project');
  const run = (onStart = () => {}) => {
    const outputDirectory = path.join(root, '.ai-orchestrator/graph', `output-${randomUUID()}`);
    mkdirSync(outputDirectory, { mode: 0o700 });
    return runRegisteredAction({ root, worktree: root, node, task, plan, skills: [], outputDirectory,
      toolchain: prepareToolchain({ root, worktree: root }), onStart });
  };
  return { root, profile, task, plan, node, checks, run };
}

test('absolute and PATH aliases keep their invocation name separate from canonical identity', (t) => {
  const tool = aliasTool(t);
  const absolute = resolveCheckExecutable(tool.directory, tool.alias);
  const found = resolveCheckExecutable(tool.directory, 'alias-tool', { PATH: tool.directory });
  assert.deepEqual(found, absolute);
  assert.equal(found.executable, tool.alias);
  assert.equal(found.canonicalPath, tool.target);
  assert.match(found.invocationIdentityHash, /^[a-f0-9]{64}$/);
  const direct = resolveCheckExecutable(tool.directory, tool.target);
  assert.equal(found.hash, direct.hash);
  assert.notEqual(found.invocationIdentityHash, direct.invocationIdentityHash);
});

test('registered alias executes with the approved $0 rather than its realpath basename', async (t) => {
  const tool = aliasTool(t), fx = fixture(t, { executable: tool.alias });
  const command = makeRegisteredCheckCommand({ root: fx.root, worktree: fx.root, node: fx.node, plan: fx.plan, profile: fx.profile });
  assert.equal(command.command.executable, tool.alias);
  const result = await fx.run();
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.equal(result.stopped, true); assert.equal(result.uncertain, false);
  assert.equal(readFileSync(path.join(fx.root, 'out/argv0'), 'utf8'), 'alias-tool');
});

for (const change of ['target', 'equivalent-alias', 'target-replacement']) test(`pre-GO refuses ${change} changes even when executable bytes are identical`, async (t) => {
  const tool = aliasTool(t), fx = fixture(t, { executable: tool.alias });
  const alternate = path.join(tool.directory, 'other-tool');
  writeFileSync(alternate, shell, { mode: 0o755 });
  const result = await fx.run(() => {
    if (change === 'target-replacement') renameSync(alternate, tool.target);
    else { rmSync(tool.alias); symlinkSync(change === 'target' ? 'other-tool' : './real-tool', tool.alias); }
  });
  assert.equal(result.failureReason, 'CHECK_REGISTRY_DRIFT', JSON.stringify(result));
  assert.equal(result.stopped, true); assert.equal(result.uncertain, false);
  assert.equal(existsSync(path.join(fx.root, 'out/argv0')), false);
});

test('normal relative executable paths resolve inside the actual worktree, not the registration root', (t) => {
  const root = temp(t), worktree = temp(t);
  for (const directory of [root, worktree]) {
    mkdirSync(path.join(directory, '.venv/bin'), { recursive: true });
    writeFileSync(path.join(directory, '.venv/bin/real-tool'), shell, { mode: 0o755 });
    symlinkSync('real-tool', path.join(directory, '.venv/bin/alias-tool'));
  }
  const approved = resolveCheckExecutable(root, './.venv/bin/alias-tool');
  const actual = resolveCheckExecutable(worktree, '.venv/bin/alias-tool');
  assert.equal(approved.hash, actual.hash);
  assert.equal(actual.executable, path.join(worktree, '.venv/bin/alias-tool'));
  assert.equal(actual.canonicalPath, path.join(worktree, '.venv/bin/real-tool'));
  assert.notEqual(actual.invocationIdentityHash, approved.invocationIdentityHash);
});

function pythonVenv(t) {
  let python;
  try { python = resolveCheckExecutable(os.tmpdir(), 'python3').executable; }
  catch { t.skip('Локальный Python3 отсутствует; SDK не устанавливается.'); return null; }
  const root = temp(t);
  execFileSync(python, ['-m', 'venv', '--without-pip', path.join(root, '.venv')], { cwd: root, stdio: 'pipe', timeout: 20000 });
  const executable = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
  writeFileSync(path.join(root, 'verify.py'), 'import json, os, sys\nassert sys.prefix == os.path.join(os.getcwd(), ".venv")\nassert sys.prefix != sys.base_prefix\nwith open("out/venv.json", "w") as result:\n    json.dump({"prefix": sys.prefix, "base": sys.base_prefix, "executable": sys.executable}, result)\n');
  return { root, executable, alias: path.join(root, ...executable.split('/')) };
}

test('real local python3 -m venv --without-pip runs through its own relative interpreter', async (t) => {
  const venv = pythonVenv(t); if (!venv) return;
  const fx = fixture(t, { root: venv.root, executable: venv.executable, argv: ['-B', 'verify.py'], inputPaths: ['verify.py', '.venv/pyvenv.cfg'] });
  const result = await fx.run();
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.equal(result.stopped, true); assert.equal(result.uncertain, false);
  const actual = JSON.parse(readFileSync(path.join(fx.root, 'out/venv.json'), 'utf8'));
  assert.equal(actual.prefix, path.join(fx.root, '.venv'));
  assert.notEqual(actual.prefix, actual.base);
  assert.equal(actual.executable, venv.alias);
});

test('pre-GO rejects a real venv interpreter alias retarget without executing the check', async (t) => {
  const venv = pythonVenv(t); if (!venv) return;
  if (!lstatSync(venv.alias).isSymbolicLink()) { t.skip('Этот Python создал копию, а не symlink интерпретатора.'); return; }
  const fx = fixture(t, { root: venv.root, executable: venv.executable, argv: ['-B', 'verify.py'], inputPaths: ['verify.py', '.venv/pyvenv.cfg'] });
  const original = resolveCheckExecutable(fx.root, venv.executable);
  const result = await fx.run(() => { rmSync(venv.alias); symlinkSync(original.canonicalPath, venv.alias); });
  assert.equal(result.failureReason, 'CHECK_REGISTRY_DRIFT', JSON.stringify(result));
  assert.equal(result.stopped, true); assert.equal(result.uncertain, false);
  assert.equal(existsSync(path.join(fx.root, 'out/venv.json')), false);
});

test('dependency trees are excluded consistently from direct, Git workspace, and AI source scans', (t) => {
  const venv = pythonVenv(t); if (!venv) return;
  const root = venv.root;
  const git = (...args) => execFileSync(gitExecutable(), ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, stdio: 'pipe' });
  git('init', '--initial-branch=main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('add', 'verify.py'); git('commit', '-m', 'fixture');
  const direct = fingerprintDirectWorkspace(root), workspace = fingerprintWorkspace(root), source = inspectProjectSource(root);
  assert.deepEqual(direct.files.map((file) => file.path), ['verify.py']);
  assert.deepEqual(workspace.files.map((file) => file.path), ['verify.py']);
  assert.deepEqual(source.files.map((file) => file.path), ['verify.py']);
  writeFileSync(path.join(root, '.venv/library-cache.py'), 'dependency = 2\n');
  assert.equal(fingerprintDirectWorkspace(root).hash, direct.hash);
  assert.equal(fingerprintWorkspace(root).hash, workspace.hash);
  assert.equal(inspectProjectSource(root).hash, source.hash);
  symlinkSync('verify.py', path.join(root, 'source-alias.py'));
  assert.throws(() => fingerprintDirectWorkspace(root), { code: 'DIRECT_LINK' });
  assert.throws(() => fingerprintWorkspace(root), { code: 'UNSAFE_WORKSPACE_ENTRY' });
});

test('dependency-root symlinks and project-directory aliases stay rejected', (t) => {
  const root = temp(t), external = temp(t);
  mkdirSync(path.join(external, 'bin')); writeFileSync(path.join(external, 'bin/python'), shell, { mode: 0o755 });
  symlinkSync(external, path.join(root, '.venv'), 'dir');
  assert.throws(() => fingerprintDirectWorkspace(root), { code: 'DIRECT_LINK' });
  assert.throws(() => resolveCheckExecutable(root, '.venv/bin/python'), { code: 'CHECK_PATH_UNSAFE' });
});
