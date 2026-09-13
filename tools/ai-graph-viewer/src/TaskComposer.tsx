import { useState } from 'react';
import type { ApiError, Capability } from './contracts';

/** Presentation only. The service supplies context, consent disclosure and availability. */
export interface IntakeContext {
  name: string;
  instructions: string[];
  disclosure: string;
  capability: Capability;
}

export function TaskComposer({ context, busy, pending, error, onSubmit, onRetry, onClose }: {
  context: IntakeContext | null;
  busy: boolean;
  pending: boolean;
  error: ApiError | null;
  onSubmit: (prompt: string) => void;
  onRetry: () => void;
  onClose?: (() => void) | undefined;
}) {
  const [prompt, setPrompt] = useState('');
  const allowed = context?.capability.allowed === true;
  return (
    <section className="task-composer" aria-labelledby="task-heading" aria-busy={busy} onKeyDown={(event) => { if (event.key === 'Escape' && onClose) onClose(); }}>
      <form onSubmit={(event) => {
        event.preventDefault();
        if (!busy && !pending && allowed && prompt.trim())
          onSubmit(prompt.trim());
      }}>
        <header>
          <div>
            <h2 id="task-heading">Что нужно сделать?</h2>
            <p>Опишите результат. Сначала рассмотрим план, потом разрешим изменения.</p>
          </div>
          {onClose && <button className="button quiet" type="button" onClick={onClose}>Закрыть</button>}
        </header>
        <label className="task-prompt-label" htmlFor="task-prompt">Задача</label>
        <textarea id="task-prompt" name="prompt" autoFocus required maxLength={16000}
          placeholder="Например, исправить поиск: при пустом запросе показать все результаты."
          value={prompt} disabled={busy || pending}
          onChange={(event) => setPrompt(event.target.value)}
          aria-describedby="task-boundaries" />
        <div className="intake-context">
          <strong>{context?.name ?? 'Контекст проекта недоступен'}</strong>
          {context && <details><summary>Инструкции и данные</summary>
            {context.instructions.length > 0
              ? <ul>{context.instructions.map((instruction) => <li key={instruction}>{instruction}</li>)}</ul>
              : <p>Дополнительные инструкции не указаны.</p>}
            <p>{context.disclosure}</p>
          </details>}
        </div>
        <p id="task-boundaries" className="task-boundaries">Текст задачи не дает разрешения на запись, сеть или коммит. Права будут показаны в конкретном плане.</p>
        {!allowed && <p role="status" className="field-error">{context?.capability.reason ?? 'Не удалось загрузить проект. Повторите загрузку.'}</p>}
        {error && <div className="dialog-error" role="alert"><p>{error.message}</p>
          <button type="button" className="button" disabled={busy} onClick={onRetry}>{pending ? 'Повторить тот же запрос' : 'Обновить контекст'}</button>
        </div>}
        <footer>
          <span role="status">{busy ? 'Готовим задачу…' : 'Изменения начнутся после вашего решения.'}</span>
          <button className="button primary" type="submit" disabled={busy || pending || !allowed || !prompt.trim()}>
            {busy ? 'Готовим задачу…' : 'Составить план'}
          </button>
        </footer>
      </form>
    </section>
  );
}
