import { z } from 'zod';
import { Hash, Id, RelativePath, Text } from './schema-primitives.mjs';

export const CoverageBindingSchema = z.strictObject({
  runId: Id, planHash: Hash, taskHash: Hash, contractHash: Hash, sourceCatalogHash: Hash, beforeHash: Hash, resultHash: Hash,
});
export const CoverageSourceSchema = z.strictObject({
  sourceId: Id, fileHash: Hash,
  range: z.strictObject({ startLine: z.number().int().positive(), endLine: z.number().int().positive() })
    .refine(value => value.endLine >= value.startLine).nullable(),
});
export const CoverageEntrySchema = z.strictObject({
  id: Id, kind: z.enum(['change', 'context', 'gap']), path: RelativePath.nullable(),
  change: z.enum(['added', 'removed', 'modified', 'metadata', 'unknown', 'unchanged']).nullable(),
  precision: z.enum(['conservative', 'exact', 'unavailable']),
  before: CoverageSourceSchema.nullable(), after: CoverageSourceSchema.nullable(), reason: Text.nullable(),
}).refine(value => value.kind === 'gap'
  ? value.change === null && value.precision === 'unavailable' && value.before === null && value.after === null && value.reason !== null
  : value.path !== null && (value.kind === 'context' ? value.change === 'unchanged' && value.after !== null
    : value.change !== null && value.change !== 'unchanged'));
export const CoveragePageSchema = z.strictObject({
  version: z.literal(1), entries: z.array(CoverageEntrySchema).min(1).max(64), next: Hash.nullable(),
}).refine(value => Buffer.byteLength(JSON.stringify(value)) <= 64 * 1024, 'Coverage page exceeds 64 KiB');
export const CoverageInventorySchema = z.strictObject({
  version: z.literal(1), binding: CoverageBindingSchema, algorithm: z.literal('line-prefix-suffix-v1'),
  entryCount: z.number().int().nonnegative(), pageCount: z.number().int().nonnegative(), firstPageHash: Hash.nullable(),
});
export const CoverageLinkSchema = z.strictObject({
  entryId: Id, status: z.enum(['unlinked', 'partial', 'linked']), stepIds: z.array(Id).max(32),
});
export const CoverageResponseSchema = z.strictObject({
  id: Hash, inventory: CoverageInventorySchema, pages: z.array(CoveragePageSchema),
  lessonHash: Hash.nullable(), linking: z.enum(['absent', 'validated', 'unavailable']),
  links: z.array(CoverageLinkSchema),
});
