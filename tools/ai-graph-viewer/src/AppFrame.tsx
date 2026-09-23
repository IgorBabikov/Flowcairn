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
      <div className="shell-summary-skeleton" aria-hidden="true">
        <span className="shell-avatar-skeleton" />
        <span className="shell-title-skeleton" />
      </div>
      <div className="shell-loading-focus">
        <span className="brand-mark loading-brand-mark" aria-hidden="true"><i /><i /><i /></span>
        <StatusLoader kind="stage" label="Загружаем данные Flowcairn. Проверяем состояние и доступные действия…" />
        <span className="shell-loading-track" aria-hidden="true"><i /></span>
      </div>
      <div className="shell-list-skeleton" aria-hidden="true">
        <div className="shell-card-skeleton" />
        <div className="shell-card-skeleton" />
        <div className="shell-card-skeleton short" />
      </div>
    </section>
  );
}

export function Brand({ title = 'flowcairn', subtitle = 'От задачи до проверенного результата.' }: { title?: string; subtitle?: string }) {
  return <div className="brand"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
    <div><h1>{title}</h1><p>{subtitle}</p></div></div>;
}

export function InitialLoadingFrame({ label, wide = false }: { label: string; wide?: boolean }) {
  return (
    <AppFrame className={wide ? 'wide-workspace wide-loading' : ''}>
      <header className="topbar">
        {wide ? <div className="wide-surface-heading"><h2>Загружаем проект</h2></div> : <><Brand />
        <div className="project-status-trigger" aria-hidden="true">
          <span className="project-name">Загружаем проект</span>
          <span className="project-status-caption"><span>Состояние проекта</span><strong>Проверяем доступность</strong></span>
        </div></>}
        <div className="topbar-actions loading-actions" aria-hidden="true">
          <span /><span /><span />
        </div>
      </header>
      <section className="operator-layout composing loading-layout" aria-label={label}>
        <aside className="run-rail" data-testid="run-rail">
          {wide && <div className="wide-project-heading"><Brand /><p>Проверяем состояние проекта…</p></div>}
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
