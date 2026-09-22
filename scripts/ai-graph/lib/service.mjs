import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import * as ProjectPolicy from './project.mjs';
import { projectContextPaths } from './project.mjs';
import { spawnSync } from 'node:child_process';
import { GraphError, hashObject, sha256, now } from './io.mjs';
import { GraphStore } from './store.mjs';
import { defaultAdapters, privateDirectory, sanitizeText } from './service-adapters.mjs';
export { runtimeIdentity, sanitizeText } from './service-adapters.mjs';
import { compilePlanningPlan } from './planning.mjs';
import { projectSummary } from './intake.mjs';
import { buildTaskContext, initialTaskContext } from './task-context.mjs';
import { resolveContextRequests } from './context-discovery.mjs';
import { resultKind } from './result-classification.mjs';
import { buildTaskContract } from './task-contract.mjs';
import { createTaskProofService } from './task-proof-service.mjs';
import { executeNode } from './node-execution.mjs';
import { recoverRun } from './service-recovery.mjs';
import { replanRun, finishReplan } from './service-replan.mjs';
import { projectSnapshot } from './task-snapshot.mjs';
import { validateRequirementAcceptances } from './requirement-verification.mjs';
import { acquireRuntimeLease } from './lifecycle.mjs';
import {
  TaskInputSchema,
  TaskSpecSchema,
  PlanningEnvelopeSchema,
  ControlRequestSchema,
  ReceiptSchema,
  RequirementAcceptanceReceiptSchema,
  RunStateSchema,
  ArtifactSchema,
  NaturalIntakeSchema,
  IntakePreviewSchema,
  AIReviewResultSchema,
  AIAnalysisResultSchema,
  AIPlanningResultSchema,
  assertJsonBounds,
  Id,
} from './schemas.mjs';
import { compilePlan, validatePlan, assertPlanHash } from './validator.mjs';
import { POLICY_HASH, REGISTRY_HASH, resolveAction, pathAllowed } from './registry.mjs';
import { initialNodes, reconcile, calculateCapabilities } from './state.mjs';
import { buildHistoricalReviewEvidence, MAX_HISTORICAL_EXECUTIONS } from './review-evidence.mjs';
import { ExternalConsentSchema, makeExternalConsent, providerToolchain } from './providers.mjs';
import { safeReason } from './failure-reason.mjs';
import { autonomyForNodes } from './autonomy-policy.mjs';
import { canReplanRejectedImplementation } from './manual-continuation.mjs';

const fail = (code, message) => {
  throw new GraphError(code, message);
};
const unique = (values) => [...new Set(values)];
const externalProvider = (provider) => ['claude', 'cursor'].includes(provider);
const processDead = (pid) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
};
function processStartIdentity(pid) {
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8',
    timeout: 2000,
    maxBuffer: 4096,
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
  });
  return result.status === 0 && result.stdout.trim() ? sha256(result.stdout.trim()) : null;
}

function assertConfiguredChecks(task, profile, draft = null) {
  if (!profile) return; // Injected adapters are trusted host code, never public input.
  const requested = [...task.checks];
  if (Array.isArray(draft?.nodes)) {
    for (const node of draft.nodes) {
      const action = node?.action?.id;
      if (typeof action === 'string' && action.startsWith('check-'))
        requested.push(action.slice('check-'.length));
    }
  }
  if (requested.some((check) => !profile.checks.includes(check)))
    fail('CHECK_NOT_CONFIGURED', 'Task or draft requests a check not enabled in .flowcairn.json');
}

/** The only control boundary. Injected adapters are trusted host code, never JSON/API data. */
export class WorkflowService {
  acquireViewerLease() {
    this.#assertOpen();
    return this.lifecycleRelease ? acquireRuntimeLease({ root: this.root, kind: 'viewer' }) : () => {};
  }
  close() {
    if (this.pendingMutations || this.active.size || this.intakes.size || this.drives.size) return false;
    this.lifecycleRelease?.(); this.lifecycleRelease = null; this.closed = true;
    return true;
  }
  #assertOpen() { if (this.closed) fail('SERVICE_CLOSED', 'WorkflowService закрыт'); }
  project() {
    return this.adapters.projectSummary ? this.adapters.projectSummary() : projectSummary(this);
  }
  previewIntake(input) {
    this.#assertOpen();
    assertJsonBounds(input);
    const body = IntakePreviewSchema.parse(input);
    if (body.runId) {
      const { task } = this.#read(body.runId, { current: false });
      Object.assign(body, { title: task.goal, description: task.instructions, taskNumber: task.taskNumber ?? task.id });
    }
    return this.#intakeContext(body, this.project());
  }
  #intakeContext(body, project, forbiddenPaths = []) {
    if (body.contextHash !== project.contextHash) fail('STALE_CONTEXT', 'Файлы или настройки изменились. Проверьте область задачи заново.');
    const inventory = this.adapters.taskContextInventory?.();
    if (project.sourceHash && inventory?.sourceHash !== project.sourceHash)
      fail('STALE_CONTEXT', 'Файлы изменились во время проверки области задачи. Повторите проверку.');
    return buildTaskContext({ fields: { title: body.title, description: body.description, taskNumber: body.taskNumber },
      project, files: inventory?.files ?? null, outputPaths: this.adapters.project?.outputPaths ?? [],
      forbiddenPaths, selection: body.selection });
  }
  async intake(input, options = {}) {
    this.#assertOpen(); this.pendingMutations++;
    try { return await this.#intake(input, options); } finally { this.pendingMutations--; }
  }
  async #intake(input, { actor = 'local-operator' } = {}) {
    this.#assertOpen();
    assertJsonBounds(input);
    const body = NaturalIntakeSchema.parse(input);
    const product = 'title' in body;
    const legacy = 'prompt' in body ? body : null;
    const untracked = legacy?.includeUntracked ?? [];
    const requestedScope = legacy?.scope;
    const snapshotRequested = legacy?.snapshot;
    const requestHash = hashObject({ body, actor });
    const suffix = hashObject({ operationId: body.operationId, actor }).slice(0, 32);
    const runId = `intake-${suffix}`;
    if (this.store.listRunIds().includes(runId)) {
      const existing = this.store.readRun(runId);
      if (existing.naturalIntakeHash !== requestHash) fail('IDEMPOTENCY_CONFLICT', 'operationId связан с другой задачей');
      return this.snapshot(runId);
    }
    const project = this.project();
    if (body.contextHash !== project.contextHash) fail('STALE_CONTEXT', 'Контекст проекта изменился; обновите описание проекта');
    if (!project.capabilities.intake.allowed) fail('INTAKE_DENIED', project.capabilities.intake.reason);
    if (product && !this.#hasReadConsent()) fail('ONBOARDING_REQUIRED', 'Завершите настройку и разрешите чтение выбранным AI');
    if (snapshotRequested && legacy?.snapshotHash !== project.bootstrap?.snapshotHash) fail('STALE_CONTEXT', 'Исходный снимок изменился; подтвердите актуальные файлы');
    if (untracked.some((file) => !project.bootstrap?.untrackedCandidates.includes(file))) fail('INTAKE_SCOPE', 'Файл не входит в текущий список snapshot candidates');
    if (!product && !requestedScope && project.scopeCandidates.length > 64) fail('INTAKE_SCOPE_LIMIT', 'Выберите не более 64 областей задачи');
    const preview = product ? this.#intakeContext(body, project) : null;
    if (preview && product && body.selection && !preview.ready) fail('INTAKE_CONTEXT_REQUIRED', preview.issues.join('\n'));
    const initial = preview ? initialTaskContext(preview, project, product && Boolean(body.selection)) : null;
    const inferredScope = initial?.scope ?? unique([...project.scopeCandidates, ...untracked.filter((file) => file !== '.flowcairn.json').map((file) => file.includes('/') ? file.split('/')[0] : file)]);
    const task = TaskInputSchema.parse({ id: `TASK-${suffix.toUpperCase()}`, goal: product ? body.title : body.prompt.slice(0, 4000),
      ...(product ? { intakeKind: 'natural' } : {}),
      ...(product ? { taskNumber: body.taskNumber } : {}),
      instructions: product ? body.description : body.prompt, scope: product ? inferredScope : requestedScope ?? inferredScope,
      ...(initial ? { contextDiscovery: true, contextNotes: initial.notes } : {}),
      contextPaths: project.contextPaths, includeUntracked: untracked, acceptance: [product ? body.description.slice(0, 4000) : body.prompt.slice(0, 4000)], checks: project.checks });
    if (task.scope.some((file) => !pathAllowed(file, task))) fail('INTAKE_SCOPE', 'Недопустимый scope');
    const pending = this.intakes.get(runId);
    if (pending) {
      if (pending.requestHash !== requestHash) fail('IDEMPOTENCY_CONFLICT', 'operationId связан с другой задачей');
      return pending.promise;
    }
    const reservationId = `registration-${suffix}`;
    const exists = this.store.listRunIds().includes(reservationId);
    if (!exists) {
      try {
        this.store.createRun(reservationId, { kind: 'intake-operation', requestHash, status: 'reserved',
          ownerPid: null, ownerStart: null, resultRunId: runId });
      } catch (error) {
        if (error.code !== 'RUN_EXISTS') throw error;
      }
    }
    let reservation = this.store.readRun(reservationId);
    if (reservation.requestHash !== requestHash) fail('IDEMPOTENCY_CONFLICT', 'operationId связан с другой задачей');
    if (reservation.status === 'running' && !processDead(reservation.ownerPid))
      fail('INTAKE_BUSY', 'Регистрация уже выполняется; повторите тот же запрос позже');
    reservation = this.store.updateRun(reservationId, reservation.revision, (current) => ({
      ...current, status: 'running', ownerPid: process.pid, ownerStart: this.ownerStart,
    }));
    const promise = (async () => {
      try {
        const { createTask } = await import('./task-registration.mjs');
        const register = this.adapters.registerTask ?? createTask;
        const snapshot = await register(this.root, task, { run: runId, operation: body.operationId, service: this,
          stage: 'planning', ...(product ? { workflow: 'autonomous', expectedSourceHash: project.sourceHash } : {}), naturalIntakeHash: requestHash, actor, contextHash: body.contextHash, snapshot: product ? true : snapshotRequested, includeUntracked: untracked });
        this.store.updateRun(reservationId, reservation.revision, (current) => ({ ...current, status: 'finished' }));
        if (product) this.#schedule(snapshot.runId);
        return snapshot;
      } catch (error) {
        this.store.updateRun(reservationId, reservation.revision, (current) => ({ ...current, status: 'failed' }));
        throw error;
      } finally { this.intakes.delete(runId); }
    })();
    this.intakes.set(runId, { requestHash, promise });
    return promise;
  }

  #previousExecutions(state) {
    if (!state.policyGrant) return [];
    const previous = [];
    let runId = state.supersedesRunId;
    for (let index = 0; index < state.policyGrant.cycle; index++) {
      if (!runId) fail('POLICY_GRANT', 'Цепочка исправлений неполная');
      const source = this.#read(runId, { current: false, verifySource: false, verifyBinding: false });
      if (source.plan.stage !== 'execution' || source.plan.workflow !== 'autonomous') fail('POLICY_GRANT', 'Неверная предыдущая версия');
      previous.unshift(source);
      runId = source.state.supersedesRunId;
    }
    if (previous[0]?.state.runId !== state.policyGrant.runId) fail('POLICY_GRANT', 'Цепочка исправлений не начинается с согласованного плана');
    return previous;
  }

  #executionHistory(state) {
    const previous = [];
    let runId = state.supersedesRunId;
    const visited = new Set([state.runId]);
    for (let depth = 0; runId; depth++) {
      if (depth >= 100 || visited.has(runId))
        fail('EXECUTION_HISTORY', 'Цепочка предыдущих execution-версий повреждена');
      visited.add(runId);
      const source = this.#read(runId, { current: false, verifySource: false, verifyBinding: false });
      if (source.plan.workflow === 'autonomous' && source.plan.stage === 'execution') {
        const implementations = source.plan.nodes.filter((node) => node.action.id === 'ai-implement');
        if (implementations.some((node) => source.state.nodes[node.id].attempts > 0)) {
          previous.unshift(source);
          if (previous.length > MAX_HISTORICAL_EXECUTIONS)
            fail('EXECUTION_HISTORY_LIMIT', `Полная история review превышает ${MAX_HISTORICAL_EXECUTIONS} execution-версий`);
        }
      }
      runId = source.state.supersedesRunId;
    }
    return previous;
  }

  #reviewHistory(state) {
    return this.#executionHistory(state).map((source) => ({ task: source.task, plan: source.plan,
      evidence: buildHistoricalReviewEvidence({ state: source.state, task: source.task, plan: source.plan,
        node: source.plan.nodes.find((node) => node.action.id === 'ai-review'), fingerprint: source.state.workspaceFingerprint,
        readReceipt: (hash) => ReceiptSchema.parse(this.store.readObject('receipts', hash)), readArtifact: (hash) => this.#artifact(hash),
      }) }));
  }

  #proofService() {
    return createTaskProofService({
      readRun: this.#read.bind(this), readArtifact: this.#artifact.bind(this),
      readReceipt: (hash) => this.store.readObject('receipts', hash),
      putReceipt: (receipt) => this.store.putObject('receipts', receipt),
      hasLock: (runId) => Boolean(this.store.inspectLock(runId)),
      verifyBinding: this.adapters.verifyBinding?.bind(this.adapters),
      verifyToolchain: this.adapters.verifyToolchain?.bind(this.adapters),
      fingerprint: this.adapters.fingerprint?.bind(this.adapters),
      challenge: this.#challenge.bind(this), verifyChallenge: this.#verifyChallenge.bind(this),
      write: this.#write.bind(this), snapshot: this.snapshot.bind(this), sanitizeText, safeReason,
    });
  }
  #analysis(state, plan) { return this.#proofService().analysis(state, plan); }
  #taskProof(state, task, plan, driftReason = null) {
    return this.#proofService().taskProof(state, task, plan, driftReason);
  }

  #executionDeadline(state, plan) {
    if (plan.workflow !== 'autonomous' || plan.stage !== 'execution' || state.nodes['approve-plan']?.status !== 'passed') return null;
    const startedAt = state.policyGrant?.startedAt ?? this.store.readObject('receipts', state.nodes['approve-plan'].receipts.at(-1)).finishedAt;
    return Date.parse(startedAt) + plan.autonomy.maxDurationMs;
  }

  #workflowProgress(state, plan) {
    if (plan.workflow !== 'autonomous') return [];
    const result = new Map();
    let source = { state, plan };
    for (let depth = 0; depth < 24; depth++) {
      if (source.plan.stage === 'planning') {
        for (const node of source.plan.nodes.filter((n) => ['ai-analyze','ai-plan'].includes(n.action.id))) {
          if (!result.has(node.action.id)) {
            const actual = source.state.nodes[node.id];
            result.set(node.action.id, { nodeId: node.id, title: node.title, outcome: node.outcome, attempt: actual.attempts, durationMs: actual.durationMs, action: node.action.id, status: actual.status,
              sourceRunId: source.state.runId, planHash: source.state.planHash, receiptIds: actual.receipts,
              artifacts: actual.artifacts.map((hash) => this.#artifactMetadata(hash)) });
          }
        }
      }
      if (result.size === 2 || !source.state.supersedesRunId) break;
      source = this.#read(source.state.supersedesRunId, { current: false, verifySource: false, verifyBinding: false });
    }
    return ['ai-analyze','ai-plan'].flatMap((id) => result.has(id) ? [result.get(id)] : []);
  }

  #delivery(state, plan, driftReason) {
    if (
      driftReason ||
      plan.workflow !== 'autonomous' ||
      plan.stage !== 'execution' ||
      state.status !== 'passed' ||
      !state.binding
    )
      return null;
    try {
      this.adapters.verifyBinding(state.binding);
      if (state.binding.mode === 'direct' && realpathSync(state.binding.worktree) === this.root)
        return { workspacePath: '.', mode: 'direct' };
      const relative = path.relative(this.root, realpathSync(state.binding.worktree)).split(path.sep).join('/');
      if (
        !relative ||
        relative === '..' ||
        relative.startsWith('../') ||
        path.isAbsolute(relative) ||
        !/^\.ai-orchestrator\/worktrees\/[a-z][a-z0-9-]{1,79}-[1-9][0-9]*$/.test(relative)
      )
        return null;
      return { workspacePath: relative };
    } catch {
      return null;
    }
  }

  #hasReadConsent() {
    return this.adapters.hasReadConsent ? this.adapters.hasReadConsent() === true :
      typeof Reflect.get(ProjectPolicy, 'hasOnboardingConsent') === 'function' && Reflect.get(ProjectPolicy, 'hasOnboardingConsent')(this.root, this.adapters.project);
  }

  // A completed AI response can be semantically uncertain without any uncertain
  // process. Re-running recovery for it only overwrites useful evidence and traps
  // the user in a recovery loop. Keep process recovery for interrupted work.
  #semanticUncertainty(state) {
    if (state.status !== 'uncertain' || state.activeOperation) return false;
    const uncertain = Object.values(state.nodes).filter((node) => node.status === 'uncertain');
    return uncertain.length > 0 && uncertain.every((node) => {
      const receiptId = node.receipts.at(-1);
      if (!receiptId) return false;
      try {
        const receipt = ReceiptSchema.parse(this.store.readObject('receipts', receiptId));
        return receipt.phase === 'finished' && receipt.verdict === 'uncertain' &&
          receipt.termination?.stopped === true && receipt.termination.uncertain !== true;
      } catch {
        return false;
      }
    });
  }
  #contextClarification(state, plan) {
    if (plan.workflow !== 'autonomous' || plan.stage !== 'planning' ||
        !['failed', 'uncertain'].includes(state.status) || state.activeOperation || state.finalDisposition || state.setupPending ||
        state.permissions.some((permission) => permission.includes('write')) ||
        (state.status === 'uncertain' && !this.#semanticUncertainty(state))) return false;
    return Object.values(state.nodes).every((node) => {
      if (!node.attempts) return true;
      try {
        const receipt = this.store.readObject('receipts', node.receipts.at(-1));
        return receipt.phase === 'gate' || (receipt.phase === 'finished' &&
          receipt.termination?.stopped === true && receipt.termination.uncertain === false &&
          receipt.beforeFingerprint === receipt.afterFingerprint && !receipt.changedFiles.length);
      } catch { return false; }
    });
  }
  #resolveContextSelection(task, selection) {
    const { contextHash, ...choices } = selection;
    const project = this.project();
    const preview = this.#intakeContext({ title: task.goal, description: task.instructions,
      taskNumber: task.taskNumber ?? task.id, contextHash, selection: choices }, project);
    if (!preview.ready) fail('INTAKE_CONTEXT_REQUIRED', preview.issues.join('\n'));
    if (preview.scope.some((file) => !pathAllowed(file, { ...task, scope: preview.scope })))
      fail('INTAKE_SCOPE', 'Выбранные пути запрещены исходной задачей');
    return { ...preview, sourceHash: project.sourceHash };
  }
  async #discoverPlanningContext(state, task, plan, request, caps) {
    if (!task.contextDiscovery || !this.#contextClarification(state, plan)) return null;
    const definition = plan.nodes.find((node) => ['ai-analyze', 'ai-plan'].includes(node.action.id) &&
      resultKind(state.nodes[node.id], (id) => this.store.readObject('receipts', id)) === 'semantic');
    if (!definition) return null;
    const artifactId = state.nodes[definition.id].artifacts.find((id) => this.#artifact(id).kind === 'analysis');
    if (!artifactId) return null;
    const data = JSON.parse(this.#artifact(artifactId).content);
    const output = (definition.action.id === 'ai-analyze' ? AIAnalysisResultSchema : AIPlanningResultSchema).parse(data);
    if (!output.contextRequests?.length) return null;
    if ((state.contextDiscoveryRound ?? 0) >= 4) {
      this.#write(state, { failureReason: 'Не удалось собрать достаточный контекст за четыре этапа исследования. Откройте причину анализа и уточните недостающие исходные данные.' });
      return null;
    }
    const fingerprint = await this.#assertWorkspace(state);
    let discovery;
    try {
      discovery = resolveContextRequests({ task, requests: output.contextRequests, files: fingerprint.files,
        outputPaths: this.adapters.project?.outputPaths ?? [], provider: this.adapters.project?.ai.provider ?? 'codex' });
      if (hashObject(discovery.scope) === hashObject([...task.scope].sort()) &&
          hashObject(discovery.contextPaths) === hashObject([...task.contextPaths].sort()))
        discovery.notes = ['Запрошенные пути уже доступны. Продолжи анализ в объявленном read context; повтор того же запроса не добавляет информации.'];
    } catch (error) {
      if (!['CONTEXT_REQUEST_INVALID', 'CONTEXT_REQUEST_LIMIT'].includes(error.code)) throw error;
      discovery = { scope: task.scope, contextPaths: task.contextPaths, notes: [
        `Executor отклонил contextRequests: ${sanitizeText(error.message)}. Запроси более точные доступные пути либо объясни, каких данных действительно не хватает.`] };
    }
    const discoveryChange = { ...discovery, feedback: [...(task.contextNotes ?? []).slice(0, 31),
      ...discovery.notes.slice(0, 1)], sourceHash: this.adapters.project?.workspaceMode === 'direct' ? fingerprint.hash : undefined };
    return this.#replan({ state, task, plan, request, actor: state.actor, caps, discoveryChange,
      digest: hashObject({ name: 'context-discovery', request, artifactId }) });
  }

  async onboarding() {
    const { inspectOnboarding } = await import(new URL('../../../bin/onboarding.mjs', import.meta.url).href);
    return inspectOnboarding(this.root);
  }

  #resumeReadyWork() {
    for (const runId of this.store.listRunIds()) {
      const raw = this.store.readRun(runId);
      if (raw.schemaVersion !== 2 || raw.finalDisposition || raw.activeOperation || raw.setupPending || raw.stopRequested ||
          !['ready','passed'].includes(raw.status)) continue;
      try {
        const { state, plan } = this.#read(runId);
        if (plan.workflow !== 'autonomous' || (plan.stage === 'execution' && state.status === 'passed')) continue;
        if (plan.stage === 'planning' || state.nodes['approve-plan']?.status === 'passed') this.#schedule(runId);
      } catch { /* Неисправное или устаревшее выполнение остается доступным только для диагностики. */ }
    }
  }

  #schedule(runId) {
    if (this.drives.has(runId)) return;
    const promise = new Promise((resolve) => setImmediate(resolve)).then(() => this.#drive(runId)).catch((error) => {
      const state = this.store.readRun(runId);
      if (!state.activeOperation) this.#write(state, { failureReason: safeReason(error) });
    }).finally(() => this.drives.delete(runId));
    this.drives.set(runId, promise);
  }

  async #drive(initialRunId) {
    let runId = initialRunId;
    // Предел относится ко всему управляющему проходу, даже если адаптер вернул неожиданный state.
    for (let turn = 0; turn < 12; turn++) {
      const { state, task, plan } = this.#read(runId);
      if (state.stopRequested || state.activeOperation || state.finalDisposition || plan.workflow !== 'autonomous') return;
      const caps = this.#caps(state, plan);
      const request = { operationId: `auto-${randomUUID()}`, expectedRevision: state.revision, planHash: state.planHash };
      if (this.#executionDeadline(state, plan) !== null && Date.now() >= this.#executionDeadline(state, plan)) {
        this.#write(state, { failureReason: 'Истек срок согласованного автономного выполнения; требуется личное ревью' });
        return;
      }
      if (caps.run.run.allowed) {
        await this.command(runId, 'run', request, { actor: state.actor });
        continue;
      }
      const discovered = await this.#discoverPlanningContext(state, task, plan, request, caps);
      if (discovered) { runId = discovered.runId; continue; }
      if (plan.stage === 'planning' && state.status === 'passed') {
        const next = await this.command(runId, 'replan', request, { actor: state.actor });
        runId = next.runId;
        continue;
      }
      if (plan.stage === 'planning' && state.status === 'failed' && caps.run.requestReplan.allowed) {
        const planner = plan.nodes.find((node) => node.action.id === 'ai-plan');
        const failed = planner && state.nodes[planner.id];
        const receiptId = failed?.receipts.at(-1);
        const receipt = receiptId && ReceiptSchema.parse(this.store.readObject('receipts', receiptId));
        const reasonCode = failed?.reason?.split(':')[0];
        if (failed?.status !== 'failed' || !['PLANNING_READ_SCOPE', 'CONTRACT_ANALYSIS_COVERAGE'].includes(reasonCode) ||
            receipt?.phase !== 'finished' || receipt.termination?.stopped !== true ||
            receipt.termination.uncertain || receipt.beforeFingerprint !== receipt.afterFingerprint) return;
        const feedback = reasonCode === 'PLANNING_READ_SCOPE'
          ? `Предыдущий план предложил чтение вне разрешенной области. Используй readPaths только внутри ${JSON.stringify([...new Set([...task.scope, ...task.contextPaths])].sort())}; не расширяй права.`
          : 'Предыдущий план свел отдельные обязательные пункты анализа к одному требованию. Для каждого пункта создай отдельное mandatory requirement с проверкой и свяжи его с implementation step через requirementIds. Не расширяй scope или права.';
        const next = await this.command(runId, 'replan', { ...request, feedback }, { actor: state.actor });
        runId = next.runId;
        continue;
      }
      if (plan.stage === 'execution' && state.status === 'failed') {
        const failed = plan.nodes.filter((node) => state.nodes[node.id].status === 'failed');
        const repairable = failed.length === 1 &&
          (failed[0].action.id.startsWith('check-') || ['ai-review', 'ai-implement'].includes(failed[0].action.id));
        const definition = failed[0];
        const lastId = definition && state.nodes[definition.id].receipts.at(-1);
        const receipt = lastId && ReceiptSchema.parse(this.store.readObject('receipts', lastId));
        const semanticReview = definition?.action.id === 'ai-review' && state.nodes[definition.id].artifacts.some((id) => {
          const artifact = this.#artifact(id);
          if (artifact.kind !== 'review-findings') return false;
          const result = AIReviewResultSchema.safeParse(JSON.parse(artifact.content));
          return result.success && result.data.verdict === 'fail' && result.data.findings.some((finding) => finding.severity === 'blocking');
        });
        const knownCheck = definition?.action.id.startsWith('check-') && receipt?.checks.some((check) => check.exitCode !== null && check.exitCode !== 0 && !check.passed);
        const rejectedImplementation = definition?.action.id === 'ai-implement' &&
          receipt?.verdict === 'fail' && receipt.beforeFingerprint === receipt.afterFingerprint &&
          receipt.changedFiles.length === 0;
        if (!repairable || (!semanticReview && !knownCheck && !rejectedImplementation) ||
            receipt?.phase !== 'finished' || !receipt.termination?.stopped || receipt.termination.uncertain) return;
        const original = state.policyGrant ?? {
          runId: state.runId, planHash: state.planHash,
          receiptId: state.nodes['approve-plan'].receipts.at(-1),
          startedAt: this.store.readObject('receipts', state.nodes['approve-plan'].receipts.at(-1)).finishedAt,
          cycle: 0,
        };
        if (original.cycle >= plan.autonomy.maxRepairCycles || Date.now() - Date.parse(original.startedAt) > plan.autonomy.maxDurationMs) return;
        const next = await this.#replan({ state, task, plan, request, digest: hashObject({ name: 'policy-repair', request }), actor: state.actor,
          caps: { ...caps, run: { ...caps.run, requestReplan: { allowed: true, reason: null } } },
          policyGrant: { ...original, cycle: original.cycle + 1 } });
        runId = next.runId;
        this.#activatePolicyGrant(runId);
        continue;
      }
      return;
    }
  }

  #verifyAuthorization(state, task, plan) {
    const grant = state.policyGrant;
    if (!grant || plan.workflow !== 'autonomous' || plan.stage !== 'execution' || grant.runId === state.runId)
      fail('POLICY_GRANT', 'Отсутствует ограниченное разрешение исходного плана');
    if (!state.supersedesRunId || state.supersedesRunId === state.runId) fail('POLICY_GRANT', 'Нет предыдущей версии исправления');
    const policyHistory = this.#previousExecutions(state);
    if (policyHistory.length !== grant.cycle || policyHistory[0]?.state.runId !== grant.runId)
      fail('POLICY_GRANT', 'Цепочка исправлений не начинается с согласованного плана');
    const parent = RunStateSchema.parse(this.store.readRun(state.supersedesRunId));
    if ((parent.policyGrant?.cycle ?? 0) !== grant.cycle - 1 ||
        (grant.cycle === 1 && parent.runId !== grant.runId) ||
        (parent.policyGrant && (parent.policyGrant.runId !== grant.runId || parent.policyGrant.receiptId !== grant.receiptId)) ||
        plan.parentPlanHash !== parent.planHash)
      fail('POLICY_GRANT', 'Счетчик или источник исправления не соответствует предыдущей версии');
    const origin = this.#read(grant.runId, { current: false, verifySource: false, verifyBinding: false });
    const approval = ReceiptSchema.parse(this.store.readObject('receipts', grant.receiptId));
    const writes = (value) => unique(value.nodes.flatMap((node) => node.resources.writes)).sort();
    const invariant = (value) => ({ goal: value.goal, instructions: value.instructions, feedback: value.planningFeedback ?? [], scope: value.scope, forbiddenPaths: value.forbiddenPaths, checks: value.checks, contextPaths: value.contextPaths, acceptance: value.acceptance });
    if (origin.plan.workflow !== 'autonomous' || origin.plan.stage !== 'execution' || origin.state.policyGrant ||
        origin.state.planHash !== grant.planHash || approval.planHash !== grant.planHash ||
        !origin.state.nodes['approve-plan']?.receipts.includes(grant.receiptId) || approval.phase !== 'gate' || approval.verdict !== 'pass' ||
        approval.finishedAt !== grant.startedAt || grant.cycle > origin.plan.autonomy.maxRepairCycles ||
        hashObject(invariant(task)) !== hashObject(invariant(origin.task)) ||
        hashObject(writes(plan)) !== hashObject(writes(origin.plan)) ||
        plan.runtimeHash !== origin.plan.runtimeHash || plan.contextHash !== origin.plan.contextHash ||
        hashObject(plan.autonomy) !== hashObject(origin.plan.autonomy))
      fail('POLICY_GRANT', 'Исправление не соответствует явно согласованному плану');
    const permissions = unique(plan.nodes.flatMap((node) => node.permissions)).sort();
    if (hashObject(permissions) !== hashObject([...approval.grantedPermissions].sort()))
      fail('POLICY_GRANT', 'Исправление не может расширять разрешения');
  }

  #activatePolicyGrant(runId) {
    const { state, task, plan } = this.#read(runId);
    this.#verifyAuthorization(state, task, plan);
    const definition = plan.nodes.find((node) => node.action.id === 'human-approve');
    if (state.nodes[definition.id].status === 'passed') return;
    const permissions = unique(plan.nodes.flatMap((node) => node.permissions));
    const receipt = this.#receipt(state, task, plan, definition, {
      phase: 'policy', verdict: 'pass', grantedPermissions: permissions,
      actor: 'approved-repair-policy', operationId: `policy-${randomUUID()}`,
    });
    const nodes = structuredClone(state.nodes);
    Object.assign(nodes[definition.id], { status: 'passed', attempts: 1, receipts: [receipt],
      startedAt: now(), finishedAt: now(), durationMs: 0, reason: 'Исправление в пределах ранее согласованного плана' });
    this.#write(state, reconcile({ ...state, nodes, permissions }, plan));
  }

  async #revise({ state, task, plan, request, digest, actor, caps }) {
    if (!caps.run.revisePlan?.allowed || !request.feedback || request.draft)
      fail('PLAN_EDIT_DENIED', 'Уточнение доступно только до согласования плана');
    if (state.binding) await this.#assertWorkspace(state);
    const retainedArtifacts = unique([...state.planningArtifacts, ...Object.values(state.nodes).flatMap((node) => node.artifacts)]);
    const analysisArtifact = retainedArtifacts.find((id) => {
      const artifact = this.#artifact(id);
      return artifact.kind === 'analysis' && artifact.mediaType === 'application/json' && Boolean(JSON.parse(artifact.content).analysis);
    });
    if (!analysisArtifact) fail('ANALYSIS_REQUIRED', 'Нет сохраненного анализа для уточнения');
    const { schemaVersion: _, sourceHash: __, ...input } = task;
    input.planningFeedback = [...(task.planningFeedback ?? []), request.feedback];
    const newRunId = `run-${randomUUID()}`;
    const preparationHash = this.store.putObject('operations', {
      input, actor, sourceBundle: state.sourceBundle, sourceHash: state.sourceHash,
      version: plan.version + 1, parentPlanHash: state.planHash, supersedesRunId: state.runId,
      workflow: 'autonomous', stage: 'planning', analysisArtifact, retainedArtifacts,
      planningTransitions: (state.planningTransitions ?? 0) + 1,
      draft: null, binding: state.binding, fingerprint: state.workspaceFingerprint,
    });
    const prior = { digest, status: 'creating', resultRunId: newRunId, preparationHash };
    state = this.#write(state, { status: 'stale', finalDisposition: 'superseded', operations: { ...state.operations, [request.operationId]: prior } });
    const next = await this.#finishReplan(state, request, digest, actor, prior);
    this.#schedule(next.runId);
    return next;
  }

  capabilities() {
    return { create: { allowed: true, reason: null } };
  }
  static async open({ root = process.cwd(), adapters = undefined } = {}) {
    const resolved = realpathSync(root);
    const release = adapters ? null : acquireRuntimeLease({ root: resolved, kind: 'service' });
    try {
      const service = new WorkflowService(resolved, adapters ?? (await defaultAdapters(resolved)));
      service.lifecycleRelease = release;
      service.#resumeReadyWork();
      return service;
    } catch (error) { release?.(); throw error; }
  }
  constructor(root, adapters) {
    this.root = root;
    this.adapters = adapters;
    this.store = new GraphStore(root);
    this.challengeKey = randomBytes(32);
    this.active = new Map();
    this.intakes = new Map();
    this.drives = new Map();
    this.lifecycleRelease = null;
    this.closed = false;
    this.pendingMutations = 0;
    this.ownerStart = this.adapters.ownerIdentity
      ? this.adapters.ownerIdentity(process.pid)
      : processStartIdentity(process.pid);
  }

  async create(input, options = {}) {
    this.#assertOpen(); this.pendingMutations++;
    try { return await this.#create(input, options); } finally { this.pendingMutations--; }
  }
  async #create(
    input,
    {
      runId = `run-${randomUUID()}`,
      actor = 'local-operator',
      operationId = `create-${randomUUID()}`,
      version = 1,
      parentPlanHash = null,
      supersedesRunId = null,
      draft = null,
      sourceOverride = null,
      setupPending = false,
      replanEvidence = null,
      stage = undefined,
      workflow = undefined,
      analysisArtifact = undefined,
      taskContract = undefined,
      retainedArtifacts = [],
      policyGrant = undefined,
      planningTransitions = 0,
      contextDiscoveryRound = 0,
      naturalIntakeHash = undefined,
      expectedSourceHash = undefined,
    } = {},
  ) {
    this.#assertOpen();
    assertJsonBounds(input);
    Id.parse(runId);
    Id.parse(operationId);
    const parsedInput = TaskInputSchema.parse(input);
    const profile = this.adapters.project;
    if (draft) assertJsonBounds(draft);
    assertConfiguredChecks(parsedInput, profile, draft);
    const taskInput = TaskInputSchema.parse({
      ...parsedInput,
      checks: unique([...parsedInput.checks, ...(profile?.checks ?? [])]),
      contextPaths: unique([
        ...parsedInput.contextPaths,
        ...(profile ? projectContextPaths(this.root, profile) : []),
        ...(this.adapters.instructionPaths?.(parsedInput) ?? []),
        ...(this.adapters.skillContextPaths?.(parsedInput) ?? []),
      ]),
    });
    const intakeHash = hashObject({
      taskInput,
      version,
      parentPlanHash,
      supersedesRunId,
      draft,
      replanEvidence,
      stage: stage ?? null,
      workflow: workflow ?? null,
      analysisArtifact: analysisArtifact ?? null,
      taskContract: taskContract ?? null,
      retainedArtifacts,
      policyGrant: policyGrant ?? null,
      planningTransitions,
      contextDiscoveryRound,
      naturalIntakeHash: naturalIntakeHash ?? null,
      actor,
    });
    if (this.store.listRunIds().includes(runId)) {
      const existing = this.store.readRun(runId);
      if (existing.intakeHash !== intakeHash || existing.createOperationId !== operationId)
        fail('IDEMPOTENCY_CONFLICT', 'runId уже связан с другим intake');
      return this.snapshot(runId);
    }
    const source = sourceOverride ?? (await this.adapters.capture(taskInput));
    const sourceHash = source.manifest.sourceHash;
    if (expectedSourceHash && sourceHash !== expectedSourceHash)
      fail('STALE_CONTEXT', 'Снимок изменился после выбора файлов. Подтвердите актуальную область задачи.');
    const task = TaskSpecSchema.parse({ ...taskInput, schemaVersion: 2, sourceHash });
    const taskHash = this.store.putObject('tasks', task);
    const context = {
      runtimeHash: this.adapters.identity(),
      skills: this.adapters.skills(task),
      resolveSkills: this.adapters.resolveSkills,
      resolveReadPaths: this.adapters.resolveReadPaths,
      contextHash: this.adapters.contextHash?.(task),
      version,
      parentPlanHash,
      workflow,
      analysisArtifact,
      taskContract,
      provider: this.adapters.project?.ai.provider,
    };
    if (workflow === 'autonomous' && stage === 'planning' && !this.#hasReadConsent())
      fail('ONBOARDING_REQUIRED', 'Нет локального согласия на чтение выбранным AI');
    const compiled = (stage === 'planning' ? compilePlanningPlan : compilePlan)(task, context).plan;
    const staged = { ...compiled, ...(stage ? { stage } : {}), ...(workflow === 'autonomous' ? { workflow, autonomy: autonomyForNodes(draft?.nodes ?? compiled.nodes) } : {}) };
    const proposal = draft ? { ...staged, nodes: draft.nodes, skills: context.skills.filter((skill) => draft.nodes.some((node) => node.skills.includes(skill.id))) } : staged;
    proposal.taskContract = taskContract ?? proposal.taskContract ?? buildTaskContract(task, {
      steps: proposal.nodes.filter((node) => node.action.id === 'ai-implement').map((node) => ({ id: node.id, nodeId: node.id, paths: node.resources.writes })),
    });
    const validated = validatePlan(proposal, task, context),
      plan = validated.plan;
    const planHash = this.store.putObject('plans', plan);
    const envelope = PlanningEnvelopeSchema.parse({
      schemaVersion: 2,
      taskHash,
      sourceHash,
      runtimeHash: plan.runtimeHash,
      registryHash: REGISTRY_HASH,
      policyHash: POLICY_HASH,
      skills: plan.skills,
      readPaths: unique(
        plan.nodes
          .filter((node) => ['analysis', 'implementation', 'review'].includes(node.success.kind))
          .flatMap((node) => node.resources.reads),
      ).sort(),
      provider: this.adapters.project?.ai.provider ?? 'codex',
      timeoutMs: task.limits.timeoutMs,
    });
    const envelopeHash = this.store.putObject('envelopes', envelope);
    const state = reconcile(
      {
        schemaVersion: 2,
        runId,
        taskHash,
        planHash,
        envelopeHash,
        sourceHash,
        sourceBundle: source.bundlePath,
        planVersion: version,
        maxReplans: task.limits.maxReplans,
        planningTransitions,
        contextDiscoveryRound,
        ...(naturalIntakeHash ? { naturalIntakeHash } : {}),
        supersedesRunId,
        createdAt: now(),
        updatedAt: now(),
        status: 'pending',
        finalDisposition: null,
        nodes: initialNodes(plan),
        permissions: workflow === 'autonomous' && stage === 'planning' ? ['ai.read'] : [],
        ...(policyGrant ? { policyGrant } : {}),
        binding: null,
        workspaceFingerprint: null,
        initialFingerprint: null,
        activeOperation: null,
        operations: {},
        planningArtifacts: unique([...retainedArtifacts, ...(replanEvidence
          ? [this.#putArtifact('analysis', 'Причины новой версии', replanEvidence)]
          : [])]),
        actor,
      },
      plan,
    );
    this.store.createRun(runId, {
      ...state,
      setupPending,
      intakeHash,
      createOperationId: operationId,
    });
    // The fixed capture worker has just verified this source. Avoid repeating
    // the whole source scan in the HTTP response; public reads still verify it.
    return this.#snapshot(runId, false);
  }

  #read(runId, { current = true, verifySource = true, verifyBinding = true } = {}) {
    const raw = this.store.readRun(runId);
    if (raw.schemaVersion !== 2)
      fail('LEGACY_RUN', 'Legacy run доступен только как сохраненное evidence');
    const parsed = RunStateSchema.safeParse(raw);
    if (!parsed.success) fail('STATE_SCHEMA', 'Run state не соответствует строгой schema');
    const state = parsed.data;
    const task = TaskSpecSchema.parse(this.store.readObject('tasks', state.taskHash));
    const plan = this.store.readObject('plans', state.planHash);
    assertPlanHash(plan, state.planHash);
    validatePlan(
      plan,
      task,
      current
        ? { runtimeHash: this.adapters.identity(), skills: this.adapters.skills(task), resolveSkills: this.adapters.resolveSkills, resolveReadPaths: this.adapters.resolveReadPaths, contextHash: this.adapters.contextHash?.(task), provider: this.adapters.project?.ai.provider }
        : { mode: 'historical' },
    );
    const envelope = PlanningEnvelopeSchema.parse(
      this.store.readObject('envelopes', state.envelopeHash),
    );
    const expectedEnvelope = {
      schemaVersion: 2,
      taskHash: state.taskHash,
      sourceHash: state.sourceHash,
      runtimeHash: plan.runtimeHash,
      registryHash: plan.registryHash,
      policyHash: plan.policyHash,
      skills: plan.skills,
      readPaths: unique(
        plan.nodes
          .filter((node) => ['analysis', 'implementation', 'review'].includes(node.success.kind))
          .flatMap((node) => node.resources.reads),
      ).sort(),
      provider: current ? (this.adapters.project?.ai.provider ?? 'codex') : envelope.provider,
      timeoutMs: task.limits.timeoutMs,
    };
    if (hashObject(envelope) !== hashObject(expectedEnvelope))
      fail('ENVELOPE_INTEGRITY', 'Planning envelope не соответствует plan/task');
    if (
      verifySource &&
      this.adapters.verifySource &&
      this.adapters.verifySource(state.sourceBundle) !== state.sourceHash
    )
      fail('SOURCE_INTEGRITY', 'Source bundle не соответствует run');
    if (state.planVersion !== plan.version || state.sourceHash !== plan.sourceHash)
      fail('PLAN_INTEGRITY', 'Run и план не совпадают');
    if (
      hashObject(Object.keys(state.nodes).sort()) !== hashObject(plan.nodes.map((n) => n.id).sort())
    )
      fail('STATE_INTEGRITY', 'State node set не совпадает с immutable plan');
    if (
      state.finalDisposition === 'accepted' &&
      (state.status !== 'passed' || Object.values(state.nodes).some((n) => n.status !== 'passed'))
    )
      fail('STATE_INTEGRITY', 'Accepted требует завершения всех nodes');
    if (state.status === 'passed' && Object.values(state.nodes).some((n) => n.status !== 'passed'))
      fail('STATE_INTEGRITY', 'Passed требует завершения всех nodes');
    if (
      state.finalDisposition === 'superseded' &&
      (state.status !== 'stale' || !Object.values(state.operations).some((op) => op.resultRunId))
    )
      fail('STATE_INTEGRITY', 'Supersession требует новую run и stale state');
    if (
      state.permissions.length &&
      !(plan.workflow === 'autonomous' && plan.stage === 'planning' &&
        state.permissions.length === 1 && state.permissions[0] === 'ai.read' && (!current || this.#hasReadConsent())) &&
      !plan.nodes.some(
        (n) =>
          n.success.kind === 'gate' &&
          n.needs.length === 0 &&
          state.nodes[n.id].status === 'passed',
      )
    )
      fail('STATE_INTEGRITY', 'Permissions не подтверждены gate');
    if (state.policyGrant) this.#verifyAuthorization(state, task, plan);
    for (const definition of plan.nodes) {
      const node = state.nodes[definition.id];
      if (!node) fail('STATE_INTEGRITY', 'Node state отсутствует');
      let previousReceipt = null,
        lastStart = null,
        attemptNumber = 0,
        lastFinished = null;
      const receiptArtifacts = [];
      for (const hash of node.receipts) {
        const receipt = ReceiptSchema.parse(this.store.readObject('receipts', hash));
        if (
          receipt.runId !== runId ||
          receipt.nodeId !== definition.id ||
          receipt.planHash !== state.planHash ||
          receipt.actionId !== definition.action.id ||
          receipt.actionVersion !== definition.action.version ||
          receipt.taskHash !== state.taskHash ||
          receipt.planVersion !== plan.version ||
          receipt.attempt > node.attempts ||
          receipt.previousReceipt !== previousReceipt ||
          hashObject(receipt.permissions) !== hashObject(definition.permissions)
        )
          fail('RECEIPT_INTEGRITY', 'Receipt относится к другому выполнению');
        if (
          receipt.sourceHash !== state.sourceHash ||
          receipt.runtimeHash !== plan.runtimeHash ||
          receipt.instructionsHash !==
            hashObject({
              instructions: task.instructions,
              acceptance: task.acceptance,
              outcome: definition.outcome,
            }) ||
          hashObject(receipt.skills) !==
            hashObject(plan.skills.filter((s) => definition.skills.includes(s.id))) ||
          hashObject(receipt.grantedPermissions) !== hashObject(state.permissions)
        )
          fail(
            'RECEIPT_INTEGRITY',
            'Receipt instructions/skills/grants/source не совпадают с approved context',
          );
        if (receipt.phase === 'started') {
          if (
            receipt.attempt !== attemptNumber + 1 ||
            receipt.verdict !== 'started' ||
            receipt.finishedAt !== null ||
            receipt.durationMs !== null
          )
            fail('ATTEMPT_INTEGRITY', 'Некорректное начало попытки');
          lastStart = receipt;
          attemptNumber = receipt.attempt;
        } else if (receipt.phase === 'finished') {
          if (
            !lastStart ||
            receipt.attemptId !== lastStart.attemptId ||
            receipt.attempt !== lastStart.attempt ||
            receipt.startedAt !== lastStart.startedAt ||
            receipt.beforeFingerprint !== lastStart.beforeFingerprint ||
            !receipt.finishedAt ||
            receipt.verdict === 'started'
          )
            fail('ATTEMPT_INTEGRITY', 'Конец попытки не связан с ее началом');
          if (
            receipt.verdict === 'pass' &&
            (receipt.exitCode !== 0 ||
              !receipt.termination?.stopped ||
              receipt.termination.uncertain)
          )
            fail('RECEIPT_INTEGRITY', 'Pass не подтвержден technical/termination evidence');
          lastFinished = receipt;
          lastStart = null;
        } else if (receipt.phase === 'gate' || receipt.phase === 'policy') {
          if (receipt.phase === 'policy') this.#verifyAuthorization(state, task, plan);
          if (
            definition.success.kind !== 'gate' ||
            attemptNumber !== 0 ||
            receipt.attempt !== 1 ||
            !['pass', 'fail'].includes(receipt.verdict)
          )
            fail('ATTEMPT_INTEGRITY', 'Некорректное gate evidence');
          attemptNumber = 1;
        } else if (receipt.phase === 'recovery') {
          if (receipt.attempt !== attemptNumber || receipt.verdict !== 'uncertain')
            fail('ATTEMPT_INTEGRITY', 'Recovery не относится к открытой попытке');
        }
        receiptArtifacts.push(...receipt.artifacts);
        previousReceipt = hash;
      }
      if (node.status === 'passed') {
        if (definition.needs.some((id) => state.nodes[id].status !== 'passed'))
          fail('STATE_INTEGRITY', 'Passed node имеет незавершенную dependency');
        const hash = node.receipts.at(-1);
        if (!hash || this.store.readObject('receipts', hash).verdict !== 'pass')
          fail('RECEIPT_MISSING', 'Passed требует успешный receipt');
      }
      if (node.status === 'cancelled') {
        const last = node.receipts.length
          ? ReceiptSchema.parse(this.store.readObject('receipts', node.receipts.at(-1)))
          : null;
        if (last?.verdict !== 'cancelled' || last.termination?.stopped !== true || last.termination.uncertain)
          fail('RECEIPT_INTEGRITY', 'Cancelled требует подтвержденную остановку процесса');
      }
      if (node.retrySafe) {
        const last = node.receipts.length
          ? this.store.readObject('receipts', node.receipts.at(-1))
          : null;
        if (
          node.status !== 'failed' ||
          (current && !resolveAction(definition.action.id).retrySafe) ||
          last?.phase !== 'finished' ||
          last.verdict !== 'fail' ||
          !last.termination?.stopped ||
          last.termination.uncertain ||
          last.beforeFingerprint !== last.afterFingerprint
        )
          fail('RETRY_INTEGRITY', 'retrySafe не подтвержден immutable receipt');
      }
      if (
        attemptNumber !== node.attempts ||
        hashObject(receiptArtifacts) !== hashObject(node.artifacts)
      )
        fail('STATE_RECEIPT_INTEGRITY', 'State attempts/artifacts не соответствуют receipts');
      if (
        lastFinished &&
        ['passed', 'failed', 'cancelled', 'uncertain'].includes(node.status) &&
        (hashObject(lastFinished.checks) !== hashObject(node.checks) ||
          hashObject(lastFinished.changedFiles) !== hashObject(node.changedFiles))
      )
        fail('STATE_RECEIPT_INTEGRITY', 'State checks/changedFiles не соответствуют receipt');
      for (const hash of node.artifacts) this.#artifact(hash);
    }
    validateRequirementAcceptances({ state, task, plan, readReceipt: (hash) => this.store.readObject('receipts', hash) });
    if (current && verifyBinding && state.binding && !state.finalDisposition)
      this.adapters.verifyBinding(state.binding);
    return { state, task, plan };
  }

  #orphan(state) {
    const owner = state.activeOperation;
    if (!owner) return false;
    if (processDead(owner.ownerPid)) return true;
    const identity =
      owner.ownerPid === process.pid
        ? this.ownerStart
        : this.adapters.ownerIdentity
          ? this.adapters.ownerIdentity(owner.ownerPid)
          : processStartIdentity(owner.ownerPid);
    return Boolean(owner.ownerStart && identity && owner.ownerStart !== identity);
  }
  #caps(state, plan) {
    const lock = this.store.inspectLock(state.runId);
    const orphan = this.#orphan(state);
    const terminalRecovery = Boolean(
      state.finalDisposition === 'superseded' &&
      orphan &&
      state.activeOperation &&
      state.operations[state.activeOperation.id]?.status === 'running' &&
      Object.values(state.operations).some(
        (operation) => operation.resultRunId && operation.preparationHash,
      ),
    );
    const capabilities = calculateCapabilities({ ...state, planVersion: state.planVersion - (state.planningTransitions ?? 0) }, plan, {
      runner: this.adapters.runner,
      historical: plan.registryHash !== REGISTRY_HASH || plan.policyHash !== POLICY_HASH,
      orphan,
      terminalRecovery,
      semanticUncertainty: this.#semanticUncertainty(state),
      lock: state.setupPending
        ? { recoverable: false }
        : lock
          ? { recoverable: lock.status === 'dead' }
          : null,
    });
    if (plan.stage === 'planning') {
      const planner = plan.nodes.find((node) => node.action.id === 'ai-plan');
      const ready = state.nodes[planner.id].status === 'passed';
      const usable = !state.activeOperation && !state.finalDisposition && !state.setupPending && !lock;
      if (ready && usable) capabilities.run.requestReplan = { allowed: true, reason: null };
      if (!ready && !['ready', 'failed', 'cancelled', 'uncertain', 'stale'].includes(state.status))
        capabilities.run.requestReplan = { allowed: false, reason: 'Сначала выполните AI-планирование' };
      for (const definition of plan.nodes.filter((node) => node.action.id === 'human-accept')) {
        capabilities.nodes[definition.id].accept = { allowed: false, reason: 'Planning не является результатом реализации' };
      }
    }
    if (
      !state.activeOperation &&
      (!lock || lock.status === 'dead') &&
      Object.values(state.operations).some(
        (op) => op.status === 'creating' && op.preparationHash && op.resultRunId,
      )
    )
      capabilities.run.recover = { allowed: true, reason: null };
    if (!lock && canReplanRejectedImplementation(state, plan,
      (id) => ReceiptSchema.parse(this.store.readObject('receipts', id))))
      capabilities.run.requestReplan = { allowed: true, reason: null };
    if (!state.binding && this.adapters.readiness) {
      const readiness = this.adapters.readiness(this.store.readObject('tasks', state.taskHash));
      if (!readiness.available)
        for (const collection of [capabilities.run, ...Object.values(capabilities.nodes)])
          for (const name of ['run', 'retry', 'rerunCheck'])
            collection[name] = { allowed: false, reason: readiness.reason };
    }
    const deadline = this.#executionDeadline(state, plan);
    if (deadline !== null && Date.now() >= deadline) {
      for (const collection of [capabilities.run, ...Object.values(capabilities.nodes)])
        for (const key of ['run','retry','rerunCheck']) collection[key] = { allowed: false, reason: 'Истек срок согласованного автономного выполнения' };
    }
    const editable = plan.workflow === 'autonomous' && plan.stage === 'execution' &&
      state.nodes['approve-plan']?.status === 'waiting-for-human' && !state.activeOperation && !state.finalDisposition && !lock;
    capabilities.run.revisePlan = { allowed: editable && (this.store.readObject('tasks', state.taskHash).planningFeedback?.length ?? 0) < 10, reason: editable ? null : 'План можно уточнить до согласования' };
    const planner = plan.nodes.find((node) => node.action.id === 'ai-plan');
    const replanCapability = {
      ...capabilities.run.requestReplan,
      label: plan.stage === 'planning'
        ? (planner && state.nodes[planner.id].status === 'passed' ? 'Показать план реализации' : 'Повторить планирование')
        : 'Новая версия плана',
    };
    capabilities.run.requestReplan = replanCapability;
    // Replan changes the whole immutable plan, so node details must expose the same boundary.
    for (const node of Object.values(capabilities.nodes)) node.requestReplan = { ...replanCapability };
    return capabilities;
  }
  #challenge(state, nodeId, expiresAt) {
    const input = [state.runId, state.planHash, state.revision, nodeId, expiresAt].join(':');
    return `${expiresAt}.${createHmac('sha256', this.challengeKey).update(input).digest('hex')}`;
  }
  #verifyChallenge(state, nodeId, challenge) {
    if (typeof challenge !== 'string')
      fail('GATE_CHALLENGE', 'Нужно открыть актуальное подтверждение');
    const expiresAt = Number(challenge.split('.')[0]);
    const expected = this.#challenge(state, nodeId, expiresAt);
    if (
      !Number.isSafeInteger(expiresAt) ||
      expiresAt < Date.now() ||
      expiresAt > Date.now() + 300001 ||
      Buffer.byteLength(challenge) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(challenge), Buffer.from(expected))
    )
      fail('GATE_CHALLENGE', 'Подтверждение устарело или не принадлежит текущему плану');
  }

  snapshot(runId) {
    return this.#snapshot(runId, true);
  }

  #snapshot(runId, verifySource) {
    return projectSnapshot({ adapters: this.adapters, sanitizeText, safeReason,
      artifactMetadata: this.#artifactMetadata.bind(this),
      caps: this.#caps.bind(this),
      challenge: this.#challenge.bind(this),
      delivery: this.#delivery.bind(this),
      read: this.#read.bind(this),
      taskProof: this.#taskProof.bind(this),
      contextClarification: this.#contextClarification.bind(this),
      resultKind: (node) => resultKind(node, (id) => this.store.readObject('receipts', id)),
      workflowProgress: this.#workflowProgress.bind(this)
    }, runId, verifySource);
  }

  // SSE carries only persisted revision hints. It never evaluates execution permission.
  revision(runId) {
    return this.store.revision(runId);
  }

  listRuns() {
    // Listing history must not rehash every source archive or spawn ownership checks.
    // Capabilities and full source integrity are evaluated when opening a snapshot/command.
    let context = null,
      contextError = null;
    try {
      context = { runtimeHash: this.adapters.identity(), resolveSkills: this.adapters.resolveSkills, resolveReadPaths: this.adapters.resolveReadPaths };
    } catch (error) {
      contextError = error;
    }
    return this.store
      .listRunIds()
      .filter((runId) => this.store.readRun(runId).kind !== 'intake-operation')
      .map((runId) => {
        let loaded = null,
          reason = null;
        try {
          loaded = this.#read(runId, { current: false, verifySource: false });
          if (contextError) throw contextError;
          validatePlan(loaded.plan, loaded.task, { ...context, skills: this.adapters.skills(loaded.task), contextHash: this.adapters.contextHash?.(loaded.task), provider: this.adapters.project?.ai.provider });
        } catch (error) {
          reason = safeReason(error);
        }
        const state = loaded?.state,
          task = loaded?.task;
        return {
          runId,
          task: task
            ? {
                id: task.id,
                taskNumber: sanitizeText(task.taskNumber ?? task.id),
                goal: sanitizeText(task.goal),
                scope: task.scope,
                acceptance: task.acceptance.map(sanitizeText),
              }
            : null,
          status: reason ? 'stale' : state.status,
          resolutionKind: state?.status === 'uncertain'
            ? (Object.values(state.nodes).filter((node) => node.status === 'uncertain')
              .every((node) => resultKind(node, (id) => this.store.readObject('receipts', id)) === 'semantic') ? 'semantic' : 'process')
            : null,
          revision: state?.revision ?? null,
          planVersion: state?.planVersion ?? null,
          planHash: state?.planHash ?? null,
          updatedAt: state?.updatedAt ?? null,
          integrity: { valid: !reason, reason, checked: 'metadata' },
        };
      })
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }
  plan(runId) {
    return structuredClone(this.#read(runId, { current: false, verifySource: false }).plan);
  }
  events(runId, afterRevision = -1) {
    this.#read(runId, { current: false, verifySource: false });
    return this.store.history(runId, { afterRevision, limit: 100 }).map((state) => ({
      runId,
      revision: state.revision,
      at: state.updatedAt,
      status: state.status,
      planHash: state.planHash,
      nodes: Object.entries(state.nodes).map(([id, node]) => ({
        id,
        status: node.status,
        attempt: node.attempts,
        receiptIds: node.receipts,
      })),
    }));
  }
  receipt(runId, hash) {
    const { state } = this.#read(runId, { current: false, verifySource: false });
    if (state.requirementReceipts?.includes(hash)) return RequirementAcceptanceReceiptSchema.parse(this.store.readObject('receipts', hash));
    if (!Object.values(state.nodes).some((n) => n.receipts.includes(hash)))
      fail('NOT_FOUND', 'Receipt не принадлежит run');
    return ReceiptSchema.parse(this.store.readObject('receipts', hash));
  }
  artifact(runId, hash) {
    const { state } = this.#read(runId, { current: false, verifySource: false });
    if (
      ![
        ...state.planningArtifacts,
        ...Object.values(state.nodes).flatMap((n) => n.artifacts),
      ].includes(hash)
    )
      fail('NOT_FOUND', 'Artifact не принадлежит run');
    return { id: hash, ...this.#artifact(hash) };
  }
  #artifact(hash) {
    const stored = this.store.readObject('artifacts', hash);
    if (!Array.isArray(stored.parts)) fail('ARTIFACT_INTEGRITY', 'Artifact chunks отсутствуют');
    const { parts, ...metadata } = stored;
    return ArtifactSchema.parse({ ...metadata, content: parts.join('') });
  }
  #artifactMetadata(hash) {
    const artifact = this.#artifact(hash);
    return {
      id: hash,
      kind: artifact.kind,
      title: artifact.title,
      mediaType: artifact.mediaType,
      size: Buffer.byteLength(artifact.content),
    };
  }
  #putArtifact(kind, title, data, mediaType = 'application/json') {
    const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    const artifact = ArtifactSchema.parse({ schemaVersion: 2, kind, title, mediaType, content });
    if (Buffer.byteLength(content) > 3 * 1024 * 1024)
      fail('ARTIFACT_LIMIT', 'Artifact превышает 3 MiB; сократите задачу');
    const parts = [];
    for (let i = 0; i < content.length; i += 8000) parts.push(content.slice(i, i + 8000));
    const { content: _, ...metadata } = artifact;
    return this.store.putObject('artifacts', { ...metadata, parts });
  }

  #write(state, update) {
    return this.store.updateRun(state.runId, state.revision, (current) => ({
      ...structuredClone(current),
      ...update,
      updatedAt: now(),
    }));
  }
  #persistFingerprint(fingerprint) {
    return this.store.putFingerprint(fingerprint);
  }
  #resolveFingerprint(reference) {
    if (!reference) fail('FINGERPRINT_MISSING', 'Не найден снимок состояния проекта');
    return Array.isArray(reference.files) ? reference : this.store.readFingerprint(reference.hash);
  }
  #providerConsent(state, task, plan) {
    const provider = this.adapters.project?.ai.provider;
    if (!externalProvider(provider)) return null;
    if (!state.providerConsentHash) fail('PROVIDER_CONSENT_REQUIRED', 'До запуска Claude Code/Cursor нужно отдельное согласие на передачу данных.');
    let consent;
    try { consent = ExternalConsentSchema.parse(this.store.readObject('provider-consents', state.providerConsentHash)); }
    catch { fail('PROVIDER_CONSENT_INVALID', 'Сохраненное согласие provider отсутствует или повреждено.'); }
    const expected = {
      provider,
      planHash: state.planHash,
      scopeHash: hashObject({ scope: task.scope, readPaths: plan.nodes.filter((node) => node.action.id.startsWith('ai-')).flatMap((node) => node.resources.reads).sort(), sourceHash: state.sourceHash }),
      instructionsHash: hashObject({ instructions: task.instructions, acceptance: task.acceptance }),
      skillsHash: hashObject(plan.skills),
      artifactsHash: hashObject({ analysisArtifact: plan.analysisArtifact ?? null }),
    };
    if (Object.entries(expected).some(([key, value]) => consent[key] !== value))
      fail('PROVIDER_CONSENT_STALE', 'Согласие не относится к текущему плану, scope или контексту.');
    const toolchain = providerToolchain(this.adapters.project.ai);
    if (consent.cliPath !== toolchain.executable || consent.cliVersion !== toolchain.version)
      fail('PROVIDER_VERSION_DRIFT', 'CLI изменился после согласия. Повторите setup и согласие.');
    return { hash: state.providerConsentHash, consent, toolchain };
  }
  #receipt(state, task, plan, definition, fields) {
    const node = state.nodes[definition.id];
    return this.store.putObject(
      'receipts',
      ReceiptSchema.parse({
        schemaVersion: 2,
        runId: state.runId,
        nodeId: definition.id,
        attemptId: `attempt-${randomUUID()}`,
        attempt: Math.max(1, node.attempts),
        phase: 'finished',
        actionId: definition.action.id,
        actionVersion: definition.action.version,
        planVersion: plan.version,
        planHash: state.planHash,
        taskHash: state.taskHash,
        sourceHash: state.sourceHash,
        runtimeHash: plan.runtimeHash,
        instructionsHash: hashObject({
          instructions: task.instructions,
          acceptance: task.acceptance,
          outcome: definition.outcome,
        }),
        skills: plan.skills.filter((s) => definition.skills.includes(s.id)),
        permissions: definition.permissions,
        grantedPermissions: state.permissions,
        termination: null,
        startedAt: now(),
        finishedAt: now(),
        durationMs: 0,
        exitCode: null,
        verdict: 'uncertain',
        checks: [],
        artifacts: [],
        changedFiles: [],
        failureReason: null,
        beforeFingerprint: state.workspaceFingerprint?.hash ?? state.sourceHash,
        afterFingerprint: state.workspaceFingerprint?.hash ?? state.sourceHash,
        actor: state.actor,
        operationId: state.activeOperation?.id ?? `receipt-${randomUUID()}`,
        previousReceipt: node.receipts.at(-1) ?? null,
        providerConsentHash: state.providerConsentHash ?? null,
        ...fields,
      }),
    );
  }

  async command(runId, name, input, options = {}) {
    this.#assertOpen(); this.pendingMutations++;
    try { return await this.#command(runId, name, input, options); } finally { this.pendingMutations--; }
  }
  async #command(runId, name, input, { actor = 'local-operator' } = {}) {
    this.#assertOpen();
    assertJsonBounds(input);
    const request = ControlRequestSchema.parse(input);
    if (request.contextSelection && name !== 'replan') fail('INVALID_CONTROL', 'Уточнение контекста допустимо только для новой версии плана');
    if (!['run', 'retry', 'rerun-check', 'gate', 'recover', 'stop', 'replan', 'revise-plan', 'verify-requirement'].includes(name))
      fail('UNKNOWN_CONTROL', 'Control action не разрешен');
    let { state, task, plan } = this.#read(runId, {
      // A revision only creates a fresh read-only plan; it never executes the historical one.
      current: !['replan', 'revise-plan', 'recover', 'stop'].includes(name),
    });
    const digest = hashObject({ name, request, actor });
    const prior = state.operations[request.operationId];
    if (prior) {
      if (prior.digest !== digest)
        fail('IDEMPOTENCY_CONFLICT', 'operationId уже использован для другого запроса');
      if (name === 'replan' && prior.status === 'creating')
        return this.#finishReplan(state, request, digest, actor, prior);
      return prior.resultRunId ? this.snapshot(prior.resultRunId) : this.snapshot(runId);
    }
    if (Object.keys(state.operations).length >= 200)
      fail('OPERATION_LIMIT', 'Лимит управляющих операций исчерпан');
    if (state.revision !== request.expectedRevision)
      fail('REVISION_CONFLICT', 'Откройте актуальный snapshot');
    if (state.planHash !== request.planHash)
      fail('PLAN_CONFLICT', 'Запрос относится к другому плану');
    if (name === 'verify-requirement')
      return this.#proofService().acceptRequirement({ runId, state, plan, request, digest, actor });
    const caps = this.#caps(state, plan);
    const definition = request.nodeId ? plan.nodes.find((n) => n.id === request.nodeId) : null;
    if (request.nodeId && !definition) fail('NODE_NOT_FOUND', 'Node отсутствует в immutable плане');
    if (name === 'gate') {
      if (!definition || !request.decision)
        fail('INVALID_CONTROL', 'Gate требует nodeId и decision');
      const cap =
        request.decision === 'accept'
          ? 'accept'
          : request.decision === 'reject'
            ? 'reject'
            : 'approve';
      if (!caps.nodes[definition.id][cap]?.allowed) fail('CONTROL_DENIED', 'Решение недоступно');
      const providerGate = definition.action.id === 'human-provider-consent';
      if (providerGate && !externalProvider(this.adapters.project?.ai.provider))
        fail('PROVIDER_CONSENT_UNEXPECTED', 'Этот plan не использует внешний provider.');
      if (providerGate && !['approve', 'reject'].includes(request.decision))
        fail('PROVIDER_CONSENT_DECISION', 'Для provider consent доступны только approve или reject.');
      this.#verifyChallenge(state, definition.id, request.challenge);
      if (request.decision !== 'reject' && definition.action.id === 'human-accept')
        await this.#assertWorkspace(state);
      const required = providerGate ? [] : unique(plan.nodes.flatMap((n) => n.permissions));
      if (
        request.decision === 'approve' &&
        hashObject([...(request.permissions ?? [])].sort()) !== hashObject(required.sort())
      )
        fail('PERMISSION_GRANT', 'Необходимо явно подтвердить точный набор прав плана');
      const rejected = request.decision === 'reject';
      let providerConsentHash = null;
      if (providerGate && !rejected) {
        const toolchain = providerToolchain(this.adapters.project.ai);
        const consent = makeExternalConsent({
          provider: this.adapters.project.ai.provider,
          planHash: state.planHash,
          scopeHash: hashObject({ scope: task.scope, readPaths: plan.nodes.filter((node) => node.action.id.startsWith('ai-')).flatMap((node) => node.resources.reads).sort(), sourceHash: state.sourceHash }),
          instructionsHash: hashObject({ instructions: task.instructions, acceptance: task.acceptance }),
          skillsHash: hashObject(plan.skills), artifactsHash: hashObject({ analysisArtifact: plan.analysisArtifact ?? null }), toolchain,
        });
        providerConsentHash = this.store.putObject('provider-consents', consent);
      }
      const receipt = this.#receipt(state, task, plan, definition, {
        phase: 'gate',
        grantedPermissions: request.decision === 'approve' ? required : state.permissions,
        verdict: rejected ? 'fail' : 'pass',
        actor,
        operationId: request.operationId,
        ...(providerConsentHash ? { providerConsentHash } : {}),
        failureReason: rejected ? sanitizeText(request.reason ?? 'Отклонено оператором') : null,
      });
      const nodes = structuredClone(state.nodes),
        node = nodes[definition.id];
      Object.assign(node, {
        status: rejected ? 'failed' : 'passed',
        attempts: 1,
        receipts: [...node.receipts, receipt],
        startedAt: now(),
        finishedAt: now(),
        durationMs: 0,
        reason: rejected ? 'Отклонено оператором' : null,
      });
      const next = reconcile(
        {
          ...state,
          nodes,
          permissions: request.decision === 'approve' && !providerGate ? required : state.permissions,
          ...(providerConsentHash ? { providerConsentHash } : {}),
          finalDisposition: rejected
            ? 'rejected'
            : request.decision === 'accept'
              ? 'accepted'
              : null,
          status: rejected ? 'failed' : request.decision === 'accept' ? 'passed' : state.status,
        },
        plan,
      );
      this.#write(state, {
        ...next,
        operations: { ...state.operations, [request.operationId]: { digest, status: 'finished' } },
      });
      if (plan.workflow === 'autonomous' && request.decision === 'approve') this.#schedule(runId);
      return this.snapshot(runId);
    }
    if (name === 'stop') {
      if (!caps.run.stop.allowed) fail('CONTROL_DENIED', 'Нет активной операции');
      state = this.#write(state, {
        stopRequested: true,
        stopResult: {
          operationId: state.activeOperation.id,
          requestedAt: now(),
          state: 'requested',
          reason: null,
        },
        operations: { ...state.operations, [request.operationId]: { digest, status: 'finished' } },
      });
      this.active.get(runId)?.abort();
      return this.snapshot(runId);
    }
    if (name === 'recover')
      return this.#recover({ state, task, plan, request, digest, actor, caps });
    if (name === 'revise-plan') return this.#revise({ state, task, plan, request, digest, actor, caps });
    if (name === 'replan') return this.#replan({ state, task, plan, request, digest, actor, caps });
    const retry = name === 'retry' || name === 'rerun-check';
    if (
      retry &&
      (!definition || !caps.nodes[definition.id][name === 'retry' ? 'retry' : 'rerunCheck'].allowed)
    )
      fail('RETRY_UNSAFE', 'Повтор не подтвержден runtime');
    if (!retry && !(definition ? caps.nodes[definition.id].run.allowed : caps.run.run.allowed))
      fail('CONTROL_DENIED', 'Запуск сейчас недоступен');
    const deadline = this.#executionDeadline(state, plan);
    if (deadline !== null && Date.now() >= deadline) fail('AUTONOMY_LIMIT', 'Истек срок согласованного автономного выполнения');
    if (state.binding) await this.#assertWorkspace(state);
    const operation = {
      id: request.operationId,
      digest,
      ownerPid: process.pid,
      ownerStart: this.ownerStart,
      nodeId: null,
      process: null,
      startedAt: now(),
    };
    state = this.#write(state, {
      activeOperation: operation,
      stopRequested: false,
      stopResult: null,
      actor,
      operations: { ...state.operations, [request.operationId]: { digest, status: 'running' } },
    });
    const controller = new AbortController();
    const deadlineTimer = deadline === null ? null : setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
    deadlineTimer?.unref();
    this.active.set(runId, controller);
    const stopMonitor = setInterval(() => {
      try {
        const current = this.store.readRun(runId);
        if (current.stopRequested || current.activeOperation?.id !== operation.id)
          controller.abort();
      } catch {
        controller.abort();
      }
    }, 500);
    stopMonitor.unref();
    try {
      if (!state.binding) {
        const binding = await this.adapters.allocate({
          runId,
          task,
          sourceBundle: state.sourceBundle,
          sourceHash: state.sourceHash,
          owner: actor,
          existingBinding: state.pendingBinding ?? undefined,
        });
        this.adapters.verifyBinding(binding);
        const toolchain = this.adapters.prepareToolchain?.(binding.worktree) ?? null;
        const fingerprint = this.adapters.fingerprint(binding.worktree, toolchain);
        const storedFingerprint = this.#persistFingerprint(fingerprint);
        state = this.store.readRun(runId);
        if (state.activeOperation?.id !== operation.id)
          fail('EXECUTION_FENCED', 'Операция больше не владеет run');
        state = this.#write(state, {
          binding,
          toolchain,
          workspaceFingerprint: storedFingerprint,
          initialFingerprint: storedFingerprint,
          pendingBinding: null,
        });
      }
      if (retry) {
        const nodes = structuredClone(state.nodes);
        nodes[definition.id].status = 'ready';
        nodes[definition.id].retrySafe = false;
        state = this.#write(state, { nodes, status: 'ready' });
      }
      while (true) {
        state = this.store.readRun(runId);
        if (state.stopRequested || controller.signal.aborted) break;
        this.#read(runId);
        const ready = plan.nodes.find(
          (n) => state.nodes[n.id].status === 'ready' && (!definition || n.id === definition.id),
        );
        if (!ready) break;
        state = await this.#execute(state, task, plan, ready, controller.signal);
        if (['failed', 'cancelled', 'uncertain', 'stale'].includes(state.status) || definition) break;
      }
      state = this.store.readRun(runId);
      if (state.activeOperation?.id === operation.id)
        this.#write(state, {
          activeOperation: null,
          ...(state.stopRequested && state.stopResult?.state === 'requested' && !state.activeOperation.process
            ? {
                status: 'cancelled',
                stopResult: {
                  ...state.stopResult,
                  state: 'stopped',
                  reason: null,
                },
              }
            : {}),
          operations: {
            ...state.operations,
            [request.operationId]: { digest, status: 'finished' },
          },
        });
    } catch (error) {
      state = this.store.readRun(runId);
      if (state.activeOperation?.id !== operation.id || state.finalDisposition)
        return this.snapshot(runId);
      const pending =
        error instanceof GraphError && error.details?.binding
          ? RunStateSchema.shape.pendingBinding.safeParse(error.details.binding)
          : null;
      const nodes = structuredClone(state.nodes);
      for (const node of Object.values(nodes))
        if (node.status === 'running') {
          node.status = 'uncertain';
          node.reason = safeReason(error);
          node.retrySafe = false;
        }
      const hasRunning = Object.values(nodes).some((n) => n.status === 'uncertain');
      this.#write(state, {
        nodes,
        status: hasRunning ? 'uncertain' : 'failed',
        failureReason: safeReason(error),
        ...(pending?.success ? { pendingBinding: pending.data } : {}),
        activeOperation: null,
        operations: { ...state.operations, [request.operationId]: { digest, status: 'failed' } },
      });
    } finally {
      clearInterval(stopMonitor);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      this.active.delete(runId);
    }
    return this.snapshot(runId);
  }

  async #assertWorkspace(state) {
    this.adapters.verifyBinding(state.binding);
    if (this.adapters.verifyToolchain)
      this.adapters.verifyToolchain(state.binding.worktree, state.toolchain);
    const actual = this.adapters.fingerprint(state.binding.worktree, state.toolchain);
    if (actual.hash !== state.workspaceFingerprint.hash)
      fail('WORKSPACE_DRIFT', 'Workspace изменился после последних evidence; требуется новый план');
    return actual;
  }

  #assertExecutionOwner(current, executionState, definition, { allowStop = false } = {}) {
    const expected = executionState.activeOperation;
    if (
      !expected ||
      current.planHash !== executionState.planHash ||
      current.taskHash !== executionState.taskHash ||
      current.sourceHash !== executionState.sourceHash ||
      current.finalDisposition ||
      current.activeOperation?.id !== expected.id ||
      current.activeOperation.digest !== expected.digest ||
      current.activeOperation.nodeId !== definition.id ||
      current.nodes[definition.id]?.status !== 'running' ||
      (!allowStop && current.stopRequested)
    )
      fail('EXECUTION_FENCED', 'Операция больше не владеет run');
  }

  #applyFencedEdits(executionState, task, plan, definition, before, edits, moves = [], jsonTransfers = []) {
    const loaded = this.#read(executionState.runId);
    const deadline = this.#executionDeadline(loaded.state, plan);
    if (deadline !== null && Date.now() >= deadline) fail('AUTONOMY_LIMIT', 'Истек срок согласованного автономного выполнения');
    this.#assertExecutionOwner(loaded.state, executionState, definition);
    const withBindingFence = this.adapters.withBindingFence
      ? this.adapters.withBindingFence.bind(this.adapters)
      : (binding, callbackSync) => {
          this.adapters.verifyBinding(binding);
          return callbackSync();
        };
    return withBindingFence(loaded.state.binding, () =>
      this.store.withRunFence(executionState.runId, loaded.state.revision, (current) => {
        this.#assertExecutionOwner(current, executionState, definition);
        validatePlan(plan, task, {
          runtimeHash: this.adapters.identity(),
          skills: this.adapters.skills(task),
      resolveSkills: this.adapters.resolveSkills,
      resolveReadPaths: this.adapters.resolveReadPaths,
      contextHash: this.adapters.contextHash?.(task),
      provider: this.adapters.project?.ai.provider,
        });
        if (hashObject(current.binding) !== hashObject(executionState.binding))
          fail('EXECUTION_FENCED', 'Binding операции был заменен');
        if (this.adapters.verifyToolchain)
          this.adapters.verifyToolchain(current.binding.worktree, current.toolchain);
        const unchanged = this.adapters.fingerprint(current.binding.worktree, current.toolchain);
        if (current.workspaceFingerprint?.hash !== before.hash || unchanged.hash !== before.hash)
          fail('WORKSPACE_DRIFT', 'Workspace изменился до применения patch');
        this.adapters.applyEdits(current.binding.worktree, before, definition, task, edits, moves, jsonTransfers);
        return this.adapters.fingerprint(current.binding.worktree, current.toolchain);
      }),
    );
  }

  async #execute(state, task, plan, definition, signal) {
    return executeNode({ root: this.root, store: this.store, adapters: this.adapters,
      sanitizeText, safeReason, privateDirectory,
      analysis: this.#analysis.bind(this),
      applyFencedEdits: this.#applyFencedEdits.bind(this),
      artifact: this.#artifact.bind(this),
      assertExecutionOwner: this.#assertExecutionOwner.bind(this),
      assertWorkspace: this.#assertWorkspace.bind(this),
      executionHistory: this.#executionHistory.bind(this),
      providerConsent: this.#providerConsent.bind(this),
      putArtifact: this.#putArtifact.bind(this),
      initialFingerprint: this.#resolveFingerprint.bind(this),
      persistFingerprint: this.#persistFingerprint.bind(this),
      read: this.#read.bind(this),
      receipt: this.#receipt.bind(this),
      reviewHistory: this.#reviewHistory.bind(this),
      write: this.#write.bind(this)
    }, state, task, plan, definition, signal);
  }

  async #recover({ state, task, plan, request, digest, actor, caps }) {
    if (!caps.run.recover.allowed)
      fail('RECOVERY_DENIED', 'Нет подтвержденного orphan или uncertain состояния');
    return recoverRun({ store: this.store, adapters: this.adapters, ownerStart: this.ownerStart,
      write: this.#write.bind(this), finishReplan: this.#finishReplan.bind(this),
      persistFingerprint: this.#persistFingerprint.bind(this),
      snapshot: this.snapshot.bind(this), orphan: this.#orphan.bind(this), receipt: this.#receipt.bind(this),
    }, { state, task, plan, request, digest, actor });
  }

  #replanHost() {
    return { store: this.store, adapters: this.adapters,
      semanticUncertainty: this.#semanticUncertainty.bind(this), assertWorkspace: this.#assertWorkspace.bind(this),
      read: this.#read.bind(this), analysis: this.#analysis.bind(this), artifact: this.#artifact.bind(this),
      assertConfiguredChecks, write: this.#write.bind(this), create: this.create.bind(this),
      persistFingerprint: this.#persistFingerprint.bind(this), resolveFingerprint: this.#resolveFingerprint.bind(this),
      snapshot: this.snapshot.bind(this), schedule: this.#schedule.bind(this),
      resolveContextSelection: this.#resolveContextSelection.bind(this),
    };
  }
  async #replan({ state, task, plan, request, digest, actor, caps, policyGrant = undefined, discoveryChange = null }) {
    if (
      state.activeOperation ||
      Object.values(state.nodes).some((node) => node.status === 'running') ||
      (state.status === 'uncertain' && !state.recovered && !this.#semanticUncertainty(state))
    )
      fail('RECOVERY_REQUIRED', 'Перед replan требуется доказанное recovery');
    if (!caps.run.requestReplan.allowed)
      fail('REPLAN_DENIED', 'Replan недоступен или бюджет исчерпан');
    if (request.contextSelection && (policyGrant || request.draft || !this.#contextClarification(state, plan)))
      fail('CONTEXT_CLARIFICATION_DENIED', 'Область можно уточнить после остановленного анализа, до согласования реализации');
    if (policyGrant && state.binding) await this.#assertWorkspace(state);
    return replanRun(this.#replanHost(), { state, task, plan, request, digest, actor, policyGrant, discoveryChange });
  }
  async #finishReplan(state, request, digest, actor, prior) {
    return finishReplan(this.#replanHost(), state, request, digest, actor, prior);
  }

}
