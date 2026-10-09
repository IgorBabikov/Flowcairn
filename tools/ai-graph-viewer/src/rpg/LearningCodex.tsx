import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CloseObject } from './GameControls';
import { WorkingObjectArt } from './WorkingObjectArt';

/** The book receives already-bound presentation; it never reads paths or executes commands itself. */
export function LearningCodex({ title, explanation, sourcePanel, footer, notices, onClose }: {
  title: string; explanation: ReactNode; sourcePanel: ReactNode; footer: ReactNode; notices?: ReactNode; onClose: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [artFailed, setArtFailed] = useState(false);
  const book = useRef<HTMLElement>(null);
  const actions = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!actions.current) return;
    const observer = new ResizeObserver(() => book.current?.style.setProperty('--codex-footer-height', `${actions.current?.getBoundingClientRect().height ?? 44}px`));
    observer.observe(actions.current);
    return () => observer.disconnect();
  }, []);
  return <section ref={book} className={`learning-codex${expanded ? ' code-expanded' : ''}${artFailed ? ' art-unavailable' : ''}`}>
    <WorkingObjectArt kind="codex" onFailure={() => setArtFailed(true)} />
    <CloseObject label="Закрыть книгу" onClose={onClose} />
    <div className="codex-page codex-explanation" data-surface-body hidden={expanded}><h2 data-overlay-heading tabIndex={-1}>{title}</h2>{notices}{explanation}</div>
    <div className="codex-page codex-source" data-surface-body>
      {expanded && <><h2 data-overlay-heading tabIndex={-1}>Сохраненный код</h2>{notices}</>}
      <button className="game-text-action" type="button" onClick={() => setExpanded(value => !value)}>{expanded ? 'К объяснению' : 'Развернуть код'}</button>
      {sourcePanel}
    </div>
    <footer ref={actions} className="codex-footer">{footer}</footer>
  </section>;
}
