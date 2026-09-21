import { useState } from 'react';

export function CollapsibleText({
  id,
  text,
  maxLength = 360,
}: {
  id: string;
  text: string;
  maxLength?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const collapsible = text.length > maxLength;
  return (
    <div className="collapsible-text">
      <p id={id} className={collapsible && !expanded ? 'clamped' : undefined}>{text}</p>
      {collapsible && (
        <button
          type="button"
          className="text-action"
          aria-controls={id}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? 'Свернуть' : 'Показать полностью'}
        </button>
      )}
    </div>
  );
}
