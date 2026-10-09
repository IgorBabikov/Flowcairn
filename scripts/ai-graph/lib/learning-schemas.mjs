import { z } from 'zod';
import { Hash, Id, RelativePath, Text } from './schema-primitives.mjs';
import { LearningModeSchema } from './stage-schemas.mjs';

export const LearningProgressSchema = z.enum(['unread', 'read', 'deferred']);
export const FreshnessSchema = z.enum(['current', 'stale', 'unknown']);
export const ContinuationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('open') }),
  z.strictObject({
    kind: z.literal('learning-hold'), holdId: Hash, stageId: Id,
    boundaryReceiptId: Hash, resultHash: Hash, createdAt: z.iso.datetime(), materialHash: Hash.nullable(),
  }),
]);
export const RunLearningSchema = z.strictObject({
  version: z.literal(1), mode: LearningModeSchema,
  stages: z.record(Id, z.strictObject({
    boundaryReceiptId: Hash, materialHash: Hash.nullable(), materialError: Text.nullable(),
  })),
  eventIds: z.array(Hash).max(200),
  jobs: z.record(Id, Hash),
  progress: z.record(Hash, LearningProgressSchema),
  captures: z.record(Id, z.strictObject({
    before: z.lazy(() => SourceCaptureReferenceSchema),
    after: z.lazy(() => SourceCaptureReferenceSchema).optional(),
  })).optional(),
  finalCapture: z.lazy(() => SourceCaptureReferenceSchema).optional(),
  finalMaterialHash: Hash.optional(),
  failure: z.strictObject({ stageId: Id.nullable(), code: z.string().min(1).max(80), reason: Text }).optional(),
});
export const MaterialGapSchema = z.strictObject({
  code: z.enum(['missing-context', 'size-limit', 'excluded-source', 'capture-unavailable']),
  path: RelativePath.nullable(), reason: Text,
});
export const SourceCaptureReferenceSchema = z.strictObject({
  sourceHash: Hash, sourceCatalogHash: Hash, gaps: z.array(MaterialGapSchema),
});
export const SourceChunkSchema = z.strictObject({
  version: z.literal(1),
  text: z.string().min(1).max(16 * 1024)
    .refine((text) => Buffer.byteLength(text, 'utf8') <= 16 * 1024 && Buffer.from(text, 'utf8').toString('utf8') === text,
      'Chunk must contain at most 16 KiB of exact UTF-8'),
});
export const SavedSourceSchema = z.strictObject({
  id: Id, path: RelativePath, fileHash: Hash, bytes: z.number().int().min(0),
  mode: z.enum(['100644', '100755']), role: z.enum(['before', 'after', 'context']),
  chunkHashes: z.array(Hash).optional(), chunkIndexHash: Hash.optional(), lineCount: z.number().int().min(0),
}).refine((source) => (source.chunkHashes !== undefined) !== (source.chunkIndexHash !== undefined), 'Exactly one chunk reference form is required');
export const SourceCatalogSchema = z.strictObject({
  version: z.literal(1), sources: z.array(SavedSourceSchema),
});
export const StageMaterialSchema = z.strictObject({
  version: z.literal(1), kind: z.enum(['stage', 'task']),
  runId: Id, planHash: Hash, taskHash: Hash, contractHash: Hash,
  stageId: Id.nullable(), goal: Text, outcome: Text, requirementIds: z.array(Id),
  beforeHash: Hash, resultHash: Hash, createdAt: z.iso.datetime(), sourceCatalogHash: Hash,
  implementationReceiptIds: z.array(Hash), checkReceiptIds: z.array(Hash),
  reviewReceiptIds: z.array(Hash), diffArtifactIds: z.array(Hash),
  findingsArtifactIds: z.array(Hash), status: z.enum(['complete', 'partial', 'unavailable']),
  gaps: z.array(MaterialGapSchema),
});
export const SourceAnchorSchema = z.strictObject({
  sourceId: Id, fileHash: Hash, startLine: z.number().int().min(1), endLine: z.number().int().min(1),
  quote: z.string().min(1).max(8192).refine((quote) => Buffer.byteLength(quote, 'utf8') <= 8192, 'Quote exceeds 8 KiB'),
}).refine(({ startLine, endLine }) => endLine >= startLine, { message: 'Invalid line range', path: ['endLine'] });
export const DataOriginSchema = z.strictObject({
  kind: z.enum(['runtime-evidence', 'test-fixture', 'manual-trace', 'teaching-example']),
  label: Text, receiptId: Hash.nullable(), artifactId: Hash.nullable(), anchor: SourceAnchorSchema.nullable(),
});
export const LessonStepSchema = z.strictObject({
  id: Id, title: z.string().min(1).max(160), caller: Text, anchors: z.array(SourceAnchorSchema).min(1).max(20),
  input: Text, transformations: z.array(Text).min(1).max(32), output: Text, next: Text.nullable(),
  purpose: Text, changeConsequence: Text, alternatives: z.array(Text).max(20), origin: DataOriginSchema,
});
export const LessonMaterialSchema = z.strictObject({
  version: z.literal(1), materialHash: Hash, methodHash: Hash, title: z.string().min(1).max(160),
  scope: Text, steps: z.array(LessonStepSchema).min(1).max(32),
  questions: z.array(z.strictObject({ id: Id, text: Text, anchors: z.array(SourceAnchorSchema).max(20) })).max(10),
  wholeFlow: Text, takeaways: z.array(Text).max(20), limitations: z.array(Text).max(32),
}).refine((lesson) => Buffer.byteLength(JSON.stringify(lesson), 'utf8') <= 64 * 1024, 'Lesson exceeds 64 KiB');
export const LearningSnapshotSchema = z.strictObject({
  version: z.literal(1), mode: LearningModeSchema,
  stages: z.array(z.strictObject({
    id: Id, title: z.string().min(1).max(160), outcome: Text, requirementIds: z.array(Id),
    status: z.enum(['pending', 'running', 'verified', 'failed', 'uncertain']), checkedResultHash: Hash.nullable(),
    freshness: FreshnessSchema, materialHash: Hash.nullable(),
    materialStatus: z.enum(['pending', 'complete', 'partial', 'unavailable']), lessonHash: Hash.nullable(),
    lessonStatus: z.enum(['absent', 'generating', 'ready', 'failed', 'uncertain']),
    progress: LearningProgressSchema, reason: Text.nullable(),
  })),
  finalMaterialHash: Hash.nullable(),
  activeJob: z.strictObject({ id: Id, kind: z.enum(['lesson', 'question']), materialHash: Hash }).nullable(),
});
export const ControlEnvelopeSchema = z.strictObject({
  operationId: Id, expectedRevision: z.number().int().min(0), planHash: Hash,
});
export const ContinueLearningSchema = ControlEnvelopeSchema.extend({ holdId: Hash, disposition: z.enum(['continue', 'defer']) });
export const SetLearningModeSchema = ControlEnvelopeSchema.extend({ mode: LearningModeSchema });
export const GenerateLessonSchema = ControlEnvelopeSchema.extend({ materialHash: Hash });
export const AskLessonSchema = GenerateLessonSchema.extend({ lessonHash: Hash, anchor: SourceAnchorSchema, question: Text });
export const SetLearningProgressSchema = GenerateLessonSchema.extend({ progress: LearningProgressSchema });
export const LearningJobSchema = z.strictObject({
  id: Id, kind: z.enum(['lesson', 'question']), materialHash: Hash,
  status: z.enum(['running', 'ready', 'failed', 'uncertain']),
  result: z.union([z.strictObject({ lessonHash: Hash }), z.strictObject({ answerHash: Hash })]).nullable(),
  error: z.strictObject({ code: z.string().min(1).max(80), message: Text }).nullable(),
});
export const LessonAnswerSchema = z.strictObject({
  version: z.literal(1), materialHash: Hash, lessonHash: Hash, anchor: SourceAnchorSchema,
  question: Text, text: z.string().min(1).max(16000), anchors: z.array(SourceAnchorSchema).max(32), limitations: z.array(Text).max(32),
});
const CapabilitySchema = z.strictObject({ label: z.string().max(160).optional(), allowed: z.boolean(), reason: Text.nullable() });
export const LearningMaterialResponseSchema = z.strictObject({
  id: Hash, material: StageMaterialSchema, sources: z.array(SavedSourceSchema),
  sourceCatalog: z.strictObject({ version: z.literal(2), pageHashes: z.array(Hash) }).optional(),
  progress: LearningProgressSchema,
  freshness: z.strictObject({ state: FreshnessSchema, reason: Text.nullable() }), lessonHash: Hash.nullable(),
  capabilities: z.strictObject({ generateLesson: CapabilitySchema, askLesson: CapabilitySchema, setLearningProgress: CapabilitySchema }),
});
export const LearningSourceResponseSchema = z.strictObject({
  sourceId: Id, fileHash: Hash, text: z.string().max(65536),
  startLine: z.number().int().min(1), endLine: z.number().int().min(0), totalLines: z.number().int().min(0),
  startColumn: z.number().int().nonnegative().optional(), endColumn: z.number().int().nonnegative().optional(), partial: z.boolean().optional(),
  next: z.strictObject({ startLine: z.number().int().min(1), lineCount: z.number().int().min(1).max(200), startColumn: z.number().int().nonnegative().optional() }).nullable(),
});
export const LearningLessonResponseSchema = z.strictObject({ id: Hash, lesson: LessonMaterialSchema });
