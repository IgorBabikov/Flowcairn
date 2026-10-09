import { GraphError, hashObject, now, sha256 } from './io.mjs';
import { AskLessonSchema, GenerateLessonSchema, LessonAnswerSchema, LearningLessonResponseSchema } from './learning-schemas.mjs';
import { LearningJobRecordSchema, readLearningJobs, publicLearningJob, learningJobProjection } from './learning-job-state.mjs';
import { learningMaterialContext } from './learning-view.mjs';
import { readLearningMaterial, validateLearningSourceAnchor } from './learning-material.mjs';
import { validateLessonMaterial } from './lesson-validation.mjs';
import { readLearningMethod } from './learning-prompt.mjs';
import { privateDirectory } from './service-adapters.mjs';
import path from 'node:path';

const fail = (code, message) => { throw new GraphError(code, message); };
const active = (job) => ['running', 'uncertain'].includes(job.status);
const completionFields = (result) => ({ exitCode: result?.exitCode ?? null, stopped: result?.stopped === true,
  uncertain: result?.uncertain !== false, timedOut: result?.timedOut === true, outputLimit: result?.outputLimit === true,
  signal: result?.signal ?? null, failureReason: result?.failureReason ?? null });
const jobIdFor = (runId, operationId) => `job-${hashObject({ runId, operationId }).slice(0, 32)}`;

/** A learning-only controller using the existing store, CAS and supervised runner. */
export class LearningJobs {
  constructor(host) { this.host = host; this.tasks = new Map(); this.preparations = new Map(); }
  get busy() { return this.tasks.size > 0 || this.preparations.size > 0; }
  #read(runId) { return this.host.read(runId, { current: false, verifySource: false, verifyBinding: false }); }
  #sources(runId, materialHash) {
    const context = learningMaterialContext(this.host, runId, materialHash);
    readLearningMaterial(context.options);
    return context;
  }
  #history(state) { return [...this.host.executionHistory(state), this.#read(state.runId)]; }
  #records(state) { return this.#history(state).flatMap((source) => readLearningJobs(this.host.store, source.state)); }
  projection(state, materialHash = null) {
    return learningJobProjection(materialHash ? this.#records(state) : readLearningJobs(this.host.store, state), materialHash);
  }
  capability(state, materialHash, kind = 'lesson') {
    try {
      if (state.schemaVersion !== 3 || state.setupPending || this.host.store.inspectLock(state.runId))
        return { allowed: false, reason: 'Запуск еще не подготовлен для учебного действия.' };
      if (this.preparations.has(state.runId) || readLearningJobs(this.host.store, state).some(({ job }) => active(job)))
        return { allowed: false, reason: 'В этом запуске уже есть активная или неопределенная учебная job.' };
      if (kind === 'lesson' && this.#records(state).filter(({ job }) => job.kind === 'lesson' && job.materialHash === materialHash).length >= 3)
        return { allowed: false, reason: 'Использованы первоначальный разбор и два явных повторных запроса.' };
      const runner = this.host.runner();
      return runner?.capability() ?? { allowed: false, reason: 'Учебный runner еще не подключен.' };
    } catch (error) { return { allowed: false, reason: this.host.safeReason(error) }; }
  }
  async start(runId, name, body, actor) {
    const request = (name === 'generate-lesson' ? GenerateLessonSchema : AskLessonSchema).parse(body);
    const digest = hashObject({ name, request, actor });
    if (this.#read(runId).state.operations[request.operationId]) return this.#start(runId, name, request, actor, digest);
    const pending = this.preparations.get(runId);
    if (pending) {
      if (pending.digest !== digest) fail('CONTROL_DENIED', 'Учебный запрос уже готовится.');
      return pending.promise;
    }
    const promise = this.#start(runId, name, request, actor, digest);
    this.preparations.set(runId, { digest, promise });
    try { return await promise; } finally { this.preparations.delete(runId); }
  }
  async #start(runId, name, request, actor, digest) {
    const { state } = this.#read(runId), id = jobIdFor(runId, request.operationId);
    if (state.schemaVersion !== 3) fail('CONTROL_DENIED', 'Учебная job требует запуск V3.');
    const prior = state.operations[request.operationId];
    if (prior) {
      if (prior.digest !== digest) fail('IDEMPOTENCY_CONFLICT', 'operationId относится к другому запросу.');
      if (!state.learning.jobs[id]) fail('LEARNING_JOB_INTEGRITY', 'Не найдена job завершенной управляющей операции.');
      return { jobId: id, snapshot: this.host.snapshot(runId) };
    }
    if (state.revision !== request.expectedRevision) fail('REVISION_CONFLICT', 'Откройте актуальное состояние.');
    if (state.planHash !== request.planHash) fail('PLAN_CONFLICT', 'Запрос относится к другому плану.');
    if (Object.keys(state.operations).length >= 200 || state.learning.eventIds.length >= 200) fail('OPERATION_LIMIT', 'Лимит управляющих операций исчерпан.');
    const kind = name === 'generate-lesson' ? 'lesson' : 'question';
    const capability = this.capability(state, request.materialHash, kind);
    if (!capability.allowed) fail('CONTROL_DENIED', capability.reason);
    const context = this.#sources(runId, request.materialHash);
    if (kind === 'question') this.readObject(runId, 'lesson', request.lessonHash, request.materialHash);
    const input = { ...context.options, methodHash: readLearningMethod().hash,
      ...(kind === 'question' ? { question: { lessonHash: request.lessonHash, anchor: request.anchor, text: request.question } } : {}) };
    const runner = this.host.runner();
    let handle, reservedJob, committed = false;
    try {
      handle = await runner.prepare(input);
      runner.beforeGo(handle);
      if (sha256(handle.input) !== handle.inputHash || handle.materialHash !== request.materialHash || handle.methodHash !== input.methodHash || handle.kind !== kind ||
          Buffer.byteLength(handle.input) > 128 * 1024)
        fail('LEARNING_PREPARATION_INVALID', 'Учебный вход не соответствует закрепленному материалу и лимиту транспорта.');
      // Preparation may await preflight; never overwrite a newer revision or a concurrent job.
      const fresh = this.#read(runId).state;
      if (fresh.revision !== state.revision || readLearningJobs(this.host.store, fresh).some(({ job }) => active(job)))
        fail('REVISION_CONFLICT', 'Запуск изменился во время подготовки учебного вызова.');
      const currentSources = this.#sources(runId, request.materialHash);
      if (hashObject(currentSources.options.policy) !== hashObject(input.policy)) fail('LEARNING_POLICY_DRIFT', 'Политика изменилась во время подготовки.');
      const materialBinding = { runId: context.owner.state.runId, planHash: context.owner.state.planHash, taskHash: context.owner.state.taskHash };
      const commandHash = hashObject(handle.command);
      const sourcePolicyHash = hashObject(input.policy);
      const promptParts = [];
      for (let offset = 0; offset < handle.input.length; offset += 8000) promptParts.push(handle.input.slice(offset, offset + 8000));
      const inputObjectHash = this.host.store.putObject('operations', { version: 1, kind: 'learning-input', promptParts,
        inputHash: handle.inputHash, schemaHash: handle.schemaHash, methodHash: handle.methodHash, materialHash: request.materialHash,
        materialBinding, providerBinding: handle.providerBinding, commandHash, sourcePolicyHash, control: { name, request, actor } });
      const stamp = now();
      const job = LearningJobRecordSchema.parse({ version: 1, id, kind, materialHash: request.materialHash, status: 'running', result: null, error: null,
        runId, planHash: state.planHash, taskHash: state.taskHash, operationId: request.operationId, digest, materialBinding,
        providerBinding: handle.providerBinding, methodHash: handle.methodHash, inputHash: handle.inputHash, schemaHash: handle.schemaHash,
        preparationHash: handle.preparationHash, inputObjectHash, commandHash, sourcePolicyHash,
        consentHash: hashObject({ request, actor, inputObjectHash, providerBinding: handle.providerBinding, commandHash }),
        ownerPid: process.pid, ownerStart: this.host.ownerStart, sequence: state.revision + 1, process: null,
        question: input.question ?? null, createdAt: stamp, updatedAt: stamp, finishedAt: null, previousJobHash: null, termination: null });
      reservedJob = job;
      const jobHash = this.host.store.putObject('learning-jobs', job);
      const eventId = this.host.store.putObject('learning-events', { version: 1, runId, planHash: state.planHash, taskHash: state.taskHash,
        name, request, actor, createdAt: stamp });
      this.host.write(state, { learning: { ...state.learning, jobs: { ...state.learning.jobs, [id]: jobHash }, eventIds: [...state.learning.eventIds, eventId] },
        operations: { ...state.operations, [request.operationId]: { digest, status: 'finished', preparationHash: inputObjectHash } } });
      committed = true;
      const task = new Promise((resolve) => setImmediate(resolve)).then(() => this.#execute(job, handle, runner));
      this.tasks.set(id, task);
      // Failures stay in durable job state; this promise never schedules another paid call.
      task.catch(() => {}).finally(() => this.tasks.delete(id));
      return { jobId: id, snapshot: this.host.snapshot(runId) };
    } catch (error) {
      // A reservation pointer may commit before its write reports an I/O failure.
      // No dispatch happened: retain the operation identity but never auto-start it.
      if (reservedJob && !committed) {
        try {
          const latest = this.#read(runId).state;
          const persisted = readLearningJobs(this.host.store, latest).find(({ job }) => job.id === id)?.job;
          if (persisted?.digest === digest && persisted.status === 'running' && !persisted.process)
            this.#update(reservedJob, { status: 'failed', result: null, finishedAt: now(),
              error: { code: 'LEARNING_RESERVATION_INTERRUPTED', message: 'Запуск не состоялся из-за ошибки сохранения. Автоматический повтор не выполняется.' } });
        } catch { /* Preserve the original storage failure; startup never replays inference. */ }
      }
      throw error;
    } finally { if (handle && !committed) runner.dispose(handle, { stopped: true }); }
  }
  #update(job, update) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const { state } = this.#read(job.runId);
      const entry = readLearningJobs(this.host.store, state).find(({ job: current }) => current.id === job.id);
      if (!entry || !active(entry.job) || entry.job.digest !== job.digest || entry.job.inputHash !== job.inputHash ||
          entry.job.ownerPid !== job.ownerPid || entry.job.ownerStart !== job.ownerStart)
        fail('LEARNING_JOB_FENCED', 'Учебный вызов больше не владеет этой job.');
      if (entry.job.process && update.process && hashObject(entry.job.process) !== hashObject(update.process))
        fail('LEARNING_JOB_FENCED', 'Процесс учебной job уже закреплен.');
      const next = LearningJobRecordSchema.parse({ ...entry.job, ...update, updatedAt: now(), previousJobHash: entry.hash });
      const nextHash = this.host.store.putObject('learning-jobs', next);
      try {
        this.host.write(state, { learning: { ...state.learning, jobs: { ...state.learning.jobs, [job.id]: nextHash } } });
        return next;
      } catch (error) { if (error.code !== 'REVISION_CONFLICT' && error.code !== 'CAS_CONFLICT') throw error; }
    }
    fail('CAS_CONFLICT', 'Состояние изменяется; результат job не был опубликован.');
  }
  async #execute(job, handle, runner) {
    let completion = null, stopped = false, executionInvoked = false;
    try {
      privateDirectory(path.join(this.host.root, '.ai-orchestrator', 'graph'), 'runner-tickets');
      executionInvoked = true;
      completion = completionFields(await runner.execute(handle, {
        onStart: (process) => { this.#update(job, { process }); },
        beforeGo: () => {
          const { state } = this.#read(job.runId);
          const current = readLearningJobs(this.host.store, state).find(({ job: current }) => current.id === job.id)?.job;
          if (!current || current.status !== 'running' || current.inputHash !== job.inputHash || current.digest !== job.digest || !current.process)
            fail('LEARNING_JOB_FENCED', 'Учебная job не владеет запуском.');
          const context = this.#sources(job.runId, job.materialHash);
          if (hashObject(context.options.policy) !== job.sourcePolicyHash) fail('LEARNING_POLICY_DRIFT', 'Политика исходников изменилась до запуска.');
          if (readLearningMethod().hash !== job.methodHash) fail('LEARNING_METHOD_DRIFT', 'Методика изменилась до запуска.');
          runner.beforeGo(handle);
          if (hashObject(handle.command) !== job.commandHash || sha256(handle.input) !== job.inputHash) fail('LEARNING_PREPARATION_CHANGED', 'Учебный вход изменился.');
        },
      }));
      stopped = completion.stopped && !completion.uncertain;
      if (!stopped || completion.exitCode !== 0 || completion.failureReason || completion.timedOut || completion.outputLimit || completion.signal)
        fail('LEARNING_PROVIDER_INCOMPLETE', 'Учебный вызов не подтвердил успешное завершение.');
      const context = this.#sources(job.runId, job.materialHash);
      const output = runner.parse(handle, completion, context.options.policy);
      if (job.kind === 'lesson') validateLessonMaterial({ ...context.options, methodHash: job.methodHash, lesson: output });
      else {
        LessonAnswerSchema.parse(output);
        if (output.materialHash !== job.materialHash || output.lessonHash !== job.question.lessonHash || output.question !== job.question.text ||
            hashObject(output.anchor) !== hashObject(job.question.anchor)) fail('LEARNING_JOB_INTEGRITY', 'Ответ не связан с исходным вопросом.');
        for (const anchor of [output.anchor, ...output.anchors]) validateLearningSourceAnchor({ ...context.options, anchor });
      }
      const resultHash = this.host.store.putObject('lessons', output);
      this.#update(job, { status: 'ready', result: job.kind === 'lesson' ? { lessonHash: resultHash } : { answerHash: resultHash },
        error: null, termination: completion, finishedAt: now() });
    } catch (error) {
      this.#update(job, { status: executionInvoked && !stopped ? 'uncertain' : 'failed', result: null,
        error: { code: typeof error.code === 'string' ? error.code.slice(0, 80) : 'LEARNING_JOB_FAILED', message: this.host.safeReason(error).slice(0, 4000) },
        termination: completion, finishedAt: now() });
    } finally { if (stopped || !executionInvoked) runner.dispose(handle, { stopped: true }); }
  }
  readObject(runId, kind, id, expectedMaterial = null) {
    const { state } = this.#read(runId);
    const entry = this.#records(state).find(({ job }) => kind === 'job' ? job.id === id :
      job.status === 'ready' && job.result && (kind === 'lesson' ? 'lessonHash' in job.result && job.result.lessonHash === id : 'answerHash' in job.result && job.result.answerHash === id));
    if (!entry) fail('NOT_FOUND', 'Учебный объект не закреплен за этим запуском и его историей.');
    const { job } = entry, context = this.#sources(runId, job.materialHash);
    if (expectedMaterial && job.materialHash !== expectedMaterial) fail('LEARNING_MATERIAL_DENIED', 'Объект относится к другому материалу.');
    if (kind === 'job') return publicLearningJob(job);
    const content = this.host.store.readObject('lessons', id);
    if (kind === 'lesson') {
      const lesson = validateLessonMaterial({ ...context.options, methodHash: job.methodHash, lesson: content });
      return LearningLessonResponseSchema.parse({ id, lesson });
    }
    const answer = LessonAnswerSchema.parse(content);
    if (answer.materialHash !== job.materialHash || answer.lessonHash !== job.question?.lessonHash || answer.question !== job.question?.text ||
        hashObject(answer.anchor) !== hashObject(job.question?.anchor)) fail('LEARNING_JOB_INTEGRITY', 'Ответ не соответствует закрепленному вопросу.');
    for (const anchor of [answer.anchor, ...answer.anchors]) validateLearningSourceAnchor({ ...context.options, anchor });
    return answer;
  }
  async reconcileInterrupted() {
    for (const runId of this.host.store.listRunIds()) {
      const raw = this.host.store.readRun(runId);
      if (raw.schemaVersion !== 3) continue;
      let state;
      try { state = this.#read(runId).state; } catch { continue; } // An unreadable run remains blocked; never dispatch during recovery.
      for (const { job } of readLearningJobs(this.host.store, state)) {
        if (!active(job) || !this.host.orphan({ activeOperation: { ownerPid: job.ownerPid, ownerStart: job.ownerStart } })) continue;
        let stopped = false, termination = job.termination;
        if (job.process) {
          try {
            const proof = await this.host.inspectProcess(job.process);
            stopped = proof.stopped === true && proof.uncertain !== true;
            if (stopped) termination = completionFields({ ...proof, exitCode: proof.result?.exitCode ?? null, uncertain: false });
          } catch { /* Unknown is never success. */ }
        }
        if (!stopped && job.process && job.status === 'uncertain') continue;
        this.#update(job, { status: stopped || !job.process ? 'failed' : 'uncertain', result: null, finishedAt: now(),
          termination, error: { code: 'LEARNING_INTERRUPTED', message: 'Учебный вызов был прерван. Автоматический повтор не выполняется.' } });
      }
    }
  }
}
