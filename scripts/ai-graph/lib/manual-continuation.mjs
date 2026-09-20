/** A stopped, read-only rejected implementation can be replanned by the user
 * after automatic repair is exhausted. The next immutable plan has a new gate. */
export function canReplanRejectedImplementation(state, plan, readReceipt) {
  if (plan.workflow !== 'autonomous' || plan.stage !== 'execution' ||
      state.status !== 'failed' || state.activeOperation || state.finalDisposition ||
      state.planVersion >= 100) return false;
  const failures = plan.nodes.filter((node) => state.nodes[node.id]?.status === 'failed');
  if (failures.length !== 1 || failures[0].action.id !== 'ai-implement') return false;
  const node = state.nodes[failures[0].id];
  if (node.changedFiles.length || !node.receipts.length) return false;
  let receipt;
  try { receipt = readReceipt(node.receipts.at(-1)); }
  catch { return false; }
  return receipt.phase === 'finished' && receipt.verdict === 'fail' &&
    receipt.beforeFingerprint === receipt.afterFingerprint &&
    receipt.termination?.stopped === true && receipt.termination.uncertain === false;
}
