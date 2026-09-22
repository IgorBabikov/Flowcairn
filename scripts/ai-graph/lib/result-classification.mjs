/** Presentation follows immutable completion receipts, never a model's explanation. */
export function resultKind(node, readReceipt) {
  if (node.status !== 'uncertain') return null;
  try {
    const receipt = readReceipt(node.receipts.at(-1));
    return receipt.phase === 'finished' && receipt.verdict === 'uncertain' &&
      receipt.actionId?.startsWith('ai-') && receipt.exitCode === 0 &&
      receipt.termination?.stopped === true && receipt.termination.uncertain === false &&
      receipt.beforeFingerprint && receipt.beforeFingerprint === receipt.afterFingerprint
      ? 'semantic' : 'process';
  } catch { return 'process'; }
}
