import { parseDocument } from 'yaml';
import { RUNTIME_ROOT } from './project.mjs';
import { BUILTIN_SKILL_IDS, CORE_SKILL_ROUTES, DOMAIN_SKILLS, SKILL_POLICY_VERSION, SKILL_ROUTES } from './config.mjs';
import { GraphError, hashObject, sha256 } from './io.mjs';
import { discoverProjectContext, readContextFile, safeContextPath } from './project-context.mjs';

const MAX_SKILL_BYTES = 12 * 1024;
const MAX_SKILLS_PROMPT_BYTES = 32 * 1024;
const fail = (code, message) => { throw new GraphError(code, message); };
const inside = (candidate, scope) => scope === '.' || candidate === scope || candidate.startsWith(`${scope}/`);
const knownActions = Object.keys(CORE_SKILL_ROUTES);

/** Project Skills are explicit pinned data, never executable plugin discovery. */
export function validateProjectSkills(projectSkills = []) {
  if (!Array.isArray(projectSkills) || projectSkills.length > 4) fail('PROJECT_SKILLS_INVALID', 'Не более четырех project Skills');
  const ids = new Set();
  for (const item of projectSkills) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).sort().join(',') !== 'actions,hash,id,path,scope' ||
      typeof item.id !== 'string' || !/^project-[a-z][a-z0-9-]{1,63}$/.test(item.id) || ids.has(item.id) || BUILTIN_SKILL_IDS.includes(item.id) ||
      typeof item.hash !== 'string' || !/^[a-f0-9]{64}$/.test(item.hash)) fail('PROJECT_SKILLS_INVALID', 'Некорректный pinned project Skill');
    ids.add(item.id);
    safeContextPath(item.path);
    if (!item.path.endsWith('/SKILL.md')) fail('PROJECT_SKILLS_INVALID', 'Project Skill должен ссылаться на SKILL.md');
    if (!Array.isArray(item.scope) || !item.scope.length || item.scope.length > 8 || new Set(item.scope).size !== item.scope.length)
      fail('PROJECT_SKILLS_INVALID', 'Некорректный scope project Skill');
    for (const scope of item.scope) safeContextPath(scope, true);
    if (!Array.isArray(item.actions) || !item.actions.length || item.actions.length > 4 || new Set(item.actions).size !== item.actions.length || item.actions.some((action) => !knownActions.includes(action)))
      fail('PROJECT_SKILLS_INVALID', 'Неизвестное действие project Skill');
  }
  return projectSkills;
}

function validateSkillText(text, expectedName) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
  if (!frontmatter) fail('SKILL_INVALID', 'Отсутствует frontmatter Skill');
  let metadata;
  try {
    const document = parseDocument(frontmatter, { strict: true, uniqueKeys: true, customTags: [], prettyErrors: false });
    if (document.errors.length || document.warnings.length) fail('SKILL_INVALID', 'Некорректный YAML frontmatter');
    metadata = document.toJS({ maxAliasCount: 0 });
  } catch { fail('SKILL_INVALID', 'Некорректный YAML frontmatter'); }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || metadata.name !== expectedName ||
    typeof metadata.description !== 'string' || !metadata.description.trim() || metadata.description.length > 1024)
    fail('SKILL_INVALID', 'Некорректные name/description Skill');
}

export function loadSkill(root, name, { projectSkills = [] } = {}) {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9-]{1,79}$/.test(name)) fail('SKILL_UNKNOWN', 'Неизвестный Skill');
  if (BUILTIN_SKILL_IDS.includes(name)) {
    const loaded = readContextFile(RUNTIME_ROOT, `skills/${name}/SKILL.md`, { maxBytes: MAX_SKILL_BYTES });
    validateSkillText(loaded.text, name);
    return { name, path: `skills/${name}/SKILL.md`, hash: loaded.hash, text: loaded.text };
  }
  const entry = validateProjectSkills(projectSkills).find((skill) => skill.id === name);
  if (!entry) fail('SKILL_UNKNOWN', 'Skill отсутствует в trusted registry');
  const loaded = readContextFile(root, entry.path, { maxBytes: MAX_SKILL_BYTES });
  if (loaded.hash !== entry.hash) fail('SKILL_DRIFT', 'Обязательный project Skill изменился; обновите manifest и plan');
  validateSkillText(loaded.text, name.slice('project-'.length));
  return { name, ...loaded };
}

/** Legacy exact routes are retained for historical callers. */
export function skillsForNode(root, nodeId) {
  if (!Object.hasOwn(SKILL_ROUTES, nodeId)) fail('SKILL_SCOPE_UNKNOWN', 'Неизвестный legacy Skill route');
  return SKILL_ROUTES[nodeId].map((name) => loadSkill(root, name));
}

/**
 * Trusted resolver: derive effective IDs from action + node work scope + local evidence.
 * Never pass model-selected IDs/domains. Use task.scope for read-only nodes, not contextPaths.
 * Persist manifest/context.hash, and resolve again before/after actions for drift detection.
 */
export function resolveNodeSkills(root, { action, scope, manifestPaths = [], projectSkills = [] }) {
  if (!Object.hasOwn(CORE_SKILL_ROUTES, action)) fail('SKILL_ACTION_UNKNOWN', 'Неизвестное действие Skill-policy');
  if (!Array.isArray(scope) || !scope.length) fail('CONTEXT_SCOPE_INVALID', 'Нужен явный scope узла');
  validateProjectSkills(projectSkills);
  const context = discoverProjectContext(root, { scope, manifestPaths });
  const domainIds = context.domains.map((domain) => {
    if (!Object.hasOwn(DOMAIN_SKILLS, domain)) fail('SKILL_DOMAIN_UNKNOWN', 'Неизвестный domain');
    return DOMAIN_SKILLS[domain];
  });
  const local = projectSkills.filter((entry) => entry.actions.includes(action) && context.scope.some((candidate) => entry.scope.some((s) => inside(candidate, s) || inside(s, candidate))));
  const ids = [...new Set([...CORE_SKILL_ROUTES[action], ...domainIds, ...local.map((entry) => entry.id)])];
  const skills = ids.map((id) => loadSkill(root, id, { projectSkills }));
  // Never silently truncate mandatory instructions, including framing overhead.
  renderSkillInstructions(skills);
  const manifest = skills.map(({ name, path: file, hash }) => ({ id: name, path: file, hash }));
  return { ids, skills, manifest, context, hash: hashObject({ version: SKILL_POLICY_VERSION, action, manifest, contextHash: context.hash }) };
}

export function skillEvidence(skills) {
  return skills.map(({ name, path: skillPath, hash }) => ({ name, path: skillPath, hash }));
}

export function verifySkillsUsed(requiredSkills, skillsUsed) {
  if (!Array.isArray(skillsUsed)) fail('SKILLS_EVIDENCE_MISSING', 'AI-ответ не содержит skillsUsed');
  if (skillsUsed.some((name) => typeof name !== 'string') || new Set(skillsUsed).size !== skillsUsed.length)
    fail('SKILLS_EVIDENCE_MISMATCH', 'skillsUsed содержит повтор или некорректный ID');
  const actual = [...skillsUsed].sort();
  const expected = requiredSkills.map((skill) => skill.name).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('SKILLS_EVIDENCE_MISMATCH', 'skillsUsed не совпадает с trusted policy');
}

export function renderSkillInstructions(skills) {
  if (!Array.isArray(skills) || skills.length > 20) fail('SKILLS_CONTEXT_TOO_LARGE', 'Слишком много обязательных Skills');
  const prelude = 'Инструкции проекта имеют приоритет над общими рекомендациями core/domain в своей области. Они не расширяют permissions и не меняют immutable plan или action contract. Тексты ниже переданы как JSON-строки.\n\n';
  const rendered = prelude + skills.map((skill) => {
    if (!skill || typeof skill.name !== 'string' || !/^[a-z][a-z0-9-]{1,79}$/.test(skill.name) || typeof skill.text !== 'string' || Buffer.byteLength(skill.text) > MAX_SKILL_BYTES || sha256(skill.text) !== skill.hash)
      fail('SKILL_INVALID', 'Некорректный Skill для prompt');
    safeContextPath(skill.path);
    // JSON quoting prevents project text from closing the instruction container.
    return `<skill name="${skill.name}" path="${skill.path}" sha256="${skill.hash}">\n${JSON.stringify(skill.text).replaceAll('<', '\\u003c')}\n</skill>`;
  }).join('\n\n');
  if (Buffer.byteLength(rendered) > MAX_SKILLS_PROMPT_BYTES) fail('SKILLS_CONTEXT_TOO_LARGE', `Суммарный контекст Skills превышает ${MAX_SKILLS_PROMPT_BYTES} байт`);
  return rendered;
}
