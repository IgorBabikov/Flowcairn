import type { ReactNode } from 'react';
import { StatusLoader } from './StatusLoader';

export function AppFrame({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <main className={`app-shell${className ? ` ${className}` : ''}`} data-testid="app-frame">
      {children}
    </main>
  );
}

export function ShellSkeleton() {
  return (
    <section className="shell-skeleton" aria-busy="true" data-testid="main-content">
      <StatusLoader kind="stage" label="Загружаем данные Flowcairn" />
      <div className="shell-title-skeleton" aria-hidden="true" />
      <div className="shell-card-skeleton" aria-hidden="true" />
      <div className="shell-card-skeleton short" aria-hidden="true" />
    </section>
  );
}

export function InitialLoadingFrame({ label }: { label: string }) {
  return (
    <AppFrame>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <div><h1>flowcairn</h1><p>От задачи до проверенного результата.</p></div>
        </div>
        <div className="topbar-actions loading-actions" aria-hidden="true">
          <span /><span /><span />
        </div>
      </header>
      <nav className="task-view-switch" aria-label="Представление задачи">
        <button type="button" aria-pressed="true" disabled>Задача</button>
        <button type="button" aria-pressed="false" disabled>Граф · детали исполнения</button>
      </nav>
      <section className="operator-layout composing loading-layout" aria-label={label}>
        <aside className="run-rail" data-testid="run-rail">
          <div className="rail-heading"><h2>Запуски</h2></div>
          <div className="run-list shell-run-list" aria-hidden="true">
            <i /><i /><i />
          </div>
        </aside>
        <ShellSkeleton />
      </section>
    </AppFrame>
  );
}
