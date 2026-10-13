import { GraphError } from './io.mjs';
import { Id, PlanningStepSchema, TaskContractSchema, assertJsonBounds } from './schemas.mjs';

const fail = (code, message) => { throw new GraphError(code, message); };

/**
 * Validate new semantic proposals without changing source, permissions or old plans.
 * Dependencies are the declared step needs, before the compiler adds a serial fence.
 * @param {{ taskContract: import('./schemas.mjs').GraphPlan['taskContract'], steps: unknown[] }} input
 */
export function validatePlanConsistency({ taskContract, steps }) {
  assertJsonBounds({ taskContract, steps });
  const parsedContract = TaskContractSchema.safeParse(taskContract);
  if (!parsedContract.success || !Array.isArray(steps) || !steps.length)
    fail('PLAN_CONSISTENCY_SCHEMA', 'Для проверки согласованности нужны контракт и непустые работы.');
  const parsedSteps = steps.map((step) => PlanningStepSchema.safeParse(step));
  if (parsedSteps.some((step) => !step.success))
    fail('PLAN_CONSISTENCY_SCHEMA', 'Работы или их interfaces не соответствуют строгой schema.');
  const work = parsedSteps.map((step) => step.data);
  const contract = parsedContract.data;
  const byId = new Map(work.map((step) => [step.id, step]));
  if (byId.size !== work.length) fail('PLAN_WORK_DUPLICATE', 'Идентификаторы работ повторяются.');
  const nodeIds = new Set(work.map((step) => `step-${step.id}`));
  if ([...nodeIds].some((id) => !Id.safeParse(id).success))
    fail('PLAN_WORK_ID', 'Идентификатор работы не помещается в compiler-owned node ID.');

  const active = new Set(), ancestors = new Map();
  const visit = (id) => {
    if (active.has(id)) fail('PLAN_WORK_CYCLE', 'Зависимости работ содержат цикл.');
    if (ancestors.has(id)) return ancestors.get(id);
    const step = byId.get(id);
    if (!step) fail('PLAN_WORK_UNKNOWN', 'Зависимость ссылается на неизвестную работу.');
    if (new Set(step.needs).size !== step.needs.length)
      fail('PLAN_WORK_DEPENDENCY', 'Зависимости работы повторяются.');
    active.add(id);
    const dependencies = new Set();
    for (const dependency of step.needs) {
      dependencies.add(dependency);
      for (const ancestor of visit(dependency)) dependencies.add(ancestor);
    }
    active.delete(id);
    ancestors.set(id, dependencies);
    return dependencies;
  };
  for (const step of work) visit(step.id);

  const requirementIds = new Set(contract.requirements.map((requirement) => requirement.id));
  if (requirementIds.size !== contract.requirements.length)
    fail('PLAN_REQUIREMENT_DUPLICATE', 'Идентификаторы требований повторяются.');
  for (const step of work) if (step.requirementIds?.some((id) => !requirementIds.has(id)))
    fail('PLAN_REQUIREMENT_UNKNOWN', 'Работа ссылается на неизвестное требование.');
  for (const requirement of contract.requirements) {
    if (requirement.workIds.some((id) => !nodeIds.has(id)))
      fail('PLAN_WORK_UNKNOWN', 'Требование ссылается на неизвестную работу.');
    if (requirement.mandatory && !requirement.workIds.length)
      fail('PLAN_REQUIREMENT_COVERAGE', 'Обязательное требование не связано с работой плана.');
    if (requirement.mandatory && requirement.verification.method === 'check' && !requirement.verification.checkIds.length)
      fail('PLAN_VERIFIER_MISSING', 'Обязательное требование не связано с исполнимой проверкой.');
    if (requirement.mandatory && requirement.verification.method !== 'human' && !requirement.verification.paths.length)
      fail('PLAN_VERIFIER_MISSING', 'Объективная проверка требования не имеет области результата.');
  }
  const linkedNodeIds = new Set(contract.requirements.flatMap((requirement) => requirement.workIds));
  const supportedWork = new Set();
  for (const step of work) if (linkedNodeIds.has(`step-${step.id}`)) {
    supportedWork.add(step.id);
    for (const dependency of ancestors.get(step.id)) supportedWork.add(dependency);
  }
  if (work.some((step) => !supportedWork.has(step.id)))
    fail('PLAN_WORK_ORPHAN', 'Работа не выполняет требование и не является объявленной зависимостью связанной работы.');

  const producers = new Map();
  for (const step of work) for (const output of step.produces ?? []) {
    const previous = producers.get(output.id);
    if (previous) fail(previous.contract === output.contract ? 'PLAN_INTERFACE_AMBIGUOUS' : 'PLAN_INTERFACE_CONFLICT',
      'Interface должен иметь одного однозначного producer и неизмененный contract.');
    producers.set(output.id, { producerId: step.id, contract: output.contract });
  }
  for (const step of work) {
    const consumed = new Set();
    for (const input of step.consumes ?? []) {
      if (consumed.has(input.id)) fail('PLAN_INTERFACE_AMBIGUOUS', 'Consumer повторяет interface reference.');
      consumed.add(input.id);
      const producer = producers.get(input.id);
      if (!byId.has(input.producerId) || !producer || producer.producerId !== input.producerId)
        fail('PLAN_INTERFACE_PRODUCER', 'Consumer ссылается на отсутствующий либо неверный producer interface.');
      if (!ancestors.get(step.id).has(input.producerId))
        fail('PLAN_INTERFACE_DEPENDENCY', 'Consumer должен явно зависеть от producer interface.');
      if (producer.contract !== input.contract)
        fail('PLAN_INTERFACE_MISMATCH', 'Produced и consumed interface contracts не совпадают.');
    }
  }

  // This is planned traceability only. Unknowns and human acceptance remain open.
  return {
    status: 'structurally-valid',
    semanticStatus: 'unassessed',
    verificationStatus: 'pending',
    humanRequirementIds: contract.requirements.filter((requirement) => requirement.mandatory &&
      requirement.verification.method === 'human').map((requirement) => requirement.id),
    unknowns: [...contract.unknowns],
  };
}
