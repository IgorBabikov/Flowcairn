import type { ArtifactSummary, GraphNodeSnapshot, RunStatus, SkillSummary, Snapshot } from '../contracts';

export type WorldRole = 'analyst' | 'mage' | 'checker' | 'reviewer' | 'mentor' | 'unknown';
export type WorldStation = 'map' | 'bench' | 'checks' | 'book';
export type WorldFreshness = 'current' | 'disconnected' | 'stale' | 'history' | 'unknown';
export type WorldWorkerState = RunStatus | Exclude<WorldFreshness, 'current'>;

export interface WorldWorker {
  /** An assignment, not a claim that the provider has a separate native agent. */
  id: string;
  runId: string;
  planHash: string | null;
  nodeId: string;
  role: WorldRole;
  station: WorldStation;
  action: string;
  title: string;
  state: WorldWorkerState;
  runtimeStatus: RunStatus;
  active: boolean;
  historical: boolean;
  dependencies: string[];
  attempt: number;
  startedAt: string | null;
  finishedAt: string | null;
  receiptIds: string[];
  artifactRefs: ArtifactSummary[];
  skills: SkillSummary[];
  reason: string | null;
}

export interface WorldHandoff {
  /** Dependency readiness + observed consumer start. No artifact-consumption event exists in Snapshot. */
  kind: 'dependency-start';
  id: string;
  fromWorkerId: string;
  toWorkerId: string;
  fromNodeId: string;
  toNodeId: string;
  receiptId: string;
  artifactRefs: ArtifactSummary[];
}

export interface WorldExecutionView {
  runId: string | null;
  planHash: string | null;
  revision: number | null;
  freshness: WorldFreshness;
  runtimeStatus: RunStatus | null;
  completed: boolean;
  workers: WorldWorker[];
  handoffs: WorldHandoff[];
}

export interface WorldExecutionOptions {
  /** Current snapshot channel, including polling fallback; not specifically an SSE connection. */
  connected: boolean;
  snapshotUnavailable?: boolean;
  /** Explicit archive selection; historical worker refs are still readable. */
  history?: boolean;
}

interface CursorNode {
  status: RunStatus;
  attempt: number;
  startedAt: string | null;
  receiptIds: string[];
}

export interface WorldExecutionCursor {
  binding: string;
  revision: number | null;
  nodes: Record<string, CursorNode>;
  /** At most one freshly observed terminal receipt per node. */
  armed: Record<string, string>;
  /** Latest handoff per dependency edge; bounded by this plan's edges, not session duration. */
  emitted: Record<string, string>;
}

function roleFor(action: string): WorldRole {
  if (action === 'ai-analyze' || action === 'ai-plan') return 'analyst';
  if (action === 'ai-implement') return 'mage';
  if (action === 'ai-review') return 'reviewer';
  if (action === 'workspace-check' || action.startsWith('check-')) return 'checker';
  if (['human-provider-consent', 'human-approve', 'human-accept', 'artifact-handoff'].includes(action)) return 'mentor';
  return 'unknown';
}

function stationFor(role: WorldRole): WorldStation {
  if (role === 'analyst') return 'map';
  if (role === 'mage') return 'bench';
  if (role === 'checker' || role === 'reviewer') return 'checks';
  return 'book';
}

const knownStatuses = new Set<RunStatus>([
  'idle', 'waiting', 'pending', 'ready', 'running', 'learning-hold', 'waiting-for-human',
  'passed', 'failed', 'cancelled', 'uncertain', 'stale',
]);

function knownStatus(status: unknown): status is RunStatus {
  return typeof status === 'string' && knownStatuses.has(status as RunStatus);
}

function freshnessOf(snapshot: Snapshot | null, options: WorldExecutionOptions): WorldFreshness {
  if (!snapshot) return 'unknown';
  if (options.history) return 'history';
  if (options.snapshotUnavailable || !options.connected) return 'disconnected';
  if (!knownStatus(snapshot.status) || snapshot.nodes.some(node => !knownStatus(node.status)) ||
    snapshot.workflowProgress?.some(progress => !knownStatus(progress.status))) return 'unknown';
  if (!snapshot.integrity.valid || snapshot.status === 'stale' || snapshot.proof?.status === 'STALE') return 'stale';
  return 'current';
}

function workerOf(snapshot: Snapshot, node: GraphNodeSnapshot, freshness: WorldFreshness): WorldWorker {
  const runId = node.sourceRunId ?? snapshot.runId;
  const planHash = node.sourcePlanHash ?? snapshot.planHash ?? null;
  const historical = runId !== snapshot.runId || planHash !== (snapshot.planHash ?? null);
  const role = roleFor(node.action.id);
  const state: WorldWorkerState = historical ? 'history' : freshness !== 'current' ? freshness : role === 'unknown' ? 'unknown' : node.status;
  const stopped = snapshot.execution?.stopRequested || ['stopping', 'stopped', 'stop-uncertain'].includes(snapshot.execution?.state ?? '');
  return {
    id: JSON.stringify([runId, planHash, node.id]), runId, planHash, nodeId: node.id,
    role, station: stationFor(role), action: node.action.id, title: node.title,
    state, runtimeStatus: node.status,
    active: state === 'running' && !stopped && !['uncertain', 'failed', 'cancelled'].includes(snapshot.status),
    historical, dependencies: [...node.needs], attempt: node.attempt,
    startedAt: node.startedAt, finishedAt: node.finishedAt,
    receiptIds: [...node.receiptIds], artifactRefs: node.artifacts.map(item => ({ ...item })),
    skills: node.skills.map(item => ({ ...item })), reason: node.reason,
  };
}

function isCompleted(snapshot: Snapshot, freshness: WorldFreshness): boolean {
  const proof = snapshot.proof;
  if (freshness !== 'current' || !proof || proof.status !== 'PROVEN' || ['uncertain', 'failed', 'cancelled'].includes(snapshot.status)) return false;
  // This only rejects inconsistent read models; cryptographic/source verification remains owned by Executor.
  const certificate = proof.certificate;
  const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  if (!certificate || certificate.version !== 1 || !hash(certificate.id) || !hash(certificate.contractHash) ||
    !hash(proof.resultHash) || certificate.resultHash !== proof.resultHash || !snapshot.task ||
    certificate.taskId !== snapshot.task.id || certificate.goal !== snapshot.task.goal ||
    !proof.contract || proof.contract.version !== 1 || certificate.goal !== proof.contract.goal ||
    !Array.isArray(certificate.requirementIds) || !Array.isArray(certificate.evidenceIds) ||
    !Array.isArray(certificate.receiptIds) || !Array.isArray(proof.evidence)) return false;
  const required = proof.requirements.filter(item => item.mandatory);
  const sameIds = (left: string[], right: string[]) => new Set(left).size === left.length &&
    new Set(right).size === right.length && left.length === right.length && left.every(id => right.includes(id));
  const ids = required.map(item => item.id);
  if (!required.length || !required.every(item => item.status === 'proven') ||
    !sameIds(ids, certificate.requirementIds) || !sameIds(ids, proof.contract.requirements.filter(item => item.mandatory).map(item => item.id)) ||
    proof.coverage.required !== required.length || proof.coverage.proven !== required.length ||
    proof.findings.some(item => item.blocking && item.status === 'open')) return false;
  const evidence = new Map(proof.evidence.map(item => [item.id, item]));
  if (evidence.size !== proof.evidence.length || !certificate.evidenceIds.length ||
    !certificate.receiptIds.every(id => typeof id === 'string' && id.length > 0) ||
    new Set(certificate.evidenceIds).size !== certificate.evidenceIds.length || !certificate.evidenceIds.every(id => {
      const item = evidence.get(id);
      return typeof id === 'string' && id.length > 0 && item?.status === 'passed' && item.freshness === 'current' &&
        item.resultHash === proof.resultHash && Array.isArray(item.requirementIds) && item.requirementIds.every(requirementId => typeof requirementId === 'string') &&
        typeof item.receiptId === 'string' && item.receiptId.length > 0 && certificate.receiptIds.includes(item.receiptId);
    })) return false;
  // Requirement evidenceIds is an audit trail, including failed/stale attempts after repair.
  // Only certificate-selected current evidence proves completion; the historical trail stays intact.
  return required.every(requirement => Array.isArray(requirement.evidenceIds) && requirement.evidenceIds.length > 0 &&
    requirement.evidenceIds.some(id => certificate.evidenceIds.includes(id) && evidence.get(id)?.requirementIds.includes(requirement.id)));
}

/** Pure read model. No commands, clocks, network, provider messages, or inferred hidden reasoning. */
export function projectWorldExecution(snapshot: Snapshot | null, options: WorldExecutionOptions): WorldExecutionView {
  const freshness = freshnessOf(snapshot, options);
  if (!snapshot) return { runId: null, planHash: null, revision: null, freshness, runtimeStatus: null, completed: false, workers: [], handoffs: [] };
  const workers = snapshot.nodes.map(node => workerOf(snapshot, node, freshness));
  // Planning progress is a preserved prior-run read model, never a live worker.
  for (const progress of snapshot.workflowProgress ?? []) {
    if (workers.some(worker => worker.nodeId === progress.nodeId && worker.runId === progress.sourceRunId)) continue;
    workers.push({
      id: JSON.stringify([progress.sourceRunId, progress.planHash, progress.nodeId]),
      runId: progress.sourceRunId, planHash: progress.planHash, nodeId: progress.nodeId,
      role: roleFor(progress.action), station: 'map', action: progress.action, title: progress.title,
      state: 'history', runtimeStatus: progress.status, active: false, historical: true, dependencies: [],
      attempt: progress.attempt ?? 0, startedAt: null, finishedAt: null,
      receiptIds: [...progress.receiptIds], artifactRefs: progress.artifacts.map(item => ({ ...item })), skills: [], reason: null,
    });
  }
  return { runId: snapshot.runId, planHash: snapshot.planHash ?? null, revision: snapshot.revision ?? null,
    freshness, runtimeStatus: snapshot.status, completed: isCompleted(snapshot, freshness), workers, handoffs: [] };
}

function cursorFor(view: WorldExecutionView): WorldExecutionCursor | null {
  // Missing revision/plan binding cannot establish ordered live transitions.
  if (view.freshness !== 'current' || !view.runId || !view.planHash || view.revision === null ||
    ['uncertain', 'failed', 'cancelled'].includes(view.runtimeStatus ?? '')) return null;
  const nodes: Record<string, CursorNode> = {};
  for (const worker of view.workers.filter(item => !item.historical)) nodes[worker.nodeId] = {
    status: worker.runtimeStatus, attempt: worker.attempt, startedAt: worker.startedAt, receiptIds: [...worker.receiptIds],
  };
  return { binding: JSON.stringify([view.runId, view.planHash]), revision: view.revision, nodes, armed: {}, emitted: {} };
}

/** Keep cursor per displayed live run. A missing cursor/reconnect/archive establishes a silent baseline. */
export function selectWorldExecution(snapshot: Snapshot | null, options: WorldExecutionOptions, previous?: WorldExecutionCursor | null): {
  view: WorldExecutionView; cursor: WorldExecutionCursor | null;
} {
  const view = projectWorldExecution(snapshot, options);
  const cursor = cursorFor(view);
  if (!cursor || !previous || previous.binding !== cursor.binding || previous.revision === null) return { view, cursor };
  if (cursor.revision === null || cursor.revision <= previous.revision) {
    // An out-of-order response cannot establish an animation baseline or rewind the cursor.
    if (cursor.revision !== null && cursor.revision < previous.revision) {
      view.freshness = 'unknown'; view.completed = false;
      view.workers = view.workers.map(worker => ({ ...worker, state: worker.historical ? 'history' : 'unknown', active: false }));
    }
    return { view, cursor: previous };
  }
  const current = view.workers.filter(item => !item.historical && item.role !== 'unknown');
  for (const consumer of current) for (const dependency of consumer.dependencies) {
    const edge = JSON.stringify([dependency, consumer.nodeId]);
    const emitted = previous.emitted[edge];
    if (emitted) cursor.emitted[edge] = emitted;
  }
  for (const worker of current) {
    const before = previous.nodes[worker.nodeId];
    const lastReceipt = worker.receiptIds.at(-1);
    // Arm only a completion observed during this uninterrupted subscription, never a baseline/history receipt.
    if (worker.state === 'passed' && before && lastReceipt &&
      (before.status !== 'passed' || before.attempt !== worker.attempt) && !before.receiptIds.includes(lastReceipt)) cursor.armed[worker.nodeId] = lastReceipt;
    else if (worker.state === 'passed' && lastReceipt && previous.armed[worker.nodeId] === lastReceipt) cursor.armed[worker.nodeId] = lastReceipt;
  }
  for (const consumer of current) {
    const before = previous.nodes[consumer.nodeId];
    const started = consumer.active && consumer.startedAt && before &&
      (before.status !== 'running' || before.attempt !== consumer.attempt || before.startedAt !== consumer.startedAt);
    if (!started) continue;
    for (const dependency of consumer.dependencies) {
      const predecessor = current.find(item => item.nodeId === dependency);
      const receiptId = cursor.armed[dependency];
      if (!predecessor || predecessor.state !== 'passed' || !receiptId || predecessor.receiptIds.at(-1) !== receiptId || !predecessor.finishedAt) continue;
      const finished = Date.parse(predecessor.finishedAt), start = Date.parse(consumer.startedAt!);
      if (!Number.isFinite(finished) || !Number.isFinite(start) || start < finished) continue;
      const id = JSON.stringify([view.runId, view.planHash, predecessor.nodeId, predecessor.attempt, receiptId, consumer.nodeId, consumer.attempt, consumer.startedAt]);
      const edge = JSON.stringify([dependency, consumer.nodeId]);
      if (cursor.emitted[edge] === id) continue;
      cursor.emitted[edge] = id;
      view.handoffs.push({
        kind: 'dependency-start',
        id,
        fromWorkerId: predecessor.id, toWorkerId: consumer.id, fromNodeId: predecessor.nodeId, toNodeId: consumer.nodeId,
        receiptId, artifactRefs: predecessor.artifactRefs.map(item => ({ ...item })),
      });
    }
  }
  return { view, cursor };
}
