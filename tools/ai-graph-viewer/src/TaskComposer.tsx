import { useState } from 'react';
import type { ApiError, Capability, TaskFields } from './contracts';

/** Форма передает задачу; настройки и права определяет сервис. */
export function TaskComposer({ capability, busy, pending, error, onSubmit, onRetry, onClose }: {
  capability: Capability | null;
  busy: boolean;
  pending: boolean;
  error: ApiError | null;
  onSubmit: (fields: TaskFields) => void;
  onRetry: () => void;
  onClose?: (() => void) | undefined;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [taskNumber, setTaskNumber] = useState('');
  const valid = title.trim().length > 0 && description.trim().length >= 3 && taskNumber.trim().length > 0;
  const allowed = capability?.allowed === true;
  return (
    <section className="task-composer" aria-labelledby="task-heading" aria-busy={busy} onKeyDown={event => { if (event.key === 'Escape' && onClose) onClose(); }}>
      <form onSubmit={event => {
        event.preventDefault();
        if (!busy && !pending && allowed && valid)
          onSubmit({ title: title.trim(), description: description.trim(), taskNumber: taskNumber.trim() });
      }}>
        <header>
          <h2 id="task-heading">Новая задача</h2>
          {onClose && <button className="button quiet" type="button" onClick={onClose}>Закрыть</button>}
        </header>
        <label htmlFor="task-title">Заголовок задачи</label>
        <input id="task-title" name="title" required maxLength={160} autoFocus
          value={title} disabled={busy || pending} onChange={event => setTitle(event.target.value)} />
        <label htmlFor="task-description">Полное описание задачи</label>
        <textarea id="task-description" name="description" required minLength={3} maxLength={16000}
          value={description} disabled={busy || pending} onChange={event => setDescription(event.target.value)} />
        <label htmlFor="task-number">Номер задачи</label>
        <input id="task-number" name="taskNumber" required maxLength={80}
          value={taskNumber} disabled={busy || pending} onChange={event => setTaskNumber(event.target.value)} />
        {!allowed && <p role="status" className="field-error">{capability?.reason ?? 'Не удалось загрузить проект. Повторите загрузку.'}</p>}
        {error && <div className="dialog-error" role="alert"><p>{error.message}</p>
          <button type="button" className="button" disabled={busy} onClick={onRetry}>{pending ? 'Повторить тот же запрос' : 'Обновить контекст'}</button>
        </div>}
        <footer>
          <button className="button primary" type="submit" disabled={busy || pending || !allowed || !valid}>
            {busy ? 'Запускаем…' : 'Запустить'}
          </button>
        </footer>
      </form>
    </section>
  );
}
