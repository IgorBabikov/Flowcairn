import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { PassThrough } from 'node:stream';
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
import { fileURLToPath } from 'node:url';
import {
  initializeProject,
  initializeCommand,
  createTask,
  parseOptions,
} from '../bin/flowcairn.mjs';
import { WorkflowService } from '../scripts/ai-graph/lib/service.mjs';

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
const testClaude = path.resolve(import.meta.dirname, 'fixtures/verified-claude/node_modules/@anthropic-ai/claude-code/bin/claude.exe');
const options = { provider: 'claude', 'provider-path': testClaude, 'workspace-mode': 'worktree' };

test('new project without Git uses its own directory for task state and source', async (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-no-git-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src', 'feature.mjs'), 'export const ready = false;\n');
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'direct-fixture', version: '1.0.0', type: 'module' }));
  const installed = initializeProject(root, { provider: 'claude', 'provider-path': testClaude,
    'read-consent': true, 'package-manager': 'npm' });
  assert.equal(installed.profile.workspaceMode, 'direct');
  assert.equal(installed.profile.onboarding.readScope, 'project-files');
  const task = { id: 'DIRECT-001', goal: 'Исправить значение в текущем проекте',
    instructions: 'Изменить src/feature.mjs', scope: ['src/feature.mjs'], acceptance: ['Значение исправлено'], checks: [] };
  writeFileSync(path.join(root, '.npmrc'), 'private fixture\n');
  await assert.rejects(createTask(root, { ...task, includeUntracked: ['.npmrc'] }), { code: 'DIRECT_SCOPE' });
  const snapshot = await createTask(root, task, { run: 'run-direct-install' });
  assert.equal(snapshot.status, 'waiting-for-human');
  assert.equal(existsSync(path.join(root, '.git')), false);
  assert.equal(existsSync(path.join(root, '.ai-orchestrator', 'worktrees')), false);
});

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
  assert.equal(installed.profile.checkMode, 'trusted-local');
  assert.deepEqual(installed.profile.manifests, ['package.json']);
  assert.equal(readFileSync(path.join(root, 'AGENTS.md')).equals(original), true);
  assert.equal(readFileSync(hook, 'utf8'), '#!/bin/sh\nexit 0\n');
  const ignore = readFileSync(path.join(root, '.gitignore'), 'utf8');
  assert.ok(ignore.startsWith('node_modules/\n'));
  assert.match(readFileSync(path.join(root, '.git/info/exclude'), 'utf8'), /\.ai-orchestrator\//);
  assert.equal(initializeProject(root, options).created, false);
  assert.equal(readFileSync(path.join(root, '.gitignore'), 'utf8'), ignore);
  assert.equal(existsSync(path.join(root, '.ai-orchestrator/state.json')), false);
});

test('conflicting state and linked local Git exclude are refused before creating profile', (t) => {
  const a = fixture(t);
  symlinkSync(path.join(a.root, 'missing-state'), path.join(a.root, '.ai-orchestrator'));
  assert.throws(() => initializeProject(a.root, options), { code: 'INSTALL_CONFLICT' });
  assert.equal(existsSync(path.join(a.root, '.flowcairn.json')), false);
  const b = fixture(t);
  rmSync(path.join(b.root, '.git/info/exclude'));
  symlinkSync(path.join(b.root, 'AGENTS.md'), path.join(b.root, '.git/info/exclude'));
  assert.throws(() => initializeProject(b.root, options));
  assert.equal(existsSync(path.join(b.root, '.flowcairn.json')), false);
});

test('invalid existing profile is not adopted or overwritten', (t) => {
  const project = fixture(t);
  writeFileSync(path.join(project.root, '.flowcairn.json'), '{}\n');
  assert.throws(() => initializeProject(project.root, options), { code: 'PROJECT_PROFILE_INVALID' });
  assert.equal(readFileSync(path.join(project.root, '.flowcairn.json'), 'utf8'), '{}\n');
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
  git('add', '.flowcairn.json', '.gitignore');
  git('commit', '-m', 'fixture setup');
  const snapshot = await createTask(root, task, { run: 'run-first-task' });
  assert.equal(snapshot.status, 'waiting-for-human');
  assert.equal(snapshot.integrity.valid, true);
  assert.equal(snapshot.nodes.some((node) => node.id === 'tests'), true);
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

test('fresh clone adopts tracked profile without changing tracked files and can register a task', async (t) => {
  const origin = fixture(t);
  initializeProject(origin.root, options);
  origin.git('add', '.flowcairn.json', '.gitignore');
  origin.git('commit', '-m', 'fixture setup');
  const clone = fixture(t);
  // Replace only this test-owned disposable checkout with an actual clone.
  rmSync(clone.root, { recursive: true, force: true });
  execFileSync('/usr/bin/git', ['clone', '--no-local', origin.root, clone.root], { stdio: 'pipe' });
  clone.git('config', 'user.name', 'Fixture');
  clone.git('config', 'user.email', 'fixture@example.invalid');
  const tracked = ['.flowcairn.json', '.gitignore', 'AGENTS.md'].map((file) => [
    file,
    readFileSync(path.join(clone.root, file)),
  ]);
  assert.equal(existsSync(path.join(clone.root, '.ai-orchestrator')), false);
  assert.deepEqual(initializeProject(clone.root, { 'dry-run': true }).changes, [
    '.git/info/exclude (локально)',
    '.ai-orchestrator/flowcairn-install.json',
  ]);
  assert.equal(existsSync(path.join(clone.root, '.ai-orchestrator')), false);
  const adopted = initializeProject(clone.root);
  assert.equal(adopted.adopted, true);
  for (const [file, bytes] of tracked)
    assert.deepEqual(readFileSync(path.join(clone.root, file)), bytes);
  assert.equal(clone.git('status', '--porcelain'), '');
  const snapshot = await createTask(
    clone.root,
    {
      id: 'ORCH-001',
      goal: 'Проверить документ',
      instructions: 'Уточнить заголовок',
      scope: ['README.md'],
      acceptance: ['Заголовок понятен'],
      checks: [],
    },
    { run: 'run-clone' },
  );
  assert.equal(snapshot.integrity.valid, true);
  assert.equal(snapshot.status, 'waiting-for-human');
});

test('adoption preserves foreign local state and refuses linked owner directory', (t) => {
  const { root } = fixture(t);
  initializeProject(root, options);
  rmSync(path.join(root, '.ai-orchestrator'), { recursive: true });
  mkdirSync(path.join(root, '.ai-orchestrator'));
  writeFileSync(path.join(root, '.ai-orchestrator/foreign.txt'), 'owner data');
  const profile = readFileSync(path.join(root, '.flowcairn.json'));
  assert.throws(() => initializeProject(root), { code: 'INSTALL_CONFLICT' });
  assert.deepEqual(readFileSync(path.join(root, '.flowcairn.json')), profile);
  assert.equal(readFileSync(path.join(root, '.ai-orchestrator/foreign.txt'), 'utf8'), 'owner data');
});

test('init includes child manifests from a pnpm YAML-only workspace', (t) => {
  const { root } = fixture(t);
  mkdirSync(path.join(root, 'packages/app'), { recursive: true });
  writeFileSync(path.join(root, 'packages/app/package.json'), '{"name":"app"}');
  writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  const result = initializeProject(root, options);
  assert.equal(result.profile.packageManager, 'pnpm');
  assert.deepEqual(result.profile.manifests, [
    'package.json',
    'pnpm-workspace.yaml',
    'packages/app/package.json',
  ]);
});

function linkedCli(t) {
  const project = fixture(t);
  const runtimeRoot = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
  const binDirectory = path.join(project.root, 'node_modules/.bin');
  mkdirSync(binDirectory, { recursive: true });
  symlinkSync(runtimeRoot, path.join(project.root, 'node_modules/flowcairn'), 'dir');
  symlinkSync('../flowcairn/bin/flowcairn.mjs', path.join(binDirectory, 'flowcairn'));
  return { ...project, runtimeRoot, cli: 'node_modules/.bin/flowcairn' };
}

test('relative npm bin symlink runs version and init with observable effects', (t) => {
  const { root, git, runtimeRoot, cli } = linkedCli(t);
  const head = git('rev-parse', 'HEAD');
  const instructions = readFileSync(path.join(root, 'AGENTS.md'));
  const version = JSON.parse(readFileSync(path.join(runtimeRoot, 'package.json'), 'utf8')).version;
  const run = (...args) =>
    execFileSync(process.execPath, [cli, ...args], {
      cwd: root,
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  assert.equal(run('--version').trim(), version);
  const result = JSON.parse(
    run('init', '--provider', 'claude', '--provider-path', testClaude, '--json'),
  );
  assert.equal(result.ok, true);
  assert.equal(result.result.created, true);
  const profile = JSON.parse(readFileSync(path.join(root, '.flowcairn.json'), 'utf8'));
  assert.equal(profile.ai.model, 'provider-default');
  assert.equal(existsSync(path.join(root, '.ai-orchestrator/flowcairn-install.json')), true);
  assert.match(readFileSync(path.join(root, '.git/info/exclude'), 'utf8'), /\.ai-orchestrator\//);
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.deepEqual(readFileSync(path.join(root, 'AGENTS.md')), instructions);
});

test('offline npx resolves the local npm bin symlink and runs the CLI', (t) => {
  const npx = path.resolve(
    path.dirname(process.execPath),
    '../lib/node_modules/npm/bin/npx-cli.js',
  );
  if (!existsSync(npx)) {
    t.skip('This Node distribution has no bundled npx');
    return;
  }
  const { root, runtimeRoot } = linkedCli(t);
  const expectedVersion = JSON.parse(
    readFileSync(path.join(runtimeRoot, 'package.json'), 'utf8'),
  ).version;
  const version = execFileSync(
    process.execPath,
    [npx, '--offline', '--no-install', 'flowcairn', '--version'],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        npm_config_offline: 'true',
        npm_config_update_notifier: 'false',
        npm_config_cache: path.join(root, 'node_modules/.cache/npm'),
      },
    },
  );
  assert.equal(version.trim(), expectedVersion);
});

test('import remains inert when argv entry is missing or does not exist', (t) => {
  const { root } = fixture(t);
  const entry = new URL('../bin/flowcairn.mjs', import.meta.url).href;
  for (const value of [undefined, path.join(root, 'missing-entry.mjs')]) {
    const script = `process.argv[1] = ${JSON.stringify(value) ?? 'undefined'}; await import(${JSON.stringify(entry)}); process.stdout.write('imported');`;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root,
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(output, 'imported');
    assert.equal(existsSync(path.join(root, '.flowcairn.json')), false);
  }
});

const firstTask = {
  id: 'ORCH-BOOTSTRAP',
  goal: 'Уточнить заголовок',
  instructions: 'Уточнить заголовок документа',
  scope: ['README.md'],
  acceptance: ['Заголовок понятен'],
  checks: [],
};

test('TTY init selects a verified CLI; non-TTY, JSON and dry-run never write with a missing CLI', async (t) => {
  for (const flags of [{}, { json: true }, { 'dry-run': true }]) {
    const { root } = fixture(t);
    await assert.rejects(
      initializeCommand(
        root,
        { provider: 'cursor', 'provider-path':path.join(root, 'missing-cursor'), ...flags },
        { input: { isTTY: false }, output: { isTTY: false } },
      ),
      { code: 'PROVIDER_TOOLCHAIN_INVALID' },
    );
    assert.equal(existsSync(path.join(root, '.flowcairn.json')), false);
    assert.equal(existsSync(path.join(root, '.ai-orchestrator')), false);
  }
  const { root } = fixture(t);
  const input = new PassThrough(),
    output = new PassThrough();
  input.isTTY = output.isTTY = true;
  let transcript = '';
  output.on('data', (bytes) => {
    const text = bytes.toString();
    transcript += text;
    const replies = [
      ['Выбор [1]:', 'keep'], ['Режим проверок [1]:', 'none'],
      ['Разрешить выбранному AI-клиенту', 'да'], ['Подключить Graph', 'нет'],
    ];
    for (const [marker, answer] of replies) if (text.includes(marker)) setImmediate(() => input.write(answer + '\n'));
  });
  const pending = initializeCommand(root, options, { input, output });
  const installed = await pending;
  assert.equal(installed.profile.ai.model, 'provider-default');
  assert.match(transcript, /Claude Code — использовать выбранный CLI/);
  const before = transcript;
  assert.equal((await initializeCommand(root, {}, { input, output })).created, false);
  assert.equal(transcript, before);
  input.destroy();
  output.destroy();
});

test('init rejects ambiguous managers, invalid model and detached HEAD without creating files', (t) => {
  const { root, git } = fixture(t);
  writeFileSync(path.join(root, 'package-lock.json'), '{}');
  writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
  assert.throws(() => initializeProject(root, options), { code: 'PACKAGE_MANAGER' });
  assert.equal(existsSync(path.join(root, '.flowcairn.json')), false);
  assert.throws(() => initializeProject(root, { provider: 'openai', model: 'test-model' }), { code: 'PROVIDER_UNSUPPORTED' });
  assert.equal(existsSync(path.join(root, '.ai-orchestrator')), false);
  git('checkout', '--detach');
  assert.throws(() => initializeProject(root, { ...options, 'package-manager': 'npm' }), {
    code: 'BRANCH_REQUIRED',
  });
});

test('first graph snapshots exact installer files with no commit, AI, binding or permissions', async (t) => {
  const { root, git } = fixture(t);
  const head = git('rev-parse', 'HEAD');
  initializeProject(root, options);
  const dirty = git('status', '--porcelain');
  const index = readFileSync(path.join(root, '.git/index'));
  const snapshot = await createTask(root, firstTask, { run: 'run-bootstrap' });
  const service = await WorkflowService.open({ root });
  const state = service.store.readRun('run-bootstrap');
  assert.equal(service.snapshot('run-bootstrap').integrity.valid, true);
  assert.equal(snapshot.status, 'waiting-for-human');
  assert.ok(snapshot.nodes.every((node) => node.attempt === 0));
  assert.deepEqual(state.permissions, []);
  assert.equal(state.binding, null);
  assert.equal(
    JSON.parse(readFileSync(path.join(root, '.ai-orchestrator/state.json'))).bootstrapSourceHash,
    state.sourceHash,
  );
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(git('status', '--porcelain'), dirty);
  assert.deepEqual(readFileSync(path.join(root, '.git/index')), index);
  await assert.rejects(createTask(root, { ...firstTask, id: 'ORCH-NEXT' }), { code: 'DIRTY_ROOT' });
});

test('first graph requires explicit tracked snapshot and captures only selected untracked files', async (t) => {
  const { root } = fixture(t);
  initializeProject(root, options);
  writeFileSync(path.join(root, 'AGENTS.md'), 'Owner changes remain\n');
  await assert.rejects(createTask(root, firstTask), { code: 'DIRTY_ROOT' });
  assert.equal(existsSync(path.join(root, '.ai-orchestrator/state.json')), false);
  writeFileSync(path.join(root, 'foreign.txt'), 'Owner data\n');
  const snapshot = await createTask(root, firstTask, { snapshot: true, run: 'run-explicit-snapshot' });
  assert.equal(snapshot.integrity.valid, true);
  const service = await WorkflowService.open({ root });
  const state = service.store.readRun('run-explicit-snapshot');
  const manifest = JSON.parse(readFileSync(path.join(state.sourceBundle, 'manifest.json')));
  assert.equal(manifest.entries.some((entry) => entry.path === 'foreign.txt'), false);
  service.close();
  assert.equal(readFileSync(path.join(root, 'foreign.txt'), 'utf8'), 'Owner data\n');
  assert.equal(readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), 'Owner changes remain\n');
  const b = fixture(t);
  initializeProject(b.root, options);
  writeFileSync(
    path.join(b.root, '.flowcairn.json'),
    readFileSync(path.join(b.root, '.flowcairn.json'), 'utf8') + ' ',
  );
  await assert.rejects(createTask(b.root, firstTask), { code: 'UNTRACKED_FILES' });
  assert.equal(existsSync(path.join(b.root, '.ai-orchestrator/state.json')), false);
  const c = fixture(t);
  initializeProject(c.root, options);
  writeFileSync(path.join(c.root, 'foreign.txt'), 'Explicitly selected\n');
  await createTask(c.root, { ...firstTask, includeUntracked: ['foreign.txt'] }, { snapshot: true, run: 'run-selected-untracked' });
  const selectedService = await WorkflowService.open({ root: c.root });
  const selectedState = selectedService.store.readRun('run-selected-untracked');
  const selectedManifest = JSON.parse(readFileSync(path.join(selectedState.sourceBundle, 'manifest.json')));
  assert.equal(selectedManifest.entries.some((entry) => entry.path === 'foreign.txt'), true);
  selectedService.close();
});

test('first graph refuses sensitive untracked files even when explicitly requested', async (t) => {
  const { root } = fixture(t);
  initializeProject(root, options);
  writeFileSync(path.join(root, '.env'), 'TEST_ONLY=not-a-secret\n');
  await assert.rejects(createTask(root, { ...firstTask, includeUntracked: ['.env'] }));
  assert.equal(existsSync(path.join(root, '.ai-orchestrator/state.json')), false);
});

test('mutation after source capture is refused before registry or run is created', async (t) => {
  const { root } = fixture(t);
  initializeProject(root, options);
  const originalOpen = WorkflowService.open;
  let opened;
  t.mock.method(WorkflowService, 'open', async (...args) => {
    const service = await originalOpen.apply(WorkflowService, args);
    opened = service;
    const capture = service.adapters.capture;
    service.adapters.capture = async (...input) => {
      const source = await capture(...input);
      writeFileSync(path.join(root, 'AGENTS.md'), 'Concurrent owner change\n');
      return source;
    };
    return service;
  });
  await assert.rejects(createTask(root, firstTask, { run: 'run-raced' }), {
    code: 'SOURCE_SNAPSHOT_MISMATCH',
  });
  assert.equal(existsSync(path.join(root, '.ai-orchestrator/state.json')), false);
  assert.equal(readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), 'Concurrent owner change\n');
  assert.deepEqual(opened.store.listRunIds(), []);
});

test('actual npm tarball install provides executable bin and offline npx init/task in a monorepo', async (t) => {
  const { root, git } = fixture(t);
  const npm = path.resolve(
    path.dirname(process.execPath),
    '../lib/node_modules/npm/bin/npm-cli.js',
  );
  const npx = path.resolve(
    path.dirname(process.execPath),
    '../lib/node_modules/npm/bin/npx-cli.js',
  );
  assert.ok(existsSync(npm) && existsSync(npx), 'Package verification requires Node with npm/npx');
  const runtimeRoot = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
  const env = {
    ...process.env,
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    npm_config_update_notifier: 'false',
  };
  const npmRun = (cwd, ...args) =>
    execFileSync(process.execPath, [npm, ...args], {
      cwd,
      env,
      encoding: 'utf8',
      timeout: 60000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const packed = JSON.parse(
    npmRun(runtimeRoot, 'pack', '--ignore-scripts', '--json', '--pack-destination', root),
  );
  const tarball = path.join(root, packed[0].filename);
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  pkg.workspaces = ['packages/*'];
  pkg.scripts.postinstall = "node -e \"require('node:fs').writeFileSync('forbidden-hook', 'ran')\"";
  writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
  mkdirSync(path.join(root, 'packages/app'), { recursive: true });
  writeFileSync(
    path.join(root, 'packages/app/package.json'),
    '{"name":"fixture-workspace","version":"1.0.0"}',
  );
  git('add', 'package.json', 'packages/app/package.json');
  git('commit', '-m', 'fixture workspace');
  const head = git('rev-parse', 'HEAD');
  const instructions = readFileSync(path.join(root, 'AGENTS.md'));
  // npm ci warms tarball content, not registry packuments. Use the repository's
  // locked production entries so this regression needs only that same npm cache.
  const runtimeLock = JSON.parse(readFileSync(path.join(runtimeRoot, 'package-lock.json'), 'utf8'));
  const runtimePackage = runtimeLock.packages[''];
  pkg.devDependencies = { flowcairn: `file:${tarball}` };
  writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
  writeFileSync(
    path.join(root, 'package-lock.json'),
    JSON.stringify({
      name: pkg.name,
      version: pkg.version,
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: pkg.name,
          version: pkg.version,
          workspaces: pkg.workspaces,
          devDependencies: pkg.devDependencies,
        },
        ...Object.fromEntries(
          Object.entries(runtimeLock.packages)
            .filter(([key, entry]) => key !== '' && !entry.dev)
            .map(([key, entry]) => [key, { ...entry, dev: true }]),
        ),
        'node_modules/flowcairn': {
          version: packed[0].version,
          resolved: `file:${tarball}`,
          integrity: packed[0].integrity,
          dev: true,
          dependencies: runtimePackage.dependencies,
          bin: runtimePackage.bin,
          engines: runtimePackage.engines,
        },
        'node_modules/fixture-workspace': { resolved: 'packages/app', link: true },
        'packages/app': { name: 'fixture-workspace', version: '1.0.0' },
      },
    }),
  );
  npmRun(root, 'ci', '--ignore-scripts', '--offline', '--no-audit', '--no-fund');
  rmSync(tarball);
  assert.equal(existsSync(path.join(root, 'forbidden-hook')), false);
  assert.equal(lstatSync(path.join(root, 'node_modules/.bin/flowcairn')).isSymbolicLink(), true);
  const direct = execFileSync(path.join(root, 'node_modules/.bin/flowcairn'), ['--version'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  assert.equal(direct.trim(), packed[0].version);
  // Verify the installed artifact, not the source checkout or browser preview.
  const presentation = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { printCard } from './node_modules/flowcairn/bin/terminal.mjs';
    printCard('Flowcairn', ['✓ Интерфейс запущен'], {
      output: { isTTY: true, columns: 32, write: value => process.stdout.write(value) },
      author: true, env: {},
    });
  `], { cwd: root, env, encoding: 'utf8' });
  assert.match(presentation, /╭/);
  assert.match(presentation, /╯/);
  assert.match(presentation, /Telegram автора/);
  assert.ok(presentation.includes('\x1b]8;;https://t.me/Babikov_build\x1b\\'));
  const run = (...args) =>
    spawnSync(process.execPath, [npx, '--offline', '--no', 'flowcairn', ...args], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 20000,
    });
  const missing = run('init', '--provider', 'openai');
  assert.equal(missing.status, 2);
  assert.equal(JSON.parse(missing.stderr).error.code, 'PROVIDER_UNSUPPORTED');
  assert.equal(existsSync(path.join(root, '.flowcairn.json')), false);
  const help = run('init', '--help');
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Быстрый старт/);
  assert.match(help.stdout, /начать настройку и открыть интерфейс/);
  assert.equal(existsSync(path.join(root, '.flowcairn.json')), false);
  const installed = run('init', '--provider', 'claude', '--provider-path', testClaude, '--json');
  assert.equal(installed.status, 0, installed.stderr);
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const viewer = spawn(path.join(root, 'node_modules/.bin/flowcairn'), ['--no-open', '--port', String(port)], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise((resolve) => viewer.once('close', resolve));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Bare CLI did not start the installed viewer')), 10000);
      let output = '';
      viewer.stdout.on('data', (chunk) => {
        output += chunk;
        if (output.includes(`http://127.0.0.1:${port}/#session=`)) { clearTimeout(timer); resolve(); }
      });
      viewer.once('error', (error) => { clearTimeout(timer); reject(error); });
      viewer.once('close', () => { clearTimeout(timer); reject(Error('Viewer exited before startup')); });
    });
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<html/i);
  } finally { viewer.kill('SIGTERM'); await closed; }
  assert.deepEqual(JSON.parse(installed.stdout).result.profile.manifests, [
    'package.json',
    'package-lock.json',
    'packages/app/package.json',
  ]);
  const repeated = run('init');
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, /Готово\. Flowcairn подготовлен/);
  const created = run(
    'task',
    '--id',
    firstTask.id,
    '--goal',
    firstTask.goal,
    '--scope',
    'README.md',
    '--accept',
    firstTask.acceptance[0],
    '--snapshot',
    '--include-untracked',
    'package-lock.json',
    '--run',
    'run-npm-install',
    '--json',
  );
  assert.equal(created.status, 0, created.stderr);
  const snapshot = JSON.parse(created.stdout).result;
  assert.equal(snapshot.status, 'waiting-for-human');
  assert.equal(snapshot.integrity.valid, true);
  assert.ok(snapshot.nodes.every((node) => node.attempt === 0));
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.deepEqual(readFileSync(path.join(root, 'AGENTS.md')), instructions);
});

test('task JSON accepts the documented explicit untracked CLI list without calling AI', (t) => {
  const { root } = fixture(t);
  initializeProject(root, options);
  writeFileSync(path.join(root, 'new.txt'), 'kept source');
  const spec = path.join(root, '.ai-orchestrator/input.json');
  writeFileSync(
    spec,
    JSON.stringify({
      id: 'ORCH-FILE',
      goal: 'Проверить файл',
      instructions: 'Прочитать файл',
      scope: ['new.txt'],
      acceptance: ['Файл учтен'],
      checks: [],
    }),
  );
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [
        fileURLToPath(new URL('../bin/flowcairn.mjs', import.meta.url)),
        'task',
        '--file',
        spec,
        '--include-untracked',
        'new.txt',
        '--snapshot',
        '--json',
      ],
      { cwd: root, encoding: 'utf8' },
    ),
  );
  assert.equal(result.ok, true);
  assert.equal(result.result.status, 'waiting-for-human');
  assert.ok(result.result.nodes.every((node) => node.attempt === 0));
  assert.equal(readFileSync(path.join(root, 'new.txt'), 'utf8'), 'kept source');
});
