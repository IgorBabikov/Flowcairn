import { z } from 'zod';
import { GraphError, hashObject, sha256 } from './io.mjs';
import { Hash, Id, Text } from './schema-primitives.mjs';
import { LearningJobSchema, LessonMaterialSchema, LessonAnswerSchema, SourceAnchorSchema, StageMaterialSchema } from './learning-schemas.mjs';

export const LearningJobRecordSchema = LearningJobSchema.extend({
  version: z.literal(1), runId: Id, planHash: Hash, taskHash: Hash, operationId: Id, digest: Hash,
  materialBinding: z.strictObject({ runId: Id, planHash: Hash, taskHash: Hash }),
  providerBinding: z.strictObject({ provider: z.string().min(1).max(80), model: z.string().min(1).max(160), toolchainHash: Hash, preflightHash: Hash, policyHash: Hash }),
  methodHash: Hash, inputHash: Hash, schemaHash: Hash, sourcePolicyHash: Hash, preparationHash: Hash, inputObjectHash: Hash, commandHash: Hash, consentHash: Hash,
  ownerPid: z.number().int().min(1), ownerStart: Hash.nullable(), process: z.json().nullable(),
  sequence: z.number().int().min(0),
  question: z.strictObject({ lessonHash: Hash, anchor: SourceAnchorSchema, text: Text }).nullable(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), finishedAt: z.iso.datetime().nullable(),
  previousJobHash: Hash.nullable(),
  termination: z.strictObject({ exitCode: z.number().int().nullable(), stopped: z.boolean(), uncertain: z.boolean(), timedOut: z.boolean(),
    outputLimit: z.boolean(), signal: z.string().nullable(), failureReason: Text.nullable() }).nullable(),
}).refine((record) => record.status === 'ready'
  ? record.result !== null && record.error === null && record.finishedAt !== null && record.termination?.stopped === true && record.termination.uncertain === false &&
    record.termination.exitCode === 0 && !record.termination.failureReason && !record.termination.timedOut && !record.termination.outputLimit && !record.termination.signal
  : record.result === null, 'Result requires validated stopped completion');

const fail = (message) => { throw new GraphError('LEARNING_JOB_INTEGRITY', message); };
function immutableBinding(job) {
  const { status: _status, result: _result, error: _error, process: _process, updatedAt: _updated, finishedAt: _finished,
    previousJobHash: _previous, termination: _termination, ...binding } = job;
  return hashObject(binding);
}
export const publicLearningJob = (record) => LearningJobSchema.parse(Object.fromEntries(
  ['id', 'kind', 'materialHash', 'status', 'result', 'error'].map((key) => [key, record[key]])));

export function readLearningJobs(store, state) {
  if (state.schemaVersion !== 3) return [];
  return Object.entries(state.learning.jobs).map(([id, objectHash]) => {
    const job = LearningJobRecordSchema.parse(store.readObject('learning-jobs', objectHash));
    let previous = job.previousJobHash;
    const visited = new Set([objectHash]);
    while (previous) {
      if (visited.has(previous) || visited.size >= 8) fail('Повреждена цепочка состояний учебной job.');
      visited.add(previous);
      const prior = LearningJobRecordSchema.parse(store.readObject('learning-jobs', previous));
      if (immutableBinding(prior) !== immutableBinding(job) || !['running', 'uncertain'].includes(prior.status) ||
          (prior.process && hashObject(prior.process) !== hashObject(job.process)))
        fail('Неизменяемая привязка учебной job была заменена.');
      previous = prior.previousJobHash;
    }
    const operation = state.operations[job.operationId];
    const material = StageMaterialSchema.parse(store.readObject('learning-materials', job.materialHash));
    if (hashObject(job.materialBinding) !== hashObject({ runId: material.runId, planHash: material.planHash, taskHash: material.taskHash }))
      fail('Учебная job не принадлежит исходному владельцу материала.');
    if (job.id !== id || job.runId !== state.runId || job.planHash !== state.planHash || job.taskHash !== state.taskHash ||
        !operation || operation.digest !== job.digest || operation.status !== 'finished' || operation.preparationHash !== job.inputObjectHash)
      fail('Учебная job не связана с управляющей операцией запуска.');
    const input = store.readObject('operations', job.inputObjectHash);
    if (input.version !== 1 || input.kind !== 'learning-input' || input.inputHash !== job.inputHash || input.methodHash !== job.methodHash ||
        input.materialHash !== job.materialHash || input.schemaHash !== job.schemaHash || input.commandHash !== job.commandHash || input.sourcePolicyHash !== job.sourcePolicyHash ||
        hashObject(input.providerBinding) !== hashObject(job.providerBinding) || hashObject(input.materialBinding) !== hashObject(job.materialBinding) ||
        !Array.isArray(input.promptParts) || input.promptParts.length > 64 || input.promptParts.some((part) => typeof part !== 'string' || part.length > 8000) ||
        Buffer.byteLength(input.promptParts.join('')) > 128 * 1024 || sha256(input.promptParts.join('')) !== job.inputHash)
      fail('Учебная job не связана с закрепленным входом.');
    if (!input.control || hashObject(input.control) !== job.digest || input.control.request?.operationId !== job.operationId ||
        input.control.request?.materialHash !== job.materialHash || input.control.name !== (job.kind === 'lesson' ? 'generate-lesson' : 'ask-lesson') ||
        job.consentHash !== hashObject({ request: input.control.request, actor: input.control.actor, inputObjectHash: job.inputObjectHash,
          providerBinding: job.providerBinding, commandHash: job.commandHash }))
      fail('Учебный вызов не связан с явным разрешением на этот вход и provider.');
    if (job.result) {
      if ((job.kind === 'lesson') !== ('lessonHash' in job.result)) fail('Вид результата не соответствует job.');
      const content = store.readObject('lessons', 'lessonHash' in job.result ? job.result.lessonHash : job.result.answerHash);
      const parsed = (job.kind === 'lesson' ? LessonMaterialSchema : LessonAnswerSchema).parse(content);
      if (parsed.materialHash !== job.materialHash || ('methodHash' in parsed && parsed.methodHash !== job.methodHash))
        fail('Результат job относится к другому материалу или методике.');
    }
    return { hash: objectHash, job };
  }).sort((left, right) => left.job.sequence - right.job.sequence);
}

export function jobProjection(store, state, materialHash) {
  return learningJobProjection(readLearningJobs(store, state), materialHash);
}
export function learningJobProjection(records, materialHash) {
  const entries = records.filter(({ job }) => !materialHash || job.materialHash === materialHash);
  const active = entries.find(({ job }) => job.status === 'running');
  const latest = entries.filter(({ job }) => job.kind === 'lesson').at(-1)?.job;
  const ready = entries.filter(({ job }) => job.kind === 'lesson' && job.status === 'ready').at(-1)?.job;
  return { activeJob: active ? { id: active.job.id, kind: active.job.kind, materialHash: active.job.materialHash } : null,
    lessonHash: ready?.result && 'lessonHash' in ready.result ? ready.result.lessonHash : null,
    lessonStatus: latest ? ({ running: 'generating', ready: 'ready', failed: 'failed', uncertain: 'uncertain' }[latest.status]) : 'absent' };
}
