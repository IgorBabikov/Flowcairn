import { GraphError, hashObject, now } from './io.mjs';
import { captureLearningSources, readLearningSourceCatalog } from './learning-sources.mjs';
import { createLearningMaterial } from './learning-material.mjs';
import { StageMaterialSchema } from './learning-schemas.mjs';

const fail = (message) => { throw new GraphError('LEARNING_STATE_INTEGRITY', message); };
const unsafe = (capture) => capture.gaps.some((gap) => gap.code === 'capture-unavailable');
const contains = (scope, file) => file === scope.replace(/\/$/, '') || file.startsWith(`${scope.replace(/\/$/, '')}/`);
export const learningPolicy = (adapters, task) => ({
  ...(adapters.learningSourcePolicy?.() ?? { denyGlobs: adapters.project?.aiDenyGlobs ?? [], outputPaths: adapters.project?.outputPaths ?? [] }),
  forbiddenPaths: task.forbiddenPaths,
});

// Selection comes from approved executor paths and its complete fingerprint, never a lesson.
function capture(host, state, task, plan, fingerprint, role, changedFiles = []) {
  const paths = [...new Set(plan.nodes.filter((node) => node.action.id === 'ai-implement')
    .flatMap((node) => [...node.resources.reads, ...node.resources.writes]))];
  const selected = fingerprint.files.filter((file) => paths.some((scope) => contains(scope, file.path)));
  const files = selected.map((file) => ({ path: file.path,
    role: role === 'before' ? 'before' : changedFiles.includes(file.path) ? 'after' : 'context',
    expected: { hash: file.hash, size: file.size, mode: file.mode } }));
  // Missing exact declared paths record honest absence/context; directory prefixes need no fabricated file.
  for (const item of paths.filter((scope) => !scope.endsWith('/') && !selected.some((file) => contains(scope, file.path))))
    files.push({ path: item, role: role === 'before' ? 'before' : changedFiles.includes(item) ? 'after' : 'context', expected: null });
  files.sort((a, b) => Number(!changedFiles.includes(a.path)) - Number(!changedFiles.includes(b.path)) || a.path.localeCompare(b.path));
  const result = captureLearningSources({ store: host.store, projectRoot: state.binding.worktree,
    sourceHash: fingerprint.hash, files: files.slice(0, files.length > 128 ? 127 : 128), policy: learningPolicy(host.adapters, task) });
  if (files.length > 128) result.gaps = [...result.gaps, {
    code: 'size-limit', path: null, reason: 'Объявленный контекст превышает 128 выбранных путей; часть исходников не сохранена.',
  }];
  return result;
}

function captureStillCurrent(host, state, fingerprint) {
  try { return host.adapters.fingerprint(state.binding.worktree, state.toolchain).hash === fingerprint.hash; }
  catch { return false; } // Persist the original capture with a blocking diagnostic, never silently recapture.
}

function failed(state, stageId) {
  const reason = 'Безопасность сохранения исходников не подтверждена; требуется новая версия плана.';
  return { ...state, status: 'failed', failureReason: reason,
    learning: { ...state.learning, failure: { stageId, code: 'LEARNING_CAPTURE_UNAVAILABLE', reason } } };
}

/** Entire before reference is committed before any write-capable implementation effect. */
export function captureStageBefore(host, state, task, plan, definition, fingerprint) {
  if (plan.schemaVersion !== 3 || plan.stage !== 'execution' || definition.action.id !== 'ai-implement') return state;
  const stage = plan.executionStages.stages.find((item) => item.implementationNodeIds.includes(definition.id));
  if (!stage || state.learning.failure || state.continuation.kind !== 'open') fail('Нет открытого безопасного этапа.');
  const previous = state.learning.captures?.[stage.id];
  if (previous) {
    if (previous.before.sourceHash !== fingerprint.hash || unsafe(previous.before)) fail('Сохраненный before не соответствует текущей попытке.');
    return state;
  }
  let before;
  try { before = capture(host, state, task, plan, fingerprint, 'before'); }
  catch (error) {
    // No effect is permitted after a storage/integrity failure in the original capture.
    host.write(state, failed(state, stage.id));
    throw error;
  }
  const next = { ...state, learning: { ...state.learning,
    captures: { ...state.learning.captures, [stage.id]: { before } } } };
  return host.write(state, unsafe(before) || !captureStillCurrent(host, state, fingerprint) ? failed(next, stage.id) : next);
}

function material(host, state, task, plan, stage, before, after, kind) {
  const stages = kind === 'task' ? plan.executionStages.stages : [stage];
  const receipts = (ids) => ids.map((id) => state.nodes[id].receipts.at(-1));
  const implementationReceiptIds = receipts(stages.flatMap((item) => item.implementationNodeIds));
  const checkReceiptIds = receipts(kind === 'task' ? plan.executionStages.finalCheckNodeIds : [stage.scopeCheckNodeId, ...stage.checkNodeIds]);
  const reviewReceiptIds = kind === 'task' ? receipts([plan.executionStages.finalReviewNodeId]) : [];
  const artifacts = [...implementationReceiptIds, ...checkReceiptIds, ...reviewReceiptIds]
    .flatMap((id) => host.store.readObject('receipts', id).artifacts);
  return createLearningMaterial({ store: host.store, binding: { runId: state.runId, planHash: state.planHash, taskHash: state.taskHash },
    kind, stageId: kind === 'task' ? null : stage.id, before, after, implementationReceiptIds, checkReceiptIds, reviewReceiptIds,
    diffArtifactIds: artifacts.filter((id) => host.store.readObject('artifacts', id).kind === 'diff'),
    findingsArtifactIds: artifacts.filter((id) => host.store.readObject('artifacts', id).kind === 'review-findings'),
    policy: learningPolicy(host.adapters, task) }).id;
}

/** Pure state candidate after durable objects; caller publishes receipt + material + hold in ONE CAS. */
export function completeStageBoundary(host, state, task, plan, definition, fingerprint, boundaryReceiptId) {
  if (plan.schemaVersion !== 3 || plan.stage !== 'execution' || state.stopRequested || state.nodes[definition.id].status !== 'passed') return state;
  const index = plan.executionStages.stages.findIndex((item) => item.boundaryNodeId === definition.id);
  if (index < 0) return state;
  const stage = plan.executionStages.stages[index], saved = state.learning.captures?.[stage.id];
  if (!saved || unsafe(saved.before) || state.learning.failure) fail('Граница не имеет безопасного сохраненного before.');
  const changed = stage.implementationNodeIds.flatMap((id) => state.nodes[id].changedFiles);
  const after = capture(host, state, task, plan, fingerprint, 'after', changed);
  let next = { ...state, learning: { ...state.learning,
    captures: { ...state.learning.captures, [stage.id]: { ...saved, after } } } };
  if (unsafe(after) || !captureStillCurrent(host, state, fingerprint)) return failed(next, stage.id);
  const materialHash = material(host, next, task, plan, stage, saved.before, after, 'stage');
  next.learning.stages = { ...next.learning.stages, [stage.id]: { boundaryReceiptId, materialHash, materialError: null } };
  if (index === plan.executionStages.stages.length - 1) {
    // A distinct capture of final bytes; never concatenation of previous materials.
    const finalCapture = capture(host, next, task, plan, fingerprint, 'after',
      plan.executionStages.stages.flatMap((item) => item.implementationNodeIds.flatMap((id) => next.nodes[id].changedFiles)));
    next.learning.finalCapture = finalCapture;
    if (unsafe(finalCapture) || !captureStillCurrent(host, state, fingerprint)) {
      delete next.learning.stages[stage.id];
      return failed(next, stage.id);
    }
    next.learning.finalMaterialHash = material(host, next, task, plan, stage,
      next.learning.captures[plan.executionStages.stages[0].id].before, finalCapture, 'task');
  } else if (next.learning.mode === 'after-stage') {
    const hold = { stageId: stage.id, boundaryReceiptId, resultHash: fingerprint.hash, createdAt: now(), materialHash };
    next.continuation = { kind: 'learning-hold', holdId: hashObject({ runId: next.runId, planHash: next.planHash, ...hold }), ...hold };
    next.status = 'learning-hold';
  }
  return next;
}

/** Validate committed references; no live source reads and no healing of missing evidence. */
export function assertLearningState(store, state, plan) {
  if (state.schemaVersion !== 3) return;
  const stages = plan.executionStages?.stages ?? [];
  const captures = state.learning.captures ?? {};
  if (new Set(state.learning.eventIds).size !== state.learning.eventIds.length) fail('Повтор учебного события.');
  for (const id of state.learning.eventIds) {
    const event = store.readObject('learning-events', id);
    const op = state.operations[event.request?.operationId];
    if (event.version !== 1 || event.runId !== state.runId || event.planHash !== state.planHash || event.taskHash !== state.taskHash ||
        !op || (op.status !== 'finished' && !(event.name === 'replan' && op.status === 'creating' && state.finalDisposition === 'superseded')) ||
        op.digest !== hashObject({ name: event.name, request: event.request, actor: event.actor }))
      fail('Учебное событие не связано с завершенной управляющей операцией.');
  }
  for (const [id, entry] of Object.entries(captures)) {
    const stage = stages.find((stage) => stage.id === id);
    if (!stage) fail('Capture принадлежит неизвестному этапу.');
    for (const ref of [entry.before, entry.after].filter(Boolean)) readLearningSourceCatalog(store, ref.sourceCatalogHash);
    if ((unsafe(entry.before) || (entry.after && unsafe(entry.after))) && !state.learning.failure) fail('Небезопасный capture не остановил выполнение.');
    const firstReceipt = state.nodes[stage.implementationNodeIds[0]].receipts[0];
    if (firstReceipt && store.readObject('receipts', firstReceipt).beforeFingerprint !== entry.before.sourceHash)
      fail('Исходный capture не относится к началу реализации.');
  }
  if (state.learning.finalCapture) readLearningSourceCatalog(store, state.learning.finalCapture.sourceCatalogHash);
  for (const [id, entry] of Object.entries(state.learning.stages)) {
    const stage = stages.find((item) => item.id === id);
    if (!stage || !captures[id]?.after || !entry.materialHash || entry.materialError !== null ||
        state.nodes[stage.boundaryNodeId].status !== 'passed' || state.nodes[stage.boundaryNodeId].receipts.at(-1) !== entry.boundaryReceiptId)
      fail('Граница этапа не подтверждена сохраненными evidence.');
    const saved = StageMaterialSchema.parse(store.readObject('learning-materials', entry.materialHash));
    const latest = (ids) => ids.map((nodeId) => state.nodes[nodeId].receipts.at(-1));
    if (saved.runId !== state.runId || saved.planHash !== state.planHash || saved.taskHash !== state.taskHash ||
        saved.stageId !== id || saved.kind !== 'stage' || saved.beforeHash !== captures[id].before.sourceHash || saved.resultHash !== captures[id].after.sourceHash ||
        store.readObject('receipts', entry.boundaryReceiptId).afterFingerprint !== saved.resultHash ||
        hashObject(saved.implementationReceiptIds) !== hashObject(latest(stage.implementationNodeIds)) ||
        hashObject(saved.checkReceiptIds) !== hashObject(latest([stage.scopeCheckNodeId, ...stage.checkNodeIds])))
      fail('Материал не принадлежит границе этапа.');
  }
  if (state.learning.finalMaterialHash) {
    const saved = StageMaterialSchema.parse(store.readObject('learning-materials', state.learning.finalMaterialHash));
    if (saved.kind !== 'task' || saved.runId !== state.runId || saved.planHash !== state.planHash || saved.taskHash !== state.taskHash ||
        saved.resultHash !== state.learning.finalCapture?.sourceHash || stages.some((stage) => !state.learning.stages[stage.id]))
      fail('Итоговый материал не подтвержден завершенными этапами.');
  }
  const hold = state.continuation;
  if (hold.kind === 'learning-hold') {
    const { kind: _kind, holdId, ...identity } = hold;
    const record = state.learning.stages[hold.stageId], index = stages.findIndex((stage) => stage.id === hold.stageId);
    if (hashObject({ runId: state.runId, planHash: state.planHash, ...identity }) !== holdId ||
        !record || index < 0 || index === stages.length - 1 || record.materialHash !== hold.materialHash ||
        record.boundaryReceiptId !== hold.boundaryReceiptId || captures[hold.stageId]?.after.sourceHash !== hold.resultHash ||
        state.workspaceFingerprint?.hash !== hold.resultHash || state.learning.failure ||
        stages.slice(index + 1).some((stage) => stage.implementationNodeIds.some((id) => state.nodes[id].attempts > 0)))
      fail('Пауза не соответствует границе и состоянию этапов.');
  }
}
