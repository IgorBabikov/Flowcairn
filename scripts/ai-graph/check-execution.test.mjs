import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, cpSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspectProjectChecks } from './lib/check-profile.mjs';
import { SKILL_ROUTES } from './lib/config.mjs';
import { fingerprintDirectWorkspace } from './lib/direct-workspace.mjs';
import { gitExecutable } from './lib/host-executables.mjs';
import { GraphError, hashObject } from './lib/io.mjs';
import { ProjectProfileSchema, trustedLocalChecksHash } from './lib/project.mjs';
import { runRegisteredAction } from './lib/runner.mjs';
import { TaskSpecV2Schema, TaskSpecV3Schema } from './lib/schemas.mjs';
import { prepareToolchain } from './lib/toolchain.mjs';
import { compilePlan } from './lib/validator.mjs';
import { fixture as proofFixture } from './test-support/provable-work.mjs';

const identity = hashObject('execution-workspace-regression');
const skills = [...new Set(Object.values(SKILL_ROUTES).flat())].map(id => ({ id, path: `skills/${id}/SKILL.md`, hash: identity }));
const approvedScript = `node -e "require('node:fs').writeFileSync('out/cwd', process.cwd())"`;
const unapprovedScript = `node -e "require('node:fs').writeFileSync('out/unapproved', 'ran')"`;

function fixture(t, { version = 3, direct = false, privateManifest = false, variant = null, extraBuild = false } = {}) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-execution-check-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync(gitExecutable(), ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, stdio: 'pipe' });
  git('init', '--initial-branch=main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  const pkg = { ...(variant === 'workspace' ? { workspaces: ['packages/check'] } : {}),
    name: 'execution-check-fixture', version: '1.0.0', scripts: { test: approvedScript, ...(extraBuild ? { build: 'node -e "process.exit(0)"' } : {}) } };
  writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
  if (privateManifest) chmodSync(path.join(root, 'package.json'), 0o600);
  writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}');
  writeFileSync(path.join(root, 'source.txt'), 'source');
  writeFileSync(path.join(root, '.gitignore'), '.ai-orchestrator/\nout/\n');
  const profile = ProjectProfileSchema.parse({ version: 1, integrationBranch: 'main', workspaceMode: direct ? 'direct' : 'worktree',
    packageManager: 'npm', contextPaths: [], checks: extraBuild ? ['tests', 'build'] : ['tests'], checkMode: 'trusted-local', checkScripts: { tests: 'test' },
    outputPaths: ['out'], manifests: ['package.json', 'package-lock.json'], ai: { provider: 'codex', model: 'fixture' } });
  writeFileSync(path.join(root, '.flowcairn.json'), JSON.stringify(profile));
  mkdirSync(path.join(root, '.ai-orchestrator/graph/runner-tickets'), { recursive: true, mode: 0o700 });
  for (const part of ['.ai-orchestrator', '.ai-orchestrator/graph']) chmodSync(path.join(root, part), 0o700);
  writeFileSync(path.join(root, '.ai-orchestrator/flowcairn-install.json'), JSON.stringify({ tool: 'flowcairn', owner: `flowcairn-${randomUUID()}`,
    trustedLocalChecksHash: trustedLocalChecksHash(root, profile) }), { mode: 0o600 });
  if (variant === 'workspace') {
    mkdirSync(path.join(root, 'packages/check'), { recursive: true });
    writeFileSync(path.join(root, 'packages/check/package.json'), JSON.stringify({ name: 'child-check', scripts: {
      test: `node -e "require('node:fs').writeFileSync('../../out/cwd', process.cwd())"` } }));
    writeFileSync(path.join(root, '.npmrc'), 'workspaces=true\n');
  }
  if (variant === 'shell' || variant === 'generated-shell') {
    const shell = variant === 'shell' ? 'check-shell' : 'out/check-shell';
    mkdirSync(path.join(root, 'out'), { recursive: true });
    writeFileSync(path.join(root, shell), '#!/bin/sh\nexec /bin/sh "$@"\n', { mode: 0o755 });
    writeFileSync(path.join(root, '.npmrc'), `script-shell=./${shell}\n`);
  }
  git('add', '.'); git('commit', '-m', 'fixture');
  let worktree = root;
  if (!direct) {
    mkdirSync(path.join(root, '.ai-orchestrator/worktrees'), { mode: 0o700 });
    worktree = path.join(root, '.ai-orchestrator/worktrees/check');
    git('worktree', 'add', '--detach', worktree, 'HEAD');
  }
  mkdirSync(path.join(worktree, 'out'), { recursive: true });
  if (!direct && variant === 'generated-shell') cpSync(path.join(root, 'out/check-shell'), path.join(worktree, 'out/check-shell'));
  const task = (version === 3 ? TaskSpecV3Schema : TaskSpecV2Schema).parse({ schemaVersion: version, id: 'CHECK-WORKSPACE',
    goal: 'Проверить workspace', instructions: 'Проверить исходник', scope: ['source.txt'], acceptance: ['Проверен'], checks: ['tests'],
    sourceHash: fingerprintDirectWorkspace(root, { outputPaths: profile.outputPaths }).hash,
    limits: { maxAttempts: 1, maxReplans: 0, timeoutMs: 5000 } });
  const compiled = compilePlan(task, { runtimeHash: identity, skills, ...(version === 3 ? { checks: inspectProjectChecks(root, profile) } : {}) }).plan;
  const plan = structuredClone(compiled), node = plan.nodes.find(node => node.action.id === 'check-tests');
  const run = (onStart = () => {}) => {
    const outputDirectory = path.join(root, '.ai-orchestrator/graph', `output-${randomUUID()}`);
    mkdirSync(outputDirectory, { mode: 0o700 });
    return runRegisteredAction({ root, worktree, node, task, plan, skills: [], outputDirectory,
      toolchain: prepareToolchain({ root, worktree }), onStart });
  };
  const rewritePackage = (changes) => writeFileSync(path.join(worktree, 'package.json'), JSON.stringify({ ...pkg, ...changes }));
  return { root, worktree, pkg, plan, run, rewritePackage };
}

for (const version of [2, 3]) for (const direct of [false, true]) {
  test(`unchanged V${version} ${direct ? 'direct' : 'worktree'} npm check runs in the actual workspace`, async t => {
    const fx = fixture(t, { version, direct, privateManifest: !direct });
    const result = await fx.run();
    assert.equal(result.exitCode, 0, JSON.stringify(result)); assert.equal(result.stopped, true); assert.equal(result.uncertain, false);
    assert.equal(readFileSync(path.join(fx.worktree, 'out/cwd'), 'utf8'), fx.worktree);
    if (!direct) assert.equal(existsSync(path.join(fx.root, 'out/cwd')), false);
  });
}

test('V2 preserves already-present worktree scripts while fencing later substitutions', async t => {
  const fx = fixture(t, { version: 2 });
  fx.rewritePackage({ scripts: { test: `${approvedScript} && node -e "process.exit(7)"` } });
  const result = await fx.run();
  assert.equal(result.exitCode, 7); assert.equal(result.stopped, true);
  assert.equal(readFileSync(path.join(fx.worktree, 'out/cwd'), 'utf8'), fx.worktree);
});

test('a V2 selected check does not require an unrelated package script to remain present', async t => {
  const fx = fixture(t, { version: 2, extraBuild: true });
  fx.rewritePackage({ scripts: { test: approvedScript } });
  const result = await fx.run();
  assert.equal(result.exitCode, 0); assert.equal(result.stopped, true);
});

test('an unchanged 65 MiB declared output does not block an unrelated npm check', async t => {
  const fx = fixture(t);
  const fd = openSync(path.join(fx.worktree, 'out/large-cache.bin'), 'wx');
  try { ftruncateSync(fd, 65 * 1024 * 1024); } finally { closeSync(fd); }
  const result = await fx.run();
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.equal(result.stopped, true);
  assert.equal(readFileSync(path.join(fx.worktree, 'out/cwd'), 'utf8'), fx.worktree);
});

test('quoted static script-shell uses the installed npm parser and remains hash-bound', async t => {
  const fx = fixture(t, { variant: 'generated-shell' });
  writeFileSync(path.join(fx.worktree, '.npmrc'), '"script-shell" = "./out/check-shell"\n');
  const result = await fx.run();
  assert.equal(result.exitCode, 0, JSON.stringify(result));
});

test('an ambiguous custom script-shell is refused explicitly before reservation', async t => {
  const fx = fixture(t, { variant: 'workspace' }); let reservations = 0;
  writeFileSync(path.join(fx.worktree, '.npmrc'), 'workspaces=true\nscript-shell=./check-shell\n');
  await assert.rejects(fx.run(() => { reservations++; }), { code: 'CHECK_SHELL_CONFIG_UNSUPPORTED' });
  assert.equal(reservations, 0);
});

for (const afterStart of [false, true]) test(`unsupported shell ${afterStart ? 'after' : 'before'} process start preserves truthful outcome`, async t => {
  const fx = await proofFixture(t);
  const execute = fx.service.adapters.execute;
  fx.service.adapters.execute = async input => {
    if (input.node.action.id !== 'check-tests') return execute(input);
    if (afterStart) input.onStart({ ticket: 'fixture-process', pid: process.pid });
    throw new GraphError('CHECK_SHELL_CONFIG_UNSUPPORTED', 'Нужен статический путь shell.');
  };
  const snapshot = await fx.run();
  assert.equal(snapshot.status, afterStart ? 'uncertain' : 'failed');
  assert.notEqual(snapshot.proof.status, 'PROVEN');
  assert.equal(fx.checks(), 0);
});

for (const variant of ['workspace', 'shell', 'generated-shell']) for (const version of [2, 3]) for (const direct of [false, true]) {
  test(`V${version} ${direct ? 'direct' : 'worktree'} fences ${variant} control inputs and preserves its unchanged command`, async t => {
    const fx = fixture(t, { version, direct, variant });
    const control = await fx.run();
    assert.equal(control.exitCode, 0, JSON.stringify(control));
    assert.equal(readFileSync(path.join(fx.worktree, 'out/cwd'), 'utf8'), variant === 'workspace' ? path.join(fx.worktree, 'packages/check') : fx.worktree);
    rmSync(path.join(fx.worktree, 'out/cwd'));
    const result = await fx.run(() => {
      if (variant === 'workspace') writeFileSync(path.join(fx.worktree, 'packages/check/package.json'), JSON.stringify({ name: 'child-check', scripts: {
        test: `node -e "require('node:fs').writeFileSync('../../out/unapproved', 'ran')"` } }));
      else writeFileSync(path.join(fx.worktree, variant === 'shell' ? 'check-shell' : 'out/check-shell'), '#!/bin/sh\nprintf ran > out/unapproved\nexit 0\n');
    });
    assert.equal(result.failureReason, 'CHECK_REGISTRY_DRIFT');
    assert.equal(result.stopped, true); assert.equal(result.uncertain, false);
    assert.equal(existsSync(path.join(fx.worktree, 'out/unapproved')), false);
    assert.equal(existsSync(path.join(fx.worktree, 'out/cwd')), false);
  });
}

test('V3 rejects a worktree manifest already different from the approved registry before reservation', async t => {
  const fx = fixture(t); let reservations = 0;
  fx.rewritePackage({ scripts: { test: unapprovedScript } });
  await assert.rejects(fx.run(() => { reservations++; }), { code: 'CHECK_REGISTRY_DRIFT' });
  assert.equal(reservations, 0); assert.equal(existsSync(path.join(fx.worktree, 'out/unapproved')), false);
});

for (const version of [2, 3]) {
  for (const change of ['script', 'pretest', 'atomic-file', 'file-symlink', 'directory-symlink', 'directory-replacement', 'npm-config']) {
    test(`V${version} refuses ${change} substitution between reservation and GO`, async t => {
      const fx = fixture(t, { version });
      const result = await fx.run(() => {
        if (change === 'script') fx.rewritePackage({ scripts: { test: unapprovedScript } });
        if (change === 'pretest') fx.rewritePackage({ scripts: { ...fx.pkg.scripts, pretest: unapprovedScript } });
        if (change === 'atomic-file') {
          const temporary = path.join(fx.worktree, 'replacement.json');
          writeFileSync(temporary, JSON.stringify({ ...fx.pkg, scripts: { test: unapprovedScript } }));
          renameSync(temporary, path.join(fx.worktree, 'package.json'));
        }
        if (change === 'file-symlink') {
          renameSync(path.join(fx.worktree, 'package.json'), path.join(fx.worktree, 'saved-package.json'));
          symlinkSync(path.join(fx.root, 'package.json'), path.join(fx.worktree, 'package.json'));
        }
        if (change === 'directory-symlink' || change === 'directory-replacement') {
          const saved = `${fx.worktree}-saved`; renameSync(fx.worktree, saved);
          if (change === 'directory-symlink') symlinkSync(saved, fx.worktree, 'dir');
          else cpSync(saved, fx.worktree, { recursive: true });
        }
        if (change === 'npm-config') {
          const shell = path.join(fx.worktree, 'unapproved-shell');
          writeFileSync(shell, '#!/bin/sh\nprintf ran > out/unapproved\nexit 0\n', { mode: 0o700 });
          writeFileSync(path.join(fx.worktree, '.npmrc'), `script-shell=${shell}\n`);
        }
      });
      assert.notEqual(result.exitCode, 0, JSON.stringify(result)); assert.ok(result.failureReason);
      assert.equal(result.stopped, true); assert.equal(result.uncertain, false);
      assert.equal(existsSync(path.join(fx.worktree, 'out/unapproved')), false);
      assert.equal(existsSync(path.join(fx.worktree, 'out/cwd')), false, 'Even the approved child must not start after drift');
    });
  }
}

test('mutating the caller plan cannot downgrade the parsed V3 authorization during reservation', async t => {
  const fx = fixture(t);
  const result = await fx.run(() => {
    fx.plan.schemaVersion = 2; delete fx.plan.checks; delete fx.plan.checkRegistryHash;
    fx.rewritePackage({ scripts: { test: unapprovedScript } });
  });
  assert.equal(result.failureReason, 'CHECK_REGISTRY_DRIFT');
  assert.equal(existsSync(path.join(fx.worktree, 'out/unapproved')), false);
});
