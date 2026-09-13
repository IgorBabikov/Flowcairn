import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { RUNTIME_ROOT } from './project.mjs';
import { SKILL_ROUTES } from './config.mjs';
import { GraphError, sha256 } from './io.mjs';

const MAX_SKILL_BYTES = 12 * 1024;
const MAX_SKILLS_PROMPT_BYTES = 32 * 1024;

export function loadSkill(root, name) {
  const skillsRoot = realpathSync(path.join(RUNTIME_ROOT, 'skills'));
  const file = path.join(skillsRoot, name, 'SKILL.md');
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    throw new GraphError('SKILL_MISSING', `Обязательный Skill не найден: ${name}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new GraphError('SKILL_UNSAFE', `Skill должен быть обычным файлом без ссылок: ${name}`);
  }
  const resolved = realpathSync(file);
  if (!resolved.startsWith(`${skillsRoot}${path.sep}`)) {
    throw new GraphError('SKILL_ESCAPE', `Skill выходит за пределы runtime skills: ${name}`);
  }
  if (stat.size > MAX_SKILL_BYTES) {
    throw new GraphError('SKILL_TOO_LARGE', `Skill ${name} превышает ${MAX_SKILL_BYTES} байт`);
  }
  const text = readFileSync(resolved, 'utf8');
  if (!text.startsWith('---\n') || !text.includes(`\nname: ${name}\n`)) {
    throw new GraphError('SKILL_INVALID', `Некорректный frontmatter Skill: ${name}`);
  }
  return {
    name,
    path: path.relative(RUNTIME_ROOT, resolved),
    hash: sha256(text),
    text,
  };
}

export function skillsForNode(root, nodeId) {
  return (SKILL_ROUTES[nodeId] ?? []).map((name) => loadSkill(root, name));
}

export function skillEvidence(skills) {
  return skills.map(({ name, path: skillPath, hash }) => ({ name, path: skillPath, hash }));
}

export function verifySkillsUsed(requiredSkills, skillsUsed) {
  if (!Array.isArray(skillsUsed)) {
    throw new GraphError('SKILLS_EVIDENCE_MISSING', 'AI-ответ не содержит skillsUsed');
  }
  const actual = [...new Set(skillsUsed)].sort();
  const expected = requiredSkills.map((skill) => skill.name).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new GraphError(
      'SKILLS_EVIDENCE_MISMATCH',
      `skillsUsed не совпадает: ожидалось ${expected.join(', ')}, получено ${actual.join(', ')}`,
    );
  }
}

export function renderSkillInstructions(skills) {
  const rendered = skills
    .map(
      (skill) =>
        `<skill name="${skill.name}" path="${skill.path}" sha256="${skill.hash}">\n${skill.text}\n</skill>`,
    )
    .join('\n\n');
  if (Buffer.byteLength(rendered) > MAX_SKILLS_PROMPT_BYTES) {
    throw new GraphError(
      'SKILLS_CONTEXT_TOO_LARGE',
      `Суммарный контекст Skills превышает ${MAX_SKILLS_PROMPT_BYTES} байт`,
    );
  }
  return rendered;
}
