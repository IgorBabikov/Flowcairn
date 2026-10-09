import { GraphError } from './io.mjs';
import { Hash } from './schema-primitives.mjs';
import { LessonMaterialSchema } from './learning-schemas.mjs';
import { readLearningMaterial } from './learning-material.mjs';
import { readLearningSource, exactSourceAnchor } from './learning-sources.mjs';
import { assertSafeText } from './source-policy.mjs';

/** @returns {never} */
const fail = (code, message) => { throw new GraphError(code, message); };

/** Deterministic shape, anchor and declared-provenance validation only.
 * Does not prove prose, rationale, traces, runtime values or human understanding.
 * There is no runtime-value extractor in L1, so runtime-evidence always fails.
 * @param {{store: import('./store.mjs').GraphStore, materialHash: string, binding: import('./learning-material.mjs').ReadBinding,
 * methodHash: string, lesson: unknown, policy?: import('./learning-sources.mjs').SourcePolicy}} options
 * @returns {import('zod').infer<typeof LessonMaterialSchema>}
 */
export function validateLessonMaterial({ store, materialHash, binding, methodHash, lesson, policy = {} }) {
  const parsed = LessonMaterialSchema.safeParse(lesson);
  if (!parsed.success) fail('LEARNING_LESSON_INVALID', 'Урок не соответствует ограниченной схеме.');
  const value = parsed.data;
  if (!Hash.safeParse(methodHash).success || value.methodHash !== methodHash || value.materialHash !== materialHash)
    fail('LEARNING_LESSON_BINDING', 'Урок не связан с выбранным материалом и методом.');
  if (value.steps.some((step) => step.origin.kind === 'runtime-evidence'))
    fail('LEARNING_RUNTIME_EVIDENCE_UNAVAILABLE', 'Данные запуска требуют зарегистрированного extractor значений.');
  if (new Set(value.steps.map((step) => step.id)).size !== value.steps.length
    || new Set(value.questions.map((question) => question.id)).size !== value.questions.length)
    fail('LEARNING_LESSON_INVALID', 'Шаги и вопросы должны иметь уникальные IDs.');
  assertSafeText(JSON.stringify(value));
  const { material, sources } = readLearningMaterial({ store, materialHash, binding, policy });
  const saved = new Map(sources.map((source) => [source.id, { source, text: readLearningSource(store, source, policy) }]));
  const validateAnchor = (anchor) => {
    const entry = saved.get(anchor.sourceId);
    if (!entry) fail('LEARNING_ANCHOR_INVALID', 'Цитата относится к другому материалу.');
    return exactSourceAnchor(entry.source, entry.text, anchor);
  };
  const receipts = new Set([...material.implementationReceiptIds, ...material.checkReceiptIds, ...material.reviewReceiptIds]);
  for (const step of value.steps) {
    step.anchors.forEach(validateAnchor);
    const origin = step.origin;
    if (origin.anchor) validateAnchor(origin.anchor);
    if (origin.kind === 'test-fixture') {
      if (!origin.anchor) fail('LEARNING_ORIGIN_INVALID', 'Учебные данные из теста требуют точную цитату fixture.');
      if (origin.receiptId !== null && !receipts.has(origin.receiptId))
        fail('LEARNING_ORIGIN_INVALID', 'Receipt происхождения данных не принадлежит материалу.');
      if (origin.artifactId !== null) {
        if (origin.receiptId === null || !store.readObject('receipts', origin.receiptId).artifacts.includes(origin.artifactId))
          fail('LEARNING_ORIGIN_INVALID', 'Артефакт происхождения данных не связан с receipt.');
        store.readObject('artifacts', origin.artifactId);
      }
    } else if (origin.receiptId !== null || origin.artifactId !== null) {
      fail('LEARNING_ORIGIN_INVALID', 'Ручная трассировка и учебный пример не являются receipt evidence.');
    }
  }
  for (const question of value.questions) question.anchors.forEach(validateAnchor);
  return value;
}
