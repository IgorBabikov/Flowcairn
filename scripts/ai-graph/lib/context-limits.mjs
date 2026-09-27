// Analysis must fit the planner handoff with room for receipts and project metadata.
// The final rendered prompt remains independently bounded to 128 KiB.
export const MAX_ANALYSIS_BYTES = 32 * 1024;
export const priorEvidenceLimit = (actionId) => ['ai-analyze', 'ai-plan'].includes(actionId)
  ? 48 * 1024 : 32 * 1024;
