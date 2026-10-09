import { useCallback } from 'react';
import type { Snapshot, SnapshotV3 } from '../contracts';
import { api } from '../api';
import { learningRun } from './learning-projection';
import { learningReadMessage, useBoundRead } from './use-bound-read';

/** Snapshot metadata discovers committed refs. Material/source URLs always retain the selected context. */
export function HistoricalMaterials({ context, allowed, onOpen }: {
  context: SnapshotV3; allowed: boolean; onOpen: (runId: string, materialHash: string, predecessors: Snapshot[]) => void;
}) {
  const predecessorId = context.supersedesRunId;
  const load = useCallback(async (signal: AbortSignal) => {
    const previous: Snapshot[] = [], visited = new Set([context.runId]);
    let id = predecessorId;
    while (id) {
      if (signal.aborted) throw { code: 'READ_UNAVAILABLE', message: 'Чтение истории прервано.', retryable: true };
      if (previous.length >= 100 || visited.has(id)) throw { code: 'LEARNING_HISTORY_INVALID', message: 'Цепочка истории несовместима или превышает предел чтения.', retryable: false };
      visited.add(id);
      const snapshot = await api.snapshot(id, signal);
      if (snapshot.runId !== id) throw { code: 'LEARNING_HISTORY_INVALID', message: 'Ответ относится к другой версии запуска.', retryable: false };
      previous.push(snapshot); id = snapshot.supersedesRunId;
    }
    return previous;
  }, [context.runId, predecessorId]);
  const result = useBoundRead(predecessorId ? `${context.runId}:${predecessorId}` : null, load);
  if (!predecessorId) return null;
  return <section className="historical-materials"><h3>Предыдущие версии задачи</h3>
    <p>Исторические исходники читаются с ограничениями выбранного запуска.</p>
    {result.state === 'loading' && <p role="status">Читаем ссылки из истории…</p>}
    {result.error && <p role="alert">{learningReadMessage(result.error)} <button className="game-text-action" type="button" onClick={result.reload}>Повторить чтение истории</button></p>}
    {result.data?.map(previous => {
      const run = learningRun(previous);
      const refs = run ? [...run.learning.stages.filter(stage => stage.materialHash).map(stage => ({hash:stage.materialHash!,title:stage.title})),
        ...(run.learning.finalMaterialHash ? [{hash:run.learning.finalMaterialHash,title:'Итоговая версия'}] : [])] : [];
      return <div key={previous.runId}><h4>Запуск {previous.runId}</h4>
        {!refs.length && <p>Ссылки на сохраненный материал в этой версии недоступны.</p>}
        {refs.map(item => <button key={item.hash} className="game-text-action" type="button" disabled={!allowed}
          onClick={() => onOpen(context.runId,item.hash,result.data!)}>{item.title} · исторический материал</button>)}
      </div>;
    })}
  </section>;
}
