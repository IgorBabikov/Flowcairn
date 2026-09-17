#!/usr/bin/env node

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectProfileHash } from './ai-graph/lib/project.mjs';
import { CliError, validateTask, assertDependencyGraph } from './ai-graph/lib/orchestrator-task-contract.mjs';
import { integrationBranch, integrationRef, git, gitText, assertIntegrationRoot, isAncestor, assertWorktreeAt } from './ai-graph/lib/orchestrator-repository.mjs';
import {
  SCHEMA_VERSION, SOURCE_HASH, ACTIVE_ATTEMPTS, branchSlug, pathsFor, assertLocalStatePaths,
  readState, atomicWrite, withLock, assertOwner, getTask, getAttempt, latestAttempt,
  activeLocks, lockConflicts, dependencyState,
} from './ai-graph/lib/orchestrator-registry.mjs';
import { parseArgs, required, positiveInteger, nonNegativeInteger } from './ai-graph/lib/orchestrator-arguments.mjs';
import { graphReserve, graphVerify, graphRebind } from './ai-graph/lib/orchestrator-graph-binding.mjs';
import { report, runChecks } from './ai-graph/lib/orchestrator-delivery.mjs';
import { candidate, review, integrate } from './ai-graph/lib/orchestrator-integration.mjs';
import { prompt, status, graph } from './ai-graph/lib/orchestrator-inspection.mjs';
import { verifyBootstrapSource } from './ai-graph/lib/orchestrator-bootstrap.mjs';

export { withGraphBindingFence } from './ai-graph/lib/orchestrator-graph-binding.mjs';


function now() {
  return new Date().toISOString();
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
      return graphReserve(root, options, { complete: completeTaskAllocation, reserve: reserveTaskAttempt });
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
