import type { TaskProof } from './proof-contracts';

export type RunStatus =
  | 'idle'
  | 'waiting'
  | 'pending'
  | 'ready'
  | 'running'
  | 'waiting-for-human'
  | 'passed'
  | 'failed'
  | 'uncertain'
  | 'stale';

export type CapabilityName =
  | 'run'
  | 'retry'
  | 'approve'
  | 'accept'
  | 'reject'
  | 'recover'
  | 'stop'
  | 'requestReplan'
  | 'openReceipt'
  | 'rerunCheck'
  | 'revisePlan';

export interface Capability {
  label?: string;
  allowed: boolean;
  reason: string | null;
}

export type CapabilitySet = Partial<Record<CapabilityName, Capability>>;

export interface SkillSummary {
  id: string;
  path: string;
  hash: string;
}

export interface ArtifactSummary {
  id: string;
  kind: string;
  title: string;
  mediaType: string;
  size: number;
}

export interface CheckResult {
  id: string;
  passed: boolean;
  exitCode: number | null;
  durationMs: number;
  summary: string;
  inputHash: string;
}

export interface GraphNodeSnapshot {
  sourceRunId?: string;
  sourcePlanHash?: string;
  id: string;
  title: string;
  outcome: string;
  needs: string[];
  action: { id: string; kind: string };
  status: RunStatus;
  mode: 'read' | 'write';
  permissions: string[];
  resources?: { reads: string[]; writes: string[] };
  skills: SkillSummary[];
  attempt: number;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  reason: string | null;
  receiptIds: string[];
  artifacts: ArtifactSummary[];
  changedFiles: string[];
  checks: CheckResult[];
  capabilities: CapabilitySet;
}

export interface GateSnapshot {
  nodeId: string;
  type: 'provider-consent' | 'approve-plan' | 'accept-result';
  readPaths?: string[];
  title: string;
  scope: string[];
  planHash: string;
  requiredPermissions: string[];
  risks: string[];
  evidence: string[];
  consequences: { approve: string; reject: string };
  challenge: string;
  expiresAt: number;
}

export interface WorkflowProgress {
  nodeId: string;
  title: string;
  action: 'ai-analyze' | 'ai-plan';
  outcome?: string;
  attempt?: number;
  durationMs?: number | null;
  status: RunStatus;
  sourceRunId: string;
  planHash: string;
  receiptIds: string[];
  artifacts: ArtifactSummary[];
}
export interface Snapshot {
  proof?: TaskProof;
  failureReason?: string | null;
  workflowProgress?: WorkflowProgress[];
  phase?: 'planning' | 'execution';
  workflow?: 'autonomous' | null;
  successorRunId?: string | null;
  completion?: 'ready-for-review' | null;
  delivery?: { workspacePath: string } | null;
  schemaVersion: 2;
  runId: string;
  task?: { id: string; goal: string; title?: string; description?: string; taskNumber?: string; scope: string[]; acceptance: string[] };
  planVersion?: number;
  planHash?: string;
  revision?: number;
  status: RunStatus;
  finalDisposition?: string | null;
  createdAt?: string;
  updatedAt?: string;
  nodes: GraphNodeSnapshot[];
  edges: Array<{ id: string; source: string; target: string }>;
  activeNodeId?: string | null;
  gates: GateSnapshot[];
  capabilities: CapabilitySet;
  integrity: { valid: boolean; reason: string | null };
  runner?: {
    ai: { available: boolean; reason: string };
    checks: { available: boolean; reason: string };
  };
  planningArtifacts?: ArtifactSummary[];
  supersedesRunId?: string | null;
}

export interface RunSummary {
  runId: string;
  task: Snapshot['task'] | null;
  status: RunStatus;
  revision: number | null;
  planVersion: number | null;
  planHash: string | null;
  updatedAt: string | null;
  integrity: { valid: boolean; reason: string | null; checked?: 'metadata' };
}

export interface ServiceCapabilities {
  create?: Capability;
}

export interface PlanNode {
  id: string;
  title: string;
  outcome: string;
  needs: string[];
  action: { id: string; version: number; inputs: Record<string, unknown> };
  success: { kind: string; requiredArtifacts: string[] };
  permissions: string[];
  skills: string[];
  resources: { reads: string[]; writes: string[]; exclusive: string[] };
  retry: { maxAttempts: number; backoffMs: number };
}

export interface GraphPlan {
  schemaVersion: 2;
  taskHash: string;
  version: number;
  parentPlanHash: string | null;
  sourceHash: string;
  runtimeHash: string;
  registryHash: string;
  policyHash: string;
  skills: SkillSummary[];
  nodes: PlanNode[];
}

export interface HistoryEvent {
  runId: string;
  revision: number;
  at: string;
  status: RunStatus;
  planHash: string;
  nodes: Array<{
    id: string;
    status: RunStatus;
    attempt: number;
    receiptIds: string[];
  }>;
}

export interface Receipt {
  schemaVersion: 2;
  runId: string;
  nodeId: string;
  attemptId: string;
  attempt: number;
  phase: string;
  actionId: string;
  actionVersion: number;
  planVersion: number;
  planHash: string;
  taskHash: string;
  sourceHash: string;
  runtimeHash: string;
  instructionsHash: string;
  skills: SkillSummary[];
  permissions: string[];
  grantedPermissions: string[];
  termination: {
    stopped: boolean;
    uncertain: boolean;
    timedOut: boolean;
    outputLimit: boolean;
    signal: string | null;
    ticketHash: string | null;
    execution: unknown;
  } | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  exitCode: number | null;
  verdict: 'pass' | 'fail' | 'uncertain' | 'started';
  checks: CheckResult[];
  artifacts: string[];
  changedFiles: string[];
  failureReason: string | null;
  beforeFingerprint: string;
  afterFingerprint: string | null;
  actor: string;
  operationId: string;
  previousReceipt: string | null;
}

export interface Artifact {
  id: string;
  schemaVersion: 2;
  kind: string;
  title: string;
  mediaType: string;
  content: string;
}

export interface ControlRequest {
  operationId: string;
  expectedRevision: number;
  planHash: string;
  nodeId?: string;
  decision?: 'approve' | 'reject' | 'accept';
  permissions?: string[];
  challenge?: string;
  draft?: { nodes: unknown[] };
  reason?: string;
  feedback?: string;
  requirementId?: string;
  resultHash?: string;
}

export interface TaskInput {
  contextPaths?: string[];
  id: string;
  goal: string;
  instructions: string;
  scope: string[];
  forbiddenPaths: string[];
  includeUntracked: string[];
  acceptance: string[];
  checks: string[];
  resources: string[];
  limits: { maxAttempts: number; maxReplans: number; timeoutMs: number };
}

export interface ApiError {
  code: string;
  message: string;
  retryable: boolean;
}

export function isSnapshot(value: unknown): value is Snapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<Snapshot>;
  return (
    candidate.schemaVersion === 2 &&
    typeof candidate.runId === 'string' &&
    typeof candidate.status === 'string' &&
    Array.isArray(candidate.nodes) &&
    Array.isArray(candidate.edges) &&
    Array.isArray(candidate.gates) &&
    Boolean(candidate.capabilities) &&
    Boolean(candidate.integrity)
  );
}

export interface BootstrapContext {
  firstTask: boolean;
  required: boolean;
  changedPaths: string[];
  untrackedCandidates: string[];
  requiredUntracked?: Array<{ path: string; hash: string }>;
  snapshotHash: string;
}
export interface IntakeOptions {
  scope?: string[];
  snapshot?: true;
  includeUntracked?: string[];
  snapshotHash?: string;
}
export interface ProjectContext {
  bootstrap?: BootstrapContext;
  schemaVersion: 2;
  name: string;
  contextHash: string;
  contextPaths: string[];
  scopeCandidates: string[];
  checks: string[];
  ai: { provider: string | null; model: string | null };
  capabilities: { intake: Capability };
}
export interface TaskFields {
  title: string;
  description: string;
  taskNumber: string;
}
export interface IntakeInput extends TaskFields {
  operationId: string;
  contextHash: string;
}

export interface OnboardingStatus {
  configured: boolean;
  profileHash: string | null;
  providers: Array<{id: string; label: string; supported: boolean; state: string; reason: string | null}>;
  values: { provider: string; model: string | null; modelMode: string; reasoningEffort: string | null; testPolicy: string; coverage: boolean; readConsent: boolean };
  limitations: string[];
}
