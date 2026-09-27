import { useState } from 'react';
import { ReadableText } from './ReadableText';

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
      <div id={id} className={collapsible && !expanded ? 'clamped' : undefined}><ReadableText text={text} /></div>
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
