import { randomUUID } from 'node:crypto';
import { hashObject } from './io.mjs';
import { ReceiptSchema, AIReviewResultSchema } from './schemas.mjs';
import { safeReason } from './failure-reason.mjs';

/**
 * @typedef {object} DriverHost
 * @property {() => string[]} listRunIds
 * @property {(runId: string) => any} readRun Raw durable state, for startup filters and error diagnostics only.
 * @property {(runId: string) => {state: any, task: import('./schemas.mjs').TaskSpec, plan: import('./schemas.mjs').GraphPlan}} read Verified control-boundary read.
 * @property {(id: string) => any} readReceipt
 * @property {(id: string) => any} artifact
 * @property {(state: any, plan: any) => any} capabilities
 * @property {(state: any, patch: any) => any} write Host CAS write.
 * @property {(state: any, plan: any) => number | null} executionDeadline
 * @property {(runId: string) => boolean} activatePolicyGrant Host checks authorization and durable dependencies.
 * @property {(state: any, task: any, plan: any, request: any, caps: any) => Promise<any>} discoverPlanningContext
 * @property {(runId: string, request: any, actor: string) => Promise<any>} run Continuation scheduling suppressed while this drive owns the pass.
 * @property {(runId: string, name: string, request: any, options: any) => Promise<any>} command
 * @property {(input: any) => Promise<any>} replan
 */

/**
 * Bounded autonomous scheduling. The host owns verified state, authorization,
 * CAS writes and execution; this driver only chooses when to invoke them.
 * pending tracks wakeups, never durable state or operation ownership.
 */
export class AutonomousDriver {
  #host;
  /** @param {DriverHost} host */
  constructor(host, pending = new Map()) {
    this.#host = host;
    this.pending = pending;
  }

  resumeReadyWork() {
    for (const runId of this.#host.listRunIds()) {
      const raw = this.#host.readRun(runId);
      if (![2,3].includes(raw.schemaVersion) || raw.learning?.failure || raw.continuation?.kind === 'learning-hold' || raw.finalDisposition || raw.activeOperation || raw.setupPending || raw.stopRequested ||
          (!['ready','passed'].includes(raw.status) && !(raw.status === 'waiting-for-human' && raw.policyGrant))) continue;
      try {
        const { state, plan } = this.#host.read(runId);
        if (plan.workflow !== 'autonomous' || (plan.stage === 'execution' && state.status === 'passed')) continue;
        // The host read verifies the policy chain. Resume its deferred activation only
        // after durable dependencies; #drive checks the original deadline first.
        const pendingRepair = state.policyGrant && plan.nodes.some((node) => node.action.id === 'human-approve' &&
          state.nodes[node.id].status === 'waiting-for-human' && node.needs.every((id) => state.nodes[id].status === 'passed'));
        if (plan.stage === 'planning' || state.nodes['approve-plan']?.status === 'passed' || pendingRepair) this.schedule(runId);
      } catch { /* Неисправное или устаревшее выполнение остается доступным только для диагностики. */ }
    }
  }

  schedule(runId) {
    if (this.pending.has(runId)) return;
    const promise = new Promise((resolve) => setImmediate(resolve)).then(() => this.#drive(runId)).catch((error) => {
      const state = this.#host.readRun(runId);
      if (!state.activeOperation) this.#host.write(state, { failureReason: safeReason(error) });
    }).finally(() => this.pending.delete(runId));
    this.pending.set(runId, promise);
  }

  async #drive(initialRunId) {
    let runId = initialRunId;
    // Предел относится ко всему управляющему проходу, даже если адаптер вернул неожиданный state.
    for (let turn = 0; turn < 12; turn++) {
      const { state, task, plan } = this.#host.read(runId);
      if ((state.schemaVersion === 3 && (state.learning.failure || state.continuation.kind === 'learning-hold')) || state.stopRequested || state.activeOperation || state.finalDisposition || plan.workflow !== 'autonomous') return;
      const caps = this.#host.capabilities(state, plan);
      const request = { operationId: `auto-${randomUUID()}`, expectedRevision: state.revision, planHash: state.planHash };
      if (this.#host.executionDeadline(state, plan) !== null && Date.now() >= this.#host.executionDeadline(state, plan)) {
        this.#host.write(state, { failureReason: 'Истек срок согласованного автономного выполнения; требуется личное ревью' });
        return;
      }
      if (state.policyGrant && state.nodes['approve-plan']?.status !== 'passed') {
        if (this.#host.activatePolicyGrant(runId)) continue;
        return;
      }
      if (caps.run.run.allowed) {
        // The current drive owns every successor in this bounded pass.
        await this.#host.run(runId, request, state.actor);
        continue;
      }
      const discovered = await this.#host.discoverPlanningContext(state, task, plan, request, caps);
      if (discovered) { runId = discovered.runId; continue; }
      if (plan.stage === 'planning' && state.status === 'passed') {
        const next = await this.#host.command(runId, 'replan', request, { actor: state.actor });
        runId = next.runId;
        continue;
      }
      if (plan.stage === 'planning' && state.status === 'failed' && caps.run.requestReplan.allowed) {
        const planner = plan.nodes.find((node) => node.action.id === 'ai-plan');
        const failed = planner && state.nodes[planner.id];
        const receiptId = failed?.receipts.at(-1);
        const receipt = receiptId && ReceiptSchema.parse(this.#host.readReceipt(receiptId));
        const reasonCode = failed?.reason?.split(':')[0];
        if (failed?.status !== 'failed' || !['PLANNING_READ_SCOPE', 'CONTRACT_ANALYSIS_COVERAGE'].includes(reasonCode) ||
            receipt?.phase !== 'finished' || receipt.termination?.stopped !== true ||
            receipt.termination.uncertain || receipt.beforeFingerprint !== receipt.afterFingerprint) return;
        const feedback = reasonCode === 'PLANNING_READ_SCOPE'
          ? `Предыдущий план предложил чтение вне разрешенной области. Используй readPaths только внутри ${JSON.stringify([...new Set([...task.scope, ...task.contextPaths])].sort())}; не расширяй права.`
          : 'Предыдущий план свел отдельные обязательные пункты анализа к одному требованию. Для каждого пункта создай отдельное mandatory requirement с проверкой и свяжи его с implementation step через requirementIds. Не расширяй scope или права.';
        const next = await this.#host.command(runId, 'replan', { ...request, feedback }, { actor: state.actor });
        runId = next.runId;
        continue;
      }
      if (plan.stage === 'execution' && state.status === 'failed') {
        const failed = plan.nodes.filter((node) => state.nodes[node.id].status === 'failed');
        const repairable = failed.length === 1 &&
          (failed[0].action.id.startsWith('check-') || ['ai-review', 'ai-implement'].includes(failed[0].action.id));
        const definition = failed[0];
        const lastId = definition && state.nodes[definition.id].receipts.at(-1);
        const receipt = lastId && ReceiptSchema.parse(this.#host.readReceipt(lastId));
        const semanticReview = definition?.action.id === 'ai-review' && state.nodes[definition.id].artifacts.some((id) => {
          const artifact = this.#host.artifact(id);
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
          startedAt: this.#host.readReceipt(state.nodes['approve-plan'].receipts.at(-1)).finishedAt,
          cycle: 0,
        };
        if (original.cycle >= plan.autonomy.maxRepairCycles || Date.now() - Date.parse(original.startedAt) > plan.autonomy.maxDurationMs) return;
        const next = await this.#host.replan({ state, task, plan, request, digest: hashObject({ name: 'policy-repair', request }), actor: state.actor,
          caps: { ...caps, run: { ...caps.run, requestReplan: { allowed: true, reason: null } } },
          policyGrant: { ...original, cycle: original.cycle + 1 } });
        runId = next.runId;
        this.#host.activatePolicyGrant(runId);
        continue;
      }
      return;
    }
  }
}
