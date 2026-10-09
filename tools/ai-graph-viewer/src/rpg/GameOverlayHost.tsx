import { useEffect, useRef, type ReactNode } from 'react';

export type GameSurface = 'conversation' | 'quest' | 'journal' | 'travel' | 'settings' | 'codex' | 'learning-map' | 'diagnostics';

/** One modal lifecycle; suspension for an existing service dialog preserves its trigger. */
export function GameOverlayHost({ surface, suspended, title, onClose, children }: {
  surface: GameSurface | null; suspended: boolean; title: string; onClose: () => void; children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const lastFocus = useRef<HTMLElement | null>(null);
  const resumeFocus = useRef<HTMLElement | null>(null);
  const lastView = useRef<string | null>(null);
  const opened = useRef(false);
  const present = Boolean(surface);
  const open = present && !suspended;
  useEffect(() => {
    if (present && !opened.current) {
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      opened.current = true;
    } else if (!present && opened.current) {
      opened.current = false;
      lastView.current = null;
      lastFocus.current = null;
      if (returnFocus.current?.isConnected) returnFocus.current.focus();
      else document.getElementById('game-map-button')?.focus();
    }
  }, [present]);
  useEffect(() => {
    const element = dialog.current;
    if (!element || !open) return;
    const remembered = lastFocus.current;
    element.showModal();
    resumeFocus.current = remembered;
    return () => element.close();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const view = `${surface}:${title}`;
    const previous = resumeFocus.current;
    if (lastView.current === view && previous?.isConnected && dialog.current?.contains(previous)) previous.focus();
    else {
      dialog.current?.scrollTo({ top: 0 });
      dialog.current?.querySelectorAll('[data-surface-body]').forEach(element => element.scrollTo({ top: 0 }));
      dialog.current?.querySelector<HTMLElement>('[data-overlay-heading]')?.focus();
    }
    lastView.current = view;
    resumeFocus.current = null;
  }, [open, surface, title]);
  return <dialog ref={dialog} className={`game-overlay game-overlay--${surface ?? 'closed'}`}
    aria-label={title} onFocusCapture={event => { if (event.target instanceof HTMLElement) lastFocus.current = event.target; }}
    onCancel={event => { event.preventDefault(); onClose(); }}>
    {children}
  </dialog>;
}
