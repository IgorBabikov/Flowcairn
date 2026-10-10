import { z } from 'zod';
import { GraphError, hashObject } from './io.mjs';
import { Hash, Id, RelativePath, Text } from './schema-primitives.mjs';
import { ReceiptSchema } from './schemas.mjs';
import { SourceAnchorSchema } from './learning-schemas.mjs';
import { readLearningMaterial } from './learning-material.mjs';
import { savedSourceAnchor } from './learning-sources.mjs';
import { assertSafeText } from './source-policy.mjs';

export const ObservationRedactionSchema = z.strictObject({
  version: z.literal(1),
  applied: z.boolean(),
  rulesHash: Hash,
  removedFields: z.array(Text).max(128),
});

export const ObservationCommandSchema = z.strictObject({
  executable: Text,
  argv: z.array(Text).max(64),
  cwd: RelativePath.nullable(),
});

export const ObservationExtractorSchema = z.strictObject({
  version: z.literal(1),
  id: Id,
  label: Text,
  command: ObservationCommandSchema.nullable(),
  fixtureId: Id.nullable(),
  fixtureHash: Hash.nullable(),
  outputSchemaHash: Hash,
  redaction: ObservationRedactionSchema,
  definitionHash: Hash,
}).refine(value => value.command !== null || value.fixtureId !== null,
  'Extractor must declare a command or fixture identity');

export const LearningObservationSchema = z.strictObject({
  version: z.literal(1),
  runId: Id,
  planHash: Hash,
  taskHash: Hash,
  materialHash: Hash,
  chapterId: Id,
  stepId: Id,
  extractorId: Id,
  extractorHash: Hash,
  commandHash: Hash.nullable(),
  fixtureHash: Hash.nullable(),
  inputHash: Hash,
  outputHash: Hash,
  sourceHash: Hash,
  sourceAnchors: z.array(SourceAnchorSchema).min(1).max(32),
  value: z.string().max(8192).nullable(),
  redaction: ObservationRedactionSchema,
  receiptId: Hash,
  status: z.enum(['observed', 'missing', 'uncertain']),
  limitation: Text.nullable(),
  createdAt: z.iso.datetime(),
}).refine(value => value.status === 'observed' ? value.value !== null && value.limitation === null : value.value === null && value.limitation !== null,
  'Observation status must match its value and limitation');

export const ObservationRecordSchema = z.strictObject({
  id: Hash,
  observation: LearningObservationSchema,
});

const fail = (code, message) => { throw new GraphError(code, message); };

function materialContext({ store, material, materialHash, binding, policy = {} }) {
  const selectedHash = materialHash ?? material?.id;
  const body = material?.material ?? material;
  if (!body || !Hash.safeParse(selectedHash).success || body.materialHash && body.materialHash !== selectedHash)
    fail('LEARNING_OBSERVATION_BINDING', 'Наблюдение относится к другому материалу.');
  if (!binding || binding.runId !== body.runId || binding.planHash !== body.planHash || binding.taskHash !== body.taskHash)
    fail('LEARNING_OBSERVATION_BINDING', 'Наблюдение не связано с владельцем материала.');
  const read = readLearningMaterial({ store, materialHash: selectedHash, binding: { ...binding, materialHashes: [selectedHash] }, policy });
  return { ...read, selectedHash };
}

function verifyReceipt(store, id, binding, { allowFailure = false } = {}) {
  const parsed = ReceiptSchema.safeParse(store.readObject('receipts', id));
  if (!parsed.success) fail('LEARNING_OBSERVATION_RECEIPT', 'Extractor receipt поврежден.');
  const receipt = parsed.data;
  if (receipt.runId !== binding.runId || receipt.planHash !== binding.planHash || receipt.taskHash !== binding.taskHash
    || receipt.phase !== 'finished' || (!allowFailure && (receipt.verdict !== 'pass' || receipt.exitCode !== 0))
    || (!allowFailure && receipt.termination?.uncertain) || (!allowFailure && receipt.termination?.stopped !== true))
    fail('LEARNING_OBSERVATION_RECEIPT', 'Extractor receipt не подтверждает заявленное наблюдение.');
  return receipt;
}

/** Register the extractor definition once. Raw command output is never stored. */
export function registerObservationExtractor({ store, id, label, command = null, fixtureId = null, fixtureHash = null,
  outputSchemaHash = hashObject('opaque-output'), redaction = { version: 1, applied: true, rulesHash: hashObject('default-redaction'), removedFields: [] } }) {
  const body = { version: 1, id, label, command, fixtureId, fixtureHash, outputSchemaHash, redaction };
  const definitionHash = hashObject(body);
  const definition = ObservationExtractorSchema.parse({ ...body, definitionHash });
  const hash = store.putObject('learning-observation-extractors', definition);
  return { id: hash, extractor: definition };
}

function loadExtractor(store, extractorHash) {
  const parsed = ObservationExtractorSchema.safeParse(store.readObject('learning-observation-extractors', extractorHash));
  if (!parsed.success) fail('LEARNING_EXTRACTOR_INVALID', 'Extractor не зарегистрирован или поврежден.');
  const { definitionHash, ...body } = parsed.data;
  if (definitionHash !== hashObject(body)) fail('LEARNING_EXTRACTOR_INVALID', 'Extractor definition hash не совпадает.');
  return parsed.data;
}

function validateObservation({ store, observation, extractorHash, extractor, context, binding, policy = {} }) {
  const parsed = LearningObservationSchema.safeParse(observation);
  if (!parsed.success) fail('LEARNING_OBSERVATION_INVALID', 'Наблюдение не соответствует схеме.');
  const value = parsed.data;
  if (value.runId !== binding.runId || value.planHash !== binding.planHash || value.taskHash !== binding.taskHash || value.materialHash !== context.selectedHash)
    fail('LEARNING_OBSERVATION_BINDING', 'Наблюдение не связано с запуском и материалом.');
  if (value.extractorHash !== extractorHash || value.extractorId !== extractor.id)
    fail('LEARNING_EXTRACTOR_INVALID', 'Наблюдение ссылается на другой extractor.');
  if (value.sourceHash !== context.material.resultHash)
    fail('LEARNING_OBSERVATION_STALE', 'Наблюдение относится к устаревшей версии исходника.');
  if (value.commandHash !== (extractor.command ? hashObject(extractor.command) : null) || value.fixtureHash !== extractor.fixtureHash)
    fail('LEARNING_EXTRACTOR_INVALID', 'Команда или fixture observation не совпадают с registry.');
  if (hashObject(value.redaction) !== hashObject(extractor.redaction) || !value.redaction.applied)
    fail('LEARNING_REDACTION_REQUIRED', 'Наблюдение должно содержать результат зарегистрированной redaction policy.');
  assertSafeText(JSON.stringify(value));
  const sourceMap = new Map(context.sources.map(source => [source.id, source]));
  value.sourceAnchors.forEach(anchor => {
    const source = sourceMap.get(anchor.sourceId);
    if (!source) fail('LEARNING_OBSERVATION_ANCHOR', 'Наблюдение содержит чужую source anchor.');
    savedSourceAnchor(store, source, anchor, policy);
  });
  const receipt = verifyReceipt(store, value.receiptId, binding, { allowFailure: value.status !== 'observed' });
  if (value.status === 'observed' && (receipt.verdict !== 'pass' || receipt.exitCode !== 0 || receipt.finishedAt === null
    || !receipt.termination || receipt.termination.stopped !== true || receipt.termination.uncertain
    || receipt.termination.timedOut || receipt.termination.outputLimit || receipt.termination.signal !== null))
    fail('LEARNING_OBSERVATION_RECEIPT', 'Observed value требует успешный extractor receipt.');
  return value;
}

/** Persist only an extractor-bound value. Missing/uncertain observations keep
 * the reason and receipt, never a fabricated value. Repeating the same input
 * is naturally idempotent because the object hash is immutable. */
export function recordLearningObservation({ store, material, materialHash, binding, extractorHash, observation, policy = {} }) {
  const context = materialContext({ store, material, materialHash, binding, policy });
  const extractor = loadExtractor(store, extractorHash);
  const value = validateObservation({ store, observation, extractorHash, extractor, context, binding, policy });
  const id = store.putObject('learning-observations', value);
  return { id, observation: value, extractor };
}

export function readLearningObservation({ store, material, materialHash, binding, observationHash, policy = {}, allowStale = false }) {
  const context = materialContext({ store, material, materialHash, binding, policy });
  const value = LearningObservationSchema.parse(store.readObject('learning-observations', observationHash));
  const extractor = loadExtractor(store, value.extractorHash);
  if (value.sourceHash !== context.material.resultHash && !allowStale) fail('LEARNING_OBSERVATION_STALE', 'Наблюдение относится к устаревшему материалу.');
  validateObservation({ store, observation: value, extractorHash: value.extractorHash, extractor, context: { ...context, material: { ...context.material, resultHash: value.sourceHash } }, binding, policy });
  return { id: observationHash, observation: value, extractor, freshness: value.sourceHash === context.material.resultHash ? 'current' : 'stale' };
}

export { validateObservation as validateLearningObservation };
