import { readFileSync } from 'node:fs';
import { CliError, TASK_ID, assertDependencyGraph } from './orchestrator-task-contract.mjs';
import { required } from './orchestrator-arguments.mjs';
import { readState, assertOwner, getTask, getAttempt, latestAttempt, latestCandidate, dependencyState, taskReference } from './orchestrator-registry.mjs';
import { gitText, integrationRef, isAncestor } from './orchestrator-repository.mjs';

// These views read the same registry and never schedule work or accept claimed completion.

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

export function prompt(root, options) {
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

export function status(root) {
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
export function graph(root, options) {
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
