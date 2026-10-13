import { z } from 'zod';
import { AIResultSchema, AIPlanningResultSchema, GraphPlanSchema, TaskSpecSchema, TaskContractSchema,
  Hash, Id, RelativePath, assertJsonBounds } from './schemas.mjs';
import { GraphError, canonicalJson, hashObject } from './io.mjs';
import { resolveAction, pathAllowed } from './registry.mjs';
import { classifyDevelopmentTask } from './development-workflow.mjs';
import { selectTaskRigor } from './task-contract.mjs';

export const MAX_PLAN_REVIEW_INPUT_BYTES = 512 * 1024;
const Status = z.enum(['pass', 'fail', 'uncertain']);
const Reason = z.string().trim().min(1).max(4000);
const Dimension = z.strictObject({ status: Status, reason: Reason });
export const PlanReviewCitationSchema = z.strictObject({
  path: RelativePath, startLine: z.number().int().min(1), quote: z.string().min(1).max(4000),
});
const PlanReference = z.strictObject({ workId: Id, checkIds: z.array(Id).max(6), creationPaths: z.array(RelativePath).max(100) });
export const AIPlanReviewResultSchema = AIResultSchema.extend({
  inputHash: Hash,
  reviewEvidenceHash: Hash.nullable(),
  requirementAssessments: z.array(z.strictObject({
    requirementId: Id, criterion: z.string().min(1), workIds: z.array(Id), checkIds: z.array(Id),
    verdict: Status, citations: z.array(PlanReviewCitationSchema).max(20), reason: Reason,
    planReferences: z.array(PlanReference).max(100),
  })).min(1),
  unknownAssessments: z.array(z.strictObject({ unknown: z.string().min(1),
    disposition: z.enum(['resolved-in-plan', 'nonblocking-risk', 'unresolved-material']), reason: Reason,
    citations: z.array(PlanReviewCitationSchema).max(20), planReferences: z.array(PlanReference).max(100) })).max(32),
  dimensions: z.strictObject({ verifier: Dimension, source: Dimension, interfaces: Dimension,
    unknowns: Dimension, capabilities: Dimension }),
  changedFiles: z.array(RelativePath).max(0),
  edits: z.array(AIResultSchema.shape.edits.unwrap().element).max(0),
  moves: z.array(AIResultSchema.shape.moves.unwrap().element).max(0),
  jsonTransfers: z.array(AIResultSchema.shape.jsonTransfers.unwrap().element).max(0),
  plan: z.array(AIResultSchema.shape.plan.element).max(0),
});
export const SemanticPlanReviewInputSchema = z.strictObject({
  version: z.literal(1), taskHash: Hash, planHash: Hash, sourceHash: Hash, runtimeHash: Hash,
  checkRegistryHash: Hash.nullable(), planningArtifactHash: Hash.nullable(),
  task: TaskSpecSchema, plan: GraphPlanSchema, taskContract: TaskContractSchema,
  proposal: AIPlanningResultSchema.nullable(),
});
const invalid = (message) => { throw new GraphError('PLAN_REVIEW_INVALID', message); };
const bounded = (value) => {
  try { assertJsonBounds(value); } catch { invalid('Plan review input/result выходит за JSON bounds.'); }
};
const sameSet = (left, right) => new Set(left).size === left.length && new Set(right).size === right.length &&
  hashObject([...left].sort()) === hashObject([...right].sort());

/** Validate identities without normalization: absent historical fields remain absent. */
export function validateSemanticPlanReviewInput(value) {
  bounded(value);
  if (!SemanticPlanReviewInputSchema.safeParse(value).success) invalid('Нужен полный строго заданный plan review input.');
  const { task, plan, taskContract } = value;
  if (!plan.taskContract) invalid('Plan review требует immutable task contract.');
  if (value.taskHash !== hashObject(task) || value.planHash !== hashObject(plan) ||
      plan.taskHash !== value.taskHash || task.sourceHash !== value.sourceHash || plan.sourceHash !== value.sourceHash ||
      plan.runtimeHash !== value.runtimeHash || (plan.checkRegistryHash ?? null) !== value.checkRegistryHash ||
      hashObject(plan.taskContract) !== hashObject(taskContract) ||
      (plan.checks && hashObject(plan.checks) !== value.checkRegistryHash))
    invalid('Plan review input содержит несогласованные task/source/plan/runtime/check identities.');
  if ((value.planningArtifactHash === null) !== (value.proposal === null))
    invalid('Planning artifact и его полный proposal должны присутствовать вместе.');
  if (Buffer.byteLength(canonicalJson(value)) > MAX_PLAN_REVIEW_INPUT_BYTES)
    invalid('Полный plan review input слишком велик; усечение запрещено.');
  return value;
}

/** Pure bundle for the existing private read-only evidence transport; no source access. */
export function buildSemanticPlanReviewInput({ task, plan, planningArtifactHash = null, proposal = null }) {
  const input = structuredClone({ version: 1, taskHash: hashObject(task), planHash: hashObject(plan),
    sourceHash: task.sourceHash, runtimeHash: plan.runtimeHash, checkRegistryHash: plan.checkRegistryHash ?? null,
    planningArtifactHash, task, plan, taskContract: plan.taskContract, proposal });
  validateSemanticPlanReviewInput(input);
  const content = canonicalJson(input), inputHash = hashObject(input);
  return { input, inputHash, hash: inputHash, content, bytes: Buffer.byteLength(content) };
}

/** Checks the review's role, binding and coverage. Host verifies quoted source bytes separately. */
export function assessSemanticPlanReview(input, output) {
  validateSemanticPlanReviewInput(input);
  bounded(output);
  const parsed = AIPlanReviewResultSchema.safeParse(output);
  if (!parsed.success) invalid('Plan reviewer result не соответствует dedicated readonly schema.');
  const result = parsed.data;
  if (result.inputHash !== hashObject(input) ||
      (result.reviewEvidenceHash !== null && result.reviewEvidenceHash !== result.inputHash))
    invalid('Plan reviewer result не относится к exact full input.');
  const requirements = new Map(input.taskContract.requirements.map((item) => [item.id, item]));
  if (requirements.size !== input.taskContract.requirements.length) invalid('Task contract содержит повторные requirement IDs.');
  const workIds = new Set(input.plan.nodes.filter((node) => node.action.id === 'ai-implement').map((node) => node.id));
  const reference = (refs, permittedWork = workIds, permittedChecks = null) => {
    for (const ref of refs) {
      const work = input.plan.nodes.find((node) => node.id === ref.workId && node.action.id === 'ai-implement');
      const problem = !work || !permittedWork.has(work.id) ? 'unknown-work-id' :
        !ref.creationPaths.length && (!ref.checkIds.length || permittedChecks && ref.checkIds.some(id => !permittedChecks.has(id))) ? 'empty-grounded-reference' :
        new Set(ref.creationPaths).size !== ref.creationPaths.length ? 'duplicate-creation-paths' :
        ref.creationPaths.some((file) => !pathAllowed(file, input.task) ||
          !work.resources.writes.some((scope) => file === scope || file.startsWith(`${scope}/`))) ? 'creation-outside-work-scope' :
        !sameSet(ref.checkIds, [...new Set(ref.checkIds)]) ? 'duplicate-check-ids' :
        ref.checkIds.some((id) => !input.plan.nodes.some(node => node.action.id === id && id.startsWith('check-')) ||
          !input.taskContract.requirements.some((r) => r.workIds.includes(work.id) && r.verification.checkIds.includes(id))) ? 'unlinked-check-action-id' : null;
      if (problem) invalid(`Plan reference не относится к объявленной authorized creation work/verifier: ${problem}.`);
    }
  };
  const seen = new Set();
  for (const assessment of result.requirementAssessments) {
    const requirement = requirements.get(assessment.requirementId);
    if (!requirement || seen.has(requirement.id)) invalid('Plan review содержит неизвестное или повторное требование.');
    seen.add(requirement.id);
    if (assessment.criterion !== requirement.verification.criterion)
      invalid('Plan review ослабляет либо заменяет исходный criterion.');
    if (!sameSet(assessment.workIds, requirement.workIds) || assessment.workIds.some((id) => !workIds.has(id)) ||
        !sameSet(assessment.checkIds, requirement.verification.checkIds))
      invalid('Plan review оценивает несвязанные работы или другие verifiers.');
    if (assessment.citations.some((citation) => !citation.quote.trim())) invalid('Пустая цитата не является source reference.');
    reference(assessment.planReferences, new Set(requirement.workIds), new Set(requirement.verification.checkIds));
    if (assessment.verdict === 'pass' && requirement.verification.method !== 'human' && !assessment.citations.length && !assessment.planReferences.length)
      invalid('Положительный plan assessment требует existing source, authorized creation либо exact linked work/check references.');
  }
  if (input.taskContract.requirements.some((item) => item.mandatory && (!item.workIds.length || !seen.has(item.id))))
    invalid('Plan review не покрывает все исходные обязательные требования и работы.');
  const outcomes = [...result.requirementAssessments.map((item) => item.verdict),
    ...Object.values(result.dimensions).map((dimension) => dimension.status)];
  const blocked = result.findings.some((finding) => finding.severity === 'blocking') || outcomes.includes('fail');
  const unknowns = new Set(input.taskContract.unknowns), assessedUnknowns = new Set();
  for (const item of result.unknownAssessments) {
    if (!unknowns.has(item.unknown) || assessedUnknowns.has(item.unknown)) invalid('Plan review подменяет или повторяет исходное unknown.');
    assessedUnknowns.add(item.unknown); reference(item.planReferences);
    if (item.citations.some((citation) => !citation.quote.trim()) ||
        (item.disposition !== 'unresolved-material' && !item.citations.length && !item.planReferences.length))
      invalid('Disposition риска требует grounded source/plan references.');
  }
  if (assessedUnknowns.size !== unknowns.size) invalid('Все исходные unknown/risk строки требуют явного disposition.');
  const uncertain = outcomes.includes('uncertain') || result.unknownAssessments.some((item) => item.disposition === 'unresolved-material');
  if (result.verdict === 'pass' && (blocked || uncertain)) invalid('Общий PASS противоречит blocking/uncertain findings либо material unknowns.');
  const status = result.verdict === 'fail' || blocked ? 'blocked' : result.verdict === 'uncertain' || uncertain ? 'uncertain' : 'consistent';
  return { status, role: 'plan-consistency', inputHash: result.inputHash, output: result,
    verificationStatus: 'pending', humanRequirementIds: input.taskContract.requirements
      .filter((item) => item.mandatory && item.verification.method === 'human').map((item) => item.id) };
}

/** Convenience gate; a consistent plan remains unverified implementation work. */
export function validateSemanticPlanReview(input, output) {
  const assessment = assessSemanticPlanReview(input, output);
  if (assessment.status !== 'consistent') throw new GraphError(
    assessment.status === 'blocked' ? 'PLAN_REVIEW_BLOCKED' : 'PLAN_REVIEW_UNCERTAIN',
    assessment.status === 'blocked' ? 'План имеет блокирующие смысловые замечания.' : 'Смысловая выполнимость плана не подтверждена.', assessment);
  return assessment;
}

export function semanticPlanReviewRequired(task, contract = null) {
  return contract?.rigor.level === 'high' || selectTaskRigor(task).level === 'high' ||
    classifyDevelopmentTask(task).rigor !== 'routine';
}

/** Compiler-owned readonly stage before source authorization; registry identity is unchanged. */
export function attachSemanticPlanReview(plan, task, context = {}) {
  if (plan.workflowPolicy !== 'developer-v2' || plan.stage === 'planning' || !semanticPlanReviewRequired(task, plan.taskContract)) return plan;
  if (plan.nodes.some((node) => node.planReview)) return plan;
  const next = structuredClone(plan);
  const action = resolveAction('ai-analyze');
  const review = { id: 'plan-review', title: 'Проверить смысловую согласованность плана',
    outcome: 'Исходные критерии, interfaces и verifiers сохранены; неизвестное обозначено',
    action: { id: action.id, version: action.version, inputs: {} }, planReview: true,
    needs: next.nodes.some((node) => node.action.id === 'human-provider-consent') ? ['provider-consent'] : [],
    success: { kind: action.kind, requiredArtifacts: [...action.artifacts] }, permissions: [...action.permissions],
    skills: [...action.skills], resources: { reads: [...new Set([...task.scope, ...task.contextPaths])], writes: [], exclusive: [] },
    retry: { maxAttempts: 1, backoffMs: 1000 } };
  if (context.resolveSkills) review.skills = context.resolveSkills(review, task);
  if (context.resolveReadPaths) review.resources.reads = context.resolveReadPaths(review, task);
  const approve = next.nodes.find((node) => node.action.id === 'human-approve');
  if (!approve) invalid('Semantic review требует source authorization boundary.');
  approve.needs = [...new Set([...approve.needs, review.id])];
  next.nodes.unshift(review);
  return next;
}
