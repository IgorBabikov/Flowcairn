import { z } from 'zod';
import { AIPlanReviewResultSchema } from './semantic-plan-review.mjs';
import { GraphError, canonicalJson, hashObject } from './io.mjs';
import { Hash, Id, ReceiptSchema, TaskContractSchema, assertJsonBounds } from './schemas.mjs';

const dimensions = ['verifier', 'source', 'interfaces', 'unknowns', 'capabilities'];
const Result = AIPlanReviewResultSchema.shape;
export const SemanticCorrectionFeedbackSchema = z.strictObject({
  version: z.literal(1), role: z.literal('semantic-plan-correction-feedback'),
  artifactId: Hash, receiptId: Hash, artifactValueHash: Hash, sourceRunId: Id, sourcePlanHash: Hash, sourceTaskHash: Hash,
  inputHash: Hash, verdict: Result.verdict, summary: Result.summary,
  findings: Result.findings,
  dimensions: z.object(Object.fromEntries(dimensions.map(key => [key, Result.dimensions.shape[key].optional()]))).strict(),
  requirementAssessments: z.array(Result.requirementAssessments.element),
  unknownAssessments: Result.unknownAssessments,
});
const invalid = message => { throw new GraphError('PLAN_REVIEW_FEEDBACK_INVALID', message); };

/** Keep complete corrective records. Successful assessments remain in the immutable artifact. */
export function projectSemanticCorrectionFeedback({ artifactId, receiptId, artifact, sourceRunId, sourcePlanHash, sourceTaskHash }) {
  if (artifact.kind !== 'analysis' || artifact.mediaType !== 'application/json')
    invalid('Semantic feedback требует canonical JSON analysis artifact.');
  let value;
  try { value = JSON.parse(artifact.content); assertJsonBounds(value); }
  catch { invalid('Semantic feedback artifact не является bounded JSON.'); }
  const parsed = AIPlanReviewResultSchema.safeParse(value);
  if (!parsed.success) invalid('Semantic feedback не соответствует dedicated plan review schema.');
  const result = parsed.data;
  return SemanticCorrectionFeedbackSchema.parse({ version: 1, role: 'semantic-plan-correction-feedback',
    artifactId, receiptId, artifactValueHash: hashObject(value), sourceRunId, sourcePlanHash, sourceTaskHash,
    inputHash: result.inputHash, verdict: result.verdict, summary: result.summary, findings: result.findings,
    dimensions: Object.fromEntries(dimensions.filter(key => result.dimensions[key].status !== 'pass').map(key => [key, result.dimensions[key]])),
    requirementAssessments: result.requirementAssessments.filter(item => item.verdict !== 'pass'),
    unknownAssessments: result.unknownAssessments.filter(item => item.disposition === 'unresolved-material'),
  });
}

export function validateSemanticCorrectionFeedback(value, { readArtifact, readReceipt, readPlan, currentPlan }) {
  if (!SemanticCorrectionFeedbackSchema.safeParse(value).success) invalid('Semantic feedback projection имеет неверную schema.');
  const expected = projectSemanticCorrectionFeedback({ ...value, artifact: readArtifact(value.artifactId) });
  if (hashObject(expected) !== hashObject(value)) invalid('Semantic feedback projection отличается от immutable canonical artifact.');
  let rawReceipt, plan;
  try { rawReceipt = readReceipt(value.receiptId); } catch { invalid('Authoritative feedback receipt недоступен.'); }
  const parsed = ReceiptSchema.safeParse(rawReceipt);
  if (!parsed.success) invalid('Semantic feedback требует authoritative finished receipt.');
  const receipt = parsed.data;
  try { plan = readPlan(receipt.planHash); assertJsonBounds(plan); } catch { invalid('Authoritative source plan недоступен.'); }
  if (!plan) invalid('Authoritative source plan отсутствует.');
  const reviewer = plan?.nodes?.find(node => node.id === receipt.nodeId);
  if (hashObject(plan) !== receipt.planHash || plan.taskHash !== receipt.taskHash || plan.workflowPolicy !== 'developer-v2' ||
      !reviewer?.planReview || reviewer.action.id !== 'ai-analyze' || receipt.actionVersion !== reviewer.action.version ||
      receipt.planVersion !== plan.version || receipt.sourceHash !== plan.sourceHash ||
      receipt.runId !== value.sourceRunId || receipt.planHash !== value.sourcePlanHash || receipt.taskHash !== value.sourceTaskHash ||
      receipt.reviewEvidenceHash !== value.inputHash || !receipt.artifacts.includes(value.artifactId) ||
      receipt.phase !== 'finished' || !['fail', 'uncertain'].includes(receipt.verdict) || receipt.exitCode !== 0 ||
      receipt.actionId !== 'ai-analyze' || !['PLAN_REVIEW_BLOCKED', 'PLAN_REVIEW_UNCERTAIN'].includes(receipt.failureReason?.split(':')[0]) ||
      receipt.termination?.stopped !== true || receipt.termination.uncertain ||
      receipt.termination.timedOut || receipt.termination.outputLimit || receipt.termination.signal !== null ||
      receipt.beforeFingerprint !== receipt.afterFingerprint || receipt.changedFiles.length)
    invalid('Semantic feedback не связан с authoritative source task/plan/reviewer/input receipt.');
  let ancestor = currentPlan, related = false;
  for (let depth = 0; ancestor && depth < 24; depth++) {
    if (hashObject(ancestor) === value.sourcePlanHash) { related = true; break; }
    const parentHash = ancestor.parentPlanHash;
    if (!parentHash) break;
    try { ancestor = readPlan(parentHash); assertJsonBounds(ancestor); }
    catch { invalid('Immutable feedback ancestry недоступен.'); }
    if (hashObject(ancestor) !== parentHash) invalid('Immutable feedback ancestor hash не совпадает.');
  }
  if (!related) invalid('Semantic feedback принадлежит unrelated source task/candidate lineage.');
  return value;
}

const InputSchema = z.strictObject({ version: z.literal(1), role: z.literal('semantic-correction-input'),
  taskHash: Hash, planHash: Hash, taskContractHash: Hash,
  taskContract: TaskContractSchema,
  feedback: z.array(SemanticCorrectionFeedbackSchema).min(1),
});
export const MAX_SEMANTIC_CORRECTION_BYTES = 512 * 1024;
export function buildSemanticCorrectionInput({ task, plan, feedback }) {
  const input = InputSchema.parse({ version: 1, role: 'semantic-correction-input', taskHash: hashObject(task),
    planHash: hashObject(plan), taskContractHash: hashObject(plan.taskContract), taskContract: plan.taskContract, feedback });
  assertJsonBounds(input);
  const content = canonicalJson(input), bytes = Buffer.byteLength(content);
  if (bytes > MAX_SEMANTIC_CORRECTION_BYTES)
    throw new GraphError('FIX_EVIDENCE_LIMIT', 'Полный mandatory semantic feedback превышает bounded private transport; усечение запрещено.');
  return { input, hash: hashObject(input), content, bytes };
}

/** Dedicated readonly correction data, never final review evidence or a source permission. */
export function validateSemanticCorrectionInput(input, { task, plan, node, priorEvidence }) {
  assertJsonBounds(input);
  if (plan.workflowPolicy !== 'developer-v2' || plan.stage !== 'planning' || node.planReview ||
      !['ai-plan', 'ai-analyze'].includes(node.action.id) || node.resources.writes.length ||
      node.permissions.some(permission => permission !== 'ai.read') || !InputSchema.safeParse(input).success)
    invalid('Private correction input имеет неверную роль или node contract.');
  const bundle = buildSemanticCorrectionInput({ task, plan, feedback: input.feedback });
  if (hashObject(input) !== bundle.hash || priorEvidence?.semanticCorrectionReference?.hash !== bundle.hash ||
      priorEvidence.semanticCorrectionReference.role !== input.role || priorEvidence.semanticCorrectionReference.bytes !== bundle.bytes ||
      hashObject(priorEvidence.semanticCorrectionReference.artifactIds) !== hashObject(input.feedback.map(item => item.artifactId)))
    invalid('Private correction input не связан с exact current task/plan/contract/reference hash.');
  return bundle;
}
