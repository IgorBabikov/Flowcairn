import type { CoverageEntry, CoverageSource, LearningMaterialResponse, LessonMaterial } from '../contracts';
import { hashContent } from '../plan-identity';
import { assertLearning, record, id, hash, integer, nullable, relativePath, choice, text, list } from './validation';

function source(value: unknown): value is CoverageSource {
  return record(value) && id(value.sourceId) && hash(value.fileHash) && (value.range === null || record(value.range)
    && integer(value.range.startLine, 1) && integer(value.range.endLine, value.range.startLine));
}
function entry(value: unknown): value is CoverageEntry {
  return record(value) && id(value.id) && choice(value.kind, ['change', 'context', 'gap']) && nullable(value.path, relativePath)
    && (value.change === null || choice(value.change, ['added', 'removed', 'modified', 'metadata', 'unknown', 'unchanged']))
    && choice(value.precision, ['conservative', 'exact', 'unavailable']) && nullable(value.before, source) && nullable(value.after, source) && nullable(value.reason, text);
}
/** Verify the entire immutable chain; a truncated or foreign page is an error. */
export async function decodeCoverage(material: LearningMaterialResponse) {
  const coverage = material.coverage;
  if (material.material.version === 1) { assertLearning(coverage === undefined); return; }
  assertLearning(record(coverage) && coverage.id === material.material.coverageHash && record(coverage.inventory));
  const inventory = coverage.inventory;
  assertLearning(inventory.version === 1 && inventory.algorithm === 'line-prefix-suffix-v1' && record(inventory.binding)
    && integer(inventory.entryCount) && integer(inventory.pageCount) && nullable(inventory.firstPageHash, hash));
  const keys = ['runId', 'planHash', 'taskHash', 'contractHash', 'sourceCatalogHash', 'beforeHash', 'resultHash'] as const;
  assertLearning(keys.every(key => inventory.binding[key] === material.material[key]) && Object.keys(inventory.binding).length === keys.length);
  assertLearning(await hashContent(inventory) === coverage.id && Array.isArray(coverage.pages) && coverage.pages.length === inventory.pageCount);
  const sourceById = new Map(material.sources.map(source => [source.id, source]));
  const ids = new Set<string>(); let next = inventory.firstPageHash;
  for (const page of coverage.pages) {
    assertLearning(record(page) && page.version === 1 && list(page.entries, entry, 64) && page.entries.length > 0 && nullable(page.next, hash)
      && new TextEncoder().encode(JSON.stringify(page)).length <= 65536 && await hashContent(page) === next);
    for (const item of page.entries) {
      const { id: entryId, ...body } = item;
      assertLearning(!ids.has(entryId) && entryId === `coverage-${await hashContent(body)}`); ids.add(entryId);
      for (const side of ['before', 'after'] as const) {
        const ref = item[side]; if (!ref) continue;
        const saved = sourceById.get(ref.sourceId);
        assertLearning(saved && saved.fileHash === ref.fileHash && saved.path === item.path
          && (side === 'before' ? saved.role === 'before' : saved.role !== 'before') && (!ref.range || ref.range.endLine <= saved.lineCount));
      }
    }
    next = page.next;
  }
  assertLearning(next === null && ids.size === inventory.entryCount && coverage.lessonHash === material.lessonHash
    && choice(coverage.linking, ['absent', 'validated', 'unavailable']) && Array.isArray(coverage.links) && coverage.links.length === ids.size);
  const linked = new Set<string>();
  for (const link of coverage.links) {
    assertLearning(record(link) && ids.has(link.entryId) && !linked.has(link.entryId) && choice(link.status, ['unlinked', 'partial', 'linked'])
      && list(link.stepIds, id, 32) && new Set(link.stepIds).size === link.stepIds.length);
    assertLearning(coverage.linking === 'validated' ? coverage.lessonHash !== null && (link.status === 'unlinked' ? link.stepIds.length === 0 : link.stepIds.length > 0)
      : link.status === 'unlinked' && link.stepIds.length === 0);
    linked.add(link.entryId);
  }
  assertLearning(coverage.linking !== 'absent' || coverage.lessonHash === null);
}

/** Independently derive links from the separately hash-validated lesson, so HTTP
 * link metadata alone cannot claim full structural coverage or invent step IDs. */
export function assertCoverageLesson(material: LearningMaterialResponse, lesson: LessonMaterial) {
  const coverage = material.coverage;
  if (!coverage || coverage.linking !== 'validated') return;
  const entries = new Map(coverage.pages.flatMap(page => page.entries).map(entry => [entry.id, entry]));
  for (const link of coverage.links) {
    const item = entries.get(link.entryId)!;
    const spans = [item.before, item.after].filter((value): value is CoverageSource & { range: NonNullable<CoverageSource['range']> } => Boolean(value?.range));
    const steps = new Set<string>(); let hit = false, complete = spans.length > 0 && item.change !== 'unknown';
    for (const span of spans) {
      const intervals: number[][] = [];
      for (const step of lesson.steps) for (const anchor of step.anchors) {
        if (anchor.sourceId !== span.sourceId || anchor.fileHash !== span.fileHash || anchor.endLine < span.range.startLine || anchor.startLine > span.range.endLine) continue;
        hit = true; steps.add(step.id); intervals.push([Math.max(anchor.startLine, span.range.startLine), Math.min(anchor.endLine, span.range.endLine)]);
      }
      let cursor = span.range.startLine;
      for (const [start, end] of intervals.sort((a, b) => a[0]! - b[0]!)) {
        if (start! > cursor) break;
        cursor = Math.max(cursor, end! + 1);
      }
      if (cursor <= span.range.endLine) complete = false;
    }
    assertLearning(link.status === (complete ? 'linked' : hit ? 'partial' : 'unlinked')
      && JSON.stringify([...steps].sort()) === JSON.stringify([...link.stepIds].sort()), 'Привязки карты не совпадают с шагами сохраненного урока.');
  }
}
