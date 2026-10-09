import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CloseObject } from './GameControls';
import { WorkingObjectArt } from './WorkingObjectArt';

export function QuestScroll({ title, onClose, children, footer, closeDisabled = false }: {
  title: string; onClose: () => void; children: ReactNode; footer: ReactNode; closeDisabled?: boolean;
}) {
  const [artFailed, setArtFailed] = useState(false);
  const object = useRef<HTMLElement>(null);
  const actions = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = actions.current;
    if (!element) return;
    const resize = new ResizeObserver(() => object.current?.style.setProperty('--scroll-footer-height', `${element.getBoundingClientRect().height}px`));
    resize.observe(element);
    return () => resize.disconnect();
  }, []);
  return <section ref={object} className={`quest-scroll${artFailed ? ' art-unavailable' : ''}`}>
    <WorkingObjectArt kind="scroll" onFailure={() => setArtFailed(true)} />
    <header className="quest-scroll-heading"><h2 data-overlay-heading tabIndex={-1}>{title}</h2></header>
    <CloseObject label="Закрыть свиток" onClose={onClose} disabled={closeDisabled} />
    <div className="quest-scroll-body" data-surface-body>{children}</div>
    <footer ref={actions} className="quest-scroll-footer">{footer}</footer>
  </section>;
}
