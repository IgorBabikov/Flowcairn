import { verifiedSourceText } from './learning-source-storage.mjs';
import { GraphError } from './io.mjs';
import { LearningSourceResponseSchema } from './learning-schemas.mjs';

const PAGE_BYTES = 64 * 1024;
const fail = () => { throw new GraphError('LEARNING_PAGE_INVALID', 'Неверные границы страницы исходника.'); };
const fit = (text, bytes) => {
  const buffer = Buffer.from(text); let end = Math.min(bytes, buffer.length);
  while (end < buffer.length && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString('utf8');
};

/** Retain only the requested page; still exhaust every chunk for integrity and
 * secret checks. Large lines continue by UTF-16 column on a UTF-8-safe boundary.
 * Normal whole-line responses retain their existing representation.
 */
export function savedLearningSourcePage(store, source, options = {}) {
  return sourceTextPage(source, verifiedSourceText(store, source), options);
}

export function sourceTextPage(source, chunks, { startLine = 1, lineCount = 100, startColumn = 0 } = {}, { maximumLines = 200 } = {}) {
  if (!Number.isSafeInteger(startLine) || startLine < 1 || startLine > Math.max(1, source.lineCount)
    || !Number.isSafeInteger(lineCount) || lineCount < 1 || lineCount > maximumLines
    || !Number.isSafeInteger(startColumn) || startColumn < 0) fail();
  const lines = [];
  let line = 1, column = 0, selectedBytes = 0, current = '', cut = false, stopped = false;
  let partial = /** @type {{ startColumn: number, endColumn: number }|null} */ (null);
  let pendingCR = '', requestedSeen = false;
  const fragment = (text) => {
    if (line < startLine || stopped) { column += text.length; return; }
    requestedSeen = true;
    let from = line === startLine ? Math.max(0, startColumn - column) : 0;
    if (from < text.length && from > 0 && /[\uDC00-\uDFFF]/u.test(text[from])) fail();
    from = Math.min(from, text.length);
    const value = text.slice(from); column += text.length;
    if (cut) return;
    const budget = PAGE_BYTES - selectedBytes - Buffer.byteLength(current) - (lines.length ? 1 : 0);
    if (budget < 0) { cut = true; stopped = true; current = ''; return; }
    const part = fit(value, Math.max(0, budget)); current += part;
    if (part.length !== value.length) {
      cut = true;
      if (lines.length) { stopped = true; current = ''; }
      else partial = { startColumn, endColumn: startColumn + current.length };
    }
  };
  const endLine = () => {
    if (line >= startLine && !stopped) {
      if (line === startLine && startColumn > column) fail();
      if (partial) { /* Keep the first partial line; next resumes its exact column. */ }
      else { selectedBytes += Buffer.byteLength(current) + (lines.length ? 1 : 0); lines.push(current); }
      current = '';
      if (partial || lines.length >= lineCount) stopped = true;
    }
    line++; column = 0;
  };
  for (const chunk of chunks) {
    let text = pendingCR + chunk; pendingCR = '';
    if (text.endsWith('\r')) { pendingCR = '\r'; text = text.slice(0, -1); }
    const segments = text.split('\n');
    for (let index = 0; index < segments.length; index++) {
      const complete = index < segments.length - 1;
      const segment = complete && segments[index].endsWith('\r') ? segments[index].slice(0, -1) : segments[index];
      fragment(segment);
      if (complete) {
        if (partial && lines.length === 0) lines.push(current);
        endLine();
      }
    }
  }
  if (pendingCR) fragment(pendingCR);
  if (source.lineCount === 0) return LearningSourceResponseSchema.parse({ sourceId: source.id, fileHash: source.fileHash,
    text: '', startLine, endLine: 0, totalLines: 0, next: null });
  if (!requestedSeen || line === startLine && startColumn > column) fail();
  if (partial && !lines.length) lines.push(current);
  if (!partial && !stopped) endLine();
  const end = startLine + lines.length - 1;
  const portion = /** @type {{ startColumn: number, endColumn: number }|null} */ (partial);
  const next = portion ? { startLine, lineCount: Math.min(200, lineCount), startColumn: portion.endColumn }
    : end < source.lineCount ? { startLine: end + 1, lineCount: Math.min(200, lineCount) } : null;
  if (portion && portion.endColumn === portion.startColumn) fail();
  return LearningSourceResponseSchema.parse({ sourceId: source.id, fileHash: source.fileHash,
    text: lines.join('\n'), startLine, endLine: end, totalLines: source.lineCount, next,
    ...(startColumn || portion ? { startColumn, endColumn: portion?.endColumn ?? startColumn + (lines[0]?.length ?? 0), partial: Boolean(portion) } : {}) });
}
