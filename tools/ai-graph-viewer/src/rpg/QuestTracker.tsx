import { learningRun } from '../learning/learning-projection';
import { taskStatusLabel } from '../task-presentation';
import type { WorkflowController } from '../workflow-controller-types';

export function QuestTracker({ controller: c, onOpen, passive, onLearning }: { controller: WorkflowController; onOpen: () => void; passive: boolean; onLearning: () => void }) {
  const s = c.snapshot;
  const status = s ? taskStatusLabel(s, c.execution, c.snapshotUnavailable) : c.loading ? 'Загружаем проект…' : 'Поручений пока нет';
  return <aside className={`quest-tracker${passive ? ' is-passive' : ''}`} aria-label="Текущее поручение">
    <strong>{s?.task?.title || s?.task?.goal || 'Новое поручение'}</strong>
    <p role="status" data-testid="rpg-runtime-status">{status}</p>
    <div hidden={passive}><button type="button" onClick={onOpen}>{s?.gates.length ? 'Проверить план' : s ? 'Открыть поручение' : 'В Гильдию'}</button>
      {learningRun(s) && <button type="button" onClick={onLearning}>Карта этапов и разбор</button>}
      {s?.capabilities.stop?.allowed && <button type="button" disabled={c.stopBusy || c.isStopping} onClick={() => void c.execute('stop')}>
        {c.stopBusy || c.isStopping ? 'Останавливаем…' : 'Остановить'}</button>}</div>
  </aside>;
}
