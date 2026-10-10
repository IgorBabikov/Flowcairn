import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './learning-coverage.test-support.mjs';
import { readLearningMaterial } from './lib/learning-material.mjs';
import { createLearningChapterBook } from './lib/learning-chapters.mjs';
import { recordLearningPracticeAttempt } from './lib/learning-practice.mjs';
import { WorkflowService } from './lib/service.mjs';

test('service read methods preserve chapter material binding and practice owner guard', t => {
  const fx = fixture(t), saved = fx.create(), material = readLearningMaterial(fx.options(saved));
  const service = Object.create(WorkflowService.prototype);
  service.store = fx.store;
  service.adapters = { learningSourcePolicy: () => ({}) };
  service.learningMaterial = () => material;
  const entries = material.coverage.pages.flatMap(page => page.entries).filter(entry => entry.kind !== 'gap');
  const source = material.sources.find(item => item.role === 'after');
  const chapter = { version: 1, materialHash: saved.id, order: 1, title: 'Глава', scope: 'main.py', coverageEntryIds: entries.map(entry => entry.id), dependencyEntryIds: [], flowNodeIds: ['step-one'], flowEdges: [],
    steps: [{ id: 'step-one', title: 'Шаг', caller: 'inc(x)', anchors: [{ sourceId: source.id, fileHash: source.fileHash, startLine: 1, endLine: 1, quote: 'def inc(x):' }], coverageEntryIds: entries.map(entry => entry.id), dependencyEntryIds: [], input: 'x', transformations: ['inc(x)'], output: 'x + 2', next: null, purpose: 'Поток', changeConsequence: 'Изменится результат', alternatives: [], origin: { kind: 'manual-trace', label: 'Trace', observationIds: [] } }], wholeFlow: 'inc → result', limitations: [] };
  const book = createLearningChapterBook({ store: fx.store, material, materialHash: saved.id, binding: fx.binding, chapters: [chapter], coverage: material.coverage });
  assert.equal(service.readLearningChapterBook(fx.binding.runId, saved.id, book.id).book.chapterCount, 1);
  assert.throws(() => service.readLearningChapterBook(fx.binding.runId, 'f'.repeat(64), book.id), { code: 'STORE_NOT_FOUND' });
  const first = recordLearningPracticeAttempt({ store: fx.store, material, materialHash: saved.id, binding: fx.binding, ownerId: 'local-operator', attempt: {
    operationId: 'service-practice', chapterBookHash: book.id, lessonHash: null, promptId: 'question-one', question: 'Что вернется?', answer: '3', hints: [],
    assessment: { status: 'unassessed', evaluator: 'none', score: null, feedback: null, limitations: [] }, limitations: ['Одна попытка.'], status: 'draft', previousVersionHash: null } });
  service.readLearningPractice = WorkflowService.prototype.readLearningPractice;
  assert.equal(service.readLearningPractice(fx.binding.runId, saved.id, first.id, 'local-operator').attempts.length, 1);
  assert.throws(() => service.readLearningPractice(fx.binding.runId, saved.id, first.id, 'other-owner'), { code: 'LEARNING_PRACTICE_BINDING' });
});
