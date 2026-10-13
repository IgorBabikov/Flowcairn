import { GraphError } from './io.mjs';
import { validatePlanConsistency } from './plan-consistency.mjs';

/** Enforce the same structural contract at the final pre-write boundary, including direct drafts. */
export function validateExecutionPlanConsistency(plan) {
  if (!['developer-v1', 'developer-v2'].includes(plan.workflowPolicy) || plan.stage === 'planning') return null;
  if (!plan.taskContract) throw new GraphError('PLAN_CONTRACT_MISSING', 'Developer execution требует исходный контракт.');
  for (const requirement of plan.taskContract.requirements) {
    if (!requirement.mandatory || requirement.verification.method !== 'check') continue;
    for (const actionId of requirement.verification.checkIds) {
      const definition = plan.checks?.definitions.find((check) => `check-${check.id}` === actionId);
      if (!definition?.report)
        throw new GraphError('PLAN_VERIFIER_MISSING', 'Обязательное check-требование developer workflow требует зарегистрированный scenario report; exit code не доказывает критерий.');
    }
  }
  const nodes = plan.nodes.filter((node) => node.action.id === 'ai-implement');
  const ids = new Map(nodes.map((node, index) => [node.id, `work-${index + 1}`]));
  const rawId = (id) => {
    const value = ids.get(id);
    if (!value) throw new GraphError('PLAN_WORK_UNKNOWN', 'Contract/interface ссылается на отсутствующую работу.');
    return value;
  };
  const all = new Map(plan.nodes.map((node) => [node.id, node]));
  const ancestors = (node) => {
    const found = new Set();
    const visit = (id) => { if (found.has(id)) return; found.add(id); for (const parent of all.get(id)?.needs ?? []) visit(parent); };
    for (const id of node.needs) visit(id);
    return found;
  };
  const steps = nodes.map((node) => {
    if (!Array.isArray(node.declaredNeeds))
      throw new GraphError('PLAN_WORK_DEPENDENCY', 'Developer work требует explicit declaredNeeds.');
    const linked = ancestors(node);
    if (node.declaredNeeds.some((id) => !linked.has(id)))
      throw new GraphError('PLAN_WORK_DEPENDENCY', 'Declared dependency отсутствует в исполняемом плане.');
    return { id: rawId(node.id), title: node.title, outcome: node.outcome, paths: node.resources.writes,
      needs: node.declaredNeeds.map(rawId),
      ...(node.produces !== undefined ? { produces: node.produces } : {}),
      ...(node.consumes !== undefined ? { consumes: node.consumes.map((item) => ({ ...item, producerId: rawId(item.producerId) })) } : {}),
    };
  });
  const contract = { ...plan.taskContract, requirements: plan.taskContract.requirements.map((item) => ({ ...item,
    workIds: item.workIds.map((id) => `step-${rawId(id)}`),
  })) };
  return validatePlanConsistency({ taskContract: contract, steps });
}
