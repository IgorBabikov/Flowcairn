import { useLayoutEffect, useRef, useState } from 'react';
import { useViewportQuery } from '../use-viewport-query';

type ReadingPage = 'explanation' | 'source' | 'actions';
export type CodexNavigation = { id: number; page: 'explanation' | 'source' };

/** Local reading positions only; a page switch never sends an execution command. */
export function useCodexReading(navigation: CodexNavigation) {
  const compact = useViewportQuery('(max-width:1000px), (max-height:600px)');
  const book = useRef<HTMLElement>(null);
  const explanation = useRef<HTMLElement>(null);
  const source = useRef<HTMLElement>(null);
  const actions = useRef<HTMLElement>(null);
  const positions = useRef<Record<ReadingPage, number>>({ explanation: 0, source: 0, actions: 0 });
  const [view, setView] = useState({ navigationId: navigation.id, page: navigation.page as ReadingPage });
  const page = view.navigationId === navigation.id ? view.page : navigation.page;
  const previous = useRef({ navigationId: navigation.id, compact, page });

  const showPage = (next: ReadingPage) => {
    if (next === page) return;
    const dialog = book.current?.closest('dialog');
    if (dialog && compact) positions.current[page] = dialog.scrollTop;
    setView({ navigationId: navigation.id, page: next });
  };

  useLayoutEffect(() => {
    const dialog = book.current?.closest('dialog');
    if (!dialog) return;
    const moved = previous.current.navigationId !== navigation.id;
    const switched = previous.current.page !== page || previous.current.compact !== compact;
    const target = page === 'explanation' ? explanation.current : page === 'source' ? source.current : actions.current;

    if (moved) {
      positions.current.source = 0;
      source.current?.scrollTo({ top: 0 });
      source.current?.querySelector('.saved-code')?.scrollTo({ left: 0 });
      if (navigation.page === 'explanation') {
        positions.current.explanation = 0;
        positions.current.actions = 0;
        explanation.current?.scrollTo({ top: 0 });
      }
    }
    if (compact && (moved || switched)) dialog.scrollTo({ top: positions.current[page], behavior: 'instant' });
    if (moved || switched) {
      const heading = moved && navigation.page === 'explanation'
        ? explanation.current?.querySelector<HTMLElement>('[data-lesson-heading]') : null;
      (heading ?? target)?.focus({ preventScroll: true });
    }
    previous.current = { navigationId: navigation.id, compact, page };

    // Polling/re-renders do not reset scroll. Keep each mounted compact page's own bookmark.
    if (!compact) return;
    const remember = () => { positions.current[page] = dialog.scrollTop; };
    dialog.addEventListener('scroll', remember, { passive: true });
    return () => dialog.removeEventListener('scroll', remember);
  }, [compact, page, navigation.id, navigation.page]);

  return { compact, book, explanation, source, actions, page, showPage };
}
