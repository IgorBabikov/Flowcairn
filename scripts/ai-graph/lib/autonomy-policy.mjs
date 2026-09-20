const BASE_DURATION_MS = 30 * 60 * 1000;
const EXTRA_STEP_MS = 15 * 60 * 1000;
const MAX_DURATION_MS = 2 * 60 * 60 * 1000;

/** The trusted compiler, never AI output, sets the execution time budget. */
export function autonomyForNodes(nodes) {
  const implementations = nodes.filter((node) => node.action.id === 'ai-implement').length;
  return { maxRepairCycles: 2,
    maxDurationMs: Math.min(MAX_DURATION_MS,
      BASE_DURATION_MS + Math.max(0, implementations - 4) * EXTRA_STEP_MS) };
}

export function validAutonomyForNodes(autonomy, nodes) {
  if (!autonomy || autonomy.maxRepairCycles !== 2) return false;
  const expected = autonomyForNodes(nodes).maxDurationMs;
  // Existing immutable plans used the original fixed 30-minute bound.
  return autonomy.maxDurationMs === BASE_DURATION_MS || autonomy.maxDurationMs === expected;
}
