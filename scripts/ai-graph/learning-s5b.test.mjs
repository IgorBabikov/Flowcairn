import assert from 'node:assert/strict';
import test from 'node:test';
import { hashObject } from './lib/io.mjs';
import { fixture } from './learning-coverage.test-support.mjs';
import { readLearningMaterial } from './lib/learning-material.mjs';
import { createLearningChapterBook, readLearningChapterBook } from './lib/learning-chapters.mjs';
import { registerObservationExtractor, recordLearningObservation, readLearningObservation } from './lib/learning-observations.mjs';
import { recordLearningPracticeAttempt, recordLearningPracticeFeedback, readLearningPracticeLog } from './lib/learning-practice.mjs';

function chapterFixture(t) {
  const fx = fixture(t), saved = fx.create(), material = readLearningMaterial(fx.options(saved));
  const entries = material.coverage.pages.flatMap(page => page.entries).filter(entry => entry.kind !== 'gap');
  const after = material.sources.find(source => source.role === 'after');
  const context = material.sources.find(source => source.role === 'context');
  const anchor = { sourceId: after.id, fileHash: after.fileHash, startLine: 1, endLine: 2, quote: 'def inc(x):\n    return x + 2' };
  const contextAnchor = { sourceId: context.id, fileHash: context.fileHash, startLine: 1, endLine: 1, quote: 'OFFSET = 2' };
  const chapter = { version: 1, materialHash: saved.id, order: 1, title: 'Путь значения', scope: 'main.py → helper.py',
    coverageEntryIds: entries.map(entry => entry.id), dependencyEntryIds: entries.filter(entry => entry.kind === 'context').map(entry => entry.id),
    flowNodeIds: ['read-input', 'apply-offset'], flowEdges: [{ id: 'edge-input', from: 'read-input', to: 'apply-offset', kind: 'calls', label: 'Передать вход', anchors: [] }],
    steps: [
      { id: 'read-input', title: 'Прочитать вход', caller: 'inc(x)', anchors: [anchor], coverageEntryIds: [entries.find(entry => entry.path === 'main.py').id], dependencyEntryIds: [],
        input: 'x = 1 (manual trace)', transformations: ['Вызвать inc(x)'], output: 'x передан в преобразование', next: 'apply-offset', purpose: 'Начать поток', changeConsequence: 'Другой вход меняет итог', alternatives: [],
        origin: { kind: 'manual-trace', label: 'Ручная трассировка по сохраненному коду', observationIds: [] } },
      { id: 'apply-offset', title: 'Применить изменение', caller: 'inc(x)', anchors: [anchor, contextAnchor], coverageEntryIds: [entries.find(entry => entry.path === 'main.py').id], dependencyEntryIds: entries.filter(entry => entry.kind === 'context').map(entry => entry.id),
        input: 'x = 1', transformations: ['Сложить x и 2'], output: '3', next: null, purpose: 'Вернуть измененный результат', changeConsequence: 'Замена +2 изменит результат', alternatives: [],
        origin: { kind: 'teaching-example', label: 'Синтетический пример', observationIds: [] } },
    ], wholeFlow: 'Вход → inc(x) → сложение → возврат', limitations: ['Значения приведены как ручная трассировка; extractor не запускался.'] };
  return { fx, saved, material, chapter, entries, anchor };
}

test('chapters cover every changed/context entry, preserve flow edges and reopen all pages', t => {
  const fx = chapterFixture(t);
  const book = createLearningChapterBook({ store: fx.fx.store, material: fx.material, materialHash: fx.saved.id, binding: fx.fx.binding, chapters: [fx.chapter], coverage: fx.material.coverage });
  const reopened = readLearningChapterBook({ store: fx.fx.store, bookHash: book.id, material: fx.material, materialHash: fx.saved.id, binding: fx.fx.binding });
  assert.equal(reopened.chapters.length, 1);
  assert.equal(reopened.chapters[0].chapter.flowEdges[0].to, 'apply-offset');
  const incomplete = structuredClone(fx.chapter); incomplete.coverageEntryIds = [fx.entries.find(entry => entry.kind === 'change').id]; incomplete.dependencyEntryIds = [];
  incomplete.steps[1].dependencyEntryIds = []; incomplete.steps[1].coverageEntryIds = [fx.entries.find(entry => entry.kind === 'change').id];
  assert.throws(() => createLearningChapterBook({ store: fx.fx.store, material: fx.material, materialHash: fx.saved.id, binding: fx.fx.binding, chapters: [incomplete], coverage: fx.material.coverage }), { code: 'LEARNING_COVERAGE_INCOMPLETE' });
});

test('observations require a registered extractor, exact receipt and source-bound redaction', t => {
  const fx = chapterFixture(t), outputSchemaHash = hashObject('number-output');
  const extractor = registerObservationExtractor({ store: fx.fx.store, id: 'counter-extractor', label: 'Counter fixture', fixtureId: 'counter-fixture', fixtureHash: hashObject('fixture-v1'), outputSchemaHash });
  const receiptId = fx.fx.receipt('check-code', 'check-verify-code');
  const observation = { version: 1, runId: fx.fx.binding.runId, planHash: fx.fx.binding.planHash, taskHash: fx.fx.binding.taskHash, materialHash: fx.saved.id,
    chapterId: 'path-chapter', stepId: 'apply-offset', extractorId: extractor.extractor.id, extractorHash: extractor.id, commandHash: null, fixtureHash: extractor.extractor.fixtureHash,
    inputHash: hashObject('x=1'), outputHash: hashObject('3'), sourceHash: fx.material.material.resultHash, sourceAnchors: [fx.anchor], value: '3',
    redaction: extractor.extractor.redaction, receiptId, status: 'observed', limitation: null, createdAt: '2026-10-10T10:00:00.000Z' };
  const saved = recordLearningObservation({ store: fx.fx.store, material: fx.material, materialHash: fx.saved.id, binding: fx.fx.binding, extractorHash: extractor.id, observation });
  assert.equal(readLearningObservation({ store: fx.fx.store, material: fx.material, materialHash: fx.saved.id, binding: fx.fx.binding, observationHash: saved.id }).observation.value, '3');
  const fabricated = { ...observation, sourceHash: hashObject('stale') };
  assert.throws(() => recordLearningObservation({ store: fx.fx.store, material: fx.material, materialHash: fx.saved.id, binding: fx.fx.binding, extractorHash: extractor.id, observation: fabricated }), { code: 'LEARNING_OBSERVATION_STALE' });
});

test('practice stores human answer, hints and feedback durably with idempotent replay and no mastery claim', t => {
  const fx = chapterFixture(t);
  const first = recordLearningPracticeAttempt({ store: fx.fx.store, material: fx.material, materialHash: fx.saved.id, binding: fx.fx.binding, ownerId: 'operator',
    attempt: { operationId: 'practice-one', chapterBookHash: null, lessonHash: null, promptId: 'predict-result', question: 'Что вернет inc(1)?', answer: '3', hints: [],
      assessment: { status: 'unassessed', evaluator: 'none', score: null, feedback: null, limitations: [] }, limitations: ['Ответ не доказывает удержание.'], status: 'draft', previousVersionHash: null } });
  const replay = recordLearningPracticeAttempt({ store: fx.fx.store, material: fx.material, materialHash: fx.saved.id, binding: fx.fx.binding, ownerId: 'operator', logHash: first.id,
    attempt: { operationId: 'practice-one', chapterBookHash: null, lessonHash: null, promptId: 'predict-result', question: 'Что вернет inc(1)?', answer: '3', hints: [],
      assessment: { status: 'unassessed', evaluator: 'none', score: null, feedback: null, limitations: [] }, limitations: ['Ответ не доказывает удержание.'], status: 'draft', previousVersionHash: null } });
  assert.equal(replay.id, first.id); assert.equal(replay.idempotent, true);
  const feedback = recordLearningPracticeFeedback({ store: fx.fx.store, material: fx.material, materialHash: fx.saved.id, binding: fx.fx.binding, ownerId: 'operator', logHash: first.id,
    attemptHash: first.attempt.id, operationId: 'practice-feedback', feedback: { hints: [{ id: 'hint-one', text: 'Посмотри на return', createdAt: '2026-10-10T10:01:00.000Z' }],
      assessment: { status: 'partially-correct', evaluator: 'human', score: 0.5, feedback: 'Верно прослежен вход, уточни helper.', limitations: ['Оценка одной попытки.'] } } });
  const log = readLearningPracticeLog({ store: fx.fx.store, material: fx.material, materialHash: fx.saved.id, binding: fx.fx.binding, ownerId: 'operator', logHash: feedback.id });
  assert.equal(log.attempts.length, 2); assert.equal(log.attempts[0].attempt.answer, '3'); assert.equal(log.attempts[0].attempt.assessment.evaluator, 'human');
  assert.throws(() => recordLearningPracticeAttempt({ store: fx.fx.store, material: fx.material, materialHash: fx.saved.id, binding: fx.fx.binding, ownerId: 'operator',
    attempt: { operationId: 'practice-bad', chapterBookHash: null, lessonHash: null, promptId: 'predict-result', question: 'Что вернет inc(1)?', answer: '3', mastery: true, hints: [],
      assessment: { status: 'unassessed', evaluator: 'none', score: null, feedback: null, limitations: [] }, limitations: [], status: 'draft', previousVersionHash: null } }), { code: 'LEARNING_PRACTICE_INVALID' });
});
