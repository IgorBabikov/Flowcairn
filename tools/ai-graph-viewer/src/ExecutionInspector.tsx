import type { ReactNode } from 'react';
import { ModalSurface } from './ModalSurface';
import { COPY, type Locale } from './ui-copy';

export type InspectorTab = 'overview' | 'evidence' | 'history' | 'plan';

/** Selection belongs to the graph; opening this surface is a separate user choice. */
export function ExecutionInspector({ compact, autonomous, tab, onTab, onClose, locale, children }: {
  compact: boolean;
  autonomous: boolean;
  tab: InspectorTab;
  onTab: (tab: InspectorTab) => void;
  onClose: () => void;
  locale: Locale;
  children: ReactNode;
}) {
  const tabs: InspectorTab[] = autonomous ? ['overview', 'evidence', 'history'] : ['overview', 'evidence', 'history', 'plan'];
  const activeTab = tabs.includes(tab) ? tab : 'overview';
  const title = locale === 'ru' ? 'Детали исполнения' : 'Execution details';
  const body = <>
    <header className="inspector-heading"><h2>{title}</h2>
      <button className="button quiet detail-close" type="button" onClick={onClose}>
        {locale === 'ru' ? 'Закрыть детали' : 'Close details'}
      </button>
    </header>
    <div className="detail-tabs" role="tablist" aria-label={title}>
      {tabs.map((name, index) => <button key={name} id={`inspector-tab-${name}`} role="tab"
        type="button" aria-selected={activeTab === name} aria-controls="inspector-content"
        tabIndex={activeTab === name ? 0 : -1} className={activeTab === name ? 'active' : ''}
        onClick={() => onTab(name)} onKeyDown={event => {
          const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
            : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
            : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
          if (next === null) return;
          event.preventDefault();
          const nextTab = tabs[next]!;
          onTab(nextTab);
          document.getElementById(`inspector-tab-${nextTab}`)?.focus();
        }}>
        {name === 'history' ? locale === 'ru' ? 'История' : 'History' : COPY[locale][name]}
      </button>)}
    </div>
    <div className="detail-scroll" id="inspector-content" role="tabpanel" aria-labelledby={`inspector-tab-${activeTab}`} tabIndex={0}>
      {children}
    </div>
  </>;
  return compact
    ? <ModalSurface title={title} onClose={onClose} className="detail-panel inspector-dialog">{body}</ModalSurface>
    : <aside className="detail-panel" aria-label={title}>{body}</aside>;
}
