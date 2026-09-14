import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, existsSync } from 'node:fs';
import path from 'node:path';
import * as ProjectPolicy from './project.mjs';
import { RUNTIME_ROOT, loadProjectProfile, projectContextPaths } from './project.mjs';
import { spawnSync } from 'node:child_process';
import { GraphError, hashObject, sha256, now } from './io.mjs';
import { GraphStore } from './store.mjs';
import { loadSkill, verifySkillsUsed } from './skills.mjs';
import * as SkillsPolicy from './skills.mjs';
import { compilePlanningPlan, compileTaskProposal } from './planning.mjs';
import { projectSummary } from './intake.mjs';
import { acquireRuntimeLease } from './lifecycle.mjs';
import { SKILL_ROUTES } from './config.mjs';
import {
  TaskInputSchema,
  TaskSpecSchema,
  PlanningEnvelopeSchema,
  ControlRequestSchema,
  ReceiptSchema,
  RunStateSchema,
  ArtifactSchema,
  AIResultSchema,
  AIPlanningResultSchema,
  AIAnalysisResultSchema,
  NaturalIntakeSchema,
  AIReviewResultSchema,
  assertJsonBounds,
  Id,
} from './schemas.mjs';
import { compilePlan, validatePlan, assertPlanHash } from './validator.mjs';
import { POLICY_HASH, REGISTRY_HASH, resolveAction, pathAllowed, overlaps } from './registry.mjs';
import { initialNodes, reconcile, calculateCapabilities } from './state.mjs';
import { captureSourceBundle, verifySourceBundle } from './source.mjs';
import { captureBeforeContents, buildAttemptDiff } from './artifacts.mjs';
import { buildReviewEvidence } from './review-evidence.mjs';
import { applyProposedEdits } from './patch.mjs';
import { prepareToolchain, verifyToolchain } from './toolchain.mjs';

const fail = (code, message) => {
  throw new GraphError(code, message);
};
const unique = (values) => [...new Set(values)];
const safeReason = (error) =>
  error instanceof GraphError
    ? `${error.code}: ${sanitizeText(error.message)}`
    : 'INTERNAL_ERROR: операция не завершена; требуется проверка evidence';
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

/** Text from actions is untrusted. Never expose host paths, credentials or raw command output. */
export function sanitizeText(value) {
  return String(value)
    .replace(
      /-----BEGIN [\s\S]*?PRIVATE KEY-----[\s\S]*?-----END [\s\S]*?PRIVATE KEY-----/g,
      '[redacted]',
    )
    .replace(/\b(?:sk-[\w-]{8,}|Bearer\s+[\w./-]+)\b/gi, '[redacted]')
    .replace(
      /((?:api[_-]?key|password|secret|access[_-]?token|authorization)\s*[=:]\s*)[^\s,;]+/gi,
      '$1[redacted]',
    )
    .replace(/\/(?:Users|home|private|tmp|var)\/[^\s"'<>]+/g, '[host-path]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '') // eslint-disable-line no-control-regex -- remove unsafe control characters
    .slice(0, 12000);
}

function readTrusted(root, relative) {
  const file = path.join(root, relative);
  for (let cursor = file; cursor !== root; cursor = path.dirname(cursor)) {
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink() || (cursor === file && (!stat.isFile() || stat.nlink !== 1)))
      fail('UNSAFE_RUNTIME', 'Runtime или инструкции содержат ссылку');
  }
  return readFileSync(file);
}

export function runtimeIdentity(root) {
  const profile = loadProjectProfile(root);
  const files = [
    'package.json',
    'scripts/ai-orchestrator.mjs',
    'scripts/ai-graph/cli.mjs',
    'scripts/ai-graph/serve.mjs',
    'tools/ai-graph-viewer/controller.mjs',
    'tools/ai-graph-viewer/server.mjs',
    'scripts/ai-graph/container-check.mjs',
    'scripts/ai-graph/Dockerfile.checks',
  ];
  const visit = (relative) => {
    for (const entry of readdirSync(path.join(RUNTIME_ROOT, relative), { withFileTypes: true })) {
      const file = `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(file);
      else if (/\.(mjs|json|md)$/.test(entry.name)) files.push(file);
    }
  };
  visit('scripts/ai-graph/lib');
  visit('skills');
  if (existsSync(path.join(RUNTIME_ROOT, 'bin'))) visit('bin');
  for (const lock of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'])
    if (existsSync(path.join(RUNTIME_ROOT, lock))) files.push(lock);
  const instructions = [];
  let instructionBytes = 0;
  const visitContext = (relative) => {
    const stat = lstatSync(path.join(root, relative));
    if (stat.isSymbolicLink()) fail('UNSAFE_RUNTIME', 'Project context must not contain links');
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path.join(root, relative)))
        visitContext(`${relative.replace(/\/$/, '')}/${entry}`);
    } else {
      if (instructions.length >= 20000 || (instructionBytes += stat.size) > 64 * 1024 * 1024)
        fail('CONTEXT_TOO_LARGE', 'Project instruction identity exceeds the bounded context size');
      instructions.push({ path: relative, hash: sha256(readTrusted(root, relative)) });
    }
  };
  for (const relative of projectContextPaths(root, profile).sort()) visitContext(relative);
  return hashObject({
    runtime: files
      .sort()
      .map((file) => ({ path: file, hash: sha256(readTrusted(RUNTIME_ROOT, file)) })),
    profile,
    instructions,
  });
}

function currentSkills(root) {
  return unique(Object.values(SKILL_ROUTES).flat())
    .sort()
    .map((id) => {
      const skill = loadSkill(root, id);
      return { id, path: skill.path, hash: skill.hash };
    });
}

function privateDirectory(parent, name) {
  const directory = path.join(parent, name);
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    fail('INSECURE_STORE', 'Control directory должна быть private и без ссылок');
  return directory;
}

const loadedRuntimeHashes = new Map();
function pinnedRuntimeIdentity(root) {
  const current = runtimeIdentity(root);
  if (!loadedRuntimeHashes.has(root)) loadedRuntimeHashes.set(root, current);
  if (loadedRuntimeHashes.get(root) !== current)
    fail(
      'RUNTIME_DRIFT',
      'Runtime изменился: перезапустите локальный server перед новой версией плана',
    );
  return current;
}

async function defaultAdapters(root) {
  const [runner, workspace, orchestrator, dockerChecks] = await Promise.all([
    import('./runner.mjs'),
    import('./workspace.mjs'),
    import('./orchestrator.mjs'),
    import('./docker-checks.mjs'),
  ]);
  pinnedRuntimeIdentity(root);
  const profile = loadProjectProfile(root);
  // These modules are bundled trusted runtime code, never a user-supplied import path.
  const rulesFile = new URL('./instructions.mjs', import.meta.url);
  const rules = existsSync(rulesFile) ? await import(rulesFile.href) : null;
  const resolveContext = Reflect.get(SkillsPolicy, 'resolveNodeSkills');
  const projectSkills = Reflect.get(profile, 'skillManifest') ?? [];
  const contextual = (action, scope) => resolveContext(root, { action, scope: scope.map((entry) => entry.replace(/\/$/, '')), manifestPaths: profile.manifests, projectSkills });
  const instructionInspection = () => {
    const inspection = rules?.inspectInstructions({ projectRoot: root });
    if (inspection && !inspection.complete) fail('INSTRUCTION_INCOMPLETE', 'Discovery инструкций неполное; требуется уточнить проектный контекст');
    return inspection;
  };
  const relevantInstructions = (scope = null) => (instructionInspection()?.files ?? []).filter((file) =>
    file.kind !== 'project-skill' && (!scope || file.scope === '.' || scope.some((entry) => overlaps(entry, file.scope))));
  const resolveReadPaths = (node, task) => {
    if (!node.action.id.startsWith('ai-')) return node.resources.reads;
    const discovered = new Set((instructionInspection()?.files ?? []).map((file) => file.path));
    const scope = node.resources.writes.length ? node.resources.writes : task.scope;
    return unique([...task.scope, ...task.contextPaths.filter((file) => !discovered.has(file)),
      ...relevantInstructions(scope).map((file) => file.path)]);
  };
  const resolveSkills = (node, task) => node.action.id.startsWith('ai-') && resolveContext
    ? contextual(node.action.id, node.resources.writes.length ? node.resources.writes : task.scope).ids
    : [...resolveAction(node.action.id).skills];
  return {
    project: profile,
    identity: () => hashObject({ runtime: pinnedRuntimeIdentity(root), instructions: instructionInspection()?.fingerprint ?? null }),
    instructionPaths: (task = null) => relevantInstructions(task?.scope).map((file) => file.path),
    instructionMetadata: (node, task) => relevantInstructions(node.resources.writes.length ? node.resources.writes : task.scope),
    resolveReadPaths,
    skills: (task) => {
      if (!resolveContext || !task) return currentSkills(root);
      const manifests = ['ai-plan', 'ai-analyze', 'ai-implement', 'ai-review'].flatMap((action) => contextual(action, task.scope).manifest);
      return [...new Map(manifests.map((skill) => [skill.id, skill])).values()].sort((a, b) => a.id.localeCompare(b.id));
    },
    resolveSkills,
    contextHash: (task) => hashObject({
      instructions: instructionInspection()?.fingerprint ?? null,
      skills: resolveContext ? ['ai-plan', 'ai-analyze', 'ai-implement', 'ai-review'].map((action) => contextual(action, task.scope).context.hash) : null,
    }),
    skillContextPaths: (task) => resolveContext
      ? ['ai-plan', 'ai-analyze', 'ai-implement', 'ai-review'].flatMap((action) => contextual(action, task.scope).context.evidence).filter((file) => file.hash).map((file) => file.path)
      : [],
    capture: (task, context = {}) => {
      const control = privateDirectory(root, '.ai-orchestrator');
      const graph = privateDirectory(control, 'graph');
      const sources = privateDirectory(graph, 'sources');
      const sourceRoot = context.worktree ?? root;
      let allowedUntracked = task.includeUntracked;
      if (context.worktree) {
        const result = spawnSync(
          '/usr/bin/git',
          ['-c', 'core.fsmonitor=false', 'ls-files', '--others', '--exclude-standard', '-z'],
          {
            cwd: sourceRoot,
            encoding: 'utf8',
            maxBuffer: 1024 * 1024,
            timeout: 10000,
            env: {
              PATH: '/usr/bin:/bin',
              GIT_CONFIG_NOSYSTEM: '1',
              GIT_CONFIG_GLOBAL: '/dev/null',
              GIT_OPTIONAL_LOCKS: '0',
            },
          },
        );
        if (result.error || result.status !== 0)
          fail('SOURCE_CAPTURE', 'Не удалось перечислить новые source files');
        allowedUntracked = result.stdout.split('\0').filter(Boolean);
        if (
          allowedUntracked.some(
            (file) => !pathAllowed(file, task) && !task.includeUntracked.includes(file),
          )
        )
          fail('SOURCE_SCOPE', 'Новый source содержит untracked вне scope');
      }
      return captureSourceBundle(sourceRoot, sources, { allowedUntracked });
    },
    readiness: (task) => orchestrator.graphExecutionContext({ root, task }),
    allocate: (options) => {
      const context = orchestrator.graphExecutionContext({ root, task: options.task });
      if (!context.available) fail('ORCHESTRATOR_NOT_READY', context.reason);
      return orchestrator.allocateGraphWorkspace({ root, ...options, owner: context.owner });
    },
    verifyBinding: (binding) => orchestrator.verifyGraphWorkspace({ root, binding }),
    withBindingFence: (binding, callbackSync) =>
      orchestrator.withGraphWorkspaceFence({ root, binding, callbackSync }),
    verifySource: (bundle) => verifySourceBundle(bundle).sourceHash,
    replaceBinding: (options) =>
      orchestrator.replaceGraphBinding({ root, ...options, owner: options.binding.owner }),
    prepareToolchain: (worktree) => prepareToolchain({ root, worktree }),
    verifyToolchain: (worktree, manifest) => verifyToolchain({ root, worktree, manifest }),
    fingerprint: (worktree, manifest) =>
      workspace.fingerprintWorkspace(worktree, {
        outputPaths: [...new Set([...profile.outputPaths, ...(manifest?.dependencyPaths ?? [])])],
      }),
    inspectChanges: workspace.inspectWorkspaceChanges,
    captureBefore: captureBeforeContents,
    applyEdits: applyProposedEdits,
    diff: buildAttemptDiff,
    runner: { ...(await runner.probeRunner({ root })), checks: dockerChecks.probeChecks({ root }) },
    execute: (options) =>
      options.node.action.id.startsWith('check-')
        ? dockerChecks.runCheck(options)
        : runner.runRegisteredAction(options),
    inspectProcess: (process) =>
      process.kind === 'docker-check'
        ? dockerChecks.inspectCheckProcess({ root, process })
        : runner.inspectProcess({ root, process }),
    loadSkills: (ids) => ids.map((id) => Reflect.apply(loadSkill, undefined, [root, id, { projectSkills }])),
  };
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
    if (!requestedScope && project.scopeCandidates.length > 32) fail('INTAKE_SCOPE_LIMIT', 'Выберите не более 32 областей задачи');
    const inferredScope = unique([...project.scopeCandidates, ...untracked.filter((file) => file !== '.flowcairn.json').map((file) => file.includes('/') ? file.split('/')[0] : file)]);
    const task = TaskInputSchema.parse({ id: `TASK-${suffix.toUpperCase()}`, goal: product ? body.title : body.prompt.slice(0, 4000),
      ...(product ? { taskNumber: body.taskNumber } : {}),
      instructions: product ? body.description : body.prompt, scope: product ? inferredScope : requestedScope ?? inferredScope,
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
          stage: 'planning', ...(product ? { workflow: 'autonomous' } : {}), naturalIntakeHash: requestHash, actor, contextHash: body.contextHash, snapshot: product ? true : snapshotRequested, includeUntracked: untracked });
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

  #reviewHistory(state) {
    return this.#previousExecutions(state).map((source) => ({ task: source.task, plan: source.plan,
      evidence: buildReviewEvidence({ state: source.state, task: source.task, plan: source.plan,
        node: source.plan.nodes.find((node) => node.action.id === 'ai-review'), fingerprint: source.state.workspaceFingerprint,
        readReceipt: (hash) => ReceiptSchema.parse(this.store.readObject('receipts', hash)), readArtifact: (hash) => this.#artifact(hash),
      }).evidence }));
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

  #hasReadConsent() {
    return this.adapters.hasReadConsent ? this.adapters.hasReadConsent() === true :
      typeof Reflect.get(ProjectPolicy, 'hasOnboardingConsent') === 'function' && Reflect.get(ProjectPolicy, 'hasOnboardingConsent')(this.root, this.adapters.project);
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
      if (plan.stage === 'planning' && state.status === 'passed') {
        const next = await this.command(runId, 'replan', request, { actor: state.actor });
        runId = next.runId;
        continue;
      }
      if (plan.stage === 'execution' && state.status === 'failed') {
        const failed = plan.nodes.filter((node) => state.nodes[node.id].status === 'failed');
        const repairable = failed.length === 1 && (failed[0].action.id.startsWith('check-') || failed[0].action.id === 'ai-review');
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
        if (!repairable || (!semanticReview && !knownCheck) || receipt?.phase !== 'finished' || !receipt.termination?.stopped || receipt.termination.uncertain) return;
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
      retainedArtifacts = [],
      policyGrant = undefined,
      planningTransitions = 0,
      naturalIntakeHash = undefined,
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
      retainedArtifacts,
      policyGrant: policyGrant ?? null,
      planningTransitions,
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
    };
    if (workflow === 'autonomous' && stage === 'planning' && !this.#hasReadConsent())
      fail('ONBOARDING_REQUIRED', 'Нет локального согласия на чтение выбранным AI');
    const compiled = (stage === 'planning' ? compilePlanningPlan : compilePlan)(task, context).plan;
    const staged = { ...compiled, ...(stage ? { stage } : {}), ...(workflow === 'autonomous' ? { workflow, autonomy: { maxRepairCycles: 2, maxDurationMs: 1800000 } } : {}) };
    const proposal = draft ? { ...staged, nodes: draft.nodes, skills: context.skills.filter((skill) => draft.nodes.some((node) => node.skills.includes(skill.id))) } : staged;
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
    return this.snapshot(runId);
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
        ? { runtimeHash: this.adapters.identity(), skills: this.adapters.skills(task), resolveSkills: this.adapters.resolveSkills, resolveReadPaths: this.adapters.resolveReadPaths, contextHash: this.adapters.contextHash?.(task) }
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
        ['passed', 'failed', 'uncertain'].includes(node.status) &&
        (hashObject(lastFinished.checks) !== hashObject(node.checks) ||
          hashObject(lastFinished.changedFiles) !== hashObject(node.changedFiles))
      )
        fail('STATE_RECEIPT_INTEGRITY', 'State checks/changedFiles не соответствуют receipt');
      for (const hash of node.artifacts) this.#artifact(hash);
    }
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
      if (!ready && !['failed', 'uncertain', 'stale'].includes(state.status))
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
    let loaded,
      driftReason = null;
    try {
      loaded = this.#read(runId);
    } catch (error) {
      if (['RUN_NOT_FOUND', 'STORE_NOT_FOUND', 'INVALID_RUN_ID'].includes(error.code)) throw error;
      if (
        [
          'RUNTIME_DRIFT',
          'SKILL_DRIFT',
          'POLICY_DRIFT',
          'STALE_GRAPH_BINDING',
          'STALE_GRAPH_OWNER',
          'STALE_GRAPH_WORKTREE',
        ].includes(error.code)
      ) {
        try {
          loaded = this.#read(runId, { current: false });
          driftReason = safeReason(error);
        } catch {
          /* Corruption still fails closed below. */
        }
      }
      if (!loaded)
        return {
          schemaVersion: 2,
          runId,
          status: 'stale',
          integrity: { valid: false, reason: safeReason(error) },
          nodes: [],
          edges: [],
          gates: [],
          capabilities: Object.fromEntries(
            [
              'run',
              'retry',
              'approve',
              'reject',
              'recover',
              'stop',
              'requestReplan',
              'openReceipt',
              'rerunCheck',
            ].map((name) => [name, { allowed: false, reason: 'Integrity не подтверждена' }]),
          ),
        };
    }
    const { state, task, plan } = loaded,
      capabilities = this.#caps(state, plan);
    if (driftReason)
      for (const collection of [capabilities.run, ...Object.values(capabilities.nodes)])
        for (const name of Object.keys(collection))
          if (
            !(
              driftReason.startsWith('STALE_GRAPH_')
                ? ['openReceipt']
                : ['requestReplan', 'recover', 'stop', 'openReceipt']
            ).includes(name)
          )
            collection[name] = { allowed: false, reason: driftReason };
    const nodes = plan.nodes.map((definition) => {
      const node = state.nodes[definition.id],
        action = { kind: definition.success.kind };
      const blockedDependency = definition.needs.find((id) => state.nodes[id].status !== 'passed');
      const reason = node.status === 'pending' && blockedDependency
        ? `Ожидается ${blockedDependency}: ${state.nodes[blockedDependency].status}`
        : node.reason;
      return {
        id: definition.id,
        title: sanitizeText(definition.title),
        outcome: sanitizeText(definition.outcome),
        needs: definition.needs,
        action: { id: definition.action.id, kind: action.kind },
        status: node.status,
        mode: definition.permissions.some((p) => p.includes('write')) ? 'write' : 'read',
        permissions: definition.permissions,
        resources: definition.resources,
        skills: plan.skills.filter((s) => definition.skills.includes(s.id)),
        attempt: node.attempts,
        startedAt: node.startedAt,
        finishedAt: node.finishedAt,
        durationMs: node.durationMs,
        reason: reason ? sanitizeText(reason) : null,
        receiptIds: node.receipts,
        artifacts: node.artifacts.map((hash) => this.#artifactMetadata(hash)),
        changedFiles: node.changedFiles,
        checks: node.checks,
        capabilities: capabilities.nodes[definition.id],
      };
    });
    const expiresAt = Date.now() + 300000;
    const gates = nodes
      .filter((node) => node.status === 'waiting-for-human' && !driftReason && !(plan.stage === 'planning' && node.action.id === 'human-accept'))
      .map((node) => ({
        nodeId: node.id,
        type: node.action.id === 'human-approve' ? 'approve-plan' : 'accept-result',
        title: node.title,
        scope: plan.workflow === 'autonomous' ? unique(plan.nodes.flatMap(item => item.resources.writes)).sort() : task.scope,
        readPaths: unique(
          plan.nodes
            .filter((n) => ['analysis', 'implementation', 'review'].includes(n.success.kind))
            .flatMap((n) => n.resources.reads),
        ).sort(),
        planHash: state.planHash,
        requiredPermissions: unique(plan.nodes.flatMap((n) => n.permissions)),
        risks: [
          `AI provider: ${this.adapters.project?.ai.provider ?? 'codex'}; model: ${this.adapters.project?.ai.model ?? 'configured'}. Вызов может расходовать платный лимит.`,
          plan.workflow === 'autonomous'
            ? 'После согласования начнутся изменения, проверки и ревью. Разрешение чтения задано в настройках проекта.'
            : 'Задание, исходники в readPaths и назначенные инструкции/Skills будут переданы выбранному AI после отдельного Run.',
          'AI может ошибаться. Приемка опирается на diff, checks и review.',
          'Разрешенная запись изменяет только изолированный workspace.',
        ],
        evidence: unique(nodes.flatMap((n) => n.artifacts.map((a) => a.id))),
        consequences: {
          approve:
            node.action.id === 'human-approve'
              ? plan.workflow === 'autonomous'
                ? `Выполнить план автоматически в указанных границах, включая до ${plan.autonomy.maxRepairCycles} циклов исправлений. Общий срок — ${Math.floor(plan.autonomy.maxDurationMs / 60000)} минут. Commit и PR остаются за вами.`
                : 'Разрешить исполнение этого immutable плана с указанными правами.'
              : 'Принять локальный результат и handoff. Интеграция в Git остается отдельным действием.',
          reject: 'Закрыть этот run без запуска следующих действий.',
        },
        challenge: this.#challenge(state, node.id, expiresAt),
        expiresAt,
      }));
    return {
      schemaVersion: 2,
      runId,
      task: {
        id: task.id,
        goal: sanitizeText(task.goal),
        title: sanitizeText(task.goal),
        description: sanitizeText(task.instructions),
        taskNumber: sanitizeText(task.taskNumber ?? task.id),
        planningFeedback: (task.planningFeedback ?? []).map(sanitizeText),
        scope: task.scope,
        acceptance: task.acceptance.map(sanitizeText),
      },
      workflow: plan.workflow ?? null,
      workflowProgress: this.#workflowProgress(state, plan),
      completion: plan.workflow === 'autonomous' && plan.stage === 'execution' && state.status === 'passed' && !driftReason ? 'ready-for-review' : null,
      successorRunId: Object.values(state.operations).find((operation) => operation.resultRunId && operation.status === 'finished')?.resultRunId ?? null,
      failureReason: state.failureReason ? sanitizeText(state.failureReason) : null,
      phase: plan.stage ?? 'execution',
      planVersion: state.planVersion,
      planHash: state.planHash,
      revision: state.revision,
      status: driftReason ? 'stale' : state.status,
      finalDisposition: state.finalDisposition,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      nodes,
      edges: plan.nodes.flatMap((n) =>
        n.needs.map((dep) => ({ id: `${dep}--${n.id}`, source: dep, target: n.id })),
      ),
      activeNodeId: nodes.find((n) => n.status === 'running')?.id ?? null,
      gates,
      capabilities: capabilities.run,
      integrity: { valid: !driftReason, reason: driftReason },
      runner: {
        ai: {
          available: this.adapters.runner.ai.available,
          reason: sanitizeText(this.adapters.runner.ai.reason ?? ''),
        },
        checks: {
          available: this.adapters.runner.checks.available,
          reason: sanitizeText(this.adapters.runner.checks.reason ?? ''),
        },
      },
      planningArtifacts: state.planningArtifacts.map((hash) => this.#artifactMetadata(hash)),
      supersedesRunId: state.supersedesRunId,
    };
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
          validatePlan(loaded.plan, loaded.task, { ...context, skills: this.adapters.skills(loaded.task), contextHash: this.adapters.contextHash?.(loaded.task) });
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
    if (!['run', 'retry', 'rerun-check', 'gate', 'recover', 'stop', 'replan', 'revise-plan'].includes(name))
      fail('UNKNOWN_CONTROL', 'Control action не разрешен');
    let { state, task, plan } = this.#read(runId, {
      current: !['replan', 'recover', 'stop'].includes(name),
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
      this.#verifyChallenge(state, definition.id, request.challenge);
      if (request.decision !== 'reject' && definition.action.id === 'human-accept')
        await this.#assertWorkspace(state);
      const required = unique(plan.nodes.flatMap((n) => n.permissions));
      if (
        request.decision === 'approve' &&
        hashObject([...(request.permissions ?? [])].sort()) !== hashObject(required.sort())
      )
        fail('PERMISSION_GRANT', 'Необходимо явно подтвердить точный набор прав плана');
      const rejected = request.decision === 'reject';
      const receipt = this.#receipt(state, task, plan, definition, {
        phase: 'gate',
        grantedPermissions: request.decision === 'approve' ? required : state.permissions,
        verdict: rejected ? 'fail' : 'pass',
        actor,
        operationId: request.operationId,
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
          permissions: request.decision === 'approve' ? required : state.permissions,
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
        state = this.#write(state, {
          binding,
          toolchain,
          workspaceFingerprint: fingerprint,
          initialFingerprint: fingerprint,
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
        if (['failed', 'uncertain', 'stale'].includes(state.status) || definition) break;
      }
      state = this.store.readRun(runId);
      if (state.activeOperation?.id === operation.id)
        this.#write(state, {
          activeOperation: null,
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

  #applyFencedEdits(executionState, task, plan, definition, before, edits) {
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
        });
        if (hashObject(current.binding) !== hashObject(executionState.binding))
          fail('EXECUTION_FENCED', 'Binding операции был заменен');
        if (this.adapters.verifyToolchain)
          this.adapters.verifyToolchain(current.binding.worktree, current.toolchain);
        const unchanged = this.adapters.fingerprint(current.binding.worktree, current.toolchain);
        if (current.workspaceFingerprint?.hash !== before.hash || unchanged.hash !== before.hash)
          fail('WORKSPACE_DRIFT', 'Workspace изменился до применения patch');
        this.adapters.applyEdits(current.binding.worktree, before, definition, task, edits);
        return this.adapters.fingerprint(current.binding.worktree, current.toolchain);
      }),
    );
  }

  async #execute(state, task, plan, definition, signal) {
    const action = resolveAction(
      definition.action.id,
      definition.action.version,
      definition.action.inputs,
    );
    if (
      !definition.needs.every((id) => state.nodes[id].status === 'passed') ||
      !definition.permissions.every((p) => state.permissions.includes(p))
    )
      fail('EXECUTION_DENIED', 'Dependencies или permissions не выполнены');
    const before = await this.#assertWorkspace(state),
      attempt = state.nodes[definition.id].attempts + 1,
      attemptId = `attempt-${randomUUID()}`,
      startedAt = now();
    const beforeContents = this.adapters.captureBefore?.(
      state.binding.worktree,
      before,
      definition,
    );
    if (attempt > definition.retry.maxAttempts) fail('ATTEMPT_LIMIT', 'Лимит попыток исчерпан');
    const startReceipt = this.#receipt(state, task, plan, definition, {
      phase: 'started',
      attempt,
      attemptId,
      startedAt,
      finishedAt: null,
      durationMs: null,
      verdict: 'started',
      afterFingerprint: null,
    });
    const nodes = structuredClone(state.nodes);
    Object.assign(nodes[definition.id], {
      status: 'running',
      attempts: attempt,
      receipts: [...nodes[definition.id].receipts, startReceipt],
      startedAt,
      finishedAt: null,
      reason: null,
      retrySafe: false,
    });
    state = this.#write(state, {
      nodes,
      status: 'running',
      activeOperation: { ...state.activeOperation, nodeId: definition.id, process: null },
    });
    const artifacts = [],
      checks = [];
    let changedFiles = [],
      result,
      aiOutput,
      reviewBundle,
      executionInvoked = false,
      fencedAfter,
      after = null,
      verdict,
      reason = null;
    const started = performance.now();
    try {
      if (definition.action.id === 'workspace-check') {
        const assessment = this.adapters.inspectChanges(
          state.initialFingerprint,
          before,
          {
            ...definition,
            permissions: ['workspace.source.write'],
            resources: { ...definition.resources, writes: task.scope },
          },
          task,
        );
        result = { exitCode: assessment.allowed ? 0 : 1, stopped: true, uncertain: false };
        artifacts.push(this.#putArtifact('test-report', 'Проверка границ workspace', assessment));
        if (!assessment.allowed) reason = 'Изменения выходят за утвержденный scope';
      } else if (definition.action.id === 'artifact-handoff') {
        const evidence = plan.nodes
          .filter((n) => n.id !== definition.id)
          .flatMap((n) => state.nodes[n.id].receipts);
        artifacts.push(
          this.#putArtifact('handoff', 'Результат для приемки', {
            goal: task.goal,
            acceptance: task.acceptance,
            planHash: state.planHash,
            receipts: evidence,
            previousExecutions: this.#previousExecutions(state).map((source) => ({ runId: source.state.runId, planHash: source.state.planHash, receipts: Object.values(source.state.nodes).flatMap((node) => node.receipts) })),
            changedFiles: unique([state, ...this.#previousExecutions(state).map((source) => source.state)].flatMap((item) => Object.values(item.nodes).flatMap((n) => n.changedFiles))),
            integration: plan.workflow === 'autonomous' ? 'Готово к личному ревью. Commit и PR пользователь выполняет самостоятельно.' :
              'Требуется отдельная проверка и интеграция Orchestrator; commit/push/deploy не выполнялись',
          }),
        );
        result = { exitCode: 0, stopped: true, uncertain: false };
      } else {
        const outputDirectory = privateDirectory(
          path.join(this.root, '.ai-orchestrator', 'graph'),
          `output-${attemptId}`,
        );
        if (definition.action.id.startsWith('ai-'))
          privateDirectory(path.join(this.root, '.ai-orchestrator', 'graph'), 'runner-tickets');
        const permittedFiles = before.files.filter((file) => pathAllowed(file.path, task));
        const fixFindings = state.planningArtifacts.flatMap((id) => {
          const artifact = this.#artifact(id);
          if (artifact.mediaType !== 'application/json') return [];
          const data = JSON.parse(artifact.content);
          return data.reviewFindings ?? [];
        });
        if (Buffer.byteLength(JSON.stringify(fixFindings)) > 24 * 1024)
          fail('FIX_EVIDENCE_LIMIT', 'Полные review findings превышают bounded context; требуется более узкая задача');
        const analysisArtifact = plan.analysisArtifact ?? [...state.planningArtifacts, ...Object.values(state.nodes).flatMap((node) => node.artifacts)].find((id) => {
          const item = this.#artifact(id);
          return item.kind === 'analysis' && item.mediaType === 'application/json' && Boolean(JSON.parse(item.content).analysis);
        });
        const priorEvidence = {
          ...(analysisArtifact ? { analysis: { artifactId: analysisArtifact, result: AIAnalysisResultSchema.parse(JSON.parse(this.#artifact(analysisArtifact).content)) } } : {}),
          feedback: task.planningFeedback ?? [],
          reviewFindings: fixFindings,
          instructionMetadata: this.adapters.instructionMetadata?.(definition, task) ?? [],
          receipts: unique(Object.values(state.nodes).flatMap((n) => n.receipts)).slice(-64),
          workspaceFiles: permittedFiles.slice(0, 100),
          workspaceFilesTruncated: permittedFiles.length > 100,
          artifacts: unique([
            ...state.planningArtifacts,
            ...Object.values(state.nodes).flatMap((n) => n.artifacts),
          ])
            .map((hash) => {
              const artifact = this.#artifact(hash);
              return {
                id: hash,
                kind: artifact.kind,
                title: artifact.title,
                excerpt: artifact.content.slice(0, 1500),
                truncated: artifact.content.length > 1500,
              };
            })
            .slice(-12),
        };
        while (Buffer.byteLength(JSON.stringify(priorEvidence)) > 30 * 1024) {
          if (priorEvidence.artifacts.length) priorEvidence.artifacts.shift();
          else if (priorEvidence.workspaceFiles.length) {
            priorEvidence.workspaceFiles.pop();
            priorEvidence.workspaceFilesTruncated = true;
          } else fail('CONTEXT_LIMIT', 'Структурированный анализ превышает допустимый размер');
        }
        if (plan.workflow === 'autonomous' && definition.action.id === 'ai-plan' && !priorEvidence.analysis)
          fail('ANALYSIS_REQUIRED', 'План требует сохраненного результата анализа');
        if (definition.action.id === 'ai-review') {
          reviewBundle = buildReviewEvidence({
            state,
            task,
            plan,
            node: definition,
            fingerprint: before,
            previousExecutions: this.#reviewHistory(state),
            readReceipt: (hash) => ReceiptSchema.parse(this.store.readObject('receipts', hash)),
            readArtifact: (hash) => this.#artifact(hash),
          });
        }
        executionInvoked = true;
        result = await this.adapters.execute({
          root: this.root,
          worktree: state.binding.worktree,
          toolchain: state.toolchain,
          beforeFingerprint: before,
          node: definition,
          task,
          plan,
          skills: this.adapters.loadSkills(definition.skills),
          outputDirectory,
          signal,
          priorEvidence,
          reviewEvidence: reviewBundle?.evidence ?? null,
          onStart: async (metadata) => {
            const current = this.store.readRun(state.runId);
            this.adapters.verifyBinding(current.binding);
            if (current.activeOperation?.id !== state.activeOperation.id || current.stopRequested)
              fail('EXECUTION_FENCED', 'Операция больше не владеет run');
            const nodes = structuredClone(current.nodes);
            nodes[definition.id].process = metadata;
            this.#write(current, {
              nodes,
              activeOperation: { ...current.activeOperation, process: metadata },
            });
          },
        });
      }
      if (
        definition.action.id.startsWith('ai-') &&
        result.exitCode === 0 &&
        result.stopped &&
        !result.uncertain
      ) {
        assertJsonBounds(result.output);
        aiOutput = (definition.action.id === 'ai-plan' ? AIPlanningResultSchema : definition.action.id === 'ai-analyze' && plan.workflow === 'autonomous' ? AIAnalysisResultSchema : reviewBundle ? AIReviewResultSchema : AIResultSchema).parse(result.output);
        if (definition.action.id === 'ai-plan' && aiOutput.verdict === 'pass')
          compileTaskProposal(task, aiOutput, { runtimeHash: this.adapters.identity(), skills: this.adapters.skills(task), resolveSkills: this.adapters.resolveSkills, resolveReadPaths: this.adapters.resolveReadPaths, contextHash: this.adapters.contextHash?.(task) });
        if (reviewBundle) {
          const verified = buildReviewEvidence({
            state,
            task,
            plan,
            node: definition,
            fingerprint: before,
            previousExecutions: this.#reviewHistory(state),
            readReceipt: (hash) => ReceiptSchema.parse(this.store.readObject('receipts', hash)),
            readArtifact: (hash) => this.#artifact(hash),
          });
          if (verified.hash !== reviewBundle.hash || aiOutput.reviewEvidenceHash !== verified.hash)
            fail('REVIEW_EVIDENCE_MISMATCH', 'Review result не связан с полным evidence');
        }
        if (definition.action.id === 'ai-analyze' && plan.workflow === 'autonomous') {
          if (Buffer.byteLength(JSON.stringify(aiOutput)) > 20 * 1024) fail('ANALYSIS_LIMIT', 'Анализ превышает ограниченный контекст передачи');
          if (AIAnalysisResultSchema.parse(aiOutput).analysis.projectFacts.some((fact) => !definition.resources.reads.some((scope) => fact.path === scope.replace(/\/$/, '') || fact.path.startsWith(scope.replace(/\/$/, '') + '/'))))
            fail('ANALYSIS_SCOPE', 'Факты анализа выходят за объявленный контекст');
        }
        verifySkillsUsed(this.adapters.loadSkills(definition.skills), aiOutput.skillsUsed);
        if (
          aiOutput.changedFiles.some((file) => !pathAllowed(file, task)) ||
          aiOutput.plan.some((step) => step.paths.some((file) => !pathAllowed(file, task)))
        )
          fail('AI_SCOPE', 'AI-result предлагает расширение scope');
        const unchanged = this.adapters.fingerprint(state.binding.worktree, state.toolchain);
        if (unchanged.hash !== before.hash)
          fail('AI_WRITE_VIOLATION', 'AI subprocess изменил source в read-only режиме');
        if (action.kind === 'implementation') {
          if (
            hashObject(aiOutput.edits.map((edit) => edit.path).sort()) !==
            hashObject([...aiOutput.changedFiles].sort())
          )
            fail('PATCH_FILES_MISMATCH', 'edits и changedFiles не совпадают');
          if (
            aiOutput.verdict === 'pass' &&
            !aiOutput.findings.some((f) => f.severity === 'blocking')
          ) {
            if (!this.adapters.applyEdits)
              fail('PATCH_HANDLER_MISSING', 'Trusted patch handler недоступен');
            fencedAfter = this.#applyFencedEdits(
              state,
              task,
              plan,
              definition,
              before,
              aiOutput.edits,
            );
          }
        } else if (aiOutput.edits.length || aiOutput.changedFiles.length)
          fail('AI_WRITE_VIOLATION', 'Read action не может предлагать запись');
      }
      after = fencedAfter ?? this.adapters.fingerprint(state.binding.worktree, state.toolchain);
      const assessment = this.adapters.inspectChanges(before, after, definition, task);
      changedFiles = assessment.changedFiles;
      this.#read(state.runId);
      if (!result.stopped || result.uncertain || !assessment.allowed) {
        verdict = 'uncertain';
        reason =
          reason ??
          (!assessment.allowed
            ? 'Нарушена граница изменений'
            : result.failureReason === 'TIMEOUT'
              ? 'Истек лимит времени выполнения этапа; требуется восстановление'
              : 'Остановка процесса или результат не подтверждены');
      } else if (result.exitCode !== 0) {
        verdict = 'fail';
        reason = reason ?? sanitizeText(result.failureReason ?? 'Действие завершилось с ошибкой');
      } else if (definition.action.id.startsWith('ai-')) {
        assertJsonBounds(result.output);
        const output = aiOutput ?? AIResultSchema.parse(result.output);
        verifySkillsUsed(this.adapters.loadSkills(definition.skills), output.skillsUsed);
        const safe = {
          ...output,
          summary: sanitizeText(output.summary),
          findings: output.findings.map((f) => ({ ...f, message: sanitizeText(f.message) })),
          plan: output.plan.map((p) => ({ ...p, outcome: sanitizeText(p.outcome) })),
          ...(definition.action.id === 'ai-analyze' && plan.workflow === 'autonomous' ? { analysis: Object.fromEntries(Object.entries(AIAnalysisResultSchema.parse(output).analysis).map(([key, values]) => [key, key === 'projectFacts' ? values.map((value) => ({ path: value.path, fact: sanitizeText(value.fact) })) : values.map(sanitizeText)])) } : {}),
          ...(definition.action.id === 'ai-plan' ? { steps: AIPlanningResultSchema.parse(output).steps.map((step) => ({ ...step, title: sanitizeText(step.title), outcome: sanitizeText(step.outcome) })) } : {}),
        };
        verdict =
          output.verdict === 'pass' && !output.findings.some((f) => f.severity === 'blocking')
            ? 'pass'
            : output.verdict === 'uncertain'
              ? 'uncertain'
              : 'fail';
        if (verdict !== 'pass') {
          reason = sanitizeText(output.findings.find((finding) => finding.severity === 'blocking')?.message || output.summary || 'AI не подтвердил результат');
          if (action.kind === 'implementation')
            artifacts.push(this.#putArtifact('review-findings', 'Почему реализация остановлена', {
              summary: safe.summary, verdict, findings: safe.findings,
            }));
        }
        if (action.kind === 'analysis')
          artifacts.push(this.#putArtifact('analysis', 'Анализ задачи', safe));
        if (action.kind === 'review')
          artifacts.push(this.#putArtifact('review-findings', 'Независимое review', safe));
        if (action.kind === 'implementation') {
          if (
            verdict === 'pass' &&
            hashObject([...output.changedFiles].sort()) !== hashObject([...changedFiles].sort())
          ) {
            verdict = 'uncertain';
            reason = 'Заявленные AI changedFiles не совпадают с fingerprint';
          }
          const diff = this.adapters.diff(state.binding.worktree, before, after, beforeContents);
          artifacts.push(
            this.#putArtifact('diff', 'Изменения workspace', diff.content, 'text/x-diff'),
            this.#putArtifact('changed-files', 'Измененные файлы', {
              changedFiles,
              before: before.hash,
              after: after.hash,
              complete: diff.complete,
            }),
          );
          if (!diff.complete) {
            verdict = 'uncertain';
            reason = 'Diff evidence неполное';
          }
        }
      } else {
        verdict = 'pass';
        if (definition.action.id.startsWith('check-')) {
          const check = {
            id: definition.id,
            passed: true,
            exitCode: 0,
            durationMs: performance.now() - started,
            summary: 'Зарегистрированная проверка завершилась успешно',
            inputHash: before.hash,
          };
          checks.push(check);
          artifacts.push(this.#putArtifact(action.artifacts[0], definition.title, check));
        }
      }
      if (definition.action.id.startsWith('check-') && result.exitCode !== 0) {
        const check = {
          id: definition.id,
          passed: false,
          exitCode: result.exitCode,
          durationMs: performance.now() - started,
          summary: reason ?? 'Проверка не пройдена',
          inputHash: before.hash,
        };
        checks.push(check);
        artifacts.push(this.#putArtifact(action.artifacts[0], definition.title, check));
      }
      if (
        verdict === 'pass' &&
        !action.artifacts.every((kind) =>
          artifacts.some((hash) => this.#artifact(hash).kind === kind),
        )
      ) {
        verdict = 'fail';
        reason = 'Не выполнен artifact success contract';
      }
    } catch (error) {
      reason = safeReason(error);
      verdict = 'uncertain';
      // A rejected read-only proposal is a known failure only when no workspace effect occurred.
      const rejectedReviewPreflight =
        definition.action.id === 'ai-review' &&
        !executionInvoked &&
        error instanceof GraphError &&
        error.code.startsWith('REVIEW_EVIDENCE_');
      if (rejectedReviewPreflight || (result?.stopped === true && result?.uncertain !== true)) {
        try {
          after = this.adapters.fingerprint(state.binding.worktree, state.toolchain);
          changedFiles = this.adapters.inspectChanges(before, after, definition, task).changedFiles;
          if (after.hash === before.hash) verdict = 'fail';
        } catch {
          // Missing or unreliable workspace evidence remains uncertain.
        }
      }
    }
    const current = this.store.readRun(state.runId),
      finishedAt = now(),
      durationMs = performance.now() - started;
    this.#assertExecutionOwner(current, state, definition, { allowStop: true });
    const receipt = this.#receipt(current, task, plan, definition, {
      attempt,
      attemptId,
      startedAt,
      finishedAt,
      durationMs,
      verdict,
      exitCode: result?.exitCode ?? null,
      checks,
      artifacts,
      changedFiles,
      failureReason: reason,
      beforeFingerprint: before.hash,
      afterFingerprint: after?.hash ?? null,
      ...(reviewBundle ? { reviewEvidenceHash: reviewBundle.hash } : {}),
      termination: result
        ? {
            stopped: result.stopped === true,
            uncertain: result.uncertain === true,
            timedOut: result.timedOut === true,
            outputLimit: result.outputLimit === true,
            signal: result.signal ?? null,
            ticketHash: result.process
              ? hashObject(result.process)
              : current.nodes[definition.id].process
                ? hashObject(current.nodes[definition.id].process)
                : null,
            execution: result.execution ?? null,
          }
        : null,
    });
    const finalNodes = structuredClone(current.nodes);
    Object.assign(finalNodes[definition.id], {
      status: verdict === 'pass' ? 'passed' : verdict === 'fail' ? 'failed' : 'uncertain',
      receipts: [...finalNodes[definition.id].receipts, receipt],
      artifacts: [...finalNodes[definition.id].artifacts, ...artifacts],
      checks,
      changedFiles,
      finishedAt,
      durationMs,
      reason,
      retrySafe:
        verdict === 'fail' &&
        action.retrySafe &&
        result?.stopped === true &&
        after?.hash === before.hash,
    });
    const next = reconcile(
      {
        ...current,
        nodes: finalNodes,
        workspaceFingerprint: after ?? current.workspaceFingerprint,
        status: verdict === 'uncertain' ? 'uncertain' : 'running',
      },
      plan,
    );
    return this.#write(current, next);
  }

  #recordedProcessStop(state, processInfo) {
    if (!processInfo) return null;
    const metadataHash = hashObject(processInfo);
    for (const node of Object.values(state.nodes)) {
      for (const id of node.receipts) {
        const receipt = this.store.readObject('receipts', id);
        const proof = receipt.termination;
        if (
          !['finished', 'recovery'].includes(receipt.phase) ||
          proof?.stopped !== true ||
          proof.ticketHash !== metadataHash
        )
          continue;
        if (processInfo.kind === 'docker-check') {
          if (
            proof.execution?.kind !== 'docker-check' ||
            proof.execution.removed !== true ||
            proof.execution.containerId !== processInfo.containerId ||
            proof.execution.imageId !== processInfo.imageId
          )
            continue;
          return { ...proof, uncertain: false };
        }
        if (proof.uncertain) continue;
        return proof;
      }
    }
    return null;
  }

  #durableDockerStop(processInfo, execution) {
    const metadataHash = hashObject(processInfo);
    return Boolean(
      execution?.kind === 'docker-check' &&
      execution.actionId === processInfo.actionId &&
      execution.containerId === processInfo.containerId &&
      execution.imageId === processInfo.imageId &&
      execution.removed === false &&
      /^[a-f0-9]{64}$/.test(execution.stopProofHash ?? '') &&
      execution.stopProofPath === `.ai-orchestrator/graph/check-stop-proofs/${metadataHash}.json`,
    );
  }

  #terminationProof(processInfo, proof) {
    if (
      proof?.stopped !== true ||
      proof.uncertain === true ||
      (processInfo.kind === 'docker-check' &&
        proof.execution?.removed !== true &&
        !this.#durableDockerStop(processInfo, proof.execution))
    )
      fail('PROCESS_UNCERTAIN', 'Сначала необходимо доказать остановку runner');
    return {
      stopped: true,
      uncertain: false,
      timedOut: proof.timedOut === true,
      outputLimit: proof.outputLimit === true,
      signal: typeof proof.signal === 'string' ? proof.signal : null,
      ticketHash: hashObject(processInfo),
      execution: proof.execution ?? null,
    };
  }

  async #recover({ state, task, plan, request, digest, actor, caps }) {
    if (!caps.run.recover.allowed)
      fail('RECOVERY_DENIED', 'Нет подтвержденного orphan или uncertain состояния');
    const deadLock = this.store.inspectLock(state.runId);
    if (deadLock) {
      if (deadLock.status !== 'dead') fail('RUN_LOCKED', 'GraphStore lock еще принадлежит writer');
      const expectedRevision = state.revision;
      this.store.recoverLock(state.runId);
      const unlocked = this.store.readRun(state.runId);
      if (
        unlocked.revision !== expectedRevision ||
        unlocked.planHash !== state.planHash ||
        unlocked.taskHash !== state.taskHash ||
        unlocked.sourceHash !== state.sourceHash
      )
        fail('RECOVERY_SUPERSEDED', 'Run изменился во время восстановления lock');
      state = unlocked;
    }
    const displacedOperation = state.activeOperation;
    const recoveryOperation = {
      id: request.operationId,
      digest,
      ownerPid: process.pid,
      ownerStart: this.ownerStart,
      nodeId: displacedOperation?.nodeId ?? null,
      process: displacedOperation?.process ?? null,
      startedAt: now(),
    };
    const reservedOperations = {
      ...state.operations,
      [request.operationId]: { digest, status: 'running' },
    };
    if (
      displacedOperation &&
      displacedOperation.id !== request.operationId &&
      reservedOperations[displacedOperation.id]?.status === 'running'
    )
      reservedOperations[displacedOperation.id] = {
        ...reservedOperations[displacedOperation.id],
        status: 'failed',
      };
    state = this.#write(state, {
      activeOperation: recoveryOperation,
      operations: reservedOperations,
    });
    try {
      const successor = Object.entries(state.operations).find(
        ([id, op]) =>
          id !== request.operationId &&
          ['creating', 'finished'].includes(op.status) &&
          op.preparationHash &&
          op.resultRunId,
      );
      if (successor) {
        const [operationId, prior] = successor;
        const next =
          prior.status === 'creating'
            ? await this.#finishReplan(state, { operationId }, prior.digest, actor, prior)
            : this.snapshot(prior.resultRunId);
        const current = this.store.readRun(state.runId);
        if (
          current.activeOperation?.id !== request.operationId ||
          current.operations[request.operationId]?.digest !== digest ||
          current.operations[request.operationId]?.status !== 'running'
        )
          fail('RECOVERY_SUPERSEDED', 'Recovery больше не владеет run');
        this.#write(current, {
          activeOperation: null,
          stopRequested: false,
          operations: {
            ...current.operations,
            [request.operationId]: { digest, status: 'finished', resultRunId: next.runId },
          },
        });
        return next;
      }
      const processInfos = [
        recoveryOperation.process,
        ...Object.values(state.nodes)
          .filter((node) => ['running', 'uncertain'].includes(node.status))
          .map((node) => node.process),
      ].filter(Boolean);
      const uniqueProcesses = [
        ...new Map(
          processInfos.map((processInfo) => [hashObject(processInfo), processInfo]),
        ).values(),
      ];
      const stopProofs = new Map();
      for (const processInfo of uniqueProcesses) {
        const recorded = this.#recordedProcessStop(state, processInfo);
        if (recorded) {
          stopProofs.set(hashObject(processInfo), recorded);
          continue;
        }
        const proof = await this.adapters.inspectProcess(processInfo);
        stopProofs.set(hashObject(processInfo), this.#terminationProof(processInfo, proof));
      }
      if (
        displacedOperation &&
        !uniqueProcesses.length &&
        !this.#orphan({ activeOperation: displacedOperation })
      )
        fail('PROCESS_UNCERTAIN', 'Владелец запуска еще активен');
      const fingerprint = state.binding
        ? this.adapters.fingerprint(state.binding.worktree, state.toolchain)
        : null;
      if (this.store.inspectLock(state.runId)) this.store.recoverLock(state.runId);
      const current = this.store.readRun(state.runId);
      if (
        current.activeOperation?.id !== request.operationId ||
        current.operations[request.operationId]?.digest !== digest ||
        current.operations[request.operationId]?.status !== 'running'
      )
        fail('RECOVERY_SUPERSEDED', 'Recovery больше не владеет run');
      const nodes = structuredClone(current.nodes);
      for (const definition of plan.nodes)
        if (['running', 'uncertain'].includes(nodes[definition.id].status)) {
          const processInfo = nodes[definition.id].process;
          const receipt = this.#receipt(current, task, plan, definition, {
            phase: 'recovery',
            actor,
            operationId: request.operationId,
            verdict: 'uncertain',
            termination: processInfo ? (stopProofs.get(hashObject(processInfo)) ?? null) : null,
            failureReason:
              'Процесс остановлен. Старые результаты не восстанавливаются в passed; требуется новый план.',
            afterFingerprint: fingerprint?.hash ?? null,
          });
          Object.assign(nodes[definition.id], {
            status: 'uncertain',
            retrySafe: false,
            receipts: [...nodes[definition.id].receipts, receipt],
            reason: 'Остановка подтверждена; требуется replan',
          });
        }
      const operations = {
        ...current.operations,
        [request.operationId]: { digest, status: 'finished' },
      };
      this.#write(current, {
        nodes,
        status: 'uncertain',
        activeOperation: null,
        stopRequested: false,
        workspaceFingerprint: fingerprint ?? current.workspaceFingerprint,
        operations,
        recovered: true,
      });
      return this.snapshot(state.runId);
    } catch (error) {
      try {
        const current = this.store.readRun(state.runId);
        if (
          current.activeOperation?.id === request.operationId &&
          current.operations[request.operationId]?.digest === digest &&
          current.operations[request.operationId]?.status === 'running'
        ) {
          const operations = {
            ...current.operations,
            [request.operationId]: { digest, status: 'failed' },
          };
          if (displacedOperation && operations[displacedOperation.id])
            operations[displacedOperation.id] = {
              ...operations[displacedOperation.id],
              status: 'running',
            };
          this.#write(current, { activeOperation: displacedOperation, operations });
        }
      } catch {
        // Preserve the first failure; a later recovery will inspect the durable operation owner.
      }
      throw error;
    }
  }

  async #replan({ state, task, plan, request, digest, actor, caps, policyGrant = undefined }) {
    if (
      state.activeOperation ||
      Object.values(state.nodes).some((node) => node.status === 'running') ||
      (state.status === 'uncertain' && !state.recovered)
    )
      fail('RECOVERY_REQUIRED', 'Перед replan требуется доказанное recovery');
    if (!caps.run.requestReplan.allowed)
      fail('REPLAN_DENIED', 'Replan недоступен или бюджет исчерпан');
    if (policyGrant && state.binding) await this.#assertWorkspace(state);
    const context = {
      runtimeHash: this.adapters.identity(),
      skills: this.adapters.skills(task),
      resolveSkills: this.adapters.resolveSkills,
      resolveReadPaths: this.adapters.resolveReadPaths,
      contextHash: this.adapters.contextHash?.(task),
      version: plan.version + 1,
      parentPlanHash: state.planHash,
      workflow: plan.workflow,
    };
    let nextDraft = request.draft ?? null;
    let nextStage = plan.stage;
    let planningTransitions = state.planningTransitions ?? 0;
    let planningEvidence = null;
    if (plan.stage === 'planning') {
      if (request.draft) fail('PLANNING_DRAFT_DENIED', 'Planning компилирует только сохраненный AI proposal');
      const planner = plan.nodes.find((node) => node.action.id === 'ai-plan');
      if (state.nodes[planner.id].status === 'passed') {
        // A stale context cannot promote an old planning receipt into new write policyGrant.
        this.#read(state.runId);
        await this.#assertWorkspace(state);
        const artifactId = state.nodes[planner.id].artifacts.find((id) => this.#artifact(id).kind === 'analysis');
        if (!artifactId) fail('PLANNING_EVIDENCE_MISSING', 'Нет сохраненного planning result');
        const output = AIPlanningResultSchema.parse(JSON.parse(this.#artifact(artifactId).content));
        const executable = compileTaskProposal(task, output, context).plan;
        nextDraft = { nodes: executable.nodes };
        nextStage = 'execution';
        planningTransitions = (state.planningTransitions ?? 0) + 1;
        planningEvidence = { artifactId, receiptIds: state.nodes[planner.id].receipts, steps: output.steps };
      } else if (!['failed', 'uncertain', 'stale'].includes(state.status)) {
        fail('PLANNING_INCOMPLETE', 'Сначала выполните AI-планирование');
      }
    } else if (plan.stage === 'execution' && !request.draft) {
      // A fix keeps semantic task granularity, with new attempts/checks/review and fresh approval.
      const implementations = plan.nodes.filter((node) => node.action.id === 'ai-implement');
      const ids = new Set(implementations.map((node) => node.id));
      const steps = implementations.map((node, index) => ({ id: `fix-${index + 1}`, title: node.title,
        outcome: node.outcome, paths: node.resources.writes,
        needs: node.needs.filter((id) => ids.has(id)).map((id) => `fix-${implementations.findIndex((n) => n.id === id) + 1}`) }));
      const proposal = { summary: 'Исправить по evidence предыдущей версии', verdict: 'pass', skillsUsed: [],
        findings: [], changedFiles: [], edits: [], plan: [], steps };
      nextDraft = { nodes: compileTaskProposal(task, proposal, context).plan.nodes };
    }
    if (nextDraft) {
      assertJsonBounds(nextDraft);
      if (
        typeof nextDraft !== 'object' ||
        Array.isArray(nextDraft) ||
        Object.keys(nextDraft).some((k) => k !== 'nodes')
      )
        fail('INVALID_DRAFT', 'Draft может предлагать только nodes');
      assertConfiguredChecks(task, this.adapters.project, nextDraft);
      validatePlan(
        { ...compilePlan(task, context).plan, ...(plan.workflow === 'autonomous' ? { workflow: 'autonomous', autonomy: plan.autonomy, stage: nextStage } : {}), nodes: nextDraft.nodes, skills: context.skills.filter((skill) => nextDraft.nodes.some((node) => node.skills.includes(skill.id))) },
        task,
        context,
      );
    }
    const { schemaVersion: _, sourceHash: __, ...input } = task;
    let fingerprint = null;
    if (state.binding) {
      this.adapters.verifyBinding(state.binding);
      fingerprint = this.adapters.fingerprint(state.binding.worktree, state.toolchain);
      const scopeNode = {
        permissions: ['workspace.source.write'],
        resources: { writes: policyGrant ? unique(plan.nodes.flatMap((node) => node.resources.writes)) : task.scope },
      };
      if (
        !this.adapters.inspectChanges(state.initialFingerprint, fingerprint, scopeNode, task)
          .allowed
      )
        fail('REPLAN_SCOPE', 'Нельзя включить изменения вне утвержденного scope в новый план');
    }
    const source = await this.adapters.capture(
      input,
      state.binding ? { worktree: state.binding.worktree } : {},
    );
    const newRunId = `run-${randomUUID()}`;
    const preparationHash = this.store.putObject('operations', {
      input,
      actor,
      sourceBundle: source.bundlePath,
      sourceHash: source.manifest.sourceHash,
      version: plan.version + 1,
      parentPlanHash: state.planHash,
      supersedesRunId: state.runId,
      ...(policyGrant ? { policyGrant } : {}),
      stage: nextStage ?? null,
      workflow: plan.workflow ?? null,
      retainedArtifacts: unique([...state.planningArtifacts, ...plan.nodes.filter((node) => node.success.kind === 'analysis').flatMap((node) => state.nodes[node.id].artifacts)]),
      planningTransitions,
      feedback: {
        planningEvidence,
        previousRunId: state.runId,
        previousPlanHash: state.planHash,
        nodes: plan.nodes
          .filter((n) => ['failed', 'uncertain'].includes(state.nodes[n.id].status))
          .map((n) => ({
            id: n.id,
            status: state.nodes[n.id].status,
            reason: state.nodes[n.id].reason,
            checks: state.nodes[n.id].checks,
            receipts: state.nodes[n.id].receipts,
            changedFiles: state.nodes[n.id].changedFiles,
          })),
        reviewFindings: plan.nodes
          .filter((n) => n.success.kind === 'review')
          .flatMap((n) => state.nodes[n.id].artifacts)
          .map((hash) => ({
            artifactId: hash,
            content: this.#artifact(hash).content,
          })),
      },
      draft: nextDraft,
      binding: state.binding,
      fingerprint,
    });
    const prior = { digest, status: 'creating', resultRunId: newRunId, preparationHash };
    state = this.#write(state, {
      status: 'stale',
      finalDisposition: 'superseded',
      operations: { ...state.operations, [request.operationId]: prior },
    });
    return this.#finishReplan(state, request, digest, actor, prior);
  }

  async #finishReplan(state, request, digest, actor, prior) {
    const preparation = this.store.readObject('operations', prior.preparationHash);
    const source = {
      bundlePath: preparation.sourceBundle,
      manifest: { sourceHash: preparation.sourceHash },
    };
    await this.create(preparation.input, {
      runId: prior.resultRunId,
      actor: preparation.actor ?? actor,
      operationId: request.operationId,
      version: preparation.version,
      parentPlanHash: preparation.parentPlanHash,
      supersedesRunId: preparation.supersedesRunId,
      draft: preparation.draft,
      stage: preparation.stage ?? undefined,
      workflow: preparation.workflow ?? undefined,
      analysisArtifact: preparation.analysisArtifact ?? undefined,
      retainedArtifacts: preparation.retainedArtifacts ?? [],
      policyGrant: preparation.policyGrant ?? undefined,
      planningTransitions: preparation.planningTransitions ?? 0,
      sourceOverride: source,
      replanEvidence: preparation.feedback ?? null,
      setupPending: true,
    });
    let next = this.store.readRun(prior.resultRunId);
    if (next.setupPending) {
      const binding = preparation.binding
        ? await this.adapters.replaceBinding({
            binding: preparation.binding,
            runId: state.runId,
            newRunId: next.runId,
            sourceHash: preparation.sourceHash,
            owner: actor,
            previousRunStopped: true,
          })
        : null;
      if (binding) this.adapters.verifyBinding(binding);
      const toolchain = binding
        ? (this.adapters.prepareToolchain?.(binding.worktree) ?? null)
        : null;
      const fingerprint = binding ? this.adapters.fingerprint(binding.worktree, toolchain) : null;
      if (fingerprint && fingerprint.hash !== preparation.fingerprint.hash)
        fail(
          'REPLAN_WORKSPACE_DRIFT',
          'Workspace изменился во время replan; новый run остается заблокирован',
        );
      next = this.#write(next, {
        binding,
        toolchain,
        workspaceFingerprint: fingerprint,
        initialFingerprint: fingerprint,
        setupPending: false,
      });
    }
    const current = this.store.readRun(state.runId);
    this.#write(current, {
      operations: {
        ...current.operations,
        [request.operationId]: { ...prior, digest, status: 'finished' },
      },
    });
    return this.snapshot(next.runId);
  }
}
