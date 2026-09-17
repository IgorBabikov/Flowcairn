import { hashObject } from './io.mjs';

const unique = (values) => [...new Set(values)];

// Read model for UI/HTTP: state and allowed actions always come from WorkflowService.
export function projectSnapshot(host, runId, verifySource) {
    let loaded,
      driftReason = null;
    try {
      loaded = host.read(runId, { verifySource });
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
          loaded = host.read(runId, { current: false, verifySource });
          driftReason = host.safeReason(error);
        } catch {
          /* Corruption still fails closed below. */
        }
      }
      if (!loaded)
        return {
          schemaVersion: 2,
          runId,
          status: 'stale',
          integrity: { valid: false, reason: host.safeReason(error) },
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
      capabilities = host.caps(state, plan);
    if (driftReason)
      for (const collection of [capabilities.run, ...Object.values(capabilities.nodes)])
        for (const name of Object.keys(collection))
          if (
            !(
              driftReason.startsWith('STALE_GRAPH_')
                ? ['openReceipt']
                : ['requestReplan', 'revisePlan', 'recover', 'stop', 'openReceipt']
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
        title: host.sanitizeText(definition.title),
        outcome: host.sanitizeText(definition.outcome),
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
        reason: reason ? host.sanitizeText(reason) : null,
        receiptIds: node.receipts,
        artifacts: node.artifacts.map((hash) => host.artifactMetadata(hash)),
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
        type: node.action.id === 'human-provider-consent' ? 'provider-consent' : node.action.id === 'human-approve' ? 'approve-plan' : 'accept-result',
        title: node.title,
        scope: plan.workflow === 'autonomous' ? unique(plan.nodes.flatMap(item => item.resources.writes)).sort() : task.scope,
        readPaths: unique(
          plan.nodes
            .filter((n) => ['analysis', 'implementation', 'review'].includes(n.success.kind))
            .flatMap((n) => n.resources.reads),
        ).sort(),
        planHash: state.planHash,
        requiredPermissions: node.action.id === 'human-provider-consent'
          ? []
          : unique(plan.nodes.flatMap((n) => n.permissions)),
        risks: [
          ...(node.action.id === 'human-provider-consent' ? [
            `Передача: ${host.adapters.project?.ai.provider === 'claude' ? 'Claude Code / Anthropic' : 'Cursor'}. Будут переданы только approved scope, instructions, Skills и artifacts текущего плана.`,
            'Не передаются .env и другие secrets, Git history, unapproved files и доступ к shell проекта. Можно отменить без передачи данных.',
            `План: ${state.planHash}; scope: ${hashObject({ scope: task.scope, readPaths: plan.nodes.filter((item) => item.action.id.startsWith('ai-')).flatMap((item) => item.resources.reads).sort(), sourceHash: state.sourceHash })}.`,
          ] : []),
          `AI provider: ${host.adapters.project?.ai.provider ?? 'codex'}; model: ${host.adapters.project?.ai.model ?? 'configured'}. Вызов может расходовать платный лимит.`,
          plan.workflow === 'autonomous'
            ? 'После согласования начнутся изменения, проверки и ревью. Разрешение чтения задано в настройках проекта.'
            : 'Задание, исходники в readPaths и назначенные инструкции/Skills будут переданы выбранному AI после отдельного Run.',
          'AI может ошибаться. Приемка опирается на diff, checks и review.',
          'Разрешенная запись изменяет только изолированный workspace.',
        ],
        evidence: unique(nodes.flatMap((n) => n.artifacts.map((a) => a.id))),
        consequences: {
          approve:
            node.action.id === 'human-provider-consent'
              ? 'Разрешить только эту одну передачу ограниченного контекста выбранному provider. Согласие будет сохранено рядом с immutable plan и receipt.'
              : node.action.id === 'human-approve'
              ? plan.workflow === 'autonomous'
                ? `Выполнить план автоматически в указанных границах, включая до ${plan.autonomy.maxRepairCycles} циклов исправлений. Общий срок — ${Math.floor(plan.autonomy.maxDurationMs / 60000)} минут. Commit и PR остаются за вами.`
                : 'Разрешить исполнение этого immutable плана с указанными правами.'
              : 'Принять локальный результат и handoff. Интеграция в Git остается отдельным действием.',
          reject: 'Закрыть этот run без запуска следующих действий.',
        },
        challenge: host.challenge(state, node.id, expiresAt),
        expiresAt,
      }));
    const delivery = host.delivery(state, plan, driftReason);
    const proof = host.taskProof(state, task, plan, driftReason);
    return {
      schemaVersion: 2,
      runId,
      task: {
        id: task.id,
        goal: host.sanitizeText(task.goal),
        title: host.sanitizeText(task.goal),
        description: host.sanitizeText(task.instructions),
        taskNumber: host.sanitizeText(task.taskNumber ?? task.id),
        planningFeedback: (task.planningFeedback ?? []).map(host.sanitizeText),
        scope: task.scope,
        acceptance: task.acceptance.map(host.sanitizeText),
      },
      workflow: plan.workflow ?? null,
      proof,
      workflowProgress: host.workflowProgress(state, plan),
      completion: delivery ? 'ready-for-review' : null,
      delivery,
      successorRunId: Object.values(state.operations).find((operation) => operation.resultRunId && operation.status === 'finished')?.resultRunId ?? null,
      failureReason: state.failureReason ? host.sanitizeText(state.failureReason) : null,
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
          available: host.adapters.runner.ai.available,
          reason: host.sanitizeText(host.adapters.runner.ai.reason ?? ''),
        },
        checks: {
          available: host.adapters.runner.checks.available,
          reason: host.sanitizeText(host.adapters.runner.checks.reason ?? ''),
        },
      },
      planningArtifacts: state.planningArtifacts.map((hash) => host.artifactMetadata(hash)),
      supersedesRunId: state.supersedesRunId,
    };
  }
