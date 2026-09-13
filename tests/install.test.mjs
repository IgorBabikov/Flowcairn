import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initializeProject, createTask, parseOptions } from '../bin/flowcairn.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-install-')));
  t.after(() => {
    // The runtime intentionally freezes source snapshots. Only unlock our disposable fixture.
    const unlock = (directory) => {
      chmodSync(directory, 0o700);
      for (const name of readdirSync(directory)) {
        const file = path.join(directory, name),
          stat = lstatSync(file);
        if (stat.isDirectory() && !stat.isSymbolicLink()) unlock(file);
      }
    };
    unlock(root);
    rmSync(root, { recursive: true, force: true });
  });
  const git = (...args) =>
    execFileSync('/usr/bin/git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'fixture-project',
      version: '1.0.0',
      type: 'module',
      scripts: { test: 'node --test' },
    }) + '\n',
  );
  writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');
  writeFileSync(path.join(root, 'AGENTS.md'), '# Правила владельца\nНе удалять этот текст.\n');
  git('add', '.');
  git('commit', '-m', 'fixture baseline');
  return { root, git };
}
const options = { provider: 'openai', model: 'configured-test-model' };

test('init dry run has no effects; setup is repeatable and preserves owner instructions/hooks', (t) => {
  const { root, git } = fixture(t);
  const original = readFileSync(path.join(root, 'AGENTS.md'));
  const hook = path.join(root, '.git/hooks/pre-commit');
  writeFileSync(hook, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const preview = initializeProject(root, { ...options, 'dry-run': true });
  assert.equal(preview.dryRun, true);
  assert.equal(existsSync(path.join(root, '.flowcairn.json')), false);
  assert.equal(git('status', '--porcelain'), '');
  const installed = initializeProject(root, options);
  assert.equal(installed.created, true);
  assert.equal(installed.profile.integrationBranch, 'main');
  assert.equal(installed.profile.packageManager, 'npm');
  assert.deepEqual(installed.profile.checks, ['tests']);
  assert.deepEqual(installed.profile.manifests, ['package.json']);
  assert.equal(readFileSync(path.join(root, 'AGENTS.md')).equals(original), true);
  assert.equal(readFileSync(hook, 'utf8'), '#!/bin/sh\nexit 0\n');
  const ignore = readFileSync(path.join(root, '.gitignore'), 'utf8');
  assert.ok(ignore.startsWith('node_modules/\n'));
  assert.equal(initializeProject(root, options).created, false);
  assert.equal(readFileSync(path.join(root, '.gitignore'), 'utf8'), ignore);
  assert.equal(existsSync(path.join(root, '.ai-orchestrator/state.json')), false);
});

test('conflicting state and linked gitignore are refused before creating profile', (t) => {
  const a = fixture(t);
  symlinkSync(path.join(a.root, 'missing-state'), path.join(a.root, '.ai-orchestrator'));
  assert.throws(() => initializeProject(a.root, options), { code: 'INSTALL_CONFLICT' });
  assert.equal(existsSync(path.join(a.root, '.flowcairn.json')), false);
  const b = fixture(t);
  rmSync(path.join(b.root, '.gitignore'));
  symlinkSync(path.join(b.root, 'AGENTS.md'), path.join(b.root, '.gitignore'));
  assert.throws(() => initializeProject(b.root, options));
  assert.equal(existsSync(path.join(b.root, '.flowcairn.json')), false);
});

test('linked manifest parent and invalid profile fail without modifying owner files', (t) => {
  const { root } = fixture(t);
  mkdirSync(path.join(root, 'real'));
  writeFileSync(path.join(root, 'real/package.json'), '{}');
  symlinkSync(path.join(root, 'real'), path.join(root, 'linked'));
  assert.throws(
    () => initializeProject(root, { ...options, manifests: 'package.json,linked/package.json' }),
    { code: 'UNSAFE_FILE' },
  );
  assert.equal(existsSync(path.join(root, '.flowcairn.json')), false);
  assert.throws(() => initializeProject(root, { ...options, outputs: 'package.json' }));
});

test('task registration works in a clean main repo without tool source or host dependencies', async (t) => {
  const { root, git } = fixture(t);
  initializeProject(root, options);
  const task = {
    id: 'ORCH-001',
    goal: 'Уточнить заголовок документа',
    instructions: 'Добавить понятный заголовок',
    scope: ['README.md'],
    acceptance: ['Заголовок объясняет назначение'],
    checks: [],
  };
  await assert.rejects(createTask(root, task), { code: 'DIRTY_ROOT' });
  git('add', '.flowcairn.json', '.gitignore');
  git('commit', '-m', 'fixture setup');
  const snapshot = await createTask(root, task, { run: 'run-first-task' });
  assert.equal(snapshot.status, 'waiting-for-human');
  assert.equal(snapshot.integrity.valid, true);
  assert.ok(snapshot.nodes.some((node) => node.id === 'tests'));
  assert.equal(existsSync(path.join(root, 'scripts/ai-graph')), false);
  assert.equal(existsSync(path.join(root, 'node_modules')), false);
  assert.equal(snapshot.nodes.find((node) => node.id === 'analyze').attempt, 0);
  await assert.rejects(createTask(root, { ...task, checks: ['graph-tests'] }), {
    code: 'CHECK_UNSUPPORTED',
  });
  await assert.rejects(createTask(root, { ...task, goal: 'Иная цель' }), { code: 'TASK_CONFLICT' });
});

test('CLI rejects arbitrary and duplicate arguments', () => {
  assert.throws(() => parseOptions(['--shell', 'rm -rf .']), { code: 'ARGUMENT' });
  assert.throws(() => parseOptions(['--root', 'a', '--root', 'b']), { code: 'ARGUMENT' });
  assert.deepEqual(parseOptions(['--root', '.', '--dry-run']), { root: '.', 'dry-run': true });
});
