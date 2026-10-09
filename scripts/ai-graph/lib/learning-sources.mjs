import { closeSync, openSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { lstatHostSync as lstatSync, fstatHostSync as fstatSync, crossStatIdentity, noFollowReadFlags, sameHostPath } from './host-filesystem.mjs';
import { GraphError, hashObject, sha256 } from './io.mjs';
import { classifySource, normalizeSourcePath, assertSafeText } from './source-policy.mjs';
import { Hash, RelativePath } from './schema-primitives.mjs';
import { MaterialGapSchema, SourceCatalogSchema, SourceChunkSchema, SourceAnchorSchema, LearningSourceResponseSchema } from './learning-schemas.mjs';

/** @typedef {import('zod').infer<typeof SourceCatalogSchema>} SourceCatalog */
/** @typedef {import('zod').infer<typeof MaterialGapSchema>} MaterialGap */
/** @typedef {{ denyGlobs?: string[], forbiddenPaths?: string[], outputPaths?: string[] }} SourcePolicy */
/** @typedef {{sourceHash: string, sourceCatalogHash: string, gaps: MaterialGap[]}} SourceCapture */
/** @typedef {{path: string, role: 'before'|'after'|'context', expected: {hash: string, size: number, mode: '100644'|'100755'}|null}} SelectedSource */

export const LEARNING_SOURCE_LIMITS = Object.freeze({ sources: 64, fileBytes: 256 * 1024, totalBytes: 2 * 1024 * 1024,
  chunkBytes: 16 * 1024, pageBytes: 64 * 1024, pageLines: 200, quoteBytes: 8 * 1024 });
/** @returns {never} */
const fail = (code, message) => { throw new GraphError(code, message); };

function safePath(value) {
  if (!RelativePath.safeParse(value).success || Buffer.from(value, 'utf8').toString('utf8') !== value) return false;
  return !value.normalize('NFKC').split('/').some((part) => !part || part === '.' || part === '..'
    || [...part].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || /[\\:]/u.test(part) || /[. ]$/.test(part)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

/** Policy is supplied by the trusted host on every read, never by lesson output. */
export function learningSourcePolicy(policy = {}) {
  const result = { denyGlobs: policy.denyGlobs ?? [], forbiddenPaths: policy.forbiddenPaths ?? [], outputPaths: policy.outputPaths ?? [] };
  for (const [key, values] of Object.entries(result)) {
    if (!Array.isArray(values) || values.length > 256 || values.some((value) => typeof value !== 'string' || !value || value.length > 512
      || (key !== 'denyGlobs' && !safePath(value.replace(/\/$/, ''))))) fail('LEARNING_POLICY_INVALID', 'Некорректная политика доступа к исходникам.');
  }
  return result;
}

function excluded(relative, bytes, policy) {
  if (!safePath(relative)) return true;
  const normalized = normalizeSourcePath(relative);
  if ([...policy.forbiddenPaths, ...policy.outputPaths].some((item) => {
    const prefix = normalizeSourcePath(item).replace(/\/$/, '');
    return normalized === prefix || normalized.startsWith(`${prefix}/`);
  })) return true;
  return classifySource(relative, bytes, policy).reason !== null;
}

/** Normalize only line separators for quotes, as the source-review path does.
 * The original bytes/hash and BOM remain unchanged. Empty files have zero lines. */
export function learningSourceLines(text) { return text === '' ? [] : text.split(/\r?\n/); }

function directoryChain(root, relative, allowAbsent) {
  const chain = [];
  let cursor = root;
  const parts = relative.split('/');
  for (let index = 0; index < parts.length; index++) {
    let stat;
    try { stat = lstatSync(cursor, { bigint: true }); }
    catch (error) {
      if (error.code !== 'ENOENT' || !allowAbsent) throw error;
      stableChain(chain);
      return { chain, absent: true };
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || !sameHostPath(realpathSync(cursor), cursor))
      fail('LEARNING_CAPTURE_UNSAFE', 'Путь исходника содержит небезопасный каталог.');
    chain.push({ path: cursor, identity: crossStatIdentity(stat) });
    cursor = path.join(cursor, parts[index]);
  }
  return { chain, absent: false };
}

function stableChain(chain) {
  for (const entry of chain) {
    const stat = lstatSync(entry.path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || crossStatIdentity(stat) !== entry.identity
      || !sameHostPath(realpathSync(entry.path), entry.path)) fail('LEARNING_CAPTURE_UNSAFE', 'Путь исходника изменился во время чтения.');
  }
}

function exactBytes(root, entry) {
  const { chain, absent } = directoryChain(root, entry.path, entry.expected === null), file = path.join(root, entry.path);
  if (absent) return null;
  let stat;
  try { stat = lstatSync(file, { bigint: true }); }
  catch (error) {
    if (error.code !== 'ENOENT' || entry.expected !== null) throw error;
    stableChain(chain);
    return null;
  }
  if (!entry.expected || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n
    || !sameHostPath(realpathSync(file), file)) fail('LEARNING_CAPTURE_UNSAFE', 'Исходник не совпадает с выбранной версией.');
  if (stat.size > BigInt(LEARNING_SOURCE_LIMITS.fileBytes)) fail('LEARNING_CAPTURE_LIMIT', 'Исходник превышает лимит сохранения.');
  if (Number(stat.size) !== entry.expected.size || (stat.mode & 0o111n ? '100755' : '100644') !== entry.expected.mode)
    fail('LEARNING_CAPTURE_UNSAFE', 'Размер или режим исходника изменился.');
  const handle = openSync(file, noFollowReadFlags());
  try {
    const opened = fstatSync(handle, { bigint: true });
    if (crossStatIdentity(opened) !== crossStatIdentity(stat)) fail('LEARNING_CAPTURE_UNSAFE', 'Исходник заменен перед чтением.');
    // A bounded allocation/read also protects against a file growing after stat.
    const buffer = Buffer.alloc(entry.expected.size + 1);
    let count = 0, read;
    while (count < buffer.length && (read = readSync(handle, buffer, count, buffer.length - count, null)) > 0) count += read;
    const bytes = buffer.subarray(0, count);
    if (count !== entry.expected.size || crossStatIdentity(fstatSync(handle, { bigint: true })) !== crossStatIdentity(stat)
      || crossStatIdentity(lstatSync(file, { bigint: true })) !== crossStatIdentity(stat)
      || !sameHostPath(realpathSync(file), file) || sha256(bytes) !== entry.expected.hash)
      fail('LEARNING_CAPTURE_UNSAFE', 'Исходник изменился во время чтения.');
    stableChain(chain);
    return bytes;
  } finally { closeSync(handle); }
}

function chunks(bytes) {
  const result = [];
  for (let offset = 0; offset < bytes.length;) {
    let end = Math.min(bytes.length, offset + LEARNING_SOURCE_LIMITS.chunkBytes);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    result.push(SourceChunkSchema.parse({ version: 1, text: bytes.subarray(offset, end).toString('utf8') }));
    offset = end;
  }
  return result;
}

/** Capture only explicit trusted descriptors; expected:null means known absence.
 * Persist the ENTIRE returned reference in durable attempt state before writes.
 * This does not scan the repo or prove that sourceHash describes the whole tree.
 * @param {{store: import('./store.mjs').GraphStore, projectRoot: string, sourceHash: string, files: SelectedSource[], policy?: SourcePolicy}} options
 * @returns {SourceCapture}
 */
export function captureLearningSources({ store, projectRoot, sourceHash, files, policy = {} }) {
  if (!Hash.safeParse(sourceHash).success || !Array.isArray(files) || files.length > 128)
    fail('LEARNING_SELECTION_INVALID', 'Некорректный выбранный набор исходников.');
  const rules = learningSourcePolicy(policy), sources = [], gaps = [], aliases = new Set();
  let total = 0, root;
  try { root = realpathSync(projectRoot); if (lstatSync(path.resolve(projectRoot)).isSymbolicLink()) root = null; } catch { root = null; }
  for (const entry of files) {
    if (!entry || !['before', 'after', 'context'].includes(entry.role) || (entry.expected !== null && (!entry.expected
      || !Hash.safeParse(entry.expected.hash).success || !Number.isSafeInteger(entry.expected.size) || entry.expected.size < 0
      || !['100644', '100755'].includes(entry.expected.mode)))) fail('LEARNING_SELECTION_INVALID', 'Некорректный descriptor исходника.');
    const gap = (code, reason, visible = true) => gaps.push(MaterialGapSchema.parse({ code, path: visible ? entry.path : null, reason }));
    if (excluded(entry.path, undefined, rules)) { gap('excluded-source', 'Исходник исключен действующей политикой.', false); continue; }
    const alias = `${entry.role}:${normalizeSourcePath(entry.path)}`;
    if (aliases.has(alias)) fail('LEARNING_SELECTION_INVALID', 'Выбранный набор содержит повторяющиеся пути.');
    aliases.add(alias);
    if (!root) { gap('capture-unavailable', 'Корень проекта недоступен для безопасного чтения.'); continue; }
    if (entry.expected !== null && (sources.length >= LEARNING_SOURCE_LIMITS.sources || entry.expected.size > LEARNING_SOURCE_LIMITS.fileBytes
      || total + entry.expected.size > LEARNING_SOURCE_LIMITS.totalBytes)) {
      gap('size-limit', 'Полный исходник не сохранен: превышен лимит материала.'); continue;
    }
    let bytes;
    try { bytes = exactBytes(root, entry); }
    catch (error) {
      gap(error.code === 'LEARNING_CAPTURE_LIMIT' ? 'size-limit' : 'capture-unavailable', 'Выбранную версию не удалось безопасно сохранить.'); continue;
    }
    if (bytes === null) {
      if (entry.role === 'context') gap('missing-context', 'Объявленный контекст отсутствует в выбранной версии.');
      continue;
    }
    if (excluded(entry.path, bytes, rules)) { gap('excluded-source', 'Исходник исключен действующей политикой.', false); continue; }
    const text = bytes.toString('utf8'), fileHash = sha256(bytes);
    const source = { id: `source-${hashObject({ path: entry.path, role: entry.role, fileHash, mode: entry.expected.mode })}`,
      path: entry.path, fileHash, bytes: bytes.length, mode: entry.expected.mode, role: entry.role,
      chunkHashes: chunks(bytes).map((chunk) => store.putObject('learning-source-chunks', chunk)), lineCount: learningSourceLines(text).length };
    sources.push(source); total += bytes.length;
  }
  const catalog = SourceCatalogSchema.parse({ version: 1, sources });
  return { sourceHash, sourceCatalogHash: store.putObject('learning-sources', catalog), gaps };
}

/** Read corruption as an error, never as an empty catalog or an ordinary gap. */
export function readLearningSourceCatalog(store, catalogHash) {
  const parsed = SourceCatalogSchema.safeParse(store.readObject('learning-sources', catalogHash));
  if (!parsed.success) fail('LEARNING_SOURCE_INTEGRITY', 'Каталог исходников поврежден.');
  const catalog = parsed.data, ids = new Set(), paths = new Set();
  let bytes = 0;
  for (const source of catalog.sources) {
    const key = `${source.role}:${normalizeSourcePath(source.path)}`;
    if (ids.has(source.id) || paths.has(key)) fail('LEARNING_SOURCE_INTEGRITY', 'Каталог содержит неоднозначные исходники.');
    ids.add(source.id); paths.add(key); bytes += source.bytes;
  }
  if (bytes > LEARNING_SOURCE_LIMITS.totalBytes) fail('LEARNING_SOURCE_INTEGRITY', 'Каталог превышает лимит материала.');
  return catalog;
}

/** Reassemble and verify the entire file before returning any page or anchor.
 * Internal helper: the public material reader verifies run/material ownership.
 * @param {import('./store.mjs').GraphStore} store
 * @param {SourceCatalog['sources'][number]} source
 * @param {SourcePolicy} policy
 */
export function readLearningSource(store, source, policy = {}) {
  const rules = learningSourcePolicy(policy);
  // Integrity is checked even for a newly denied path; policy never masks corruption.
  const text = source.chunkHashes.map((id) => {
    const chunk = SourceChunkSchema.safeParse(store.readObject('learning-source-chunks', id));
    if (!chunk.success) fail('LEARNING_SOURCE_INTEGRITY', 'Сохраненный фрагмент исходника поврежден.');
    return chunk.data.text;
  }).join('');
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length !== source.bytes || sha256(bytes) !== source.fileHash || learningSourceLines(text).length !== source.lineCount)
    fail('LEARNING_SOURCE_INTEGRITY', 'Сохраненные bytes не соответствуют исходнику.');
  if (excluded(source.path, bytes, rules)) fail('LEARNING_SOURCE_DENIED', 'Исходник закрыт действующей политикой доступа.');
  return text;
}

/** Shared line pagination over already verified saved bytes. No live reads. */
export function learningSourcePage(source, text, { startLine = 1, lineCount = 100 } = {}) {
  const lines = learningSourceLines(text);
  if (!Number.isSafeInteger(startLine) || startLine < 1 || startLine > Math.max(1, lines.length)
    || !Number.isSafeInteger(lineCount) || lineCount < 1 || lineCount > LEARNING_SOURCE_LIMITS.pageLines)
    fail('LEARNING_PAGE_INVALID', 'Неверные границы страницы исходника.');
  const selected = []; let size = 0;
  for (const line of lines.slice(startLine - 1, startLine - 1 + lineCount)) {
    const added = Buffer.byteLength(line, 'utf8') + (selected.length ? 1 : 0);
    if (size + added > LEARNING_SOURCE_LIMITS.pageBytes) {
      if (!selected.length) fail('LEARNING_PAGE_LIMIT', 'Строка превышает лимит страницы; исходник сохранен полностью.');
      break;
    }
    size += added; selected.push(line);
  }
  const endLine = startLine - 1 + selected.length;
  return LearningSourceResponseSchema.parse({ sourceId: source.id, fileHash: source.fileHash, text: selected.join('\n'), startLine, endLine,
    totalLines: lines.length, next: endLine < lines.length ? { startLine: endLine + 1, lineCount } : null });
}

/** Exact whole-line quote, with CRLF normalized to LF and no trimming. */
export function exactSourceAnchor(source, text, anchor) {
  const parsed = SourceAnchorSchema.safeParse(anchor);
  if (!parsed.success) fail('LEARNING_ANCHOR_INVALID', 'Некорректная ссылка на исходник.');
  const value = parsed.data, lines = learningSourceLines(text);
  if (value.sourceId !== source.id || value.fileHash !== source.fileHash || value.endLine > lines.length
    || value.quote.replace(/\r\n/g, '\n') !== lines.slice(value.startLine - 1, value.endLine).join('\n'))
    fail('LEARNING_ANCHOR_INVALID', 'Цитата не совпадает с сохраненными строками исходника.');
  return value;
}

/** Redact newly forbidden gap paths without exposing names or arbitrary text. */
export function safeLearningGaps(gaps, policy = {}) {
  if (!Array.isArray(gaps) || gaps.length > 128) fail('LEARNING_GAPS_INVALID', 'Слишком много пробелов в материале.');
  const rules = learningSourcePolicy(policy);
  return gaps.map((gap) => {
    const parsed = MaterialGapSchema.safeParse(gap);
    if (!parsed.success) fail('LEARNING_GAPS_INVALID', 'Некорректное описание пробела в материале.');
    const value = parsed.data;
    assertSafeText(value.reason);
    return value.code === 'excluded-source' || value.path !== null && excluded(value.path, undefined, rules)
      ? { ...value, path: null, reason: 'Исходник исключен действующей политикой.' } : value;
  });
}
