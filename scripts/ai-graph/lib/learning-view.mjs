import { GraphError, hashObject } from './io.mjs';
import { Hash, Id } from './schema-primitives.mjs';
import { ReceiptSchema } from './schemas.mjs';
import { LearningMaterialResponseSchema, LearningSnapshotSchema, StageMaterialSchema } from './learning-schemas.mjs';
import { readLearningMaterial, readLearningSourcePage } from './learning-material.mjs';

const generationUnavailable = 'Генератор учебных материалов еще не подключен.';
const answersUnavailable = 'Ответы на вопросы по учебным материалам еще не подключены.';
/** @returns {never} */
const fail = (code, message) => { throw new GraphError(code, message); };

const committedHashes = state => [...new Set([
  ...Object.values(state.learning?.stages ?? {}).map(record => record.materialHash),
  state.learning?.finalMaterialHash,
].filter(Boolean))];

function currentPolicy(host, requested, owner) {
  const project = host.adapters.learningSourcePolicy
    ? host.adapters.learningSourcePolicy()
    : { denyGlobs: host.adapters.project?.aiDenyGlobs ?? [], outputPaths: host.adapters.project?.outputPaths ?? [] };
  return {
    denyGlobs: project.denyGlobs,
    outputPaths: project.outputPaths,
    forbiddenPaths: [...new Set([...(requested.task.forbiddenPaths ?? []), ...(owner.task.forbiddenPaths ?? [])])],
  };
}

function materialContext(host, runId, materialHash) {
  if (!Id.safeParse(runId).success || !Hash.safeParse(materialHash).success)
    fail('LEARNING_BINDING_INVALID', 'Некорректная ссылка на учебный материал.');
  const requested = host.read(runId, { current: false, verifySource: false, verifyBinding: false });
  const owns = candidate => candidate.state.schemaVersion === 3 && committedHashes(candidate.state).includes(materialHash);
  const owner = owns(requested) ? requested : host.executionHistory(requested.state).find(owns);
  if (!owner) fail('LEARNING_MATERIAL_DENIED', 'Материал не закреплен за запуском или его историей.');
  return { requested, owner, options: {
    store: host.store, materialHash,
    binding: { runId: owner.state.runId, planHash: owner.state.planHash, taskHash: owner.state.taskHash,
      materialHashes: committedHashes(owner.state) },
    policy: currentPolicy(host, requested, owner),
  } };
}

function assertMaterialOwner(owner, materialHash, material) {
  const { state, plan } = owner;
  const linked = material.kind === 'task'
    ? material.stageId === null && state.learning.finalMaterialHash === materialHash
    : state.learning.stages[material.stageId]?.materialHash === materialHash &&
      plan.executionStages.stages.some(stage => stage.id === material.stageId);
  if (!linked || material.runId !== state.runId || material.planHash !== state.planHash ||
      material.taskHash !== state.taskHash || material.contractHash !== hashObject(plan.taskContract))
    fail('LEARNING_MATERIAL_DENIED', 'Сохраненный материал относится к другому запуску или этапу.');
}

function materialMetadata(host, owner, materialHash) {
  const parsed = StageMaterialSchema.safeParse(host.store.readObject('learning-materials', materialHash));
  if (!parsed.success) fail('LEARNING_MATERIAL_INTEGRITY', 'Закрепленный материал поврежден.');
  assertMaterialOwner(owner, materialHash, parsed.data);
  return parsed.data;
}

/** Permission to read saved history is independent of current execution rights. */
export function openLearningCapability(host, state) {
  try {
    const requested = host.read(state.runId, { current: false, verifySource: false, verifyBinding: false });
    const owners = [requested, ...host.executionHistory(requested.state)];
    const candidates = owners.filter(owner => owner.state.schemaVersion === 3).flatMap(owner => {
      const hashes = committedHashes(owner.state);
      return hashes.map(materialHash => {
        // Validate every referenced metadata object before considering any convenient readable one.
        materialMetadata(host, owner, materialHash);
        return { store: host.store, materialHash,
          binding: { runId: owner.state.runId, planHash: owner.state.planHash, taskHash: owner.state.taskHash, materialHashes: hashes },
          policy: currentPolicy(host, requested, owner) };
      });
    });
    if (!candidates.length) return { allowed: false, reason: 'Материал еще не сохранен.' };
    let readable = false;
    for (const options of candidates) {
      try { readLearningMaterial(options); readable = true; }
      catch (error) {
        if (error.code !== 'LEARNING_SOURCE_DENIED') throw error;
      }
    }
    return readable ? { allowed: true, reason: null }
      : { allowed: false, reason: 'Сохраненные материалы закрыты действующей политикой доступа (LEARNING_SOURCE_DENIED).' };
  } catch (error) {
    const code = typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : 'LEARNING_READ_UNAVAILABLE';
    return { allowed: false, reason: `Доступ к сохраненным материалам не подтвержден (${code}).` };
  }
}

function freshness(state, resultHash, driftReason = null) {
  if (driftReason || state.activeOperation || state.learning?.failure || state.status === 'uncertain' ||
      state.finalDisposition === 'superseded' || Object.values(state.nodes).some(node => node.status === 'running'))
    return { state: 'unknown', reason: driftReason || 'Текущая версия проекта не подтверждена завершенным действием.' };
  if (!state.workspaceFingerprint?.hash || !resultHash)
    return { state: 'unknown', reason: 'Нет сохраненной версии проекта для сравнения.' };
  return state.workspaceFingerprint.hash === resultHash
    ? { state: 'current', reason: 'Совпадает с последней сохраненной версией проекта.' }
    : { state: 'stale', reason: 'Последняя сохраненная версия проекта отличается от материала.' };
}

/** A read never marks a material as read or schedules a provider. */
export function learningMaterial(host, runId, materialHash) {
  const context = materialContext(host, runId, materialHash);
  const result = readLearningMaterial(context.options);
  assertMaterialOwner(context.owner, materialHash, result.material);
  const state = context.requested.state;
  const projection = host.learningProjection?.(state, materialHash) ?? { lessonHash: null, lessonStatus: 'absent' };
  const generate = result.sources.length ? host.learningCapability?.(state, materialHash, 'lesson') : null;
  const ask = projection.lessonHash ? host.learningCapability?.(state, materialHash, 'question') : null;
  const quiescent = state.schemaVersion === 3 && !state.activeOperation && !state.setupPending && !host.store.inspectLock(state.runId) &&
    !Object.values(state.nodes).some(node => node.status === 'running') &&
    !Object.values(state.operations ?? {}).some(operation => ['running', 'creating'].includes(operation.status));
  return LearningMaterialResponseSchema.parse({ ...result,
    progress: state.learning?.progress?.[materialHash] ?? context.owner.state.learning?.progress?.[materialHash] ?? 'unread',
    freshness: freshness(state, result.material.resultHash), lessonHash: projection.lessonHash,
    capabilities: {
      generateLesson: generate ?? { allowed: false, reason: result.sources.length ? generationUnavailable : 'В материале нет сохраненных исходников для разбора.' },
      askLesson: ask ?? { allowed: false, reason: projection.lessonHash ? answersUnavailable : 'Сначала нужен сохраненный разбор этого материала.' },
      setLearningProgress: { allowed: quiescent, reason: quiescent ? null : 'Дождитесь завершения текущего действия запуска.' },
    },
  });
}

/** @param {{startLine?: number, lineCount?: number}} options */
export function learningSource(host, runId, materialHash, sourceId, options = {}) {
  const context = materialContext(host, runId, materialHash);
  // Validate the committed stage slot before returning any saved source bytes.
  materialMetadata(host, context.owner, materialHash);
  return readLearningSourcePage({ ...context.options, sourceId, startLine: options.startLine, lineCount: options.lineCount });
}

export function learningUnavailable(host, runId, kind, id) {
  if (!['lesson', 'job', 'answer'].includes(kind) ||
      !(kind === 'job' ? Id : Hash).safeParse(id).success)
    fail('INVALID_REQUEST', 'Некорректная ссылка на учебный объект.');
  host.read(runId, { current: false, verifySource: false, verifyBinding: false });
  fail('NOT_FOUND', kind === 'answer' ? answersUnavailable : generationUnavailable);
}

function boundaryResult(host, state, plan, stage, record) {
  const node = state.nodes[stage.boundaryNodeId];
  const definition = plan.nodes.find(item => item.id === stage.boundaryNodeId);
  const receipt = ReceiptSchema.parse(host.store.readObject('receipts', record.boundaryReceiptId));
  if (!node || !definition || node.receipts.at(-1) !== record.boundaryReceiptId ||
      receipt.runId !== state.runId || receipt.planHash !== state.planHash || receipt.taskHash !== state.taskHash ||
      receipt.nodeId !== stage.boundaryNodeId || receipt.actionId !== definition.action.id ||
      receipt.actionVersion !== definition.action.version || receipt.planVersion !== plan.version ||
      receipt.phase !== 'finished' || receipt.verdict !== 'pass' || receipt.exitCode !== 0 ||
      receipt.failureReason !== null || !receipt.finishedAt || receipt.termination?.stopped !== true || receipt.termination?.uncertain !== false ||
      receipt.termination?.timedOut !== false || receipt.termination?.outputLimit !== false || receipt.termination?.signal !== null ||
      !Hash.safeParse(receipt.afterFingerprint).success)
    fail('LEARNING_BOUNDARY_INTEGRITY', 'Граница учебного этапа не подтверждена сохраненным receipt.');
  return receipt.afterFingerprint;
}

/** Canonical stage metadata comes from the immutable plan; execution owns success. */
export function learningSnapshot(host, state, task, plan, driftReason = null) {
  const stages = (plan.executionStages?.stages ?? []).map(stage => {
    const record = state.learning.stages[stage.id];
    const materialHash = record?.materialHash ?? null;
    const material = materialHash ? materialMetadata(host, { state, task, plan }, materialHash) : null;
    const checkedResultHash = record ? boundaryResult(host, state, plan, stage, record) : null;
    if (material && (material.kind !== 'stage' || material.stageId !== stage.id || material.resultHash !== checkedResultHash))
      fail('LEARNING_BOUNDARY_INTEGRITY', 'Материал не совпадает с проверенной версией границы этапа.');
    const nodeIds = [...new Set([...stage.implementationNodeIds, stage.scopeCheckNodeId, ...stage.checkNodeIds, stage.boundaryNodeId,
      ...(stage.boundaryNodeId === plan.executionStages.handoffNodeId ? [plan.executionStages.finalReviewNodeId] : [])])];
    const nodes = nodeIds.map(id => state.nodes[id]);
    if (nodes.some(node => !node)) fail('LEARNING_BOUNDARY_INTEGRITY', 'В запуске отсутствует работа учебного этапа.');
    const failure = state.learning.failure?.stageId === stage.id ? state.learning.failure : null;
    const status = nodes.some(node => node.status === 'uncertain') ? 'uncertain'
      : failure || nodes.some(node => ['failed', 'cancelled'].includes(node.status)) ? 'failed'
      : record && stage.checkNodeIds.length && nodes.every(node => node.status === 'passed') ? 'verified'
      : nodes.every(node => node.status === 'passed') ? 'uncertain'
      : nodes.some(node => ['running', 'passed'].includes(node.status) || node.attempts > 0) ? 'running' : 'pending';
    const reason = failure?.reason ?? record?.materialError ?? nodes.find(node => ['failed', 'uncertain', 'cancelled'].includes(node.status))?.reason ??
      (!stage.checkNodeIds.length ? 'Нет зарегистрированной обязательной проверки этапа.' :
        status === 'uncertain' && !record ? 'Нет сохраненной границы завершенного этапа.' : null);
    const projection = materialHash ? host.learningProjection?.(state, materialHash) : null;
    return {
      id: stage.id, title: stage.title, outcome: stage.outcome, requirementIds: stage.requirementIds,
      status, checkedResultHash, freshness: freshness(state, material?.resultHash ?? checkedResultHash, driftReason).state,
      materialHash, materialStatus: material?.status ?? (record || failure ? 'unavailable' : 'pending'),
      lessonHash: projection?.lessonHash ?? null, lessonStatus: projection?.lessonStatus ?? 'absent', progress: materialHash ? state.learning.progress[materialHash] ?? 'unread' : 'unread', reason,
    };
  });
  const finalMaterialHash = state.learning.finalMaterialHash ?? null;
  if (finalMaterialHash) materialMetadata(host, { state, task, plan }, finalMaterialHash);
  return LearningSnapshotSchema.parse({ version: 1, mode: state.learning.mode, stages, finalMaterialHash,
    activeJob: host.learningProjection?.(state)?.activeJob ?? null });
}

// Trusted host-only binding for asynchronous preparation; never accepts caller-supplied lineage.
export { materialContext as learningMaterialContext };
