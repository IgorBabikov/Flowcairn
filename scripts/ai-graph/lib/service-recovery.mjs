import { GraphError, hashObject, now } from './io.mjs';
import { ReceiptSchema } from './schemas.mjs';

const fail = (code, message) => { throw new GraphError(code, message); };

// Recovery reserves an operation before inspecting durable process-stop proof.
function recordedProcessStop(host, state, processInfo) {
  if (!processInfo) return null;
  const metadataHash = hashObject(processInfo);
  for (const node of Object.values(state.nodes)) {
    for (const id of node.receipts) {
      const receipt = host.store.readObject('receipts', id);
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

function durableDockerStop(processInfo, execution) {
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

function terminationProof(processInfo, proof) {
  if (
    proof?.stopped !== true ||
    proof.uncertain === true ||
    (processInfo.kind === 'docker-check' &&
      proof.execution?.removed !== true &&
      !durableDockerStop(processInfo, proof.execution))
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

// A committed hold is already a verified boundary, never an opportunity to adopt loose receipts.
function assertCommittedLearningHold(host, state, plan, fingerprint) {
  const hold = state.continuation;
  const stages = plan.executionStages?.stages ?? [];
  const index = stages.findIndex((stage) => stage.id === hold.stageId);
  const stage = stages[index];
  const definition = plan.nodes.find((node) => node.id === stage?.boundaryNodeId);
  const node = state.nodes[definition?.id];
  const savedStage = state.learning.stages[hold.stageId];
  if (state.status !== 'learning-hold' || state.stopRequested || state.stopResult || state.finalDisposition ||
      state.failureReason || state.setupPending || index < 0 || index >= stages.length - 1 || !stage.checkNodeIds.length ||
      !stage.checkNodeIds.includes(stage.boundaryNodeId) || !definition?.action.id.startsWith('check-') ||
      Object.values(state.nodes).some((entry) => ['running', 'uncertain', 'failed', 'cancelled'].includes(entry.status)) ||
      [...stage.implementationNodeIds, stage.scopeCheckNodeId, ...stage.checkNodeIds].some((id) => state.nodes[id]?.status !== 'passed') ||
      node?.receipts.at(-1) !== hold.boundaryReceiptId || savedStage?.boundaryReceiptId !== hold.boundaryReceiptId ||
      savedStage.materialHash !== hold.materialHash || fingerprint?.hash !== hold.resultHash || state.workspaceFingerprint?.hash !== hold.resultHash)
    fail('LEARNING_HOLD_RECOVERY_UNSAFE', 'Сохраненная учебная пауза не подтверждена текущим состоянием и завершенной границей.');
  const parsed = ReceiptSchema.safeParse(host.store.readObject('receipts', hold.boundaryReceiptId));
  const receipt = parsed.success ? parsed.data : null;
  if (!receipt || receipt.phase !== 'finished' || receipt.verdict !== 'pass' || receipt.exitCode !== 0 ||
      receipt.termination?.stopped !== true || receipt.termination.uncertain !== false || !receipt.finishedAt ||
      receipt.runId !== state.runId || receipt.planHash !== state.planHash || receipt.taskHash !== state.taskHash ||
      receipt.sourceHash !== state.sourceHash || receipt.runtimeHash !== plan.runtimeHash || receipt.planVersion !== plan.version ||
      receipt.nodeId !== definition.id || receipt.actionId !== definition.action.id || receipt.actionVersion !== definition.action.version ||
      receipt.attempt !== node.attempts || receipt.beforeFingerprint !== hold.resultHash || receipt.afterFingerprint !== hold.resultHash)
    fail('LEARNING_HOLD_RECOVERY_UNSAFE', 'Receipt сохраненной границы не доказывает успешную остановленную проверку этой версии.');
}

export async function recoverRun(host, { state, task, plan, request, digest, actor }) {
  const deadLock = host.store.inspectLock(state.runId);
  if (deadLock) {
    if (deadLock.status !== 'dead') fail('RUN_LOCKED', 'GraphStore lock еще принадлежит writer');
    const expectedRevision = state.revision;
    host.store.recoverLock(state.runId);
    const unlocked = host.store.readRun(state.runId);
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
  const recoveringHold = state.schemaVersion === 3 && state.continuation.kind === 'learning-hold';
  if (recoveringHold && displacedOperation && !host.orphan({ activeOperation: displacedOperation }))
    fail('PROCESS_UNCERTAIN', 'Владелец учебной паузы еще активен');
  const recoveryOperation = {
    id: request.operationId,
    digest,
    ownerPid: process.pid,
    ownerStart: host.ownerStart,
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
  state = host.write(state, {
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
      if (recoveringHold)
        fail('LEARNING_HOLD_RECOVERY_UNSAFE', 'Учебная пауза конфликтует с незавершенной передачей в другой запуск.');
      const [operationId, prior] = successor;
      const next =
        prior.status === 'creating'
          ? await host.finishReplan(state, { operationId }, prior.digest, actor, prior)
          : host.snapshot(prior.resultRunId);
      const current = host.store.readRun(state.runId);
      if (
        current.activeOperation?.id !== request.operationId ||
        current.operations[request.operationId]?.digest !== digest ||
        current.operations[request.operationId]?.status !== 'running'
      )
        fail('RECOVERY_SUPERSEDED', 'Recovery больше не владеет run');
      host.write(current, {
        activeOperation: null,
        stopRequested: false,
        stopResult: null,
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
      const recorded = recordedProcessStop(host, state, processInfo);
      if (recorded) {
        stopProofs.set(hashObject(processInfo), recorded);
        continue;
      }
      const proof = await host.adapters.inspectProcess(processInfo);
      stopProofs.set(hashObject(processInfo), terminationProof(processInfo, proof));
    }
    if (
      displacedOperation &&
      (recoveringHold || !uniqueProcesses.length) &&
      !host.orphan({ activeOperation: displacedOperation })
    )
      fail('PROCESS_UNCERTAIN', 'Владелец запуска еще активен');
    const fingerprint = state.binding
      ? host.adapters.fingerprint(state.binding.worktree, state.toolchain)
      : null;
    if (host.store.inspectLock(state.runId)) host.store.recoverLock(state.runId);
    const current = host.store.readRun(state.runId);
    if (
      current.activeOperation?.id !== request.operationId ||
      current.operations[request.operationId]?.digest !== digest ||
      current.operations[request.operationId]?.status !== 'running'
    )
      fail('RECOVERY_SUPERSEDED', 'Recovery больше не владеет run');
    if (recoveringHold || (current.schemaVersion === 3 && current.continuation.kind === 'learning-hold')) {
      if (!recoveringHold || hashObject(current.continuation) !== hashObject(state.continuation))
        fail('RECOVERY_SUPERSEDED', 'Учебная пауза изменилась во время восстановления');
      assertCommittedLearningHold(host, current, plan, fingerprint);
      host.write(current, { activeOperation: null,
        operations: { ...current.operations, [request.operationId]: { digest, status: 'finished' } }, recovered: true });
      return host.snapshot(state.runId);
    }
    const nodes = structuredClone(current.nodes);
    for (const definition of plan.nodes)
      if (['running', 'uncertain'].includes(nodes[definition.id].status)) {
        const processInfo = nodes[definition.id].process;
        const receipt = host.receipt(current, task, plan, definition, {
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
    host.write(current, {
      nodes,
      status: 'uncertain',
      activeOperation: null,
      stopRequested: false,
      stopResult: null,
      workspaceFingerprint: fingerprint ? host.persistFingerprint(fingerprint) : current.workspaceFingerprint,
      operations,
      recovered: true,
    });
    return host.snapshot(state.runId);
  } catch (error) {
    try {
      const current = host.store.readRun(state.runId);
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
        host.write(current, { activeOperation: displacedOperation, operations });
      }
    } catch {
      // Preserve the first failure; a later recovery will inspect the durable operation owner.
    }
    throw error;
  }
}
