import { z } from 'zod';
import { GraphError, hashObject } from './io.mjs';
import { Hash, Id, Text } from './schema-primitives.mjs';
import { SourceAnchorSchema } from './learning-schemas.mjs';
import { readLearningMaterial } from './learning-material.mjs';
import { savedSourceAnchor } from './learning-sources.mjs';

/**
 * Chapters are the durable, multi-page successor to the small LessonMaterial
 * v1 object.  They deliberately have their own objects and hashes so old
 * lessons/jobs remain readable and immutable.
 */
export const ChapterFlowEdgeSchema = z.strictObject({
  id: Id,
  from: Id,
  to: Id,
  kind: z.enum(['calls', 'returns', 'branches', 'reads', 'writes', 'depends-on', 'hands-off']),
  label: Text.nullable(),
  anchors: z.array(SourceAnchorSchema).max(8),
});

export const ChapterOriginSchema = z.strictObject({
  kind: z.enum(['manual-trace', 'test-fixture', 'teaching-example', 'runtime-observation']),
  label: Text,
  observationIds: z.array(Hash).max(32),
});

export const LearningChapterStepSchema = z.strictObject({
  id: Id,
  title: z.string().min(1).max(160),
  caller: Text,
  anchors: z.array(SourceAnchorSchema).min(1).max(20),
  coverageEntryIds: z.array(Id).min(1).max(128),
  dependencyEntryIds: z.array(Id).max(128),
  input: Text,
  transformations: z.array(Text).min(1).max(64),
  output: Text,
  next: Id.nullable(),
  purpose: Text,
  changeConsequence: Text,
  alternatives: z.array(Text).max(20),
  origin: ChapterOriginSchema,
});

export const LearningChapterSchema = z.strictObject({
  version: z.literal(1),
  materialHash: Hash,
  order: z.number().int().positive(),
  title: z.string().min(1).max(160),
  scope: Text,
  coverageEntryIds: z.array(Id).min(1).max(256),
  dependencyEntryIds: z.array(Id).max(256),
  flowNodeIds: z.array(Id).min(1).max(256),
  flowEdges: z.array(ChapterFlowEdgeSchema).max(512),
  steps: z.array(LearningChapterStepSchema).min(1).max(64),
  wholeFlow: Text,
  limitations: z.array(Text).max(64),
}).refine(value => new Set(value.steps.map(step => step.id)).size === value.steps.length,
  'Chapter step IDs must be unique')
  .refine(value => new Set(value.flowNodeIds).size === value.flowNodeIds.length,
    'Chapter flow node IDs must be unique');

export const ChapterRefSchema = z.strictObject({
  id: Hash,
  order: z.number().int().positive(),
  title: z.string().min(1).max(160),
});

export const LearningChapterPageSchema = z.strictObject({
  version: z.literal(1),
  chapters: z.array(ChapterRefSchema).min(1).max(64),
  next: Hash.nullable(),
}).refine(value => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 64 * 1024,
  'Chapter page exceeds 64 KiB');

export const LearningChapterBookSchema = z.strictObject({
  version: z.literal(1),
  materialHash: Hash,
  chapterCount: z.number().int().nonnegative(),
  pageCount: z.number().int().nonnegative(),
  firstPageHash: Hash.nullable(),
  chapters: z.array(ChapterRefSchema),
});

const fail = (code, message) => { throw new GraphError(code, message); };

function materialContext({ store, material, materialHash, binding, policy = {} }) {
  const selectedHash = materialHash ?? material?.id;
  const materialBody = material?.material ?? material;
  if (!materialBody || !Hash.safeParse(selectedHash).success || materialBody.materialHash && materialBody.materialHash !== selectedHash)
    fail('LEARNING_CHAPTER_BINDING', 'Глава относится к другому материалу.');
  if (!binding || binding.runId !== materialBody.runId || binding.planHash !== materialBody.planHash || binding.taskHash !== materialBody.taskHash)
    fail('LEARNING_CHAPTER_BINDING', 'Глава не связана с владельцем материала.');
  const read = readLearningMaterial({ store, materialHash: selectedHash, binding: { ...binding, materialHashes: [selectedHash] }, policy });
  if (read.material.version < 2 || !read.coverage)
    fail('LEARNING_COVERAGE_REQUIRED', 'Для глав нужна версия материала с полной картой покрытия.');
  return { ...read, selectedHash };
}

function coverageEntries(coverage) {
  return new Map(coverage.pages.flatMap(page => page.entries).map(entry => [entry.id, entry]));
}

function validateAnchor(store, sources, anchor, policy) {
  const source = sources.find(item => item.id === anchor.sourceId);
  if (!source) fail('LEARNING_CHAPTER_ANCHOR', 'Глава содержит ссылку на чужой исходник.');
  return savedSourceAnchor(store, source, anchor, policy);
}

function validateChapter({ store, chapter, materialHash, coverage, sources, policy = {} }) {
  const parsed = LearningChapterSchema.safeParse(chapter);
  if (!parsed.success) fail('LEARNING_CHAPTER_INVALID', 'Глава не соответствует схеме.');
  const value = parsed.data;
  if (value.materialHash !== materialHash) fail('LEARNING_CHAPTER_BINDING', 'Глава не связана с материалом.');
  const entries = coverageEntries(coverage), referenced = new Set(value.coverageEntryIds), dependencies = new Set(value.dependencyEntryIds);
  for (const id of [...referenced, ...dependencies]) if (!entries.has(id)) fail('LEARNING_CHAPTER_COVERAGE', 'Глава ссылается на неизвестный участок покрытия.');
  const steps = new Map(value.steps.map(step => [step.id, step]));
  for (const step of value.steps) {
    for (const id of [...step.coverageEntryIds, ...step.dependencyEntryIds]) {
      if (!entries.has(id)) fail('LEARNING_CHAPTER_COVERAGE', 'Шаг ссылается на неизвестный участок покрытия.');
      referenced.add(id);
    }
    step.anchors.forEach(anchor => validateAnchor(store, sources, anchor, policy));
    if (step.origin.kind === 'runtime-observation' && !step.origin.observationIds.length)
      fail('LEARNING_OBSERVATION_REQUIRED', 'Наблюдаемое значение требует зарегистрированной observation.');
    if (step.origin.kind !== 'runtime-observation' && step.origin.observationIds.length)
      fail('LEARNING_OBSERVATION_ORIGIN', 'Observation можно указывать только для runtime-observation шага.');
    if (step.next !== null && !steps.has(step.next)) fail('LEARNING_FLOW_EDGE', 'Следующий шаг отсутствует в главе.');
  }
  const edgeIds = new Set();
  for (const edge of value.flowEdges) {
    if (edgeIds.has(edge.id) || !steps.has(edge.from) || !steps.has(edge.to)) fail('LEARNING_FLOW_EDGE', 'Flow edge содержит неизвестный узел.');
    edgeIds.add(edge.id); edge.anchors.forEach(anchor => validateAnchor(store, sources, anchor, policy));
  }
  for (const step of value.steps) if (step.next !== null && !value.flowEdges.some(edge => edge.from === step.id && edge.to === step.next))
    fail('LEARNING_FLOW_EDGE', 'Связь next должна быть закреплена flow edge.');
  const coveredBySteps = new Set(value.steps.flatMap(step => [...step.coverageEntryIds, ...step.dependencyEntryIds]));
  for (const id of value.coverageEntryIds) if (!coveredBySteps.has(id)) fail('LEARNING_CHAPTER_COVERAGE', 'Покрытие главы не прослеживается ни в одном шаге.');
  return value;
}

function requiredCoverageIds(coverage) {
  return coverage.pages.flatMap(page => page.entries).filter(entry => entry.kind !== 'gap').map(entry => entry.id);
}

/** Persist a complete chapter set. Every changed/context entry must appear in
 * at least one chapter; gaps remain explicit and are never silently dropped. */
export function createLearningChapterBook({ store, material, materialHash, binding, chapters, coverage, policy = {} }) {
  const read = materialContext({ store, material, materialHash, binding, policy });
  const effectiveHash = read.selectedHash;
  const map = coverage ?? read.coverage;
  if (!Array.isArray(chapters) || chapters.length === 0) fail('LEARNING_CHAPTER_INVALID', 'Нужна хотя бы одна глава.');
  const ordered = [...chapters].sort((a, b) => a.order - b.order);
  if (ordered.some((chapter, index) => chapter.order !== index + 1)) fail('LEARNING_CHAPTER_ORDER', 'Порядок глав должен быть непрерывным.');
  const saved = [];
  const allCovered = new Set();
  for (const input of ordered) {
    const chapter = validateChapter({ store, chapter: input, materialHash: effectiveHash, coverage: map, sources: read.sources, policy });
    chapter.coverageEntryIds.forEach(id => allCovered.add(id));
    chapter.dependencyEntryIds.forEach(id => allCovered.add(id));
    chapter.steps.forEach(step => [...step.coverageEntryIds, ...step.dependencyEntryIds].forEach(id => allCovered.add(id)));
    const id = store.putObject('learning-chapters', chapter);
    saved.push({ id, order: chapter.order, title: chapter.title });
  }
  const missing = requiredCoverageIds(map).filter(id => !allCovered.has(id));
  if (missing.length) fail('LEARNING_COVERAGE_INCOMPLETE', 'Измененные участки или необходимый контекст не покрыты главами.');
  const chunks = [];
  for (let start = 0; start < saved.length; start += 64) {
    const chunk = saved.slice(start, start + 64);
    if (!LearningChapterPageSchema.safeParse({ version: 1, chapters: chunk, next: 'a'.repeat(64) }).success)
      fail('LEARNING_CHAPTER_TOO_LARGE', 'Одна страница глав превышает лимит.');
    chunks.push(chunk);
  }
  let next = null;
  for (let index = chunks.length - 1; index >= 0; index -= 1)
    next = store.putObject('learning-chapter-pages', LearningChapterPageSchema.parse({ version: 1, chapters: chunks[index], next }));
  const pageCount = chunks.length;
  const book = LearningChapterBookSchema.parse({ version: 1, materialHash: effectiveHash, chapterCount: saved.length, pageCount, firstPageHash: next, chapters: saved });
  const id = store.putObject('learning-chapter-books', book);
  return { id, book, chapters: saved };
}

function readPages(store, book) {
  const pages = [], seen = new Set(); let next = book.firstPageHash;
  while (next) {
    if (seen.has(next) || pages.length >= book.pageCount) fail('LEARNING_CHAPTER_INTEGRITY', 'Страницы глав содержат цикл или лишние данные.');
    seen.add(next);
    const page = LearningChapterPageSchema.safeParse(store.readObject('learning-chapter-pages', next));
    if (!page.success) fail('LEARNING_CHAPTER_INTEGRITY', 'Страница глав повреждена.');
    pages.push(page.data); next = page.data.next;
  }
  if (pages.length !== book.pageCount) fail('LEARNING_CHAPTER_INTEGRITY', 'Количество страниц глав не совпадает.');
  const refs = pages.flatMap(page => page.chapters);
  if (refs.length !== book.chapterCount || new Set(refs.map(ref => ref.id)).size !== refs.length || hashObject(refs) !== hashObject(book.chapters))
    fail('LEARNING_CHAPTER_INTEGRITY', 'Индекс глав усечен или изменен.');
  return refs;
}

/** Read the complete immutable chapter book; no live filesystem or AI call. */
export function readLearningChapterBook({ store, bookHash, material, materialHash, binding, policy = {} }) {
  const read = materialContext({ store, material, materialHash, binding, policy });
  const book = LearningChapterBookSchema.safeParse(store.readObject('learning-chapter-books', bookHash));
  if (!book.success || book.data.materialHash !== read.selectedHash) fail('LEARNING_CHAPTER_INTEGRITY', 'Книга глав не связана с материалом.');
  const refs = readPages(store, book.data);
  const chapters = refs.map(ref => {
    const chapter = validateChapter({ store, chapter: store.readObject('learning-chapters', ref.id), materialHash: book.data.materialHash,
      coverage: read.coverage, sources: read.sources, policy });
    return { id: ref.id, chapter };
  });
  return { id: bookHash, book: book.data, chapters };
}

export function readLearningChapter({ store, bookHash, chapterHash, material, materialHash, binding, policy = {} }) {
  const book = readLearningChapterBook({ store, bookHash, material, materialHash, binding, policy });
  const found = book.chapters.find(item => item.id === chapterHash);
  if (!found) fail('LEARNING_CHAPTER_NOT_FOUND', 'Глава не входит в выбранную книгу.');
  return found;
}

export { validateChapter as validateLearningChapter };
