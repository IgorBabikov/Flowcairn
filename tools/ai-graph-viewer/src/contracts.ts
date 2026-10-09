import type { TaskContract, TaskProof } from './proof-contracts';

export type RunStatus =
  | 'idle'
  | 'waiting'
  | 'pending'
  | 'ready'
  | 'running'
  | 'learning-hold'
  | 'waiting-for-human'
  | 'passed'
  | 'failed'
  | 'cancelled'
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
  | 'revisePlan'
  | 'continueLearning'
  | 'setLearningMode'
  | 'openLearning';

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
  resolutionKind?: 'semantic' | 'process' | null;
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
interface SnapshotBase {
  contextClarification?: boolean;
  resolutionKind?: 'semantic' | 'process' | null;
  proof?: TaskProof;
  failureReason?: string | null;
  workflowProgress?: WorkflowProgress[];
  phase?: 'planning' | 'execution';
  workflow?: 'autonomous' | null;
  successorRunId?: string | null;
  completion?: 'ready-for-review' | null;
  delivery?: { workspacePath: string; mode?: 'direct' } | null;
  runId: string;
  task?: { id: string; goal: string; title?: string; description?: string; taskNumber?: string; scope: string[]; acceptance: string[] };
  planVersion?: number;
  planHash?: string;
  revision?: number;
  status: RunStatus;
  execution?: {
    state: 'idle' | 'running' | 'stopping' | 'stopped' | 'stop-uncertain';
    stopRequested: boolean;
  };
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

export interface SnapshotV2 extends SnapshotBase {
  schemaVersion: 2;
  continuation?: null;
  learning?: null;
  approvalExpiresAt?: number | null;
}
export interface SnapshotV3 extends SnapshotBase {
  schemaVersion: 3;
  continuation: Continuation;
  learning: LearningSnapshot;
  approvalExpiresAt: number | null;
}
export type Snapshot = SnapshotV2 | SnapshotV3;

export interface RunSummary {
  resolutionKind?: 'semantic' | 'process' | null;
  contextClarification?: boolean;
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

interface GraphPlanBase {
  taskContract?: TaskContract;
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

export interface GraphPlanV2 extends GraphPlanBase {
  schemaVersion: 2;
}
export interface GraphPlanV3 extends GraphPlanBase {
  schemaVersion: 3;
  stage: 'planning' | 'execution';
  checkRegistryHash: string;
  checks: PlanChecks;
  learning: { version: 1; initialMode: LearningMode };
  executionStages: ExecutionStages | null;
}
export type GraphPlan = GraphPlanV2 | GraphPlanV3;

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
  verdict: 'pass' | 'fail' | 'cancelled' | 'uncertain' | 'started';
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
  contextSelection?: ContextSelection & { contextHash: string };
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
  learningMode?: LearningMode;
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
    (candidate.schemaVersion === 2 || (candidate.schemaVersion === 3 &&
      Boolean(candidate.continuation) && Boolean(candidate.learning) &&
      (candidate.approvalExpiresAt === null || typeof candidate.approvalExpiresAt === 'number'))) &&
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
  schemaVersion: 2 | 3;
  name: string;
  contextHash: string;
  contextPaths: string[];
  scopeCandidates: string[];
  checks: string[] | ProjectCheckSummary[];
  checkIds?: string[];
  toolchain?: {
    status: 'ready' | 'missing' | 'unverified';
    issues: Array<{ checkId: string | null; code: string; message: string }>;
  };
  ai: { provider: string | null; model: string | null };
  capabilities: { intake: Capability };
}
export interface ProjectCheckSummary {
  id: string;
  title: string;
  purpose: string;
  available: boolean;
  reason: string | null;
  profileHash: string;
}
export interface TaskFields {
  title: string;
  description: string;
  taskNumber: string;
}
export interface IntakeInput extends TaskFields {
  learningMode?: LearningMode;
  operationId: string;
  contextHash: string;
  selection?: ContextSelection;
}

export interface ContextSelection {
  previewHash: string;
  scope: string[];
  resolutions: Array<{ reference: string; kind: 'existing' | 'create' | 'example'; path?: string }>;
}
export interface IntakePreview {
  contextHash: string;
  previewHash: string;
  scope: string[];
  candidates: string[];
  references: Array<{ reference: string; status: 'resolved' | 'missing' | 'ambiguous' | 'unavailable'; matches: string[] }>;
  issues: string[];
  ready: boolean;
  feedback: string[];
}
export type PreviewInput = TaskFields & { learningMode?: LearningMode; contextHash: string; selection?: ContextSelection; runId?: string };

export interface OnboardingStatus {
  configured: boolean;
  profileHash: string | null;
  providers: Array<{id: string; label: string; supported: boolean; state: string; reason: string | null}>;
  values: { provider: string; model: string | null; modelMode: string; reasoningEffort: string | null; testPolicy: string; coverage: boolean; checkMode: 'none' | 'trusted-local' | 'hardened'; checks: string[]; readConsent: boolean };
  limitations: string[];
}

// Canonical RPG v1 transport contracts. Execution authority remains in the runtime.
export type LearningMode = 'after-stage' | 'after-task';
export type LearningProgress = 'unread' | 'read' | 'deferred';
export type SourceFreshness = 'current' | 'stale' | 'unknown';
export interface RegisteredCheck {
  id: string;
  title: string;
  purpose: string;
  command: { executable: string; argv: string[]; cwd: string };
  inputPaths: string[];
  outputPaths: string[];
  timeoutMs: number;
  maxOutputBytes: number;
}
export interface CheckProfile {
  version: 1;
  requiredCheckIds: string[];
  definitions: RegisteredCheck[];
  environment: Array<{ name: string; value: string }>;
}
export interface BoundCheck {
  id: string;
  definitionHash: string;
  executableHash: string;
  invocationHash: string;
  inputManifestHash: string;
  toolchainHash: string;
}
export interface PlanChecks {
  version: 1;
  profileHash: string;
  definitions: RegisteredCheck[];
  bindings: BoundCheck[];
}
export interface StageSpec {
  id: string;
  title: string;
  outcome: string;
  implementationNodeIds: string[];
  requirementIds: string[];
  scopeCheckNodeId: string;
  checkNodeIds: string[];
  boundaryNodeId: string;
}
export interface ExecutionStages {
  version: 1;
  stages: StageSpec[];
  finalCheckNodeIds: string[];
  finalReviewNodeId: string;
  handoffNodeId: string;
}
export type Continuation =
  | { kind: 'open' }
  | { kind: 'learning-hold'; holdId: string; stageId: string; boundaryReceiptId: string;
      resultHash: string; createdAt: string; materialHash: string | null };
export interface MaterialGap {
  code: 'missing-context' | 'size-limit' | 'excluded-source' | 'capture-unavailable';
  path: string | null;
  reason: string;
}
export interface SavedSource {
  id: string;
  path: string;
  fileHash: string;
  bytes: number;
  mode: '100644' | '100755';
  role: 'before' | 'after' | 'context';
  chunkHashes?: string[];
  chunkIndexHash?: string;
  lineCount: number;
}
export interface SourceCatalog { version: 1; sources: SavedSource[] }
export interface StageMaterial {
  version: 1;
  kind: 'stage' | 'task';
  runId: string;
  planHash: string;
  taskHash: string;
  contractHash: string;
  stageId: string | null;
  goal: string;
  outcome: string;
  requirementIds: string[];
  beforeHash: string;
  resultHash: string;
  createdAt: string;
  sourceCatalogHash: string;
  implementationReceiptIds: string[];
  checkReceiptIds: string[];
  reviewReceiptIds: string[];
  diffArtifactIds: string[];
  findingsArtifactIds: string[];
  status: 'complete' | 'partial' | 'unavailable';
  gaps: MaterialGap[];
}
export interface SourceAnchor {
  sourceId: string;
  fileHash: string;
  startLine: number;
  endLine: number;
  quote: string;
}
export interface DataOrigin {
  kind: 'runtime-evidence' | 'test-fixture' | 'manual-trace' | 'teaching-example';
  label: string;
  receiptId: string | null;
  artifactId: string | null;
  anchor: SourceAnchor | null;
}
export interface LessonStep {
  id: string;
  title: string;
  caller: string;
  anchors: SourceAnchor[];
  input: string;
  transformations: string[];
  output: string;
  next: string | null;
  purpose: string;
  changeConsequence: string;
  alternatives: string[];
  origin: DataOrigin;
}
export interface LessonMaterial {
  version: 1;
  materialHash: string;
  methodHash: string;
  title: string;
  scope: string;
  steps: LessonStep[];
  questions: Array<{ id: string; text: string; anchors: SourceAnchor[] }>;
  wholeFlow: string;
  takeaways: string[];
  limitations: string[];
}
export interface LearningSnapshot {
  version: 1;
  mode: LearningMode;
  stages: Array<{
    id: string; title: string; outcome: string; requirementIds: string[];
    status: 'pending' | 'running' | 'verified' | 'failed' | 'uncertain';
    checkedResultHash: string | null;
    freshness: SourceFreshness;
    materialHash: string | null;
    materialStatus: 'pending' | 'complete' | 'partial' | 'unavailable';
    lessonHash: string | null;
    lessonStatus: 'absent' | 'generating' | 'ready' | 'failed' | 'uncertain';
    progress: LearningProgress;
    reason: string | null;
  }>;
  finalMaterialHash: string | null;
  activeJob: { id: string; kind: 'lesson' | 'question'; materialHash: string } | null;
}
export interface ControlEnvelope { operationId: string; expectedRevision: number; planHash: string }
export interface ContinueLearning extends ControlEnvelope { holdId: string; disposition: 'continue' | 'defer' }
export interface SetLearningMode extends ControlEnvelope { mode: LearningMode }
export interface GenerateLesson extends ControlEnvelope { materialHash: string }
export interface AskLesson extends GenerateLesson { lessonHash: string; anchor: SourceAnchor; question: string }
export interface SetLearningProgress extends GenerateLesson { progress: LearningProgress }
export interface LearningMaterialResponse {
  id: string;
  material: StageMaterial;
  sources: SavedSource[];
  sourceCatalog?: { version: 2; pageHashes: string[] };
  progress: LearningProgress;
  freshness: { state: SourceFreshness; reason: string | null };
  lessonHash: string | null;
  capabilities: { generateLesson: Capability; askLesson: Capability; setLearningProgress: Capability };
}
export interface LearningSourceResponse {
  sourceId: string;
  fileHash: string;
  text: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  startColumn?: number;
  endColumn?: number;
  partial?: boolean;
  next: { startLine: number; lineCount: number; startColumn?: number } | null;
}
export interface LearningLessonResponse { id: string; lesson: LessonMaterial }
export interface LearningJob {
  id: string;
  kind: 'lesson' | 'question';
  materialHash: string;
  status: 'running' | 'ready' | 'failed' | 'uncertain';
  result: { lessonHash: string } | { answerHash: string } | null;
  error: { code: string; message: string } | null;
}
export interface LessonAnswer {
  version: 1; materialHash: string; lessonHash: string; anchor: SourceAnchor;
  question: string; text: string; anchors: SourceAnchor[]; limitations: string[];
}
export interface LearningCommandResponse {
  jobId: string;
  snapshot: SnapshotV3;
}
/** HTTP 202 after a prepared, durably reserved explicit learning action. */
export interface LearningCommandEnvelope { ok: true; result: LearningCommandResponse }
