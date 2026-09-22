import { randomUUID } from 'node:crypto';
import { GraphError } from './io.mjs';
import { AIAnalysisResultSchema, AIPlanningResultSchema, ReceiptSchema, assertJsonBounds } from './schemas.mjs';
import { compileTaskProposal } from './planning.mjs';
import { compilePlan, validatePlan } from './validator.mjs';
import { buildTaskContract } from './task-contract.mjs';
import { repairExecutionSteps } from './repair-decomposition.mjs';
import { autonomyForNodes } from './autonomy-policy.mjs';

const fail = (code, message) => { throw new GraphError(code, message); };
const unique = (values) => [...new Set(values)];

// Prepare and resume immutable successor runs; the service owns authorization and CAS writes.
export async function replanRun(host, { state, task, plan, request, digest, actor, policyGrant = undefined, discoveryChange = null }) {
  const originalTask = task;
  const contextChange = discoveryChange ?? (request.contextSelection ? host.resolveContextSelection(task, request.contextSelection) : null);
  if (contextChange) task = { ...task, scope: contextChange.scope,
    contextNotes: contextChange.feedback, contextPaths: contextChange.contextPaths ?? originalTask.contextPaths };
  const context = {
    runtimeHash: host.adapters.identity(),
    skills: host.adapters.skills(task),
    resolveSkills: host.adapters.resolveSkills,
    resolveReadPaths: host.adapters.resolveReadPaths,
    contextHash: host.adapters.contextHash?.(task),
    version: plan.version + 1,
    parentPlanHash: state.planHash,
    workflow: plan.workflow,
    provider: host.adapters.project?.ai.provider,
    analysis: contextChange ? null : host.analysis(state, plan),
    ...(plan.stage === 'execution' && plan.taskContract ? { taskContract: plan.taskContract } : {}),
  };
  let nextContract = plan.stage === 'execution' ? plan.taskContract : null;
  let nextDraft = request.draft ?? null;
  let nextStage = plan.stage;
  let planningTransitions = (state.planningTransitions ?? 0) + (discoveryChange ? 1 : 0);
  let planningEvidence = null;
  let analysisArtifact = null;
  if (plan.stage === 'planning') {
    if (request.draft) fail('PLANNING_DRAFT_DENIED', 'Planning компилирует только сохраненный AI proposal');
    const planner = plan.nodes.find((node) => node.action.id === 'ai-plan');
    if (!contextChange && state.nodes[planner.id].status === 'passed') {
      // A stale context cannot promote an old planning receipt into new write policyGrant.
      host.read(state.runId);
      await host.assertWorkspace(state);
      const artifactId = state.nodes[planner.id].artifacts.find((id) => host.artifact(id).kind === 'analysis');
      if (!artifactId) fail('PLANNING_EVIDENCE_MISSING', 'Нет сохраненного planning result');
      const output = AIPlanningResultSchema.parse(JSON.parse(host.artifact(artifactId).content));
      const executable = compileTaskProposal(task, output, context).plan;
      nextContract = executable.taskContract;
      nextDraft = { nodes: executable.nodes };
      nextStage = 'execution';
      planningTransitions = (state.planningTransitions ?? 0) + 1;
      planningEvidence = { artifactId, receiptIds: state.nodes[planner.id].receipts, steps: output.steps };
    } else if (!contextChange && (state.nodes[planner.id].status === 'failed' || (state.nodes[planner.id].status === 'uncertain' && (state.recovered === true || host.semanticUncertainty(state))))) {
      const analyzer = plan.nodes.find((node) => node.action.id === 'ai-analyze');
      if (state.binding) {
        host.adapters.verifyBinding(state.binding);
        const currentHash = host.adapters.fingerprint(state.binding.worktree, state.toolchain).hash;
        const candidate = (id) => {
          const artifact = host.artifact(id);
          return artifact.kind === 'analysis' && artifact.mediaType === 'application/json' &&
            AIAnalysisResultSchema.safeParse(JSON.parse(artifact.content)).success;
        };
        if (analyzer && state.nodes[analyzer.id].status === 'passed') {
          const id = state.nodes[analyzer.id].receipts.at(-1);
          const receipt = id && ReceiptSchema.parse(host.store.readObject('receipts', id));
          if (receipt?.phase === 'finished' && receipt.verdict === 'pass' && receipt.exitCode === 0 &&
              receipt.termination?.stopped === true && receipt.termination.uncertain === false &&
              receipt.beforeFingerprint === currentHash && receipt.afterFingerprint === currentHash)
            analysisArtifact = receipt.artifacts.find(candidate) ?? null;
        } else if (plan.analysisArtifact && currentHash === state.initialFingerprint?.hash &&
                   currentHash === state.workspaceFingerprint?.hash && candidate(plan.analysisArtifact)) {
          analysisArtifact = plan.analysisArtifact;
        }
      }
    } else if (!['ready', 'failed', 'uncertain', 'stale'].includes(state.status)) {
      fail('PLANNING_INCOMPLETE', 'Сначала выполните AI-планирование');
    }
  } else if (plan.stage === 'execution' && !request.draft) {
    // A timed-out broad step is subdivided without changing the approved write scope.
    const repairState = state.workspaceFingerprint
      ? { ...state, workspaceFingerprint: host.resolveFingerprint(state.workspaceFingerprint) }
      : state;
    const { steps, repairReadPaths, isolatedReadStepIds } = repairExecutionSteps(plan, repairState,
      (id) => ReceiptSchema.parse(host.store.readObject('receipts', id)));
    const proposal = { summary: 'Исправить по evidence предыдущей версии', verdict: 'pass', skillsUsed: [],
      findings: [], changedFiles: [], edits: [], plan: [], steps };
    const executable = compileTaskProposal(task, proposal, { ...context, repairReadPaths,
      isolatedReadStepIds }).plan;
    nextDraft = { nodes: executable.nodes };
    nextContract = executable.taskContract;
  }
  if (nextDraft) {
    assertJsonBounds(nextDraft);
    if (
      typeof nextDraft !== 'object' ||
      Array.isArray(nextDraft) ||
      Object.keys(nextDraft).some((k) => k !== 'nodes')
    )
      fail('INVALID_DRAFT', 'Draft может предлагать только nodes');
    host.assertConfiguredChecks(task, host.adapters.project, nextDraft);
    if (nextContract && request.draft) nextContract = buildTaskContract(task, { previousContract: nextContract,
      steps: nextDraft.nodes.filter((node) => node.action.id === 'ai-implement').map((node) => ({ id: node.id, nodeId: node.id, paths: node.resources.writes })) });
    validatePlan(
      { ...compilePlan(task, context).plan, ...(plan.workflow === 'autonomous' ? { workflow: 'autonomous', autonomy: autonomyForNodes(nextDraft.nodes), stage: nextStage } : {}), ...(nextContract ? { taskContract: nextContract } : {}), nodes: nextDraft.nodes, skills: context.skills.filter((skill) => nextDraft.nodes.some((node) => node.skills.includes(skill.id))) },
      task,
      context,
    );
  }
  const { schemaVersion: _, sourceHash: __, ...input } = task;
  if (nextStage === 'planning' && plan.workflow === 'autonomous' && task.intakeKind === 'natural') input.contextDiscovery = true;
  if (request.feedback)
    input.planningFeedback = [...(task.planningFeedback ?? []), request.feedback];
  let fingerprint = null;
  if (state.binding) {
    host.adapters.verifyBinding(state.binding);
    fingerprint = host.adapters.fingerprint(state.binding.worktree, state.toolchain);
    const scopeNode = {
      permissions: ['workspace.source.write'],
      resources: { writes: policyGrant ? unique(plan.nodes.flatMap((node) => node.resources.writes)) : originalTask.scope },
    };
    if (
      !host.adapters.inspectChanges(host.resolveFingerprint(state.initialFingerprint), fingerprint, scopeNode, originalTask)
        .allowed
    )
      fail('REPLAN_SCOPE', 'Нельзя включить изменения вне утвержденного scope в новый план');
  }
  const source = await host.adapters.capture(
    input,
    state.binding ? { worktree: state.binding.worktree } : {},
  );
  if (contextChange?.sourceHash && source.manifest.sourceHash !== contextChange.sourceHash)
    fail('STALE_CONTEXT', 'Файлы изменились после уточнения задачи. Проверьте выбранную область заново.');
  const newRunId = `run-${randomUUID()}`;
  const preparationHash = host.store.putObject('operations', {
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
    ...(nextContract ? { taskContract: nextContract } : {}),
    ...(analysisArtifact ? { analysisArtifact } : {}),
    retainedArtifacts: contextChange ? [] : unique([...state.planningArtifacts, ...plan.nodes.filter((node) => node.success.kind === 'analysis').flatMap((node) => state.nodes[node.id].artifacts)]),
    planningTransitions,
    contextDiscoveryRound: (state.contextDiscoveryRound ?? 0) + (discoveryChange ? 1 : 0),
    feedback: {
      planningEvidence,
      ...(contextChange ? { ...(request.contextSelection ? { contextSelection: request.contextSelection } : {}), contextNotes: contextChange.feedback,
        previousScope: originalTask.scope, scope: task.scope } : {}),
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
          content: host.artifact(hash).content,
        })),
    },
    draft: nextDraft,
    binding: state.binding,
    fingerprint: fingerprint ? host.persistFingerprint(fingerprint) : null,
  });
  const prior = { digest, status: 'creating', resultRunId: newRunId, preparationHash };
  state = host.write(state, {
    status: 'stale',
    finalDisposition: 'superseded',
    operations: { ...state.operations, [request.operationId]: prior },
  });
  return finishReplan(host, state, request, digest, actor, prior);
}

export async function finishReplan(host, state, request, digest, actor, prior) {
  const preparation = host.store.readObject('operations', prior.preparationHash);
  const source = {
    bundlePath: preparation.sourceBundle,
    manifest: { sourceHash: preparation.sourceHash },
  };
  await host.create(preparation.input, {
    runId: prior.resultRunId,
    actor: preparation.actor ?? actor,
    operationId: request.operationId,
    version: preparation.version,
    parentPlanHash: preparation.parentPlanHash,
    supersedesRunId: preparation.supersedesRunId,
    draft: preparation.draft,
    stage: preparation.stage ?? undefined,
    workflow: preparation.workflow ?? undefined,
    taskContract: preparation.taskContract ?? undefined,
    analysisArtifact: preparation.analysisArtifact ?? undefined,
    retainedArtifacts: preparation.retainedArtifacts ?? [],
    policyGrant: preparation.policyGrant ?? undefined,
    planningTransitions: preparation.planningTransitions ?? 0,
    contextDiscoveryRound: preparation.contextDiscoveryRound ?? 0,
    sourceOverride: source,
    replanEvidence: preparation.feedback ?? null,
    setupPending: true,
  });
  let next = host.store.readRun(prior.resultRunId);
  if (next.setupPending) {
    const binding = preparation.binding
      ? await host.adapters.replaceBinding({
          binding: preparation.binding,
          runId: state.runId,
          newRunId: next.runId,
          sourceHash: preparation.sourceHash,
          owner: actor,
          previousRunStopped: true,
        })
      : null;
    if (binding) host.adapters.verifyBinding(binding);
    const toolchain = binding
      ? (host.adapters.prepareToolchain?.(binding.worktree) ?? null)
      : null;
    const fingerprint = binding ? host.adapters.fingerprint(binding.worktree, toolchain) : null;
    if (fingerprint && fingerprint.hash !== preparation.fingerprint.hash)
      fail(
        'REPLAN_WORKSPACE_DRIFT',
        'Workspace изменился во время replan; новый run остается заблокирован',
      );
    next = host.write(next, {
      binding,
      toolchain,
      workspaceFingerprint: fingerprint ? host.persistFingerprint(fingerprint) : null,
      initialFingerprint: fingerprint ? host.persistFingerprint(fingerprint) : null,
      setupPending: false,
    });
  }
  const current = host.store.readRun(state.runId);
  host.write(current, {
    operations: {
      ...current.operations,
      [request.operationId]: { ...prior, digest, status: 'finished' },
    },
  });
  const snapshot = host.snapshot(next.runId);
  if (preparation.workflow === 'autonomous' && preparation.stage === 'planning') host.schedule(next.runId);
  return snapshot;
}
