import { z } from 'zod';
import { Id, Text } from './schema-primitives.mjs';

export const LearningModeSchema = z.enum(['after-stage', 'after-task']);
export const StageSpecSchema = z.strictObject({
  id: Id,
  title: z.string().min(1).max(160),
  outcome: Text,
  implementationNodeIds: z.array(Id).length(1),
  requirementIds: z.array(Id),
  scopeCheckNodeId: Id,
  // Missing verifiers remain readable; execution capability must deny this plan.
  checkNodeIds: z.array(Id).max(6),
  boundaryNodeId: Id,
});
export const ExecutionStagesSchema = z.strictObject({
  version: z.literal(1),
  stages: z.array(StageSpecSchema).min(1),
  finalCheckNodeIds: z.array(Id).max(6),
  finalReviewNodeId: Id,
  handoffNodeId: Id,
});
