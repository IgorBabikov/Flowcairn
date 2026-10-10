import type { LearningChapter, LearningChapterBook, LearningObservationResponse, LearningPracticeAttempt, LearningPracticeLog, PracticeAssessment, PracticeHint } from '../contracts';
import { hashContent } from '../plan-identity';
import { assertLearning, choice, hash, id, integer, list, nullable, record, text, uniqueIds } from './validation';

type ChapterRecord = { id: string; chapter: LearningChapter };
const field = (value: Record<string, unknown>, key: string) => value[key];

function anchor(value: unknown): value is LearningChapter['steps'][number]['anchors'][number] {
  if (!record(value)) return false;
  return id(field(value, 'sourceId')) && hash(field(value, 'fileHash')) && integer(field(value, 'startLine'), 1)
    && integer(field(value, 'endLine'), field(value, 'startLine') as number) && text(field(value, 'quote'), 8192);
}
function hint(value: unknown): value is PracticeHint {
  if (!record(value)) return false;
  return id(field(value, 'id')) && text(field(value, 'text')) && text(field(value, 'createdAt'), 64)
    && Number.isFinite(Date.parse(field(value, 'createdAt') as string));
}
function assessment(value: unknown): value is PracticeAssessment {
  if (!record(value)) return false;
  return choice(field(value, 'status'), ['unassessed', 'correct', 'partially-correct', 'incorrect', 'uncertain'])
    && choice(field(value, 'evaluator'), ['none', 'human', 'ai'])
    && nullable(field(value, 'score'), (item): item is number => typeof item === 'number' && item >= 0 && item <= 1)
    && nullable(field(value, 'feedback'), text) && list(field(value, 'limitations'), text, 32);
}
function step(value: unknown): value is LearningChapter['steps'][number] {
  if (!record(value)) return false;
  const origin = field(value, 'origin');
  return id(field(value, 'id')) && text(field(value, 'title'), 160) && text(field(value, 'caller')) && list(field(value, 'anchors'), anchor, 20)
    && (field(value, 'anchors') as unknown[]).length > 0 && list(field(value, 'coverageEntryIds'), id, 128) && list(field(value, 'dependencyEntryIds'), id, 128)
    && text(field(value, 'input')) && list(field(value, 'transformations'), text, 64) && (field(value, 'transformations') as unknown[]).length > 0
    && text(field(value, 'output')) && nullable(field(value, 'next'), id) && text(field(value, 'purpose')) && text(field(value, 'changeConsequence'))
    && list(field(value, 'alternatives'), text, 20) && record(origin)
    && choice(field(origin, 'kind'), ['manual-trace', 'test-fixture', 'teaching-example', 'runtime-observation'])
    && text(field(origin, 'label')) && list(field(origin, 'observationIds'), hash, 32);
}
function edge(value: unknown): value is LearningChapter['flowEdges'][number] {
  if (!record(value)) return false;
  return id(field(value, 'id')) && id(field(value, 'from')) && id(field(value, 'to'))
    && choice(field(value, 'kind'), ['calls', 'returns', 'branches', 'reads', 'writes', 'depends-on', 'hands-off'])
    && nullable(field(value, 'label'), text) && list(field(value, 'anchors'), anchor, 8);
}
function chapter(value: unknown): value is LearningChapter {
  if (!record(value)) return false;
  const steps = field(value, 'steps');
  return field(value, 'version') === 1 && hash(field(value, 'materialHash')) && integer(field(value, 'order'), 1) && text(field(value, 'title'), 160)
    && text(field(value, 'scope')) && list(field(value, 'coverageEntryIds'), id, 256) && list(field(value, 'dependencyEntryIds'), id, 256)
    && list(field(value, 'flowNodeIds'), id, 256) && list(field(value, 'flowEdges'), edge, 512) && list(steps, step, 64)
    && (steps as unknown[]).length > 0 && uniqueIds(steps as Array<{ id: string }>) && text(field(value, 'wholeFlow')) && list(field(value, 'limitations'), text, 64);
}
function chapterRef(value: unknown): value is { id: string; order: number; title: string } {
  if (!record(value)) return false;
  return hash(field(value, 'id')) && integer(field(value, 'order'), 1) && text(field(value, 'title'), 160);
}
function chapterRecord(value: unknown): value is ChapterRecord {
  if (!record(value)) return false;
  return hash(field(value, 'id')) && chapter(field(value, 'chapter'));
}
function attempt(value: unknown): value is LearningPracticeAttempt {
  if (!record(value)) return false;
  const body = field(value, 'attempt');
  if (!record(body)) return false;
  const answer = field(body, 'answer');
  return hash(field(value, 'id')) && field(body, 'version') === 1 && id(field(body, 'runId')) && hash(field(body, 'planHash')) && hash(field(body, 'taskHash'))
    && hash(field(body, 'materialHash')) && nullable(field(body, 'chapterBookHash'), hash) && nullable(field(body, 'lessonHash'), hash)
    && text(field(body, 'ownerId')) && id(field(body, 'operationId')) && id(field(body, 'promptId')) && text(field(body, 'question'))
    && typeof answer === 'string' && answer.length > 0 && answer.length <= 16000 && list(field(body, 'hints'), hint, 32)
    && assessment(field(body, 'assessment')) && list(field(body, 'limitations'), text, 32) && choice(field(body, 'status'), ['draft', 'submitted', 'assessed'])
    && nullable(field(body, 'previousVersionHash'), hash) && text(field(body, 'createdAt'), 64) && text(field(body, 'updatedAt'), 64)
    && Number.isFinite(Date.parse(field(body, 'createdAt') as string)) && Number.isFinite(Date.parse(field(body, 'updatedAt') as string));
}

export async function decodeLearningChapterBook(value: unknown, materialHash: string, bookHash?: string): Promise<LearningChapterBook> {
  assertLearning(record(value));
  const book = field(value, 'book');
  const chapters = field(value, 'chapters');
  assertLearning(record(book));
  assertLearning(hash(field(value, 'id')) && (!bookHash || field(value, 'id') === bookHash) && field(book, 'version') === 1 && field(book, 'materialHash') === materialHash
    && integer(field(book, 'chapterCount'), 1) && integer(field(book, 'pageCount'), 1) && nullable(field(book, 'firstPageHash'), hash)
    && list(field(book, 'chapters'), chapterRef, 10000) && list(chapters, chapterRecord, 10000)
    && (chapters as unknown[]).length === field(book, 'chapterCount') && (field(book, 'chapters') as unknown[]).length === field(book, 'chapterCount')
    && uniqueIds(chapters as Array<{ id: string }>));
  const response = value as unknown as LearningChapterBook;
  const effectiveHash = bookHash ?? response.id;
  assertLearning(await hashContent(response.book) === effectiveHash, 'Книга глав не соответствует сохраненному хешу.');
  for (const item of response.chapters) assertLearning(item.chapter.materialHash === materialHash && await hashContent(item.chapter) === item.id, 'Глава не соответствует сохраненной версии.');
  return response;
}

export async function decodeLearningChapter(value: unknown, materialHash: string, chapterHash: string): Promise<ChapterRecord> {
  assertLearning(record(value) && field(value, 'id') === chapterHash && chapter(field(value, 'chapter'))
    && (field(value, 'chapter') as LearningChapter).materialHash === materialHash);
  const response = value as unknown as ChapterRecord;
  assertLearning(await hashContent(response.chapter) === chapterHash, 'Глава не соответствует сохраненному хешу.');
  return response;
}

export async function decodeLearningObservation(value: unknown, materialHash: string, observationHash: string): Promise<LearningObservationResponse> {
  assertLearning(record(value) && field(value, 'id') === observationHash && record(field(value, 'observation')));
  const observation = field(value, 'observation') as Record<string, unknown>;
  const redaction = field(observation, 'redaction');
  assertLearning(field(observation, 'version') === 1 && field(observation, 'materialHash') === materialHash && id(field(observation, 'runId'))
    && hash(field(observation, 'planHash')) && hash(field(observation, 'taskHash')) && id(field(observation, 'chapterId')) && id(field(observation, 'stepId'))
    && id(field(observation, 'extractorId')) && hash(field(observation, 'extractorHash')) && nullable(field(observation, 'commandHash'), hash)
    && nullable(field(observation, 'fixtureHash'), hash) && hash(field(observation, 'inputHash')) && hash(field(observation, 'outputHash'))
    && hash(field(observation, 'sourceHash')) && list(field(observation, 'sourceAnchors'), anchor, 32)
    && nullable(field(observation, 'value'), (item): item is string => typeof item === 'string' && item.length <= 8192)
    && record(redaction) && field(redaction, 'version') === 1 && field(redaction, 'applied') === true && hash(field(redaction, 'rulesHash'))
    && list(field(redaction, 'removedFields'), text, 128) && hash(field(observation, 'receiptId'))
    && choice(field(observation, 'status'), ['observed', 'missing', 'uncertain']) && nullable(field(observation, 'limitation'), text)
    && text(field(observation, 'createdAt'), 64) && Number.isFinite(Date.parse(field(observation, 'createdAt') as string)) && record(field(value, 'extractor'))
    && choice(field(value, 'freshness'), ['current', 'stale']));
  return value as unknown as LearningObservationResponse;
}

export async function decodeLearningPracticeLog(value: unknown, materialHash: string, logHash: string): Promise<LearningPracticeLog> {
  assertLearning(record(value) && field(value, 'logHash') === logHash && record(field(value, 'log')));
  const log = field(value, 'log') as Record<string, unknown>;
  const attempts = field(value, 'attempts');
  assertLearning(field(log, 'version') === 1 && field(log, 'materialHash') === materialHash && id(field(log, 'runId')) && hash(field(log, 'planHash'))
    && hash(field(log, 'taskHash')) && text(field(log, 'ownerId')) && integer(field(log, 'attemptCount')) && integer(field(log, 'pageCount'))
    && nullable(field(log, 'firstPageHash'), hash) && record(field(log, 'operations')) && list(attempts, attempt, 10000)
    && (attempts as unknown[]).length === field(log, 'attemptCount'));
  const response = value as unknown as LearningPracticeLog;
  for (const item of response.attempts) assertLearning(item.attempt.materialHash === materialHash && await hashContent(item.attempt) === item.id, 'Попытка не соответствует сохраненному хешу.');
  return response;
}

export async function decodePracticeMutation(value: unknown, materialHash: string): Promise<{ logHash: string; attemptHash: string; attempt: LearningPracticeAttempt['attempt']; idempotent: boolean }> {
  assertLearning(record(value) && hash(field(value, 'logHash')) && record(field(value, 'attempt')) && typeof field(value, 'idempotent') === 'boolean');
  const wrapper = field(value, 'attempt') as Record<string, unknown>;
  assertLearning(attempt(wrapper));
  const item = wrapper as unknown as LearningPracticeAttempt;
  assertLearning(item.attempt.materialHash === materialHash && await hashContent(item.attempt) === item.id, 'Сохраненная попытка не соответствует хешу.');
  return { logHash: field(value, 'logHash') as string, attemptHash: item.id, attempt: item.attempt, idempotent: field(value, 'idempotent') as boolean };
}
