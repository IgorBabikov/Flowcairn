import { GraphError, hashObject } from './io.mjs';
import { ExecutionStagesSchema } from './stage-schemas.mjs';

const fail = (code, message) => { throw new GraphError(code, message); };
const stagePrefix = (index) => `s${String(index + 1).padStart(2, '0')}`;
export const stageScopeId = (index) => `${stagePrefix(index)}-workspace-check`;
export const stageCheckId = (index, checkId) => `${stagePrefix(index)}-check-${checkId}`;

/** Compute the execution budget before asking a provider for semantic steps. */
export function planningStepLimit(task, { workflow = undefined, provider = undefined, nodes = [] } = {}) {
  if (task.schemaVersion !== 3) return 12;
  const checkCount = task.checks.length;
  if (!checkCount) return 1; // An inert, readable plan; never a verified stage.
  const consent = ['claude', 'cursor'].includes(provider) || nodes.some((node) => node.action.id === 'human-provider-consent');
  const gateCount = 1 + Number(consent) + Number(workflow !== 'autonomous');
  return Math.min(12, Math.floor((64 - gateCount - 2) / (2 + checkCount)));
}

/** Rebuild immutable stage metadata from compiler-owned node IDs after contract rebinding. */
export function buildExecutionStages(nodes, taskContract = null) {
  const implementations = nodes.filter((node) => node.action.id === 'ai-implement');
  const checks = nodes.filter((node) => node.action.id.startsWith('check-'));
  const scopes = nodes.filter((node) => node.action.id === 'workspace-check');
  const reviews = nodes.filter((node) => node.action.id === 'ai-review');
  const handoffs = nodes.filter((node) => node.action.id === 'artifact-handoff');
  if (new Set(nodes.map((node) => node.id)).size !== nodes.length || !implementations.length || implementations.length > 12 ||
      scopes.length !== implementations.length || reviews.length !== 1 || handoffs.length !== 1 ||
      nodes.some((node) => node.resources.writes.length && node.action.id !== 'ai-implement'))
    fail('STAGE_CONTRACT', 'Нет однозначного полного набора работ и границ этапов.');
  const finalChecks = checks.filter((node) => !/^s\d{2}-/.test(node.id));
  if (implementations.length > 1 && !finalChecks.length)
    fail('STAGE_VERIFIER_REQUIRED', 'Для нескольких этапов нужна зарегистрированная исполнимая проверка.');
  const stages = implementations.map((work, index) => {
    const final = index === implementations.length - 1;
    const scopeId = final ? 'workspace-check' : stageScopeId(index);
    const scope = scopes.find((node) => node.id === scopeId);
    const stageChecks = final ? finalChecks : checks.filter((node) => node.id.startsWith(`${stagePrefix(index)}-`));
    if (!scope || stageChecks.some((node) => !final && node.id !== stageCheckId(index, node.action.id.slice(6))))
      fail('STAGE_CONTRACT', 'Идентификаторы проверок не соответствуют этапу.');
    return { id: `stage-${String(index + 1).padStart(2, '0')}`, title: work.title, outcome: work.outcome,
      implementationNodeIds: [work.id],
      requirementIds: taskContract?.requirements.filter((requirement) => requirement.workIds.includes(work.id)).map((requirement) => requirement.id) ?? [],
      scopeCheckNodeId: scope.id, checkNodeIds: stageChecks.map((node) => node.id),
      boundaryNodeId: final ? handoffs[0].id : stageChecks.at(-1)?.id ?? scope.id };
  });
  if (stages.flatMap((stage) => stage.checkNodeIds).length !== checks.length)
    fail('STAGE_CONTRACT', 'Каждая проверка должна принадлежать ровно одному этапу.');
  return ExecutionStagesSchema.parse({ version: 1, stages,
    finalCheckNodeIds: finalChecks.map((node) => node.id), finalReviewNodeId: reviews[0].id, handoffNodeId: handoffs[0].id });
}

/** Host structural checks are separate from successful execution receipts. */
export function assertExecutionStages(plan, task, ancestors) {
  if (plan.schemaVersion !== 3 || plan.stage === 'planning') return;
  const expected = buildExecutionStages(plan.nodes, plan.taskContract);
  if (hashObject(expected) !== hashObject(plan.executionStages))
    fail('STAGE_CONTRACT', 'Границы этапов не соответствуют работам, проверкам или требованиям плана.');
  const byId = new Map(plan.nodes.map((node) => [node.id, node]));
  const follows = (nodeId, dependency) => nodeId === dependency || ancestors.get(nodeId)?.has(dependency);
  for (const [index, stage] of expected.stages.entries()) {
    const workId = stage.implementationNodeIds[0];
    if (index && !ancestors.get(workId)?.has(expected.stages[index - 1].boundaryNodeId))
      fail('STAGE_ORDER', 'Следующая работа должна ждать проверенную границу предыдущего этапа.');
    if (!ancestors.get(stage.scopeCheckNodeId)?.has(workId))
      fail('STAGE_SCOPE', 'Проверка области должна следовать после работы своего этапа.');
    const actualChecks = stage.checkNodeIds.map((id) => byId.get(id).action.id.slice(6));
    if (actualChecks.length !== task.checks.length || new Set(actualChecks).size !== actualChecks.length ||
        task.checks.some((id) => !actualChecks.includes(id)))
      fail('STAGE_REQUIRED_CHECKS', 'Каждый этап должен содержать все обязательные зарегистрированные проверки.');
    for (const checkId of stage.checkNodeIds) {
      if (!ancestors.get(checkId)?.has(stage.scopeCheckNodeId) || !follows(stage.boundaryNodeId, checkId))
        fail('STAGE_BOUNDARY', 'Граница этапа должна ждать проверки после контроля области изменений.');
    }
    if (!follows(stage.boundaryNodeId, stage.scopeCheckNodeId))
      fail('STAGE_BOUNDARY', 'Граница этапа должна ждать контроль области изменений.');
    if (!ancestors.get(expected.finalReviewNodeId)?.has(workId) ||
        !ancestors.get(expected.finalReviewNodeId)?.has(stage.scopeCheckNodeId) ||
        stage.checkNodeIds.some((id) => !ancestors.get(expected.finalReviewNodeId)?.has(id)))
      fail('STAGE_FINAL_REVIEW', 'Финальное ревью должно учитывать все работы и проверки.');
  }
  if (!ancestors.get(expected.handoffNodeId)?.has(expected.finalReviewNodeId))
    fail('STAGE_FINAL_REVIEW', 'Передача результата должна ждать независимое финальное ревью.');
}
