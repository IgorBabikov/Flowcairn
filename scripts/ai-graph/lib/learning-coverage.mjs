import { lstatSync } from 'node:fs';
import path from 'node:path';
import { GraphError, hashObject } from './io.mjs';
import { CoverageBindingSchema, CoverageEntrySchema, CoverageInventorySchema, CoveragePageSchema } from './learning-coverage-schemas.mjs';
import { savedChangedRanges } from './learning-coverage-diff.mjs';
import { safeLearningGaps } from './learning-sources.mjs';

const fail = () => { throw new GraphError('LEARNING_COVERAGE_INTEGRITY', 'Карта участков не соответствует сохраненному материалу.'); };
export const coverageBinding = material => CoverageBindingSchema.parse(Object.fromEntries(
  ['runId', 'planHash', 'taskHash', 'contractHash', 'sourceCatalogHash', 'beforeHash', 'resultHash'].map(key => [key, material[key]])));
const whole = source => source?.lineCount ? { startLine: 1, endLine: source.lineCount } : null;
const ref = (source, range = whole(source)) => source ? { sourceId: source.id, fileHash: source.fileHash, range } : null;
const entry = value => CoverageEntrySchema.parse({ id: `coverage-${hashObject(value)}`, ...value });
const gap = (reason, path = null) => entry({ kind: 'gap', path, change: null, precision: 'unavailable', before: null, after: null, reason });

function fingerprint(store, hash) {
  try { return store.readFingerprint(hash); }
  catch (error) {
    // Old/local callers may not have persisted fingerprints. Corruption is not absence.
    if (typeof store.graphRoot === 'string') {
      try {
        const directory = path.join(store.graphRoot, 'fingerprints');
        const stat = lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw error;
        lstatSync(path.join(directory, `${hash}.json`));
      } catch (missing) { if (missing.code === 'ENOENT') return null; }
    }
    throw error;
  }
}
function descriptors(value) {
  if (!value) return null;
  const files = new Map();
  for (const file of value.files) {
    if (!file || typeof file.path !== 'string' || files.has(file.path)) fail();
    files.set(file.path, file);
  }
  return files;
}

/** Trusted creation only. Never called by polling/GET; no Git/live filesystem. */
export function createLearningCoverage({ store, material, sources, before, after, policy = {} }) {
  const left = descriptors(fingerprint(store, material.beforeHash)), right = descriptors(fingerprint(store, material.resultHash));
  const byPath = new Map();
  for (const source of sources) {
    const pair = byPath.get(source.path) ?? {};
    const side = source.role === 'before' ? 'before' : 'after';
    if (pair[side]) fail();
    pair[side] = source; byPath.set(source.path, pair);
    const descriptor = (side === 'before' ? left : right)?.get(source.path);
    if ((side === 'before' ? left : right) && (!descriptor || descriptor.hash !== source.fileHash
      || descriptor.size !== source.bytes || descriptor.mode !== source.mode)) fail();
  }
  // Include every changed fingerprint path, including missing captures, with policy
  // redaction before persisting any path. No excluded name leaks into inventory.
  if (left && right) for (const path of new Set([...left.keys(), ...right.keys()])) {
    if (hashObject(left.get(path) ?? null) !== hashObject(right.get(path) ?? null) && !byPath.has(path)) byPath.set(path, {});
  }
  const entries = [];
  for (const [path, pair] of [...byPath].sort(([a], [b]) => a.localeCompare(b))) {
    const visible = safeLearningGaps([{ code: 'missing-context', path, reason: 'Исходник не сохранен.' }], policy)[0];
    if (visible.path === null) { entries.push(gap('Часть измененных исходников исключена политикой.')); continue; }
    const a = pair.before, b = pair.after;
    const missing = side => side.gaps.some(item => item.path === null || item.path === path);
    let change, precision = 'exact', reason = null, beforeRef = a ? ref(a) : null, afterRef = b ? ref(b) : null;
    if (a && b) {
      if (a.fileHash === b.fileHash) {
        change = a.mode === b.mode ? 'unchanged' : 'metadata';
        if (change === 'metadata') { beforeRef = ref(a, null); afterRef = ref(b, null); reason = 'Изменен режим файла; цитата строк не объясняет метаданные.'; }
      } else {
        change = 'modified'; precision = 'conservative';
        const ranges = savedChangedRanges(store, a, b);
        beforeRef = ref(a, ranges.before); afterRef = ref(b, ranges.after);
        reason = 'Диапазон между общими началом и концом; внутри могут быть неизмененные строки. Семантические границы не определялись.';
        if (a.mode !== b.mode) reason += ' Также изменен режим файла.';
      }
    } else if (b && left && !left.has(path) && !missing(before)) change = 'added';
    else if (a && right && !right.has(path) && !missing(after)) change = 'removed';
    else if (b?.role === 'context' && !a && !left) {
      change = 'unchanged'; reason = 'Контекст предоставлен отдельно; связь с потоком задачи еще не прослежена.';
    } else {
      change = 'unknown'; precision = 'unavailable';
      reason = 'Не хватает сохраненной версии или подтверждения отсутствия файла. Создание и удаление не предполагаются.';
    }
    if (change === 'unchanged') { beforeRef = null; reason = 'Контекст предоставлен отдельно; связь с потоком задачи еще не прослежена.'; }
    if (a && b && a.mode !== b.mode && change !== 'metadata') entries.push(entry({ kind: 'change', path, change: 'metadata', precision: 'exact',
      before: ref(a, null), after: ref(b, null), reason: 'Изменен режим файла; цитата строк не объясняет метаданные.' }));
    entries.push(entry({ kind: change === 'unchanged' ? 'context' : 'change', path, change, precision, before: beforeRef, after: afterRef, reason }));
  }
  for (const value of material.gaps) entries.push(gap(value.reason, value.path));
  if (!left || !right) entries.push(gap('Полный перечень изменений по сохраненным снимкам недоступен; показаны сохраненные исходники.'));
  entries.push(gap('Связи с зависимостями вне сохраненного контекста еще не прослежены. Наличие файла или цитаты не подтверждает полноту объяснения.'));
  // Deduplicate redacted identical gaps; no path or count is fabricated.
  const rank = { change: 0, context: 1, gap: 2 };
  const unique = [...new Map(entries.map(value => [value.id, value])).values()].sort((a, b) => rank[a.kind] - rank[b.kind]);
  let next = null, pageCount = 0;
  // Bound both count and serialized bytes. A pathological entry is rejected, not truncated.
  const pages = []; let chunk = [];
  for (const value of unique) {
    const candidate = { version: 1, entries: [...chunk, value], next: 'a'.repeat(64) };
    if (chunk.length && !CoveragePageSchema.safeParse(candidate).success) { pages.push(chunk); chunk = []; }
    chunk.push(value); CoveragePageSchema.parse({ ...candidate, entries: chunk });
  }
  if (chunk.length) pages.push(chunk);
  for (const values of pages.reverse()) {
    next = store.putObject('learning-coverage-pages', CoveragePageSchema.parse({ version: 1, entries: values, next })); pageCount++;
  }
  const inventory = CoverageInventorySchema.parse({ version: 1, binding: coverageBinding(material), algorithm: 'line-prefix-suffix-v1',
    entryCount: unique.length, pageCount, firstPageHash: next });
  return store.putObject('learning-coverage', inventory);
}

/** Read all immutable pages without recomputing diffs or reading live files. */
export function readLearningCoverage({ store, material, sources, policy = {} }) {
  if (material.version === 1) return undefined;
  const parsed = CoverageInventorySchema.safeParse(store.readObject('learning-coverage', material.coverageHash));
  if (!parsed.success || hashObject(parsed.data.binding) !== hashObject(coverageBinding(material))) fail();
  const inventory = parsed.data, pages = [], seen = new Set(), ids = new Set(), saved = new Map(sources.map(source => [source.id, source]));
  let next = inventory.firstPageHash, count = 0;
  while (next) {
    if (seen.has(next) || pages.length >= inventory.pageCount) fail();
    seen.add(next);
    const page = CoveragePageSchema.safeParse(store.readObject('learning-coverage-pages', next));
    if (!page.success) fail();
    for (const value of page.data.entries) {
      const { id, ...body } = value;
      if (ids.has(id) || id !== `coverage-${hashObject(body)}`) fail();
      ids.add(id); count++;
      if (value.path && safeLearningGaps([{ code: 'missing-context', path: value.path, reason: 'Карта участков' }], policy)[0].path !== value.path)
        throw new GraphError('LEARNING_SOURCE_DENIED', 'Карта участков закрыта действующей политикой.');
      for (const side of ['before', 'after']) {
        const reference = value[side];
        if (!reference) continue;
        const source = saved.get(reference.sourceId);
        if (!source || source.path !== value.path || source.fileHash !== reference.fileHash
          || (side === 'before' ? source.role !== 'before' : source.role === 'before')
          || reference.range && reference.range.endLine > source.lineCount) fail();
      }
    }
    pages.push(page.data); next = page.data.next;
  }
  if (pages.length !== inventory.pageCount || count !== inventory.entryCount) fail();
  return { id: material.coverageHash, inventory, pages, lessonHash: null, linking: 'absent', links: pages.flatMap(page => page.entries.map(value => ({ entryId: value.id, status: 'unlinked', stepIds: [] }))) };
}

/** Validated step anchors only. Context remains an inventory of supplied sources;
 * linked labels express line coverage, never semantic completeness or mastery. */
export function linkLearningCoverage(coverage, lesson, lessonHash) {
  const links = coverage.pages.flatMap(page => page.entries.map(value => {
    const spans = [value.before, value.after].filter(reference => reference?.range);
    const stepIds = new Set(); let hit = false, complete = spans.length > 0 && value.change !== 'unknown';
    for (const span of spans) {
      const intervals = [];
      for (const step of lesson.steps) for (const anchor of step.anchors) {
        if (anchor.sourceId !== span.sourceId || anchor.fileHash !== span.fileHash
          || anchor.endLine < span.range.startLine || anchor.startLine > span.range.endLine) continue;
        stepIds.add(step.id); hit = true;
        intervals.push([Math.max(anchor.startLine, span.range.startLine), Math.min(anchor.endLine, span.range.endLine)]);
      }
      let cursor = span.range.startLine;
      for (const [start, end] of intervals.sort((a, b) => a[0] - b[0])) {
        if (start > cursor) break;
        cursor = Math.max(cursor, end + 1);
      }
      if (cursor <= span.range.endLine) complete = false;
    }
    return { entryId: value.id, status: complete ? 'linked' : hit ? 'partial' : 'unlinked', stepIds: [...stepIds] };
  }));
  return { ...coverage, lessonHash, linking: 'validated', links };
}
