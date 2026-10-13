import { z } from 'zod';
import { GraphError, hashObject } from './io.mjs';
import { CheckIdSchema } from './check-schemas.mjs';
import { RelativePath } from './schema-primitives.mjs';

// Bundled recipes are data. They neither install a tool nor authorize a command.
export const DEVELOPMENT_CAPABILITIES = Object.freeze([
  { id: 'browser-scenario', domain: 'frontend', evidence: 'browser assertions and report' },
  { id: 'component-test', domain: 'frontend', evidence: 'component assertions and report' },
  { id: 'api-integration', domain: 'backend', evidence: 'request, real dependency, response and negative cases' },
  { id: 'api-contract', domain: 'backend', evidence: 'versioned API schema and executable assertions' },
  { id: 'mobile-ios-build', domain: 'mobile', evidence: 'native iOS build and artifact identity' },
  { id: 'mobile-ios-scenario', domain: 'mobile', evidence: 'iOS simulator/device scenario and report' },
  { id: 'mobile-android-build', domain: 'mobile', evidence: 'native Android build and artifact identity' },
  { id: 'mobile-android-scenario', domain: 'mobile', evidence: 'Android emulator/device scenario and report' },
  { id: 'mobile-component-test', domain: 'mobile', evidence: 'existing framework widget/component assertions' },
  { id: 'security-check', domain: 'engineering', evidence: 'scoped reproducible security finding checks' },
  { id: 'performance-check', domain: 'engineering', evidence: 'measured criterion and environment identity' },
]);
export const DEVELOPMENT_TASK_KINDS = Object.freeze(['static', 'behavior', 'bugfix', 'refactor', 'performance', 'design']);
export const DEVELOPMENT_METHODS = Object.freeze([
  { id: 'intent', skillId: 'core-analysis', source: 'flowcairn', inputs: ['original-request', 'authorized-scope'], outputs: ['requirements', 'constraints', 'material-unknowns'] },
  { id: 'context', skillId: 'project-context', source: 'flowcairn', inputs: ['scope', 'source-identity'], outputs: ['owners', 'consumers', 'source-bound-facts'] },
  { id: 'contract', skillId: 'core-planning', source: 'flowcairn', inputs: ['original-criteria', 'registered-verifiers'], outputs: ['requirement-work-verifier-links'] },
  { id: 'decomposition', skillId: 'workflow-planning', source: 'flowcairn-original', inputs: ['contract', 'interfaces'], outputs: ['observable-work', 'declared-dependencies', 'plan-findings'] },
  { id: 'reuse', skillId: 'workflow-reuse', source: 'flowcairn-original', inputs: ['manifests', 'missing-capability'], outputs: ['compatible-reuse-decision', 'license-and-source-gaps'] },
  { id: 'implementation', skillId: 'clean-implementation', source: 'flowcairn', inputs: ['authorized-work', 'current-source'], outputs: ['broker-proposal'] },
  { id: 'verification', skillId: 'workflow-verification', source: 'flowcairn-original', inputs: ['current-artifact', 'registered-checks'], outputs: ['scenario-evidence', 'explicit-unverified-requirements'] },
  { id: 'test-quality', skillId: 'workflow-test-quality', source: 'pinned-mattpocock-tdd-and-dotnet-test-gap', inputs: ['original-criteria', 'test-policy', 'authorized-scope', 'source-and-assertions'], outputs: ['behavior-assertions-or-scoped-gap-findings'] },
  { id: 'review', skillId: 'code-review', source: 'existing-pinned-provenance', inputs: ['complete-review-evidence', 'contract'], outputs: ['findings', 'requirement-assessments'] },
  { id: 'diagnosis', skillId: 'workflow-diagnosis', source: 'flowcairn-original', inputs: ['original-criterion', 'failed-scenario', 'current-source'], outputs: ['falsifiable-cause', 'scoped-correction-or-explicit-blocker'] },
  { id: 'handoff', skillId: 'delivery-pipeline', source: 'flowcairn', inputs: ['executor-proof', 'current-diff'], outputs: ['local-result', 'limits', 'next-action'] },
]);
const capabilityIds = DEVELOPMENT_CAPABILITIES.map(({ id }) => id);
const uniqueArray = (schema) => z.array(schema).refine((items) => new Set(items).size === items.length, 'Duplicate routing values');

/** Owner-configured metadata can select pinned Skills, never executable paths. */
export const DevelopmentWorkflowSchema = z.strictObject({
  version: z.union([z.literal(1), z.literal(2)]),
  capabilities: uniqueArray(z.strictObject({
    id: z.enum(capabilityIds), checkIds: uniqueArray(CheckIdSchema).min(1),
    scope: uniqueArray(z.union([z.literal('.'), RelativePath])).min(1).max(8).optional(),
  })).refine((items) => new Set(items.map(({ id }) => id)).size === items.length, 'Duplicate capability IDs').optional(),
  specialists: z.array(z.strictObject({
    skillId: z.string().regex(/^project-[a-z][a-z0-9-]{1,63}$/),
    domains: uniqueArray(z.enum(['engineering', 'frontend', 'backend', 'mobile'])).min(1),
    frameworks: uniqueArray(z.string().regex(/^[a-z][a-z0-9-]{1,63}$/)).min(1),
    majors: uniqueArray(z.number().int().min(0)).min(1),
    taskKinds: uniqueArray(z.enum(DEVELOPMENT_TASK_KINDS)).min(1),
    requires: uniqueArray(z.enum(capabilityIds)),
  })).refine((items) => new Set(items.map(({ skillId }) => skillId)).size === items.length, 'Duplicate specialist IDs').optional(),
});

export function validateDevelopmentWorkflow(input, { projectSkills = [], checks = [] } = {}) {
  const policy = DevelopmentWorkflowSchema.parse(input);
  if ((policy.capabilities ?? []).some(({ checkIds }) => checkIds.some((id) => !checks.includes(id))))
    throw new GraphError('WORKFLOW_CHECK_UNREGISTERED', 'Capability должна ссылаться на обязательные зарегистрированные checks проекта.');
  if ((policy.specialists ?? []).some(({ skillId }) => !projectSkills.some(({ id }) => id === skillId)))
    throw new GraphError('WORKFLOW_SKILL_UNREGISTERED', 'Specialist должен ссылаться на pinned project Skill.');
  return policy;
}

/** These facts come from the original task. They do not grant rights or drop checks. */
export function classifyDevelopmentTask(task) {
  const text = `${task.goal ?? ''}\n${task.instructions ?? ''}`;
  const risks = [];
  if (/(?:\bauth(?:entication|orization)?\b|\bsecurity\b|авторизац|аутентификац|безопасност)/i.test(text)) risks.push('access');
  if (/(?:\bmigrat|\bpayment|\bconcurr|\bidempoten|\btransaction|миграци|платеж|конкурент|идемпотент|транзакц)/i.test(text)) risks.push('data-integrity');
  const scope = task.scope ?? [];
  const staticOnly = scope.length > 0 && scope.every((file) => /\.(?:md|txt|rst)$/i.test(file));
  let kind = staticOnly ? 'static' : 'behavior';
  if (!staticOnly) {
    if (/(?:\bbug\b|\bfix\b|\berror\b|ошибк|дефект|исправ)/i.test(text)) kind = 'bugfix';
    else if (/(?:\brefactor|рефактор|декомпозиц)/i.test(text)) kind = 'refactor';
    else if (/(?:\bperformance\b|\blatency\b|производительност|ускор|задержк)/i.test(text)) kind = 'performance';
    else if (/(?:\bredesign\b|\bdesign\b|дизайн|верстк)/i.test(text)) kind = 'design';
  }
  return { kind, rigor: risks.length ? 'high-risk' : staticOnly ? 'routine' : 'standard', risks };
}

const ROUTES = Object.freeze({
  'ai-plan': ['project-context', 'core-analysis', 'core-planning', 'core-security'],
  'ai-analyze': ['project-context', 'core-analysis', 'core-planning', 'core-security'],
  'ai-implement': ['project-context', 'clean-implementation', 'testing', 'delivery-pipeline', 'core-security'],
  'ai-review': ['project-context', 'code-review', 'testing', 'core-security'],
});

/** Pure trusted routing: a missing capability/unknown major excludes a specialist. */
export function selectDevelopmentSkills({ action, stack, task, policy, projectSkills = [], availableCheckIds = [], checkDefinitions = [], failureClass = null }) {
  if (!Object.hasOwn(ROUTES, action)) throw new GraphError('SKILL_ACTION_UNKNOWN', 'Неизвестное действие Skill-policy.');
  policy = DevelopmentWorkflowSchema.parse(policy);
  const classification = classifyDevelopmentTask(task);
  const registered = new Set(availableCheckIds);
  const formats = {
    'browser-scenario': ['playwright-json'], 'component-test': ['jest-json', 'vitest-json', 'flowcairn-node-test/v1'],
    'api-integration': ['flowcairn-node-test/v1', 'jest-json'], 'api-contract': ['flowcairn-node-test/v1', 'jest-json'],
    'mobile-android-build': ['flowcairn-android-node/v1'], 'mobile-android-scenario': ['flowcairn-android-node/v1'],
    'mobile-ios-build': ['flowcairn-xctest/v1'], 'mobile-ios-scenario': ['flowcairn-xctest/v1'],
    'mobile-component-test': ['jest-json', 'vitest-json', 'flowcairn-node-test/v1'],
  };
  const inside = (file, directory) => directory === '.' || file === directory || file.startsWith(`${directory}/`);
  const scoped = (entry) => (entry.scope ?? ['.']).some((scope) => stack.scope.some((file) => inside(file, scope) || inside(scope, file)));
  const capabilities = (policy.capabilities ?? []).map((entry) => ({ ...entry,
    status: scoped(entry) && entry.checkIds.every((id) => registered.has(id) &&
      formats[entry.id]?.includes(checkDefinitions.find((definition) => definition.id === id)?.report?.format)) ? 'registered' : 'unavailable',
    acceptance: 'unverified',
  }));
  const applicable = capabilities.filter(({ status }) => status === 'registered');
  const explicitDomains = [...new Set(applicable.map(({ id }) => DEVELOPMENT_CAPABILITIES.find((capability) => capability.id === id).domain))];
  const domains = stack.domains.length === 1 && stack.domains[0] === 'engineering' && explicitDomains.length === 1
    ? explicitDomains : stack.domains;
  const ids = [...ROUTES[action]];
  if (['ai-plan', 'ai-analyze'].includes(action) && classification.rigor !== 'routine') ids.push('workflow-planning', 'workflow-reuse');
  if (['ai-implement', 'ai-review'].includes(action) && classification.kind !== 'static') ids.push('workflow-verification');
  const testQualityRequested = /(?:\btest[- ]?(?:gap|quality)|\bweak assertions?\b|качеств\w*\s+тест|пробел\w*\s+(?:в\s+)?тест|слаб\w*\s+(?:проверк|assert))/i.test(`${task.goal ?? ''}\n${task.instructions ?? ''}`);
  if (classification.kind !== 'static' && (action === 'ai-implement' || action === 'ai-review' &&
      (classification.rigor === 'high-risk' || classification.kind === 'bugfix' || testQualityRequested))) ids.push('workflow-test-quality');
  if (action === 'ai-implement' && (classification.kind === 'bugfix' || failureClass !== null)) ids.push('workflow-diagnosis');
  if (action === 'ai-implement' && failureClass === 'implementation') ids.push('core-debugging');
  if ((task.scope ?? []).some((file) => /\.(?:md|rst)$/i.test(file))) ids.push('core-documentation');
  ids.push(...domains.map((domain) => `domain-${domain}`));
  const exclusions = [];
  for (const skill of projectSkills) {
    const specialist = (policy.specialists ?? []).find(({ skillId }) => skillId === skill.id);
    if (!specialist) { ids.push(skill.id); continue; }
    const relevant = stack.packages.flatMap((pkg) => pkg.frameworks.filter((framework) =>
      specialist.frameworks.includes(framework.id) && specialist.domains.includes(framework.domain)));
    const knownVersion = relevant.length > 0 && relevant.every((framework) =>
      framework.version.major !== null && specialist.majors.includes(framework.version.major));
    const missing = specialist.requires.filter((id) => !applicable.some((entry) => entry.id === id));
    if (!knownVersion || !specialist.taskKinds.includes(classification.kind) || missing.length) {
      exclusions.push({ skillId: skill.id, reason: !knownVersion ? 'framework-or-version-unknown-or-incompatible' : missing.length ? 'capability-unavailable' : 'task-kind-inapplicable', missing });
    } else ids.push(skill.id);
  }
  const body = { version: 1, action, classification, domains, ids: [...new Set(ids)], capabilities, exclusions,
    stackHash: stack.hash, policyHash: hashObject(policy), catalogHash: hashObject({ capabilities: DEVELOPMENT_CAPABILITIES, methods: DEVELOPMENT_METHODS }) };
  return { ...body, hash: hashObject(body) };
}
