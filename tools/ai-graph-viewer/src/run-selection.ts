import type { RunSummary, Snapshot } from './contracts';

function taskLifecycleKey(run: RunSummary): string {
  const task = run.task;
  return task?.id && task.taskNumber ? `${task.id}\u0000${task.taskNumber}` : run.runId;
}

function isNewerPlan(candidate: RunSummary, current: RunSummary): boolean {
  const candidateVersion = candidate.planVersion ?? -1;
  const currentVersion = current.planVersion ?? -1;
  if (candidateVersion !== currentVersion) return candidateVersion > currentVersion;
  if ((candidate.updatedAt ?? '') !== (current.updatedAt ?? ''))
    return (candidate.updatedAt ?? '') > (current.updatedAt ?? '');
  return candidate.runId > current.runId;
}

/** One task lifecycle is shown once, always at its newest immutable plan version. */
export function newestRunsByTask(runs: RunSummary[]): RunSummary[] {
  const latest = new Map<string, RunSummary>();
  for (const run of runs) {
    const key = taskLifecycleKey(run);
    const current = latest.get(key);
    if (!current || isNewerPlan(run, current)) latest.set(key, run);
  }
  return runs.filter((run) => latest.get(taskLifecycleKey(run)) === run);
}

export function relevantNodeId(snapshot: Snapshot): string | null {
  const ids = new Set(snapshot.nodes.map((node) => node.id));
  if (snapshot.activeNodeId && ids.has(snapshot.activeNodeId)) return snapshot.activeNodeId;
  const gate = snapshot.gates.find((item) => ids.has(item.nodeId));
  if (gate) return gate.nodeId;
  const blocked = snapshot.nodes.find((node) => ['failed', 'cancelled', 'uncertain'].includes(node.status));
  if (blocked) return blocked.id;
  if (snapshot.finalDisposition === 'accepted' || snapshot.status === 'passed')
    return snapshot.nodes.at(-1)?.id ?? null;
  return (
    snapshot.nodes.find((node) =>
      ['running', 'waiting-for-human', 'ready', 'uncertain'].includes(node.status),
    )?.id ??
    snapshot.nodes[0]?.id ??
    null
  );
}
