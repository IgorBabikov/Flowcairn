import { ReceiptSchema } from './schemas.mjs';
import { hashObject } from './io.mjs';
import { resolveAction } from './registry.mjs';
import { boundCheckVerification } from './check-verification.mjs';

const ENVIRONMENT_CODES = new Set([
  'CHECK_EXECUTABLE_MISSING', 'CHECK_SCRIPT_MISSING', 'CHECK_CWD_INVALID',
  'CHECK_UNAVAILABLE', 'CHECK_SHELL_CONFIG_UNSUPPORTED', 'LOCAL_CHECK_TOOLCHAIN',
  'LOCAL_CHECK_NODE_VERSION', 'LOCAL_CHECK_UNAVAILABLE', 'RUNNER_CHECK_CONTAINMENT_UNAVAILABLE',
  'CODEX_AUTH_REQUIRED', 'PROVIDER_AUTH_REQUIRED', 'SDK_MISSING', 'ENVIRONMENT_MISSING',
  'ENOENT', 'EACCES', 'EPERM', 'PATCH_HANDLER_MISSING',
]);
const VERIFIER_CODES = new Set([
  'CHECK_REGISTRY_MISSING', 'CHECK_REGISTRY_DRIFT', 'CHECK_INPUT_DRIFT',
  'CHECK_NOT_REGISTERED', 'CHECK_NOT_CONFIGURED', 'CHECK_UNSUPPORTED', 'CHECKS_NOT_ENABLED',
  'CHECK_LOCAL_BINDING_REQUIRED', 'CHECK_DESCENDANT_CONTAINMENT_UNVERIFIED',
  'PLAN_VERIFIER_MISSING', 'VERIFIER_MISSING', 'UNKNOWN_ACTION',
  'CHECK_REPORT_UNSAFE', 'CHECK_REPORT_DRIFT', 'CHECK_REPORT_MISSING', 'CHECK_REPORT_INVALID', 'CHECK_REPORT_STALE', 'CHECK_REPORT_UNVERIFIED',
  'CHECK_PATH_UNSAFE', 'CHECK_INPUT_UNSAFE', 'CONTEXT_LINK_UNSAFE', 'CONTEXT_FILE_UNSAFE', 'CONTEXT_ENCODING', 'CONTEXT_PATH_UNSAFE',
]);
const PROCESS_CODES = new Set([
  'TIMEOUT', 'OUTPUT_LIMIT', 'ABORTED', 'PARENT_DISCONNECTED',
  'START_NOT_ACKNOWLEDGED', 'PROCESS_STOP_UNCONFIRMED',
]);
const PROPOSAL_REJECTION_CODES = new Set(['AI_SCOPE', 'AI_RESULT_SCHEMA', 'PATCH_FILES_MISMATCH', 'PATCH_DENIED']);
const decision = (category, route, code) => ({ category, route, code });
const reasonCode = (value) => typeof value === 'string' ? value.match(/^([A-Z][A-Z0-9_]*)(?::|$)/)?.[1] : null;

function registeredCheck(plan, definition) {
  try { resolveAction(definition.action.id, definition.action.version, definition.action.inputs ?? {}, plan.schemaVersion === 3 ? plan.checks : null); }
  catch { return false; }
  if (plan.schemaVersion !== 3) return true;
  const id = definition.action.id.slice('check-'.length);
  return plan.checks && plan.checkRegistryHash === hashObject(plan.checks) &&
    plan.checks.definitions.some((check) => check.id === id) &&
    plan.checks.bindings.some((check) => check.id === id);
}

/**
 * Pure scheduling decision after the host's verified read. A route never grants
 * permissions, rewrites state or upgrades a failure to requirement evidence.
 * Free-text diagnostics can only stop repair, never establish an assertion cause.
 * @param {{state: any, plan: any, definition: any, node: any, receipt: any, semanticReview?: boolean, rejectedImplementation?: boolean}} input
 */
export function classifyDevelopmentFailure({ state, plan, definition, node, receipt, semanticReview = false, rejectedImplementation = false }) {
  const parsed = ReceiptSchema.safeParse(receipt);
  if (!parsed.success) return decision('process', 'recovery', 'RECEIPT_UNAVAILABLE');
  const completed = parsed.data;
  if (!definition || completed.runId !== state.runId || completed.nodeId !== definition.id ||
      completed.actionId !== definition.action.id || completed.actionVersion !== definition.action.version ||
      completed.planHash !== state.planHash || completed.planVersion !== plan.version)
    return decision('verifier', 'diagnostic', 'FAILURE_RECEIPT_MISMATCH');
  const code = reasonCode(completed.failureReason) ?? reasonCode(node?.reason);
  const termination = completed.termination;
  if (completed.phase !== 'finished' || !completed.finishedAt || !termination ||
      termination.stopped !== true || termination.uncertain !== false ||
      termination.timedOut || termination.outputLimit || termination.signal !== null ||
      completed.exitCode === null || completed.exitCode < 0 ||
      PROCESS_CODES.has(code) || /^(?:RUNNER_.*(?:TIMEOUT|CONTROL|IDENTITY)|PROCESS_)/.test(code ?? ''))
    return decision('process', 'recovery', code ?? 'PROCESS_OUTCOME_UNCONFIRMED');
  if ([126, 127].includes(completed.exitCode) || completed.checks.some((check) => [126, 127].includes(check.exitCode)) || ENVIRONMENT_CODES.has(code))
    return decision('environment', 'diagnostic', code ?? 'CHECK_TOOL_UNAVAILABLE');
  if (VERIFIER_CODES.has(code) || code?.startsWith('REVIEW_EVIDENCE_'))
    return decision('verifier', 'diagnostic', code);
  if (/^(?:PLANNING_|PLAN_|CONTRACT_)/.test(code ?? '') || code === 'ANALYSIS_REQUIRED')
    return decision('plan', 'plan-correction', code);
  if (node?.status !== 'failed' || completed.verdict !== 'fail')
    return decision('unknown', 'diagnostic', 'FAILURE_STATUS_UNCONFIRMED');
  if (completed.beforeFingerprint !== completed.afterFingerprint || completed.changedFiles.length)
    return decision('verifier', 'diagnostic', 'FAILURE_SOURCE_CHANGED');
  if (definition.action.id.startsWith('check-')) {
    if (!registeredCheck(plan, definition)) return decision('verifier', 'diagnostic', 'CHECK_NOT_REGISTERED');
    const check = completed.checks.length === 1 && completed.checks[0];
    if (!check || check.id !== definition.id || check.passed || check.exitCode === null ||
        check.exitCode === 0 || check.exitCode !== completed.exitCode || check.inputHash !== completed.beforeFingerprint)
      return decision('verifier', 'diagnostic', 'CHECK_RESULT_UNCONFIRMED');
    const report = check.verification;
    if (report && boundCheckVerification(plan, definition, check) && report.status === 'failed' && report.countsConfirmed &&
        report.format === 'flowcairn-node-test/v1' && report.counts.completed > 0 && report.counts.failed > 0 &&
        report.assertionFailures === report.counts.failed)
      return decision('implementation', 'source-repair', 'VERIFIED_ASSERTION_FAILURE');
    const scenarioReasons = new Set(['REPORT_UNEXPECTED_OUTCOME', 'REPORT_REQUIRED_SCENARIO_NOT_PASSED',
      'REPORT_CASE_FAILED', 'REPORT_RUN_FAILURES', 'REPORT_NATIVE_SUMMARY_FAILED', 'REPORT_NON_CASE_FAILURE']);
    if (report && boundCheckVerification(plan, definition, check) && report.status === 'failed' && report.countsConfirmed &&
        report.counts.completed > 0 && report.counts.failed > 0 && ['playwright-json', 'flowcairn-xctest/v1', 'flowcairn-android-node/v1', 'jest-json'].includes(report.format) &&
        report.reasonCodes.every((code) => scenarioReasons.has(code)) &&
        (!['flowcairn-xctest/v1', 'flowcairn-android-node/v1'].includes(report.format) || report.artifactHash && report.environmentHash) &&
        (report.format !== 'flowcairn-android-node/v1' || report.artifactPath && report.assertionFailures === report.counts.failed))
      return decision('verification', 'diagnosis-repair', 'VERIFIED_SCENARIO_FAILURE');
    // Nonzero status or assertion-looking text alone cannot establish the cause.
    return decision('unknown', 'diagnostic', 'CHECK_FAILURE_CAUSE_UNVERIFIED');
  }
  if (definition.action.id === 'ai-review' && semanticReview && completed.exitCode === 0)
    return decision('implementation', 'source-repair', 'BLOCKING_SEMANTIC_REVIEW');
  if (definition.action.id === 'ai-implement' && completed.exitCode === 0 &&
      (rejectedImplementation || PROPOSAL_REJECTION_CODES.has(code)))
    return decision('implementation', 'source-repair', 'PREWRITE_IMPLEMENTATION_REJECTED');
  return decision('unknown', 'diagnostic', 'FAILURE_CAUSE_UNVERIFIED');
}
