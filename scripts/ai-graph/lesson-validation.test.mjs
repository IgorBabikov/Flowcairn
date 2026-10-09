import assert from 'node:assert/strict';
import test from 'node:test';
import { validateLessonMaterial } from './lib/lesson-validation.mjs';
import { hashObject } from './lib/io.mjs';

const hash = hashObject('lesson-limits');
const anchor = { sourceId: 'source-fixture', fileHash: hash, startLine: 1, endLine: 1, quote: 'example' };
function lesson() { return { version: 1, materialHash: hash, methodHash: hash, title: 'Учебный пример', scope: 'Выбранный файл',
  steps: [{ id: 'step-one', title: 'Шаг', caller: 'Вход', anchors: [anchor], input: 'Пример', transformations: ['Преобразование'], output: 'Выход', next: null,
    purpose: 'Зачем', changeConsequence: 'Последствие', alternatives: [], origin: { kind: 'teaching-example', label: 'Учебный пример', receiptId: null, artifactId: null, anchor: null } }],
  questions: [], wholeFlow: 'Вход → выход', takeaways: [], limitations: ['Пример не запускался.'] }; }
// Schema failures must not access a project or even its store.
const validate = (value, options = {}) => validateLessonMaterial({ store: null, binding: null, materialHash: hash, methodHash: hash, lesson: value, ...options });

test('lesson rejects imperative output keys, oversized UTF-8 output, too many steps and duplicate IDs before reading', () => {
  for (const key of ['edits', 'commands', 'permissions', 'moves', 'html']) assert.throws(() => validate({ ...lesson(), [key]: [] }), { code: 'LEARNING_LESSON_INVALID' });
  const huge = lesson(); huge.limitations = Array.from({ length: 32 }, () => 'я'.repeat(2000));
  assert.throws(() => validate(huge), { code: 'LEARNING_LESSON_INVALID' });
  const steps = lesson(); steps.steps = Array.from({ length: 33 }, (_, index) => ({ ...steps.steps[0], id: `step-${index}` }));
  assert.throws(() => validate(steps), { code: 'LEARNING_LESSON_INVALID' });
  const duplicate = lesson(); duplicate.steps.push(structuredClone(duplicate.steps[0]));
  assert.throws(() => validate(duplicate), { code: 'LEARNING_LESSON_INVALID' });
});

test('lesson requires exact method/material binding and never accepts runtime-evidence without an extractor', () => {
  assert.throws(() => validate(lesson(), { methodHash: hashObject('other-method') }), { code: 'LEARNING_LESSON_BINDING' });
  assert.throws(() => validate(lesson(), { materialHash: hashObject('other-material') }), { code: 'LEARNING_LESSON_BINDING' });
  const value = lesson(); value.steps[0].origin = { kind: 'runtime-evidence', label: 'Запуск', receiptId: hash, artifactId: hash, anchor };
  assert.throws(() => validate(value), { code: 'LEARNING_RUNTIME_EVIDENCE_UNAVAILABLE' });
});
