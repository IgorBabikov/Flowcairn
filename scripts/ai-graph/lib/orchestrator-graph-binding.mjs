import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { CliError } from './orchestrator-task-contract.mjs';
import { required } from './orchestrator-arguments.mjs';
import { SOURCE_HASH, pathsFor, readState, withLock, atomicWrite, assertOwner, getTask, getAttempt, latestAttempt } from './orchestrator-registry.mjs';
import { assertIntegrationRoot, gitText } from './orchestrator-repository.mjs';

// A graph lease binds one run to the existing task attempt; allocation still uses the shared scheduler.
const GRAPH_RUN_ID = /^[a-z0-9][a-z0-9-]{2,79}$/;
const now = () => new Date().toISOString();

export function graphBindingResult(task, attempt, { recoveredAllocation = false } = {}) {
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

export function graphReserve(root, options, allocationOperations) {
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
        const allocation = allocationOperations.complete(root, state, task, attempt);
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
    const allocation = allocationOperations.reserve(root, state, task, {
      worker: `graph:${runId}`,
      graphBinding,
    });
    return graphBindingResult(task, allocation.attempt, {
      recoveredAllocation: allocation.recoveredAllocation,
    });
  });
}

export function graphVerify(root, options, { ownsLock = false } = {}) {
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

export function graphRebind(root, options) {
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
