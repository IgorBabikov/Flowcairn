import { useId, useState, type ReactNode } from 'react';
import { CloseObject } from './GameControls';
import { WorkingObjectArt } from './WorkingObjectArt';
import { useCodexReading, type CodexNavigation } from './use-codex-reading';

/** The book receives already-bound presentation; it never reads paths or executes commands itself. */
export function LearningCodex({ title, explanation, sourcePanel, footer, notices, navigation, onClose }: {
  title: string; explanation: ReactNode; sourcePanel: ReactNode; footer: ReactNode; notices?: ReactNode;
  navigation: CodexNavigation; onClose: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [artFailed, setArtFailed] = useState(false);
  const { compact, book: bookRef, explanation: explanationRef, source: sourceRef, actions: actionsRef, page, showPage } = useCodexReading(navigation);
  const id = useId();
  const spreadExpanded = expanded && !compact;
  const selectPage = (next: 'explanation' | 'source' | 'actions') => {
    setExpanded(false);
    showPage(next);
  };
  return <section ref={bookRef} className={`learning-codex${spreadExpanded ? ' code-expanded' : ''}${artFailed ? ' art-unavailable' : ''}`}>
    <div className="codex-art-frame"><WorkingObjectArt kind="codex" onFailure={() => setArtFailed(true)} /></div>
    <div className="codex-toolbar">
      <nav className="codex-reading-nav" aria-label="Переходы по книге">
        <button className="game-text-action" type="button" aria-pressed={page === 'explanation'} aria-controls={`${id}-explanation`} onClick={() => selectPage('explanation')}>Объяснение</button>
        <button className="game-text-action" type="button" aria-pressed={page === 'source'} aria-controls={`${id}-source`} onClick={() => selectPage('source')}>Код</button>
        <button className="game-text-action" type="button" aria-pressed={page === 'actions'} aria-controls={`${id}-actions`} onClick={() => selectPage('actions')}>Продолжение</button>
      </nav>
      <CloseObject label="Закрыть книгу" onClose={onClose} />
    </div>
    <div className="codex-spread" hidden={compact && page === 'actions'}>
      <section id={`${id}-explanation`} ref={explanationRef} className="codex-page codex-explanation" aria-label="Объяснение" data-surface-body tabIndex={-1} hidden={compact ? page !== 'explanation' : spreadExpanded}>
        <h2 data-overlay-heading tabIndex={-1}>{title}</h2>{notices}{explanation}
      </section>
      <section id={`${id}-source`} ref={sourceRef} className="codex-page codex-source" aria-label="Код" data-surface-body tabIndex={-1} hidden={compact && page !== 'source'}>
        {spreadExpanded && <><h2 data-overlay-heading tabIndex={-1}>Сохраненный код</h2>{notices}</>}
        {compact && notices}
        <button className="game-text-action" type="button" hidden={compact} aria-expanded={spreadExpanded} onClick={() => {
          setExpanded(value => !value);
          showPage(spreadExpanded ? 'explanation' : 'source');
        }}>{spreadExpanded ? 'К объяснению' : 'Развернуть код'}</button>
        {sourcePanel}
      </section>
    </div>
    <footer id={`${id}-actions`} ref={actionsRef} className="codex-footer" tabIndex={-1} hidden={compact && page !== 'actions'}>{compact && notices}{footer}</footer>
  </section>;
}
