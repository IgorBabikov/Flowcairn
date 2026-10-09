import { GraphError, hashObject } from './io.mjs';
import { PlanChecksSchema } from './check-schemas.mjs';
// Keep the legacy import surface for service/replan callers while stages are compiled centrally.
export { buildExecutionStages as singleExecutionStage } from './stage-plan.mjs';

export function validatePlanChecks(plan, task, currentChecks = null) {
  if (plan.schemaVersion !== 3) return;
  const checks = PlanChecksSchema.parse(plan.checks);
  const ids = checks.definitions.map((check) => check.id);
  if (task.schemaVersion !== 3 || hashObject(checks) !== plan.checkRegistryHash || new Set(ids).size !== ids.length ||
      new Set(checks.bindings.map((check) => check.id)).size !== ids.length || checks.bindings.length !== ids.length ||
      checks.definitions.some((check) => checks.bindings.find((bound) => bound.id === check.id)?.definitionHash !== hashObject(check)) ||
      task.checks.some((id) => !ids.includes(id)) || new Set(task.checks).size !== task.checks.length)
    throw new GraphError('CHECK_REGISTRY_INVALID', 'План не связан с полным registry проверок.');
  if (currentChecks && hashObject(currentChecks) !== plan.checkRegistryHash)
    throw new GraphError('CHECK_REGISTRY_DRIFT', 'Registry или окружение проверок изменились.');
}
