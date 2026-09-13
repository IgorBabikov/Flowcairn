import { z } from 'zod';
import { GraphError, hashObject } from './io.mjs';
import { SKILL_ROUTES } from './config.mjs';

const empty = z.strictObject({});
const definition = (id, kind, permissions, skills, artifacts, retrySafe = false) =>
  Object.freeze({
    id,
    version: 1,
    kind,
    permissions: Object.freeze(permissions),
    skills: Object.freeze(skills),
    artifacts: Object.freeze(artifacts),
    retrySafe,
    maxAttempts: retrySafe ? 3 : 1,
    inputSchema: empty,
  });
const entries = [
  definition('human-approve', 'gate', [], [], []),
  definition('human-accept', 'gate', [], [], []),
  definition('ai-analyze', 'analysis', ['ai.read'], SKILL_ROUTES.analyze, ['analysis']),
  definition(
    'ai-implement',
    'implementation',
    ['ai.read', 'workspace.source.write'],
    SKILL_ROUTES.implement,
    ['diff', 'changed-files'],
  ),
  definition('ai-review', 'review', ['ai.read'], SKILL_ROUTES.review, ['review-findings']),
  definition('workspace-check', 'checks', [], [], ['test-report'], true),
  ...['graph-tests', 'shared-build', 'typecheck', 'lint', 'tests', 'build'].map((id) =>
    definition(
      `check-${id}`,
      'checks',
      ['workspace.output.write'],
      [],
      [id.includes('build') ? 'build-report' : 'test-report'],
      true,
    ),
  ),
  definition('artifact-handoff', 'handoff', [], [], ['handoff'], true),
];
const registry = new Map(entries.map((action) => [action.id, action]));
export const ACTION_MANIFEST = Object.freeze(
  entries.map(({ inputSchema, ...entry }) => Object.freeze(entry)),
);
export const REGISTRY_HASH = hashObject(ACTION_MANIFEST);
export const REQUIRED_AI_CONTEXT_PATHS = Object.freeze([]);
export const POLICY = Object.freeze({
  version: 2,
  maxNodes: 64,
  maxReplans: 3,
  permissions: ['ai.read', 'workspace.source.write', 'workspace.output.write'],
  externalEffects: 'denied',
  maxReceiptBytes: 262144,
  serialExecution: true,
  requiredAiContextPaths: REQUIRED_AI_CONTEXT_PATHS,
});
export const POLICY_HASH = hashObject(POLICY);

export function resolveAction(id, version = 1, inputs = {}) {
  const action = registry.get(id);
  if (!action || action.version !== version)
    throw new GraphError('UNKNOWN_ACTION', `Неизвестное действие: ${String(id).slice(0, 80)}`);
  const result = action.inputSchema.safeParse(inputs);
  if (!result.success)
    throw new GraphError(
      'INVALID_ACTION_INPUT',
      'Параметры действия не соответствуют trusted registry',
    );
  return action;
}

export function requiredChecks(task) {
  const checks = new Set(task.checks);
  return ['shared-build', 'graph-tests', 'typecheck', 'lint', 'tests', 'build'].filter((id) =>
    checks.has(id),
  );
}

export function isWithin(candidate, scope) {
  const prefix = scope.replace(/\/$/, '');
  return candidate === prefix || candidate.startsWith(`${prefix}/`);
}
export function overlaps(a, b) {
  return isWithin(a, b) || isWithin(b, a);
}
export function pathAllowed(candidate, task) {
  return (
    candidate !== '.flowcairn.json' &&
    task.scope.some((scope) => isWithin(candidate, scope)) &&
    !task.forbiddenPaths.some((scope) => isWithin(candidate, scope))
  );
}

function isSensitivePath(candidate) {
  return candidate.split('/').some((segment) => {
    const name = segment.toLowerCase();
    return (
      name === '.env' ||
      name.startsWith('.env.') ||
      [
        'node_modules',
        'credentials',
        'credentials.json',
        '.npmrc',
        '.pypirc',
        '.netrc',
        'id_rsa',
        'id_ed25519',
      ].includes(name) ||
      /\.(?:pem|key|p12|pfx)$/.test(name) ||
      /(?:^|[._-])secrets?(?:[._-](?:json|ya?ml|toml|txt))?$/.test(name)
    );
  });
}

export function contextPathAllowed(candidate, task) {
  const declared =
    pathAllowed(candidate, task) ||
    task.contextPaths.some((scope) => isWithin(candidate, scope)) ||
    REQUIRED_AI_CONTEXT_PATHS.includes(candidate);
  return (
    declared &&
    !task.forbiddenPaths.some((scope) => isWithin(candidate, scope)) &&
    !isSensitivePath(candidate)
  );
}
