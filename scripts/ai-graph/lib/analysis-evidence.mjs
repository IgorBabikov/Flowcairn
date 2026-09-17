import { AIAnalysisResultSchema, ReceiptSchema } from './schemas.mjs';

/** Prefer current successful analysis; retained context must not shadow freshly inspected source. */
export function selectAnalysisEvidence({ state, plan, readArtifact, readReceipt }) {
  const fromArtifact = (artifactId) => {
    const artifact = readArtifact(artifactId);
    if (artifact.kind !== 'analysis' || artifact.mediaType !== 'application/json') return null;
    let value;
    try { value = JSON.parse(artifact.content); } catch { return null; }
    const parsed = AIAnalysisResultSchema.safeParse(value);
    if (!parsed.success || parsed.data.verdict !== 'pass' || parsed.data.findings.some((finding) => finding.severity === 'blocking')) return null;
    return { artifactId, result: parsed.data };
  };
  const current = plan.nodes.filter((node) => node.action.id === 'ai-analyze' && state.nodes[node.id]?.status === 'passed');
  if (current.length) {
    const receipts = current.flatMap((node) => [...state.nodes[node.id].receipts].reverse().flatMap((id) => {
      const parsed = ReceiptSchema.safeParse(readReceipt(id));
      if (!parsed.success) return [];
      const receipt = parsed.data;
      return receipt.runId === state.runId && receipt.nodeId === node.id && receipt.actionId === 'ai-analyze' &&
        receipt.planHash === state.planHash && receipt.taskHash === state.taskHash &&
        receipt.phase === 'finished' && receipt.verdict === 'pass' && receipt.exitCode === 0 &&
        receipt.termination?.stopped === true && receipt.termination.uncertain === false &&
        receipt.beforeFingerprint === receipt.afterFingerprint && receipt.afterFingerprint === state.workspaceFingerprint?.hash &&
        typeof receipt.finishedAt === 'string' ? [receipt] : [];
    })).sort((left, right) => right.finishedAt.localeCompare(left.finishedAt));
    // An invalid current success must fail closed, not fall back to facts from older source.
    for (const id of [...(receipts[0]?.artifacts ?? [])].reverse()) {
      const evidence = fromArtifact(id);
      if (evidence) return evidence;
    }
    return null;
  }
  if (plan.analysisArtifact) {
    const evidence = fromArtifact(plan.analysisArtifact);
    if (evidence) return evidence;
  }
  for (const id of [...(state.planningArtifacts ?? [])].reverse()) {
    const evidence = fromArtifact(id);
    if (evidence) return evidence;
  }
  return null;
}
