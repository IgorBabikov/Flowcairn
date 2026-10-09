import type { LearningSourceResponse, SourceAnchor } from '../contracts';

/** Keep the immutable quote intact while requesting a bounded window around it. */
export function sourceSelectionForAnchor(anchor: SourceAnchor) {
  const startLine = Math.max(1, anchor.startLine - 12);
  const lineCount = Math.min(200, Math.max(100, anchor.endLine - startLine + 1 + 12));
  return { sourceId: anchor.sourceId, startLine, lineCount, anchor };
}

export function anchorPageMatch(page: LearningSourceResponse, anchor: SourceAnchor | null) {
  if (!anchor || page.sourceId !== anchor.sourceId || page.fileHash !== anchor.fileHash) return null;
  const start = Math.max(page.startLine, anchor.startLine), end = Math.min(page.endLine, anchor.endLine);
  if (start > end) return null;
  const actual = page.text.split('\n').slice(start - page.startLine, end - page.startLine + 1).join('\n');
  const expected = anchor.quote.replace(/\r\n/g, '\n').split('\n').slice(start - anchor.startLine, end - anchor.startLine + 1).join('\n');
  return { matches: actual === expected, complete: start === anchor.startLine && end === anchor.endLine, start, end };
}
export const sourceRoleLabels = { before: 'До изменений', after: 'После изменений', context: 'Неизмененный контекст' };
