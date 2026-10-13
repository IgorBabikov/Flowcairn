import { GraphError, hashObject } from './io.mjs';
import { assertJsonBounds } from './schemas.mjs';
import { inspectCheckProfile } from './check-profile.mjs';
import { readContextFile } from './project-context.mjs';
import { parseStackManifest } from './stack-profile.mjs';
import path from 'node:path';

// Method data only: no command templates, package installs or SDK/device discovery.
export const MOBILE_RECIPES = Object.freeze([
  Object.freeze({ id: 'react-native-expo', frameworks: Object.freeze(['react-native', 'expo']),
    platforms: Object.freeze(['android', 'ios']), prerequisites: Object.freeze(['node', 'project-mobile-runner']),
    runner: 'Preserve the installed React Native/Expo runner and native project. Component tests do not prove a native scenario. Expo generation/prebuild requires separate approved write scope.',
    documentation: 'https://github.com/expo/expo/blob/main/docs/pages/guides/local-app-development.mdx' }),
  Object.freeze({ id: 'flutter', frameworks: Object.freeze(['flutter']),
    platforms: Object.freeze(['android', 'ios']), prerequisites: Object.freeze(['flutter-sdk', 'dart-sdk']),
    runner: 'Preserve the project Flutter/Dart toolchain and existing widget/integration_test runner. Native system UI may require the existing native UI suite; do not replace it.',
    documentation: 'https://github.com/flutter/website/blob/main/sites/docs/src/content/testing/integration-tests/index.md' }),
  Object.freeze({ id: 'native-android', frameworks: Object.freeze(['android']),
    platforms: Object.freeze(['android']), prerequisites: Object.freeze(['gradle-wrapper']),
    runner: 'Preserve the project Gradle wrapper, Android Gradle plugin, SDK and Compose/Espresso/UI Automator suite. JVM unit tests do not prove an instrumented device scenario.',
    documentation: 'https://developer.android.com/build/gradle-build-overview' }),
  Object.freeze({ id: 'native-ios', frameworks: Object.freeze(['ios']),
    platforms: Object.freeze(['ios']), prerequisites: Object.freeze([]),
    runner: 'Preserve the existing Xcode project/scheme and Swift language settings, XCTest/Swift Testing and native UI suite. A Swift package declaration alone does not prove an app build.',
    documentation: 'https://developer.apple.com/documentation/xcode/running-tests-and-interpreting-results' }),
]);
const PLATFORMS = Object.freeze({
  android: Object.freeze({ hosts: Object.freeze(['darwin', 'win32', 'linux']), prerequisites: Object.freeze(['jdk', 'android-sdk', 'android-device']), nativeFormats: Object.freeze(['flowcairn-android-node/v1']) }),
  ios: Object.freeze({ hosts: Object.freeze(['darwin']), prerequisites: Object.freeze(['xcode', 'ios-sdk', 'ios-device']), nativeFormats: Object.freeze(['flowcairn-xctest/v1']) }),
});
const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const inside = (file, scope) => scope === '.' || file === scope || file.startsWith(`${scope}/`);
const overlaps = (a, b) => inside(a, b) || inside(b, a);
const scoped = (entry, scope) => (entry.scope ?? ['.']).some((candidate) => overlaps(candidate, scope));
const sorted = (values) => [...new Set(values)].sort();
const issue = (code, detail = {}) => ({ code, ...detail });

/** Derive families only from the scoped, source-bound stack profile, never task prose. */
export function selectMobileRecipes(stack, ownerPackages = []) {
  assertJsonBounds({ stack, ownerPackages }, 100000);
  if (!stack || stack.version !== 1 || stack.guidanceOnly !== true || !Array.isArray(stack.packages) || !hash(stack.hash))
    throw new GraphError('MOBILE_STACK_INVALID', 'Нужен scoped source-bound stack profile.');
  const families = [...stack.packages, ...ownerPackages.filter((owner) => !stack.packages.some(({ path: file }) => file === owner.path))].map((pkg) => {
    const ids = pkg.frameworks.filter(({ domain }) => domain === 'mobile').map(({ id }) => id);
    // Cross-platform owners win over their generated native subprojects; .NET is not native Kotlin/Swift.
    const recipe = ids.includes('expo') || ids.includes('react-native') ? MOBILE_RECIPES[0]
      : ids.includes('flutter') ? MOBILE_RECIPES[1]
        : pkg.frameworks.some(({ id }) => id === 'dotnet') ? null
          : ids.includes('android') ? MOBILE_RECIPES[2] : ids.includes('ios') ? MOBILE_RECIPES[3] : null;
    return recipe ? { pkg, recipe } : null;
  }).filter(Boolean);
  return families.filter(({ pkg, recipe }) => !families.some((owner) =>
    ['react-native-expo', 'flutter'].includes(owner.recipe.id) && owner.pkg.scope !== pkg.scope &&
    inside(pkg.scope, owner.pkg.scope) && !['react-native-expo', 'flutter'].includes(recipe.id)))
    .map(({ pkg, recipe }) => ({ id: recipe.id, scope: pkg.scope, manifestPath: pkg.path, manifestHash: pkg.hash,
      frameworks: pkg.frameworks.filter(({ domain }) => domain === 'mobile').map(({ id, version }) => ({ id, version })),
      platforms: [...recipe.platforms], prerequisites: [...recipe.prerequisites], runner: recipe.runner,
      versionPolicy: 'Preserve declared versions; installed SDK/JDK/runner compatibility requires a bound probe. No generic major constraint is asserted.',
      documentation: recipe.documentation })).sort((a, b) => a.scope.localeCompare(b.scope) || a.id.localeCompare(b.id));
}

/** Recover a cross-platform owner hidden by nearest native-package filtering. Only known,
 * hashed ancestor manifests already discovered for this scope may be read; no wider scan.
 */
export function inspectMobileRecipeOwners(root, stack) {
  selectMobileRecipes(stack);
  const nativeScopes = stack.packages.filter((pkg) => pkg.frameworks.some(({ id }) => ['android', 'ios'].includes(id))).map(({ scope }) => scope);
  const owners = [];
  for (const entry of stack.evidence ?? []) {
    if (!hash(entry.hash) || !['package.json', 'pubspec.yaml'].includes(path.posix.basename(entry.path)) ||
        stack.packages.some(({ path: file }) => file === entry.path)) continue;
    const scope = path.posix.dirname(entry.path);
    if (!nativeScopes.some((native) => native !== scope && inside(native, scope))) continue;
    const loaded = readContextFile(root, entry.path, { maxBytes: 262144 });
    if (loaded.hash !== entry.hash) throw new GraphError('MOBILE_STACK_DRIFT', 'Ancestor manifest стека изменился; нужен новый plan.');
    const pkg = parseStackManifest(entry.path, loaded.text);
    if (pkg.frameworks.some(({ id, domain }) => domain === 'mobile' && ['react-native', 'expo', 'flutter'].includes(id))) owners.push(pkg);
  }
  return owners;
}

/** Pure decision API. Observations are owner-normalized fixture/probe facts, not model JSON.
 * Production inspector below intentionally has no observation input: a trusted typed probe adapter
 * must bind facts to current stack/check/toolchain before an Executor can supply them here.
 * @param {{stack: any, ownerPackages?: any[], capabilities?: any[], checkDefinitions?: any[], checkBindings?: any[], availableCheckIds?: string[], hostPlatform?: string, observations?: any[], checkIssues?: any[]}} input
 */
export function evaluateMobilePreflight({ stack, ownerPackages = [], capabilities = [], checkDefinitions = [], checkBindings = [],
  availableCheckIds = [], hostPlatform = process.platform, observations = [], checkIssues = [] }) {
  const selections = selectMobileRecipes(stack, ownerPackages);
  assertJsonBounds({ capabilities, checkDefinitions, checkBindings, availableCheckIds, observations, checkIssues }, 100000);
  const recipes = selections.map((selection) => {
    const findings = [], requirements = [], roles = [];
    const supplied = capabilities.filter((entry) => scoped(entry, selection.scope) && stack.scope.some((scope) => scoped(entry, scope)));
    const targets = selection.platforms.length === 1 ? [...selection.platforms] : selection.platforms.filter((platform) =>
      supplied.some(({ id }) => [`mobile-${platform}-build`, `mobile-${platform}-scenario`].includes(id)));
    if (!targets.length) findings.push(issue('MOBILE_TARGET_UNRESOLVED'));
    for (const platform of targets) {
      const config = PLATFORMS[platform];
      if (!config.hosts.includes(hostPlatform)) findings.push(issue('MOBILE_HOST_INCOMPATIBLE', { platform }));
      for (const role of ['build', 'scenario']) {
        const capabilityId = `mobile-${platform}-${role}`;
        const capability = supplied.find(({ id }) => id === capabilityId);
        const checkIds = capability?.checkIds ?? [];
        if (!checkIds.length) findings.push(issue('MOBILE_CAPABILITY_MISSING', { platform, capabilityId }));
        const checks = checkIds.map((checkId) => {
          const definition = checkDefinitions.find(({ id }) => id === checkId);
          const binding = checkBindings.find(({ id }) => id === checkId);
          const failure = checkIssues.find((entry) => entry.checkId === checkId);
          if (!definition || !availableCheckIds.includes(checkId)) findings.push(issue('MOBILE_CHECK_UNREGISTERED', { platform, capabilityId, checkId }));
          if (failure) findings.push(issue('MOBILE_TOOLCHAIN_UNAVAILABLE', { platform, checkId, cause: failure.code }));
          else if (!binding || !hash(binding.toolchainHash) || binding.definitionHash !== hashObject(definition))
            findings.push(issue('MOBILE_TOOLCHAIN_UNVERIFIED', { platform, checkId }));
          const format = definition?.report?.format ?? null;
          if (!config.nativeFormats.includes(format)) findings.push(issue('MOBILE_REPORT_ADAPTER_MISSING', { platform, checkId, format }));
          return { checkId, format, toolchainHash: binding?.toolchainHash ?? null };
        });
        // Lack of an Android adapter is distinct from SDK absence, even with no registered check.
        if (!config.nativeFormats.length && !checkIds.length) findings.push(issue('MOBILE_REPORT_ADAPTER_MISSING', { platform, capabilityId, format: null }));
        roles.push({ platform, role, capabilityId, checks });
      }
      for (const id of sorted([...selection.prerequisites, ...config.prerequisites])) {
        const observation = observations.find((entry) => entry.id === id && entry.platform === platform &&
          entry.stackHash === stack.hash && hash(entry.evidenceHash) &&
          availableCheckIds.includes(entry.checkId) &&
          checkDefinitions.some((definition) => definition.id === entry.checkId && checkBindings.some((binding) =>
            binding.id === entry.checkId && binding.definitionHash === hashObject(definition) && hash(binding.toolchainHash) && binding.toolchainHash === entry.toolchainHash)) &&
          entry.hostPlatform === hostPlatform && entry.completion === 'completed' && entry.exitCode === 0 &&
          ['available', 'missing', 'incompatible'].includes(entry.status));
        const status = observation?.status ?? 'unknown';
        if (status !== 'available') findings.push(issue(status === 'missing' ? 'MOBILE_PREREQUISITE_MISSING'
          : status === 'incompatible' ? 'MOBILE_PREREQUISITE_INCOMPATIBLE' : 'MOBILE_PREREQUISITE_UNKNOWN', { platform, prerequisiteId: id }));
        requirements.push({ id, platform, status, evidenceHash: observation?.evidenceHash ?? null });
      }
    }
    const uniqueFindings = [...new Map(findings.map((finding) => [JSON.stringify(finding), finding])).values()];
    const blocking = uniqueFindings.filter(({ code }) => !['MOBILE_TOOLCHAIN_UNVERIFIED', 'MOBILE_PREREQUISITE_UNKNOWN'].includes(code));
    return { ...selection, targets, roles, requirements, findings: uniqueFindings,
      status: blocking.length ? 'blocked' : uniqueFindings.length ? 'needs-probe' : 'registered-unverified', acceptance: 'unverified' };
  });
  const unknown = stack.domains.includes('mobile') && !recipes.length;
  const body = { version: 1, guidanceOnly: true, acceptance: 'unverified', stackHash: stack.hash,
    recipeCatalogHash: hashObject({ recipes: MOBILE_RECIPES, platforms: PLATFORMS }), hostPlatform, recipes,
    findings: unknown ? [issue('MOBILE_RECIPE_UNSUPPORTED')] : [],
    status: unknown || recipes.some(({ status }) => status === 'blocked') ? 'blocked'
      : recipes.some(({ status }) => status === 'needs-probe') ? 'needs-probe' : recipes.length ? 'registered-unverified' : 'not-applicable',
    limitations: ['static-registration-not-native-acceptance', 'no-sdk-install-or-command-discovery',
      'sdk-version-device-availability-requires-bound-probe', 'component-report-does-not-prove-native-artifact-or-platform',
      'prewrite-enforcement-remains-executor-owned'] };
  return { ...body, hash: hashObject(body) };
}

/** Safe production projection: registered files only, no subprocess, SDK discovery or AI facts.
 * @param {string} root
 * @param {{stack: any, capabilities?: any[], checkProfile: any, hostPlatform?: string}} input
 */
export function inspectMobilePreflight(root, { stack, capabilities = [], checkProfile, hostPlatform = process.platform }) {
  const definitions = checkProfile?.definitions ?? [], enabled = checkProfile?.requiredCheckIds ?? [];
  const checkBindings = [], checkIssues = [];
  for (const checkId of enabled) {
    try {
      const selected = { ...checkProfile, requiredCheckIds: [checkId], definitions: definitions.filter(({ id }) => id === checkId) };
      checkBindings.push(...inspectCheckProfile(root, selected).bindings);
    } catch (error) {
      // Paths/tool names and raw error text never enter the model/doctor projection.
      checkIssues.push({ checkId, code: error.code ?? 'CHECK_UNAVAILABLE' });
    }
  }
  return evaluateMobilePreflight({ stack, capabilities, checkDefinitions: definitions, checkBindings,
    ownerPackages: inspectMobileRecipeOwners(root, stack), availableCheckIds: enabled, hostPlatform, checkIssues });
}
