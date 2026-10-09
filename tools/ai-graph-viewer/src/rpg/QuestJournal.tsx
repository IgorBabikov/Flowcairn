import { useState } from 'react';
import type { WorkflowController } from '../workflow-controller-types';
import { statusLabel } from '../ui-copy';
import { CloseObject } from './GameControls';
import { WorkingObjectArt } from './WorkingObjectArt';
import { RuntimeNotices } from './RuntimeNotices';

export function QuestJournal({ controller: c, onClose, onOpen, onNew }: {
  controller: WorkflowController; onClose: () => void; onOpen: (id: string) => void; onNew: () => void;
}) {
  const [selectedId, setSelectedId] = useState(c.selectedRunId);
  const [artFailed, setArtFailed] = useState(false);
  const selected = c.visibleRuns.find(run => run.runId === selectedId) ?? c.visibleRuns.find(run => run.runId === c.selectedRunId) ?? c.visibleRuns[0];
  const status = selected ? !selected.integrity.valid ? 'Состояние недоступно' : selected.runId === c.snapshot?.runId && c.snapshotUnavailable ? 'Актуальность не подтверждена' : statusLabel(selected.status, 'ru', selected.resolutionKind) : '';
  return <section className={`quest-journal${artFailed ? ' art-unavailable' : ''}`}>
    <WorkingObjectArt kind="codex" onFailure={() => setArtFailed(true)} />
    <CloseObject label="Закрыть журнал" onClose={onClose} />
    <div className="journal-page journal-list" data-surface-body>
      <h2 data-overlay-heading tabIndex={-1}>Журнал поручений</h2>
      <RuntimeNotices controller={c} />
      {c.loading && !c.visibleRuns.length ? <p role="status">Загружаем поручения…</p>
        : !c.visibleRuns.length ? <p>Здесь появятся ваши поручения.</p>
        : <ul>{c.visibleRuns.map(run => <li key={run.runId}><button type="button" className="journal-entry" aria-pressed={selected?.runId === run.runId} onClick={() => setSelectedId(run.runId)}>
          <strong>{run.task?.title || run.task?.goal || run.runId}</strong>
          <span>{run.task?.taskNumber || run.task?.id} · {statusLabel(run.status, 'ru', run.resolutionKind)}</span>
        </button></li>)}</ul>}
      <button className="game-text-action" type="button" onClick={() => void c.refreshRuns()}>Обновить журнал</button>
    </div>
    <div className="journal-page journal-detail" data-surface-body>
      {selected ? <>
        <h3>{selected.task?.title || selected.task?.goal || 'Поручение'}</h3>
        <p>{status}</p>
        <p>Версия плана: {selected.planVersion ?? 'не подготовлена'}</p>
        {selected.integrity.reason && <p>{selected.integrity.reason}</p>}
        <button className="game-primary" type="button" onClick={() => onOpen(selected.runId)}>Открыть поручение</button>
      </> : <button className="game-primary" type="button" disabled={!c.project?.capabilities.intake.allowed} onClick={onNew}>Создать поручение</button>}
      {selected && <button className="game-text-action" type="button" disabled={!c.project?.capabilities.intake.allowed} onClick={onNew}>Новое поручение</button>}
      {c.snapshot?.capabilities.stop?.allowed && <button className="game-text-action" type="button" disabled={c.stopBusy || c.isStopping} onClick={() => void c.execute('stop')}>{c.stopBusy || c.isStopping ? 'Останавливаем…' : 'Остановить текущую работу'}</button>}
    </div>
  </section>;
}
