import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { captureSourceBundle } from './ai-graph/lib/source.mjs';
import { projectProfileHash } from './ai-graph/lib/project.mjs';
import { migrateProjectProfile } from './ai-orchestrator.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ai-orchestrator.mjs');
const OWNER = 'orchestrator-session-1';

function execute(command, args, { cwd, allowFailure = false, input } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, CI: 'true' },
    shell: false,
    input,
  });
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function git(repo, ...args) {
  return execute('git', ['-C', repo, ...args]).stdout.trim();
}

function cli(repo, command, options = {}, { fail = false } = {}) {
  const args = [SCRIPT, command, '--root', repo];
  for (const [key, value] of Object.entries(options)) {
    if (value === false || value === undefined) continue;
    args.push(`--${key}`);
    if (value !== true) args.push(String(value));
  }
  const result = execute(process.execPath, args, { cwd: repo, allowFailure: true });
  const channel = result.status === 0 ? result.stdout : result.stderr || result.stdout;
  let parsed;
  try {
    parsed = JSON.parse(channel);
  } catch {
    throw new Error(
      `Invalid CLI JSON (status ${result.status})\nstdout=${result.stdout}\nstderr=${result.stderr}`,
    );
  }
  if (fail) {
    assert.notEqual(result.status, 0, `Expected ${command} to fail`);
    assert.equal(parsed.ok, false);
  } else {
    assert.equal(result.status, 0, `${command} failed: ${JSON.stringify(parsed)}`);
    assert.equal(parsed.ok, true);
  }
  return { ...parsed, processStatus: result.status };
}

function fixture(t, { mode = 'autonomous', maxTasks = 8, maxRetries = 2, maxWorkers = 3 } = {}) {
  const base = mkdtempSync(path.join(tmpdir(), 'flowcairn-orchestrator-'));
  const repo = path.join(base, 'repo');
  mkdirSync(repo);
  execute('git', ['init', '-b', 'develop', repo]);
  git(repo, 'config', 'user.name', 'Orchestrator Test');
  git(repo, 'config', 'user.email', 'orchestrator@example.test');
  writeFileSync(path.join(repo, '.gitignore'), '.ai-orchestrator/\n');
  writeFileSync(
    path.join(repo, '.flowcairn.json'),
    JSON.stringify({
      version: 1,
      integrationBranch: 'develop',
      packageManager: 'npm',
      contextPaths: [],
      checks: [],
      outputPaths: [],
      manifests: [],
      ai: { provider: 'codex', model: 'test-model' },
    }),
  );
  writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
  mkdirSync(path.join(repo, 'area'), { recursive: true });
  writeFileSync(path.join(repo, 'area', '.keep'), 'tracked\n');
  mkdirSync(path.join(repo, 'other'), { recursive: true });
  writeFileSync(path.join(repo, 'other', '.keep'), 'tracked\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'chore(test): создал тестовый репозиторий', '-m', 'Refs: ORCH-SETUP');
  cli(repo, 'init', {
    owner: OWNER,
    goal: 'Проверить безопасную локальную интеграцию',
    mode,
    'max-tasks': maxTasks,
    'max-retries': maxRetries,
    'max-workers': maxWorkers,
  });
  t.after(() => {
    execute('/bin/chmod', ['-R', 'u+w', base], { allowFailure: true });
    rmSync(base, { recursive: true, force: true });
  });
  return { base, repo };
}

function uninitializedFixture(t, name, readme = `${name}\n`) {
  const base = mkdtempSync(path.join(realpathSync(tmpdir()), `flowcairn-orchestrator-${name}-`));
  const repo = path.join(base, 'repo');
  mkdirSync(repo);
  execute('git', ['init', '-b', 'develop', repo]);
  git(repo, 'config', 'user.name', 'Orchestrator Test');
  git(repo, 'config', 'user.email', 'orchestrator@example.test');
  writeFileSync(path.join(repo, '.gitignore'), '.ai-orchestrator/\n');
  writeFileSync(
    path.join(repo, '.flowcairn.json'),
    JSON.stringify({
      version: 1,
      integrationBranch: 'develop',
      packageManager: 'npm',
      contextPaths: [],
      checks: [],
      outputPaths: [],
      manifests: [],
      ai: { provider: 'codex', model: 'test-model' },
    }),
  );
  writeFileSync(path.join(repo, 'README.md'), readme);
  mkdirSync(path.join(repo, 'area'));
  writeFileSync(path.join(repo, 'area', '.keep'), 'tracked\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', `chore(test): ${name}`, '-m', 'Refs: ORCH-BOOT');
  t.after(() => {
    execute('/bin/chmod', ['-R', 'u+w', base], { allowFailure: true });
    rmSync(base, { recursive: true, force: true });
  });
  return { base, repo };
}

function initOptions(overrides = {}) {
  return {
    owner: OWNER,
    goal: 'Проверить bootstrap immutable source',
    mode: 'autonomous',
    'max-tasks': 4,
    'max-retries': 2,
    'max-workers': 2,
    ...overrides,
  };
}

test('dirty bootstrap requires one exact immutable source authorization', (t) => {
  const source = uninitializedFixture(t, 'bootstrap-source', 'source head\n');
  const other = uninitializedFixture(t, 'bootstrap-other', 'different head\n');
  const clean = uninitializedFixture(t, 'bootstrap-clean', 'clean head\n');

  writeFileSync(path.join(source.repo, 'README.md'), 'authorized dirty source\n');
  const sourceStore = path.join(source.repo, '.ai-orchestrator', 'graph', 'sources');
  mkdirSync(path.dirname(sourceStore), { recursive: true, mode: 0o700 });
  const captured = captureSourceBundle(source.repo, sourceStore);

  const wrongRoot = cli(
    other.repo,
    'init',
    initOptions({ 'bootstrap-source-bundle': captured.bundlePath }),
    { fail: true },
  );
  assert.equal(wrongRoot.error.code, 'SOURCE_HEAD_MISMATCH');
  assert.equal(existsSync(path.join(other.repo, '.ai-orchestrator', 'state.json')), false);

  writeFileSync(path.join(source.repo, 'README.md'), 'drift after capture\n');
  const drift = cli(
    source.repo,
    'init',
    initOptions({ 'bootstrap-source-bundle': captured.bundlePath }),
    { fail: true },
  );
  assert.equal(drift.error.code, 'SOURCE_SNAPSHOT_MISMATCH');
  assert.equal(existsSync(path.join(source.repo, '.ai-orchestrator', 'state.json')), false);

  writeFileSync(path.join(source.repo, 'README.md'), 'authorized dirty source\n');
  writeFileSync(path.join(source.repo, 'unexpected.txt'), 'unselected local scratch\n');
  const initialized = cli(
    source.repo,
    'init',
    initOptions({ 'bootstrap-source-bundle': captured.bundlePath }),
  );
  assert.equal(initialized.state.bootstrapSourceHash, captured.manifest.sourceHash);
  assert.equal(readFileSync(path.join(source.repo, 'unexpected.txt'), 'utf8'), 'unselected local scratch\n');
  assert.equal(captured.manifest.entries.some((entry) => entry.path === 'unexpected.txt'), false);
  addTasks(source.base, source.repo, taskSpec('ORCH-BOOT'));

  const unauthorizedFlag = cli(
    source.repo,
    'graph-reserve',
    {
      owner: OWNER,
      task: 'ORCH-BOOT',
      run: 'run-public-bypass',
      'source-hash': 'f'.repeat(64),
      'bootstrap-dirty-snapshot': true,
    },
    { fail: true },
  );
  assert.equal(unauthorizedFlag.error.code, 'BOOTSTRAP_SOURCE_MISMATCH');

  const wrongHash = cli(
    source.repo,
    'graph-reserve',
    {
      owner: OWNER,
      task: 'ORCH-BOOT',
      run: 'run-wrong-source',
      'source-hash': 'f'.repeat(64),
    },
    { fail: true },
  );
  assert.equal(wrongHash.error.code, 'DIRTY_ROOT');

  const missingInternalFlag = cli(
    source.repo,
    'graph-reserve',
    {
      owner: OWNER,
      task: 'ORCH-BOOT',
      run: 'run-without-internal-flag',
      'source-hash': captured.manifest.sourceHash,
    },
    { fail: true },
  );
  assert.equal(missingInternalFlag.error.code, 'DIRTY_ROOT');

  const reserved = cli(source.repo, 'graph-reserve', {
    owner: OWNER,
    task: 'ORCH-BOOT',
    run: 'run-authorized-source',
    'source-hash': captured.manifest.sourceHash,
    'bootstrap-dirty-snapshot': true,
  });
  assert.equal(reserved.sourceHash, captured.manifest.sourceHash);
  const state = JSON.parse(readFileSync(path.join(source.repo, '.ai-orchestrator', 'state.json')));
  assert.equal(state.tasks[0].attempts[0].graphBinding.bootstrapDirtySnapshot, true);

  const normal = cli(clean.repo, 'init', initOptions());
  assert.equal(normal.state.bootstrapSourceHash, null);
});

function taskSpec(
  id,
  {
    scope = ['area'],
    resources = [],
    dependsOn = [],
    file = 'area/result.txt',
    checks = [['/bin/test', '-f', file]],
    priority = 100,
  } = {},
) {
  return {
    id,
    title: `Task ${id}`,
    outcome: `Create ${file}`,
    why: 'Exercise an observable isolated Git change',
    sourceDocs: ['README.md'],
    scope,
    resources,
    dependsOn,
    acceptance: [`${file} exists in develop`],
    checks,
    checkTimeoutMs: 10_000,
    priority,
    model: 'test-model',
    effort: 'medium',
  };
}

function addTasks(base, repo, specs, name = 'tasks.json') {
  const specPath = path.join(base, name);
  writeFileSync(specPath, `${JSON.stringify(specs, null, 2)}\n`);
  return cli(repo, 'add', { owner: OWNER, spec: specPath });
}

function claimBind(
  repo,
  id,
  worker = `worker-${id.toLowerCase()}`,
  handle = `handle-${id.toLowerCase()}`,
) {
  const claimed = cli(repo, 'claim', { owner: OWNER, task: id, worker });
  const attempt = claimed.attempt.number;
  cli(repo, 'bind', { owner: OWNER, task: id, attempt, handle });
  return { ...claimed.attempt, worker, handle };
}

function commitWorker(base, repo, id, attempt, changes) {
  for (const [relative, content] of Object.entries(changes)) {
    const target = path.join(attempt.worktree, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  git(attempt.worktree, 'add', '.');
  git(
    attempt.worktree,
    'commit',
    '-m',
    `feat(test): выполнил ${id.toLowerCase()}`,
    '-m',
    `Refs: ${id}`,
  );
  const commit = git(attempt.worktree, 'rev-parse', 'HEAD');
  const changedFiles = Object.keys(changes).sort();
  const resultPath = path.join(base, `${id}-${attempt.number}-result.json`);
  writeFileSync(
    resultPath,
    `${JSON.stringify(
      {
        outcome: `Implemented ${id}`,
        changedFiles,
        selfReview: 'Diff is limited to the assigned behavior.',
        checks: ['Worker reports its local self-check; helper reruns required checks.'],
        acceptance: ['Requested file exists.'],
        limitations: [],
        nextStep: 'Orchestrator must verify and integrate the exact commit.',
      },
      null,
      2,
    )}\n`,
  );
  const reported = cli(repo, 'report', {
    owner: OWNER,
    task: id,
    attempt: attempt.number,
    handle: attempt.handle,
    commit,
    'result-file': resultPath,
  });
  return { commit, resultPath, reported };
}

function verifyBuildAndIntegrate(repo, id, attempt, reviewer = `reviewer-${id.toLowerCase()}`) {
  cli(repo, 'check', { owner: OWNER, task: id, attempt: attempt.number, phase: 'worker' });
  const built = cli(repo, 'candidate', { owner: OWNER, task: id, attempt: attempt.number });
  cli(repo, 'check', { owner: OWNER, task: id, attempt: attempt.number, phase: 'candidate' });
  cli(repo, 'review', {
    owner: OWNER,
    task: id,
    attempt: attempt.number,
    reviewer,
    commit: built.candidate.sha,
    verdict: 'pass',
    summary: 'Acceptance and diff were independently checked.',
  });
  const integrated = cli(repo, 'integrate', { owner: OWNER, task: id, attempt: attempt.number });
  return { built, integrated };
}

test('real temp Git happy path verifies merge before opening a dependent task', (t) => {
  const { base, repo } = fixture(t);
  addTasks(base, repo, [
    taskSpec('ORCH-001', { file: 'area/first.txt', priority: 2 }),
    taskSpec('ORCH-002', { dependsOn: ['ORCH-001'], file: 'area/second.txt', priority: 1 }),
  ]);

  assert.deepEqual(cli(repo, 'next', { owner: OWNER }).ready, ['ORCH-001']);
  const first = claimBind(repo, 'ORCH-001');
  const prompt = cli(repo, 'prompt', { owner: OWNER, task: 'ORCH-001', attempt: first.number });
  assert.match(prompt.prompt, new RegExp(first.worktree.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const worker = commitWorker(base, repo, 'ORCH-001', first, { 'area/first.txt': 'first\n' });

  const beforeMerge = cli(repo, 'status');
  assert.equal(beforeMerge.tasks.find((entry) => entry.id === 'ORCH-001').status, 'reported');
  assert.notEqual(
    git(repo, 'rev-parse', 'develop'),
    worker.commit,
    'a Worker commit is not done by itself',
  );
  assert.deepEqual(cli(repo, 'next', { owner: OWNER }).ready, []);

  const { built } = verifyBuildAndIntegrate(repo, 'ORCH-001', first);
  assert.equal(built.candidate.sha, worker.commit, 'linear candidate must reuse the Worker SHA');
  assert.equal(git(repo, 'rev-parse', 'develop'), built.candidate.sha);
  assert.equal(git(repo, 'merge-base', '--is-ancestor', worker.commit, 'develop'), '');
  assert.deepEqual(cli(repo, 'next', { owner: OWNER }).ready, ['ORCH-002']);
  const graphAfterMerge = cli(repo, 'graph');
  assert.equal(graphAfterMerge.nodes[0].mergeStillInDevelop, true);
  assert.equal(graphAfterMerge.nodes[1].dependenciesIntegrated, true);
  assert.equal(readFileSync(path.join(repo, 'area', 'first.txt'), 'utf8'), 'first\n');
});

test('divergent candidate uses compliant tooling scope and preserves a named ORCH reference', (t) => {
  const { base, repo } = fixture(t);
  const id = 'ORCH-NAMED-CANDIDATE';
  addTasks(base, repo, taskSpec(id, { file: 'area/named.txt' }));
  const attempt = claimBind(repo, id);
  const worker = commitWorker(base, repo, id, attempt, { 'area/named.txt': 'worker\n' });
  cli(repo, 'check', { owner: OWNER, task: id, attempt: attempt.number, phase: 'worker' });
  writeFileSync(path.join(repo, 'other', 'develop.txt'), 'develop\n');
  git(repo, 'add', 'other/develop.txt');
  git(repo, 'commit', '-m', 'test(test): сдвинул develop', '-m', `Refs: ${id}`);
  const built = cli(repo, 'candidate', { owner: OWNER, task: id, attempt: attempt.number });
  assert.notEqual(built.candidate.sha, worker.commit);
  assert.equal(
    git(built.candidate.worktree, 'show', '-s', '--format=%s', built.candidate.sha),
    'chore(tooling): интегрировал задачу orch-named-candidate',
  );
  const body = git(built.candidate.worktree, 'show', '-s', '--format=%b', built.candidate.sha);
  assert.match(body, /^Refs: ORCH-NAMED-CANDIDATE$/m);
  assert.doesNotMatch(body, /ORCH-ORCH-/);
});

test('configured hooks path blocks candidate until ready and invokes the native merge hook', (t) => {
  const { base, repo } = fixture(t);
  const id = 'ORCH-102';
  addTasks(base, repo, taskSpec(id, { file: 'area/hook.txt' }));
  const attempt = claimBind(repo, id);
  commitWorker(base, repo, id, attempt, { 'area/hook.txt': 'worker\n' });
  cli(repo, 'check', { owner: OWNER, task: id, attempt: attempt.number, phase: 'worker' });
  writeFileSync(path.join(repo, 'other', 'hook-base.txt'), 'develop\n');
  git(repo, 'add', 'other/hook-base.txt');
  git(repo, 'commit', '-m', 'test(test): подготовил divergent base', '-m', `Refs: ${id}`);
  const hooks = path.join(base, 'configured-hooks');
  const marker = path.join(base, 'native-hook-invoked');
  git(repo, 'config', 'core.hooksPath', hooks);

  const missing = cli(
    repo,
    'candidate',
    { owner: OWNER, task: id, attempt: attempt.number },
    { fail: true },
  );
  assert.equal(missing.error.code, 'HOOKS_NOT_READY');
  const stateFile = path.join(repo, '.ai-orchestrator/state.json');
  const retained = JSON.parse(readFileSync(stateFile, 'utf8')).tasks[0].candidates[0];
  assert.equal(retained.status, 'creating');
  mkdirSync(hooks, { recursive: true });
  writeFileSync(path.join(hooks, 'pre-merge-commit'), `#!/bin/sh\nprintf invoked > '${marker}'\n`, {
    mode: 0o755,
  });

  const built = cli(repo, 'candidate', { owner: OWNER, task: id, attempt: attempt.number });
  assert.equal(built.candidate.status, 'built');
  assert.equal(readFileSync(marker, 'utf8'), 'invoked');
});

test('graph plan can be inspected without creating a live registry or accepting claimed status', (t) => {
  const base = mkdtempSync(path.join(tmpdir(), 'flowcairn-graph-plan-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  execute('git', ['init', '-b', 'develop', base]);
  git(base, 'config', 'user.name', 'Graph Test');
  git(base, 'config', 'user.email', 'graph@example.test');
  git(base, 'commit', '--allow-empty', '-m', 'fixture');
  writeFileSync(
    path.join(base, '.flowcairn.json'),
    JSON.stringify({
      version: 1,
      integrationBranch: 'develop',
      packageManager: 'npm',
      contextPaths: [],
      checks: [],
      outputPaths: [],
      manifests: [],
      ai: { provider: 'codex', model: 'test-model' },
    }),
  );
  const plan = path.join(base, 'plan.json');
  writeFileSync(
    plan,
    JSON.stringify({
      version: 1,
      nodes: [
        { id: 'PLAN-001', title: 'Example', dependsOn: [], status: 'done' },
        { id: 'PLAN-002', title: 'Dependent', dependsOn: ['PLAN-001'] },
      ],
    }),
  );
  const result = cli(base, 'graph', { plan });
  assert.equal(result.execution, 'plan-inspection-only');
  assert.equal(result.nodes[0].recordedStatus, 'not-started');
  assert.equal(result.nodes[1].dependenciesIntegrated, false);
  assert.equal(existsSync(path.join(base, '.ai-orchestrator')), false);
  assert.equal(cli(base, 'graph', {}, { fail: true }).error.code, 'STATE_MISSING');
  assert.equal(existsSync(path.join(base, '.ai-orchestrator')), false);
});

test('graph displays a diamond without changing registry, Git or worktrees', (t) => {
  const { base, repo } = fixture(t);
  addTasks(base, repo, [
    taskSpec('ORCH-101'),
    taskSpec('ORCH-102', { dependsOn: ['ORCH-101'] }),
    taskSpec('ORCH-103', { dependsOn: ['ORCH-101'] }),
    taskSpec('ORCH-104', { dependsOn: ['ORCH-102', 'ORCH-103'] }),
  ]);
  const statePath = path.join(repo, '.ai-orchestrator/state.json');
  const before = readFileSync(statePath, 'utf8');
  const refs = git(repo, 'show-ref');
  const worktrees = git(repo, 'worktree', 'list', '--porcelain');
  const result = cli(repo, 'graph');
  assert.deepEqual(result.layers, [['ORCH-101'], ['ORCH-102', 'ORCH-103'], ['ORCH-104']]);
  assert.equal(result.edges.length, 4);
  assert.deepEqual(result.edges[0], { from: 'ORCH-101', to: 'ORCH-102' });
  assert.match(result.mermaid, /n1 --> n3/);
  assert.equal(
    result.layersAreParallelBatches,
    false,
    'shared scopes are not a safe parallel batch',
  );
  assert.equal(result.nodes[3].dependenciesIntegrated, false);
  assert.equal(readFileSync(statePath, 'utf8'), before);
  assert.equal(git(repo, 'show-ref'), refs);
  assert.equal(git(repo, 'worktree', 'list', '--porcelain'), worktrees);
  cli(repo, 'close', { owner: OWNER, status: 'paused', reason: 'graph test' });
  assert.equal(cli(repo, 'graph').runStatus, 'paused');
  assert.deepEqual(cli(repo, 'next').ready, []);
});

test('graph supports empty state and rejects corrupted dependencies without repairs', (t) => {
  const { base, repo } = fixture(t);
  assert.deepEqual(cli(repo, 'graph').layers, []);
  addTasks(base, repo, [taskSpec('ORCH-201'), taskSpec('ORCH-202')]);
  const statePath = path.join(repo, '.ai-orchestrator/state.json');
  const original = JSON.parse(readFileSync(statePath, 'utf8'));
  for (const [mutate, code] of [
    [
      (s) => {
        s.tasks[0].dependsOn = ['ORCH-999'];
      },
      'MISSING_DEPENDENCY',
    ],
    [
      (s) => {
        s.tasks[0].dependsOn = ['ORCH-201'];
      },
      'CYCLIC_DEPENDENCY',
    ],
    [
      (s) => {
        s.tasks[0].dependsOn = ['ORCH-202'];
        s.tasks[1].dependsOn = ['ORCH-201'];
      },
      'CYCLIC_DEPENDENCY',
    ],
    [
      (s) => {
        s.tasks[1].id = s.tasks[0].id;
      },
      'STATE_INVALID',
    ],
    [
      (s) => {
        s.tasks[0].dependsOn = null;
      },
      'STATE_INVALID',
    ],
  ]) {
    const state = structuredClone(original);
    mutate(state);
    const bytes = JSON.stringify(state);
    writeFileSync(statePath, bytes);
    assert.equal(cli(repo, 'graph', {}, { fail: true }).error.code, code);
    assert.equal(readFileSync(statePath, 'utf8'), bytes);
  }
});

test('graph does not equate a recorded done label with integrated work', (t) => {
  const { base, repo } = fixture(t);
  addTasks(base, repo, [taskSpec('ORCH-301'), taskSpec('ORCH-302', { dependsOn: ['ORCH-301'] })]);
  const statePath = path.join(repo, '.ai-orchestrator/state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  state.tasks[0].status = 'done';
  state.tasks[0].merge = { workerSha: '0'.repeat(40), developSha: '0'.repeat(40) };
  writeFileSync(statePath, JSON.stringify(state));
  const result = cli(repo, 'graph');
  assert.equal(result.nodes[0].recordedStatus, 'done');
  assert.equal(result.nodes[0].mergeStillInDevelop, false);
  assert.equal(result.nodes[1].dependenciesIntegrated, false);
});

test('active path and semantic resource ownership blocks overlapping claims', (t) => {
  const { base, repo } = fixture(t);
  addTasks(base, repo, [
    taskSpec('ORCH-101', { scope: ['area'], resources: ['voice-contract'], file: 'area/a.txt' }),
    taskSpec('ORCH-102', { scope: ['area/nested'], file: 'area/nested/b.txt' }),
    taskSpec('ORCH-103', { scope: ['other'], resources: ['voice-contract'], file: 'other/c.txt' }),
  ]);
  claimBind(repo, 'ORCH-101');
  assert.equal(
    cli(repo, 'claim', { owner: OWNER, task: 'ORCH-102', worker: 'worker-102' }, { fail: true })
      .error.code,
    'LOCK_CONFLICT',
  );
  assert.equal(
    cli(repo, 'claim', { owner: OWNER, task: 'ORCH-103', worker: 'worker-103' }, { fail: true })
      .error.code,
    'LOCK_CONFLICT',
  );
});

test('task batches reject missing and cyclic dependencies atomically', (t) => {
  const { base, repo } = fixture(t);
  const missingPath = path.join(base, 'missing.json');
  writeFileSync(missingPath, JSON.stringify(taskSpec('ORCH-201', { dependsOn: ['ORCH-999'] })));
  assert.equal(
    cli(repo, 'add', { owner: OWNER, spec: missingPath }, { fail: true }).error.code,
    'MISSING_DEPENDENCY',
  );

  const cyclePath = path.join(base, 'cycle.json');
  writeFileSync(
    cyclePath,
    JSON.stringify([
      taskSpec('ORCH-202', { dependsOn: ['ORCH-203'] }),
      taskSpec('ORCH-203', { dependsOn: ['ORCH-202'] }),
    ]),
  );
  assert.equal(
    cli(repo, 'add', { owner: OWNER, spec: cyclePath }, { fail: true }).error.code,
    'CYCLIC_DEPENDENCY',
  );
  assert.deepEqual(cli(repo, 'status').tasks, []);
});

test('failed worker checks and failed candidate review both block integration', (t) => {
  const { base, repo } = fixture(t);
  addTasks(base, repo, [
    taskSpec('ORCH-301', { file: 'area/missing.txt' }),
    taskSpec('ORCH-302', { scope: ['other'], file: 'other/review.txt' }),
  ]);

  const failedCheck = claimBind(repo, 'ORCH-301');
  commitWorker(base, repo, 'ORCH-301', failedCheck, { 'area/different.txt': 'different\n' });
  const check = cli(
    repo,
    'check',
    {
      owner: OWNER,
      task: 'ORCH-301',
      attempt: failedCheck.number,
      phase: 'worker',
    },
    { fail: true },
  );
  assert.equal(check.processStatus, 2);
  assert.equal(
    cli(
      repo,
      'candidate',
      { owner: OWNER, task: 'ORCH-301', attempt: failedCheck.number },
      { fail: true },
    ).error.code,
    'CHECK_REQUIRED',
  );

  const failedReview = claimBind(repo, 'ORCH-302');
  commitWorker(base, repo, 'ORCH-302', failedReview, { 'other/review.txt': 'review\n' });
  cli(repo, 'check', {
    owner: OWNER,
    task: 'ORCH-302',
    attempt: failedReview.number,
    phase: 'worker',
  });
  const built = cli(repo, 'candidate', {
    owner: OWNER,
    task: 'ORCH-302',
    attempt: failedReview.number,
  });
  cli(repo, 'check', {
    owner: OWNER,
    task: 'ORCH-302',
    attempt: failedReview.number,
    phase: 'candidate',
  });
  const review = cli(
    repo,
    'review',
    {
      owner: OWNER,
      task: 'ORCH-302',
      attempt: failedReview.number,
      reviewer: 'independent-reviewer',
      commit: built.candidate.sha,
      verdict: 'fail',
      summary: 'Acceptance evidence is insufficient.',
    },
    { fail: true },
  );
  assert.equal(review.processStatus, 2);
  assert.equal(
    cli(
      repo,
      'integrate',
      { owner: OWNER, task: 'ORCH-302', attempt: failedReview.number },
      { fail: true },
    ).error.code,
    'REVIEW_REQUIRED',
  );
});

test('moved develop invalidates a candidate and a new revision can be rebuilt', (t) => {
  const { base, repo } = fixture(t);
  addTasks(base, repo, taskSpec('ORCH-401', { file: 'area/moved.txt' }));
  const attempt = claimBind(repo, 'ORCH-401');
  commitWorker(base, repo, 'ORCH-401', attempt, { 'area/moved.txt': 'worker\n' });
  cli(repo, 'check', { owner: OWNER, task: 'ORCH-401', attempt: attempt.number, phase: 'worker' });
  const first = cli(repo, 'candidate', { owner: OWNER, task: 'ORCH-401', attempt: attempt.number });
  cli(repo, 'check', {
    owner: OWNER,
    task: 'ORCH-401',
    attempt: attempt.number,
    phase: 'candidate',
  });
  cli(repo, 'review', {
    owner: OWNER,
    task: 'ORCH-401',
    attempt: attempt.number,
    reviewer: 'reviewer-401',
    commit: first.candidate.sha,
    verdict: 'pass',
    summary: 'First candidate passed before develop moved.',
  });

  writeFileSync(path.join(repo, 'README.md'), 'fixture moved\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-m', 'docs(test): сдвинул develop', '-m', 'Refs: ORCH-401');
  const invalidated = cli(
    repo,
    'integrate',
    { owner: OWNER, task: 'ORCH-401', attempt: attempt.number },
    { fail: true },
  );
  assert.equal(invalidated.processStatus, 2);

  const second = cli(repo, 'candidate', {
    owner: OWNER,
    task: 'ORCH-401',
    attempt: attempt.number,
  });
  assert.equal(second.candidate.revision, 2);
  assert.notEqual(second.candidate.sha, first.candidate.sha);
  cli(repo, 'check', {
    owner: OWNER,
    task: 'ORCH-401',
    attempt: attempt.number,
    phase: 'candidate',
  });
  cli(repo, 'review', {
    owner: OWNER,
    task: 'ORCH-401',
    attempt: attempt.number,
    reviewer: 'reviewer-401b',
    commit: second.candidate.sha,
    verdict: 'pass',
    summary: 'Rebuilt candidate was checked on the new develop base.',
  });
  cli(repo, 'integrate', { owner: OWNER, task: 'ORCH-401', attempt: attempt.number });
});

test('out-of-scope changes and a dirty canonical root fail closed', (t) => {
  const { base, repo } = fixture(t);
  addTasks(base, repo, [
    taskSpec('ORCH-501', { file: 'area/scoped.txt' }),
    taskSpec('ORCH-502', { scope: ['other'], file: 'other/clean.txt' }),
  ]);
  const attempt = claimBind(repo, 'ORCH-501');
  const committed = commitWorkerWithoutReport(base, repo, 'ORCH-501', attempt, {
    'area/scoped.txt': 'allowed\n',
    'README.md': 'not allowed\n',
  });
  const report = cli(
    repo,
    'report',
    {
      owner: OWNER,
      task: 'ORCH-501',
      attempt: attempt.number,
      handle: attempt.handle,
      commit: committed.commit,
      'result-file': committed.resultPath,
    },
    { fail: true },
  );
  assert.equal(report.error.code, 'SCOPE_VIOLATION');

  writeFileSync(path.join(repo, 'dirty.txt'), 'dirty\n');
  assert.equal(
    cli(repo, 'claim', { owner: OWNER, task: 'ORCH-502', worker: 'worker-502' }, { fail: true })
      .error.code,
    'DIRTY_ROOT',
  );
});

function commitWorkerWithoutReport(base, repo, id, attempt, changes) {
  for (const [relative, content] of Object.entries(changes)) {
    const target = path.join(attempt.worktree, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  git(attempt.worktree, 'add', '.');
  git(
    attempt.worktree,
    'commit',
    '-m',
    `feat(test): изменил ${id.toLowerCase()}`,
    '-m',
    `Refs: ${id}`,
  );
  const commit = git(attempt.worktree, 'rev-parse', 'HEAD');
  const resultPath = path.join(base, `${id}-raw-result.json`);
  writeFileSync(
    resultPath,
    JSON.stringify({
      outcome: `Implemented ${id}`,
      changedFiles: Object.keys(changes).sort(),
      selfReview: 'Reviewed.',
      checks: [],
      acceptance: [],
      limitations: [],
      nextStep: 'Verify.',
    }),
  );
  return { commit, resultPath };
}

test('stopped-worker recovery rejects stale reports and records a new routing choice', (t) => {
  const { base, repo } = fixture(t, { maxRetries: 2 });
  addTasks(base, repo, taskSpec('ORCH-601', { file: 'area/retry.txt' }));
  const first = claimBind(repo, 'ORCH-601', 'worker-old', 'handle-old');
  const oldCommit = commitWorkerWithoutReport(base, repo, 'ORCH-601', first, {
    'area/retry.txt': 'old\n',
  });
  const recovery = cli(repo, 'recover', {
    owner: OWNER,
    task: 'ORCH-601',
    action: 'retry',
    'worker-stopped': true,
    reason: 'Native worker was explicitly stopped after losing context.',
    model: 'stronger-test-model',
    effort: 'high',
    'routing-reason': 'Previous attempt lost context and needs stronger synthesis.',
  });
  assert.equal(recovery.nextRouting.model, 'stronger-test-model');
  assert.equal(
    cli(repo, 'prompt', { task: 'ORCH-601', attempt: first.number }, { fail: true }).error.code,
    'STALE_ATTEMPT',
  );
  const stale = cli(
    repo,
    'report',
    {
      owner: OWNER,
      task: 'ORCH-601',
      attempt: first.number,
      handle: first.handle,
      commit: oldCommit.commit,
      'result-file': oldCommit.resultPath,
    },
    { fail: true },
  );
  assert.equal(stale.error.code, 'STALE_ATTEMPT');

  const second = claimBind(repo, 'ORCH-601', 'worker-new', 'handle-new');
  assert.equal(second.number, 2);
  assert.equal(second.model, 'stronger-test-model');
  assert.equal(second.effort, 'high');
  const prompt = cli(repo, 'prompt', { task: 'ORCH-601', attempt: second.number });
  assert.match(prompt.prompt, /stronger-test-model \/ high/);
});

test('review mode retains a draft and rejects committed integration commands', (t) => {
  const { base, repo } = fixture(t, { mode: 'review' });
  addTasks(base, repo, taskSpec('ORCH-101', { file: 'area/draft.txt' }));
  const attempt = claimBind(repo, 'ORCH-101');
  const resultPath = path.join(base, 'draft-result.json');
  writeFileSync(
    resultPath,
    JSON.stringify({
      outcome: 'Prepared a draft without a commit.',
      changedFiles: [],
      selfReview: 'Draft reviewed.',
      checks: ['No committed check receipt.'],
      acceptance: ['Draft is available in the retained worktree.'],
      limitations: ['Not committed or integrated.'],
      nextStep: 'Owner reviews the draft.',
    }),
  );
  const drafted = cli(repo, 'draft', {
    owner: OWNER,
    task: 'ORCH-101',
    attempt: attempt.number,
    handle: attempt.handle,
    'result-file': resultPath,
  });
  assert.equal(drafted.status, 'drafted');
  assert.deepEqual(cli(repo, 'next', { owner: OWNER }).ready, []);
  assert.equal(
    cli(
      repo,
      'candidate',
      { owner: OWNER, task: 'ORCH-101', attempt: attempt.number },
      { fail: true },
    ).error.code,
    'MODE_MISMATCH',
  );
});

test('--help works without a root and linked worktrees cannot own a registry', (t) => {
  const help = execute(process.execPath, [SCRIPT, '--help']);
  assert.equal(JSON.parse(help.stdout).command, 'help');
  const { base, repo } = fixture(t);
  const linked = path.join(base, 'linked');
  git(repo, 'worktree', 'add', '--detach', linked, 'HEAD');
  assert.equal(cli(linked, 'status', {}, { fail: true }).error.code, 'NON_CANONICAL_ROOT');
});

test('invalid claim input creates no branch or worktree artifact', (t) => {
  const { base, repo } = fixture(t);
  addTasks(base, repo, taskSpec('ORCH-801', { file: 'area/input.txt' }));
  assert.equal(
    cli(repo, 'claim', { owner: OWNER, task: 'ORCH-801' }, { fail: true }).error.code,
    'MISSING_ARGUMENT',
  );
  assert.equal(git(repo, 'branch', '--list', 'codex/orch-801-1'), '');
  assert.equal(cli(repo, 'status').tasks[0].status, 'pending');
});

test('an accepted old candidate cannot integrate after a replacement attempt starts', (t) => {
  const { base, repo } = fixture(t);
  addTasks(base, repo, taskSpec('ORCH-802', { file: 'area/stale.txt' }));
  const first = claimBind(repo, 'ORCH-802', 'worker-old', 'handle-old');
  commitWorker(base, repo, 'ORCH-802', first, { 'area/stale.txt': 'old\n' });
  cli(repo, 'check', { owner: OWNER, task: 'ORCH-802', attempt: first.number, phase: 'worker' });
  const built = cli(repo, 'candidate', { owner: OWNER, task: 'ORCH-802', attempt: first.number });
  cli(repo, 'check', { owner: OWNER, task: 'ORCH-802', attempt: first.number, phase: 'candidate' });
  cli(repo, 'review', {
    owner: OWNER,
    task: 'ORCH-802',
    attempt: first.number,
    reviewer: 'reviewer-old',
    commit: built.candidate.sha,
    verdict: 'pass',
    summary: 'Old attempt was accepted before replacement.',
  });
  cli(repo, 'recover', {
    owner: OWNER,
    task: 'ORCH-802',
    action: 'retry',
    'worker-stopped': true,
    reason: 'Replace the stopped Worker.',
  });
  claimBind(repo, 'ORCH-802', 'worker-new', 'handle-new');
  assert.equal(
    cli(
      repo,
      'integrate',
      { owner: OWNER, task: 'ORCH-802', attempt: first.number },
      { fail: true },
    ).error.code,
    'STALE_ATTEMPT',
  );
});

test('Git already at a candidate does not bypass missing candidate checks and review', (t) => {
  const { base, repo } = fixture(t);
  addTasks(base, repo, taskSpec('ORCH-803', { file: 'area/recovery.txt' }));
  const attempt = claimBind(repo, 'ORCH-803');
  commitWorker(base, repo, 'ORCH-803', attempt, { 'area/recovery.txt': 'recovery\n' });
  cli(repo, 'check', { owner: OWNER, task: 'ORCH-803', attempt: attempt.number, phase: 'worker' });
  const built = cli(repo, 'candidate', { owner: OWNER, task: 'ORCH-803', attempt: attempt.number });
  git(repo, 'merge', '--ff-only', built.candidate.sha);
  assert.equal(
    cli(
      repo,
      'integrate',
      { owner: OWNER, task: 'ORCH-803', attempt: attempt.number },
      { fail: true },
    ).error.code,
    'CHECK_REQUIRED',
  );
  assert.equal(cli(repo, 'status').tasks[0].status, 'reported');
});

test('candidate creation rejects a rewritten develop that lost the Worker base', (t) => {
  const { base, repo } = fixture(t);
  addTasks(base, repo, taskSpec('ORCH-804', { file: 'area/diverged.txt' }));
  const attempt = claimBind(repo, 'ORCH-804');
  commitWorker(base, repo, 'ORCH-804', attempt, { 'area/diverged.txt': 'worker\n' });
  cli(repo, 'check', { owner: OWNER, task: 'ORCH-804', attempt: attempt.number, phase: 'worker' });
  const tree = git(repo, 'rev-parse', 'develop^{tree}');
  const unrelated = execute('git', ['-C', repo, 'commit-tree', tree], {
    input: 'rewritten develop\n',
  }).stdout.trim();
  git(repo, 'switch', '--detach');
  git(repo, 'branch', '-f', 'develop', unrelated);
  git(repo, 'switch', 'develop');
  assert.equal(
    cli(
      repo,
      'candidate',
      { owner: OWNER, task: 'ORCH-804', attempt: attempt.number },
      { fail: true },
    ).error.code,
    'DEVELOP_DIVERGED',
  );
});

test('a paused run can stop a confirmed Worker and start a bounded new goal', (t) => {
  const { base, repo } = fixture(t);
  addTasks(base, repo, taskSpec('ORCH-901', { file: 'area/paused.txt' }));
  claimBind(repo, 'ORCH-901', 'worker-paused', 'handle-paused');
  cli(repo, 'close', { owner: OWNER, status: 'paused', reason: 'Owner paused the current goal.' });
  assert.deepEqual(cli(repo, 'next', { owner: OWNER }).ready, []);
  cli(repo, 'recover', {
    owner: OWNER,
    task: 'ORCH-901',
    action: 'stop',
    'worker-stopped': true,
    reason: 'Native worker stop was confirmed after the pause.',
  });
  cli(repo, 'start', {
    owner: OWNER,
    'new-owner': 'orchestrator-session-2',
    'previous-owner-stopped': true,
    goal: 'Start a separate bounded goal',
    mode: 'review',
    'max-tasks': 2,
    'max-retries': 1,
    'max-workers': 1,
  });
  const duplicatePath = path.join(base, 'historical-duplicate.json');
  writeFileSync(duplicatePath, JSON.stringify(taskSpec('ORCH-901', { file: 'area/new.txt' })));
  assert.equal(
    cli(repo, 'add', { owner: 'orchestrator-session-2', spec: duplicatePath }, { fail: true }).error
      .code,
    'DUPLICATE_TASK',
  );
  assert.equal(cli(repo, 'status').owner, 'orchestrator-session-2');
});

test('start keeps dirty root denied without an exact bootstrap source bundle', (t) => {
  const { repo } = fixture(t);
  cli(repo, 'close', { owner: OWNER, status: 'paused', reason: 'Prepare a new bounded run.' });
  writeFileSync(path.join(repo, 'README.md'), 'authorized dirty start\n');
  const canonicalRepo = realpathSync(repo);
  const sourceStore = path.join(canonicalRepo, '.ai-orchestrator', 'graph', 'sources');
  mkdirSync(path.dirname(sourceStore), { recursive: true, mode: 0o700 });
  const captured = captureSourceBundle(canonicalRepo, sourceStore);
  const startOptions = {
    owner: OWNER,
    'new-owner': 'orchestrator-dirty-start',
    'previous-owner-stopped': true,
    goal: 'Run one authorized dirty snapshot',
    mode: 'autonomous',
    'max-tasks': 1,
    'max-retries': 0,
    'max-workers': 1,
  };
  const stateFile = path.join(repo, '.ai-orchestrator/state.json');
  const before = readFileSync(stateFile, 'utf8');
  assert.equal(cli(repo, 'start', startOptions, { fail: true }).error.code, 'DIRTY_ROOT');
  assert.equal(readFileSync(stateFile, 'utf8'), before);

  writeFileSync(path.join(repo, 'README.md'), 'drift after source capture\n');
  assert.equal(
    cli(
      repo,
      'start',
      { ...startOptions, 'bootstrap-source-bundle': captured.bundlePath },
      { fail: true },
    ).error.code,
    'SOURCE_SNAPSHOT_MISMATCH',
  );
  assert.equal(readFileSync(stateFile, 'utf8'), before);
});

test('start accepts an exact dirty source, audits it, and preserves old run history', (t) => {
  const { base, repo } = fixture(t);
  addTasks(base, repo, taskSpec('ORCH-BOOTSTRAP-HISTORY'));
  cli(repo, 'close', { owner: OWNER, status: 'paused', reason: 'Start the approved next run.' });
  writeFileSync(path.join(repo, 'README.md'), 'approved dirty source\n');
  const canonicalRepo = realpathSync(repo);
  const sourceStore = path.join(canonicalRepo, '.ai-orchestrator', 'graph', 'sources');
  mkdirSync(path.dirname(sourceStore), { recursive: true, mode: 0o700 });
  const captured = captureSourceBundle(canonicalRepo, sourceStore);
  cli(repo, 'start', {
    owner: OWNER,
    'new-owner': 'orchestrator-new-source',
    'previous-owner-stopped': true,
    goal: 'Execute the approved source snapshot once',
    mode: 'autonomous',
    'max-tasks': 1,
    'max-retries': 0,
    'max-workers': 1,
    'bootstrap-source-bundle': captured.bundlePath,
  });
  const state = JSON.parse(readFileSync(path.join(repo, '.ai-orchestrator/state.json'), 'utf8'));
  assert.equal(state.bootstrapSourceHash, captured.manifest.sourceHash);
  assert.equal(state.limits.maxRetries, 0);
  assert.equal(state.sourceAuthorizations.at(-1).sourceHash, captured.manifest.sourceHash);
  assert.equal(state.sourceAuthorizations.at(-1).owner, 'orchestrator-new-source');
  assert.equal(state.runHistory.length, 1);
  assert.equal(state.runHistory[0].goal, 'Проверить безопасную локальную интеграцию');
  assert.equal(state.runHistory[0].taskReceipts[0].id, 'ORCH-BOOTSTRAP-HISTORY');
  assert.deepEqual(state.runHistory[0].sourceAuthorizations, []);
});

test('max-retries zero permits one attempt and rejects a second', (t) => {
  const { base, repo } = fixture(t, { maxRetries: 0 });
  addTasks(base, repo, taskSpec('ORCH-NO-RETRY'));
  claimBind(repo, 'ORCH-NO-RETRY', 'worker-once', 'handle-once');
  const retry = cli(
    repo,
    'recover',
    {
      owner: OWNER,
      task: 'ORCH-NO-RETRY',
      action: 'retry',
      'worker-stopped': true,
      reason: 'No retry is authorized for this run.',
    },
    { fail: true },
  );
  assert.equal(retry.error.code, 'RETRY_LIMIT');
  assert.equal(cli(repo, 'status').tasks[0].attempt, 1);
});

test('max-tasks and max-workers still reject zero', (t) => {
  const tasks = uninitializedFixture(t, 'zero-max-tasks');
  assert.equal(
    cli(tasks.repo, 'init', initOptions({ 'max-tasks': 0, 'max-retries': 0 }), { fail: true }).error
      .code,
    'INVALID_ARGUMENT',
  );
  const workers = uninitializedFixture(t, 'zero-max-workers');
  assert.equal(
    cli(workers.repo, 'init', initOptions({ 'max-workers': 0, 'max-retries': 0 }), { fail: true })
      .error.code,
    'INVALID_ARGUMENT',
  );
});

test('an interrupted allocating attempt can be abandoned without deleting its artifacts', (t) => {
  const { base, repo } = fixture(t);
  addTasks(base, repo, taskSpec('ORCH-902', { file: 'area/allocation.txt' }));
  const first = cli(repo, 'claim', {
    owner: OWNER,
    task: 'ORCH-902',
    worker: 'worker-allocation',
  }).attempt;
  writeFileSync(path.join(first.worktree, 'area', 'allocation.txt'), 'partial artifact\n');
  git(first.worktree, 'add', 'area/allocation.txt');
  git(
    first.worktree,
    'commit',
    '-m',
    'feat(test): оставил частичный артефакт',
    '-m',
    'Refs: ORCH-902',
  );
  const oldHead = git(first.worktree, 'rev-parse', 'HEAD');

  const statePath = path.join(repo, '.ai-orchestrator', 'state.json');
  const interrupted = JSON.parse(readFileSync(statePath, 'utf8'));
  interrupted.tasks[0].status = 'allocating';
  interrupted.tasks[0].attempts[0].status = 'allocating';
  writeFileSync(statePath, `${JSON.stringify(interrupted, null, 2)}\n`);

  cli(repo, 'recover', {
    owner: OWNER,
    task: 'ORCH-902',
    action: 'retry',
    'worker-stopped': true,
    reason: 'Allocation process stopped with an unexpectedly advanced retained branch.',
  });
  assert.equal(git(repo, 'rev-parse', first.branch), oldHead);
  const second = cli(repo, 'claim', {
    owner: OWNER,
    task: 'ORCH-902',
    worker: 'worker-replacement',
  }).attempt;
  assert.equal(second.number, 2);
  assert.notEqual(second.worktree, first.worktree);
});

test('a conflicted old candidate cannot block the replacement attempt candidate', (t) => {
  const { base, repo } = fixture(t);
  writeFileSync(path.join(repo, 'area', 'conflict.txt'), 'base\n');
  git(repo, 'add', 'area/conflict.txt');
  git(repo, 'commit', '-m', 'test(test): добавил базу конфликта', '-m', 'Refs: ORCH-903');
  addTasks(base, repo, taskSpec('ORCH-903', { file: 'area/conflict.txt' }));

  const first = claimBind(repo, 'ORCH-903', 'worker-conflict-old', 'handle-conflict-old');
  commitWorker(base, repo, 'ORCH-903', first, { 'area/conflict.txt': 'worker old\n' });
  cli(repo, 'check', { owner: OWNER, task: 'ORCH-903', attempt: first.number, phase: 'worker' });
  writeFileSync(path.join(repo, 'area', 'conflict.txt'), 'develop changed\n');
  git(repo, 'add', 'area/conflict.txt');
  git(repo, 'commit', '-m', 'test(test): изменил develop для конфликта', '-m', 'Refs: ORCH-903');
  const conflict = cli(
    repo,
    'candidate',
    { owner: OWNER, task: 'ORCH-903', attempt: first.number },
    { fail: true },
  );
  assert.equal(conflict.status, 'conflicted');
  const oldCandidateWorktree = conflict.worktree;

  cli(repo, 'recover', {
    owner: OWNER,
    task: 'ORCH-903',
    action: 'retry',
    'worker-stopped': true,
    reason: 'Old Worker stopped after its candidate conflicted.',
  });
  const second = claimBind(repo, 'ORCH-903', 'worker-conflict-new', 'handle-conflict-new');
  commitWorker(base, repo, 'ORCH-903', second, { 'area/conflict.txt': 'worker new\n' });
  cli(repo, 'check', { owner: OWNER, task: 'ORCH-903', attempt: second.number, phase: 'worker' });
  const replacement = cli(repo, 'candidate', {
    owner: OWNER,
    task: 'ORCH-903',
    attempt: second.number,
  });
  assert.equal(replacement.candidate.attemptNumber, second.number);
  assert.notEqual(replacement.candidate.worktree, oldCandidateWorktree);
  assert.equal(existsSync(oldCandidateWorktree), true, 'conflicted artifact must be retained');
});

test('new source authorization requires owner, exact current snapshot, and no active worker', (t) => {
  const { base, repo } = fixture(t);
  writeFileSync(path.join(repo, 'README.md'), 'updated source\n');
  mkdirSync(path.join(realpathSync(repo), '.ai-orchestrator/graph'), {
    recursive: true,
    mode: 0o700,
  });
  const source = captureSourceBundle(
    realpathSync(repo),
    path.join(realpathSync(repo), '.ai-orchestrator/graph/sources'),
  );
  const options = {
    owner: OWNER,
    'source-bundle': source.bundlePath,
    reason: 'Explicit local source update',
  };
  assert.equal(
    cli(repo, 'authorize-source', { ...options, owner: 'other' }, { fail: true }).error.code,
    'OWNER_MISMATCH',
  );
  writeFileSync(path.join(repo, 'README.md'), 'drift\n');
  assert.equal(
    cli(repo, 'authorize-source', options, { fail: true }).error.code,
    'SOURCE_SNAPSHOT_MISMATCH',
  );
  writeFileSync(path.join(repo, 'README.md'), 'updated source\n');
  const result = cli(repo, 'authorize-source', options);
  assert.equal(result.sourceHash, source.manifest.sourceHash);
  const state = JSON.parse(readFileSync(path.join(repo, '.ai-orchestrator/state.json')));
  assert.equal(state.sourceAuthorizations.at(-1).sourceHash, result.sourceHash);
  addTasks(base, repo, taskSpec('ORCH-SOURCE'));
  cli(repo, 'graph-reserve', {
    owner: OWNER,
    task: 'ORCH-SOURCE',
    run: 'run-source-owner',
    'source-hash': result.sourceHash,
    'bootstrap-dirty-snapshot': true,
  });
  assert.equal(cli(repo, 'authorize-source', options, { fail: true }).error.code, 'ACTIVE_WORKER');
});

test('profile migration requires explicit stopped lifecycle and preserves prior profile history', (t) => {
  const { repo } = fixture(t);
  const statePath = path.join(repo, '.ai-orchestrator/state.json');
  const before = JSON.parse(readFileSync(statePath, 'utf8'));
  const profilePath = path.join(repo, '.flowcairn.json');
  const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
  const options = {
    owner: OWNER,
    'new-owner': 'next-owner',
    'previous-owner-stopped': true,
    goal: 'Next configured goal',
    mode: 'review',
    'max-tasks': 2,
    'max-retries': 1,
    'max-workers': 1,
  };
  cli(repo, 'close', {
    owner: OWNER,
    status: 'paused',
    reason: 'Previous goal stopped before changing configuration.',
  });
  writeFileSync(
    profilePath,
    JSON.stringify({ ...profile, ai: { ...profile.ai, model: 'another-model' } }),
  );
  const changedState = readFileSync(statePath, 'utf8');
  assert.equal(cli(repo, 'start', options, { fail: true }).error.code, 'PROJECT_PROFILE_DRIFT');
  assert.equal(
    cli(
      repo,
      'start',
      { ...options, 'accept-profile-change': true, 'previous-owner-stopped': false },
      { fail: true },
    ).error.code,
    'OWNER_STOP_UNCONFIRMED',
  );
  assert.equal(
    cli(repo, 'start', { ...options, 'accept-profile-change': true }, { fail: true }).error.code,
    'DIRTY_ROOT',
  );
  assert.equal(readFileSync(statePath, 'utf8'), changedState);
  mkdirSync(path.join(realpathSync(repo), '.ai-orchestrator/graph'), {
    recursive: true,
    mode: 0o700,
  });
  const captured = captureSourceBundle(
    realpathSync(repo),
    path.join(realpathSync(repo), '.ai-orchestrator/graph/sources'),
  );
  cli(repo, 'start', {
    ...options,
    'accept-profile-change': true,
    'bootstrap-source-bundle': captured.bundlePath,
  });
  const after = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(after.runHistory.at(-1).projectProfileHash, before.projectProfileHash);
  assert.equal(after.runHistory.at(-1).integrationBranch, before.integrationBranch);
  assert.notEqual(after.projectProfileHash, before.projectProfileHash);
  assert.equal(after.owner, 'next-owner');
  assert.equal(cli(repo, 'status').owner, 'next-owner');
});

test('profile-change flag cannot replace an active goal', (t) => {
  const { repo } = fixture(t);
  const profilePath = path.join(repo, '.flowcairn.json');
  const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
  writeFileSync(profilePath, JSON.stringify({ ...profile, checks: ['tests'] }));
  assert.equal(
    cli(repo, 'start', { owner: OWNER, 'accept-profile-change': true }, { fail: true }).error.code,
    'RUN_ACTIVE',
  );
});

test('migration preserves a recovered Graph binding for the next replan', (t) => {
  const { base, repo } = fixture(t);
  addTasks(base, repo, taskSpec('ORCH-PROFILE'));
  const sourceHash = 'a'.repeat(64);
  const reserved = cli(repo, 'graph-reserve', {
    owner: OWNER,
    task: 'ORCH-PROFILE',
    run: 'run-profile-previous',
    'source-hash': sourceHash,
  });
  cli(repo, 'bind', {
    owner: OWNER,
    task: 'ORCH-PROFILE',
    attempt: reserved.attemptId,
    handle: `graph:${reserved.leaseId}`,
  });
  const before = JSON.parse(readFileSync(path.join(repo, '.ai-orchestrator', 'state.json')));
  const profilePath = path.join(repo, '.flowcairn.json');
  const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
  writeFileSync(profilePath, JSON.stringify({ ...profile, ai: { ...profile.ai, model: 'next-model' } }));
  const migrated = migrateProjectProfile(repo, {
    fromProfileHash: before.projectProfileHash,
    toProfileHash: projectProfileHash(repo),
    verifyStoppedGraph: () => ({
      verified: true,
      evidence: 'Graph recovery and lifecycle fence verified.',
      bindings: [{ ...reserved, handle: `graph:${reserved.leaseId}` }],
    }),
  });
  assert.equal(migrated.migrated, true);
  assert.equal(migrated.previousProfileHash, before.projectProfileHash);
  assert.equal(migrated.profileHash, projectProfileHash(repo));
  const after = JSON.parse(readFileSync(path.join(repo, '.ai-orchestrator', 'state.json')));
  assert.equal(after.tasks[0].attempts[0].number, reserved.attemptId);
  assert.equal(after.tasks[0].attempts[0].status, 'active');
  assert.deepEqual(after.tasks[0].attempts[0].graphBinding.runId, reserved.runId);
  assert.equal(cli(repo, 'graph-verify', {
    owner: OWNER,
    task: 'ORCH-PROFILE',
    attempt: reserved.attemptId,
    run: reserved.runId,
    lease: reserved.leaseId,
    'source-hash': sourceHash,
    worktree: reserved.worktree,
  }).runId, reserved.runId);
});

test('migration still rejects an active legacy worker', (t) => {
  const { base, repo } = fixture(t);
  addTasks(base, repo, taskSpec('ORCH-LEGACY'));
  claimBind(repo, 'ORCH-LEGACY');
  const before = JSON.parse(readFileSync(path.join(repo, '.ai-orchestrator', 'state.json')));
  const profilePath = path.join(repo, '.flowcairn.json');
  const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
  writeFileSync(profilePath, JSON.stringify({ ...profile, ai: { ...profile.ai, model: 'next-model' } }));
  assert.throws(() => migrateProjectProfile(repo, {
    fromProfileHash: before.projectProfileHash,
    toProfileHash: projectProfileHash(repo),
    verifyStoppedGraph: () => ({ verified: true, evidence: 'Lifecycle fence verified.', bindings: [] }),
  }), (error) => error.code === 'ACTIVE_LEASES');
});

test('legacy task data cannot select arbitrary programs or out-of-scope host checks', (t) => {
  const { base, repo } = fixture(t);
  for (const checks of [
    [['/usr/bin/env']],
    [['/bin/sh', '-c', 'true']],
    [['/bin/test', '-f', '../outside']],
    [['/bin/test', '-f', 'other/file']],
    [['/usr/bin/git', 'config', '--list']],
  ]) {
    const specPath = path.join(base, 'denied-check.json');
    writeFileSync(specPath, JSON.stringify(taskSpec('ORCH-DENIED', { checks })));
    const result = cli(repo, 'add', { owner: OWNER, spec: specPath }, { fail: true });
    assert.ok(['CHECK_NOT_ALLOWED', 'INVALID_SPEC'].includes(result.error.code));
    assert.deepEqual(cli(repo, 'status').tasks, []);
  }
});

test('legacy checks are revalidated from saved state before execution or receipts change', (t) => {
  const { base, repo } = fixture(t);
  addTasks(base, repo, [taskSpec('ORCH-OLD')]);
  const statePath = path.join(repo, '.ai-orchestrator/state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  for (const checks of [[['/usr/bin/true']], []]) {
    state.tasks[0].checks = checks;
    writeFileSync(statePath, JSON.stringify(state));
    const before = readFileSync(statePath);
    const result = cli(
      repo,
      'check',
      { owner: OWNER, task: 'ORCH-OLD', attempt: 1, phase: 'worker' },
      { fail: true },
    );
    assert.equal(result.error.code, 'CHECK_NOT_ALLOWED');
    assert.deepEqual(readFileSync(statePath), before);
  }
});
