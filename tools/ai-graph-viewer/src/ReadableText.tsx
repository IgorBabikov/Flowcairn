import type { ReactNode } from 'react';

function inlineContent(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={index}>{part.slice(1, -1)}</code>;
    return part;
  });
}

function paragraphs(text: string): string[] {
  return text.split(/\n\s*\n/).flatMap(block => {
    if (block.length < 320) return [block];
    const sentences = [...new Intl.Segmenter('ru', { granularity: 'sentence' }).segment(block)].map(item => item.segment.trim()).filter(Boolean);
    const result: string[] = [];
    let paragraph = '';
    for (const sentence of sentences) {
      if (paragraph && paragraph.length + sentence.length > 280) {
        result.push(paragraph);
        paragraph = sentence;
      } else {
        paragraph = paragraph ? `${paragraph} ${sentence}` : sentence;
      }
    }
    if (paragraph) result.push(paragraph);
    return result;
  }).filter(Boolean);
}

export function ReadableText({ text, className = '' }: { text: string; className?: string }) {
  return <div className={`readable-text ${className}`}>
    {paragraphs(text).map((paragraph, index) => <p key={index}>{inlineContent(paragraph)}</p>)}
  </div>;
}
