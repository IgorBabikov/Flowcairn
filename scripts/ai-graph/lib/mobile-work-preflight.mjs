import { GraphError, hashObject } from './io.mjs';
import { discoverStackProfile } from './stack-profile.mjs';
import { inspectMobilePreflight } from './mobile-recipes.mjs';
import { projectCheckProfile, inspectCheckProfile } from './check-profile.mjs';

const nativeFormats = new Set(['flowcairn-xctest/v1', 'flowcairn-android-node/v1']);
const inside = (file, scope) => scope === '.' || file === scope || file.startsWith(`${scope}/`);
const codeFor = finding => finding.code === 'MOBILE_HOST_INCOMPATIBLE' || finding.code === 'MOBILE_PREREQUISITE_MISSING' ||
  finding.code === 'MOBILE_PREREQUISITE_INCOMPATIBLE' ? 'SDK_MISSING'
  : finding.code === 'MOBILE_TOOLCHAIN_UNAVAILABLE' ? finding.cause ?? 'CHECK_UNAVAILABLE'
    : finding.code === 'MOBILE_TARGET_UNRESOLVED' ? 'PLANNING_MOBILE_TARGET' : 'VERIFIER_MISSING';

/** A native work guard uses owner registration; ordinary component/source review
 * does not acquire new device obligations. Unknown live SDK facts remain pending.
 * @param {{root:string,profile:any,task:any,plan:any,node:any,hostPlatform?:string}} input
 */
export function inspectMobileWorkPreflight({ root, profile, task, plan, node, hostPlatform = process.platform }) {
  if (!profile.developmentWorkflow || node.action.id !== 'ai-implement') return null;
  const checks = projectCheckProfile(root, profile);
  const related = new Set((plan.taskContract?.requirements ?? []).filter(requirement => requirement.mandatory &&
    requirement.workIds.includes(node.id)).flatMap(requirement => requirement.verification.checkIds.map(id => id.replace(/^check-/, ''))));
  const nativeIds = checks.definitions.filter(definition => related.has(definition.id) && nativeFormats.has(definition.report?.format)).map(({ id }) => id);
  const capabilities = (profile.developmentWorkflow.capabilities ?? []).filter(capability =>
    /^mobile-(?:ios|android)-(?:build|scenario)$/.test(capability.id) && capability.checkIds.some(id => related.has(id)) &&
    (capability.scope ?? ['.']).some(scope => (node.resources.writes.length ? node.resources.writes : task.scope)
      .some(file => inside(file, scope) || inside(scope, file))));
  if (!nativeIds.length && !capabilities.length) return null;
  for (const capability of capabilities) {
    const expected = capability.id.startsWith('mobile-ios-') ? 'flowcairn-xctest/v1' : 'flowcairn-android-node/v1';
    if (capability.checkIds.some(id => checks.definitions.find(definition => definition.id === id)?.report?.format !== expected))
      throw new GraphError('VERIFIER_MISSING', 'Зарегистрированная проверка не имеет подходящего native report format; source write остановлен.');
  }
  const requiresIos = capabilities.some(capability => capability.id.startsWith('mobile-ios-')) ||
    checks.definitions.some(definition => nativeIds.includes(definition.id) && definition.report?.format === 'flowcairn-xctest/v1');
  if (requiresIos && plan.workflowPolicy === 'developer-v2' && checks.definitions.some(definition =>
    related.has(definition.id) && definition.report?.format === 'flowcairn-xctest/v1' && !definition.report.xctest))
    throw new GraphError('VERIFIER_MISSING', 'Native iOS проверка требует регистрации текущих .app и .xcresult до source write.');
  if (requiresIos && hostPlatform !== 'darwin') throw new GraphError('SDK_MISSING', 'Native iOS проверка требует macOS/Xcode; source write остановлен.');
  const stack = discoverStackProfile(root, { scope: node.resources.writes.length ? node.resources.writes : task.scope,
    manifestPaths: profile.manifests });
  const result = inspectMobilePreflight(root, { stack, capabilities, checkProfile: checks, hostPlatform });
  if (result.status === 'not-applicable') {
    // Owner native registration can support an unrecognized project/build system.
    // It supplies a verifier, never a guessed framework or live SDK availability.
    const binding = inspectCheckProfile(root, checks);
    const pending = { version: 1, guidanceOnly: true, acceptance: 'unverified', status: 'needs-probe',
      stackHash: stack.hash, registrationHash: hashObject(binding), hostPlatform,
      recipes: [], findings: [{ code: 'MOBILE_FRAMEWORK_UNKNOWN' }, { code: 'MOBILE_PREREQUISITE_UNKNOWN' }] };
    return { ...pending, hash: hashObject(pending) };
  }
  if (result.status === 'blocked') {
    const findings = [...result.findings, ...result.recipes.flatMap(recipe => recipe.findings)];
    const known = findings.find(finding => !['MOBILE_PREREQUISITE_UNKNOWN', 'MOBILE_TOOLCHAIN_UNVERIFIED'].includes(finding.code));
    throw new GraphError(codeFor(known ?? { code: 'MOBILE_RECIPE_UNSUPPORTED' }),
      'Native mobile проверка не подготовлена; исправьте выбранную среду или регистрацию verifier до source write.',
      { preflightHash: result.hash, findings });
  }
  return result;
}
