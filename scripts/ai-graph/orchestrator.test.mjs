import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  allocateGraphWorkspace,
  replaceGraphBinding,
  verifyGraphWorkspace,
} from './lib/orchestrator.mjs';
import { captureSourceBundle } from './lib/source.mjs';
import { withGraphBindingFence } from '../ai-orchestrator.mjs';

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'ai-orchestrator.mjs',
);
const OWNER = 'graph-owner-1';

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function cli(root, command, options = {}, { fail = false } = {}) {
  const args = [SCRIPT, command, '--root', root];
  for (const [key, value] of Object.entries(options)) {
    if (value === false || value === undefined) continue;
    args.push(`--${key}`);
    if (value !== true) args.push(String(value));
  }
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CI: 'true' },
  });
  const channel = result.status === 0 ? result.stdout : result.stderr || result.stdout;
  const payload = JSON.parse(channel);
  if (fail) {
    assert.notEqual(result.status, 0, `${command} unexpectedly passed`);
  } else {
    assert.equal(result.status, 0, `${command} failed: ${channel}`);
  }
  return payload;
}

function taskSpec(id) {
  return {
    id,
    goal: 'Preserve the exact Graph source snapshot',
    instructions: ['Change only the owned source path.'],
    scope: ['src'],
    forbiddenPaths: ['.git', '.ai-orchestrator'],
    resources: ['graph-workspace'],
    checks: [['/usr/bin/test', '-f', 'src/value.txt']],
    limits: { maxAttempts: 2 },
  };
}

function fixture(t, { initialize = true, integrationBranch = 'develop' } = {}) {
  const base = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'flowcairn-graph-bridge-'));
  const root = path.join(base, 'repo');
  mkdirSync(root);
  execFileSync('git', ['init', '-b', integrationBranch, root]);
  git(root, 'config', 'user.name', 'Graph Bridge Test');
  git(root, 'config', 'user.email', 'graph-bridge@example.test');
  writeFileSync(path.join(root, '.gitignore'), '.ai-orchestrator/\n');
  writeFileSync(
    path.join(root, '.flowcairn.json'),
    JSON.stringify({
      version: 1,
      integrationBranch,
      packageManager: 'npm',
      contextPaths: [],
      checks: [],
      outputPaths: [],
      manifests: [],
      ai: { provider: 'codex', model: 'test-model' },
    }),
  );
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src', 'value.txt'), 'head\n');
  writeFileSync(path.join(root, 'src', 'deleted.txt'), 'delete me\n');
  writeFileSync(path.join(root, 'src', 'line\nfile.txt'), 'newline path\n');
  symlinkSync('value.txt', path.join(root, 'src', 'value-link'));
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'chore(test): initialize graph bridge fixture');
  const head = git(root, 'rev-parse', 'HEAD');
  const initializeRegistry = (bootstrapSourceBundle = undefined) => {
    cli(root, 'init', {
      owner: OWNER,
      goal: 'Test Graph bridge',
      mode: 'autonomous',
      'max-tasks': 4,
      'max-retries': 2,
      'max-workers': 2,
      'bootstrap-source-bundle': bootstrapSourceBundle,
    });
    const registrySpec = path.join(base, 'tasks.json');
    writeFileSync(
      registrySpec,
      `${JSON.stringify({
        id: 'GW01',
        title: 'Graph workspace bridge',
        outcome: 'An isolated source-bound workspace exists',
        why: 'Graph must reuse Orchestrator ownership',
        sourceDocs: [],
        scope: ['src'],
        resources: ['graph-workspace'],
        dependsOn: [],
        acceptance: ['The workspace preserves HEAD, index and worktree layers'],
        checks: [['/usr/bin/test', '-f', 'src/value.txt']],
        model: 'test-model',
        effort: 'medium',
      })}\n`,
    );
    cli(root, 'add', { owner: OWNER, spec: registrySpec });
  };
  if (initialize) initializeRegistry();
  t.after(() => {
    execFileSync('/bin/chmod', ['-R', 'u+w', base]);
    rmSync(base, { recursive: true, force: true });
  });
  return { base, root, head, task: taskSpec('GW01'), initializeRegistry };
}

function expectCode(callback, code) {
  assert.throws(callback, (error) => error?.code === code);
}

test('allocates one source-bound Orchestrator worktree and keeps Graph acceptance as handoff', (t) => {
  const { root, head, task, initializeRegistry } = fixture(t, { initialize: false });
  writeFileSync(path.join(root, 'src', 'value.txt'), 'index\n');
  git(root, 'add', 'src/value.txt');
  writeFileSync(path.join(root, 'src', 'value.txt'), 'worktree\n');
  unlinkSync(path.join(root, 'src', 'deleted.txt'));
  git(root, 'add', '--', 'src/deleted.txt');
  writeFileSync(path.join(root, 'allowed.txt'), 'allowed untracked\n');
  const sourceStore = path.join(root, '.ai-orchestrator', 'graph', 'sources');
  mkdirSync(path.dirname(sourceStore), { recursive: true, mode: 0o700 });
  const captured = captureSourceBundle(root, sourceStore, { allowedUntracked: ['allowed.txt'] });
  initializeRegistry(captured.bundlePath);
  const request = {
    root,
    runId: 'run-001',
    task,
    sourceBundle: captured.bundlePath,
    sourceHash: captured.manifest.sourceHash,
    owner: OWNER,
  };

  expectCode(
    () => allocateGraphWorkspace({ ...request, sourceHash: '0'.repeat(64) }),
    'SOURCE_HASH_MISMATCH',
  );
  expectCode(
    () => allocateGraphWorkspace({ ...request, task: { ...task, id: 'GW02' } }),
    'TASK_NOT_FOUND',
  );
  let state = JSON.parse(readFileSync(path.join(root, '.ai-orchestrator', 'state.json')));
  assert.equal(state.bootstrapSourceHash, captured.manifest.sourceHash);
  assert.equal(state.tasks[0].status, 'pending');
  assert.equal(state.tasks[0].attempts.length, 0);

  const binding = allocateGraphWorkspace(request);
  assert.equal(binding.taskId, 'GW01');
  assert.equal(binding.attemptId, 1);
  assert.equal(binding.runId, 'run-001');
  assert.equal(binding.owner, OWNER);
  assert.equal(binding.sourceHash, captured.manifest.sourceHash);
  assert.equal(binding.worktree.startsWith(path.join(root, '.ai-orchestrator', 'worktrees')), true);
  assert.equal(existsSync(path.join(binding.worktree, '.git')), true);
  assert.equal(git(binding.worktree, 'rev-parse', 'HEAD'), head);
  assert.equal(git(binding.worktree, 'show', ':src/value.txt'), 'index');
  assert.equal(readFileSync(path.join(binding.worktree, 'src', 'value.txt'), 'utf8'), 'worktree\n');
  assert.equal(
    readFileSync(path.join(binding.worktree, 'allowed.txt'), 'utf8'),
    'allowed untracked\n',
  );
  assert.equal(existsSync(path.join(binding.worktree, 'src', 'deleted.txt')), false);
  assert.equal(
    readFileSync(path.join(binding.worktree, 'src', 'line\nfile.txt'), 'utf8'),
    'newline path\n',
  );
  assert.equal(readlinkSync(path.join(binding.worktree, 'src', 'value-link')), 'value.txt');

  state = JSON.parse(readFileSync(path.join(root, '.ai-orchestrator', 'state.json')));
  assert.equal(state.tasks[0].status, 'active');
  assert.equal(state.tasks[0].merge, null);
  assert.equal(state.tasks[0].attempts[0].status, 'active');
  assert.equal(state.tasks[0].attempts[0].reportedSha, null);
  assert.equal(git(root, 'rev-parse', 'HEAD'), head);
  assert.deepEqual(allocateGraphWorkspace(request), binding);

  writeFileSync(path.join(binding.worktree, 'src', 'value.txt'), 'legitimate AI edit\n');
  assert.deepEqual(allocateGraphWorkspace({ ...request, existingBinding: binding }), binding);
  assert.equal(
    readFileSync(path.join(binding.worktree, 'src', 'value.txt'), 'utf8'),
    'legitimate AI edit\n',
  );
  const stateBeforeVerify = readFileSync(path.join(root, '.ai-orchestrator', 'state.json'), 'utf8');
  const controlEntriesBeforeVerify = readdirSync(path.join(root, '.ai-orchestrator')).sort();
  assert.deepEqual(verifyGraphWorkspace({ root, binding }), binding);
  assert.equal(
    readFileSync(path.join(root, '.ai-orchestrator', 'state.json'), 'utf8'),
    stateBeforeVerify,
  );
  assert.deepEqual(
    readdirSync(path.join(root, '.ai-orchestrator')).sort(),
    controlEntriesBeforeVerify,
  );

  const replanStore = path.join(root, '.ai-orchestrator', 'graph', 'replan-sources');
  const replanned = captureSourceBundle(binding.worktree, replanStore, {
    allowedUntracked: ['allowed.txt'],
  });
  const replacement = {
    root,
    binding,
    runId: 'run-001',
    newRunId: 'run-002',
    sourceHash: replanned.manifest.sourceHash,
    owner: OWNER,
  };
  expectCode(() => replaceGraphBinding(replacement), 'RUN_STOP_UNCONFIRMED');
  const rebound = replaceGraphBinding({ ...replacement, previousRunStopped: true });
  assert.equal(rebound.worktree, binding.worktree);
  assert.equal(rebound.attemptId, binding.attemptId);
  assert.equal(rebound.runId, 'run-002');
  assert.equal(rebound.sourceHash, replanned.manifest.sourceHash);
  assert.notEqual(rebound.leaseId, binding.leaseId);
  assert.equal(
    readFileSync(path.join(rebound.worktree, 'src', 'value.txt'), 'utf8'),
    'legitimate AI edit\n',
  );
  assert.deepEqual(replaceGraphBinding({ ...replacement, previousRunStopped: true }), rebound);
  expectCode(
    () =>
      replaceGraphBinding({
        ...replacement,
        binding: { ...binding, sourceHash: '1'.repeat(64) },
        previousRunStopped: true,
      }),
    'STALE_GRAPH_BINDING',
  );
  expectCode(
    () =>
      replaceGraphBinding({
        ...replacement,
        newRunId: 'run-003',
        previousRunStopped: true,
      }),
    'STALE_GRAPH_BINDING',
  );
  expectCode(() => verifyGraphWorkspace({ root, binding }), 'STALE_GRAPH_BINDING');
  assert.deepEqual(verifyGraphWorkspace({ root, binding: rebound }), rebound);

  cli(root, 'transfer', {
    owner: OWNER,
    'new-owner': 'graph-owner-2',
    reason: 'Test stale Graph owner fencing',
    'previous-owner-stopped': true,
  });
  expectCode(() => verifyGraphWorkspace({ root, binding: rebound }), 'STALE_GRAPH_OWNER');
});

test('normal registry never accepts a dirty Graph snapshot through request options', (t) => {
  const { root, task } = fixture(t);
  writeFileSync(path.join(root, 'src', 'value.txt'), 'dirty\n');
  const sourceStore = path.join(root, '.ai-orchestrator', 'graph', 'sources');
  mkdirSync(path.dirname(sourceStore), { recursive: true, mode: 0o700 });
  const captured = captureSourceBundle(root, sourceStore);
  const request = {
    root,
    runId: 'run-normal-policy',
    task,
    sourceBundle: captured.bundlePath,
    sourceHash: captured.manifest.sourceHash,
    owner: OWNER,
  };

  expectCode(() => allocateGraphWorkspace(request), 'DIRTY_ROOT');
  expectCode(
    () => allocateGraphWorkspace({ ...request, bootstrapDirtySnapshot: true }),
    'DIRTY_ROOT',
  );
  const state = JSON.parse(readFileSync(path.join(root, '.ai-orchestrator', 'state.json')));
  assert.equal(state.bootstrapSourceHash, null);
  assert.equal(state.tasks[0].status, 'pending');
  assert.equal(state.tasks[0].attempts.length, 0);
});

test('a reserved Graph attempt only accepts its lease-bound handle', (t) => {
  const { root } = fixture(t);
  const reservation = cli(root, 'graph-reserve', {
    owner: OWNER,
    task: 'GW01',
    run: 'run-guard',
    'source-hash': 'a'.repeat(64),
  });
  const rejected = cli(
    root,
    'bind',
    {
      owner: OWNER,
      task: 'GW01',
      attempt: reservation.attemptId,
      handle: 'unrelated-worker-handle',
    },
    { fail: true },
  );
  assert.equal(rejected.error.code, 'STALE_GRAPH_BINDING');
  const state = JSON.parse(readFileSync(path.join(root, '.ai-orchestrator', 'state.json')));
  assert.equal(state.tasks[0].status, 'reserved');
  assert.equal(state.tasks[0].attempts[0].handle, null);
});

test('write fence holds existing registry ownership until synchronous patch completes', (t) => {
  const { root, task } = fixture(t);
  mkdirSync(path.join(root, '.ai-orchestrator/graph'), { mode: 0o700 });
  const source = captureSourceBundle(root, path.join(root, '.ai-orchestrator/graph/sources'));
  const binding = allocateGraphWorkspace({
    root,
    task,
    runId: 'run-write-fence',
    owner: OWNER,
    sourceBundle: source.bundlePath,
    sourceHash: source.manifest.sourceHash,
  });
  let applied = 0;
  const result = withGraphBindingFence(root, binding, () => {
    const rejected = cli(
      root,
      'recover',
      {
        owner: OWNER,
        task: task.id,
        action: 'stop',
        'worker-stopped': true,
        reason: 'Concurrent revoke while patch owns the registry',
      },
      { fail: true },
    );
    assert.equal(rejected.error.code, 'REGISTRY_LOCKED');
    applied++;
    return 'patched';
  });
  assert.equal(result, 'patched');
  assert.equal(applied, 1);
  assert.equal(existsSync(path.join(root, '.ai-orchestrator/lock')), false);
  assert.throws(
    () =>
      withGraphBindingFence(root, binding, async () => {
        applied++;
      }),
    { code: 'INVALID_FENCE' },
  );
  cli(root, 'recover', {
    owner: OWNER,
    task: task.id,
    action: 'stop',
    'worker-stopped': true,
    reason: 'After patch',
  });
  assert.throws(
    () =>
      withGraphBindingFence(root, binding, () => {
        applied++;
      }),
    { code: 'STALE_GRAPH_BINDING' },
  );
  assert.equal(applied, 1);
});

test('configured main branch allocates and fences a source-bound workspace; profile drift stops it', (t) => {
  const { root, task } = fixture(t, { integrationBranch: 'main' });
  mkdirSync(path.join(root, '.ai-orchestrator', 'graph'), { recursive: true, mode: 0o700 });
  const captured = captureSourceBundle(
    root,
    path.join(root, '.ai-orchestrator', 'graph', 'sources'),
  );
  const binding = allocateGraphWorkspace({
    root,
    task,
    runId: 'run-main-profile',
    sourceBundle: captured.bundlePath,
    sourceHash: captured.manifest.sourceHash,
    owner: OWNER,
  });
  assert.equal(verifyGraphWorkspace({ root, binding }).leaseId, binding.leaseId);
  const profilePath = path.join(root, '.flowcairn.json');
  const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
  writeFileSync(profilePath, JSON.stringify({ ...profile, integrationBranch: 'changed' }));
  expectCode(() => verifyGraphWorkspace({ root, binding }), 'PROJECT_PROFILE_DRIFT');
});
