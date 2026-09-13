import { createInterface } from 'node:readline/promises';
import { GraphError } from '../scripts/ai-graph/lib/io.mjs';

const csv = (text) => text.split(',').map((part) => part.trim()).filter(Boolean);
const label = (value) => [...String(value)]
  .filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
  .join('').slice(0, 512);
const actions = ['ai-plan', 'ai-analyze', 'ai-implement', 'ai-review'];

function selectedActions(value) {
  const selected = csv(value).map((part) => part.startsWith('ai-') ? part : `ai-${part}`);
  if (!selected.length || selected.some((part) => !actions.includes(part)) ||
      new Set(selected).size !== selected.length)
    throw new GraphError('SKILL_APPLICABILITY', 'Укажите этапы: plan, analyze, implement, review. Файлы не изменены.');
  return selected;
}

/** Explicit local selection only; discovered text never becomes instructions automatically. */
export async function selectProjectSkills(projectRoot, options = {}, terminal = {}, loader = async () => ({
  ...await import('../scripts/ai-graph/lib/instructions.mjs'),
  ...await import('../scripts/ai-graph/lib/skills.mjs'),
})) {
  const input = terminal.input ?? process.stdin;
  const output = terminal.output ?? process.stderr;
  const interactive = input.isTTY && output.isTTY && !options.json && !options['dry-run'];
  if (options.skills === undefined && !interactive) return undefined;
  const api = await loader();
  const instructionManifest = api.inspectInstructions({ projectRoot });
  const discovered = api.discoverProjectSkillCandidates(projectRoot, { instructionManifest });
  const eligible = discovered.candidates.filter((item) => item.eligible);
  /** @type {import('node:readline/promises').Interface | undefined} */
  let prompt;
  const question = async (text) => {
    prompt ??= terminal.prompt ?? createInterface({ input, output });
    return (await prompt.question(text)).trim();
  };
  try {
    let selected;
    if (options.skills !== undefined) {
      selected = csv(options.skills).map((name) => {
        const matches = eligible.filter((item) => item.name === name);
        if (matches.length !== 1)
          throw new GraphError('SKILL_SELECTION', 'Имя Skill отсутствует, неоднозначно или не прошло проверку. Используйте интерактивный init для выбора конкретного файла.');
        return matches[0];
      });
    } else {
      if (!eligible.length) return undefined;
      output.write('Найдены локальные Skills. Подключаются только выбранные вами файлы:\n');
      eligible.forEach((item, index) => output.write(`  ${index + 1}. ${label(item.name)} (${label(item.path)})\n`));
      const selection = await question('Номера через запятую (до 4), Enter — пропустить: ');
      if (!selection) return undefined;
      selected = csv(selection).map((value) => {
        if (!/^[1-9]\d*$/.test(value) || !eligible[Number(value) - 1])
          throw new GraphError('SKILL_SELECTION', 'Выберите номера из показанного списка. Файлы не изменены.');
        return eligible[Number(value) - 1];
      });
    }
    if (selected.length > 4 || new Set(selected.map((item) => item.path)).size !== selected.length)
      throw new GraphError('SKILL_SELECTION', 'Выберите не более 4 разных Skills. Файлы не изменены.');
    const selections = [];
    for (const candidate of selected) {
      let assignedActions, scope;
      if (options['skill-actions'] !== undefined && options['skill-scope'] !== undefined) {
        assignedActions = selectedActions(options['skill-actions']);
        scope = csv(options['skill-scope']);
      } else if (!interactive) {
        throw new GraphError('SKILL_APPLICABILITY', 'Для --skills нужны --skill-actions plan,analyze,implement,review (выберите нужные) и --skill-scope src (или . для всего проекта). Файлы не изменены.');
      } else {
        output.write(`Skill ${label(candidate.name)}. Этапы: 1 — планирование, 2 — анализ, 3 — реализация, 4 — ревью.\n`);
        const stages = await question('Номера нужных этапов, Enter — не подключать этот Skill: ');
        if (!stages) continue;
        assignedActions = csv(stages).map((value) => {
          if (!/^[1-4]$/.test(value))
            throw new GraphError('SKILL_APPLICABILITY', 'Выберите этапы из списка 1–4. Файлы не изменены.');
          return actions[Number(value) - 1];
        });
        const suggested = candidate.scope === '.' ? '. — весь проект' : label(candidate.scope);
        const region = await question(`Область: ${suggested}. Enter — подтвердить, либо введите папки через запятую: `);
        scope = region ? csv(region) : [candidate.scope];
      }
      if (!scope.length || scope.length > 8 || new Set(assignedActions).size !== assignedActions.length)
        throw new GraphError('SKILL_APPLICABILITY', 'Нужны уникальные этапы и от 1 до 8 областей проекта. Файлы не изменены.');
      selections.push({ path: candidate.path, actions: assignedActions, scope });
    }
    return api.createProjectSkillManifest(projectRoot, {
      instructionManifest, expectedFingerprint: discovered.fingerprint, selections,
    });
  } finally { if (prompt && !terminal.prompt) prompt.close(); }
}
