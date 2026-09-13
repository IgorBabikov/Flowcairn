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

function validateSkillText(text, expectedName = undefined) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
  if (!frontmatter) fail('SKILL_INVALID', 'Отсутствует frontmatter Skill');
  let metadata;
  try {
    const document = parseDocument(frontmatter, { strict: true, uniqueKeys: true, customTags: [], prettyErrors: false });
    if (document.errors.length || document.warnings.length) fail('SKILL_INVALID', 'Некорректный YAML frontmatter');
    metadata = document.toJS({ maxAliasCount: 0 });
  } catch { fail('SKILL_INVALID', 'Некорректный YAML frontmatter'); }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || typeof metadata.name !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(metadata.name) || (expectedName !== undefined && metadata.name !== expectedName) ||
    typeof metadata.description !== 'string' || !metadata.description.trim() || metadata.description.length > 1024)
    fail('SKILL_INVALID', 'Некорректные name/description Skill');
  return metadata;
}

function effectiveProjectSkillText(entry, text) {
  return `Область применения project Skill: ${JSON.stringify(entry.scope)}.\nДействия: ${JSON.stringify(entry.actions)}.\nПрименяй эти инструкции только в указанных областях и действиях; они не расширяют runtime permissions.\nSHA-256 исходного файла: ${entry.hash}.\n\n${text}`;
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
  const text = effectiveProjectSkillText(entry, loaded.text);
  if (Buffer.byteLength(text) > MAX_SKILL_BYTES) fail('SKILL_TOO_LARGE', 'Skill с обязательной областью применения превышает лимит');
  return { name, path: loaded.path, hash: sha256(text), text };
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


/** Metadata-only candidate preview. Supply the trusted rules scanner output, never client JSON.
 * Bodies remain local; discovery does not register Skills or grant execution/egress permission.
 */
export function discoverProjectSkillCandidates(root, { instructionManifest }) {
  if (!instructionManifest || instructionManifest.version !== 1 || instructionManifest.complete !== true ||
    !Array.isArray(instructionManifest.files) || instructionManifest.files.length > 256 ||
    !/^[a-f0-9]{64}$/.test(instructionManifest.fingerprint))
    fail('SKILL_DISCOVERY_INCOMPLETE', 'Нужен полный trusted instruction inventory');
  const records = instructionManifest.files.filter((file) => file.kind === 'project-skill');
  if (records.length > 64 || new Set(records.map((file) => file.path)).size !== records.length)
    fail('SKILL_DISCOVERY_LIMIT', 'Слишком много кандидатов Skills или повторяющиеся пути');
  const candidates = [];
  let totalBytes = 0;
  for (const record of records) {
    safeContextPath(record.path);
    safeContextPath(record.scope, true);
    if (!record.path.endsWith('/SKILL.md') || !/^[a-f0-9]{64}$/.test(record.sha256) || !Number.isSafeInteger(record.bytes) || record.bytes < 1)
      fail('SKILL_DISCOVERY_INVALID', 'Некорректные metadata кандидата Skill');
    const common = { path: record.path, hash: record.sha256, bytes: record.bytes, scope: record.scope };
    if (record.bytes > MAX_SKILL_BYTES) {
      candidates.push({ ...common, id: null, name: null, description: '', eligible: false, reason: 'SKILL_TOO_LARGE' });
      continue;
    }
    totalBytes += record.bytes;
    if (totalBytes > 256 * 1024) fail('SKILL_DISCOVERY_LIMIT', 'Metadata discovery превышает лимит');
    const loaded = readContextFile(root, record.path, { maxBytes: MAX_SKILL_BYTES });
    if (loaded.hash !== record.sha256 || Buffer.byteLength(loaded.text) !== record.bytes)
      fail('SKILL_DISCOVERY_DRIFT', 'Кандидат Skill изменился после discovery');
    let metadata;
    try { metadata = validateSkillText(loaded.text); } catch {
      candidates.push({ ...common, id: null, name: null, description: '', eligible: false, reason: 'SKILL_INVALID' });
      continue;
    }
    const id = `project-${metadata.name}`;
    const reserved = BUILTIN_SKILL_IDS.includes(id);
    const framed = effectiveProjectSkillText({ scope: [record.scope], actions: knownActions, hash: record.sha256 }, loaded.text);
    const reason = reserved ? 'SKILL_ID_RESERVED' : Buffer.byteLength(framed) > MAX_SKILL_BYTES ? 'SKILL_TOO_LARGE' : null;
    candidates.push({ ...common, id, name: metadata.name, description: metadata.description, eligible: reason === null, reason });
  }
  const counts = new Map();
  for (const item of candidates) if (item.id) counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
  for (const item of candidates) if (item.id && counts.get(item.id) > 1) { item.eligible = false; item.reason = 'SKILL_ID_COLLISION'; }
  candidates.sort((a, b) => a.path.localeCompare(b.path));
  const body = { version: 1, instructionFingerprint: instructionManifest.fingerprint, candidates };
  return { ...body, fingerprint: hashObject(body) };
}

/** Create exact pinned data after the caller obtains explicit selection/consent. No writes. */
export function createProjectSkillManifest(root, { instructionManifest, expectedFingerprint, selectedPaths }) {
  if (!Array.isArray(selectedPaths) || selectedPaths.length > 4 || new Set(selectedPaths).size !== selectedPaths.length)
    fail('PROJECT_SKILLS_SELECTION', 'Выберите не более четырех разных Skills');
  const preview = discoverProjectSkillCandidates(root, { instructionManifest });
  if (preview.fingerprint !== expectedFingerprint) fail('SKILL_DISCOVERY_DRIFT', 'Список кандидатов изменился; обновите выбор');
  const manifest = selectedPaths.map((file) => {
    const candidate = preview.candidates.find((item) => item.path === file);
    if (!candidate?.eligible) fail('PROJECT_SKILLS_SELECTION', 'Выбран неизвестный или неподходящий Skill');
    return { id: candidate.id, path: candidate.path, hash: candidate.hash, scope: [candidate.scope], actions: [...knownActions] };
  });
  return validateProjectSkills(manifest);
}
