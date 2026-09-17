import { GraphError, hashObject } from './io.mjs';
import { GraphPlanSchema, TaskSpecSchema, assertJsonBounds } from './schemas.mjs';
import { validateTaskContract } from './task-contract.mjs';
import {
  resolveAction,
  requiredChecks,
  overlaps,
  contextPathAllowed,
  pathAllowed,
  REQUIRED_AI_CONTEXT_PATHS,
  POLICY_HASH,
  REGISTRY_HASH,
} from './registry.mjs';

function reject(code, message) {
  throw new GraphError(code, message);
}
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/** Validate current proposals or inert persisted evidence without performing effects. */
export function validatePlan(
  input,
  taskInput,
  { runtimeHash = undefined, skills = undefined, resolveSkills = undefined, resolveReadPaths = undefined, contextHash = undefined, provider = undefined, mode = 'current' } = {},
) {
  if (!['current', 'historical'].includes(mode))
    reject('INVALID_VALIDATION_MODE', 'Неизвестный режим проверки плана');
  const historical = mode === 'historical';
  assertJsonBounds(input);
  assertJsonBounds(taskInput);
  const parsed = GraphPlanSchema.safeParse(input);
  if (!parsed.success) reject('INVALID_PLAN', 'GraphPlan не соответствует schema');
  const task = TaskSpecSchema.parse(taskInput),
    plan = parsed.data;
  const taskHashes = historical
    ? new Set([hashObject(taskInput), hashObject(task)])
    : new Set([hashObject(task)]);
  if (!taskHashes.has(plan.taskHash) || plan.sourceHash !== task.sourceHash)
    reject('PLAN_TASK_MISMATCH', 'План связан с другой задачей или исходниками');
  if (!historical && (plan.registryHash !== REGISTRY_HASH || plan.policyHash !== POLICY_HASH))
    reject('POLICY_DRIFT', 'Registry или permissions policy изменились');
  if (!historical && contextHash && plan.contextHash !== contextHash)
    reject('CONTEXT_DRIFT', 'Project context или Skills discovery изменились');
  if (!historical && runtimeHash && plan.runtimeHash !== runtimeHash)
    reject('RUNTIME_DRIFT', 'Runtime изменился');
  if (!historical && skills && plan.skills.some((skill) => !skills.some((current) => hashObject(current) === hashObject(skill))))
    reject('SKILL_DRIFT', 'Назначенные Skills изменились');
  if (new Set(plan.skills.map((s) => s.id)).size !== plan.skills.length)
    reject('INVALID_SKILLS', 'Повторяющиеся Skills');
  const nodes = new Map(plan.nodes.map((n) => [n.id, n]));
  if (nodes.size !== plan.nodes.length) reject('DUPLICATE_NODE', 'Node IDs должны быть уникальны');
  const visited = new Set(),
    active = new Set(),
    order = [];
  function visit(id) {
    if (active.has(id)) reject('CYCLE', 'Graph содержит цикл');
    if (visited.has(id)) return;
    const node = nodes.get(id);
    if (!node) reject('MISSING_DEPENDENCY', 'Зависимость не существует');
    active.add(id);
    for (const dep of node.needs) visit(dep);
    active.delete(id);
    visited.add(id);
    order.push(id);
  }
  for (const node of plan.nodes) visit(node.id);
  const ancestors = new Map();
  for (const id of order) {
    const set = new Set();
    for (const dep of nodes.get(id).needs) {
      set.add(dep);
      for (const ancestor of ancestors.get(dep)) set.add(ancestor);
    }
    ancestors.set(id, set);
  }
  const autonomous = plan.workflow === 'autonomous';
  const productPlanning = autonomous && plan.stage === 'planning';
  const providerConsent = plan.nodes.filter((node) => node.action.id === 'human-provider-consent');
  const externalProvider = ['claude', 'cursor'].includes(provider) || (historical && providerConsent.length === 1);
  const historicalGates = historical && !autonomous
    ? plan.nodes.filter((node) => node.success.kind === 'gate')
    : [];
  const approve = historical && !autonomous
    ? historicalGates.filter((n) => n.needs.length === 0)
    : plan.nodes.filter((n) => n.action.id === 'human-approve');
  const accept = autonomous
    ? plan.nodes.filter((node) => node.action.id === 'artifact-handoff')
    : historical
    ? historicalGates.filter(
        (n) => n.success.kind === 'gate' && ancestors.get(n.id).size === plan.nodes.length - 1,
      )
    : plan.nodes.filter((n) => n.action.id === 'human-accept');
  if (
    (!autonomous && historical && historicalGates.length !== (externalProvider ? 3 : 2)) ||
    providerConsent.length !== (externalProvider ? 1 : 0) ||
    (providerConsent.length && providerConsent[0].needs.length !== 0) ||
    approve.length !== (productPlanning ? 0 : 1) ||
    accept.length !== 1 ||
    (!historical && !productPlanning && (externalProvider
      ? !approve[0].needs.includes('provider-consent')
      : approve[0].needs.length)) ||
    (autonomous && plan.nodes.some((n) => n.action.id === 'human-accept'))
  )
    reject('INVALID_GATES', 'Нужны один начальный approve-plan и один конечный accept-result');
  if (autonomous && (!plan.autonomy || plan.autonomy.maxRepairCycles !== 2 || plan.autonomy.maxDurationMs !== 1800000))
    reject('AUTONOMY_POLICY', 'Нет ограниченной политики автономного выполнения');
  const declaredSkills = new Set(plan.skills.map((s) => s.id));
  const usedSkills = new Set();
  for (const node of plan.nodes) {
    if (new Set(node.needs).size !== node.needs.length)
      reject('DUPLICATE_DEPENDENCY', 'Зависимости повторяются');
    const action = historical
      ? null
      : resolveAction(node.action.id, node.action.version, node.action.inputs);
    if (new Set(node.permissions).size !== node.permissions.length)
      reject('PERMISSION_MISMATCH', 'Node содержит повторяющиеся permissions');
    if (!historical && !same(node.permissions, action.permissions))
      reject('PERMISSION_MISMATCH', 'Node не может расширить или скрыть permissions действия');
    if (new Set(node.skills).size !== node.skills.length)
      reject('SKILL_POLICY', 'Node содержит повторяющиеся Skills');
    if (!historical && !same(node.skills, resolveSkills ? resolveSkills(node, task) : action.skills))
      reject('SKILL_POLICY', 'Skills назначает trusted policy');
    for (const skill of node.skills) {
      if (!declaredSkills.has(skill)) reject('MISSING_SKILL', 'Отсутствует Skill manifest');
      usedSkills.add(skill);
    }
    const kind = action?.kind ?? node.success.kind;
    if (
      !historical &&
      (node.success.kind !== kind || !same(node.success.requiredArtifacts, action.artifacts))
    )
      reject('INVALID_SUCCESS_CONTRACT', 'Success contract не соответствует действию');
    const maxAttempts = historical
      ? task.limits.maxAttempts
      : Math.min(action.maxAttempts, task.limits.maxAttempts);
    if (node.retry.maxAttempts > maxAttempts)
      reject('UNSAFE_RETRY_POLICY', 'Retry policy превышает безопасный предел');
    if (!productPlanning && node.id !== approve[0].id && node.id !== providerConsent[0]?.id && !ancestors.get(node.id).has(approve[0].id))
      reject('APPROVAL_BYPASS', 'Node не зависит от approval');
    if (node.id !== accept[0].id && !ancestors.get(accept[0].id).has(node.id))
      reject('ACCEPTANCE_BYPASS', 'Final gate должен ждать все nodes');
    if (!historical) {
      for (const p of node.resources.reads) {
        const allowed = node.action.id.startsWith('ai-')
          ? contextPathAllowed(p, task)
          : pathAllowed(p, task);
        if (!allowed) reject('PATH_SCOPE', 'Node выходит за разрешенный read scope');
      }
      if (
        node.action.id.startsWith('ai-') &&
        [...REQUIRED_AI_CONTEXT_PATHS, ...(resolveReadPaths ? resolveReadPaths(node, task) : task.contextPaths)].some(
          (required) => !node.resources.reads.includes(required),
        )
      )
        reject('AI_CONTEXT_MISSING', 'AI node не объявляет обязательный trusted context');
    }
    for (const p of node.resources.writes)
      if (!pathAllowed(p, task)) reject('PATH_SCOPE', 'Node выходит за разрешенный write scope');
    if (node.resources.writes.length && !node.permissions.includes('workspace.source.write'))
      reject('WRITE_PERMISSION', 'Запись source требует явного разрешения');
    if (!historical && node.action.id === 'ai-implement' && !node.resources.writes.length)
      reject('WRITE_SCOPE_MISSING', 'Implementation требует ограниченный write scope');
  }
  if (!same([...usedSkills], [...declaredSkills]))
    reject('UNUSED_SKILLS', 'Manifest содержит неназначенные Skills');
  for (let i = 0; i < plan.nodes.length; i++)
    for (let j = i + 1; j < plan.nodes.length; j++) {
      const a = plan.nodes[i],
        b = plan.nodes[j];
      if (ancestors.get(a.id).has(b.id) || ancestors.get(b.id).has(a.id)) continue;
      const conflict =
        a.resources.writes.some((p) =>
          [...b.resources.reads, ...b.resources.writes].some((q) => overlaps(p, q)),
        ) ||
        b.resources.writes.some((p) => a.resources.reads.some((q) => overlaps(p, q))) ||
        a.resources.exclusive.some((r) => b.resources.exclusive.includes(r));
      if (conflict) reject('RESOURCE_CONFLICT', 'Конфликтующие nodes требуют dependency');
    }
  if (!historical && plan.stage === 'planning') {
    if (autonomous) {
      const analyze = plan.nodes.filter((n) => n.action.id === 'ai-analyze');
      const planner = plan.nodes.filter((n) => n.action.id === 'ai-plan');
      if (planner.length !== 1 || analyze.length !== (plan.analysisArtifact || plan.taskContract?.rigor.level === 'light' ? 0 : 1) ||
          (analyze.length && !ancestors.get(planner[0].id).has(analyze[0].id)) ||
          plan.nodes.some((n) => !['human-provider-consent','ai-analyze','ai-plan','artifact-handoff'].includes(n.action.id)) ||
          plan.nodes.some((n) => n.permissions.some((p) => p !== 'ai.read')))
        reject('INVALID_PLANNING_STAGE', 'Нужны последовательные read-only анализ и план');
    } else if (plan.nodes.length !== (externalProvider ? 4 : 3) || plan.nodes.filter((n) => n.action.id === 'ai-plan').length !== 1 ||
        plan.nodes.some((n) => !['human-provider-consent', 'human-approve', 'ai-plan', 'human-accept'].includes(n.action.id)) ||
        plan.nodes.some((n) => n.permissions.some((permission) => permission !== 'ai.read')))
      reject('INVALID_PLANNING_STAGE', 'Planning допускает только consent, read-only planner и terminal boundary');
  }
  if (!historical && plan.stage !== 'planning') {
    if (plan.nodes.some((n) => n.action.id === 'ai-plan'))
      reject('INVALID_PLANNING_STAGE', 'Planner требует отдельного staging run');
    const implementations = plan.nodes.filter((n) => n.action.id === 'ai-implement');
    const workspaceChecks = plan.nodes.filter((n) => n.action.id === 'workspace-check');
    if (
      implementations.some(
        (n) => !workspaceChecks.some((check) => ancestors.get(check.id).has(n.id)),
      )
    )
      reject('MISSING_SCOPE_CHECK', 'Implementation требует workspace-check после записи');
    for (const check of plan.nodes.filter(
      (n) =>
        n.action.id.startsWith('check-') ||
        n.action.id === 'ai-review' ||
        n.action.id === 'artifact-handoff',
    ))
      if (
        implementations.some(
          (n) =>
            !workspaceChecks.some(
              (scope) => ancestors.get(scope.id).has(n.id) && ancestors.get(check.id).has(scope.id),
            ),
        )
      )
        reject('CHECK_BEFORE_SCOPE', 'Checks должны следовать после workspace-check');
    for (const check of requiredChecks(task)) {
      const candidates = plan.nodes.filter((n) => n.action.id === `check-${check}`);
      if (
        !candidates.length ||
        implementations.some((n) => !candidates.some((c) => ancestors.get(c.id).has(n.id)))
      )
        reject(
          'MISSING_REQUIRED_CHECK',
          `Обязательная проверка ${check} отсутствует после implementation`,
        );
    }
    const reviews = plan.nodes.filter((n) => n.action.id === 'ai-review');
    if (
      implementations.length &&
      (!reviews.length ||
        implementations.some((n) => !reviews.some((r) => ancestors.get(r.id).has(n.id))))
    )
      reject('MISSING_REVIEW', 'Implementation требует независимого review');
    for (const review of reviews)
      for (const check of plan.nodes.filter((n) => n.action.id.startsWith('check-')))
        if (!ancestors.get(review.id).has(check.id))
          reject('REVIEW_BEFORE_CHECKS', 'Review должен учитывать все checks');
  }
  if (plan.taskContract) validateTaskContract(plan.taskContract, task, plan.stage === 'planning' ? [] : plan.nodes);
  freeze(plan);
  return Object.freeze({ plan, hash: hashObject(plan), order: Object.freeze(order), ancestors });
}

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function assertPlanHash(plan, expectedHash) {
  assertJsonBounds(plan);
  if (hashObject(plan) !== expectedHash)
    reject('PLAN_INTEGRITY', 'Immutable plan hash не совпадает');
}

export function compilePlan(task, { runtimeHash, skills, resolveSkills = undefined, resolveReadPaths = undefined, contextHash = undefined, provider = undefined, version = 1, parentPlanHash = null }) {
  const nodes = [];
  const externalProvider = ['claude', 'cursor'].includes(provider);
  const aiReads = [...new Set([...task.scope, ...task.contextPaths, ...REQUIRED_AI_CONTEXT_PATHS])];
  const add = (id, actionId, title, outcome, needs) => {
    const action = resolveAction(actionId);
    nodes.push({
      id,
      title,
      outcome,
      needs,
      action: { id: actionId, version: 1, inputs: {} },
      success: {
        kind: action.kind === 'gate' ? 'gate' : action.kind,
        requiredArtifacts: [...action.artifacts],
      },
      permissions: [...action.permissions],
      skills: [...action.skills],
      resources: {
        reads: actionId.startsWith('ai-') ? aiReads : action.kind === 'gate' ? [] : [...task.scope],
        writes: actionId === 'ai-implement' ? [...task.scope] : [],
        exclusive: actionId === 'ai-implement' ? [...task.resources] : [],
      },
      retry: {
        maxAttempts: Math.min(action.maxAttempts, task.limits.maxAttempts),
        backoffMs: 1000,
      },
    });
  };
  if (externalProvider) add(
    'provider-consent',
    'human-provider-consent',
    'Согласовать передачу ограниченного контекста провайдеру',
    'Отдельное согласие привязано к текущему immutable плану, scope и версии CLI.',
    [],
  );
  add(
    'approve-plan',
    'human-approve',
    'Подтвердить план',
    'Утверждены конкретный план и разрешения',
    externalProvider ? ['provider-consent'] : [],
  );
  add('analyze', 'ai-analyze', 'Понять задачу', 'Подтвержден конкретный путь реализации', [
    'approve-plan',
  ]);
  add('implement', 'ai-implement', 'Реализовать', task.goal, ['analyze']);
  let previous = 'implement';
  add(
    'workspace-check',
    'workspace-check',
    'Проверить изменения',
    'Изменения ограничены утвержденными файлами и каталогами',
    [previous],
  );
  previous = 'workspace-check';
  for (const check of requiredChecks(task)) {
    const title = {
      tests: 'Проверить тесты',
      typecheck: 'Проверить типы',
      lint: 'Проверить стиль кода',
      build: 'Собрать проект',
      'graph-tests': 'Проверить работу графа',
      'shared-build': 'Собрать общие пакеты',
    }[check];
    add(check, `check-${check}`, title, 'Проверка успешно завершена', [previous]);
    previous = check;
  }
  add('review', 'ai-review', 'Провести независимое ревью', 'Нет блокирующих замечаний', [previous]);
  add(
    'handoff',
    'artifact-handoff',
    'Подготовить результат',
    'Доказательства выполнения и изменения собраны для приемки',
    ['review'],
  );
  add(
    'accept-result',
    'human-accept',
    'Принять результат',
    'Владелец принял проверенный результат',
    ['handoff'],
  );
  if (resolveSkills) for (const node of nodes) node.skills = resolveSkills(node, task);
  if (resolveReadPaths) for (const node of nodes) node.resources.reads = resolveReadPaths(node, task);
  const selectedSkills = skills.filter((skill) => nodes.some((node) => node.skills.includes(skill.id)));
  return validatePlan(
    {
      schemaVersion: 2,
      ...(contextHash ? { contextHash } : {}),
      taskHash: hashObject(task),
      version,
      parentPlanHash,
      sourceHash: task.sourceHash,
      runtimeHash,
      registryHash: REGISTRY_HASH,
      policyHash: POLICY_HASH,
      skills: selectedSkills,
      nodes,
    },
    task,
    { runtimeHash, skills, resolveSkills, resolveReadPaths, contextHash, provider },
  );
}
