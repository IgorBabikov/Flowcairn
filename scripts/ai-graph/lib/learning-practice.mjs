import { z } from 'zod';
import { GraphError, hashObject, now } from './io.mjs';
import { Hash, Id, Text } from './schema-primitives.mjs';
import { readLearningMaterial } from './learning-material.mjs';

export const PracticeHintSchema = z.strictObject({
  id: Id,
  text: Text,
  createdAt: z.iso.datetime(),
});

export const PracticeAssessmentSchema = z.strictObject({
  status: z.enum(['unassessed', 'correct', 'partially-correct', 'incorrect', 'uncertain']),
  evaluator: z.enum(['none', 'human', 'ai']),
  score: z.number().min(0).max(1).nullable(),
  feedback: Text.nullable(),
  limitations: z.array(Text).max(32),
}).refine(value => value.status === 'unassessed' ? value.evaluator === 'none' && value.score === null
  : value.evaluator !== 'none', 'Assessment status and evaluator must agree');

export const LearningPracticeAttemptSchema = z.strictObject({
  version: z.literal(1),
  runId: Id,
  planHash: Hash,
  taskHash: Hash,
  materialHash: Hash,
  chapterBookHash: Hash.nullable(),
  lessonHash: Hash.nullable(),
  ownerId: Text,
  operationId: Id,
  promptId: Id,
  question: Text,
  answer: z.string().min(1).max(16000),
  hints: z.array(PracticeHintSchema).max(32),
  assessment: PracticeAssessmentSchema,
  limitations: z.array(Text).max(32),
  status: z.enum(['draft', 'submitted', 'assessed']),
  previousVersionHash: Hash.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).refine(value => value.status === 'assessed' ? value.assessment.status !== 'unassessed' : value.assessment.status === 'unassessed',
  'Attempt status must match assessment');

export const LearningPracticePageSchema = z.strictObject({
  version: z.literal(1),
  attemptHashes: z.array(Hash).min(1).max(100),
  next: Hash.nullable(),
});

export const LearningPracticeLogSchema = z.strictObject({
  version: z.literal(1),
  runId: Id,
  planHash: Hash,
  taskHash: Hash,
  materialHash: Hash,
  ownerId: Text,
  attemptCount: z.number().int().nonnegative(),
  pageCount: z.number().int().nonnegative(),
  firstPageHash: Hash.nullable(),
  operations: z.record(z.string().min(2).max(80), Hash),
  latestAttemptHash: Hash.nullable(),
});

export const PracticeAppendRequestSchema = z.strictObject({
  operationId: Id,
  expectedRevision: z.number().int().min(0),
  planHash: Hash,
  materialHash: Hash,
  logHash: Hash.nullable(),
  chapterBookHash: Hash.nullable(),
  lessonHash: Hash.nullable(),
  promptId: Id,
  question: Text,
  answer: z.string().min(1).max(16000),
  hints: z.array(PracticeHintSchema).max(32),
  limitations: z.array(Text).max(32),
});

export const PracticeFeedbackRequestSchema = z.strictObject({
  operationId: Id,
  expectedRevision: z.number().int().min(0),
  planHash: Hash,
  materialHash: Hash,
  logHash: Hash,
  attemptHash: Hash,
  feedback: z.strictObject({
    hints: z.array(PracticeHintSchema).max(32).optional(),
    assessment: PracticeAssessmentSchema.optional(),
    limitations: z.array(Text).max(32).optional(),
  }),
});

const fail = (code, message) => { throw new GraphError(code, message); };

function context({ store, material, materialHash, binding }) {
  const selectedHash = materialHash ?? material?.id;
  const body = material?.material ?? material;
  if (!body || !Hash.safeParse(selectedHash).success || body.materialHash && body.materialHash !== selectedHash)
    fail('LEARNING_PRACTICE_BINDING', 'Попытка относится к другому материалу.');
  if (!binding || body.runId !== binding.runId || body.planHash !== binding.planHash || body.taskHash !== binding.taskHash)
    fail('LEARNING_PRACTICE_BINDING', 'Попытка не связана с владельцем материала.');
  const read = readLearningMaterial({ store, materialHash: selectedHash, binding: { ...binding, materialHashes: [selectedHash] } });
  return { ...read, selectedHash };
}

function readLog(store, logHash, binding, selectedHash, ownerId) {
  if (!logHash) return { log: null, attempts: [] };
  const parsed = LearningPracticeLogSchema.safeParse(store.readObject('learning-practice-logs', logHash));
  if (!parsed.success || parsed.data.runId !== binding.runId || parsed.data.planHash !== binding.planHash
    || parsed.data.taskHash !== binding.taskHash || parsed.data.materialHash !== selectedHash || parsed.data.ownerId !== ownerId)
    fail('LEARNING_PRACTICE_BINDING', 'Журнал попыток принадлежит другой задаче или владельцу.');
  const log = parsed.data, pages = [], seen = new Set(); let next = log.firstPageHash;
  while (next) {
    if (seen.has(next) || pages.length >= log.pageCount) fail('LEARNING_PRACTICE_INTEGRITY', 'Журнал попыток содержит цикл или лишние страницы.');
    seen.add(next);
    const page = LearningPracticePageSchema.safeParse(store.readObject('learning-practice-pages', next));
    if (!page.success) fail('LEARNING_PRACTICE_INTEGRITY', 'Страница попыток повреждена.');
    pages.push(page.data); next = page.data.next;
  }
  if (pages.length !== log.pageCount) fail('LEARNING_PRACTICE_INTEGRITY', 'Количество страниц попыток не совпадает.');
  const hashes = pages.flatMap(page => page.attemptHashes);
  if (hashes.length !== log.attemptCount || (hashes[0] ?? null) !== log.latestAttemptHash)
    fail('LEARNING_PRACTICE_INTEGRITY', 'Журнал попыток усечен.');
  const attempts = hashes.map(hash => {
    const attempt = LearningPracticeAttemptSchema.safeParse(store.readObject('learning-practice-attempts', hash));
    if (!attempt.success || attempt.data.runId !== log.runId || attempt.data.materialHash !== log.materialHash || attempt.data.ownerId !== ownerId)
      fail('LEARNING_PRACTICE_INTEGRITY', 'Попытка не совпадает с журналом.');
    return { id: hash, attempt: attempt.data };
  });
  for (const item of attempts) {
    if (log.operations[item.attempt.operationId] !== digestInput(item.attempt))
      fail('LEARNING_PRACTICE_INTEGRITY', 'Индекс idempotency не совпадает с попыткой.');
  }
  return { logHash, log, attempts };
}

function digestInput(attempt) {
  return hashObject({ promptId: attempt.promptId, question: attempt.question, answer: attempt.answer, hints: attempt.hints,
    assessment: attempt.assessment, limitations: attempt.limitations, status: attempt.status, previousVersionHash: attempt.previousVersionHash });
}

/** Append an immutable attempt and return a durable log hash. Replaying the
 * same operationId and payload returns the original log without duplication. */
export function recordLearningPracticeAttempt({ store, material, materialHash, binding, ownerId, logHash = null, attempt, createdAt = now() }) {
  const read = context({ store, material, materialHash, binding });
  const parsed = LearningPracticeAttemptSchema.safeParse({ version: 1, ...attempt, runId: binding.runId, planHash: binding.planHash,
    taskHash: binding.taskHash, materialHash: read.selectedHash, ownerId, createdAt: attempt.createdAt ?? createdAt, updatedAt: attempt.updatedAt ?? createdAt });
  if (!parsed.success) fail('LEARNING_PRACTICE_INVALID', 'Попытка не соответствует схеме.');
  const value = parsed.data;
  const prior = readLog(store, logHash, binding, read.selectedHash, ownerId);
  const digest = digestInput(value);
  const existing = prior.attempts.find(item => item.attempt.operationId === value.operationId);
  if (existing) {
    if (digestInput(existing.attempt) !== digest) fail('LEARNING_PRACTICE_IDEMPOTENCY_CONFLICT', 'operationId уже связан с другим ответом.');
    return { id: prior.logHash, log: prior.log, attempt: existing, idempotent: true };
  }
  if (value.previousVersionHash && !prior.attempts.some(item => item.id === value.previousVersionHash))
    fail('LEARNING_PRACTICE_VERSION', 'Предыдущая версия попытки не принадлежит этому журналу.');
  const attemptHash = store.putObject('learning-practice-attempts', value);
  const page = LearningPracticePageSchema.parse({ version: 1, attemptHashes: [attemptHash], next: prior.log?.firstPageHash ?? null });
  const pageHash = store.putObject('learning-practice-pages', page);
  const operations = { ...(prior.log?.operations ?? {}), [value.operationId]: digest };
  const log = LearningPracticeLogSchema.parse({ version: 1, runId: binding.runId, planHash: binding.planHash, taskHash: binding.taskHash,
    materialHash: read.selectedHash, ownerId, attemptCount: (prior.log?.attemptCount ?? 0) + 1, pageCount: (prior.log?.pageCount ?? 0) + 1,
    firstPageHash: pageHash, operations, latestAttemptHash: attemptHash });
  const nextLogHash = store.putObject('learning-practice-logs', log);
  return { id: nextLogHash, log, attempt: { id: attemptHash, attempt: value }, idempotent: false };
}

/** Feedback is a new immutable version; the original answer remains intact. */
export function recordLearningPracticeFeedback({ store, material, materialHash, binding, ownerId, logHash, attemptHash, feedback, operationId, updatedAt = now() }) {
  const read = context({ store, material, materialHash, binding });
  const prior = readLog(store, logHash, binding, read.selectedHash, ownerId);
  const current = prior.attempts.find(item => item.id === attemptHash);
  if (!current) fail('LEARNING_PRACTICE_NOT_FOUND', 'Попытка не входит в журнал.');
  const assessment = PracticeAssessmentSchema.parse(feedback.assessment ?? current.attempt.assessment);
  const hints = z.array(PracticeHintSchema).max(32).parse(feedback.hints ?? current.attempt.hints);
  const limitations = z.array(Text).max(32).parse(feedback.limitations ?? current.attempt.limitations);
  const value = { ...current.attempt, operationId, hints, assessment, limitations,
    status: assessment.status === 'unassessed' ? 'submitted' : 'assessed', previousVersionHash: current.id, updatedAt };
  return recordLearningPracticeAttempt({ store, material, materialHash: read.selectedHash, binding, ownerId, logHash,
    attempt: value, createdAt: current.attempt.createdAt, });
}

export function readLearningPracticeLog({ store, material, materialHash, binding, ownerId, logHash }) {
  const read = context({ store, material, materialHash, binding });
  return readLog(store, logHash, binding, read.selectedHash, ownerId);
}
