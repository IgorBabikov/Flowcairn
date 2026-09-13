import { z } from 'zod';
import { GraphError } from './io.mjs';

export function assertJsonBounds(value, maxEntries = 20000) {
  const queue = [[value, 0]];
  let entries = 0;
  while (queue.length) {
    const [item, depth] = queue.pop();
    if (++entries > maxEntries || depth > 24)
      throw new GraphError('INPUT_LIMIT', 'Превышен предел размера или вложенности входа');
    if (item && typeof item === 'object') {
      if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item)))
        throw new GraphError('INVALID_INPUT', 'Ожидается JSON');
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(item))) {
        if (descriptor.get || descriptor.set)
          throw new GraphError('INVALID_INPUT', 'Accessors недопустимы');
        queue.push([descriptor.value, depth + 1]);
      }
    } else if (
      typeof item === 'function' ||
      typeof item === 'symbol' ||
      typeof item === 'bigint' ||
      (typeof item === 'number' && !Number.isFinite(item))
    ) {
      throw new GraphError('INVALID_INPUT', 'Ожидается JSON');
    }
  }
}

export const SCHEMA_VERSION = 2;
export const Id = z.string().regex(/^[a-z][a-z0-9-]{1,79}$/);
export const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const Text = z.string().min(1).max(4000);
export const RelativePath = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => {
    if (
      value.includes('\\') ||
      value.includes('\0') ||
      value.startsWith('/') ||
      /^[a-z]:/i.test(value)
    )
      return false;
    return !value
      .replace(/\/$/, '')
      .split('/')
      .some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          part.toLowerCase() === '.git' ||
          part.toLowerCase() === '.ai-orchestrator',
      );
  }, 'Expected a contained repository-relative path');
export const Permission = z.enum(['ai.read', 'workspace.source.write', 'workspace.output.write']);
export const Status = z.enum([
  'pending',
  'ready',
  'running',
  'waiting-for-human',
  'passed',
  'failed',
  'uncertain',
  'stale',
]);
export const ArtifactKind = z.enum([
  'analysis',
  'plan',
  'diff',
  'changed-files',
  'test-report',
  'build-report',
  'review-findings',
  'screenshot',
  'generated-doc',
  'handoff',
]);
export const SkillManifestSchema = z.strictObject({ id: Id, path: RelativePath, hash: Hash });
export const TaskInputSchema = z.strictObject({
  id: z.string().regex(/^[A-Z][A-Z0-9-]{2,40}$/),
  goal: Text,
  instructions: z.string().min(1).max(16000),
  scope: z.array(RelativePath).min(1).max(32),
  contextPaths: z.array(RelativePath).max(32).default([]),
  forbiddenPaths: z.array(RelativePath).max(32).default([]),
  includeUntracked: z.array(RelativePath).max(64).default([]),
  acceptance: z.array(Text).min(1).max(20),
  checks: z
    .array(z.enum(['graph-tests', 'typecheck', 'lint', 'tests', 'build', 'shared-build']))
    .max(6)
    .default([]),
  resources: z.array(Id).max(16).default([]),
  limits: z
    .strictObject({
      maxAttempts: z.number().int().min(1).max(3).default(2),
      maxReplans: z.number().int().min(0).max(3).default(2),
      timeoutMs: z.number().int().min(1000).max(1800000).default(600000),
    })
    .default({ maxAttempts: 2, maxReplans: 2, timeoutMs: 600000 }),
});
export const TaskSpecSchema = TaskInputSchema.extend({
  schemaVersion: z.literal(2),
  sourceHash: Hash,
});
export const SuccessContractSchema = z.strictObject({
  kind: z.enum(['gate', 'analysis', 'implementation', 'checks', 'review', 'handoff']),
  requiredArtifacts: z.array(ArtifactKind).max(10),
});
export const NodeDefinitionSchema = z.strictObject({
  id: Id,
  title: z.string().min(1).max(160),
  outcome: Text,
  needs: z.array(Id).max(64),
  action: z.strictObject({
    id: Id,
    version: z.literal(1),
    inputs: z.record(z.string().max(80), z.json()),
  }),
  success: SuccessContractSchema,
  permissions: z.array(Permission).max(3),
  skills: z.array(Id).max(20),
  resources: z.strictObject({
    reads: z.array(RelativePath).max(96),
    writes: z.array(RelativePath).max(64),
    exclusive: z.array(Id).max(16),
  }),
  retry: z.strictObject({
    maxAttempts: z.number().int().min(1).max(3),
    backoffMs: z.number().int().min(0).max(60000),
  }),
});
export const GraphPlanSchema = z.strictObject({
  stage: z.enum(['planning', 'execution']).optional(),
  contextHash: Hash.optional(),
  schemaVersion: z.literal(2),
  taskHash: Hash,
  version: z.number().int().min(1).max(100),
  parentPlanHash: Hash.nullable(),
  sourceHash: Hash,
  runtimeHash: Hash,
  registryHash: Hash,
  policyHash: Hash,
  skills: z.array(SkillManifestSchema).max(20),
  nodes: z.array(NodeDefinitionSchema).min(2).max(64),
});
export const PlanningEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(2),
  taskHash: Hash,
  sourceHash: Hash,
  runtimeHash: Hash,
  registryHash: Hash,
  policyHash: Hash,
  skills: z.array(SkillManifestSchema).max(20),
  readPaths: z.array(RelativePath).max(96),
  provider: z.enum(['codex', 'openai']),
  timeoutMs: z.number().int().min(1000).max(1800000),
});
export const AIResultSchema = z.strictObject({
  summary: z.string().min(1).max(3000),
  verdict: z.enum(['pass', 'fail', 'uncertain']),
  skillsUsed: z.array(Id).max(20),
  reviewEvidenceHash: Hash.nullable().default(null),
  findings: z
    .array(
      z.strictObject({
        severity: z.enum(['blocking', 'warning', 'info']),
        message: Text,
        path: RelativePath.nullable(),
      }),
    )
    .max(30),
  changedFiles: z.array(RelativePath).max(100),
  edits: z
    .array(
      z.strictObject({
        path: RelativePath,
        previousHash: Hash.nullable(),
        content: z
          .string()
          .max(128 * 1024)
          .nullable(),
        executable: z.boolean(),
      }),
    )
    .max(100)
    .default([]),
  plan: z.array(z.strictObject({ outcome: Text, paths: z.array(RelativePath).max(32) })).max(20),
});
export const AIReviewResultSchema = AIResultSchema.extend({ reviewEvidenceHash: Hash });
export const CheckResultSchema = z.strictObject({
  id: Id,
  passed: z.boolean(),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().min(0),
  summary: z.string().max(2000),
  inputHash: Hash,
});
export const ArtifactSchema = z.strictObject({
  schemaVersion: z.literal(2),
  kind: ArtifactKind,
  title: z.string().min(1).max(160),
  mediaType: z.enum([
    'application/json',
    'text/plain',
    'text/markdown',
    'text/x-diff',
    'image/png',
  ]),
  content: z.string().max(5 * 1024 * 1024),
});
export const ReceiptSchema = z.strictObject({
  schemaVersion: z.literal(2),
  runId: Id,
  nodeId: Id,
  attemptId: Id,
  attempt: z.number().int().min(1),
  phase: z.enum(['started', 'finished', 'gate', 'recovery', 'planning']),
  actionId: Id,
  actionVersion: z.number().int().min(1),
  planVersion: z.number().int().min(1),
  planHash: Hash,
  taskHash: Hash,
  sourceHash: Hash,
  runtimeHash: Hash,
  instructionsHash: Hash,
  skills: z.array(SkillManifestSchema).max(20),
  permissions: z.array(Permission).max(3),
  grantedPermissions: z.array(Permission).max(3),
  termination: z
    .strictObject({
      stopped: z.boolean(),
      uncertain: z.boolean(),
      timedOut: z.boolean(),
      outputLimit: z.boolean(),
      signal: z.string().max(40).nullable(),
      ticketHash: Hash.nullable(),
      execution: z.json().nullable(),
    })
    .nullable(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  durationMs: z.number().min(0).nullable(),
  exitCode: z.number().int().nullable(),
  verdict: z.enum(['pass', 'fail', 'uncertain', 'started']),
  checks: z.array(CheckResultSchema).max(20),
  artifacts: z.array(Hash).max(30),
  changedFiles: z.array(RelativePath).max(200),
  failureReason: z.string().max(3000).nullable(),
  reviewEvidenceHash: Hash.optional(),
  beforeFingerprint: Hash,
  afterFingerprint: Hash.nullable(),
  actor: z.string().min(1).max(120),
  operationId: Id,
  previousReceipt: Hash.nullable(),
});
const FingerprintSchema = z.strictObject({
  hash: Hash,
  files: z
    .array(
      z.strictObject({
        path: RelativePath,
        hash: Hash,
        mode: z.enum(['100644', '100755']),
        size: z.number().int().min(0),
      }),
    )
    .max(20000),
  git: z.strictObject({
    head: z
      .string()
      .regex(/^[a-f0-9]{40,64}$/)
      .nullable(),
    indexHash: Hash,
  }),
});
const BindingSchema = z.strictObject({
  worktree: z.string().max(4096),
  taskId: z.string().max(80),
  attemptId: z.number().int().min(1),
  leaseId: z.string().max(120),
  sourceHash: Hash,
  runId: Id.optional(),
  owner: z.string().max(120).optional(),
});
export const RunStateSchema = z.strictObject({
  schemaVersion: z.literal(2),
  runId: Id,
  revision: z.number().int().min(0),
  taskHash: Hash,
  planHash: Hash,
  envelopeHash: Hash,
  sourceHash: Hash,
  sourceBundle: z.string().max(4096),
  planVersion: z.number().int().min(1),
  maxReplans: z.number().int().min(0).max(3),
  planningTransitions: z.number().int().min(0).max(1).optional(),
  supersedesRunId: Id.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  status: Status,
  finalDisposition: z.enum(['accepted', 'rejected', 'superseded']).nullable(),
  nodes: z.record(
    Id,
    z.strictObject({
      status: Status,
      attempts: z.number().int().min(0).max(3),
      receipts: z.array(Hash).max(20),
      artifacts: z.array(Hash).max(50),
      checks: z.array(CheckResultSchema).max(20),
      changedFiles: z.array(RelativePath).max(200),
      reason: z.string().max(12000).nullable(),
      startedAt: z.iso.datetime().nullable(),
      finishedAt: z.iso.datetime().nullable(),
      durationMs: z.number().min(0).nullable(),
      retrySafe: z.boolean(),
      process: z.json().optional(),
    }),
  ),
  toolchain: z
    .strictObject({
      dependencyPaths: z.array(RelativePath).max(100),
      readRoots: z.array(z.string().max(4096)).max(100),
      hash: Hash,
    })
    .nullable()
    .optional(),
  permissions: z.array(Permission).max(3),
  binding: BindingSchema.nullable(),
  pendingBinding: BindingSchema.nullable().optional(),
  workspaceFingerprint: FingerprintSchema.nullable(),
  initialFingerprint: FingerprintSchema.nullable(),
  activeOperation: z
    .strictObject({
      id: Id,
      digest: Hash,
      ownerPid: z.number().int().min(1),
      ownerStart: Hash.nullable(),
      nodeId: Id.nullable(),
      process: z.json().nullable(),
      startedAt: z.iso.datetime(),
    })
    .nullable(),
  operations: z.record(
    Id,
    z.strictObject({
      digest: Hash,
      status: z.enum(['running', 'finished', 'failed', 'creating']),
      resultRunId: Id.optional(),
      preparationHash: Hash.optional(),
    }),
  ),
  planningArtifacts: z.array(Hash).max(50),
  actor: z.string().min(1).max(120),
  intakeHash: Hash,
  naturalIntakeHash: Hash.optional(),
  createOperationId: Id,
  setupPending: z.boolean(),
  stopRequested: z.boolean().optional(),
  recovered: z.boolean().optional(),
  failureReason: z.string().max(12000).optional(),
});
export const ControlRequestSchema = z.strictObject({
  operationId: Id,
  expectedRevision: z.number().int().min(0),
  planHash: Hash,
  nodeId: Id.optional(),
  decision: z.enum(['approve', 'reject', 'accept']).optional(),
  permissions: z.array(Permission).max(3).optional(),
  challenge: z.string().max(160).optional(),
  draft: z.unknown().optional(),
  reason: z.string().min(1).max(1000).optional(),
});

/** @typedef {z.infer<typeof TaskInputSchema>} TaskInput */
/** @typedef {z.infer<typeof TaskSpecSchema>} TaskSpec */
/** @typedef {z.infer<typeof GraphPlanSchema>} GraphPlan */
/** @typedef {z.infer<typeof NodeDefinitionSchema>} NodeDefinition */
/** @typedef {z.infer<typeof ReceiptSchema>} Receipt */
/** @typedef {z.infer<typeof ControlRequestSchema>} ControlRequest */
/** @typedef {z.infer<typeof AIResultSchema>} AIResult */

// Planner output is data: actions, commands, permissions and Skills are deliberately absent.
export const PlanningStepSchema = z.strictObject({
  id: Id,
  title: z.string().min(1).max(160),
  outcome: Text,
  needs: z.array(Id).max(12),
  paths: z.array(RelativePath).min(1).max(32),
});
export const AIPlanningResultSchema = AIResultSchema.extend({
  steps: z.array(PlanningStepSchema).max(12),
});
export const NaturalIntakeSchema = z.strictObject({
  prompt: z.string().trim().min(3).max(16000),
  operationId: Id,
  contextHash: Hash,
  scope: z.array(RelativePath).min(1).max(32).optional(),
  snapshot: z.literal(true).optional(),
  snapshotHash: Hash.optional(),
  includeUntracked: z.array(RelativePath).max(64).optional(),
});
