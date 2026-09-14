// Legacy routes are immutable compatibility data for existing plans and receipts.
export const SKILL_ROUTES = Object.freeze({
  plan: Object.freeze(['project-context']),
  analyze: Object.freeze(['project-context']),
  implement: Object.freeze(['project-context', 'clean-implementation', 'testing', 'delivery-pipeline']),
  review: Object.freeze(['project-context', 'code-review']),
});

export const SKILL_POLICY_VERSION = 2;
export const CORE_SKILL_ROUTES = Object.freeze({
  'ai-plan': Object.freeze(['project-context', 'core-analysis', 'core-planning', 'core-security']),
  'ai-analyze': Object.freeze(['project-context', 'core-analysis', 'core-planning', 'core-security']),
  'ai-implement': Object.freeze([
    'project-context', 'clean-implementation', 'testing', 'delivery-pipeline',
    'core-security', 'core-documentation', 'core-debugging',
  ]),
  'ai-review': Object.freeze(['project-context', 'code-review', 'testing', 'core-security']),
});
export const DOMAIN_SKILLS = Object.freeze({
  engineering: 'domain-engineering',
  frontend: 'domain-frontend',
  backend: 'domain-backend',
  mobile: 'domain-mobile',
});
export const BUILTIN_SKILL_IDS = Object.freeze([...new Set([
  ...Object.values(SKILL_ROUTES).flat(),
  ...Object.values(CORE_SKILL_ROUTES).flat(),
  ...Object.values(DOMAIN_SKILLS),
])]);
