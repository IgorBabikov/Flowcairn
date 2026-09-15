import { GraphError } from './io.mjs';
import { AIPlanningResultSchema, assertJsonBounds } from './schemas.mjs';
import { compilePlan, validatePlan } from './validator.mjs';
import { resolveAction, pathAllowed } from './registry.mjs';

const fail = (code, message) => { throw new GraphError(code, message); };
const selected = (nodes, skills) => skills.filter((skill) => nodes.some((node) => node.skills.includes(skill.id)));
const externalProvider = (context) => ['claude', 'cursor'].includes(context.provider);

/** The staging graph has no write permission and is never an accepted implementation. */
export function compilePlanningPlan(task, context) {
  const baseline = compilePlan(task, context).plan;
  const consent = externalProvider(context) ? structuredClone(baseline.nodes.find((node) => node.action.id === 'human-provider-consent')) : null;
  if (context.workflow === 'autonomous') {
    const analyze = structuredClone(baseline.nodes.find((n) => n.action.id === 'ai-analyze'));
    analyze.needs = []; analyze.title = 'Анализ задачи и проекта';
    const planner = structuredClone(analyze), action = resolveAction('ai-plan');
    Object.assign(planner, { id: 'plan-task', title: 'План реализации', needs: context.analysisArtifact ? [] : [analyze.id],
      action: { id: action.id, version: action.version, inputs: {} }, skills: [...action.skills] });
    if (context.resolveSkills) planner.skills = context.resolveSkills(planner, task);
    if (context.resolveReadPaths) planner.resources.reads = context.resolveReadPaths(planner, task);
    const terminal = structuredClone(baseline.nodes.find((n) => n.action.id === 'artifact-handoff'));
    terminal.id = 'plan-ready'; terminal.title = 'План подготовлен'; terminal.needs = [planner.id];
    if (consent) {
      if (!context.analysisArtifact) analyze.needs = ['provider-consent'];
      else planner.needs = ['provider-consent'];
    }
    const nodes = [...(consent ? [consent] : []), ...(context.analysisArtifact ? [] : [analyze]), planner, terminal];
    return validatePlan({ ...baseline, workflow: 'autonomous', autonomy: { maxRepairCycles: 2, maxDurationMs: 1800000 },
      ...(context.analysisArtifact ? { analysisArtifact: context.analysisArtifact } : {}), stage: 'planning', skills: selected(nodes, context.skills), nodes }, task, context);
  }
  const approve = structuredClone(baseline.nodes.find((n) => n.action.id === 'human-approve'));
  approve.title = 'Разрешить AI-планирование';
  approve.outcome = 'Подтверждение разрешит выбранному AI прочитать указанный контекст и составить план. Исходники останутся без изменений.';
  const planner = structuredClone(baseline.nodes.find((n) => n.action.id === 'ai-analyze'));
  const action = resolveAction('ai-plan');
  Object.assign(planner, {
    id: 'plan-task', title: 'Составить план задачи', outcome: task.goal,
    action: { id: action.id, version: action.version, inputs: {} },
    skills: [...action.skills],
  });
  if (context.resolveSkills) planner.skills = context.resolveSkills(planner, task);
  if (context.resolveReadPaths) planner.resources.reads = context.resolveReadPaths(planner, task);
  const terminal = structuredClone(baseline.nodes.find((n) => n.action.id === 'human-accept'));
  terminal.title = 'Передать план на компиляцию';
  terminal.outcome = 'Новая версия исполнения требует отдельного подтверждения';
  terminal.needs = [planner.id];
  if (consent) approve.needs = ['provider-consent'];
  const nodes = [...(consent ? [consent] : []), approve, planner, terminal];
  return validatePlan({ ...baseline, stage: 'planning', skills: selected(nodes, context.skills), nodes }, task, context);
}

/** Compile bounded semantic steps. Model data cannot choose executable actions or relax checks. */
export function compileTaskProposal(task, proposalInput, context) {
  assertJsonBounds(proposalInput);
  const result = AIPlanningResultSchema.safeParse(proposalInput);
  if (!result.success) fail('PLANNING_SCHEMA', 'Planning output не соответствует ограниченной schema');
  const proposal = result.data;
  if (proposal.verdict !== 'pass' || proposal.findings.some((f) => f.severity === 'blocking'))
    fail('PLANNING_UNCONFIRMED', 'AI не подтвердил выполнимый план');
  if (!proposal.steps.length || proposal.edits.length || proposal.changedFiles.length)
    fail('PLANNING_CONTRACT', 'Planner должен предложить шаги без изменений файлов');
  const byId = new Map(proposal.steps.map((step) => [step.id, step]));
  if (byId.size !== proposal.steps.length) fail('PLANNING_DUPLICATE', 'Planning step IDs повторяются');
  const active = new Set(), done = new Set(), ordered = [];
  const visit = (id) => {
    if (active.has(id)) fail('PLANNING_CYCLE', 'Planning dependencies содержат цикл');
    if (done.has(id)) return;
    const step = byId.get(id);
    if (!step) fail('PLANNING_DEPENDENCY', 'Planning dependency отсутствует');
    if (step.id.length > 60 || new Set(step.needs).size !== step.needs.length)
      fail('PLANNING_DEPENDENCY', 'Planning IDs/dependencies недопустимы');
    if (step.paths.some((file) => !pathAllowed(file, task)))
      fail('PLANNING_SCOPE', 'Planning step выходит за утвержденный scope');
    active.add(id);
    for (const dependency of step.needs) visit(dependency);
    active.delete(id); done.add(id); ordered.push(step);
  };
  for (const step of proposal.steps) visit(step.id);
  const baseline = compilePlan(task, context).plan;
  const template = baseline.nodes.find((node) => node.action.id === 'ai-implement');
  const approval = structuredClone(baseline.nodes.find((node) => node.action.id === 'human-approve'));
  const consent = externalProvider(context) ? structuredClone(baseline.nodes.find((node) => node.action.id === 'human-provider-consent')) : null;
  if (consent) approval.needs = ['provider-consent'];
  const nodes = [...(consent ? [consent] : []), approval];
  let previous = 'approve-plan';
  for (const step of ordered) {
    const node = structuredClone(template);
    Object.assign(node, { id: `step-${step.id}`, title: step.title, outcome: step.outcome,
      // Serial compiler fence supplements declared dependencies because AI nodes read shared context.
      needs: [...new Set([previous, ...step.needs.map((id) => `step-${id}`)])],
      resources: { ...node.resources, writes: [...step.paths] } });
    if (context.resolveSkills) node.skills = context.resolveSkills(node, task);
    if (context.resolveReadPaths) node.resources.reads = context.resolveReadPaths(node, task);
    nodes.push(node); previous = node.id;
  }
  for (const original of baseline.nodes.filter((node) => !['human-approve', 'ai-analyze', 'ai-implement'].includes(node.action.id))) {
    const node = structuredClone(original);
    if (node.action.id === 'workspace-check') node.needs = [previous];
    nodes.push(node);
  }
  const executable = context.workflow === 'autonomous' ? nodes.filter((n) => n.action.id !== 'human-accept') : nodes;
  if (context.workflow === 'autonomous') {
    executable.at(-1).title = 'Готово к личному ревью';
    executable.at(-1).outcome = 'Реализация, проверки и независимое ревью завершены';
  }
  return validatePlan({ ...baseline, stage: 'execution', ...(context.workflow === 'autonomous' ? { workflow: 'autonomous', autonomy: { maxRepairCycles: 2, maxDurationMs: 1800000 } } : {}), nodes: executable, skills: selected(executable, context.skills) }, task, context);
}
