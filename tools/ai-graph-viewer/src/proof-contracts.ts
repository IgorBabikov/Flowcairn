export interface RequirementVerification {
  method: 'check' | 'source-review' | 'human';
  checkIds: string[];
  criterion: string;
  paths: string[];
}

export interface TaskRequirement {
  id: string;
  title: string;
  mandatory: boolean;
  origin: 'acceptance' | 'analysis';
  verification: RequirementVerification;
  workIds: string[];
}

export interface TaskContract {
  version: 1;
  goal: string;
  instructionsHash: string;
  requirements: TaskRequirement[];
  optionalImprovements: string[];
  constraints: string[];
  assumptions: string[];
  unknowns: string[];
  scope: string[];
  forbiddenPaths: string[];
  rigor: { level: 'light' | 'standard' | 'high'; reasons: string[] };
}

export interface RequirementProof extends Omit<TaskRequirement, 'origin' | 'workIds'> {
  status: 'proven' | 'unproven' | 'stale' | 'failed' | 'blocked';
  reason: string;
  workNodeIds: string[];
  artifactIds: string[];
  evidenceIds: string[];
  findingIds: string[];
}

export interface ProofEvidence {
  id: string;
  requirementIds: string[];
  nodeId: string | null;
  runId: string;
  receiptId: string | null;
  artifactIds: string[];
  method: string;
  summary: string;
  status: 'passed' | 'failed' | 'uncertain' | 'unavailable';
  freshness: 'current' | 'stale';
  checkedAt: string | null;
  resultHash: string | null;
  staleReason: string | null;
}

export interface ProofFinding {
  id: string;
  requirementIds: string[];
  blocking: boolean;
  status: 'open' | 'resolved';
  title: string;
  repairNodeIds: string[];
}

export interface ProofUsage {
  aiCalls: number;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  tokensPerProvenRequirement: number | null;
  costPerProvenRequirement: number | null;
  reportedCalls: number;
  unknownCalls: number;
  contextBytes: number | null;
  durationMs: number;
  repairCalls: number;
  verificationCalls: number;
  byRequirement: Array<{ requirementId: string; aiCalls: number; inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; costUsd: number | null }>;
}

export interface CompletionCertificate {
  version: 1;
  id: string;
  taskId: string;
  goal: string;
  contractHash: string;
  resultHash: string;
  requirementIds: string[];
  evidenceIds: string[];
  receiptIds: string[];
  issuedAt: string | null;
  limitations?: string[];
}

export interface TaskProof {
  changedFiles?: string[];
  resultHash: string;
  acceptance: { allowed: boolean; reason: string | null; challenge: string | null };
  contract: TaskContract | null;
  requirements: RequirementProof[];
  evidence: ProofEvidence[];
  findings: ProofFinding[];
  coverage: { required: number; proven: number };
  status: 'PROVEN' | 'UNPROVEN' | 'STALE' | 'FAILED' | 'BLOCKED' | 'RUNNING';
  blockers: string[];
  certificate: CompletionCertificate | null;
  usage: ProofUsage;
}
