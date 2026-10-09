import type { ReactNode } from 'react';

export function CloseObject({ onClose, label = 'Закрыть', disabled = false }: { onClose: () => void; label?: string; disabled?: boolean }) {
  return <button className="game-close" type="button" aria-label={label} disabled={disabled} onClick={onClose}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
  </button>;
}
export function GameIcon({ kind }: { kind: 'book' | 'map' | 'settings' | 'cairn' }) {
  const shapes: Record<typeof kind, ReactNode> = {
    book: <path d="m3 5 12 2 12-2v20l-12 2-12-2Zm12 2v20M7 11l4 1m8 0 4-1M7 16l4 1m8 0 4-1" />,
    map: <><circle cx="15" cy="15" r="11" /><path d="m10 20 3-8 8-3-3 9Zm5-19v5m0 20v5M1 15h5m20 0h5" /></>,
    settings: <><circle cx="15" cy="15" r="8" /><circle cx="15" cy="15" r="3" /><path d="M15 1v5m0 18v5M1 15h5m18 0h5M5 5l4 4m12 12 4 4M5 25l4-4M21 9l4-4" /></>,
    cairn: <path d="m3 22 12-4 12 4-12 5ZM6 15l9-3 9 3-9 4Zm5-9 5-2 5 3-5 3ZM3 22v4l12 4 12-4v-4M6 15v4m18-4v4M11 6v4l5 3 5-3V7" />,
  };
  return <svg viewBox="0 0 30 32" fill="none" aria-hidden="true">{shapes[kind]}</svg>;
}
