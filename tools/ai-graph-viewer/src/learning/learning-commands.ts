import type { Capability, ContinueLearning, LearningMode, SetLearningMode, Snapshot } from '../contracts';
import type { PendingControlOperation } from '../control-operations';
import { learningCapability, learningRun } from './learning-projection';

export type LearningIntent = { action: 'continue-learning'; holdId: string; disposition: 'continue' | 'defer' }
  | { action: 'set-learning-mode'; mode: LearningMode };
export function learningCommandCapability(snapshot: Snapshot | null, intent: LearningIntent, unavailable = false, now = Date.now()): Capability {
  const run = learningRun(snapshot);
  const denied = (reason: string): Capability => ({ allowed: false, reason });
  if (!run) return denied('Этот запуск не предоставляет совместимое учебное состояние.');
  if (unavailable || !run.integrity.valid) return denied('Сначала обновите и проверьте состояние задачи.');
  if (!run.planHash || run.revision == null) return denied('Не получена актуальная версия плана.');
  const cap = learningCapability(run, intent.action === 'continue-learning' ? 'continueLearning' : 'setLearningMode');
  if (!cap.allowed) return cap;
  if (!['idle', 'stopped'].includes(run.execution?.state ?? '') || run.status === 'running') return denied('Дождитесь завершения текущей операции.');
  if (intent.action === 'continue-learning') {
    if (run.continuation.kind !== 'learning-hold' || run.continuation.holdId !== intent.holdId) return denied('Учебная пауза изменилась. Проверьте актуальное состояние.');
    if (run.status !== 'learning-hold') return denied('Продолжение требует решения по текущему состоянию задачи.');
    if (run.approvalExpiresAt !== null && run.approvalExpiresAt <= now) return denied('Разрешение истекло. Проверьте актуальный план.');
  }
  return cap;
}
export function learningOperation(snapshot: Snapshot, intent: LearningIntent, operationId: string): PendingControlOperation {
  if (!snapshot.planHash || snapshot.revision == null) throw new Error('Missing command binding');
  const envelope = { operationId, expectedRevision: snapshot.revision, planHash: snapshot.planHash };
  const request = intent.action === 'continue-learning'
    ? { ...envelope, holdId: intent.holdId, disposition: intent.disposition } satisfies ContinueLearning
    : { ...envelope, mode: intent.mode } satisfies SetLearningMode;
  return { kind: 'control', key: `${snapshot.runId}:${intent.action}:${intent.action === 'continue-learning' ? intent.holdId : intent.mode}`,
    operationId, runId: snapshot.runId, action: intent.action, request };
}
