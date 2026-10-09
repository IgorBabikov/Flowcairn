import { useEffect, useState } from 'react';
import type { WorkflowController } from '../workflow-controller-types';
import { learningCommandCapability } from './learning-commands';
import { learningRun } from './learning-projection';

export function useDecisionTime(expiresAt: number | null | undefined) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (expiresAt == null) return;
    const timeout = window.setTimeout(() => setNow(Date.now()), Math.max(0, Math.min(2147483647, expiresAt - Date.now() + 10)));
    return () => window.clearTimeout(timeout);
  }, [expiresAt]);
  return now;
}
export function LearningControls({ controller: c, materialBinding, compact = false }: {
  controller: WorkflowController; compact?: boolean; materialBinding?: { runId: string; materialHash: string };
}) {
  const run = learningRun(c.snapshot);
  const now = useDecisionTime(run?.approvalExpiresAt);
  if (!run) return <p>Этот запуск не предоставляет учебные команды.</p>;
  const pending = c.busy || Boolean(c.pending);
  const hold = run.continuation.kind === 'learning-hold' ? run.continuation : null;
  const modeIntent = { action: 'set-learning-mode' as const, mode: run.learning.mode };
  const modeCapability = learningCommandCapability(run, modeIntent, c.snapshotUnavailable, now);
  const historical = Boolean(materialBinding && (materialBinding.runId !== run.runId || hold?.materialHash !== materialBinding.materialHash));
  const continueCapability = hold ? learningCommandCapability(run, { action: 'continue-learning', holdId: hold.holdId, disposition: 'continue' }, c.snapshotUnavailable, now) : null;
  const continueReason = historical ? 'Открыт другой материал. Продолжение доступно у текущей учебной паузы.' : continueCapability?.reason;
  return <section className="learning-controls" aria-label="Продолжение работы">
    {hold && <>{!compact && <p className="learning-hold-label">Учебная пауза. Следующий этап ждет решения.</p>}
      <div className="learning-continue-actions"><button className="game-primary" type="button"
        disabled={pending || historical || !continueCapability?.allowed} aria-describedby="learning-continue-reason"
        onClick={() => void c.executeLearning({ action: 'continue-learning', holdId: hold.holdId, disposition: 'continue' })}>Продолжить работу</button>
        <button className="game-secondary" type="button" disabled={pending || historical || !continueCapability?.allowed}
          onClick={() => void c.executeLearning({ action: 'continue-learning', holdId: hold.holdId, disposition: 'defer' })}>Отложить разбор и продолжить</button></div>
      <p id="learning-continue-reason">{continueReason || (pending ? 'Уточняем результат команды…' : 'Закрытие книги и чтение не продолжают работу.')}</p>
    </>}
    {!compact && <><label className="learning-mode-field">Учебный режим
      <select value={run.learning.mode} disabled={pending || !modeCapability.allowed || Boolean(materialBinding && materialBinding.runId !== run.runId)}
        onChange={event => { const mode = event.target.value; if (mode === 'after-stage' || mode === 'after-task') void c.executeLearning({ action: 'set-learning-mode', mode }); }}>
        <option value="after-stage">По этапам</option><option value="after-task">После всей задачи</option>
      </select>
    </label>
    <p>{modeCapability.allowed ? 'Изменение режима действует на будущие этапы и само не снимает текущую паузу.' : modeCapability.reason}</p></>}
    {compact && !hold && <p>Чтение не меняет состояние выполнения.</p>}
    {pending && <p role="status">Предыдущая команда еще не подтверждена. При потере ответа повторяйте тот же запрос через сообщение об ошибке.</p>}
  </section>;
}
