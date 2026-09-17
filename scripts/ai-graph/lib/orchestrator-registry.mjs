import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { projectProfileHash } from './project.mjs';
import { CliError, STATE_DIR } from './orchestrator-task-contract.mjs';
import { integrationBranch, integrationRef, gitText, isAncestor } from './orchestrator-repository.mjs';

// One registry and one writer lock remain the authority for task/attempt ownership.
export const SCHEMA_VERSION = 1;
export const SOURCE_HASH = /^[a-f0-9]{64}$/;
export const ACTIVE_ATTEMPTS = new Set(['allocating', 'reserved', 'active', 'reported', 'drafted']);
const now = () => new Date().toISOString();

export function pathsFor(root) {
  const directory = path.join(root, STATE_DIR);
  return {
    directory,
    state: path.join(directory, 'state.json'),
    lock: path.join(directory, 'lock'),
    logs: path.join(directory, 'logs'),
    worktrees: path.join(directory, 'worktrees'),
  };
}

export function assertLocalStatePaths(root) {
  for (const candidate of Object.values(pathsFor(root))) {
    if (existsSync(candidate) && lstatSync(candidate).isSymbolicLink()) {
      throw new CliError(
        'UNSAFE_STATE_PATH',
        `Orchestrator state path must not be a symlink: ${candidate}`,
      );
    }
  }
}

export function readState(root, { allowProfileChange = false } = {}) {
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

export function atomicWrite(root, state) {
  const registryPaths = pathsFor(root);
  state.updatedAt = now();
  const temporary = `${registryPaths.state}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, registryPaths.state);
}

export function withLock(root, owner, operation) {
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

export function assertOwner(state, owner) {
  if (state.owner !== owner) {
    throw new CliError('OWNER_MISMATCH', `Registry belongs to ${state.owner}`);
  }
  if (state.runStatus !== 'active') {
    throw new CliError('RUN_CLOSED', `Run is ${state.runStatus}`);
  }
}

export function getTask(state, id) {
  const task = state.tasks.find((entry) => entry.id === id);
  if (!task) throw new CliError('TASK_NOT_FOUND', `Unknown task: ${id}`);
  return task;
}

export function getAttempt(task, rawAttempt) {
  const number = Number(rawAttempt);
  const attempt = task.attempts.find((entry) => entry.number === number);
  if (!attempt)
    throw new CliError('ATTEMPT_NOT_FOUND', `Unknown attempt ${rawAttempt} for ${task.id}`);
  return attempt;
}

export function latestAttempt(task) {
  return task.attempts.at(-1) ?? null;
}

export function latestCandidate(task) {
  return task.candidates.at(-1) ?? null;
}

export function pathOverlaps(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function activeLocks(state, excludeTask = null) {
  return state.tasks.flatMap((task) => {
    if (task.id === excludeTask) return [];
    const attempt = latestAttempt(task);
    if (!attempt || !ACTIVE_ATTEMPTS.has(attempt.status)) return [];
    return [{ task: task.id, scope: task.scope, resources: task.resources }];
  });
}

export function lockConflicts(state, task) {
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

export function dependencyState(root, state, task) {
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

export function branchSlug(id) {
  return id.toLowerCase();
}

export function taskReference(id) {
  if (/^ORCH-/.test(id) || /^[A-Z][A-Z0-9]+-\d+$/.test(id)) return id;
  return `ORCH-${id}`;
}
