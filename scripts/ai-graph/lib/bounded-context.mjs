import { GraphError } from './io.mjs';
import { isWithin, overlaps } from './registry.mjs';
import { buildTaskContract } from './task-contract.mjs';

const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
const MAX_CONTEXT_BYTES = 30 * 1024;

export function dependencyNodeIds(plan, node) {
  const byId = new Map(plan.nodes.map((item) => [item.id, item]));
  const selected = new Set();
  const visit = (id) => {
    if (selected.has(id)) return;
    selected.add(id);
    for (const parent of byId.get(id)?.needs ?? []) visit(parent);
  };
  for (const id of node.needs ?? []) visit(id);
  return [...selected];
}

export function taskContractForNode(task, plan, node, priorEvidence = null) {
  const contract = plan.stage === 'planning' && priorEvidence?.analysis?.result?.analysis
    ? buildTaskContract(task, { analysis: priorEvidence.analysis.result.analysis })
    : plan.taskContract ?? buildTaskContract(task);
  const requirements = plan.taskContract && node.action?.id === 'ai-implement'
    ? contract.requirements.filter((item) => item.workIds.includes(node.id))
    : contract.requirements;
  return { ...contract, requirements };
}

/** Select by graph dependencies, requirement links and declared paths, never by whole history. */
export function boundPriorEvidence({ task, plan, node, state, priorEvidence, readReceipt = null }) {
  const dependencies = dependencyNodeIds(plan, node);
  const relevantNodes = dependencies.map((id) => state.nodes[id]).filter(Boolean);
  const artifacts = new Set([...relevantNodes.flatMap((item) => item.artifacts), ...(state.planningArtifacts ?? [])]);
  const receipts = new Set(relevantNodes.flatMap((item) => item.receipts));
  const contract = taskContractForNode(task, plan, node, priorEvidence);
  const selectedPaths = node.action.id === 'ai-implement'
    ? [...node.resources.writes, ...contract.requirements.flatMap((item) => item.verification.paths)]
    : node.resources.reads;
  const relevantPath = (file) => !file || selectedPaths.some((scope) => overlaps(file, scope));
  const result = {
    ...priorEvidence,
    receipts: (priorEvidence.receipts ?? []).filter((id) => receipts.has(id)),
    workspaceFiles: (priorEvidence.workspaceFiles ?? []).filter((file) =>
      relevantPath(file.path) && node.resources.reads.some((scope) => isWithin(file.path, scope))),
    artifacts: (priorEvidence.artifacts ?? []).filter((item) => artifacts.has(item.id)),
    reviewFindings: (priorEvidence.reviewFindings ?? []).filter((finding) => relevantPath(finding.path)),
    contextSelection: { dependencyNodeIds: dependencies, requirementIds: contract.requirements.map((item) => item.id) },
    verificationChecks: readReceipt ? [...receipts].flatMap((receiptId) => {
      const receipt = readReceipt(receiptId);
      if (receipt.phase !== 'finished' || !receipt.actionId.startsWith('check-')) return [];
      return receipt.checks.map((check) => ({ receiptId, nodeId: receipt.nodeId, actionId: receipt.actionId,
        inputHash: check.inputHash, exitCode: check.exitCode, passed: check.passed, verdict: receipt.verdict,
        afterFingerprint: receipt.afterFingerprint }));
    }) : [],
  };
  // Only the planner needs the full semantic analysis. Work receives scoped facts;
  // review uses its separate complete, immutable evidence bundle.
  if (!['ai-plan', 'ai-analyze'].includes(node.action.id)) {
    if (priorEvidence.analysis?.result?.analysis) {
      result.projectFacts = priorEvidence.analysis.result.analysis.projectFacts.filter((item) => relevantPath(item.path));
      result.analysisReference = priorEvidence.analysis.artifactId;
    }
    delete result.analysis;
  }
  while (bytes(result) > MAX_CONTEXT_BYTES && result.artifacts.length) result.artifacts.shift();
  while (bytes(result) > MAX_CONTEXT_BYTES && result.workspaceFiles.length) {
    result.workspaceFiles.pop();
    result.workspaceFilesTruncated = true;
  }
  if (bytes(result) > MAX_CONTEXT_BYTES)
    throw new GraphError('CONTEXT_LIMIT', 'Обязательный контекст текущего шага превышает 30 KiB; требуется сузить задачу');
  return result;
}

export function measurePromptContext(prompt, priorEvidence, source = []) {
  return {
    promptBytes: Buffer.byteLength(prompt),
    priorEvidenceBytes: priorEvidence ? bytes(priorEvidence) : 0,
    sourceBytes: source.length ? bytes(source) : 0,
    sourceFiles: source.length,
    requirementIds: priorEvidence?.contextSelection?.requirementIds ?? [],
    dependencyNodeIds: priorEvidence?.contextSelection?.dependencyNodeIds ?? [],
  };
}
