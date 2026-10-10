import { assertCoverageLesson } from './coverage-decoder';
import type { DataOrigin, LearningLessonResponse, LearningMaterialResponse, LessonMaterial, LessonStep } from '../contracts';
import { hashContent } from '../plan-identity';
import { assertLearning, record, text, hash, id, list, nullable, choice, sourceAnchor, anchorInCatalog, uniqueIds } from './validation';

function origin(value: unknown): value is DataOrigin {
  return record(value) && choice(value.kind, ['runtime-evidence', 'test-fixture', 'manual-trace', 'teaching-example'])
    && text(value.label) && nullable(value.receiptId, hash) && nullable(value.artifactId, hash) && nullable(value.anchor, sourceAnchor);
}
function step(value: unknown): value is LessonStep {
  return record(value) && id(value.id) && text(value.title, 160) && text(value.caller) && list(value.anchors, sourceAnchor, 20) && value.anchors.length > 0
    && text(value.input) && list(value.transformations, text, 32) && value.transformations.length > 0 && text(value.output)
    && nullable(value.next, text) && text(value.purpose) && text(value.changeConsequence) && list(value.alternatives, text, 20) && origin(value.origin);
}
function lesson(value: unknown): value is LessonMaterial {
  return record(value) && value.version === 1 && hash(value.materialHash) && hash(value.methodHash) && text(value.title, 160)
    && text(value.scope) && list(value.steps, step, 32) && value.steps.length > 0 && uniqueIds(value.steps)
    && Array.isArray(value.questions) && value.questions.length <= 10 && value.questions.every(question => record(question)
      && id(question.id) && text(question.text) && list(question.anchors, sourceAnchor, 20))
    && text(value.wholeFlow) && list(value.takeaways, text, 20) && list(value.limitations, text, 32);
}
export async function decodeLearningLesson(value: unknown, lessonHash: string, material: LearningMaterialResponse): Promise<LearningLessonResponse> {
  assertLearning(record(value) && value.id === lessonHash && lesson(value.lesson) && value.lesson.materialHash === material.id);
  const response = value as unknown as LearningLessonResponse;
  assertLearning(new TextEncoder().encode(JSON.stringify(response.lesson)).length <= 65536 && await hashContent(response.lesson) === lessonHash,
    'Готовый разбор не соответствует сохраненной версии.');
  const anchors = response.lesson.steps.flatMap(item => [...item.anchors, ...(item.origin.anchor ? [item.origin.anchor] : [])])
    .concat(response.lesson.questions.flatMap(item => item.anchors));
  assertLearning(anchors.every(anchor => anchorInCatalog(anchor, material.sources)), 'Ссылка разбора не соответствует каталогу сохраненных исходников.');
  assertCoverageLesson(material, response.lesson);
  return response;
}
