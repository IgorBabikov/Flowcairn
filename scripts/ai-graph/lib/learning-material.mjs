import { savedLearningSourcePage } from './learning-source-page.mjs';
import { putLearningSourceCatalog } from './learning-source-storage.mjs';
import { GraphError, hashObject } from './io.mjs';
import { Hash, Id } from './schema-primitives.mjs';
import { GraphPlanSchema, TaskSpecSchema, ReceiptSchema } from './schemas.mjs';
import { StageMaterialSchema, SourceCatalogSchema } from './learning-schemas.mjs';
import { readLearningSourceCatalog, verifyLearningSource, savedSourceAnchor, safeLearningGaps } from './learning-sources.mjs';

/** @typedef {import('zod').infer<typeof StageMaterialSchema>} StageMaterial */
/** @typedef {{runId: string, planHash: string, taskHash: string}} MaterialBinding */
/** @typedef {MaterialBinding & {materialHashes: string[]}} ReadBinding */
/** @typedef {import('./learning-sources.mjs').SourceCapture} SourceCapture */
/** @typedef {import('./learning-sources.mjs').SourcePolicy} SourcePolicy */
/** @returns {never} */
const fail = (code, message) => { throw new GraphError(code, message); };

function linkedPlan(store, binding) {
  if (!binding || !Id.safeParse(binding.runId).success || !Hash.safeParse(binding.planHash).success || !Hash.safeParse(binding.taskHash).success)
    fail('LEARNING_BINDING_INVALID', 'Некорректная связь материала с задачей.');
  const plan = GraphPlanSchema.safeParse(store.readObject('plans', binding.planHash));
  const task = TaskSpecSchema.safeParse(store.readObject('tasks', binding.taskHash));
  if (!plan.success || !task.success || plan.data.taskHash !== binding.taskHash || plan.data.schemaVersion !== 3
    || plan.data.stage !== 'execution' || !plan.data.executionStages || !plan.data.taskContract)
    fail('LEARNING_BINDING_INVALID', 'Материал требует связанный исполняемый план и контракт.');
  return { plan: plan.data, task: task.data };
}

function receiptSet(store, ids, binding, allowedNodes, plan) {
  if (!Array.isArray(ids) || new Set(ids).size !== ids.length)
    fail('LEARNING_RECEIPT_INVALID', 'Некорректный набор receipts.');
  return ids.map((id) => {
    const result = ReceiptSchema.safeParse(store.readObject('receipts', id));
    if (!result.success) fail('LEARNING_RECEIPT_INVALID', 'Receipt не соответствует контракту.');
    const receipt = result.data;
    const node = plan.nodes.find((item) => item.id === receipt.nodeId);
    if (receipt.runId !== binding.runId || receipt.planHash !== binding.planHash || receipt.taskHash !== binding.taskHash
      || !allowedNodes.includes(receipt.nodeId) || receipt.phase !== 'finished' || receipt.verdict !== 'pass'
      || !node || receipt.actionId !== node.action.id || receipt.actionVersion !== node.action.version || receipt.planVersion !== plan.version
      || receipt.termination?.uncertain || receipt.termination?.stopped === false)
      fail('LEARNING_RECEIPT_INVALID', 'Receipt не принадлежит завершенной работе этого материала.');
    return receipt;
  });
}

/** Check only completion consistency; registry authority and proof stay in the
 * executor. Internal workspace-check has no process ticket or execution record. */
function assertSuccessfulCheckReceipt(receipt) {
  const termination = receipt.termination;
  if (receipt.exitCode !== 0 || receipt.failureReason !== null || receipt.finishedAt === null
    || !termination || termination.stopped !== true || termination.uncertain !== false
    || termination.timedOut !== false || termination.outputLimit !== false || termination.signal !== null
    || receipt.checks.some((check) => check.passed !== true || check.exitCode !== 0))
    fail('LEARNING_RECEIPT_INVALID', 'Receipt проверки содержит ошибку или не подтверждает успешное завершение.');
}

function captureCatalog(store, capture, roles) {
  if (!capture || !Hash.safeParse(capture.sourceHash).success || !Hash.safeParse(capture.sourceCatalogHash).success)
    fail('LEARNING_CAPTURE_INVALID', 'Отсутствует закрепленная ссылка на capture.');
  const catalog = readLearningSourceCatalog(store, capture.sourceCatalogHash);
  if (catalog.sources.some((source) => !roles.includes(source.role)))
    fail('LEARNING_CAPTURE_INVALID', 'Роль исходника не соответствует границе capture.');
  return catalog;
}

/** @param {import('./store.mjs').GraphStore} store */
function mergeCaptures(store, before, after, policy, extraGaps) {
  const previous = captureCatalog(store, before, ['before']);
  const current = captureCatalog(store, after, ['after', 'context']);
  const gaps = safeLearningGaps([...before.gaps, ...after.gaps, ...extraGaps], policy);
  const sources = [];
  // Prefer the final version when the combined catalog exceeds its budget.
  for (const source of [...current.sources, ...previous.sources]) {
    try { verifyLearningSource(store, source, policy); }
    catch (error) {
      if (error.code !== 'LEARNING_SOURCE_DENIED') throw error;
      gaps.push({ code: 'excluded-source', path: null, reason: 'Исходник исключен действующей политикой.' }); continue;
    }
    sources.push(source);
  }
  if (!sources.length && !gaps.length) gaps.push({ code: 'capture-unavailable', path: null, reason: 'Выбранный набор не содержит сохраненных исходников.' });
  return { catalog: SourceCatalogSchema.parse({ version: 1, sources }), gaps: safeLearningGaps(gaps, policy) };
}

/** Persist a material after durable captures. Does not mutate execution/run state.
 * `before` is the entire reference saved before the effect; never recapture it.
 * For kind:task, `after` MUST be a new capture from the final fingerprint.
 * This validates provenance, not PROVEN or educational completeness.
 * @param {{store: import('./store.mjs').GraphStore, binding: MaterialBinding, kind?: 'stage'|'task', stageId?: string|null,
 * before: SourceCapture, after: SourceCapture, implementationReceiptIds: string[], checkReceiptIds: string[], reviewReceiptIds?: string[],
 * diffArtifactIds?: string[], findingsArtifactIds?: string[], gaps?: import('./learning-sources.mjs').MaterialGap[], policy?: SourcePolicy, createdAt?: string}} options
 */
export function createLearningMaterial({ store, binding, kind = 'stage', stageId = null, before, after,
  implementationReceiptIds, checkReceiptIds, reviewReceiptIds = [], diffArtifactIds = [], findingsArtifactIds = [], gaps = [], policy = {}, createdAt = new Date().toISOString() }) {
  const { plan, task } = linkedPlan(store, binding);
  const stage = plan.executionStages.stages.find((item) => item.id === stageId);
  if (kind === 'stage' ? !stage : kind !== 'task' || stageId !== null)
    fail('LEARNING_STAGE_INVALID', 'Материал не связан с этапом плана.');
  const stages = kind === 'task' ? plan.executionStages.stages : [stage];
  const implementationNodes = stages.flatMap((item) => item.implementationNodeIds);
  const checkNodes = [...new Set(stages.flatMap((item) => [item.scopeCheckNodeId, ...item.checkNodeIds]))];
  const implementations = receiptSet(store, implementationReceiptIds, binding, implementationNodes, plan);
  const checks = receiptSet(store, checkReceiptIds, binding, [...checkNodes, ...plan.executionStages.finalCheckNodeIds], plan);
  checks.forEach(assertSuccessfulCheckReceipt);
  const reviews = receiptSet(store, reviewReceiptIds, binding, [plan.executionStages.finalReviewNodeId], plan);
  // Failed/uncertain work has diagnostics, not a successful final synthesis.
  if (!implementationNodes.every((nodeId) => implementations.some((receipt) => receipt.nodeId === nodeId))
    || implementations.length === 0 || implementations[0].beforeFingerprint !== before.sourceHash
    || implementations.at(-1).afterFingerprint !== after.sourceHash)
    fail('LEARNING_RECEIPT_INVALID', 'Реализация не связана с before/result snapshots.');
  for (let index = 1; index < implementations.length; index++) {
    if (implementations[index].beforeFingerprint !== implementations[index - 1].afterFingerprint)
      fail('LEARNING_RECEIPT_INVALID', 'Цепочка версий реализации разорвана.');
  }
  const requiredChecks = kind === 'task' ? plan.executionStages.finalCheckNodeIds : stage.checkNodeIds;
  if (!requiredChecks.length || !requiredChecks.every((nodeId) => checks.some((receipt) => receipt.nodeId === nodeId
    && receipt.beforeFingerprint === after.sourceHash && receipt.afterFingerprint === after.sourceHash)))
    fail('LEARNING_RECEIPT_INVALID', 'Нет обязательных проверок итоговой версии материала.');
  if (kind === 'stage' && !checks.some((receipt) => receipt.nodeId === stage.scopeCheckNodeId
    && receipt.beforeFingerprint === after.sourceHash && receipt.afterFingerprint === after.sourceHash))
    fail('LEARNING_RECEIPT_INVALID', 'Нет проверки области изменений этого этапа.');
  if (kind === 'task' && !reviews.some((receipt) => receipt.beforeFingerprint === after.sourceHash && receipt.afterFingerprint === after.sourceHash))
    fail('LEARNING_RECEIPT_INVALID', 'Итоговый материал требует ревью финальной версии.');
  const attached = new Set([...implementations, ...checks, ...reviews].flatMap((receipt) => receipt.artifacts));
  for (const id of [...diffArtifactIds, ...findingsArtifactIds]) {
    if (!attached.has(id)) fail('LEARNING_ARTIFACT_INVALID', 'Артефакт не принадлежит receipts материала.');
    store.readObject('artifacts', id);
  }
  const merged = mergeCaptures(store, before, after, policy, gaps);
  const material = StageMaterialSchema.parse({ version: 1, kind, ...binding,
    contractHash: hashObject(plan.taskContract), stageId, goal: plan.taskContract.goal,
    outcome: stage?.outcome ?? task.goal, requirementIds: stage?.requirementIds ?? plan.taskContract.requirements.map((requirement) => requirement.id),
    beforeHash: before.sourceHash, resultHash: after.sourceHash, createdAt,
    sourceCatalogHash: putLearningSourceCatalog(store, merged.catalog), implementationReceiptIds, checkReceiptIds, reviewReceiptIds,
    diffArtifactIds, findingsArtifactIds, status: !merged.catalog.sources.length ? 'unavailable' : merged.gaps.length ? 'partial' : 'complete', gaps: merged.gaps });
  return { id: store.putObject('learning-materials', material), material };
}

/** `binding.materialHashes` comes from committed run state, never an HTTP body.
 * No live source read, refresh, repair, provider call or progress mutation.
 * @param {{store: import('./store.mjs').GraphStore, materialHash: string, binding: ReadBinding, policy?: SourcePolicy}} options
 */
export function readLearningMaterial({ store, materialHash, binding, policy = {} }) {
  if (!binding?.materialHashes?.includes(materialHash)) fail('LEARNING_MATERIAL_DENIED', 'Материал не закреплен за этим запуском.');
  const parsed = StageMaterialSchema.safeParse(store.readObject('learning-materials', materialHash));
  if (!parsed.success) fail('LEARNING_MATERIAL_INTEGRITY', 'Закрепленный материал поврежден.');
  const material = parsed.data;
  const { plan } = linkedPlan(store, binding);
  if (material.runId !== binding.runId || material.planHash !== binding.planHash || material.taskHash !== binding.taskHash
    || material.contractHash !== hashObject(plan.taskContract)
    || (material.kind === 'stage' ? !plan.executionStages.stages.some((stage) => stage.id === material.stageId) : material.stageId !== null))
    fail('LEARNING_MATERIAL_DENIED', 'Связь материала с запуском не совпадает.');
  const catalog = readLearningSourceCatalog(store, material.sourceCatalogHash);
  for (const source of catalog.sources) verifyLearningSource(store, source, policy);
  // Do not silently sanitize an immutable object while retaining its hash.
  if (hashObject(safeLearningGaps(material.gaps, policy)) !== hashObject(material.gaps))
    fail('LEARNING_SOURCE_DENIED', 'Контекст материала закрыт действующей политикой.');
  const sourceCatalog = store.readObject('learning-sources', material.sourceCatalogHash);
  return { id: materialHash, material, sources: catalog.sources, ...(sourceCatalog.version === 2 ? { sourceCatalog } : {}) };
}

/** @param {{store: import('./store.mjs').GraphStore, materialHash: string, binding: ReadBinding, sourceId: string,
 * policy?: SourcePolicy, startLine?: number, lineCount?: number, startColumn?: number}} options */
export function readLearningSourcePage(options) {
  const result = readLearningMaterial(options);
  const source = result.sources.find((item) => item.id === options.sourceId);
  if (!source) fail('LEARNING_SOURCE_DENIED', 'Исходник не принадлежит материалу.');
  return savedLearningSourcePage(options.store, source, options);
}

/** @param {{store: import('./store.mjs').GraphStore, materialHash: string, binding: ReadBinding, policy?: SourcePolicy,
 * anchor: import('zod').infer<typeof import('./learning-schemas.mjs').SourceAnchorSchema>}} options */
export function validateLearningSourceAnchor(options) {
  const result = readLearningMaterial(options);
  const source = result.sources.find((item) => item.id === options.anchor?.sourceId);
  if (!source) fail('LEARNING_SOURCE_DENIED', 'Исходник не принадлежит материалу.');
  return savedSourceAnchor(options.store, source, options.anchor, options.policy);
}
