const unique = (items) => [...new Set(items)];
const group = (items, size) => Array.from({ length: Math.ceil(items.length / size) },
  (_, index) => items.slice(index * size, (index + 1) * size));

function timedOutWithoutChanges(node, readReceipt) {
  if (node.status !== 'uncertain' || node.changedFiles.length) return false;
  const finished = [...node.receipts].reverse().map(readReceipt).find((receipt) => receipt.phase === 'finished');
  return Boolean(finished?.termination?.timedOut && finished.termination.stopped &&
    finished.beforeFingerprint === finished.afterFingerprint);
}

/** Break a timed-out directory-wide implementation into bounded serial parts. */
export function repairExecutionSteps(plan, state, readReceipt) {
  const implementations = plan.nodes.filter((node) => node.action.id === 'ai-implement');
  const implementationIds = new Set(implementations.map((node) => node.id));
  const filePaths = state.workspaceFingerprint?.files.map((file) => file.path) ?? [];
  const steps = [], repairReadPaths = {}, isolatedReadStepIds = [], lastStepByNode = new Map();
  for (const [index, node] of implementations.entries()) {
    const baseId = `fix-${index + 1}`;
    const dependencies = node.needs.filter((id) => implementationIds.has(id)).map((id) => lastStepByNode.get(id));
    if (dependencies.some((id) => !id)) throw new Error('Implementation order is not topological');
    const writes = node.resources.writes;
    const directories = writes.filter((entry) => filePaths.some((file) => file.startsWith(`${entry}/`)));
    const shared = writes.filter((entry) => !directories.includes(entry));
    const partition = node.id.match(/^(.*)-part-\d+$/)?.[1];
    const partitionTitle = node.title.match(/^(.*) \(\d+\/\d+\)$/)?.[1];
    const partitionDirectories = partition || partitionTitle
      ? unique(implementations.filter((candidate) =>
          (partition && candidate.id.startsWith(`${partition}-part-`)) ||
          (partitionTitle && candidate.title.match(/^(.*) \(\d+\/\d+\)$/)?.[1] === partitionTitle))
        .flatMap((candidate) => candidate.resources.writes)
        .filter((entry) => filePaths.some((file) => file.startsWith(`${entry}/`))))
      : [];
    const inheritedPartition = partitionDirectories.length >= 10;
    const split = timedOutWithoutChanges(state.nodes[node.id], readReceipt) &&
      writes.length > 12 && directories.length >= 10 && shared.length > 0 && shared.length <= 4;
    const parts = split ? group(directories, 5).map((chunk) => unique([...shared, ...chunk])) : [writes];
    const requirementIds = plan.taskContract?.requirements
      .filter((item) => item.workIds.includes(node.id)).map((item) => item.id);
    for (const [partIndex, paths] of parts.entries()) {
      const id = split ? `${baseId}-part-${partIndex + 1}` : baseId;
      const needs = partIndex === 0 ? dependencies : [steps.at(-1).id];
      steps.push({ id, title: split ? `${node.title.slice(0, 120)} (${partIndex + 1}/${parts.length})` : node.title,
        outcome: node.outcome, paths, requirementIds, needs });
      const isolate = split || inheritedPartition;
      const restrictedDirectories = inheritedPartition ? partitionDirectories : directories;
      repairReadPaths[id] = isolate
        ? unique([...node.resources.reads.filter((read) =>
            !restrictedDirectories.some((directory) => read === directory || directory.startsWith(`${read}/`))), ...paths])
        : node.resources.reads;
      if (isolate) isolatedReadStepIds.push(id);
      lastStepByNode.set(node.id, id);
    }
  }
  return { steps, repairReadPaths, isolatedReadStepIds };
}
