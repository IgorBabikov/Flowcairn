import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, symlinkSync, lstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RUNNER_TESTING } from './lib/runner.mjs';
import { prepareToolchain, verifyToolchain } from './lib/toolchain.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'flowcairn-runner-deps-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' },
  });
  git('init', '--initial-branch=main');
  const profile = { version: 1, integrationBranch: 'main', packageManager: 'npm', contextPaths: [], checks: [], outputPaths: [],
    manifests: ['package.json', 'packages/lib/package.json'], ai: { provider: 'openai', model: 'fixture-model' } };
  mkdirSync(path.join(root, 'src'), { recursive: true });
  mkdirSync(path.join(root, 'packages/lib'), { recursive: true });
  writeFileSync(path.join(root, 'package.json'), '{"name":"fixture","workspaces":["packages/*"]}\n');
  writeFileSync(path.join(root, 'packages/lib/package.json'), '{"name":"fixture-lib"}\n');
  writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  writeFileSync(path.join(root, '.flowcairn.json'), JSON.stringify(profile));
  writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n.ai-orchestrator/\n');
  writeFileSync(path.join(root, 'AGENTS.md'), '# Root instructions\n');
  writeFileSync(path.join(root, 'src/AGENTS.md'), '# Scoped instructions\n');
  writeFileSync(path.join(root, 'src/value.mjs'), 'export const value = 1;\n');
  git('add', '.'); git('commit', '-m', 'fixture baseline');
  for (const relative of ['node_modules', 'packages/lib/node_modules']) {
    const dependencies = path.join(root, relative);
    mkdirSync(path.join(dependencies, '.bin'), { recursive: true });
    mkdirSync(path.join(dependencies, 'fixture-runner/bin'), { recursive: true });
    writeFileSync(path.join(dependencies, 'fixture-runner/package.json'), '{"name":"fixture-runner","version":"1.0.0"}');
    writeFileSync(path.join(dependencies, 'fixture-runner/bin/run.js'), '#!/usr/bin/env node\n');
    symlinkSync('../fixture-runner/bin/run.js', path.join(dependencies, '.bin/run'));
  }
  const worktree = path.join(root, '.ai-orchestrator/worktrees/task-1');
  mkdirSync(path.dirname(worktree), { recursive: true, mode: 0o700 });
  git('worktree', 'add', '--detach', worktree, 'HEAD');
  const manifest = prepareToolchain({ root, worktree });
  const verified = verifyToolchain({ root, worktree, manifest });
  const task = { scope: ['src'], contextPaths: ['AGENTS.md'], forbiddenPaths: [] };
  const node = { resources: { reads: ['src', 'AGENTS.md'] } };
  return { root, worktree, profile, manifest, verified, task, node };
}

test('AI source and Codex instruction inventory skip verified root/nested dependency .bin links', (t) => {
  const f = fixture(t);
  assert.equal(lstatSync(path.join(f.worktree, 'node_modules/.bin/run')).isSymbolicLink(), true);
  assert.equal(lstatSync(path.join(f.worktree, 'packages/lib/node_modules/.bin/run')).isSymbolicLink(), true);
  assert.deepEqual(f.verified.dependencyPaths, ['node_modules', 'packages/lib/node_modules']);
  assert.throws(() => RUNNER_TESTING.selectedSourceContext(f.worktree, f.node, f.task, f.profile), (error) => error.code === 'UNSAFE_WORKSPACE_ENTRY');
  const source = RUNNER_TESTING.selectedSourceContext(f.worktree, f.node, f.task, f.profile, f.verified);
  assert.deepEqual(source.map((file) => file.path), ['AGENTS.md', 'src/value.mjs']);
  assert.deepEqual(RUNNER_TESTING.instructionDenials(f.worktree, f.node, f.profile, f.verified), ['src/AGENTS.md']);
});

test('source symlinks remain forbidden even when dependency view is verified', (t) => {
  const f = fixture(t);
  symlinkSync('value.mjs', path.join(f.worktree, 'src/alias.mjs'));
  assert.throws(() => RUNNER_TESTING.selectedSourceContext(f.worktree, f.node, f.task, f.profile, f.verified), (error) => error.code === 'UNSAFE_WORKSPACE_ENTRY');
  assert.throws(() => RUNNER_TESTING.instructionDenials(f.worktree, f.node, f.profile, f.verified), (error) => error.code === 'UNSAFE_WORKSPACE_ENTRY');
});

test('dependency projection drift still requires toolchain rejection before context preparation', (t) => {
  const f = fixture(t);
  const executable = path.join(f.worktree, 'node_modules/.bin/run');
  rmSync(executable);
  symlinkSync(path.join(f.root, 'src/value.mjs'), executable);
  assert.throws(() => verifyToolchain({ root: f.root, worktree: f.worktree, manifest: f.manifest }), (error) => error.code === 'TOOLCHAIN_DRIFT');
});
