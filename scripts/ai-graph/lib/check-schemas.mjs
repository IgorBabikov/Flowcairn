import { z } from 'zod';
import { Hash, Id, RelativePath, Text } from './schema-primitives.mjs';

// Registration and executable authorization are host checks, not schema parsing.
export const CheckIdSchema = Id.max(40).refine((id) => !id.startsWith('check-'), 'Use a check ID without the action prefix');
const Argument = z.string().max(4096).refine((value) => !value.includes('\0'), 'NUL is not an argv value');
export const VerificationReportSpecSchema = z.strictObject({
  version: z.literal(1),
  format: z.enum(['flowcairn-node-test/v1', 'flowcairn-xctest/v1', 'flowcairn-android-node/v1', 'playwright-json', 'jest-json', 'vitest-json', 'xcresult-summary-json']),
  path: RelativePath,
  android: z.strictObject({ sourcePaths: z.array(RelativePath).min(1).max(4096)
    .refine(values => new Set(values).size === values.length, 'Duplicate native source path') }).optional(),
  // Optional owner-pinned native material contract. Historical report hashes stay unchanged.
  xctest: z.strictObject({
    artifactRoot: RelativePath,
    resultName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.xcresult$/),
    applicationRelativePath: RelativePath.refine(value => value.endsWith('.app'), 'Expected an iOS .app bundle'),
    algorithm: z.literal('sha256-tree-v1'),
  }).optional(),
  requiredScenarios: z.array(z.string().min(1).max(1024)).min(1).max(128)
    .refine((values) => new Set(values).size === values.length, 'Duplicate required scenarios'),
}).superRefine((spec, context) => {
  if ((spec.format === 'flowcairn-android-node/v1') !== Boolean(spec.android))
    context.addIssue({ code: 'custom', path: ['android'], message: 'Android format requires its owner-pinned exact compilation source set.' });
  if (spec.xctest && spec.format !== 'flowcairn-xctest/v1')
    context.addIssue({ code: 'custom', path: ['xctest'], message: 'XCTest material belongs only to the native XCTest report.' });
});
export const RegisteredCheckSchema = z.strictObject({
  id: CheckIdSchema,
  title: z.string().min(1).max(160),
  purpose: Text,
  command: z.strictObject({
    executable: Argument.min(1),
    argv: z.array(Argument).max(64),
    cwd: z.union([z.literal('.'), RelativePath]),
  }),
  inputPaths: z.array(RelativePath).max(96),
  // Owner-pinned tool/dependency identities; never commands or AI-readable source roots.
  identityFiles: z.array(Argument.min(1)).max(16).refine((values) => new Set(values).size === values.length).optional(),
  outputPaths: z.array(RelativePath).max(128),
  timeoutMs: z.number().int().min(1000).max(1800000),
  maxOutputBytes: z.number().int().min(1024).max(5 * 1024 * 1024),
  // No default: historical registrations retain exactly their previous bytes/hash.
  report: VerificationReportSpecSchema.optional(),
}).superRefine((check, context) => {
  const root = check.report?.xctest?.artifactRoot;
  if (root && !check.outputPaths.some(output => root === output || root.startsWith(`${output}/`)))
    context.addIssue({ code: 'custom', path: ['report', 'xctest', 'artifactRoot'], message: 'Native material root must be a registered output.' });
});
export const CheckProfileSchema = z.strictObject({
  version: z.literal(1),
  requiredCheckIds: z.array(CheckIdSchema).max(6),
  definitions: z.array(RegisteredCheckSchema).max(6),
  environment: z.array(z.strictObject({
    name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,79}$/),
    value: Argument,
  })).max(32),
}).superRefine((profile, context) => {
  const ids = profile.definitions.map((definition) => definition.id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', path: ['definitions'], message: 'Duplicate check IDs' });
  if (new Set(profile.requiredCheckIds).size !== profile.requiredCheckIds.length || profile.requiredCheckIds.some((id) => !ids.includes(id)))
    context.addIssue({ code: 'custom', path: ['requiredCheckIds'], message: 'Required checks must uniquely reference registered definitions' });
  if (new Set(profile.environment.map(({ name }) => name)).size !== profile.environment.length)
    context.addIssue({ code: 'custom', path: ['environment'], message: 'Duplicate environment names' });
});
export const BoundCheckSchema = z.strictObject({
  id: CheckIdSchema,
  definitionHash: Hash,
  executableHash: Hash,
  invocationHash: Hash,
  inputManifestHash: Hash,
  toolchainHash: Hash,
});
export const PlanChecksSchema = z.strictObject({
  version: z.literal(1),
  profileHash: Hash,
  definitions: z.array(RegisteredCheckSchema).max(6),
  bindings: z.array(BoundCheckSchema).max(6),
});
