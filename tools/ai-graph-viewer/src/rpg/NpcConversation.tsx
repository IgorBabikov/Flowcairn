import type { WorkflowController } from '../workflow-controller-types';
import { learningCommandCapability } from '../learning/learning-commands';
import { learningRun } from '../learning/learning-projection';
import { useDecisionTime } from '../learning/LearningControls';
import { CloseObject } from './GameControls';
import { RuntimeNotices } from './RuntimeNotices';

export function NpcConversation({ controller: c, onPlan, onReports, onLearning, onClose }: {
  controller: WorkflowController; onPlan: () => void; onReports: () => void; onLearning: () => void; onClose: () => void;
}) {
  const s = c.snapshot;
  const learning = learningRun(s);
  const hold = learning?.continuation.kind === 'learning-hold' ? learning.continuation : null;
  const now = useDecisionTime(learning?.approvalExpiresAt);
  const deferCapability = hold ? learningCommandCapability(s, { action: 'continue-learning', holdId: hold.holdId, disposition: 'defer' }, c.snapshotUnavailable, now) : null;
  const unknown = c.snapshotUnavailable || s?.integrity.valid === false || s?.status === 'uncertain' || c.execution.kind === 'stop-uncertain';
  const hasPlan = s?.gates.some(gate => ['approve-plan', 'provider-consent'].includes(gate.type));
  const running = c.execution.kind === 'running' || c.execution.kind === 'stopping';
  const hasMaterial = Boolean(learning?.learning.finalMaterialHash || learning?.learning.stages.some(stage => stage.materialHash));
  const message = unknown ? 'Результат пока неизвестен. Сначала нужно проверить состояние.'
    : s?.schemaVersion === 3 && !learning ? 'Учебное состояние несовместимо. Проверьте сведения о запуске: продолжение из этого интерфейса недоступно.'
    : !s ? 'Начнем с поручения. Опишите задачу в Гильдии.'
    : hasPlan ? 'План готов. В Гильдии можно проверить этапы и границы работы.'
    : hold ? 'Этап проверен. Следующий этап ждет решения. Можно открыть сохраненный материал или отложить разбор.'
    : running ? 'Работа идет. Отчеты появятся по мере завершения проверок.'
    : s.status === 'failed' ? 'Проверка не завершилась успешно. Откройте причину и доступные действия.'
    : hasMaterial ? 'Сохраненные материалы доступны на карте этапов. Изучим точную версию решения?'
    : 'Сохраненного разбора пока нет. План и отчеты задачи доступны.';
  const opensLearning = !unknown && !hasPlan && Boolean(hold || hasMaterial);
  const primary = opensLearning ? onLearning : !s || hasPlan ? onPlan : onReports;
  return <section className="npc-conversation">
    <div className="npc-portrait" aria-hidden="true"><img src="/assets/rpg/mentor-idle.png" alt="" /></div>
    <CloseObject label="Закрыть разговор" onClose={onClose} />
    <h2 data-overlay-heading tabIndex={-1}>Наставник</h2>
    <p className="npc-reply">{message}</p>
    <div className="npc-choices">
      <button className="game-primary" type="button" onClick={primary}>{opensLearning ? 'Карта этапов и разбор' : !s ? 'Открыть Гильдию' : hasPlan ? 'Проверить план' : 'Ход работы и отчеты'}</button>
      {hold ? <button className="game-secondary" type="button" disabled={c.busy || Boolean(c.pending) || !deferCapability?.allowed}
        onClick={() => void c.executeLearning({ action: 'continue-learning', holdId: hold.holdId, disposition: 'defer' })}>Отложить разбор и продолжить</button>
        : s?.capabilities.stop?.allowed ? <button className="game-secondary" type="button" disabled={c.stopBusy || c.isStopping}
          onClick={() => void c.execute('stop')}>{c.stopBusy || c.isStopping ? 'Останавливаем…' : 'Остановить выполнение'}</button>
        : <button className="game-secondary" type="button" onClick={onClose}>Вернуться позже</button>}
    </div>
    {hold && !deferCapability?.allowed && <p>{deferCapability?.reason}</p>}
    <RuntimeNotices controller={c} />
  </section>;
}
