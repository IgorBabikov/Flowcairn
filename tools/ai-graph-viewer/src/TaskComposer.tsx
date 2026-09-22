import { useState } from 'react';
import type { ApiError, Capability, TaskFields } from './contracts';
import { humanText, runtimeProblem } from './presentation';
import { StatusLoader } from './StatusLoader';
import { TechnicalDetails } from './TechnicalDetails';

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
  const problem = error ? runtimeProblem(`${error.code}: ${error.message}`) : null;
  return (
    <section className="task-composer" aria-labelledby="task-heading" aria-busy={busy} onKeyDown={event => { if (event.key === 'Escape' && onClose) onClose(); }}>
      <form onSubmit={event => {
        event.preventDefault();
        if (!busy && !pending && allowed && valid)
          onSubmit({ title: title.trim(), description: description.trim(), taskNumber: taskNumber.trim() });
      }}>
        <header>
          <div>
            <h2 id="task-heading">Новая задача</h2>
            <p>Flowcairn сначала изучит проект и покажет план. Изменения начнутся только после вашего согласия.</p>
          </div>
          {onClose && <button className="button quiet" type="button" onClick={onClose}>Закрыть</button>}
        </header>
        <label htmlFor="task-title">Заголовок задачи</label>
        <input id="task-title" name="title" required maxLength={160} autoFocus
          placeholder="Кратко опишите, что нужно сделать"
          value={title} disabled={busy || pending} onChange={event => setTitle(event.target.value)} />
        <p className="field-hint">Например: «Добавить локализацию для модуля платежей».</p>
        <label htmlFor="task-description">Полное описание задачи</label>
        <textarea id="task-description" name="description" required minLength={3} maxLength={16000}
          placeholder="Опишите задачу, цели и важные детали…"
          value={description} disabled={busy || pending} onChange={event => setDescription(event.target.value)} />
        <p className="field-hint">Укажите, что нужно изменить, где находятся файлы и какие есть ограничения.</p>
        <label htmlFor="task-number">Номер задачи</label>
        <input id="task-number" name="taskNumber" required maxLength={80}
          placeholder="Например, PROJ-123"
          value={taskNumber} disabled={busy || pending} onChange={event => setTaskNumber(event.target.value)} />
        <p className="field-hint">Используйте номер из вашей системы трекинга.</p>
        {!allowed && <p role="status" className="field-error">{humanText(capability?.reason) || 'Не удалось загрузить проект. Повторите загрузку.'}</p>}
        {error && <div className="dialog-error" role="alert"><strong>{problem?.title ?? 'Не удалось подготовить задачу'}</strong><p>{(problem?.summary ?? humanText(error.message)) || 'Не удалось подготовить задачу.'}</p>
          {problem && <p>{problem.action}</p>}
          <TechnicalDetails code={error.code} message={error.message} />
          <button type="button" className="button" disabled={busy} onClick={onRetry}>{pending ? 'Повторить тот же запрос' : 'Обновить контекст'}</button>
        </div>}
        {busy && pending && <p className="intake-progress" role="status">Подготавливаем снимок проекта и граф задачи. Для большого проекта это может занять до двух минут.</p>}
        <footer>
          {onClose && <button className="button secondary" type="button" onClick={onClose}>Отмена</button>}
          <button className="button primary" type="submit" aria-label={busy ? 'Запускаем…' : 'Запустить'} disabled={busy || pending || !allowed || !valid}>
            {busy ? <StatusLoader kind="button" label="Начинаем анализ…" inline announce={false} /> : 'Начать анализ'}
          </button>
        </footer>
      </form>
    </section>
  );
}
