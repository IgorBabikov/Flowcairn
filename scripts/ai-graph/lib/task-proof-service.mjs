import { GraphError, hashObject, now } from './io.mjs';
import { RequirementAcceptanceReceiptSchema } from './schemas.mjs';
import { selectAnalysisEvidence } from './analysis-evidence.mjs';
import { deriveTaskProof } from './task-proof.mjs';
import { requirementAcceptanceCapability } from './requirement-verification.mjs';

const fail = (code, message) => { throw new GraphError(code, message); };

/** Proof integration receives only the trusted service's storage, validation and mutation callbacks. */
export function createTaskProofService(host) {
  const proofHistory = (state) => {
    const history = [], visited = new Set([state.runId]);
    let id = state.supersedesRunId;
    while (id) {
      if (history.length >= 100 || visited.has(id)) fail('EXECUTION_HISTORY', 'История задачи повреждена');
      visited.add(id);
      const previous = host.readRun(id, { current: false, verifySource: false, verifyBinding: false });
      history.unshift(previous);
      id = previous.state.supersedesRunId;
    }
    return history;
  };
  return {
    analysis(state, plan) {
      return selectAnalysisEvidence({ state, plan, readArtifact: host.readArtifact, readReceipt: host.readReceipt })?.result.analysis ?? null;
    },
    taskProof(state, task, plan, driftReason = null) {
      let fingerprint = null, reason = driftReason;
      try {
        if (state.binding) {
          host.verifyBinding(state.binding);
          if (state.toolchain && host.verifyToolchain) host.verifyToolchain(state.binding.worktree, state.toolchain);
          fingerprint = host.fingerprint(state.binding.worktree, state.toolchain);
        }
      } catch (error) { reason = reason ?? host.safeReason(error); }
      const proof = deriveTaskProof({ state, task, plan, currentFingerprint: fingerprint, currentReason: reason,
        previousExecutions: proofHistory(state), readReceipt: host.readReceipt, readArtifact: host.readArtifact });
      const acceptance = requirementAcceptanceCapability(state, plan, fingerprint, reason, host.hasLock(state.runId));
      return { ...proof, resultHash: fingerprint?.hash ?? null, acceptance: { ...acceptance,
        challenge: acceptance.allowed ? host.challenge(state, 'requirement-acceptance', Date.now() + 300000) : null } };
    },
    // The outer service checks command name, revision, plan hash and idempotency before dispatch.
    acceptRequirement({ runId, state, plan, request, digest, actor }) {
      const requirement = plan.taskContract?.requirements.find((item) => item.id === request.requirementId);
      if (!requirement || requirement.verification.method !== 'human' || request.decision !== 'accept' || !request.reason?.trim())
        fail('REQUIREMENT_ACCEPTANCE_DENIED', 'Нужны требование с ручной приемкой и описание фактической проверки');
      host.verifyChallenge(state, 'requirement-acceptance', request.challenge);
      if (state.binding) host.verifyBinding(state.binding);
      if (state.toolchain && host.verifyToolchain) host.verifyToolchain(state.binding.worktree, state.toolchain);
      const fingerprint = state.binding ? host.fingerprint(state.binding.worktree, state.toolchain) : null;
      const capability = requirementAcceptanceCapability(state, plan, fingerprint, null, host.hasLock(runId));
      if (!capability.allowed) fail('REQUIREMENT_ACCEPTANCE_DENIED', capability.reason);
      if (request.resultHash !== fingerprint.hash) fail('REQUIREMENT_RESULT_CHANGED', 'Подтвердите актуальное состояние результата');
      const receipt = RequirementAcceptanceReceiptSchema.parse({ schemaVersion: 2, phase: 'requirement', runId,
        planHash: state.planHash, taskHash: state.taskHash, contractHash: hashObject(plan.taskContract),
        requirementId: requirement.id, decision: 'accept', actor, acceptedAt: now(), resultHash: fingerprint.hash,
        reason: host.sanitizeText(request.reason), operationId: request.operationId,
        previousReceipt: state.requirementReceipts?.at(-1) ?? null, artifacts: [] });
      const receiptId = host.putReceipt(receipt);
      host.write(state, { requirementReceipts: [...(state.requirementReceipts ?? []), receiptId],
        operations: { ...state.operations, [request.operationId]: { digest, status: 'finished' } } });
      return host.snapshot(runId);
    },
  };
}
