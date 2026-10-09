import { sourceTextPage } from './learning-source-page.mjs';
import { saveLearningSourceBytes, verifiedSourceText, putLearningSourceCatalog, loadLearningSourceCatalog } from './learning-source-storage.mjs';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { lstatHostSync as lstatSync, crossStatIdentity, sameHostPath } from './host-filesystem.mjs';
import { GraphError, hashObject, } from './io.mjs';
import { classifySource, normalizeSourcePath, assertSafeText } from './source-policy.mjs';
import { Hash, RelativePath } from './schema-primitives.mjs';
import { MaterialGapSchema, SourceCatalogSchema, SourceAnchorSchema } from './learning-schemas.mjs';

/** @typedef {import('zod').infer<typeof SourceCatalogSchema>} SourceCatalog */
/** @typedef {import('zod').infer<typeof MaterialGapSchema>} MaterialGap */
/** @typedef {{ denyGlobs?: string[], forbiddenPaths?: string[], outputPaths?: string[] }} SourcePolicy */
/** @typedef {{sourceHash: string, sourceCatalogHash: string, gaps: MaterialGap[]}} SourceCapture */
/** @typedef {{path: string, role: 'before'|'after'|'context', expected: {hash: string, size: number, mode: '100644'|'100755'}|null}} SelectedSource */

export const LEARNING_SOURCE_LIMITS = Object.freeze({ sources: null, fileBytes: null, totalBytes: null,
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

function exactBytes(root, entry, storeForCapture) {
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
  if (Number(stat.size) !== entry.expected.size || (stat.mode & 0o111n ? '100755' : '100644') !== entry.expected.mode)
    fail('LEARNING_CAPTURE_UNSAFE', 'Размер или режим исходника изменился.');
  const source = saveLearningSourceBytes(storeForCapture, file, entry.expected, { beforePersist: () => stableChain(chain) });
  return source;
}

/** Capture only explicit trusted descriptors; expected:null means known absence.
 * Persist the ENTIRE returned reference in durable attempt state before writes.
 * This does not scan the repo or prove that sourceHash describes the whole tree.
 * @param {{store: import('./store.mjs').GraphStore, projectRoot: string, sourceHash: string, files: SelectedSource[], policy?: SourcePolicy}} options
 * @returns {SourceCapture}
 */
export function captureLearningSources({ store, projectRoot, sourceHash, files, policy = {} }) {
  if (!Hash.safeParse(sourceHash).success || !Array.isArray(files))
    fail('LEARNING_SELECTION_INVALID', 'Некорректный выбранный набор исходников.');
  const rules = learningSourcePolicy(policy), sources = [], gaps = [], aliases = new Set();
  let root;
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
    let bytes;
    try { bytes = exactBytes(root, entry, store); }
    catch (error) {
      if (error.capturePersistenceFailure) throw error;
      if (error.code === 'LEARNING_SOURCE_DENIED') gap('excluded-source', 'Исходник исключен действующей политикой.', false);
      else gap('capture-unavailable', 'Выбранную версию не удалось безопасно сохранить.');
      continue;
    }
    if (bytes === null) {
      if (entry.role === 'context') gap('missing-context', 'Объявленный контекст отсутствует в выбранной версии.');
      continue;
    }
    const fileHash = bytes.fileHash;
    sources.push({ id: `source-${hashObject({ path: entry.path, role: entry.role, fileHash, mode: entry.expected.mode })}`,
      path: entry.path, mode: entry.expected.mode, role: entry.role, ...bytes });
  }
  const catalog = SourceCatalogSchema.parse({ version: 1, sources });
  return { sourceHash, sourceCatalogHash: putLearningSourceCatalog(store, catalog), gaps };
}

/** Read corruption as an error, never as an empty catalog or an ordinary gap. */
export function readLearningSourceCatalog(store, catalogHash) {
  const parsed = SourceCatalogSchema.safeParse(loadLearningSourceCatalog(store, catalogHash));
  if (!parsed.success) fail('LEARNING_SOURCE_INTEGRITY', 'Каталог исходников поврежден.');
  const catalog = parsed.data, ids = new Set(), paths = new Set();
  for (const source of catalog.sources) {
    const key = `${source.role}:${normalizeSourcePath(source.path)}`;
    if (ids.has(source.id) || paths.has(key)) fail('LEARNING_SOURCE_INTEGRITY', 'Каталог содержит неоднозначные исходники.');
    ids.add(source.id); paths.add(key);
  }
  return catalog;
}

/** Verify saved bytes with bounded working memory before exposing metadata/pages. */
export function verifyLearningSource(store, source, policy = {}) {
  const rules = learningSourcePolicy(policy);
  for (const _text of verifiedSourceText(store, source)) { /* Exhaust full integrity/policy validation. */ }
  if (excluded(source.path, undefined, rules)) fail('LEARNING_SOURCE_DENIED', 'Исходник закрыт действующей политикой доступа.');
  return source;
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
  const text = [...verifiedSourceText(store, source)].join('');
  const bytes = Buffer.from(text, 'utf8');
  if (excluded(source.path, bytes, rules)) fail('LEARNING_SOURCE_DENIED', 'Исходник закрыт действующей политикой доступа.');
  return text;
}

/** Shared line pagination over already verified saved bytes. No live reads. */
export function learningSourcePage(source, text, options = {}) {
  return sourceTextPage(source, [text], options);
}

/** Validate a saved whole-line citation without reassembling its complete file. */
export function savedSourceAnchor(store, source, anchor, policy = {}) {
  const parsed = SourceAnchorSchema.safeParse(anchor);
  if (!parsed.success) fail('LEARNING_ANCHOR_INVALID', 'Некорректная ссылка на исходник.');
  const value = parsed.data;
  if (value.sourceId !== source.id || value.fileHash !== source.fileHash || value.endLine > source.lineCount)
    fail('LEARNING_ANCHOR_INVALID', 'Ссылка не соответствует сохраненному исходнику.');
  const page = sourceTextPage(source, verifiedSourceText(store, source), { startLine: value.startLine,
    lineCount: value.endLine - value.startLine + 1 }, { maximumLines: Number.MAX_SAFE_INTEGER });
  if (excluded(source.path, undefined, learningSourcePolicy(policy))) fail('LEARNING_SOURCE_DENIED', 'Исходник закрыт действующей политикой доступа.');
  if (page.partial || page.endLine !== value.endLine || page.text !== value.quote.replace(/\r\n/g, '\n'))
    fail('LEARNING_ANCHOR_INVALID', 'Цитата не совпадает с полными сохраненными строками.');
  return value;
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
  if (!Array.isArray(gaps)) fail('LEARNING_GAPS_INVALID', 'Слишком много пробелов в материале.');
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
