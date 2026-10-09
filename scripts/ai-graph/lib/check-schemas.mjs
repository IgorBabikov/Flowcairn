import { z } from 'zod';
import { Hash, Id, RelativePath, Text } from './schema-primitives.mjs';

// Registration and executable authorization are host checks, not schema parsing.
export const CheckIdSchema = Id.max(40).refine((id) => !id.startsWith('check-'), 'Use a check ID without the action prefix');
const Argument = z.string().max(4096).refine((value) => !value.includes('\0'), 'NUL is not an argv value');
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
  outputPaths: z.array(RelativePath).max(128),
  timeoutMs: z.number().int().min(1000).max(1800000),
  maxOutputBytes: z.number().int().min(1024).max(5 * 1024 * 1024),
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
