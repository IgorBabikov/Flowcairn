import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import test from 'node:test';
import { fixture, H, hash } from './learning-fixtures.test-support.mjs';
import { control, learningRead } from '../../controller.mjs';

const require = createRequire(import.meta.url);
const bundle = await build({ stdin: { contents: `
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
export const render = (component, props) => renderToStaticMarkup(createElement(component, props));
export { ChapterNavigation } from './ChapterNavigation';
export { LearningPracticePanel } from './LearningPracticePanel';
export { createLearningApi } from './learning-api';
`, resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'tsx' }, bundle: true, write: false, platform: 'node', format: 'esm', jsx: 'automatic',
  plugins: [{ name: 'react-instance', setup(build) { build.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true })); } }] });
const components = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

test('S5c learning API uses exact chapter, observation and practice routes with immutable hashes', async () => {
  const calls = [];
  const materialHash = H, chapterAnchor = { sourceId: 'source-after', fileHash: H, startLine: 1, endLine: 1, quote: 'x' }, chapter = { version: 1, materialHash, order: 1, title: 'Глава', scope: 'src/app.ts', coverageEntryIds: ['coverage-one'], dependencyEntryIds: [],
    flowNodeIds: ['step-one'], flowEdges: [], steps: [{ id: 'step-one', title: 'Шаг', caller: 'run()', anchors: [chapterAnchor], coverageEntryIds: ['coverage-one'], dependencyEntryIds: [], input: 'x', transformations: ['f(x)'], output: 'y', next: null, purpose: 'Проверить поток', changeConsequence: 'Изменится y', alternatives: [], origin: { kind: 'manual-trace', label: 'Trace', observationIds: [] } }], wholeFlow: 'run → y', limitations: [] };
  const chapterHash = hash(chapter), book = { version: 1, materialHash, chapterCount: 1, pageCount: 1, firstPageHash: H, chapters: [{ id: chapterHash, order: 1, title: 'Глава' }] }, bookHash = hash(book);
  const read = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('/chapters/books/') || url.endsWith('/chapters')) return { id: bookHash, book, chapters: [{ id: chapterHash, chapter }] };
    if (url.includes('/practice/')) return { logHash: H, log: { version: 1, runId: 'run-fixture', planHash: H, taskHash: H, materialHash, ownerId: 'local-operator', attemptCount: 0, pageCount: 0, firstPageHash: null, operations: {}, latestAttemptHash: null }, attempts: [] };
    return { id: H, observation: { version: 1, runId: 'run-fixture', planHash: H, taskHash: H, materialHash, chapterId: 'chapter-one', stepId: 'step-one', extractorId: 'extractor-one', extractorHash: H, commandHash: null, fixtureHash: H, inputHash: H, outputHash: H, sourceHash: H, sourceAnchors: [], value: null, redaction: { version: 1, applied: true, rulesHash: H, removedFields: [] }, receiptId: H, status: 'uncertain', limitation: 'Fixture', createdAt: '2026-10-10T10:00:00.000Z' }, extractor: {}, freshness: 'current' };
  };
  const api = components.createLearningApi(read);
  await api.learningChapterBook('run-fixture', materialHash, bookHash);
  await api.learningChapterBook('run-fixture', materialHash);
  await api.learningObservation('run-fixture', materialHash, H);
  await api.learningPractice('run-fixture', materialHash, H);
  assert.deepEqual(calls.map(call => call.url), [
    `/api/runs/run-fixture/learning/materials/${materialHash}/chapters/books/${bookHash}`,
    `/api/runs/run-fixture/learning/materials/${materialHash}/chapters`,
    `/api/runs/run-fixture/learning/materials/${materialHash}/observations/${H}`,
    `/api/runs/run-fixture/learning/materials/${materialHash}/practice/${H}`,
  ]);
});

test('chapter navigation and human practice render compactly without claiming mastery', () => {
  const fx = fixture();
  const chapterHash = hash({ version: 1, materialHash: fx.materialHash, order: 1, title: 'Глава', scope: 'src', coverageEntryIds: ['coverage-one'], dependencyEntryIds: [], flowNodeIds: ['step-one'], flowEdges: [], steps: [], wholeFlow: 'flow', limitations: [] });
  const book = { id: H, book: { version: 1, materialHash: fx.materialHash, chapterCount: 1, pageCount: 1, firstPageHash: H, chapters: [{ id: chapterHash, order: 1, title: 'Глава' }] }, chapters: [{ id: chapterHash, chapter: { order: 1, title: 'Глава' } }] };
  const nav = components.render(components.ChapterNavigation, { book, selectedId: null, onSelect: () => {} });
  assert.match(nav, /Главы/); assert.match(nav, /Глава/);
  const controller = { snapshot: { ...fx.snapshot, planHash: H }, snapshotUnavailable: false };
  const practice = components.render(components.LearningPracticePanel, { controller, runId: 'run-fixture', material: fx.response, lesson: fx.lesson, canRead: true });
  assert.match(practice, /Попробуй сам/); assert.match(practice, /Сохранить ответ/); assert.match(practice, /не доказывают долговременное освоение/); assert.doesNotMatch(practice, /PROVEN|mastery/);
});

test('controller keeps S5c routes exact and delegates writes to service ownership', async () => {
  const calls = [];
  const service = {
    readLearningChapterBook: async (...args) => { calls.push(['book', ...args]); return { ok: true }; },
    readLearningObservation: async (...args) => { calls.push(['observation', ...args]); return { ok: true }; },
    appendLearningPractice: async (...args) => { calls.push(['practice', ...args]); return { logHash: H }; },
  };
  const response = { statusCode: 0, headers: {}, body: '', setHeader(name, value) { this.headers[name] = value; }, end(value) { this.body = value; } };
  assert.equal(await learningRead(service, response, new URL(`/api/runs/run-fixture/learning/materials/${H}/chapters/books/${H}`, 'http://localhost')), true);
  assert.equal(await learningRead(service, response, new URL(`/api/runs/run-fixture/learning/materials/${H}/observations/${H}`, 'http://localhost')), true);
  const body = { operationId: 'practice-one', expectedRevision: 4, planHash: H, materialHash: H, logHash: null, chapterBookHash: null, lessonHash: null, promptId: 'question-one', question: 'Что изменится?', answer: 'Ответ', hints: [], limitations: ['Ограничение'] };
  const request = { headers: { 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } };
  await control(service, request, response, new URL(`/api/runs/run-fixture/learning/materials/${H}/practice`, 'http://localhost'));
  assert.equal(calls[0][0], 'book'); assert.equal(calls[1][0], 'observation'); assert.equal(calls[2][0], 'practice');
  assert.equal(calls[2][3], 'local-operator'); assert.equal(response.statusCode, 200);
});
