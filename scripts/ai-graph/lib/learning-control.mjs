import { GraphError, hashObject, now } from './io.mjs';
import { ContinueLearningSchema, SetLearningModeSchema, SetLearningProgressSchema } from './learning-schemas.mjs';
import { reconcile } from './state.mjs';

export const learningCommands = {
  'continue-learning': ContinueLearningSchema, 'set-learning-mode': SetLearningModeSchema,
  'set-learning-progress': SetLearningProgressSchema,
};
const fail = (code, message) => { throw new GraphError(code, message); };

/** Uses the executor's operation ledger and CAS. Learning never grants execution rights. */
export async function learningCommand(host, runId, name, input, actor) {
  const request = learningCommands[name].parse(input);
  let { state } = host.read(runId, { current: false });
  let plan;
  if (state.schemaVersion !== 3) fail('CONTROL_DENIED', 'Обучение доступно только для нового плана V3.');
  const digest = hashObject({ name, request, actor }), prior = state.operations[request.operationId];
  if (prior) {
    if (prior.digest !== digest) fail('IDEMPOTENCY_CONFLICT', 'operationId уже связан с другим действием.');
    return host.snapshot(runId);
  }
  if (Object.keys(state.operations).length >= 200 || state.learning.eventIds.length >= 200)
    fail('OPERATION_LIMIT', 'Лимит управляющих операций исчерпан.');
  if (state.revision !== request.expectedRevision) fail('REVISION_CONFLICT', 'Откройте актуальное состояние.');
  if (state.planHash !== request.planHash) fail('PLAN_CONFLICT', 'Запрос относится к другому плану.');
  const busy = state.activeOperation || state.setupPending || host.store.inspectLock(runId) ||
    Object.values(state.operations).some((op) => ['running', 'creating'].includes(op.status));
  if (busy) fail('CONTROL_DENIED', 'Дождитесь завершения активной операции.');
  let next = { ...state, learning: structuredClone(state.learning) };
  if (name === 'continue-learning') {
    const hold = state.continuation;
    if (hold.kind !== 'learning-hold' || hold.holdId !== request.holdId)
      fail('HOLD_CONFLICT', 'Эта пауза уже снята или относится к другой границе.');
    ({ state, plan } = host.read(runId));
    if (hold.materialHash) host.learningMaterial(runId, hold.materialHash);
    const cap = host.caps(state, plan).run.continueLearning;
    if (!cap?.allowed) fail('CONTROL_DENIED', cap?.reason ?? 'Продолжение недоступно.');
    const fingerprint = await host.assertWorkspace(state);
    if (fingerprint.hash !== hold.resultHash) fail('WORKSPACE_DRIFT', 'Результат этапа изменился после проверки.');
    const deadline = host.executionDeadline(state, plan);
    if (deadline !== null && Date.now() >= deadline) fail('AUTONOMY_LIMIT', 'Истек срок согласованного выполнения.');
    next = { ...state, learning: structuredClone(state.learning), continuation: { kind: 'open' }, status: 'pending' };
    if (request.disposition === 'defer' && hold.materialHash) next.learning.progress[hold.materialHash] = 'deferred';
    next = reconcile(next, plan);
  } else if (name === 'set-learning-mode') {
    ({ state, plan } = host.read(runId));
    if (!host.caps(state, plan).run.setLearningMode?.allowed) fail('CONTROL_DENIED', 'Режим можно менять только в спокойном состоянии запуска.');
    if (state.binding) await host.assertWorkspace(state);
    next = { ...state, learning: structuredClone(state.learning) };
    next.learning.mode = request.mode;
  } else {
    const material = host.learningMaterial(runId, request.materialHash);
    if (!material.capabilities.setLearningProgress.allowed) fail('CONTROL_DENIED', material.capabilities.setLearningProgress.reason);
    next.learning.progress[request.materialHash] = request.progress;
  }
  const eventId = host.store.putObject('learning-events', { version: 1, runId, planHash: state.planHash,
    taskHash: state.taskHash, name, request, actor, createdAt: now() });
  next.learning.eventIds = [...next.learning.eventIds, eventId];
  host.write(state, { ...next,
    operations: { ...state.operations, [request.operationId]: { digest, status: 'finished' } } });
  if (name === 'continue-learning') host.schedule(runId);
  return host.snapshot(runId);
}
