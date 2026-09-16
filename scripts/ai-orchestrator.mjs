#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureSourceBundle, verifySourceBundle } from './ai-graph/lib/source.mjs';
import { loadProjectProfile, projectProfileHash } from './ai-graph/lib/project.mjs';

function integrationBranch(root) {
  return loadProjectProfile(root).integrationBranch;
}
function integrationRef(root) {
  return `refs/heads/${integrationBranch(root)}`;
}

const SCHEMA_VERSION = 1;
const STATE_DIR = '.ai-orchestrator';
const ACTIVE_ATTEMPTS = new Set(['allocating', 'reserved', 'active', 'reported', 'drafted']);
const TASK_ID = /^[A-Z][A-Z0-9-]{2,40}$/;
const RESOURCE_ID = /^[a-z0-9][a-z0-9:-]{0,80}$/;
const GRAPH_RUN_ID = /^[a-z0-9][a-z0-9-]{2,79}$/;
const SOURCE_HASH = /^[a-f0-9]{64}$/;
const GIT_TIMEOUT_MS = 15_000;

class CliError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function now() {
  return new Date().toISOString();
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) {
      throw new CliError('INVALID_ARGUMENT', `Unexpected argument: ${token}`);
    }
    const key = token.slice(2);
    const next = rest[index + 1];
    if (next === undefined || next.startsWith('--')) {
      options[key] = true;
    } else {
      options[key] = next;
      index += 1;
    }
  }
  return { command, options };
}

function required(options, key) {
  const value = options[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CliError('MISSING_ARGUMENT', `--${key} is required`);
  }
  return value.trim();
}

function positiveInteger(options, key) {
  const raw = required(options, key);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CliError('INVALID_ARGUMENT', `--${key} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(options, key) {
  const raw = required(options, key);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CliError('INVALID_ARGUMENT', `--${key} must be a non-negative integer`);
  }
  return value;
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, timeout?: number, allowFailure?: boolean, env?: Record<string, string>}} options
 */
function run(command, args, { cwd, timeout = 120_000, allowFailure = false, env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout,
    maxBuffer: 20 * 1024 * 1024,
    env: env ?? { ...process.env, CI: process.env.CI ?? 'true' },
    shell: false,
  });
  const output = {
    command: [command, ...args],
    status: result.status,
    signal: result.signal,
    error: result.error?.message ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
  if (!allowFailure && result.error) {
    const errorCode = typeof result.error === 'object' && 'code' in result.error
      ? result.error.code
      : null;
    throw new CliError(
      errorCode === 'ETIMEDOUT' && command === '/usr/bin/git' ? 'GIT_TIMEOUT' : 'COMMAND_FAILED',
      errorCode === 'ETIMEDOUT' && command === '/usr/bin/git' ? 'Git не ответил за отведенное время.' : `${command} failed`,
      output,
    );
  }
  if (!allowFailure && result.status !== 0) {
    throw new CliError('COMMAND_FAILED', `${command} failed`, output);
  }
  return output;
}

function git(root, args, options = {}) {
  return run('/usr/bin/git', ['-C', root, '-c', 'core.fsmonitor=false', ...args], {
    ...options,
    timeout: options.timeout ?? GIT_TIMEOUT_MS,
  });
}

function gitText(root, args) {
  return git(root, args).stdout.trim();
}

function resolveRoot(rawRoot) {
  const supplied = path.resolve(rawRoot);
  let root;
  try {
    root = realpathSync(supplied);
  } catch {
    throw new CliError('INVALID_ROOT', `Root does not exist: ${supplied}`);
  }
  const gitRoot = realpathSync(gitText(root, ['rev-parse', '--show-toplevel']));
  if (gitRoot !== root) {
    throw new CliError(
      'NON_CANONICAL_ROOT',
      `--root must be the canonical main worktree: ${gitRoot}`,
    );
  }
  const commonDir = realpathSync(
    path.resolve(root, gitText(root, ['rev-parse', '--git-common-dir'])),
  );
  let mainGitDir;
  try {
    mainGitDir = realpathSync(path.join(root, '.git'));
  } catch {
    throw new CliError(
      'NON_CANONICAL_ROOT',
      '--root must be the main worktree, not a linked worktree',
    );
  }
  if (!lstatSync(mainGitDir).isDirectory() || commonDir !== mainGitDir) {
    throw new CliError('NON_CANONICAL_ROOT', '--root must own the common Git directory');
  }
  assertLocalStatePaths(root);
  return root;
}

function pathsFor(root) {
  const directory = path.join(root, STATE_DIR);
  return {
    directory,
    state: path.join(directory, 'state.json'),
    lock: path.join(directory, 'lock'),
    logs: path.join(directory, 'logs'),
    worktrees: path.join(directory, 'worktrees'),
  };
}

function assertLocalStatePaths(root) {
  for (const candidate of Object.values(pathsFor(root))) {
    if (existsSync(candidate) && lstatSync(candidate).isSymbolicLink()) {
      throw new CliError(
        'UNSAFE_STATE_PATH',
        `Orchestrator state path must not be a symlink: ${candidate}`,
      );
    }
  }
}

function assertIntegrationRoot(root, { clean = true } = {}) {
  const branch = gitText(root, ['branch', '--show-current']);
  if (branch !== integrationBranch(root)) {
    throw new CliError(
      'WRONG_BRANCH',
      `Canonical root must be on ${integrationBranch(root)}, found: ${branch || '(detached)'}`,
    );
  }
  if (clean) {
    const dirty = gitText(root, ['status', '--porcelain=v1', '--untracked-files=all']);
    if (dirty) {
      throw new CliError('DIRTY_ROOT', 'Canonical integration worktree has uncommitted changes', {
        paths: dirty.split('\n').map((line) => line.slice(3)),
      });
    }
  }
}

function comparePath(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function trustedBootstrapGit(root, args) {
  const environment = {};
  for (const key of ['TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_CTYPE']) {
    if (typeof process.env[key] === 'string') environment[key] = process.env[key];
  }
  const result = spawnSync(
    '/usr/bin/git',
    ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args],
    {
      cwd: root,
      encoding: 'buffer',
      timeout: 120_000,
      maxBuffer: 20 * 1024 * 1024,
      shell: false,
      env: {
        ...environment,
        GIT_OPTIONAL_LOCKS: '0',
        GIT_NO_LAZY_FETCH: '1',
        GIT_NO_REPLACE_OBJECTS: '1',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_ATTR_NOSYSTEM: '1',
        LC_ALL: 'C',
      },
    },
  );
  if (result.error || result.signal || result.status !== 0) {
    throw new CliError('COMMAND_FAILED', 'System Git failed during bootstrap verification');
  }
  return result.stdout;
}

function trustedBootstrapGitText(root, args) {
  return trustedBootstrapGit(root, args).toString('utf8').trim();
}

function currentUntrackedPaths(root) {
  return trustedBootstrapGit(root, ['ls-files', '--others', '--exclude-standard', '-z'])
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .sort(comparePath);
}

function makeDirectoriesWritable(directory) {
  if (!existsSync(directory)) return;
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  chmodSync(directory, stat.mode | 0o700);
  for (const entry of readdirSync(directory)) {
    makeDirectoriesWritable(path.join(directory, entry));
  }
}

function verifyBootstrapSource(root, rawBundlePath) {
  if (typeof rawBundlePath !== 'string' || rawBundlePath.trim() === '') {
    throw new CliError(
      'INVALID_ARGUMENT',
      '--bootstrap-source-bundle must be an immutable source bundle path',
    );
  }
  const bundlePath = path.resolve(rawBundlePath.trim());
  const manifest = verifySourceBundle(bundlePath);
  const branch = trustedBootstrapGitText(root, ['branch', '--show-current']);
  if (branch !== integrationBranch(root)) {
    throw new CliError(
      'WRONG_BRANCH',
      `Canonical root must be on ${integrationBranch(root)}, found: ${branch || '(detached)'}`,
    );
  }
  const developHead = trustedBootstrapGitText(root, ['rev-parse', integrationRef(root)]);
  if (manifest.source.head === null || manifest.source.head !== developHead) {
    throw new CliError(
      'SOURCE_HEAD_MISMATCH',
      'Bootstrap source bundle HEAD does not match current integration branch',
      { expected: developHead, actual: manifest.source.head },
    );
  }

  const expectedUntracked = manifest.entries
    .filter((entry) => entry.head === null && entry.index === null && entry.worktree !== null)
    .map((entry) => entry.path)
    .sort(comparePath);
  const actualUntracked = currentUntrackedPaths(root);
  if (expectedUntracked.some((file) => !actualUntracked.includes(file))) {
    throw new CliError(
      'SOURCE_SNAPSHOT_MISMATCH',
      'Selected untracked paths are missing from the current checkout',
    );
  }

  const verificationRoot = mkdtempSync(
    path.join(realpathSync(tmpdir()), 'flowcairn-orchestrator-bootstrap-'),
  );
  try {
    const current = captureSourceBundle(root, path.join(verificationRoot, 'sources'), {
      allowedUntracked: expectedUntracked,
    });
    if (
      current.manifest.sourceHash !== manifest.sourceHash ||
      JSON.stringify(currentUntrackedPaths(root)) !== JSON.stringify(actualUntracked)
    ) {
      throw new CliError(
        'SOURCE_SNAPSHOT_MISMATCH',
        'Current HEAD, index or worktree does not match the bootstrap source bundle',
        { expected: manifest.sourceHash, actual: current.manifest.sourceHash },
      );
    }
  } finally {
    try {
      makeDirectoriesWritable(verificationRoot);
      rmSync(verificationRoot, { recursive: true, force: true });
    } catch {
      /* Verification cleanup is best-effort and must not replace the source verdict. */
    }
  }
  return manifest.sourceHash;
}

function readState(root, { allowProfileChange = false } = {}) {
  const statePath = pathsFor(root).state;
  if (!existsSync(statePath)) {
    throw new CliError('STATE_MISSING', `No registry at ${statePath}; run init first`);
  }
  let state;
  try {
    state = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch (error) {
    throw new CliError('STATE_INVALID', `Cannot parse registry: ${error.message}`);
  }
  if (state.schemaVersion !== SCHEMA_VERSION || state.root !== root) {
    throw new CliError('STATE_INVALID', 'Registry schema or canonical root does not match');
  }
  if (
    state.bootstrapSourceHash !== undefined &&
    state.bootstrapSourceHash !== null &&
    !SOURCE_HASH.test(state.bootstrapSourceHash)
  ) {
    throw new CliError('STATE_INVALID', 'Registry bootstrap source authorization is invalid');
  }
  if (
    !allowProfileChange &&
    (state.integrationBranch !== integrationBranch(root) ||
      state.projectProfileHash !== projectProfileHash(root))
  ) {
    throw new CliError(
      'PROJECT_PROFILE_DRIFT',
      'Project profile changed after registry initialization; explicit migration is required',
    );
  }
  return state;
}

/**
 * Moves only the registry's profile reference after the caller has stopped
 * Graph work and atomically written the new profile. Plans, tasks and receipts
 * remain historical evidence and are intentionally never rewritten.
 * @param {string} root
 * @param {{fromProfileHash?: string, toProfileHash?: string, verifyStoppedGraph?: () => {verified?: boolean, evidence?: string, bindings?: ReadonlyArray<object>}}} options
 */
export function migrateProjectProfile(root, { fromProfileHash, toProfileHash, verifyStoppedGraph } = {}) {
  const canonicalRoot = resolveRoot(root);
  if (!existsSync(pathsFor(canonicalRoot).state))
    return { migrated: false, reason: 'REGISTRY_MISSING' };
  if (!SOURCE_HASH.test(fromProfileHash ?? '') || !SOURCE_HASH.test(toProfileHash ?? ''))
    throw new CliError('PROFILE_MIGRATION_INVALID', 'Profile migration requires exact previous and next hashes');
  if (typeof verifyStoppedGraph !== 'function')
    throw new CliError('STOP_PROOF_REQUIRED', 'Profile migration requires verified lifecycle stop proof');
  return withLock(canonicalRoot, 'flowcairn-profile-migration', () => {
    const stopProof = verifyStoppedGraph();
    if (
      !stopProof ||
      stopProof.verified !== true ||
      typeof stopProof.evidence !== 'string' ||
      stopProof.evidence.length < 1 ||
      stopProof.evidence.length > 1024 ||
      !Array.isArray(stopProof.bindings) ||
      stopProof.bindings.length > 128
    )
      throw new CliError('STOP_PROOF_REQUIRED', 'Profile migration requires verified lifecycle stop proof');
    const state = readState(canonicalRoot, { allowProfileChange: true });
    if (state.integrationBranch !== integrationBranch(canonicalRoot))
      throw new CliError('PROFILE_MIGRATION_SCOPE', 'Migration cannot accept an integration branch change');
    if (state.projectProfileHash !== fromProfileHash)
      throw new CliError('PROFILE_MIGRATION_STALE', 'Registry profile changed before migration');
    if (projectProfileHash(canonicalRoot) !== toProfileHash)
      throw new CliError('PROFILE_MIGRATION_STALE', 'Project profile changed before migration');
    const leases = activeLocks(state);
    for (const lock of leases) {
      const task = getTask(state, lock.task);
      const attempt = latestAttempt(task);
      const binding = attempt?.graphBinding;
      const matched = stopProof.bindings.find((candidate) =>
        candidate && typeof candidate === 'object' &&
        candidate.runId === binding?.runId &&
        candidate.taskId === task.id &&
        candidate.attemptId === attempt?.number &&
        candidate.leaseId === binding?.leaseId &&
        candidate.sourceHash === binding?.sourceHash &&
        candidate.worktree === attempt?.worktree &&
        candidate.owner === state.owner,
      );
      if (
        !binding ||
        binding.owner !== state.owner ||
        attempt.handle !== `graph:${binding.leaseId}` ||
        !matched
      )
        throw new CliError('ACTIVE_LEASES', 'Recover every active worker before changing its project profile', leases);
    }
    if (fromProfileHash === toProfileHash)
      return { migrated: false, reason: 'UNCHANGED', profileHash: state.projectProfileHash };
    state.projectProfileHash = toProfileHash;
    state.profileMigrations ??= [];
    state.profileMigrations.push({
      fromProfileHash,
      toProfileHash,
      at: now(),
      stopProof: stopProof.evidence,
    });
    atomicWrite(canonicalRoot, state);
    return {
      migrated: true,
      previousProfileHash: fromProfileHash,
      profileHash: toProfileHash,
    };
  });
}

function atomicWrite(root, state) {
  const registryPaths = pathsFor(root);
  state.updatedAt = now();
  const temporary = `${registryPaths.state}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, registryPaths.state);
}

function withLock(root, owner, operation) {
  const registryPaths = pathsFor(root);
  mkdirSync(registryPaths.directory, { recursive: true, mode: 0o700 });
  try {
    mkdirSync(registryPaths.lock, { mode: 0o700 });
  } catch {
    throw new CliError(
      'REGISTRY_LOCKED',
      'Registry lock already exists; inspect it instead of taking it over',
    );
  }
  try {
    writeFileSync(
      path.join(registryPaths.lock, 'owner.json'),
      `${JSON.stringify({ owner, pid: process.pid, acquiredAt: now() }, null, 2)}\n`,
      { mode: 0o600 },
    );
    return operation();
  } finally {
    rmSync(registryPaths.lock, { recursive: true, force: true });
  }
}

function assertOwner(state, owner) {
  if (state.owner !== owner) {
    throw new CliError('OWNER_MISMATCH', `Registry belongs to ${state.owner}`);
  }
  if (state.runStatus !== 'active') {
    throw new CliError('RUN_CLOSED', `Run is ${state.runStatus}`);
  }
}

function safeRelativePath(raw, label) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new CliError('INVALID_SPEC', `${label} must be a non-empty repository-relative path`);
  }
  const normalized = path.posix.normalize(raw.trim().replaceAll('\\', '/')).replace(/\/$/, '');
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.startsWith('/') ||
    normalized === '.git' ||
    normalized.startsWith('.git/') ||
    normalized === STATE_DIR ||
    normalized.startsWith(`${STATE_DIR}/`)
  ) {
    throw new CliError(
      'INVALID_SPEC',
      `${label} escapes or targets orchestrator/Git state: ${raw}`,
    );
  }
  return normalized;
}

function stringArray(value, label, { nonEmpty = false } = {}) {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    throw new CliError(
      'INVALID_SPEC',
      `${label} must be ${nonEmpty ? 'a non-empty ' : 'an '}array`,
    );
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new CliError('INVALID_SPEC', `${label}[${index}] must be a non-empty string`);
    }
    return entry.trim();
  });
}

/** Legacy task data selects only these inert host checks, never a program or shell. */
function registeredHostCheck(command, scope) {
  if (Array.isArray(command) && command.length === 3) {
    if (command[0] === '/usr/bin/git' && command[1] === 'diff' && command[2] === '--check')
      return ['/usr/bin/git', 'diff', '--check'];
    if (
      ['/bin/test', '/usr/bin/test'].includes(command[0]) &&
      command[1] === '-f' &&
      typeof command[2] === 'string' &&
      !/[\0\r\n]/.test(command[2])
    ) {
      const file = safeRelativePath(command[2], 'check path');
      if (scope.some((prefix) => file === prefix || file.startsWith(`${prefix}/`)))
        return ['/bin/test', '-f', file];
    }
  }
  throw new CliError(
    'CHECK_NOT_ALLOWED',
    'Разрешены только git diff --check и проверка существования файла внутри scope. Произвольные команды из JSON не исполняются. Тесты и сборку запускайте через зарегистрированные проверки Graph.',
  );
}

function validateTask(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CliError('INVALID_SPEC', 'Each task spec must be an object');
  }
  if (!TASK_ID.test(raw.id ?? '')) {
    throw new CliError('INVALID_SPEC', 'Task id must use uppercase letters, digits and dashes');
  }
  const text = {};
  for (const key of ['title', 'outcome', 'why']) {
    if (typeof raw[key] !== 'string' || raw[key].trim() === '') {
      throw new CliError('INVALID_SPEC', `${key} must be a non-empty string`);
    }
    text[key] = raw[key].trim();
  }
  const sourceDocs = stringArray(raw.sourceDocs, 'sourceDocs').map((entry, index) =>
    safeRelativePath(entry, `sourceDocs[${index}]`),
  );
  const scope = [
    ...new Set(
      stringArray(raw.scope, 'scope', { nonEmpty: true }).map((entry, index) =>
        safeRelativePath(entry, `scope[${index}]`),
      ),
    ),
  ];
  const resources = [...new Set(stringArray(raw.resources ?? [], 'resources'))];
  for (const resource of resources) {
    if (!RESOURCE_ID.test(resource)) {
      throw new CliError('INVALID_SPEC', `Invalid resource id: ${resource}`);
    }
  }
  const dependsOn = [...new Set(stringArray(raw.dependsOn ?? [], 'dependsOn'))];
  const acceptance = stringArray(raw.acceptance, 'acceptance', { nonEmpty: true });
  if (!Array.isArray(raw.checks) || raw.checks.length === 0) {
    throw new CliError('INVALID_SPEC', 'checks must contain at least one argv array');
  }
  const checks = raw.checks.map((command) => registeredHostCheck(command, scope));
  if (typeof raw.model !== 'string' || raw.model.trim() === '') {
    throw new CliError('INVALID_SPEC', 'model must be a non-empty string');
  }
  if (typeof raw.effort !== 'string' || raw.effort.trim() === '') {
    throw new CliError('INVALID_SPEC', 'effort must be a non-empty string');
  }
  const checkTimeoutMs = raw.checkTimeoutMs === undefined ? 120_000 : Number(raw.checkTimeoutMs);
  if (!Number.isSafeInteger(checkTimeoutMs) || checkTimeoutMs < 1 || checkTimeoutMs > 30 * 60_000) {
    throw new CliError('INVALID_SPEC', 'checkTimeoutMs must be between 1 and 1800000');
  }
  const priority = raw.priority === undefined ? 100 : Number(raw.priority);
  if (!Number.isSafeInteger(priority) || priority < 1 || priority > 999) {
    throw new CliError('INVALID_SPEC', 'priority must be an integer from 1 (highest) to 999');
  }
  return {
    id: raw.id,
    ...text,
    sourceDocs,
    scope,
    resources,
    dependsOn,
    acceptance,
    checks,
    checkTimeoutMs,
    priority,
    model: raw.model.trim(),
    effort: raw.effort.trim(),
    status: 'pending',
    attempts: [],
    candidates: [],
    merge: null,
    createdAt: now(),
  };
}

function assertDependencyGraph(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!byId.has(dependency)) {
        throw new CliError(
          'MISSING_DEPENDENCY',
          `${task.id} depends on missing task ${dependency}`,
        );
      }
      if (dependency === task.id) {
        throw new CliError('CYCLIC_DEPENDENCY', `${task.id} depends on itself`);
      }
    }
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) {
      throw new CliError('CYCLIC_DEPENDENCY', `Dependency cycle includes ${id}`);
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const task of tasks) visit(task.id);
}

function getTask(state, id) {
  const task = state.tasks.find((entry) => entry.id === id);
  if (!task) throw new CliError('TASK_NOT_FOUND', `Unknown task: ${id}`);
  return task;
}

function getAttempt(task, rawAttempt) {
  const number = Number(rawAttempt);
  const attempt = task.attempts.find((entry) => entry.number === number);
  if (!attempt)
    throw new CliError('ATTEMPT_NOT_FOUND', `Unknown attempt ${rawAttempt} for ${task.id}`);
  return attempt;
}

function latestAttempt(task) {
  return task.attempts.at(-1) ?? null;
}

function latestCandidate(task) {
  return task.candidates.at(-1) ?? null;
}

function pathOverlaps(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function activeLocks(state, excludeTask = null) {
  return state.tasks.flatMap((task) => {
    if (task.id === excludeTask) return [];
    const attempt = latestAttempt(task);
    if (!attempt || !ACTIVE_ATTEMPTS.has(attempt.status)) return [];
    return [{ task: task.id, scope: task.scope, resources: task.resources }];
  });
}

function lockConflicts(state, task) {
  const conflicts = [];
  for (const lock of activeLocks(state, task.id)) {
    const paths = task.scope.filter((candidate) =>
      lock.scope.some((held) => pathOverlaps(candidate, held)),
    );
    const resources = task.resources.filter((resource) => lock.resources.includes(resource));
    if (paths.length || resources.length) conflicts.push({ task: lock.task, paths, resources });
  }
  return conflicts;
}

function isAncestor(root, ancestor, descendant) {
  const result = git(root, ['merge-base', '--is-ancestor', ancestor, descendant], {
    allowFailure: true,
  });
  return result.status === 0;
}

function dependencyState(root, state, task) {
  const developSha = gitText(root, ['rev-parse', integrationRef(root)]);
  return task.dependsOn.map((id) => {
    const dependency = getTask(state, id);
    const valid =
      dependency.status === 'done' &&
      dependency.merge?.workerSha &&
      dependency.merge?.developSha &&
      isAncestor(root, dependency.merge.workerSha, developSha) &&
      isAncestor(root, dependency.merge.developSha, developSha);
    return { id, status: dependency.status, valid };
  });
}

function branchSlug(id) {
  return id.toLowerCase();
}

function taskReference(id) {
  if (/^ORCH-/.test(id) || /^[A-Z][A-Z0-9]+-\d+$/.test(id)) return id;
  return `ORCH-${id}`;
}

function assertMergeHooksReady(worktree) {
  const configured = git(worktree, ['config', '--path', '--get', 'core.hooksPath'], {
    allowFailure: true,
  });
  if (configured.status === 1 && configured.stdout.trim() === '') return;
  if (configured.status !== 0 || configured.stdout.trim() === '') {
    throw new CliError('HOOKS_NOT_READY', 'Configured core.hooksPath cannot be resolved');
  }
  const value = configured.stdout.trim();
  const hooksPath = path.isAbsolute(value) ? value : path.resolve(worktree, value);
  let stat;
  try {
    stat = lstatSync(hooksPath);
  } catch {
    throw new CliError('HOOKS_NOT_READY', `Configured hooks directory is missing: ${hooksPath}`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new CliError('HOOKS_NOT_READY', `Configured hooks path is not a directory: ${hooksPath}`);
  }
}

function assertWorktreeAt(root, worktree, sha) {
  const actual = gitText(worktree, ['rev-parse', 'HEAD']);
  if (actual !== sha) {
    throw new CliError('HEAD_MISMATCH', `Expected ${sha}, found ${actual} in ${worktree}`);
  }
  const dirty = gitText(worktree, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (dirty) {
    throw new CliError('DIRTY_WORKTREE', `Worktree is dirty: ${worktree}`, {
      paths: dirty.split('\n').map((line) => line.slice(3)),
    });
  }
  if (!isAncestor(root, sha, actual)) {
    throw new CliError(
      'HEAD_MISMATCH',
      `Commit is not available from canonical repository: ${sha}`,
    );
  }
}

function parseNameStatus(result) {
  const tokens = result.split('\0').filter(Boolean);
  const files = [];
  for (let index = 0; index < tokens.length; ) {
    const status = tokens[index++];
    const first = tokens[index++];
    if (!status || !first) break;
    files.push(first);
    if (status.startsWith('R') || status.startsWith('C')) {
      const second = tokens[index++];
      if (second) files.push(second);
    }
  }
  return [...new Set(files)].sort();
}

function diffPaths(root, base, commit) {
  return parseNameStatus(git(root, ['diff', '--name-status', '-z', `${base}..${commit}`]).stdout);
}

function historyPaths(root, base, commit) {
  const merges = gitText(root, ['rev-list', '--min-parents=2', `${base}..${commit}`]);
  if (merges) {
    throw new CliError(
      'WORKER_MERGE_FORBIDDEN',
      'Worker history must be linear; merge commits require Orchestrator integration',
    );
  }
  const commits = gitText(root, ['rev-list', '--reverse', `${base}..${commit}`])
    .split('\n')
    .filter(Boolean);
  const files = commits.flatMap((sha) =>
    parseNameStatus(
      git(root, ['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-z', sha]).stdout,
    ),
  );
  return [...new Set(files)].sort();
}

function changedWorktreePaths(worktree) {
  const tracked = [
    ...gitText(worktree, ['diff', '--name-only', 'HEAD']).split('\n'),
    ...gitText(worktree, ['diff', '--cached', '--name-only', 'HEAD']).split('\n'),
    ...gitText(worktree, ['ls-files', '--others', '--exclude-standard']).split('\n'),
  ].filter(Boolean);
  return [...new Set(tracked)].sort();
}

function readResultFile(file) {
  let value;
  try {
    value = JSON.parse(readFileSync(path.resolve(file), 'utf8'));
  } catch (error) {
    throw new CliError('INVALID_RESULT', `Cannot parse result file: ${error.message}`);
  }
  for (const key of ['outcome', 'selfReview', 'nextStep']) {
    if (typeof value[key] !== 'string' || value[key].trim() === '') {
      throw new CliError('INVALID_RESULT', `${key} must be a non-empty string`);
    }
  }
  for (const key of ['changedFiles', 'checks', 'acceptance', 'limitations']) {
    stringArray(value[key], key);
  }
  return {
    outcome: value.outcome.trim(),
    changedFiles: [...new Set(value.changedFiles)].sort(),
    selfReview: value.selfReview.trim(),
    checks: value.checks,
    acceptance: value.acceptance,
    limitations: value.limitations,
    nextStep: value.nextStep.trim(),
  };
}

function assertBoundAttempt(task, attempt, options) {
  if (attempt !== latestAttempt(task) || attempt.status !== 'active') {
    throw new CliError(
      'STALE_ATTEMPT',
      `Attempt ${attempt.number} is not the active attempt for ${task.id}`,
    );
  }
  const handle = required(options, 'handle');
  if (!attempt.handle || attempt.handle !== handle) {
    throw new CliError('STALE_WORKER', 'Worker handle does not match the bound active worker');
  }
}

function makePrompt(state, task, attempt) {
  const autonomy =
    state.mode === 'autonomous'
      ? 'You may commit only your scoped changes on the assigned branch. Do not merge or push.'
      : 'Review mode: do not commit, merge or push. Return a retained draft result.';
  const dependencies = task.dependsOn.map((id) => {
    const dependency = getTask(state, id);
    return `${id}@${dependency.merge?.developSha ?? 'NOT_MERGED'}`;
  });
  return [
    `Task ${task.id}, attempt ${attempt.number}`,
    `Goal: ${task.outcome}`,
    `Why: ${task.why}`,
    `Canonical repository: ${state.root}`,
    `Required cwd: ${attempt.worktree}`,
    `Base SHA: ${attempt.baseSha}`,
    `Branch: ${attempt.branch}`,
    `Allowed paths: ${task.scope.join(', ')}`,
    `Locked resources: ${task.resources.join(', ') || '(none)'}`,
    `Verified dependencies: ${dependencies.join(', ') || '(none)'}`,
    `Read first: ${task.sourceDocs.join(', ') || '(task-local files only)'}`,
    'Read existing repository instructions and the approved project context. Follow the packaged Flowcairn Skills.',
    `Acceptance: ${task.acceptance.join(' | ')}`,
    `Required checks: ${task.checks.map((entry) => JSON.stringify(entry)).join(' ; ')}`,
    `Selected model/effort: ${attempt.model} / ${attempt.effort}`,
    `Routing reason: ${attempt.routingReason}`,
    autonomy,
    'You are not alone in the codebase. Preserve others changes and do not edit the orchestrator registry.',
    'Do not widen scope, choose the next task, reuse another worktree, delete artifacts, bypass hooks, or resolve unrelated conflicts.',
    `Commit format when authorized: Conventional Commit with Russian description and footer "Refs: ${taskReference(task.id)}".`,
    `Report identity: task=${task.id}, attempt=${attempt.number}, handle=${attempt.handle ?? 'BIND_PENDING'}, base=${attempt.baseSha}.`,
    'Return JSON with outcome, changedFiles, selfReview, checks, acceptance, limitations, and nextStep. The Orchestrator verifies it against Git.',
  ].join('\n');
}

function authorizeSource(root, options) {
  const owner = required(options, 'owner');
  return withLock(root, owner, () => {
    const state = readState(root);
    if (state.owner !== owner)
      throw new CliError('OWNER_MISMATCH', 'Only the current owner can authorize a source');
    if (state.runStatus !== 'active')
      throw new CliError('RUN_CLOSED', 'Source authorization requires an active registry');
    if (
      state.tasks.some((task) =>
        ['allocating', 'reserved', 'active', 'reported', 'drafted'].includes(
          latestAttempt(task)?.status,
        ),
      )
    )
      throw new CliError(
        'ACTIVE_WORKER',
        'Stop and verify all workers before authorizing a new source',
      );
    const reason = required(options, 'reason');
    const sourceHash = verifyBootstrapSource(root, required(options, 'source-bundle'));
    const previousSourceHash = state.bootstrapSourceHash ?? null;
    state.bootstrapSourceHash = sourceHash;
    state.sourceAuthorizations = [
      ...(state.sourceAuthorizations ?? []),
      { sourceHash, previousSourceHash, owner, reason, at: now() },
    ];
    atomicWrite(root, state);
    return { ok: true, command: 'authorize-source', sourceHash, previousSourceHash };
  });
}

function init(root, options) {
  const registryPaths = pathsFor(root);
  if (existsSync(registryPaths.state)) {
    throw new CliError('STATE_EXISTS', `Registry already exists: ${registryPaths.state}`);
  }
  const bootstrapSourceBundle = options['bootstrap-source-bundle'];
  assertIntegrationRoot(root, { clean: bootstrapSourceBundle === undefined });
  const bootstrapSourceHash =
    bootstrapSourceBundle === undefined ? null : verifyBootstrapSource(root, bootstrapSourceBundle);
  const mode = required(options, 'mode');
  if (!['review', 'autonomous'].includes(mode)) {
    throw new CliError('INVALID_ARGUMENT', '--mode must be review or autonomous');
  }
  const owner = required(options, 'owner');
  const state = {
    schemaVersion: SCHEMA_VERSION,
    root,
    integrationBranch: integrationBranch(root),
    projectProfileHash: projectProfileHash(root),
    owner,
    goal: required(options, 'goal'),
    mode,
    runStatus: 'active',
    limits: {
      maxTasks: positiveInteger(options, 'max-tasks'),
      maxRetries: nonNegativeInteger(options, 'max-retries'),
      maxWorkers: positiveInteger(options, 'max-workers'),
    },
    developStartSha: gitText(root, ['rev-parse', integrationRef(root)]),
    bootstrapSourceHash,
    tasks: [],
    runHistory: [],
    createdAt: now(),
    updatedAt: now(),
  };
  mkdirSync(registryPaths.logs, { recursive: true, mode: 0o700 });
  mkdirSync(registryPaths.worktrees, { recursive: true, mode: 0o700 });
  atomicWrite(root, state);
  return { ok: true, command: 'init', statePath: registryPaths.state, state };
}

function add(root, options) {
  const owner = required(options, 'owner');
  return withLock(root, owner, () => {
    const state = readState(root);
    assertOwner(state, owner);
    let raw;
    try {
      raw = JSON.parse(readFileSync(path.resolve(required(options, 'spec')), 'utf8'));
    } catch (error) {
      throw new CliError('INVALID_SPEC', `Cannot parse task spec: ${error.message}`);
    }
    const additions = (Array.isArray(raw) ? raw : [raw]).map(validateTask);
    const historicalIds = state.runHistory.flatMap(
      (run) => run.taskReceipts?.map((task) => task.id) ?? [],
    );
    const ids = new Set([...state.tasks.map((task) => task.id), ...historicalIds]);
    for (const task of additions) {
      if (ids.has(task.id)) throw new CliError('DUPLICATE_TASK', `Duplicate task id: ${task.id}`);
      ids.add(task.id);
    }
    if (state.tasks.length + additions.length > state.limits.maxTasks) {
      throw new CliError('TASK_LIMIT', `Task limit is ${state.limits.maxTasks}`);
    }
    const tasks = [...state.tasks, ...additions];
    assertDependencyGraph(tasks);
    state.tasks = tasks;
    atomicWrite(root, state);
    return { ok: true, command: 'add', added: additions.map((task) => task.id) };
  });
}

function next(root, options) {
  const state = readState(root);
  if (options.owner && state.owner !== String(options.owner)) {
    throw new CliError('OWNER_MISMATCH', `Registry belongs to ${state.owner}`);
  }
  const activeCount = activeLocks(state).length;
  const capacity = Math.max(0, state.limits.maxWorkers - activeCount);
  const schedulable = state.runStatus === 'active' && capacity > 0;
  const tasks = state.tasks.map((task) => {
    const dependencies = dependencyState(root, state, task);
    const conflicts = lockConflicts(state, task);
    const ready =
      schedulable &&
      task.status === 'pending' &&
      dependencies.every((entry) => entry.valid) &&
      conflicts.length === 0;
    return { id: task.id, status: task.status, ready, dependencies, conflicts };
  });
  const ready = state.tasks
    .filter((task) => tasks.find((entry) => entry.id === task.id).ready)
    .sort(
      (left, right) =>
        left.priority - right.priority || left.createdAt.localeCompare(right.createdAt),
    )
    .slice(0, capacity)
    .map((task) => task.id);
  return {
    ok: true,
    command: 'next',
    runStatus: state.runStatus,
    schedulable,
    activeCount,
    capacity,
    tasks,
    ready,
  };
}

function completeTaskAllocation(root, state, task, attempt) {
  const branchExists =
    git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${attempt.branch}`], {
      allowFailure: true,
    }).status === 0;
  const worktreeExists = existsSync(attempt.worktree);
  if (!branchExists && worktreeExists) {
    throw new CliError(
      'ALLOCATION_INCONSISTENT',
      `Worktree path exists without recorded branch: ${attempt.worktree}`,
    );
  }
  if (branchExists) {
    const branchSha = gitText(root, ['rev-parse', `refs/heads/${attempt.branch}`]);
    if (branchSha !== attempt.baseSha) {
      throw new CliError(
        'ALLOCATION_INCONSISTENT',
        `Allocating branch moved from its recorded base: ${attempt.branch}`,
      );
    }
  }
  if (!branchExists) {
    git(root, ['worktree', 'add', '-b', attempt.branch, attempt.worktree, attempt.baseSha]);
  } else if (!worktreeExists) {
    git(root, ['worktree', 'add', attempt.worktree, attempt.branch]);
  }
  assertWorktreeAt(root, attempt.worktree, attempt.baseSha);
  attempt.status = 'reserved';
  attempt.reservedAt = now();
  task.status = 'reserved';
  atomicWrite(root, state);
  return {
    ok: true,
    command: attempt.graphBinding ? 'graph-reserve' : 'claim',
    task: task.id,
    attempt,
    recoveredAllocation: branchExists || worktreeExists,
  };
}

function reserveTaskAttempt(root, state, task, { worker, graphBinding = undefined }) {
  if (task.status !== 'pending')
    throw new CliError('TASK_NOT_PENDING', `${task.id} is ${task.status}`);
  const dependencies = dependencyState(root, state, task);
  if (!dependencies.every((entry) => entry.valid)) {
    throw new CliError(
      'DEPENDENCY_BLOCKED',
      `${task.id} has incomplete or invalid dependencies`,
      dependencies,
    );
  }
  const conflicts = lockConflicts(state, task);
  if (conflicts.length)
    throw new CliError('LOCK_CONFLICT', `${task.id} conflicts with active ownership`, conflicts);
  const activeCount = activeLocks(state).length;
  if (activeCount >= state.limits.maxWorkers) {
    throw new CliError('WORKER_LIMIT', `Active worker limit is ${state.limits.maxWorkers}`);
  }
  const attemptNumber = task.attempts.length + 1;
  if (attemptNumber > state.limits.maxRetries + 1) {
    throw new CliError('RETRY_LIMIT', `${task.id} exhausted its retry limit`);
  }
  const branch = `codex/${branchSlug(task.id)}-${attemptNumber}`;
  const worktree = path.join(pathsFor(root).worktrees, `${branchSlug(task.id)}-${attemptNumber}`);
  if (
    existsSync(worktree) ||
    git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { allowFailure: true })
      .status === 0
  ) {
    throw new CliError(
      'ARTIFACT_EXISTS',
      `Refusing to reuse existing branch/worktree for ${branch}`,
    );
  }
  const baseSha = gitText(root, ['rev-parse', integrationRef(root)]);
  const attempt = {
    number: attemptNumber,
    branch,
    worktree,
    baseSha,
    worker,
    model: task.model,
    effort: task.effort,
    routingReason: task.routingReason ?? 'task specification',
    handle: null,
    status: 'allocating',
    allocationStartedAt: now(),
    boundAt: null,
    reportedSha: null,
    result: null,
    checks: { worker: [] },
    ...(graphBinding === undefined ? {} : { graphBinding }),
  };
  task.attempts.push(attempt);
  task.status = 'allocating';
  atomicWrite(root, state);
  return completeTaskAllocation(root, state, task, attempt);
}

function claim(root, options) {
  const owner = required(options, 'owner');
  const taskId = required(options, 'task');
  const worker = required(options, 'worker');
  return withLock(root, owner, () => {
    const state = readState(root);
    assertOwner(state, owner);
    assertIntegrationRoot(root);
    const task = getTask(state, taskId);
    const allocating = latestAttempt(task);
    if (task.status === 'allocating' && allocating?.status === 'allocating') {
      if (allocating.worker !== worker) {
        throw new CliError(
          'ALLOCATION_OWNED',
          `Partial allocation belongs to ${allocating.worker}`,
        );
      }
      return completeTaskAllocation(root, state, task, allocating);
    }
    return reserveTaskAttempt(root, state, task, { worker });
  });
}

function graphBindingResult(task, attempt, { recoveredAllocation = false } = {}) {
  return {
    ok: true,
    command: 'graph-reserve',
    taskId: task.id,
    attemptId: attempt.number,
    leaseId: attempt.graphBinding.leaseId,
    sourceHash: attempt.graphBinding.sourceHash,
    worktree: attempt.worktree,
    runId: attempt.graphBinding.runId,
    owner: attempt.graphBinding.owner,
    recoveredAllocation,
  };
}

function graphReserve(root, options) {
  const owner = required(options, 'owner');
  const taskId = required(options, 'task');
  const runId = required(options, 'run');
  const sourceHash = required(options, 'source-hash');
  if (!GRAPH_RUN_ID.test(runId)) {
    throw new CliError('INVALID_ARGUMENT', '--run must use lowercase letters, digits and dashes');
  }
  if (!SOURCE_HASH.test(sourceHash)) {
    throw new CliError('INVALID_ARGUMENT', '--source-hash must be a lowercase SHA-256');
  }
  if (
    options['bootstrap-dirty-snapshot'] !== undefined &&
    options['bootstrap-dirty-snapshot'] !== true
  ) {
    throw new CliError(
      'INVALID_ARGUMENT',
      '--bootstrap-dirty-snapshot must be an internal boolean flag',
    );
  }
  const existingAttempt = options['existing-attempt'];
  const existingLease = options['existing-lease'];
  if ((existingAttempt === undefined) !== (existingLease === undefined)) {
    throw new CliError(
      'INVALID_ARGUMENT',
      '--existing-attempt and --existing-lease must be provided together',
    );
  }

  return withLock(root, owner, () => {
    const state = readState(root);
    assertOwner(state, owner);
    const task = getTask(state, taskId);

    const latest = latestAttempt(task);
    const exactReplay =
      latest?.graphBinding?.runId === runId &&
      latest.graphBinding.sourceHash === sourceHash &&
      latest.graphBinding.owner === owner;
    if (existingAttempt !== undefined || exactReplay) {
      const attempt = existingAttempt !== undefined ? getAttempt(task, existingAttempt) : latest;
      if (attempt !== latestAttempt(task)) {
        throw new CliError('STALE_ATTEMPT', 'Graph binding must target the latest task attempt');
      }
      const binding = attempt.graphBinding;
      if (
        !binding ||
        binding.owner !== owner ||
        binding.runId !== runId ||
        binding.sourceHash !== sourceHash ||
        (existingLease !== undefined && binding.leaseId !== existingLease)
      ) {
        throw new CliError('STALE_GRAPH_BINDING', 'Explicit Graph binding no longer matches');
      }
      if (attempt.status === 'allocating' && task.status === 'allocating') {
        const allocation = completeTaskAllocation(root, state, task, attempt);
        return graphBindingResult(task, allocation.attempt, {
          recoveredAllocation: allocation.recoveredAllocation,
        });
      }
      if (!['reserved', 'active'].includes(attempt.status)) {
        throw new CliError('STALE_GRAPH_BINDING', `Graph attempt is ${attempt.status}`);
      }
      return graphBindingResult(task, attempt, { recoveredAllocation: true });
    }

    if (task.status !== 'pending') {
      throw new CliError(
        'GRAPH_BINDING_REQUIRED',
        `${task.id} already has an allocation; pass its explicit Graph binding`,
      );
    }
    const bootstrapDirtySnapshot = options['bootstrap-dirty-snapshot'] === true;
    if (bootstrapDirtySnapshot && state.bootstrapSourceHash !== sourceHash) {
      throw new CliError(
        'BOOTSTRAP_SOURCE_MISMATCH',
        'Dirty bootstrap flag is not authorized for the requested source hash',
      );
    }
    assertIntegrationRoot(root, { clean: !bootstrapDirtySnapshot });
    const graphBinding = {
      runId,
      leaseId: randomUUID(),
      sourceHash,
      owner,
      bootstrapDirtySnapshot,
      reservedAt: now(),
    };
    const allocation = reserveTaskAttempt(root, state, task, {
      worker: `graph:${runId}`,
      graphBinding,
    });
    return graphBindingResult(task, allocation.attempt, {
      recoveredAllocation: allocation.recoveredAllocation,
    });
  });
}

function graphVerify(root, options, { ownsLock = false } = {}) {
  if (!ownsLock && existsSync(pathsFor(root).lock)) {
    throw new CliError('REGISTRY_LOCKED', 'Registry is being mutated; retry Graph verification');
  }
  const state = readState(root);
  const task = getTask(state, required(options, 'task'));
  const attempt = getAttempt(task, required(options, 'attempt'));
  const binding = attempt.graphBinding;
  if (!binding) throw new CliError('GRAPH_BINDING_MISSING', 'Attempt has no Graph binding');
  if (state.runStatus !== 'active' || binding.owner !== state.owner) {
    throw new CliError('STALE_GRAPH_OWNER', 'Graph binding owner is no longer active');
  }
  if (attempt !== latestAttempt(task) || attempt.status !== 'active' || task.status !== 'active') {
    throw new CliError('STALE_GRAPH_BINDING', 'Graph binding is not the current active attempt');
  }
  const expected = {
    owner: required(options, 'owner'),
    runId: required(options, 'run'),
    leaseId: required(options, 'lease'),
    sourceHash: required(options, 'source-hash'),
    worktree: path.resolve(required(options, 'worktree')),
  };
  if (
    binding.owner !== expected.owner ||
    binding.runId !== expected.runId ||
    binding.leaseId !== expected.leaseId ||
    binding.sourceHash !== expected.sourceHash ||
    attempt.worktree !== expected.worktree ||
    attempt.handle !== `graph:${binding.leaseId}`
  ) {
    throw new CliError('STALE_GRAPH_BINDING', 'Graph binding fields no longer match');
  }
  const worktreesRoot = realpathSync(pathsFor(root).worktrees);
  const actualWorktree = realpathSync(attempt.worktree);
  if (!actualWorktree.startsWith(`${worktreesRoot}${path.sep}`)) {
    throw new CliError('UNSAFE_WORKTREE', 'Graph worktree is outside Orchestrator ownership');
  }
  const branch = gitText(attempt.worktree, ['branch', '--show-current']);
  const head = gitText(attempt.worktree, ['rev-parse', 'HEAD']);
  if (branch !== attempt.branch || head !== attempt.baseSha) {
    throw new CliError('STALE_GRAPH_WORKTREE', 'Graph worktree branch or HEAD changed');
  }
  const currentState = readState(root);
  if (
    JSON.stringify(currentState) !== JSON.stringify(state) ||
    (!ownsLock && existsSync(pathsFor(root).lock))
  ) {
    throw new CliError('REGISTRY_CHANGED', 'Registry changed during Graph verification');
  }
  return {
    ok: true,
    command: 'graph-verify',
    taskId: task.id,
    attemptId: attempt.number,
    leaseId: binding.leaseId,
    sourceHash: binding.sourceHash,
    worktree: attempt.worktree,
    runId: binding.runId,
    owner: binding.owner,
  };
}

/** Trusted in-process write fence. Not exposed as a CLI/Graph control operation. */
export function withGraphBindingFence(root, binding, callbackSync) {
  if (typeof callbackSync !== 'function' || callbackSync.constructor?.name === 'AsyncFunction') {
    throw new CliError('INVALID_FENCE', 'Graph write fence requires a synchronous callback');
  }
  if (!binding || typeof binding !== 'object') {
    throw new CliError('INVALID_BINDING', 'Graph binding is required');
  }
  const options = {
    owner: binding.owner,
    task: binding.taskId,
    attempt: String(binding.attemptId),
    run: binding.runId,
    lease: binding.leaseId,
    'source-hash': binding.sourceHash,
    worktree: binding.worktree,
  };
  const owner = required(options, 'owner');
  return withLock(root, owner, () => {
    const verified = graphVerify(root, options, { ownsLock: true });
    const result = callbackSync(verified);
    if (result && typeof result.then === 'function') {
      throw new CliError('INVALID_FENCE', 'Graph write fence callback returned a Promise');
    }
    return result;
  });
}

function graphRebind(root, options) {
  const owner = required(options, 'owner');
  const oldRunId = required(options, 'run');
  const newRunId = required(options, 'new-run');
  const oldSourceHash = required(options, 'source-hash');
  const newSourceHash = required(options, 'new-source-hash');
  if (!GRAPH_RUN_ID.test(oldRunId) || !GRAPH_RUN_ID.test(newRunId) || oldRunId === newRunId) {
    throw new CliError(
      'INVALID_ARGUMENT',
      '--run and --new-run must be distinct valid Graph run IDs',
    );
  }
  if (!SOURCE_HASH.test(oldSourceHash) || !SOURCE_HASH.test(newSourceHash)) {
    throw new CliError('INVALID_ARGUMENT', 'Graph source hashes must be lowercase SHA-256 values');
  }
  if (options['previous-run-stopped'] !== true) {
    throw new CliError('RUN_STOP_UNCONFIRMED', '--previous-run-stopped is required');
  }
  return withLock(root, owner, () => {
    const state = readState(root);
    assertOwner(state, owner);
    if (state.runStatus !== 'active') throw new CliError('RUN_CLOSED', `Run is ${state.runStatus}`);
    const task = getTask(state, required(options, 'task'));
    const attempt = getAttempt(task, required(options, 'attempt'));
    const binding = attempt.graphBinding;
    const oldLeaseId = required(options, 'lease');
    const requestedWorktree = path.resolve(required(options, 'worktree'));
    const currentAttempt = Boolean(
      binding &&
      binding.owner === owner &&
      attempt.worktree === requestedWorktree &&
      attempt.handle === `graph:${binding.leaseId}` &&
      attempt === latestAttempt(task) &&
      attempt.status === 'active' &&
      task.status === 'active',
    );
    const exactReplay =
      currentAttempt &&
      binding.runId === newRunId &&
      binding.sourceHash === newSourceHash &&
      binding.priorRunId === oldRunId &&
      binding.priorLeaseId === oldLeaseId &&
      binding.priorSourceHash === oldSourceHash;
    const currentOldBinding =
      currentAttempt &&
      binding.runId === oldRunId &&
      binding.sourceHash === oldSourceHash &&
      binding.leaseId === oldLeaseId;
    if (!exactReplay && !currentOldBinding) {
      throw new CliError('STALE_GRAPH_BINDING', 'Previous Graph binding is no longer current');
    }
    const worktreesRoot = realpathSync(pathsFor(root).worktrees);
    const actualWorktree = realpathSync(attempt.worktree);
    if (!actualWorktree.startsWith(`${worktreesRoot}${path.sep}`)) {
      throw new CliError('UNSAFE_WORKTREE', 'Graph worktree is outside Orchestrator ownership');
    }
    const branch = gitText(attempt.worktree, ['branch', '--show-current']);
    const head = gitText(attempt.worktree, ['rev-parse', 'HEAD']);
    if (branch !== attempt.branch || head !== attempt.baseSha) {
      throw new CliError('STALE_GRAPH_WORKTREE', 'Graph worktree branch or HEAD changed');
    }
    if (exactReplay) return graphBindingResult(task, attempt, { recoveredAllocation: true });
    const previous = binding;
    const leaseId = randomUUID();
    attempt.graphBinding = {
      runId: newRunId,
      leaseId,
      sourceHash: newSourceHash,
      owner,
      bootstrapDirtySnapshot: previous.bootstrapDirtySnapshot,
      reservedAt: now(),
      priorRunId: previous.runId,
      priorLeaseId: previous.leaseId,
      priorSourceHash: previous.sourceHash,
    };
    attempt.worker = `graph:${newRunId}`;
    attempt.handle = `graph:${leaseId}`;
    attempt.boundAt = now();
    atomicWrite(root, state);
    return graphBindingResult(task, attempt);
  });
}

function bind(root, options) {
  const owner = required(options, 'owner');
  return withLock(root, owner, () => {
    const state = readState(root);
    assertOwner(state, owner);
    const task = getTask(state, required(options, 'task'));
    const attempt = getAttempt(task, required(options, 'attempt'));
    if (attempt !== latestAttempt(task) || attempt.status !== 'reserved') {
      throw new CliError('STALE_ATTEMPT', 'Only the latest reserved attempt can be bound');
    }
    const handle = required(options, 'handle');
    if (attempt.graphBinding && handle !== `graph:${attempt.graphBinding.leaseId}`) {
      throw new CliError('STALE_GRAPH_BINDING', 'Graph attempt handle must match its lease');
    }
    const duplicate = state.tasks.some((entry) =>
      entry.attempts.some(
        (candidate) =>
          candidate !== attempt &&
          ACTIVE_ATTEMPTS.has(candidate.status) &&
          candidate.handle === handle,
      ),
    );
    if (duplicate) throw new CliError('DUPLICATE_HANDLE', `Handle is already active: ${handle}`);
    attempt.handle = handle;
    attempt.status = 'active';
    attempt.boundAt = now();
    task.status = 'active';
    atomicWrite(root, state);
    return { ok: true, command: 'bind', task: task.id, attempt: attempt.number, handle };
  });
}

function prompt(root, options) {
  const state = readState(root);
  if (options.owner) assertOwner(state, String(options.owner));
  const task = getTask(state, required(options, 'task'));
  const attempt = getAttempt(task, required(options, 'attempt'));
  if (attempt !== latestAttempt(task) || !['reserved', 'active'].includes(attempt.status)) {
    throw new CliError('STALE_ATTEMPT', 'Prompt requires the latest reserved or active attempt');
  }
  return {
    ok: true,
    command: 'prompt',
    task: task.id,
    attempt: attempt.number,
    prompt: makePrompt(state, task, attempt),
  };
}

function report(root, options, { draft = false } = {}) {
  const owner = required(options, 'owner');
  return withLock(root, owner, () => {
    const state = readState(root);
    assertOwner(state, owner);
    const task = getTask(state, required(options, 'task'));
    const attempt = getAttempt(task, required(options, 'attempt'));
    assertBoundAttempt(task, attempt, options);
    const result = readResultFile(required(options, 'result-file'));
    if (draft) {
      if (state.mode !== 'review')
        throw new CliError('MODE_MISMATCH', 'draft is only valid in review mode');
      const head = gitText(attempt.worktree, ['rev-parse', 'HEAD']);
      if (head !== attempt.baseSha)
        throw new CliError(
          'COMMIT_FORBIDDEN',
          'Review-mode draft must remain at its assigned base commit',
        );
      const files = changedWorktreePaths(attempt.worktree);
      const violations = files.filter(
        (file) => !task.scope.some((scope) => file === scope || file.startsWith(`${scope}/`)),
      );
      if (violations.length)
        throw new CliError('SCOPE_VIOLATION', 'Draft changes paths outside its scope', violations);
      if (JSON.stringify(files) !== JSON.stringify(result.changedFiles)) {
        throw new CliError(
          'RESULT_MISMATCH',
          'Draft changedFiles do not match the retained worktree',
          { expected: files, reported: result.changedFiles },
        );
      }
      attempt.result = result;
      attempt.scopeFiles = files;
      attempt.status = 'drafted';
      attempt.draftedAt = now();
      task.status = 'drafted';
      atomicWrite(root, state);
      return {
        ok: true,
        command: 'draft',
        task: task.id,
        attempt: attempt.number,
        status: task.status,
      };
    }
    if (state.mode !== 'autonomous') {
      throw new CliError(
        'MODE_MISMATCH',
        'Committed worker reports are disabled in review mode; use draft',
      );
    }
    const commit = required(options, 'commit');
    const branchSha = gitText(root, ['rev-parse', `refs/heads/${attempt.branch}`]);
    if (branchSha !== commit)
      throw new CliError('COMMIT_MISMATCH', `Branch head is ${branchSha}, report says ${commit}`);
    assertWorktreeAt(root, attempt.worktree, commit);
    if (!isAncestor(root, attempt.baseSha, commit) || commit === attempt.baseSha) {
      throw new CliError(
        'INVALID_COMMIT',
        'Worker commit must descend from and differ from its base',
      );
    }
    const files = diffPaths(root, attempt.baseSha, commit);
    const touchedHistory = historyPaths(root, attempt.baseSha, commit);
    const violations = touchedHistory.filter(
      (file) =>
        !task.scope.some(
          (scope) => pathOverlaps(file, scope) && (file === scope || file.startsWith(`${scope}/`)),
        ),
    );
    if (violations.length)
      throw new CliError(
        'SCOPE_VIOLATION',
        'Worker commit changes paths outside its scope',
        violations,
      );
    if (JSON.stringify(files) !== JSON.stringify(result.changedFiles)) {
      throw new CliError('RESULT_MISMATCH', 'Result changedFiles do not match Git diff', {
        expected: files,
        reported: result.changedFiles,
      });
    }
    attempt.reportedSha = commit;
    attempt.result = result;
    attempt.scopeFiles = files;
    attempt.historyScopeFiles = touchedHistory;
    attempt.status = 'reported';
    attempt.reportedAt = now();
    task.status = 'reported';
    atomicWrite(root, state);
    return {
      ok: true,
      command: 'report',
      task: task.id,
      attempt: attempt.number,
      commit,
      files,
      done: false,
    };
  });
}

function runChecks(root, options) {
  const owner = required(options, 'owner');
  return withLock(root, owner, () => {
    const state = readState(root);
    assertOwner(state, owner);
    const task = getTask(state, required(options, 'task'));
    if (!Array.isArray(task.checks) || task.checks.length === 0)
      throw new CliError('CHECK_NOT_ALLOWED', 'Нет зарегистрированных проверок для выполнения.');
    const commands = task.checks.map((command) => registeredHostCheck(command, task.scope));
    const attempt = getAttempt(task, required(options, 'attempt'));
    if (attempt !== latestAttempt(task))
      throw new CliError('STALE_ATTEMPT', 'Checks require the latest task attempt');
    const phase = required(options, 'phase');
    let target;
    if (phase === 'worker') {
      if (attempt.status !== 'reported' || !attempt.reportedSha) {
        throw new CliError('REPORT_REQUIRED', 'A verified worker report is required first');
      }
      target = {
        sha: attempt.reportedSha,
        worktree: attempt.worktree,
        checks: attempt.checks.worker,
      };
    } else if (phase === 'candidate') {
      const candidate = latestCandidate(task);
      if (
        !candidate ||
        candidate.status !== 'built' ||
        candidate.attemptNumber !== attempt.number
      ) {
        throw new CliError(
          'CANDIDATE_REQUIRED',
          'A current integration candidate for this attempt is required',
        );
      }
      target = { sha: candidate.sha, worktree: candidate.worktree, checks: candidate.checks };
    } else {
      throw new CliError('INVALID_ARGUMENT', '--phase must be worker or candidate');
    }
    assertWorktreeAt(root, target.worktree, target.sha);
    const checkRun = { sha: target.sha, startedAt: now(), commands: [], status: 'running' };
    target.checks.push(checkRun);
    atomicWrite(root, state);
    const logDirectory = path.join(pathsFor(root).logs, task.id.toLowerCase());
    mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
    for (let index = 0; index < commands.length; index += 1) {
      const argv = commands[index];
      const result = run(argv[0], argv.slice(1), {
        cwd: target.worktree,
        timeout: task.checkTimeoutMs,
        allowFailure: true,
        env: {
          PATH: '/usr/bin:/bin',
          HOME: '/var/empty',
          CI: 'true',
          LC_ALL: 'C',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_OPTIONAL_LOCKS: '0',
        },
      });
      const logPath = path.join(
        logDirectory,
        `${attempt.number}-${phase}-${Date.now()}-${index + 1}.log`,
      );
      writeFileSync(logPath, `${result.stdout}${result.stderr}`, { mode: 0o600 });
      let integrityError = null;
      try {
        assertWorktreeAt(root, target.worktree, target.sha);
      } catch (error) {
        integrityError = { code: error.code ?? 'CHECK_MUTATED_WORKTREE', message: error.message };
      }
      const passed = result.status === 0 && !result.error && !integrityError;
      checkRun.commands.push({
        argv,
        status: result.status,
        signal: result.signal,
        error: result.error,
        integrityError,
        logPath,
        passed,
      });
      if (!passed) break;
    }
    checkRun.finishedAt = now();
    checkRun.status =
      checkRun.commands.length === task.checks.length &&
      checkRun.commands.every((entry) => entry.passed)
        ? 'passed'
        : 'failed';
    atomicWrite(root, state);
    return {
      ok: checkRun.status === 'passed',
      command: 'check',
      task: task.id,
      attempt: attempt.number,
      phase,
      sha: target.sha,
      status: checkRun.status,
      logs: checkRun.commands.map((entry) => entry.logPath),
      checks: checkRun.commands,
      exitCode: checkRun.status === 'passed' ? 0 : 2,
    };
  });
}

function completeCandidate(root, state, task, attempt, integration) {
  const branchExists =
    git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${integration.branch}`], {
      allowFailure: true,
    }).status === 0;
  const worktreeExists = existsSync(integration.worktree);
  if (!branchExists && worktreeExists) {
    throw new CliError(
      'CANDIDATE_INCONSISTENT',
      `Candidate worktree exists without branch: ${integration.worktree}`,
    );
  }
  if (!branchExists) {
    git(root, [
      'worktree',
      'add',
      '-b',
      integration.branch,
      integration.worktree,
      integration.baseSha,
    ]);
  } else if (!worktreeExists) {
    git(root, ['worktree', 'add', integration.worktree, integration.branch]);
  }
  const checkedOutBranch = gitText(integration.worktree, ['branch', '--show-current']);
  if (checkedOutBranch !== integration.branch) {
    throw new CliError(
      'CANDIDATE_INCONSISTENT',
      `Candidate worktree is on ${checkedOutBranch || '(detached)'}`,
    );
  }
  let candidateSha = gitText(integration.worktree, ['rev-parse', 'HEAD']);
  if (candidateSha === integration.baseSha) {
    assertWorktreeAt(root, integration.worktree, integration.baseSha);
    assertMergeHooksReady(integration.worktree);
    const fastForward = isAncestor(root, integration.baseSha, attempt.reportedSha);
    const message = `chore(tooling): интегрировал задачу ${task.id.toLowerCase()}\n\nRefs: ${taskReference(task.id)}`;
    const merge = git(
      integration.worktree,
      fastForward
        ? ['merge', '--ff-only', attempt.reportedSha]
        : ['merge', '--no-ff', attempt.reportedSha, '-m', message],
      { allowFailure: true },
    );
    if (merge.status !== 0) {
      integration.status = 'conflicted';
      integration.conflictedAt = now();
      integration.conflict = { stdout: merge.stdout, stderr: merge.stderr };
      atomicWrite(root, state);
      return {
        ok: false,
        command: 'candidate',
        task: task.id,
        status: 'conflicted',
        branch: integration.branch,
        worktree: integration.worktree,
        exitCode: 2,
      };
    }
    candidateSha = gitText(integration.worktree, ['rev-parse', 'HEAD']);
  }
  assertWorktreeAt(root, integration.worktree, candidateSha);
  if (
    !isAncestor(root, integration.baseSha, candidateSha) ||
    !isAncestor(root, attempt.reportedSha, candidateSha)
  ) {
    throw new CliError(
      'CANDIDATE_INCONSISTENT',
      'Candidate does not contain its recorded base and Worker commit',
    );
  }
  const files = diffPaths(root, integration.baseSha, candidateSha);
  const violations = files.filter(
    (file) => !task.scope.some((scope) => file === scope || file.startsWith(`${scope}/`)),
  );
  if (violations.length) {
    integration.status = 'scope-violating';
    integration.scopeViolations = violations;
    atomicWrite(root, state);
    throw new CliError(
      'SCOPE_VIOLATION',
      'Candidate imports changes outside task scope',
      violations,
    );
  }
  integration.sha = candidateSha;
  integration.status = 'built';
  integration.builtAt = now();
  integration.scopeFiles = files;
  atomicWrite(root, state);
  return {
    ok: true,
    command: 'candidate',
    task: task.id,
    attempt: attempt.number,
    candidate: integration,
  };
}

function candidate(root, options) {
  const owner = required(options, 'owner');
  const taskId = required(options, 'task');
  const attemptNumber = required(options, 'attempt');
  return withLock(root, owner, () => {
    const state = readState(root);
    assertOwner(state, owner);
    if (state.mode !== 'autonomous')
      throw new CliError('MODE_MISMATCH', 'candidate is disabled in review mode');
    assertIntegrationRoot(root);
    const task = getTask(state, taskId);
    const attempt = getAttempt(task, attemptNumber);
    if (attempt !== latestAttempt(task) || attempt.status !== 'reported') {
      throw new CliError('REPORT_REQUIRED', 'Latest attempt must have a verified report');
    }
    if (
      attempt.checks.worker.at(-1)?.status !== 'passed' ||
      attempt.checks.worker.at(-1)?.sha !== attempt.reportedSha
    ) {
      throw new CliError('CHECK_REQUIRED', 'Worker checks must pass at the reported SHA');
    }
    const previous = latestCandidate(task);
    if (previous?.status === 'built' && previous.attemptNumber === attempt.number) {
      throw new CliError('CANDIDATE_EXISTS', `Current candidate already exists: ${previous.sha}`);
    }
    if (previous?.status === 'creating' && previous.attemptNumber === attempt.number) {
      return completeCandidate(root, state, task, attempt, previous);
    }
    if (previous?.status === 'conflicted' && previous.attemptNumber === attempt.number) {
      const dirty = gitText(previous.worktree, [
        'status',
        '--porcelain=v1',
        '--untracked-files=all',
      ]);
      if (dirty || gitText(previous.worktree, ['rev-parse', 'HEAD']) === previous.baseSha) {
        throw new CliError(
          'CONFLICT_UNRESOLVED',
          `Resolve and commit the retained candidate before retrying: ${previous.worktree}`,
        );
      }
      previous.status = 'creating';
      previous.reconciliationStartedAt = now();
      atomicWrite(root, state);
      return completeCandidate(root, state, task, attempt, previous);
    }
    const baseSha = gitText(root, ['rev-parse', integrationRef(root)]);
    if (!isAncestor(root, attempt.baseSha, baseSha)) {
      throw new CliError(
        'DEVELOP_DIVERGED',
        'Worker base is no longer an ancestor of the integration branch; retry from the current tip',
      );
    }
    const revision = task.candidates.length + 1;
    const integration = {
      revision,
      branch: `codex/integrate-${branchSlug(task.id)}-${attempt.number}-r${revision}`,
      worktree: path.join(
        pathsFor(root).worktrees,
        `integrate-${branchSlug(task.id)}-${attempt.number}-r${revision}`,
      ),
      baseSha,
      workerSha: attempt.reportedSha,
      attemptNumber: attempt.number,
      sha: null,
      status: 'creating',
      creatingAt: now(),
      checks: [],
      reviews: [],
    };
    if (
      existsSync(integration.worktree) ||
      git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${integration.branch}`], {
        allowFailure: true,
      }).status === 0
    ) {
      throw new CliError(
        'ARTIFACT_EXISTS',
        `Refusing to reuse integration artifact ${integration.branch}`,
      );
    }
    task.candidates.push(integration);
    atomicWrite(root, state);
    return completeCandidate(root, state, task, attempt, integration);
  });
}

function review(root, options) {
  const owner = required(options, 'owner');
  return withLock(root, owner, () => {
    const state = readState(root);
    assertOwner(state, owner);
    const task = getTask(state, required(options, 'task'));
    const attempt = getAttempt(task, required(options, 'attempt'));
    if (attempt !== latestAttempt(task))
      throw new CliError('STALE_ATTEMPT', 'Review requires the latest task attempt');
    const integration = latestCandidate(task);
    if (
      !integration ||
      integration.status !== 'built' ||
      integration.attemptNumber !== attempt.number
    ) {
      throw new CliError('CANDIDATE_REQUIRED', 'A current candidate for this attempt is required');
    }
    const commit = required(options, 'commit');
    if (commit !== integration.sha)
      throw new CliError('STALE_REVIEW', `Review must target current candidate ${integration.sha}`);
    if (
      integration.checks.at(-1)?.status !== 'passed' ||
      integration.checks.at(-1)?.sha !== integration.sha
    ) {
      throw new CliError('CHECK_REQUIRED', 'Candidate checks must pass before review is recorded');
    }
    assertWorktreeAt(root, integration.worktree, integration.sha);
    const reviewer = required(options, 'reviewer');
    if (reviewer === attempt.worker || reviewer === attempt.handle) {
      throw new CliError(
        'REVIEW_NOT_INDEPENDENT',
        'Reviewer must differ from the Worker identity and handle',
      );
    }
    const verdict = required(options, 'verdict');
    if (!['pass', 'fail'].includes(verdict))
      throw new CliError('INVALID_ARGUMENT', '--verdict must be pass or fail');
    const receipt = {
      reviewer,
      commit,
      verdict,
      summary: required(options, 'summary'),
      reviewedAt: now(),
    };
    integration.reviews.push(receipt);
    atomicWrite(root, state);
    return {
      ok: verdict === 'pass',
      command: 'review',
      task: task.id,
      attempt: attempt.number,
      review: receipt,
      exitCode: verdict === 'pass' ? 0 : 2,
    };
  });
}

function assertCandidateAccepted(root, task, attempt, integration) {
  if (integration.workerSha !== attempt.reportedSha || !attempt.reportedSha) {
    throw new CliError(
      'INTEGRATION_INVALID',
      'Candidate Worker SHA does not match the verified report',
    );
  }
  if (!integration.sha || !isAncestor(root, integration.workerSha, integration.sha)) {
    throw new CliError(
      'INTEGRATION_INVALID',
      'Candidate does not contain the verified Worker commit',
    );
  }
  if (
    integration.checks.at(-1)?.status !== 'passed' ||
    integration.checks.at(-1)?.sha !== integration.sha
  ) {
    throw new CliError('CHECK_REQUIRED', 'Candidate checks must pass at the exact candidate SHA');
  }
  const acceptedReview = integration.reviews.at(-1);
  if (
    !acceptedReview ||
    acceptedReview.verdict !== 'pass' ||
    acceptedReview.commit !== integration.sha
  ) {
    throw new CliError(
      'REVIEW_REQUIRED',
      'Latest independent review must pass at the exact candidate SHA',
    );
  }
  assertWorktreeAt(root, integration.worktree, integration.sha);
}

function integrate(root, options) {
  const owner = required(options, 'owner');
  return withLock(root, owner, () => {
    const state = readState(root);
    assertOwner(state, owner);
    if (state.mode !== 'autonomous')
      throw new CliError('MODE_MISMATCH', 'integrate is disabled in review mode');
    assertIntegrationRoot(root);
    const task = getTask(state, required(options, 'task'));
    const attempt = getAttempt(task, required(options, 'attempt'));
    if (attempt !== latestAttempt(task) || !['reported', 'integrated'].includes(attempt.status)) {
      throw new CliError('STALE_ATTEMPT', 'Integration requires the latest reported attempt');
    }
    const integration = latestCandidate(task);
    if (
      !integration ||
      integration.attemptNumber !== attempt.number ||
      !['built', 'merged'].includes(integration.status)
    ) {
      throw new CliError('CANDIDATE_REQUIRED', 'A current candidate is required');
    }
    assertCandidateAccepted(root, task, attempt, integration);
    const currentDevelop = gitText(root, ['rev-parse', integrationRef(root)]);
    if (currentDevelop === integration.sha) {
      integration.status = 'merged';
      integration.mergedAt = integration.mergedAt ?? now();
      task.status = 'done';
      attempt.status = 'integrated';
      task.merge = {
        candidateSha: integration.sha,
        workerSha: integration.workerSha,
        developSha: currentDevelop,
        verifiedAt: now(),
        recovered: true,
      };
      atomicWrite(root, state);
      return {
        ok: true,
        command: 'integrate',
        task: task.id,
        done: true,
        recovered: true,
        developSha: currentDevelop,
      };
    }
    if (integration.status !== 'built')
      throw new CliError(
        'INTEGRATION_INVALID',
        'Recorded merged candidate is no longer at the integration branch',
      );
    if (currentDevelop !== integration.baseSha) {
      integration.status = 'invalidated';
      integration.invalidatedAt = now();
      integration.invalidatedReason = `Integration branch moved from ${integration.baseSha} to ${currentDevelop}`;
      atomicWrite(root, state);
      return {
        ok: false,
        command: 'integrate',
        task: task.id,
        status: 'invalidated',
        reason: integration.invalidatedReason,
        exitCode: 2,
      };
    }
    git(root, ['merge', '--ff-only', integration.sha]);
    const verified = gitText(root, ['rev-parse', integrationRef(root)]);
    if (verified !== integration.sha || !isAncestor(root, integration.workerSha, verified)) {
      throw new CliError(
        'INTEGRATION_INVALID',
        'Fast-forward did not produce the verified candidate ancestry',
      );
    }
    assertIntegrationRoot(root);
    integration.status = 'merged';
    integration.mergedAt = now();
    task.status = 'done';
    attempt.status = 'integrated';
    task.merge = {
      candidateSha: integration.sha,
      workerSha: integration.workerSha,
      developSha: verified,
      verifiedAt: now(),
      recovered: false,
    };
    atomicWrite(root, state);
    return {
      ok: true,
      command: 'integrate',
      task: task.id,
      done: true,
      recovered: false,
      developSha: verified,
    };
  });
}

function recover(root, options) {
  const owner = required(options, 'owner');
  return withLock(root, owner, () => {
    const state = readState(root);
    const action = required(options, 'action');
    if (!['retry', 'stop'].includes(action))
      throw new CliError('INVALID_ARGUMENT', '--action must be retry or stop');
    if (state.owner !== owner)
      throw new CliError('OWNER_MISMATCH', `Registry belongs to ${state.owner}`);
    if (action === 'retry' && state.runStatus !== 'active') {
      throw new CliError('RUN_CLOSED', `Retry requires an active run, found ${state.runStatus}`);
    }
    if (action === 'stop' && !['active', 'paused'].includes(state.runStatus)) {
      throw new CliError('RUN_CLOSED', `Stop cannot change a ${state.runStatus} run`);
    }
    if (options['worker-stopped'] !== true) {
      throw new CliError(
        'WORKER_STOP_UNCONFIRMED',
        '--worker-stopped is required; TTL does not release ownership',
      );
    }
    const task = getTask(state, required(options, 'task'));
    const attempt = latestAttempt(task);
    if (
      !attempt ||
      !['allocating', 'reserved', 'active', 'reported', 'drafted'].includes(attempt.status)
    ) {
      throw new CliError('RECOVERY_INVALID', 'Task has no recoverable active attempt');
    }
    if (action === 'retry' && task.attempts.length >= state.limits.maxRetries + 1) {
      throw new CliError('RETRY_LIMIT', `${task.id} exhausted its retry limit`);
    }
    attempt.status = 'abandoned';
    attempt.abandonedAt = now();
    attempt.abandonedReason = required(options, 'reason');
    if (action === 'stop') {
      if (
        options.model !== undefined ||
        options.effort !== undefined ||
        options['routing-reason'] !== undefined
      ) {
        throw new CliError('INVALID_ARGUMENT', 'Routing overrides only apply to --action retry');
      }
      for (const integration of task.candidates) {
        if (['creating', 'built', 'conflicted'].includes(integration.status)) {
          integration.status = 'invalidated';
          integration.invalidatedAt = now();
          integration.invalidatedReason = `Worker attempt ${attempt.number} was stopped`;
        }
      }
      attempt.status = 'stopped';
      task.status = 'blocked';
      atomicWrite(root, state);
      return {
        ok: true,
        command: 'recover',
        action,
        task: task.id,
        stoppedAttempt: attempt.number,
        status: task.status,
      };
    }
    const nextModel = options.model === undefined ? task.model : required(options, 'model');
    const nextEffort = options.effort === undefined ? task.effort : required(options, 'effort');
    if (
      (options.model !== undefined || options.effort !== undefined) &&
      options['routing-reason'] === undefined
    ) {
      throw new CliError(
        'MISSING_ARGUMENT',
        '--routing-reason is required with --model or --effort',
      );
    }
    task.model = nextModel;
    task.effort = nextEffort;
    task.routingReason =
      options['routing-reason'] === undefined
        ? (task.routingReason ?? 'task specification')
        : required(options, 'routing-reason');
    for (const integration of task.candidates) {
      if (['creating', 'built', 'conflicted'].includes(integration.status)) {
        integration.status = 'invalidated';
        integration.invalidatedAt = now();
        integration.invalidatedReason = `Worker attempt ${attempt.number} was abandoned`;
      }
    }
    task.status = 'pending';
    atomicWrite(root, state);
    return {
      ok: true,
      command: 'recover',
      action,
      task: task.id,
      abandonedAttempt: attempt.number,
      nextAttempt: attempt.number + 1,
      nextRouting: { model: task.model, effort: task.effort, reason: task.routingReason },
    };
  });
}

function transfer(root, options) {
  const owner = required(options, 'owner');
  return withLock(root, owner, () => {
    const state = readState(root);
    if (state.owner !== owner)
      throw new CliError('OWNER_MISMATCH', `Registry belongs to ${state.owner}`);
    if (!['active', 'paused'].includes(state.runStatus))
      throw new CliError('RUN_CLOSED', `Run is ${state.runStatus}`);
    if (options['previous-owner-stopped'] !== true) {
      throw new CliError('OWNER_STOP_UNCONFIRMED', '--previous-owner-stopped is required');
    }
    const previousOwner = state.owner;
    state.owner = required(options, 'new-owner');
    state.ownerTransfers ??= [];
    state.ownerTransfers.push({
      from: previousOwner,
      to: state.owner,
      reason: required(options, 'reason'),
      transferredAt: now(),
    });
    atomicWrite(root, state);
    return { ok: true, command: 'transfer', previousOwner, owner: state.owner };
  });
}

function closeRun(root, options) {
  const owner = required(options, 'owner');
  return withLock(root, owner, () => {
    const state = readState(root);
    assertOwner(state, owner);
    const status = required(options, 'status');
    if (!['completed', 'paused'].includes(status))
      throw new CliError('INVALID_ARGUMENT', '--status must be completed or paused');
    if (status === 'completed' && state.tasks.some((task) => task.status !== 'done')) {
      throw new CliError(
        'RUN_INCOMPLETE',
        'Every registered task must be done before completing a run',
      );
    }
    if (status === 'completed') {
      assertIntegrationRoot(root);
      const developSha = gitText(root, ['rev-parse', integrationRef(root)]);
      const invalid = state.tasks.filter(
        (task) =>
          !task.merge ||
          !isAncestor(root, task.merge.workerSha, developSha) ||
          !isAncestor(root, task.merge.developSha, developSha),
      );
      if (invalid.length) {
        throw new CliError(
          'RUN_INCOMPLETE',
          'Recorded task merges are no longer in the integration branch',
          invalid.map((task) => task.id),
        );
      }
    }
    state.runStatus = status;
    state.closedAt = now();
    state.closeReason = required(options, 'reason');
    atomicWrite(root, state);
    return { ok: true, command: 'close', status };
  });
}

function startRun(root, options) {
  const owner = required(options, 'owner');
  return withLock(root, owner, () => {
    const state = readState(root, {
      allowProfileChange: options['accept-profile-change'] === true,
    });
    if (state.owner !== owner)
      throw new CliError('OWNER_MISMATCH', `Registry belongs to ${state.owner}`);
    if (state.runStatus === 'active')
      throw new CliError('RUN_ACTIVE', 'Close the active run before starting another');
    if (options['previous-owner-stopped'] !== true) {
      throw new CliError('OWNER_STOP_UNCONFIRMED', '--previous-owner-stopped is required');
    }
    const leases = activeLocks(state);
    if (leases.length) {
      throw new CliError(
        'ACTIVE_LEASES',
        'Release every old Worker lease with recover after confirming it stopped',
        leases,
      );
    }
    const bootstrapSourceBundle = options['bootstrap-source-bundle'];
    assertIntegrationRoot(root, { clean: bootstrapSourceBundle === undefined });
    const bootstrapSourceHash =
      bootstrapSourceBundle === undefined
        ? null
        : verifyBootstrapSource(root, bootstrapSourceBundle);
    const mode = required(options, 'mode');
    if (!['review', 'autonomous'].includes(mode))
      throw new CliError('INVALID_ARGUMENT', '--mode must be review or autonomous');
    const newOwner = required(options, 'new-owner');
    const nextLimits = {
      maxTasks: positiveInteger(options, 'max-tasks'),
      maxRetries: nonNegativeInteger(options, 'max-retries'),
      maxWorkers: positiveInteger(options, 'max-workers'),
    };
    const startedAt = now();
    const previousBootstrapSourceHash = state.bootstrapSourceHash ?? null;
    const previousSourceAuthorizations = (state.sourceAuthorizations ?? []).map((entry) => ({
      ...entry,
    }));
    state.runHistory.push({
      integrationBranch: state.integrationBranch,
      projectProfileHash: state.projectProfileHash,
      goal: state.goal,
      mode: state.mode,
      owner: state.owner,
      status: state.runStatus,
      createdAt: state.createdAt,
      closedAt: state.closedAt,
      bootstrapSourceHash: previousBootstrapSourceHash,
      sourceAuthorizations: previousSourceAuthorizations,
      taskReceipts: state.tasks.map((task) => ({
        id: task.id,
        status: task.status,
        merge: task.merge,
        attempts: task.attempts.map((attempt) => ({
          number: attempt.number,
          branch: attempt.branch,
          worktree: attempt.worktree,
          baseSha: attempt.baseSha,
          reportedSha: attempt.reportedSha,
          worker: attempt.worker,
          handle: attempt.handle,
          model: attempt.model,
          effort: attempt.effort,
          status: attempt.status,
        })),
        candidates: task.candidates.map((candidate) => ({
          revision: candidate.revision,
          branch: candidate.branch,
          worktree: candidate.worktree,
          baseSha: candidate.baseSha,
          workerSha: candidate.workerSha,
          sha: candidate.sha,
          status: candidate.status,
        })),
      })),
    });
    state.integrationBranch = integrationBranch(root);
    state.projectProfileHash = projectProfileHash(root);
    state.owner = newOwner;
    state.goal = required(options, 'goal');
    state.mode = mode;
    state.runStatus = 'active';
    state.limits = nextLimits;
    state.developStartSha = gitText(root, ['rev-parse', integrationRef(root)]);
    state.bootstrapSourceHash = bootstrapSourceHash;
    state.sourceAuthorizations = previousSourceAuthorizations.map((entry) => ({ ...entry }));
    if (bootstrapSourceHash !== null) {
      state.sourceAuthorizations.push({
        sourceHash: bootstrapSourceHash,
        previousSourceHash: previousBootstrapSourceHash,
        owner: newOwner,
        reason: 'start --bootstrap-source-bundle',
        at: startedAt,
      });
    }
    state.tasks = [];
    state.createdAt = startedAt;
    delete state.closedAt;
    delete state.closeReason;
    atomicWrite(root, state);
    return { ok: true, command: 'start', owner: state.owner, goal: state.goal, mode: state.mode };
  });
}

function resumeRun(root, options) {
  const owner = required(options, 'owner');
  return withLock(root, owner, () => {
    const state = readState(root);
    if (state.owner !== owner)
      throw new CliError('OWNER_MISMATCH', `Registry belongs to ${state.owner}`);
    if (state.runStatus !== 'paused')
      throw new CliError('RUN_NOT_PAUSED', `Run is ${state.runStatus}`);
    assertIntegrationRoot(root);
    state.runStatus = 'active';
    state.resumedAt = now();
    delete state.closedAt;
    delete state.closeReason;
    atomicWrite(root, state);
    return { ok: true, command: 'resume', owner: state.owner, goal: state.goal };
  });
}

function status(root) {
  const state = readState(root);
  const developSha = gitText(root, ['rev-parse', integrationRef(root)]);
  const tasks = state.tasks.map((task) => {
    const attempt = latestAttempt(task);
    const integration = latestCandidate(task);
    const lastWorkerCheck = attempt?.checks.worker.at(-1) ?? null;
    const lastCandidateCheck = integration?.checks.at(-1) ?? null;
    return {
      id: task.id,
      status: task.status,
      priority: task.priority,
      scope: task.scope,
      resources: task.resources,
      worker: attempt?.worker ?? null,
      handle: attempt?.handle ?? null,
      attempt: attempt?.number ?? null,
      branch: attempt?.branch ?? null,
      worktree: attempt?.worktree ?? null,
      model: attempt?.model ?? task.model,
      effort: attempt?.effort ?? task.effort,
      lastActivityAt:
        attempt?.reportedAt ??
        attempt?.draftedAt ??
        attempt?.boundAt ??
        attempt?.reservedAt ??
        attempt?.allocationStartedAt ??
        null,
      workerCheck: lastWorkerCheck
        ? {
            sha: lastWorkerCheck.sha,
            status: lastWorkerCheck.status,
            finishedAt: lastWorkerCheck.finishedAt ?? null,
          }
        : null,
      candidate: integration
        ? {
            revision: integration.revision,
            sha: integration.sha,
            status: integration.status,
            branch: integration.branch,
            worktree: integration.worktree,
          }
        : null,
      candidateCheck: lastCandidateCheck
        ? {
            sha: lastCandidateCheck.sha,
            status: lastCandidateCheck.status,
            finishedAt: lastCandidateCheck.finishedAt ?? null,
          }
        : null,
      dependencyState: dependencyState(root, state, task),
      mergeStillInDevelop:
        task.status === 'done'
          ? Boolean(
              task.merge &&
              isAncestor(root, task.merge.workerSha, developSha) &&
              isAncestor(root, task.merge.developSha, developSha),
            )
          : null,
    };
  });
  return {
    ok: true,
    command: 'status',
    root: state.root,
    owner: state.owner,
    goal: state.goal,
    mode: state.mode,
    runStatus: state.runStatus,
    limits: state.limits,
    bootstrapSourceHash: state.bootstrapSourceHash ?? null,
    developSha,
    tasks,
  };
}

// A read-only projection of the existing registry, never a second scheduler.
function graph(root, options) {
  const preview = options.plan !== undefined;
  let state;
  if (preview) {
    const definition = JSON.parse(readFileSync(required(options, 'plan'), 'utf8'));
    if (definition.version !== 1 || !Array.isArray(definition.nodes)) {
      throw new CliError('INVALID_SPEC', 'Graph plan needs version: 1 and nodes array');
    }
    state = {
      tasks: definition.nodes.map((node) => ({
        id: node?.id,
        title: node?.title,
        dependsOn: node?.dependsOn,
        status: 'not-started',
        merge: null,
      })),
      runStatus: 'not-started',
    };
  } else {
    state = readState(root);
  }
  if (!Array.isArray(state.tasks)) {
    throw new CliError('STATE_INVALID', 'Registry tasks must be an array');
  }
  const ids = new Set();
  for (const task of state.tasks) {
    if (
      !task ||
      typeof task.id !== 'string' ||
      !TASK_ID.test(task.id) ||
      ids.has(task.id) ||
      !Array.isArray(task.dependsOn) ||
      task.dependsOn.some((id) => typeof id !== 'string')
    ) {
      throw new CliError('STATE_INVALID', 'Graph requires unique task IDs and dependency arrays');
    }
    ids.add(task.id);
  }
  assertDependencyGraph(state.tasks);
  const developSha = gitText(root, ['rev-parse', integrationRef(root)]);
  const remaining = new Map(state.tasks.map((task) => [task.id, task]));
  const visited = new Set();
  const layers = [];
  while (remaining.size) {
    const layer = [...remaining.values()]
      .filter((task) => task.dependsOn.every((id) => visited.has(id)))
      .map((task) => task.id);
    if (!layer.length) throw new CliError('CYCLIC_DEPENDENCY', 'Graph has no next layer');
    layers.push(layer);
    for (const id of layer) {
      visited.add(id);
      remaining.delete(id);
    }
  }
  const integrated = (task) =>
    Boolean(
      task.status === 'done' &&
      task.merge?.workerSha &&
      task.merge?.developSha &&
      isAncestor(root, task.merge.workerSha, developSha) &&
      isAncestor(root, task.merge.developSha, developSha),
    );
  const integratedIds = new Set(state.tasks.filter(integrated).map((task) => task.id));
  const edges = state.tasks.flatMap((task) =>
    task.dependsOn.map((from) => ({ from, to: task.id })),
  );
  const index = new Map(state.tasks.map((task, i) => [task.id, `n${i}`]));
  const mermaid = [
    'flowchart TD',
    ...state.tasks.map((task) => `  ${index.get(task.id)}["${task.id}"]`),
    ...edges.map(({ from, to }) => `  ${index.get(from)} --> ${index.get(to)}`),
  ].join('\n');
  if (
    gitText(root, ['rev-parse', integrationRef(root)]) !== developSha ||
    (!preview && JSON.stringify(readState(root)) !== JSON.stringify(state))
  ) {
    throw new CliError(
      'STATE_CHANGED',
      'Registry or integration branch changed during graph inspection; retry',
    );
  }
  return {
    ok: true,
    command: 'graph',
    root,
    runStatus: state.runStatus,
    developSha,
    execution: preview ? 'plan-inspection-only' : 'inspection-only',
    layersAreParallelBatches: false,
    nodes: state.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      recordedStatus: task.status,
      mergeStillInDevelop: task.status === 'done' ? integratedIds.has(task.id) : null,
      dependenciesIntegrated: task.dependsOn.every((id) => integratedIds.has(id)),
    })),
    edges,
    layers,
    mermaid,
    note: 'Layers describe dependencies only. Use next/claim for current capacity, ownership and permissions; claim rechecks conflicts. No worker was started.',
  };
}

function help() {
  return {
    ok: true,
    command: 'help',
    usage: [
      'node scripts/ai-orchestrator.mjs init --root ROOT --owner OWNER --goal TEXT --mode review|autonomous --max-tasks N --max-retries N --max-workers N [--bootstrap-source-bundle PATH]',
      'node scripts/ai-orchestrator.mjs authorize-source --root ROOT --owner OWNER --source-bundle PATH --reason TEXT',
      'node scripts/ai-orchestrator.mjs add --root ROOT --owner OWNER --spec FILE.json',
      'node scripts/ai-orchestrator.mjs next --root ROOT [--owner OWNER]',
      'node scripts/ai-orchestrator.mjs claim --root ROOT --owner OWNER --task ID --worker LOGICAL_ID',
      'node scripts/ai-orchestrator.mjs graph-reserve --root ROOT --owner OWNER --task ID --run RUN_ID --source-hash SHA256 [--existing-attempt N --existing-lease UUID]',
      'node scripts/ai-orchestrator.mjs graph-verify --root ROOT --owner OWNER --run RUN_ID --task ID --attempt N --lease UUID --source-hash SHA256 --worktree PATH',
      'node scripts/ai-orchestrator.mjs graph-rebind --root ROOT --owner OWNER --run OLD_RUN --new-run NEW_RUN --task ID --attempt N --lease UUID --source-hash OLD_SHA256 --new-source-hash NEW_SHA256 --worktree PATH --previous-run-stopped',
      'node scripts/ai-orchestrator.mjs bind --root ROOT --owner OWNER --task ID --attempt N --handle NATIVE_HANDLE',
      'node scripts/ai-orchestrator.mjs prompt --root ROOT --task ID --attempt N [--owner OWNER]',
      'node scripts/ai-orchestrator.mjs report --root ROOT --owner OWNER --task ID --attempt N --handle HANDLE --commit SHA --result-file FILE.json',
      'node scripts/ai-orchestrator.mjs draft --root ROOT --owner OWNER --task ID --attempt N --handle HANDLE --result-file FILE.json',
      'node scripts/ai-orchestrator.mjs check --root ROOT --owner OWNER --task ID --attempt N --phase worker|candidate',
      'node scripts/ai-orchestrator.mjs candidate --root ROOT --owner OWNER --task ID --attempt N',
      'node scripts/ai-orchestrator.mjs review --root ROOT --owner OWNER --task ID --attempt N --reviewer ID --commit SHA --verdict pass|fail --summary TEXT',
      'node scripts/ai-orchestrator.mjs integrate --root ROOT --owner OWNER --task ID --attempt N',
      'node scripts/ai-orchestrator.mjs recover --root ROOT --owner OWNER --task ID --action retry|stop --worker-stopped --reason TEXT [--model ID --effort LEVEL --routing-reason TEXT]',
      'node scripts/ai-orchestrator.mjs transfer --root ROOT --owner OLD --new-owner NEW --previous-owner-stopped --reason TEXT',
      'node scripts/ai-orchestrator.mjs close --root ROOT --owner OWNER --status completed|paused --reason TEXT',
      'node scripts/ai-orchestrator.mjs resume --root ROOT --owner OWNER',
      'node scripts/ai-orchestrator.mjs start --root ROOT --owner OLD --new-owner NEW --previous-owner-stopped --goal TEXT --mode MODE --max-tasks N --max-retries N --max-workers N [--bootstrap-source-bundle PATH] [--accept-profile-change]',
      'node scripts/ai-orchestrator.mjs status --root ROOT',
      'node scripts/ai-orchestrator.mjs graph --root ROOT [--plan FILE.json]',
    ],
  };
}

function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === 'help' || command === '--help' || options.help) return help();
  const root = resolveRoot(required(options, 'root'));
  switch (command) {
    case 'init':
      return withLock(root, options.owner, () => init(root, options));
    case 'authorize-source':
      return authorizeSource(root, options);
    case 'add':
      return add(root, options);
    case 'next':
      return next(root, options);
    case 'claim':
      return claim(root, options);
    case 'graph-reserve':
      return graphReserve(root, options);
    case 'graph-verify':
      return graphVerify(root, options);
    case 'graph-rebind':
      return graphRebind(root, options);
    case 'bind':
      return bind(root, options);
    case 'prompt':
      return prompt(root, options);
    case 'report':
      return report(root, options);
    case 'draft':
      return report(root, options, { draft: true });
    case 'check':
      return runChecks(root, options);
    case 'candidate':
      return candidate(root, options);
    case 'review':
      return review(root, options);
    case 'integrate':
      return integrate(root, options);
    case 'recover':
      return recover(root, options);
    case 'transfer':
      return transfer(root, options);
    case 'close':
      return closeRun(root, options);
    case 'resume':
      return resumeRun(root, options);
    case 'start':
      return startRun(root, options);
    case 'status':
      return status(root);
    case 'graph':
      return graph(root, options);
    default:
      throw new CliError('UNKNOWN_COMMAND', `Unknown command: ${command}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const output = main();
    const exitCode = output.exitCode ?? 0;
    delete output.exitCode;
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    process.exitCode = exitCode;
  } catch (error) {
    const failure = {
      ok: false,
      error: {
        code: error.code ?? 'UNEXPECTED_ERROR',
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    };
    process.stderr.write(`${JSON.stringify(failure, null, 2)}\n`);
    process.exitCode = 1;
  }
}
