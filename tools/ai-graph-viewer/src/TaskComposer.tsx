import { useState } from 'react';
import type { ApiError, Capability, BootstrapContext, IntakeOptions } from './contracts';

/** Presentation only. The service supplies context, consent disclosure and availability. */
export interface IntakeContext {
  name: string;
  instructions: string[];
  disclosure: string;
  checks: string[];
  scopeCandidates: string[];
  bootstrap?: BootstrapContext | undefined;
  capability: Capability;
}

export function TaskComposer({ context, busy, pending, error, onSubmit, onRetry, onClose }: {
  context: IntakeContext | null;
  busy: boolean;
  pending: boolean;
  error: ApiError | null;
  onSubmit: (prompt: string, options: IntakeOptions) => void;
  onRetry: () => void;
  onClose?: (() => void) | undefined;
}) {
  const [prompt, setPrompt] = useState('');
  const allowed = context?.capability.allowed === true;
  const [snapshotConsent, setSnapshotConsent] = useState<string | null>(null);
  const [selectedUntracked, setSelectedUntracked] = useState<string[]>([]);
  const bootstrap = context?.bootstrap;
  const snapshotConfirmed = !bootstrap?.required || snapshotConsent === bootstrap.snapshotHash;
  const untracked = selectedUntracked.filter(path => bootstrap?.untrackedCandidates.includes(path));
  const [selectedScope, setSelectedScope] = useState<string[] | null>(null);
  const candidates = context?.scopeCandidates ?? [];
  const needsNarrowScope = candidates.length > 32;
  const scope = selectedScope?.filter(path => candidates.includes(path)) ?? (needsNarrowScope ? [] : candidates);
  const scopeValid = !candidates.length || (scope.length > 0 && scope.length <= 32);
  return (
    <section className="task-composer" aria-labelledby="task-heading" aria-busy={busy} onKeyDown={(event) => { if (event.key === 'Escape' && onClose) onClose(); }}>
      <form onSubmit={(event) => {
        event.preventDefault();
        if (!busy && !pending && allowed && prompt.trim() && scopeValid && snapshotConfirmed)
          onSubmit(prompt.trim(), {
            ...(selectedScope !== null || needsNarrowScope ? { scope } : {}),
            ...(bootstrap?.required ? { snapshot: true, snapshotHash: bootstrap.snapshotHash, includeUntracked: untracked } : {}),
          });
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
            <p>Настроенные проверки: {context.checks.length ? context.checks.join(', ') : 'не указаны'}.</p>
            <p>{context.disclosure}</p>
          </details>}
        </div>
        {candidates.length > 0 && <details className="scope-picker">
          <summary>Области задачи · {scope.length} из {candidates.length}</summary>
          <p>Выберите до 32 областей для планирования. Разрешение на запись подтвердите отдельно.</p>
          <div className="scope-options">{candidates.map(path => <label className="confirmation" key={path}>
            <input type="checkbox" checked={scope.includes(path)} disabled={busy || pending || (!scope.includes(path) && scope.length >= 32)}
              onChange={event => setSelectedScope(event.target.checked ? [...scope, path] : scope.filter(item => item !== path))} />
            <span>{path}</span>
          </label>)}</div>
        </details>}
        {!scopeValid && <p role="status">Выберите области задачи: от 1 до 32.</p>}
        {bootstrap?.required && <section className="bootstrap-context" aria-label="Исходный снимок">
          <details>
            <summary>Изменения перед началом работы</summary>
            {bootstrap.changedPaths.length > 0 && <ul>{bootstrap.changedPaths.map(path => <li key={path}>{path}</li>)}</ul>}
            {bootstrap.untrackedCandidates.length > 0 && <>
              <p>Новые файлы: выберите только те, которые относятся к задаче.</p>
              <div className="scope-options">{bootstrap.untrackedCandidates.map(path => <label className="confirmation" key={path}>
                <input type="checkbox" checked={untracked.includes(path)} disabled={busy || pending}
                  onChange={event => { setSelectedUntracked(event.target.checked ? [...untracked, path] : untracked.filter(item => item !== path)); setSnapshotConsent(null); }} />
                <span>{path}</span>
              </label>)}</div>
            </>}
          <label className="confirmation">
            <input type="checkbox" checked={snapshotConfirmed} disabled={busy || pending}
              onChange={event => setSnapshotConsent(event.target.checked ? bootstrap.snapshotHash : null)} />
            <span>Включить перечисленные изменения в исходный снимок</span>
          </label>
          <p>Сохраняем локальный снимок. Передача его данных AI потребует отдельного решения.</p>
          </details>
        </section>}
        <p id="task-boundaries" className="task-boundaries">Текст задачи не дает разрешения на запись, сеть или коммит. Права будут показаны в конкретном плане.</p>
        {!allowed && <p role="status" className="field-error">{context?.capability.reason ?? 'Не удалось загрузить проект. Повторите загрузку.'}</p>}
        {error && <div className="dialog-error" role="alert"><p>{error.message}</p>
          <button type="button" className="button" disabled={busy} onClick={onRetry}>{pending ? 'Повторить тот же запрос' : 'Обновить контекст'}</button>
        </div>}
        <footer>
          <span role="status">{busy ? 'Готовим задачу…' : 'Изменения начнутся после вашего решения.'}</span>
          <button className="button primary" type="submit" disabled={busy || pending || !allowed || !prompt.trim() || !scopeValid || !snapshotConfirmed}>
            {busy ? 'Готовим задачу…' : 'Составить план'}
          </button>
        </footer>
      </form>
    </section>
  );
}
