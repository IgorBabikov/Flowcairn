import { gitExecutable, hostNullDevice } from './host-executables.mjs';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { loadProjectProfile } from './project.mjs';
import { fileURLToPath } from 'node:url';
import { withGraphBindingFence } from '../../ai-orchestrator.mjs';
import { GraphError, assertRunId, sha256 } from './io.mjs';
import { materializeSourceBundle, verifySourceBundle } from './source.mjs';

const ORCHESTRATOR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'ai-orchestrator.mjs',
);
const SOURCE_HASH = /^[a-f0-9]{64}$/;

export function graphExecutionContext({ root, task }) {
  try {
    const state = invokeOrchestrator(root, 'status', {}),
      registered = state.tasks.find((item) => item.id === task.id);
    if (state.runStatus !== 'active')
      return { available: false, reason: 'Orchestrator не активен' };
    if (!registered)
      return {
        available: false,
        reason: 'TaskSpec.id должен ссылаться на зарегистрированную задачу Orchestrator',
      };
    if (
      task.scope.some(
        (candidate) =>
          !registered.scope.some(
            (scope) =>
              candidate.replace(/\/$/, '') === scope.replace(/\/$/, '') ||
              candidate.startsWith(`${scope.replace(/\/$/, '')}/`),
          ),
      )
    )
      return { available: false, reason: 'Graph scope выходит за ownership задачи Orchestrator' };
    return { available: true, reason: null, owner: state.owner };
  } catch (error) {
    return {
      available: false,
      reason: `Orchestrator недоступен: ${error.code ?? 'STATE_UNAVAILABLE'}`,
    };
  }
}

function trustedEnvironment() {
  return {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C',
    CI: 'true',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: hostNullDevice,
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: hostNullDevice,
    GIT_CONFIG_KEY_1: 'core.fsmonitor',
    GIT_CONFIG_VALUE_1: 'false',
  };
}

function fail(code, message, details = undefined) {
  throw new GraphError(code, message, details);
}

function invokeOrchestrator(root, command, options) {
  const args = [ORCHESTRATOR, command, '--root', root];
  for (const [key, value] of Object.entries(options)) {
    if (value === false || value === undefined || value === null) continue;
    args.push(`--${key}`);
    if (value !== true) args.push(String(value));
  }
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 20 * 1024 * 1024,
    env: trustedEnvironment(),
    shell: false,
  });
  const channel = result.status === 0 ? result.stdout : result.stderr || result.stdout;
  let payload;
  try {
    payload = JSON.parse(channel);
  } catch {
    fail('ORCHESTRATOR_PROTOCOL_ERROR', `Orchestrator ${command} вернул невалидный JSON`, {
      status: result.status,
      stderr: result.stderr?.trim(),
    });
  }
  if (result.error || result.status !== 0 || payload.ok !== true) {
    fail(
      payload?.error?.code ?? 'ORCHESTRATOR_FAILED',
      payload?.error?.message ?? `${command} failed`,
      {
        command,
        orchestrator: payload?.error?.details,
      },
    );
  }
  return payload;
}

function runGit(root, args, { input = undefined, allowFailure = false } = {}) {
  const result = spawnSync(gitExecutable(), ['-C', root, ...args], {
    encoding: 'utf8',
    input,
    timeout: 120_000,
    maxBuffer: 20 * 1024 * 1024,
    shell: false,
    env: trustedEnvironment(),
  });
  if (!allowFailure && (result.error || result.status !== 0)) {
    fail('GIT_FAILED', `git ${args[0]} завершился с ошибкой`, {
      status: result.status,
      stderr: result.stderr?.trim(),
    });
  }
  return result;
}

function gitText(root, args) {
  return runGit(root, args).stdout.trim();
}

function validateRequest({ root, runId, task, sourceHash, owner }) {
  if (typeof root !== 'string' || root.trim() === '') fail('INVALID_ROOT', 'root обязателен');
  assertRunId(runId);
  if (!task || typeof task !== 'object' || Array.isArray(task))
    fail('INVALID_TASK', 'task должен быть TaskSpec object');
  if (typeof task.id !== 'string' || task.id.trim() === '')
    fail('INVALID_TASK', 'task.id должен ссылаться на существующую задачу Orchestrator');
  if (!SOURCE_HASH.test(sourceHash ?? ''))
    fail('INVALID_SOURCE_HASH', 'sourceHash должен быть lowercase SHA-256');
  if (typeof owner !== 'string' || owner.trim() === '') fail('INVALID_OWNER', 'owner обязателен');
}

function bindingOptions(binding) {
  return {
    owner: binding.owner,
    run: binding.runId,
    task: binding.taskId,
    attempt: binding.attemptId,
    lease: binding.leaseId,
    'source-hash': binding.sourceHash,
    worktree: binding.worktree,
  };
}

function canonicalBinding(payload) {
  return {
    worktree: payload.worktree,
    taskId: payload.taskId,
    attemptId: payload.attemptId,
    leaseId: payload.leaseId,
    sourceHash: payload.sourceHash,
    runId: payload.runId,
    owner: payload.owner,
  };
}

function assertExplicitBinding(binding, request) {
  if (!binding || typeof binding !== 'object') fail('INVALID_BINDING', 'existingBinding invalid');
  for (const [key, expected] of [
    ['taskId', request.task.id],
    ['runId', request.runId],
    ['sourceHash', request.sourceHash],
    ['owner', request.owner],
  ]) {
    if (binding[key] !== expected)
      fail('STALE_GRAPH_BINDING', `existingBinding.${key} не совпадает с запросом`);
  }
  if (!Number.isSafeInteger(Number(binding.attemptId)) || Number(binding.attemptId) < 1)
    fail('INVALID_BINDING', 'existingBinding.attemptId invalid');
  for (const key of ['leaseId', 'worktree']) {
    if (typeof binding[key] !== 'string' || binding[key] === '')
      fail('INVALID_BINDING', `existingBinding.${key} invalid`);
  }
}

function isInside(parent, candidate) {
  return candidate.startsWith(`${parent}${path.sep}`);
}

function assertOwnedWorktree(root, worktree) {
  const expectedRoot = realpathSync(path.join(root, '.ai-orchestrator', 'worktrees'));
  const actual = realpathSync(worktree);
  if (!isInside(expectedRoot, actual))
    fail('UNSAFE_WORKTREE', 'Worktree находится вне canonical Orchestrator storage');
  const dotGit = path.join(actual, '.git');
  if (!existsSync(dotGit)) fail('INVALID_WORKTREE', 'Git worktree metadata отсутствует');
  return actual;
}

function assertSafeAncestors(root, relativePath) {
  let current = root;
  for (const part of relativePath.split('/').slice(0, -1)) {
    current = path.join(current, part);
    if (!existsSync(current)) {
      mkdirSync(current, { mode: 0o700 });
      continue;
    }
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      fail('UNSAFE_WORKTREE', `Небезопасный ancestor: ${relativePath}`);
  }
}

function removeManifestPaths(worktree, manifest) {
  const paths = [...manifest.entries.map((entry) => entry.path), ...(manifest.withheldPaths ?? [])].sort(
    (left, right) => right.split('/').length - left.split('/').length,
  );
  for (const entryPath of paths) {
    const destination = path.join(worktree, ...entryPath.split('/'));
    if (existsSync(destination) || lstatExists(destination))
      rmSync(destination, { recursive: true });
  }
}

function lstatExists(candidate) {
  try {
    lstatSync(candidate);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

function copyMaterializedWorktree(staging, worktree, manifest) {
  removeManifestPaths(worktree, manifest);
  for (const entry of manifest.entries.filter((item) => item.worktree !== null)) {
    assertSafeAncestors(worktree, entry.path);
    const source = path.join(staging, ...entry.path.split('/'));
    const destination = path.join(worktree, ...entry.path.split('/'));
    if (entry.worktree.type === 'symlink') {
      symlinkSync(readlinkSync(source), destination);
    } else {
      writeFileSync(destination, readFileSync(source), { flag: 'wx', mode: 0o600 });
      chmodSync(destination, entry.worktree.mode === '100755' ? 0o700 : 0o600);
    }
  }
}

function restoreIndex(worktree, manifest) {
  runGit(worktree, ['read-tree', '--empty']);
  const records = manifest.entries
    .filter((entry) => entry.index !== null)
    .map((entry) => `${entry.index.mode} ${entry.index.gitOid}\t${entry.path}\0`)
    .join('');
  if (records) runGit(worktree, ['update-index', '-z', '--index-info'], { input: records });
}

function parseIndex(worktree) {
  const output = runGit(worktree, ['ls-files', '--stage', '-z']).stdout;
  return output
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const match = /^([0-9]+) ([a-f0-9]+) 0\t([\s\S]+)$/.exec(record);
      if (!match) fail('INVALID_WORKTREE', 'Не удалось прочитать Git index');
      return { mode: match[1], gitOid: match[2], path: match[3] };
    });
}

function actualBytes(candidate, descriptor) {
  const stat = lstatSync(candidate);
  if (descriptor.type === 'symlink') {
    if (!stat.isSymbolicLink()) fail('SOURCE_TRANSFER_FAILED', `${candidate} не symlink`);
    return readlinkSync(candidate, { encoding: 'buffer' });
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    fail('SOURCE_TRANSFER_FAILED', `${candidate} не является безопасным file`);
  if (((stat.mode & 0o111) !== 0) !== (descriptor.mode === '100755'))
    fail('SOURCE_TRANSFER_FAILED', `${candidate} имеет неверный executable mode`);
  return readFileSync(candidate);
}

function verifyInitialWorkspace(worktree, manifest) {
  if (gitText(worktree, ['rev-parse', 'HEAD']) !== manifest.source.head)
    fail('SOURCE_HEAD_MISMATCH', 'Worktree HEAD не совпадает с source bundle');
  const expectedIndex = manifest.entries
    .filter((entry) => entry.index !== null)
    .map((entry) => ({ mode: entry.index.mode, gitOid: entry.index.gitOid, path: entry.path }));
  const actualIndex = parseIndex(worktree);
  if (JSON.stringify(actualIndex) !== JSON.stringify(expectedIndex))
    fail('SOURCE_TRANSFER_FAILED', 'Git index не совпадает с source bundle');
  for (const entry of manifest.entries) {
    const destination = path.join(worktree, ...entry.path.split('/'));
    if (entry.worktree === null) {
      if (lstatExists(destination))
        fail('SOURCE_TRANSFER_FAILED', `${entry.path} должен отсутствовать`);
      continue;
    }
    if (!lstatExists(destination)) fail('SOURCE_TRANSFER_FAILED', `${entry.path} отсутствует`);
    if (sha256(actualBytes(destination, entry.worktree)) !== entry.worktree.sha256)
      fail('SOURCE_TRANSFER_FAILED', `${entry.path} не совпадает с source bundle`);
  }
  const expectedUntracked = manifest.entries
    .filter((entry) => entry.index === null && entry.worktree !== null)
    .map((entry) => entry.path)
    .sort();
  const actualUntracked = runGit(worktree, ['ls-files', '--others', '--exclude-standard', '-z'])
    .stdout.split('\0')
    .filter(Boolean)
    .sort();
  if (JSON.stringify(actualUntracked) !== JSON.stringify(expectedUntracked))
    fail('SOURCE_TRANSFER_FAILED', 'Untracked paths не совпадают с source bundle');
}

function isPristineAtSource(worktree, sourceHead) {
  return (
    gitText(worktree, ['rev-parse', 'HEAD']) === sourceHead &&
    runGit(worktree, ['status', '--porcelain=v1', '--untracked-files=all']).stdout.trim() === ''
  );
}

function stageAndTransfer(sourceBundle, worktree, manifest, leaseId) {
  const stagingParent = path.join(path.dirname(path.dirname(worktree)), 'graph-staging');
  mkdirSync(stagingParent, { recursive: true, mode: 0o700 });
  const staging = path.join(stagingParent, leaseId);
  try {
    materializeSourceBundle(sourceBundle, staging);
    copyMaterializedWorktree(staging, worktree, manifest);
    restoreIndex(worktree, manifest);
    verifyInitialWorkspace(worktree, manifest);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function verifyGraphWorkspace({ root, binding }) {
  if (!binding || typeof binding !== 'object') fail('INVALID_BINDING', 'binding обязателен');
  const verified = invokeOrchestrator(path.resolve(root), 'graph-verify', bindingOptions(binding));
  return canonicalBinding(verified);
}

export function withGraphWorkspaceFence({ root, binding, callbackSync }) {
  try {
    return withGraphBindingFence(path.resolve(root), binding, callbackSync);
  } catch (error) {
    if (error instanceof GraphError) throw error;
    fail(error.code ?? 'ORCHESTRATOR_FENCE_FAILED', error.message, error.details);
  }
}

export function replaceGraphBinding({
  root,
  binding,
  runId,
  newRunId,
  sourceHash,
  owner,
  previousRunStopped = false,
}) {
  if (previousRunStopped !== true)
    fail('RUN_STOP_UNCONFIRMED', 'previousRunStopped=true обязателен для replan');
  assertRunId(runId);
  assertRunId(newRunId);
  if (runId === newRunId) fail('INVALID_RUN_ID', 'newRunId должен отличаться от runId');
  if (!SOURCE_HASH.test(sourceHash ?? ''))
    fail('INVALID_SOURCE_HASH', 'Новый sourceHash должен быть lowercase SHA-256');
  if (typeof owner !== 'string' || owner === '') fail('INVALID_OWNER', 'owner обязателен');
  assertExplicitBinding(binding, {
    task: { id: binding?.taskId },
    runId,
    sourceHash: binding?.sourceHash,
    owner,
  });
  const rebound = invokeOrchestrator(path.resolve(root), 'graph-rebind', {
    ...bindingOptions(binding),
    'new-run': newRunId,
    'new-source-hash': sourceHash,
    'previous-run-stopped': true,
  });
  return canonicalBinding(rebound);
}

export function allocateGraphWorkspace({
  root,
  runId,
  task,
  sourceBundle,
  sourceHash,
  owner,
  existingBinding = undefined,
}) {
  const request = { root: path.resolve(root), runId, task, sourceHash, owner };
  validateRequest(request);

  if (existingBinding !== undefined) {
    assertExplicitBinding(existingBinding, request);
    try {
      return verifyGraphWorkspace({ root: request.root, binding: existingBinding });
    } catch (error) {
      if (!(error instanceof GraphError) || error.code !== 'STALE_GRAPH_BINDING') throw error;
    }
  }

  if (typeof sourceBundle !== 'string' || sourceBundle === '')
    fail('INVALID_SOURCE_BUNDLE', 'sourceBundle обязателен для новой или reserved allocation');
  const manifest = verifySourceBundle(sourceBundle);
  if (manifest.sourceHash !== sourceHash)
    fail('SOURCE_HASH_MISMATCH', 'sourceHash не совпадает с verified bundle');
  if (manifest.source.head === null)
    fail('SOURCE_HEAD_MISSING', 'Graph bridge требует существующий Git HEAD');
  if (
    gitText(request.root, [
      'rev-parse',
      `refs/heads/${loadProjectProfile(request.root).integrationBranch}`,
    ]) !== manifest.source.head
  )
    fail('SOURCE_HEAD_MISMATCH', 'Source bundle HEAD не совпадает с integration branch');
  const registry = invokeOrchestrator(request.root, 'status', {});
  const bootstrapDirtySnapshot = registry.bootstrapSourceHash === sourceHash;

  const reserveOptions = {
    owner,
    task: task.id,
    run: runId,
    'source-hash': sourceHash,
    'bootstrap-dirty-snapshot': bootstrapDirtySnapshot,
    ...(existingBinding === undefined
      ? {}
      : {
          'existing-attempt': existingBinding.attemptId,
          'existing-lease': existingBinding.leaseId,
        }),
  };
  const reservation = canonicalBinding(
    invokeOrchestrator(request.root, 'graph-reserve', reserveOptions),
  );
  try {
    return verifyGraphWorkspace({ root: request.root, binding: reservation });
  } catch (error) {
    if (error.code !== 'STALE_GRAPH_BINDING') throw error;
  }
  const worktree = assertOwnedWorktree(request.root, reservation.worktree);
  try {
    try {
      verifyInitialWorkspace(worktree, manifest);
    } catch (error) {
      if (!isPristineAtSource(worktree, manifest.source.head)) {
        fail(
          'WORKSPACE_CHANGED',
          'Reserved Graph worktree уже изменен; автоматическое восстановление запрещено',
          {
            binding: reservation,
            cause: error.code,
          },
        );
      }
      stageAndTransfer(sourceBundle, worktree, manifest, reservation.leaseId);
    }
    invokeOrchestrator(request.root, 'bind', {
      owner,
      task: reservation.taskId,
      attempt: reservation.attemptId,
      handle: `graph:${reservation.leaseId}`,
    });
    return verifyGraphWorkspace({ root: request.root, binding: reservation });
  } catch (error) {
    if (error instanceof GraphError && error.details?.binding) throw error;
    fail(error.code ?? 'GRAPH_WORKSPACE_ALLOCATION_FAILED', error.message, {
      binding: reservation,
      cause: error.details,
    });
  }
}
