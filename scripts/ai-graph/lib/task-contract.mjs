import { GraphError, hashObject } from './io.mjs';
import { TaskContractSchema, TaskContractProposalSchema } from './schemas.mjs';
import { contextPathAllowed, overlaps } from './registry.mjs';

const unique = (values) => [...new Set(values)];
const fail = (code, message) => { throw new GraphError(code, message); };
const normalize = (value) => value.trim().replace(/\s+/g, ' ');
const requirementId = (title) => `req-${hashObject(normalize(title)).slice(0, 16)}`;

function referencedDetail(title, existingIds) {
  const prefix = /^(req-[a-z0-9-]+(?:\s*[/,]\s*(?:req-[a-z0-9-]+|[0-9]{3}))*)\s*:\s*(\S[\s\S]*)$/.exec(title.trim());
  if (!prefix) return null;
  const ids = prefix[1].split(/\s*[/,]\s*/).map((id) => id.startsWith('req-') ? id : `req-${id}`);
  return ids.every((id) => existingIds.has(id)) ? prefix[2].trim() : null;
}

/** Deterministic effort selection never changes permissions or removes configured checks. */
export function selectTaskRigor(task, analysis = null) {
  const reasons = [];
  const requirements = analysis?.requirements?.length ?? task.acceptance.length;
  const uncertainties = analysis?.risks?.length ?? 0;
  const text = `${task.goal}\n${task.instructions}`;
  if (/(?:\bsecurity\b|\bauth\b|\bpayment\b|\bmigration\b|\bproduction\b|безопасност|авторизац|платеж|миграци|удален[иия])/i.test(text)) reasons.push('Задача затрагивает операции с высокой ценой ошибки');
  if (task.scope.length > 8 || requirements > 8) reasons.push('Широкая область изменений или много требований');
  if (uncertainties > 3) reasons.push('Анализ обнаружил несколько существенных рисков');
  if (reasons.length) return { level: 'high', reasons };
  const boundedTextEdit = task.scope.length <= 2 && task.scope.every((file) => /\.(?:md|txt|rst)$/i.test(file)) &&
    /(?:опечат|исправить текст|переименовать|заменить текст|\btypo\b|\brename\b|\bwording\b|\bspelling\b)/i.test(text);
  if (boundedTextEdit && requirements <= 2 && uncertainties === 0 && text.length <= 1800)
    return { level: 'light', reasons: ['Небольшая правка текста в точно выбранных документах без выявленных существенных рисков'] };
  return { level: 'standard', reasons: ['Несколько связанных результатов требуют анализа и независимой проверки'] };
}

function verificationFor(task, title, input = null) {
  const verification = input ?? { method: 'human', checkIds: [], criterion: title, paths: [...task.scope] };
  if (verification.paths.some((file) => !contextPathAllowed(file, task)))
    fail('CONTRACT_VERIFICATION_SCOPE', 'Verification path выходит за разрешенный контекст задачи');
  if (verification.method === 'check' && (!verification.checkIds.length || verification.checkIds.some((id) => !task.checks.some((check) => id === `check-${check}`))))
    fail('CONTRACT_CHECK_UNAVAILABLE', 'Требование ссылается на ненастроенную проверку');
  if (verification.method !== 'check' && verification.checkIds.length)
    fail('CONTRACT_VERIFICATION_METHOD', 'Checks допустимы только для метода check');
  if (verification.method !== 'human' && !verification.paths.length)
    fail('CONTRACT_VERIFICATION_SCOPE', 'Объективная проверка требует область проверяемого результата');
  return { ...verification, checkIds: unique(verification.checkIds), paths: unique(verification.paths) };
}

function bindWork(requirements, steps) {
  const ids = new Set(requirements.map((requirement) => requirement.id));
  for (const step of steps) if (step.requirementIds?.some((id) => !ids.has(id)))
    fail('CONTRACT_REQUIREMENT_UNKNOWN', 'План ссылается на неизвестное требование');
  return requirements.map((requirement) => ({
    ...requirement,
    workIds: steps.filter((step) => step.requirementIds
      ? step.requirementIds.includes(requirement.id)
      : !requirement.verification.paths.length || step.paths.some((file) => requirement.verification.paths.some((scope) => overlaps(file, scope))))
      .map((step) => step.nodeId ?? `step-${step.id}`),
  }));
}

/** AI proposes semantics; the runtime preserves the original obligations and allowed verification. */
export function buildTaskContract(task, { proposal = null, analysis = null, previousContract = null, steps = [] } = {}) {
  const instructionsHash = hashObject(task.instructions);
  const omnibusAcceptance = (task.intakeKind === 'natural' || (!task.intakeKind && task.taskNumber)) &&
    task.acceptance.length === 1 &&
    normalize(task.acceptance[0]) === normalize(task.instructions.slice(0, 4000));
  if (previousContract) {
    const previous = TaskContractSchema.parse(previousContract);
    const decomposed = omnibusAcceptance && previous.acceptanceHash === hashObject(task.acceptance);
    if (previous.goal !== task.goal || previous.instructionsHash !== instructionsHash ||
        hashObject(previous.scope) !== hashObject(task.scope) || hashObject(previous.forbiddenPaths) !== hashObject(task.forbiddenPaths) ||
        (previous.acceptanceHash && !decomposed) ||
        (!decomposed && previous.requirements.filter((item) => item.origin === 'acceptance').length !== task.acceptance.length) ||
        (decomposed && previous.requirements.some((item) => item.origin !== 'analysis' || !item.mandatory)))
      fail('CONTRACT_DRIFT', 'Исправление не может изменить исходную задачу и ее границы');
    const rigorLevels = ['light', 'standard', 'high'];
    if (rigorLevels.indexOf(previous.rigor.level) < rigorLevels.indexOf(selectTaskRigor(task).level))
      fail('CONTRACT_RIGOR_WEAKENED', 'Контракт не может уменьшить необходимую строгость проверки');
    for (const [index, title] of (decomposed ? [] : task.acceptance).entries()) {
      const requirement = previous.requirements.find((item) => item.id === `req-${String(index + 1).padStart(3, '0')}`);
      if (!requirement?.mandatory || requirement.title !== title || requirement.origin !== 'acceptance')
        fail('CONTRACT_DRIFT', 'Исходное обязательное требование отсутствует в сохраненном контракте');
    }
    for (const requirement of previous.requirements) verificationFor(task, requirement.title, requirement.verification);
    return TaskContractSchema.parse({ ...previous, requirements: steps.length ? bindWork(previous.requirements, steps) : previous.requirements });
  }
  const proposed = proposal ? TaskContractProposalSchema.parse(proposal) : null;
  if (proposed && new Set(proposed.requirements.map((item) => item.id)).size !== proposed.requirements.length)
    fail('CONTRACT_REQUIREMENT_DUPLICATE', 'Идентификаторы требований повторяются');
  const proposedById = new Map(proposed?.requirements.map((item) => [item.id, item]) ?? []);
  const decomposing = omnibusAcceptance && Boolean(analysis?.requirements?.length);
  if (omnibusAcceptance && proposed && !decomposing)
    fail('CONTRACT_ANALYSIS_REQUIRED', 'Естественная задача требует отдельного анализа обязательных пунктов');
  const requirements = (decomposing ? [] : task.acceptance).map((title, index) => {
    const id = `req-${String(index + 1).padStart(3, '0')}`, candidate = proposedById.get(id);
    if (candidate && (!candidate.mandatory || candidate.title !== title || candidate.verification.criterion !== title))
      fail('CONTRACT_ACCEPTANCE_WEAKENED', 'Planner не может удалить, переименовать или ослабить исходное требование');
    return { id, title, mandatory: true, origin: 'acceptance', verification: verificationFor(task, title, candidate?.verification), workIds: [] };
  });
  const titles = new Set(requirements.map((item) => normalize(item.title)));
  const existingIds = new Set(requirements.map((item) => item.id));
  for (const rawTitle of analysis?.requirements ?? []) {
    const detail = referencedDetail(rawTitle, existingIds);
    if (detail && !decomposing) continue;
    const title = decomposing
      ? rawTitle.replace(/^(?:req-[a-z0-9-]+(?:\s*[/,]\s*(?:req-[a-z0-9-]+|[0-9]{3}))*)\s*:\s*/i, '').trim()
      : rawTitle;
    if (titles.has(normalize(title))) continue;
    const candidate = proposed?.requirements.find((item) => normalize(item.title) === normalize(title));
    if (decomposing && proposed && !candidate)
      fail('CONTRACT_ANALYSIS_COVERAGE', 'План должен отдельно проверить каждый пункт анализа');
    if (candidate && (!candidate.mandatory || candidate.verification.criterion !== title))
      fail('CONTRACT_ACCEPTANCE_WEAKENED', 'Требование анализа нельзя ослабить или заменить общим критерием');
    requirements.push({ id: candidate?.id ?? requirementId(title), title, mandatory: true, origin: 'analysis',
      verification: verificationFor(task, title, candidate?.verification), workIds: [] });
    titles.add(normalize(title));
  }
  for (const candidate of proposed?.requirements ?? []) {
    if (decomposing && candidate.id === 'req-001' && candidate.title === task.acceptance[0]) continue;
    if (requirements.some((item) => item.id === candidate.id)) continue;
    if (titles.has(normalize(candidate.title))) fail('CONTRACT_REQUIREMENT_DUPLICATE', 'Одинаковое требование получило разные идентификаторы');
    requirements.push({ ...candidate, origin: 'analysis', verification: verificationFor(task, candidate.title, candidate.verification), workIds: [] });
    titles.add(normalize(candidate.title));
  }
  if (new Set(requirements.map((item) => item.id)).size !== requirements.length)
    fail('CONTRACT_REQUIREMENT_DUPLICATE', 'Идентификаторы требований пересекаются с исходным контрактом');
  const linkedSteps = decomposing ? steps.map((step) => ({ ...step,
    ...(step.requirementIds ? { requirementIds: step.requirementIds.filter((id) => id !== 'req-001') } : {}),
  })) : steps;
  const bound = bindWork(requirements, linkedSteps);
  if (decomposing && proposed && steps.length && bound.some((item) => item.origin === 'analysis' && !item.workIds.length))
    fail('CONTRACT_ANALYSIS_COVERAGE', 'Каждый пункт анализа должен быть связан с работой плана');
  return TaskContractSchema.parse({
    version: 1, goal: task.goal, instructionsHash,
    ...(decomposing ? { acceptanceHash: hashObject(task.acceptance) } : {}),
    requirements: bound,
    optionalImprovements: proposed?.optionalImprovements ?? [],
    constraints: unique(proposed ? proposed.constraints : analysis?.constraints ?? []),
    assumptions: proposed?.assumptions ?? [],
    unknowns: unique([...(analysis?.risks ?? []), ...(proposed?.unknowns ?? [])]),
    scope: [...task.scope], forbiddenPaths: [...task.forbiddenPaths], rigor: selectTaskRigor(task, analysis),
  });
}

/** Validate task linkage and work/verification references when loading an immutable plan. */
export function validateTaskContract(contract, task, nodes = []) {
  const parsed = buildTaskContract(task, { previousContract: contract });
  const workIds = new Set(nodes.filter((node) => node.action.id === 'ai-implement').map((node) => node.id));
  const checkIds = new Set(nodes.filter((node) => node.action.id.startsWith('check-')).map((node) => node.action.id));
  if (new Set(parsed.requirements.map((item) => item.id)).size !== parsed.requirements.length)
    fail('CONTRACT_REQUIREMENT_DUPLICATE', 'Идентификаторы требований повторяются');
  for (const requirement of parsed.requirements) {
    if (requirement.workIds.some((id) => !workIds.has(id)))
      fail('CONTRACT_WORK_UNKNOWN', 'Требование ссылается на отсутствующую работу');
    if (nodes.some((node) => node.action.id === 'ai-implement') && requirement.verification.checkIds.some((id) => !checkIds.has(id)))
      fail('CONTRACT_CHECK_UNAVAILABLE', 'План не содержит обязательную проверку требования');
  }
  return parsed;
}
