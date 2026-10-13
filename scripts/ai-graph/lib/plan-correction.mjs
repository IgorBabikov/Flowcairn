export const MAX_PLAN_CORRECTIONS = 2;
const correctable = new Set([
  'PLANNING_SCHEMA', 'PLANNING_CONTRACT', 'PLANNING_READ_SCOPE', 'PLANNING_SCOPE',
  'PLANNING_CYCLE', 'PLANNING_DEPENDENCY', 'PLANNING_DUPLICATE',
  'CONTRACT_ANALYSIS_COVERAGE', 'CONTRACT_ACCEPTANCE_WEAKENED', 'CONTRACT_REQUIREMENT_UNKNOWN',
  'PLAN_CONSISTENCY_SCHEMA', 'PLAN_REQUIREMENT_COVERAGE', 'PLAN_REQUIREMENT_UNKNOWN',
  'PLAN_WORK_ORPHAN', 'PLAN_WORK_UNKNOWN', 'PLAN_WORK_CYCLE', 'PLAN_WORK_DEPENDENCY',
  'PLAN_INTERFACE_AMBIGUOUS', 'PLAN_INTERFACE_CONFLICT', 'PLAN_INTERFACE_PRODUCER',
  'PLAN_INTERFACE_DEPENDENCY', 'PLAN_INTERFACE_MISMATCH', 'PLAN_VERIFIER_MISSING',
]);

/** A failed read-only proposal can be corrected only after its process and writes are reconciled. */
export function planningCorrection({ state, plan, receipt, task = null }) {
  const semantic = plan.workflowPolicy === 'developer-v2' && plan.stage === 'execution' && !state.policyGrant && state.nodes['approve-plan']?.status !== 'passed';
  const planner = plan.nodes.find((node) => semantic ? node.planReview : node.action.id === 'ai-plan');
  const failed = planner && state.nodes[planner.id];
  const code = failed?.reason?.split(':')[0];
  const developer = Boolean(plan.workflowPolicy);
  const allowedCode = semantic ? code === 'PLAN_REVIEW_BLOCKED' : developer ? correctable.has(code) : ['PLANNING_READ_SCOPE', 'CONTRACT_ANALYSIS_COVERAGE'].includes(code);
  if ((!semantic && plan.stage !== 'planning') || failed?.status !== 'failed' || !allowedCode ||
      receipt?.phase !== 'finished' || receipt.nodeId !== planner.id ||
      receipt.termination?.stopped !== true || receipt.termination.uncertain ||
      (semantic && (receipt.exitCode !== 0 || receipt.verdict !== 'fail' || receipt.actionId !== 'ai-analyze' ||
        receipt.termination.timedOut || receipt.termination.outputLimit || receipt.termination.signal !== null)) ||
      typeof receipt.beforeFingerprint !== 'string' || !receipt.beforeFingerprint ||
      receipt.beforeFingerprint !== receipt.afterFingerprint || !Array.isArray(receipt.changedFiles) || receipt.changedFiles.length)
    return { allowed: false, reason: 'PLAN_CORRECTION_UNSAFE', code: code ?? null };
  if (developer && (state.planCorrectionCycles ?? 0) >= MAX_PLAN_CORRECTIONS)
    return { allowed: false, reason: 'PLAN_CORRECTION_BUDGET_EXHAUSTED', code };
  if (!developer) return { allowed: true, reason: null, code,
    feedback: code === 'PLANNING_READ_SCOPE'
      ? `Предыдущий план предложил чтение вне разрешенной области. Используй readPaths только внутри ${JSON.stringify([...new Set([...(task?.scope ?? []), ...(task?.contextPaths ?? [])])].sort())}; не расширяй права.`
      : 'Предыдущий план свел отдельные обязательные пункты анализа к одному требованию. Для каждого пункта создай отдельное mandatory requirement с проверкой и свяжи его с implementation step через requirementIds. Не расширяй scope или права.' };
  return { allowed: true, reason: null, code, nextCycle: (state.planCorrectionCycles ?? 0) + 1,
    feedback: `Предыдущий read-only план отклонен runtime: ${code}. Исправь согласованность плана по исходной постановке: сохрани все обязательные требования, IDs, criteria, constraints, scope и permissions. Свяжи каждое требование с работой и допустимой проверкой; исключи несвязанные работы. Явно укажи реальные needs и согласованные consumes/produces contracts. Используй только разрешенные readPaths и зарегистрированные checks. Missing verifier или существенное неизвестное обозначь честно; не заменяй их PASS и не расширяй права.` };
}
