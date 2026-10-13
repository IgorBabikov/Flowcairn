import { GraphError, hashObject, sha256 } from './io.mjs';
import { captureVerificationReport, readFreshVerificationReport } from './verification-report-file.mjs';
import { parseVerificationReport } from './verification-report.mjs';
import { parseNodeVerificationReport } from './node-verification-report.mjs';
import { parseXCTestVerificationReport } from './xctest-verification-report.mjs';
import { boundXCTestMaterialPaths, hashRegisteredXCTestTree, XCTEST_TREE_ALGORITHM } from './xctest-artifact-material.mjs';
import { parseAndroidNodeVerificationReport, ANDROID_NODE_REPORT_FORMAT, MAX_ANDROID_APK_BYTES } from './android-node-verification-report.mjs';
import { RelativePath } from './schemas.mjs';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { lstatHostSync, crossStatIdentity, sameHostPath } from './host-filesystem.mjs';
import { scanSourceFile } from './source-file-scan.mjs';
import { checkFileIdentity, checkInputManifest, containedCheckPath, resolveCheckExecutable } from './check-toolchain.mjs';

const inside = (file, scope) => scope === '.' || file === scope.replace(/\/$/, '') || file.startsWith(scope.replace(/\/$/, '') + '/');
function verifiedFileHash(root, file, maxBytes) {
  RelativePath.parse(file);
  let absolute = realpathSync(root);
  const directories = [];
  for (const part of file.split('/')) {
    const stat = lstatHostSync(absolute, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || !sameHostPath(realpathSync(absolute), absolute))
      throw new GraphError('ANDROID_FILE_UNSAFE', 'Native identity file cannot cross an alias.');
    directories.push({ path: absolute, identity: crossStatIdentity(stat) }); absolute = path.join(absolute, part);
  }
  const expected = lstatHostSync(absolute, { bigint: true });
  if (expected.size > BigInt(maxBytes)) throw new GraphError('ANDROID_FILE_LIMIT', 'Native identity file exceeds its bound.');
  const scanned = scanSourceFile(absolute, { expected, classify: false });
  for (const directory of directories) {
    const current = lstatHostSync(directory.path, { bigint: true });
    if (crossStatIdentity(current) !== directory.identity || !sameHostPath(realpathSync(directory.path), directory.path))
      throw new GraphError('ANDROID_FILE_UNSAFE', 'Native identity path changed.');
  }
  return scanned.hash;
}

/** Same bounded actual APK reader can serve subsequent output-drift checks. */
export function hashRegisteredAndroidArtifact(root, outputPaths, artifactPath) {
  if (!outputPaths.some(scope => inside(artifactPath, scope))) throw new GraphError('ANDROID_ARTIFACT_SCOPE', 'APK is outside registered output paths.');
  return verifiedFileHash(root, artifactPath, MAX_ANDROID_APK_BYTES);
}

function androidMaterial(root, plan, node, definition, binding, value, normalized, before, inputHash) {
  const reject = code => {
    normalized.status = 'unverified'; normalized.reasons.push({ code, kind: 'unverified' });
    normalized.artifact = { ...normalized.artifact, status: 'unknown' };
  };
  if (normalized.status === 'unverified') { normalized.artifact.status = 'unknown'; return; }
  if (!before || before.hash !== inputHash || !Array.isArray(before.files)) { reject('REPORT_ANDROID_SOURCE_SNAPSHOT_MISSING'); return; }
  if (plan.checkRegistryHash !== hashObject(plan.checks) || binding.definitionHash !== hashObject(definition) ||
      !definition.identityFiles?.length || value.build.toolchainHash !== binding.toolchainHash) {
    reject('REPORT_ANDROID_TOOLCHAIN_UNVERIFIED'); return;
  }
  try {
    const executable = resolveCheckExecutable(root, definition.command.executable);
    const inputManifestHash = checkInputManifest(root, definition.inputPaths);
    const identityFiles = definition.identityFiles.map(file => {
      const location = path.isAbsolute(file) ? file : containedCheckPath(root, file);
      const physical = realpathSync(location);
      return { path: file, physical, ...checkFileIdentity(physical, { opaque: true }) };
    });
    if (hashObject({ executable, invocationHash: binding.invocationHash, inputManifestHash, identityFiles }) !== binding.toolchainHash) {
      reject('REPORT_ANDROID_TOOLCHAIN_UNVERIFIED'); return;
    }
  } catch { reject('REPORT_ANDROID_TOOLCHAIN_UNVERIFIED'); return; }
  const expected = definition.report.android?.sourcePaths, inputs = value.build.sourceInputs;
  if (!expected || hashObject([...expected].sort()) !== hashObject(inputs.map(item => item.path).sort())) {
    reject('REPORT_ANDROID_SOURCE_SET_MISMATCH'); return;
  }
  const requirements = (plan.taskContract?.requirements ?? []).filter(item => item.verification.checkIds.includes(node.action.id));
  const workIds = new Set(requirements.flatMap(item => item.workIds));
  const work = plan.nodes.filter(item => item.action.id === 'ai-implement' && workIds.has(item.id));
  const applicationWrites = work.flatMap(item => item.resources.writes);
  const criterionPaths = requirements.flatMap(item => item.verification.paths);
  // Mutable application work must be compiled. A criterion may also reference
  // the protected verifier/oracle: its bytes are already in the checked input
  // manifest/toolchain, and it is not an APK source. Unbound paths still fail.
  const uncovered = before.files.some(file =>
    applicationWrites.some(scope => inside(file.path, scope)) && !expected.includes(file.path) ||
    criterionPaths.some(scope => inside(file.path, scope)) && !expected.includes(file.path) &&
      !definition.inputPaths.some(scope => inside(file.path, scope)));
  if (uncovered) { reject('REPORT_ANDROID_SOURCE_COVERAGE_MISSING'); return; }
  // The protected driver/native oracle is a registered input, outside application writes.
  const writes = plan.nodes.filter(item => item.action.id === 'ai-implement').flatMap(item => item.resources.writes);
  if (!definition.inputPaths.length || definition.inputPaths.some(file => writes.some(scope => inside(file, scope) || inside(scope, file)))) {
    reject('REPORT_ANDROID_ORACLE_UNPROTECTED'); return;
  }
  try {
    for (const input of inputs) {
      const original = before.files.find(file => file.path === input.path);
      if (!original || original.hash !== input.hash || verifiedFileHash(root, input.path, MAX_ANDROID_APK_BYTES) !== input.hash) {
        reject('REPORT_ANDROID_SOURCE_CHANGED'); return;
      }
    }
    const artifact = value.artifact;
    if (hashRegisteredAndroidArtifact(root, definition.outputPaths, artifact.path) !== artifact.hash || artifact.hash !== artifact.installedHash) {
      reject('REPORT_ANDROID_APK_HASH_MISMATCH'); return;
    }
  } catch (error) {
    reject(error?.code === 'ANDROID_ARTIFACT_SCOPE' ? 'REPORT_ANDROID_APK_OUTSIDE_OUTPUTS' : 'REPORT_ANDROID_MATERIAL_UNSAFE');
  }
}

function xctestMaterial(root, plan, definition, binding, value, normalized, before, inputHash) {
  const reject = code => {
    normalized.status = 'unverified'; normalized.reasons.push({ code, kind: 'unverified' });
    normalized.artifact = { ...normalized.artifact, status: 'unknown' };
  };
  if (normalized.status === 'unverified') return null;
  if (!definition.report.xctest) { reject('REPORT_XCTEST_MATERIAL_REGISTRATION_MISSING'); return null; }
  if (!before || before.hash !== inputHash || plan.checkRegistryHash !== hashObject(plan.checks) ||
      binding.definitionHash !== hashObject(definition)) { reject('REPORT_XCTEST_SOURCE_OR_REGISTRY_DRIFT'); return null; }
  const result = value.artifact, application = value.applicationArtifact;
  if (result?.kind !== 'xcresult-bundle' || application?.kind !== 'ios-app-bundle' ||
      result.algorithm !== XCTEST_TREE_ALGORITHM || application.algorithm !== XCTEST_TREE_ALGORITHM ||
      !/^[a-f0-9]{64}$/.test(result.hash) || !/^[a-f0-9]{64}$/.test(application.hash) ||
      typeof result.path !== 'string' || typeof application.path !== 'string') {
    reject('REPORT_XCTEST_MATERIAL_MISSING'); return null;
  }
  try {
    boundXCTestMaterialPaths(definition, result.path, application.path);
    if (hashRegisteredXCTestTree(root, definition, result.path) !== result.hash ||
        hashRegisteredXCTestTree(root, definition, application.path) !== application.hash) {
      reject('REPORT_XCTEST_MATERIAL_HASH_MISMATCH'); return null;
    }
  } catch { reject('REPORT_XCTEST_MATERIAL_UNSAFE'); return null; }
  return { resultPath: result.path, applicationPath: application.path, applicationHash: application.hash };
}

function registration(plan, node) {
  if (!plan.checks || !node.action.id.startsWith('check-')) return null;
  const id = node.action.id.slice('check-'.length);
  const definition = plan.checks?.definitions.find((check) => check.id === id);
  const binding = plan.checks?.bindings.find((check) => check.id === id);
  return definition?.report && binding ? { definition, binding } : null;
}

export function captureCheckVerification(root, plan, node) {
  const registered = registration(plan, node);
  return registered ? captureVerificationReport(root, registered.definition.report) : null;
}

/** Executor-owned projection, computed from a fresh registered file after known process completion. */
export function finishCheckVerification(root, plan, node, previous, inputHash, beforeFingerprint = undefined) {
  const registered = registration(plan, node);
  if (!registered) return undefined;
  const { definition, binding } = registered;
  const spec = definition.report;
  const report = readFreshVerificationReport(root, spec, previous);
  const normalize = spec.format === 'flowcairn-node-test/v1' ? parseNodeVerificationReport :
    spec.format === 'flowcairn-xctest/v1' ? parseXCTestVerificationReport :
    spec.format === ANDROID_NODE_REPORT_FORMAT ? parseAndroidNodeVerificationReport :
    (value, options) => parseVerificationReport(spec.format, value, options);
  const normalized = normalize(report.value, { requiredScenarios: spec.requiredScenarios });
  if (spec.format === ANDROID_NODE_REPORT_FORMAT)
    androidMaterial(root, plan, node, definition, binding, report.value, normalized, beforeFingerprint, inputHash);
  const artifact = Reflect.get(normalized, 'artifact'), environment = Reflect.get(normalized, 'environment');
  const mobileWorks = new Set((plan.taskContract?.requirements ?? [])
    .filter(requirement => requirement.verification.checkIds.includes(node.action.id)).flatMap(requirement => requirement.workIds));
  const nativeIosRequired = plan.workflowPolicy === 'developer-v2' && spec.format === 'flowcairn-xctest/v1' &&
    plan.nodes.some(work => mobileWorks.has(work.id) && work.skills?.includes('domain-mobile'));
  const xctestPaths = spec.format === 'flowcairn-xctest/v1' && (nativeIosRequired || spec.xctest) ?
    xctestMaterial(root, plan, definition, binding, report.value, normalized, beforeFingerprint, inputHash) : null;
  if (nativeIosRequired && (environment?.status !== 'reported' ||
      !environment.devices?.every(device => ['iOS', 'iOS Simulator'].includes(device.platform)))) {
    normalized.status = 'unverified';
    normalized.reasons.push({ code: 'NATIVE_PLATFORM_MISMATCH', kind: 'unverified' });
  }
  const nativeIdentityMissing = ['flowcairn-xctest/v1', ANDROID_NODE_REPORT_FORMAT].includes(spec.format) &&
    (normalized.artifact?.status !== 'reported' || environment?.status !== 'reported');
  return { version: 1, format: spec.format, status: normalized.status, counts: normalized.counts,
    countsConfirmed: normalized.countsConfirmed, assertionFailures: normalized.assertionFailures ?? 0,
    scenarioIds: normalized.scenarios.map(({ id }) => sha256(id)),
    reasonCodes: [...normalized.reasons.map(({ code }) => code), ...(nativeIdentityMissing ? ['NATIVE_IDENTITY_UNVERIFIED'] : [])],
    reportHash: report.hash, specHash: hashObject(spec), inputHash,
    adapterHash: hashObject({ runtimeHash: plan.runtimeHash, format: spec.format }),
    checkRegistryHash: plan.checkRegistryHash, definitionHash: binding.definitionHash, toolchainHash: binding.toolchainHash,
    ...(normalized.artifact?.status === 'reported' ? { artifactHash: normalized.artifact.identity } : {}),
    ...(spec.format === ANDROID_NODE_REPORT_FORMAT && normalized.artifact?.status === 'reported' ? { artifactPath: artifact.path } : {}),
    ...(xctestPaths && normalized.artifact?.status === 'reported' ? {
      artifactPath: xctestPaths.resultPath,
      applicationArtifactPath: xctestPaths.applicationPath,
      applicationArtifactHash: xctestPaths.applicationHash,
    } : {}),
    ...(environment?.status === 'reported' ? { environmentHash: hashObject(environment) } : {}),
    ...(nativeIdentityMissing && normalized.status === 'passed' ? { status: 'unverified' } : {}),
  };
}

/** Verify the projection's original trusted binding; no model-selected IDs or diagnostic inference. */
export function boundCheckVerification(plan, node, check) {
  const registered = registration(plan, node);
  if (!registered) return check.verification === undefined;
  if (plan.checkRegistryHash !== hashObject(plan.checks) || registered.binding.definitionHash !== hashObject(registered.definition)) return false;
  const evidence = check.verification;
  return evidence?.version === 1 && evidence.format === registered.definition.report.format &&
    evidence.specHash === hashObject(registered.definition.report) && evidence.inputHash === check.inputHash &&
    evidence.adapterHash === hashObject({ runtimeHash: plan.runtimeHash, format: evidence.format }) &&
    evidence.checkRegistryHash === plan.checkRegistryHash && evidence.definitionHash === registered.binding.definitionHash &&
    evidence.toolchainHash === registered.binding.toolchainHash;
}
