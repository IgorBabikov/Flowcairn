import type { Capability, LearningSnapshot, Snapshot, SnapshotV3, SourceFreshness, StageMaterial } from '../contracts';
import { record, text, hash, id, list, nullable, choice, uniqueIds } from './validation';

function learningData(value: unknown): value is LearningSnapshot {
  if (!record(value) || value.version !== 1 || !choice(value.mode, ['after-stage', 'after-task']) || !Array.isArray(value.stages) || value.stages.length > 12) return false;
  const validStages = value.stages.every(stage => record(stage) && id(stage.id) && text(stage.title, 160) && text(stage.outcome)
    && list(stage.requirementIds, id, 40) && choice(stage.status, ['pending', 'running', 'verified', 'failed', 'uncertain'])
    && nullable(stage.checkedResultHash, hash) && choice(stage.freshness, ['current', 'stale', 'unknown']) && nullable(stage.materialHash, hash)
    && choice(stage.materialStatus, ['pending', 'complete', 'partial', 'unavailable']) && nullable(stage.lessonHash, hash)
    && choice(stage.lessonStatus, ['absent', 'generating', 'ready', 'failed', 'uncertain']) && choice(stage.progress, ['unread', 'read', 'deferred']) && nullable(stage.reason, text));
  return validStages && uniqueIds(value.stages) && nullable(value.finalMaterialHash, hash) && (value.activeJob === null
    || record(value.activeJob) && id(value.activeJob.id) && choice(value.activeJob.kind, ['lesson', 'question']) && hash(value.activeJob.materialHash));
}
export function learningRun(snapshot: Snapshot | null): SnapshotV3 | null {
  if (snapshot?.schemaVersion !== 3 || !learningData(snapshot.learning) || !record(snapshot.continuation)) return null;
  const hold = snapshot.continuation;
  if (hold.kind !== 'open' && !(hold.kind === 'learning-hold' && hash(hold.holdId) && id(hold.stageId)
    && hash(hold.boundaryReceiptId) && hash(hold.resultHash) && text(hold.createdAt) && nullable(hold.materialHash, hash))) return null;
  return snapshot;
}
export function learningCapability(snapshot: Snapshot | null, name: 'openLearning' | 'continueLearning' | 'setLearningMode'): Capability {
  return snapshot?.capabilities[name] ?? { allowed: false, reason: 'Сервис не сообщил о доступности этого действия.' };
}
export const freshnessLabels = { current: 'Актуально', stale: 'Устарело относительно проекта', unknown: 'Актуальность неизвестна' };
export const stageLabels = { pending: 'Ожидает выполнения', running: 'Выполняется', verified: 'Этап проверен', failed: 'Ошибка этапа', uncertain: 'Результат неизвестен' };
export const progressLabels = { unread: 'Не отмечено прочитанным', read: 'Отмечено прочитанным', deferred: 'Отложено' };
/** A material GET compares persisted versions only. Live freshness requires a checked snapshot. */
export function resultFreshness(snapshot: Snapshot | null, resultHash: string | null, contextRunId: string, unavailable = false): SourceFreshness {
  const run = learningRun(snapshot);
  if (!run || !hash(resultHash) || run.runId !== contextRunId || unavailable || !run.integrity.valid
    || ['running', 'uncertain', 'stale'].includes(run.status) || !['idle', 'stopped'].includes(run.execution?.state ?? '')
    || run.nodes.some(node => node.status === 'running') || !hash(run.proof?.resultHash)) return 'unknown';
  return run.proof.resultHash === resultHash ? 'current' : 'stale';
}

export const materialFreshness = (snapshot: Snapshot | null, material: StageMaterial | null, contextRunId: string, unavailable = false): SourceFreshness =>
  resultFreshness(snapshot, material?.resultHash ?? null, contextRunId, unavailable);

/** Only explicit snapshot refs in the selected run's verified predecessor chain are UI navigation targets. */
export function knownLearningMaterial(snapshot: Snapshot, materialHash: string, predecessors: Snapshot[] = []): boolean {
  const contains = (value: Snapshot) => {
    const run = learningRun(value);
    return Boolean(run && (run.learning.finalMaterialHash === materialHash || run.learning.stages.some(stage => stage.materialHash === materialHash)));
  };
  if (contains(snapshot)) return true;
  const visited = new Set([snapshot.runId]);
  let expected = snapshot.supersedesRunId;
  for (const previous of predecessors.slice(0, 100)) {
    if (!expected || previous.runId !== expected || visited.has(previous.runId)) return false;
    visited.add(previous.runId);
    if (contains(previous)) return true;
    expected = previous.supersedesRunId;
  }
  return false;
}
