import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, realpathSync, rmSync, unlinkSync, symlinkSync, linkSync, truncateSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { parseAndroidNodeVerificationReport, ANDROID_NODE_REPORT_FORMAT, MAX_ANDROID_APK_BYTES } from '../scripts/ai-graph/lib/android-node-verification-report.mjs';
import { captureCheckVerification, finishCheckVerification, hashRegisteredAndroidArtifact, boundCheckVerification } from '../scripts/ai-graph/lib/check-verification.mjs';
import { inspectCheckProfile } from '../scripts/ai-graph/lib/check-profile.mjs';
import { VerificationReportSpecSchema } from '../scripts/ai-graph/lib/check-schemas.mjs';
import { CheckVerificationSchema } from '../scripts/ai-graph/lib/schemas.mjs';
import { fingerprintDirectWorkspace } from '../scripts/ai-graph/lib/direct-workspace.mjs';
import { sha256, hashObject } from '../scripts/ai-graph/lib/io.mjs';
import { selectDevelopmentSkills } from '../scripts/ai-graph/lib/development-workflow.mjs';
import { classifyDevelopmentFailure } from '../scripts/ai-graph/lib/development-failure.mjs';

const H = 'a'.repeat(64), CASE = 'device observation is asserted';
const header = "import test from 'node:test'; import assert from 'node:assert/strict';\n";
const passing = header + `test(${JSON.stringify(CASE)},()=>assert.equal(42,42));\n`;
const reporter = path.resolve('scripts/ai-graph/lib/node-test-reporter.mjs');
function directory(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'flowcairn-android-bridge-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'out')); return root;
}
function nodeReport(root, source = passing) {
  writeFileSync(path.join(root, 'driver.test.mjs'), source);
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', `--test-reporter=${reporter}`,
    '--test-reporter-destination=out/node.json', 'driver.test.mjs'], { cwd: root, env, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined);
  return { report: JSON.parse(readFileSync(path.join(root, 'out/node.json'), 'utf8')), exitCode: result.status };
}
// These synthetic Android identities exercise the host contract, never native acceptance.
function envelope(report) {
  return { format: ANDROID_NODE_REPORT_FORMAT, nodeReport: report,
    build: { completed: true, exitCode: 0, sourceInputs: [{ path: 'app/Main.java', hash: H }], toolchainHash: H },
    artifact: { kind: 'apk', path: 'out/control.apk', hash: H, installedHash: H },
    environment: { platform: 'android', apiLevel: 35, abi: 'arm64-v8a', deviceHash: H, target: 'emulator', sessionHash: H },
    session: { ownership: 'task-owned', deviceHash: H, sessionHash: H, cleanup: { completed: true, stopped: true, exitCode: 0 } } };
}
const reason = (result, code) => result.reasons.some(item => item.code === code);

test('genuine Node22 event report preserves exact scenario identities in the Android envelope', t => {
  const root = directory(t), { report, exitCode } = nodeReport(root);
  assert.equal(exitCode, 0);
  const value = envelope(report), snapshot = structuredClone(value);
  const result = parseAndroidNodeVerificationReport(value, { requiredScenarios: [CASE] });
  assert.equal(result.status, 'passed'); assert.equal(result.countsConfirmed, true);
  assert.deepEqual(result.counts, { total: 1, completed: 1, passed: 1, failed: 0, skipped: 0 });
  assert.equal(result.scenarios[0].id, report.cases[0].id); assert.equal(result.reasons.length, 0);
  assert.deepEqual(value, snapshot);
  assert.equal(parseAndroidNodeVerificationReport(value, { requiredScenarios: ['unobserved scenario'] }).status, 'unverified');
  assert.equal(parseAndroidNodeVerificationReport(value, { requiredScenarios: [report.cases[0].id] }).status, 'passed');
  assert.equal(parseAndroidNodeVerificationReport(report).status, 'unverified', 'component Node JSON cannot claim Android identity');
});

test('genuine zero, skip, todo, ambiguous titles, exception and assertion failures stay distinct', t => {
  const root = directory(t);
  for (const source of ['', header + `test.skip(${JSON.stringify(CASE)},()=>{});`,
    header + `test.todo(${JSON.stringify(CASE)},()=>{});`,
    passing + `test(${JSON.stringify(CASE)},()=>assert.equal(42,42));`]) {
    const result = parseAndroidNodeVerificationReport(envelope(nodeReport(root, source).report), { requiredScenarios: [CASE] });
    assert.equal(result.status, 'unverified');
  }
  const exception = parseAndroidNodeVerificationReport(envelope(nodeReport(root, header +
    `test(${JSON.stringify(CASE)},()=>{throw new Error('SDK driver failed before observation');});`).report), { requiredScenarios: [CASE] });
  assert.equal(exception.status, 'unverified'); assert.equal(exception.assertionFailures, 0);
  assert.ok(reason(exception, 'REPORT_ANDROID_DRIVER_FAILURE_UNVERIFIED'));
  const mixed = parseAndroidNodeVerificationReport(envelope(nodeReport(root, header +
    `test('real assertion',()=>assert.equal(41,42)); test(${JSON.stringify(CASE)},()=>{throw new Error('driver unavailable');});`).report));
  assert.equal(mixed.status, 'unverified'); assert.equal(mixed.counts.failed, 2); assert.equal(mixed.assertionFailures, 1);
  assert.ok(reason(mixed, 'REPORT_ANDROID_DRIVER_FAILURE_UNVERIFIED'));
  const assertion = parseAndroidNodeVerificationReport(envelope(nodeReport(root, header +
    `test(${JSON.stringify(CASE)},()=>assert.equal(41,42));`).report), { requiredScenarios: [CASE] });
  assert.equal(assertion.status, 'failed'); assert.equal(assertion.countsConfirmed, true);
  assert.equal(assertion.assertionFailures, 1); assert.equal(assertion.counts.failed, 1);
});

test('unconfirmed Android build/artifact/device/session/cleanup and unknown shapes never pass', t => {
  const root = directory(t), base = envelope(nodeReport(root).report);
  const variants = [
    v => { v.format = 'junit-xml'; }, v => { v.build.completed = false; }, v => { v.build.exitCode = null; },
    v => { delete v.build.toolchainHash; }, v => { v.build.sourceInputs = []; },
    v => { v.build.sourceInputs.push({ ...v.build.sourceInputs[0] }); },
    v => { v.artifact = null; }, v => { v.artifact.installedHash = 'b'.repeat(64); },
    v => { v.artifact.hash = null; }, v => { v.artifact.path = '../outside.apk'; },
    v => { v.environment = null; }, v => { v.environment.platform = 'ios'; },
    v => { v.environment.apiLevel = '35'; }, v => { v.environment.abi = 'unknown'; },
    v => { v.environment.target = 'component'; }, v => { v.session = null; },
    v => { v.session.deviceHash = 'b'.repeat(64); }, v => { v.session.sessionHash = 'b'.repeat(64); },
    v => { v.session.ownership = 'existing-user-session'; }, v => { v.session.cleanup.completed = false; },
    v => { v.session.cleanup.stopped = false; }, v => { v.session.cleanup.exitCode = null; },
    v => { v.nodeReport.summary.counts.passed = 20; }, v => { v.nodeReport.fileSummaries[0].success = false; },
    v => { v.nodeReport.cases[0].id = 'b'.repeat(64); }, v => { v.nodeReport.cases[0].testNumber = 1.5; },
    v => { v.nodeReport.cases[0].line = null; v.nodeReport.cases[0].id = 'b'.repeat(64); },
    v => { v.arbitrary = 'unknown field'; },
  ];
  for (const change of variants) {
    const value = structuredClone(base); change(value);
    assert.equal(parseAndroidNodeVerificationReport(value, { requiredScenarios: [CASE] }).status, 'unverified', change.toString());
  }
  const cycle = structuredClone(base); cycle.nodeReport.issues.push(cycle);
  assert.equal(parseAndroidNodeVerificationReport(cycle).status, 'unverified');
  let invoked = false; const getter = structuredClone(base);
  Object.defineProperty(getter, 'build', { get: () => { invoked = true; return {}; } });
  assert.equal(parseAndroidNodeVerificationReport(getter).status, 'unverified'); assert.equal(invoked, false);
});

test('custom retry/expected-failure claims cannot supply absent official Node facts', t => {
  const root = directory(t), base = envelope(nodeReport(root).report);
  for (const key of ['retry', 'retries', 'retryCount', 'retryReasons', 'attempt', 'attempts', 'invocations',
    'expectedStatus', 'expectedFailure', 'expectedFailures', 'failing']) {
    for (const level of ['root', 'case']) {
      const value = structuredClone(base); (level === 'root' ? value.nodeReport : value.nodeReport.cases[0])[key] = 0;
      const result = parseAndroidNodeVerificationReport(value);
      assert.equal(result.status, 'unverified'); assert.ok(reason(result, 'REPORT_ANDROID_RETRY_OR_EXPECTATION_UNCONFIRMED'));
    }
  }
});

function registered(t, { source = passing, sourcePaths = ['app/Main.java', 'AndroidManifest.xml'], inputPaths = ['driver.test.mjs'], identityFiles = ['sdk-identity.bin'] } = {}) {
  const root = directory(t);
  mkdirSync(path.join(root, 'app'));
  writeFileSync(path.join(root, 'app/Main.java'), 'class Main {}\n');
  writeFileSync(path.join(root, 'AndroidManifest.xml'), '<manifest package="fixture"/>\n');
  writeFileSync(path.join(root, 'sdk-identity.bin'), 'mock SDK identity, no SDK invocation\n');
  const generated = nodeReport(root, source);
  const definition = { id: 'native', title: 'Registered Android fixture', purpose: 'Verify material binding of the bridge',
    command: { executable: realpathSync(process.execPath), argv: ['driver.test.mjs'], cwd: '.' }, inputPaths, identityFiles,
    outputPaths: ['out'], timeoutMs: 10000, maxOutputBytes: 1024,
    report: { version: 1, format: ANDROID_NODE_REPORT_FORMAT, path: 'out/report.json', requiredScenarios: [CASE], android: { sourcePaths } } };
  const checks = inspectCheckProfile(root, { version: 1, requiredCheckIds: ['native'], definitions: [definition], environment: [] });
  const node = { id: 'verify-native', action: { id: 'check-native', version: 1, inputs: {} }, resources: { writes: [] } };
  const plan = { version: 1, schemaVersion: 3, runtimeHash: H, checks, checkRegistryHash: hashObject(checks),
    taskContract: { requirements: [{ id: 'req001', workIds: ['work-app'], verification: { checkIds: ['check-native'], paths: ['app'] } }] },
    nodes: [{ id: 'work-app', action: { id: 'ai-implement' }, resources: { writes: ['app'] } }, node] };
  const before = fingerprintDirectWorkspace(root, { outputPaths: ['out'] });
  const value = envelope(generated.report);
  value.build.sourceInputs = sourcePaths.map(file => ({ path: file, hash: before.files.find(item => item.path === file).hash }));
  value.build.toolchainHash = checks.bindings[0].toolchainHash;
  writeFileSync(path.join(root, value.artifact.path), 'bounded mock APK bytes; no device or SDK was run\n');
  value.artifact.hash = value.artifact.installedHash = sha256(readFileSync(path.join(root, value.artifact.path)));
  const previous = captureCheckVerification(root, plan, node);
  const save = () => writeFileSync(path.join(root, definition.report.path), JSON.stringify(value));
  const finish = (snapshot = before) => { save(); return finishCheckVerification(root, plan, node, previous, before.hash, snapshot); };
  return { root, node, plan, before, value, definition: checks.definitions[0], previous, save, finish, exitCode: generated.exitCode };
}

test('real registered fresh-file reader hashes source/APK/toolchain and projects actual artifactPath', t => {
  const f = registered(t), result = f.finish();
  CheckVerificationSchema.parse(result);
  assert.equal(result.status, 'passed'); assert.equal(result.artifactPath, 'out/control.apk');
  assert.equal(result.artifactHash, sha256(readFileSync(path.join(f.root, result.artifactPath))));
  assert.equal(result.environmentHash.length, 64); assert.equal(result.inputHash, f.before.hash);
  assert.equal(boundCheckVerification(f.plan, f.node, { inputHash: f.before.hash, verification: result }), true);
  const previous = captureCheckVerification(f.root, f.plan, f.node);
  assert.throws(() => finishCheckVerification(f.root, f.plan, f.node, previous, f.before.hash, f.before), { code: 'CHECK_REPORT_STALE' });
  assert.equal(MAX_ANDROID_APK_BYTES, 512 * 1024 * 1024);
});

const materialCases = [
  ['outside output paths', 'REPORT_ANDROID_APK_OUTSIDE_OUTPUTS', f => { writeFileSync(path.join(f.root, 'outside.apk'), 'apk'); f.value.artifact.path = 'outside.apk'; }],
  ['missing APK', 'REPORT_ANDROID_MATERIAL_UNSAFE', f => { unlinkSync(path.join(f.root, f.value.artifact.path)); }],
  ['oversized APK', 'REPORT_ANDROID_MATERIAL_UNSAFE', f => { truncateSync(path.join(f.root, f.value.artifact.path), MAX_ANDROID_APK_BYTES + 1); }],
  ['APK hash mismatch', 'REPORT_ANDROID_APK_HASH_MISMATCH', f => { writeFileSync(path.join(f.root, f.value.artifact.path), 'changed APK'); }],
  ['APK symlink', 'REPORT_ANDROID_MATERIAL_UNSAFE', f => { unlinkSync(path.join(f.root, f.value.artifact.path)); symlinkSync('../AndroidManifest.xml', path.join(f.root, f.value.artifact.path)); }],
  ['APK hardlink', 'REPORT_ANDROID_MATERIAL_UNSAFE', f => { unlinkSync(path.join(f.root, f.value.artifact.path)); linkSync(path.join(f.root, 'AndroidManifest.xml'), path.join(f.root, f.value.artifact.path)); }],
  ['symlink directory', 'REPORT_ANDROID_MATERIAL_UNSAFE', f => { mkdirSync(path.join(f.root, 'physical')); writeFileSync(path.join(f.root, 'physical/control.apk'), 'apk'); symlinkSync('physical', path.join(f.root, 'out/link')); f.value.artifact.path = 'out/link/control.apk'; }],
  ['changed source bytes', 'REPORT_ANDROID_SOURCE_CHANGED', f => { writeFileSync(path.join(f.root, 'app/Main.java'), 'class Changed {}'); }],
  ['source symlink', 'REPORT_ANDROID_MATERIAL_UNSAFE', f => { unlinkSync(path.join(f.root, 'app/Main.java')); symlinkSync('../AndroidManifest.xml', path.join(f.root, 'app/Main.java')); }],
  ['producer-selected source subset', 'REPORT_ANDROID_SOURCE_SET_MISMATCH', f => { f.value.build.sourceInputs.pop(); }],
  ['wrong original source hash', 'REPORT_ANDROID_SOURCE_CHANGED', f => { f.value.build.sourceInputs[0].hash = H; }],
  ['changed SDK identity bytes', 'REPORT_ANDROID_TOOLCHAIN_UNVERIFIED', f => { writeFileSync(path.join(f.root, 'sdk-identity.bin'), 'changed SDK identity'); }],
  ['missing SDK identity file', 'REPORT_ANDROID_TOOLCHAIN_UNVERIFIED', f => { unlinkSync(path.join(f.root, 'sdk-identity.bin')); }],
  ['forged SDK binding', 'REPORT_ANDROID_TOOLCHAIN_UNVERIFIED', f => { f.value.build.toolchainHash = H; }],
  ['changed protected oracle bytes', 'REPORT_ANDROID_TOOLCHAIN_UNVERIFIED', f => { writeFileSync(path.join(f.root, 'driver.test.mjs'), 'changed oracle'); }],
  ['missing source fingerprint', 'REPORT_ANDROID_SOURCE_SNAPSHOT_MISSING', f => { f.snapshot = null; }],
  ['wrong fingerprint identity', 'REPORT_ANDROID_SOURCE_SNAPSHOT_MISSING', f => { f.snapshot = { ...f.before, hash: H }; }],
];
for (const [name, code, change] of materialCases) test(`host refuses ${name} without artifact proof`, t => {
  const f = registered(t); change(f);
  const result = f.finish(Object.hasOwn(f, 'snapshot') ? f.snapshot : f.before);
  assert.equal(result.status, 'unverified'); assert.ok(result.reasonCodes.includes(code), result.reasonCodes.join(','));
  assert.equal(Object.hasOwn(result, 'artifactHash'), false); assert.equal(Object.hasOwn(result, 'artifactPath'), false);
});

test('declared source set must cover every current file within affected work/criterion scopes', t => {
  const f = registered(t, { sourcePaths: ['AndroidManifest.xml'] });
  const result = f.finish();
  assert.equal(result.status, 'unverified'); assert.ok(result.reasonCodes.includes('REPORT_ANDROID_SOURCE_COVERAGE_MISSING'));
  assert.equal(Object.hasOwn(result, 'artifactPath'), false);
  const criterion = registered(t, { sourcePaths: ['app/Main.java'] });
  criterion.plan.taskContract.requirements[0].verification.paths = ['AndroidManifest.xml'];
  const missingCriterion = criterion.finish();
  assert.equal(missingCriterion.status, 'unverified'); assert.ok(missingCriterion.reasonCodes.includes('REPORT_ANDROID_SOURCE_COVERAGE_MISSING'));
});

test('missing toolchain identities and an oracle in AI write scope remain unverified', t => {
  for (const options of [{ identityFiles: [] }, { inputPaths: [] }, { inputPaths: ['app/Main.java'] }]) {
    const f = registered(t, options), result = f.finish();
    assert.equal(result.status, 'unverified');
    assert.ok(result.reasonCodes.includes(options.identityFiles ? 'REPORT_ANDROID_TOOLCHAIN_UNVERIFIED' : 'REPORT_ANDROID_ORACLE_UNPROTECTED'));
  }
});

test('criterion references to immutable registered verifier inputs do not claim they were compiled into APK', t => {
  const f = registered(t);
  f.plan.taskContract.requirements[0].verification.paths = ['app', 'driver.test.mjs'];
  const result = f.finish();
  assert.equal(result.status, 'passed');
  assert.equal(result.artifactPath, 'out/control.apk');
  assert.deepEqual(f.value.build.sourceInputs.map(item => item.path), ['app/Main.java', 'AndroidManifest.xml']);
});

test('protected criterion oracle cannot hide missing application work coverage', t => {
  const f = registered(t, { sourcePaths: ['AndroidManifest.xml'] });
  f.plan.taskContract.requirements[0].verification.paths = ['driver.test.mjs'];
  const result = f.finish();
  assert.equal(result.status, 'unverified');
  assert.ok(result.reasonCodes.includes('REPORT_ANDROID_SOURCE_COVERAGE_MISSING'));
  assert.equal(Object.hasOwn(result, 'artifactPath'), false);
});

test('a criterion path outside compiled sources and registered check inputs remains unverified', t => {
  const f = registered(t);
  f.plan.taskContract.requirements[0].verification.paths = ['app', 'sdk-identity.bin'];
  const result = f.finish();
  assert.equal(result.status, 'unverified');
  assert.ok(result.reasonCodes.includes('REPORT_ANDROID_SOURCE_COVERAGE_MISSING'));
});

test('criterion oracle remains protected and current when included in verification paths', t => {
  const changed = registered(t);
  changed.plan.taskContract.requirements[0].verification.paths = ['app', 'driver.test.mjs'];
  writeFileSync(path.join(changed.root, 'driver.test.mjs'), 'changed oracle');
  assert.ok(changed.finish().reasonCodes.includes('REPORT_ANDROID_TOOLCHAIN_UNVERIFIED'));
  const writable = registered(t);
  writable.plan.taskContract.requirements[0].verification.paths = ['app', 'driver.test.mjs'];
  writable.plan.nodes[0].resources.writes.push('driver.test.mjs');
  assert.equal(writable.finish().status, 'unverified');
});

test('unverified inner driver error has no host-verified artifact; only confirmed assertion failure permits native diagnosis', t => {
  for (const source of [header + `test(${JSON.stringify(CASE)},()=>{throw new Error('driver unavailable');});`,
    header + `test(${JSON.stringify(CASE)},()=>assert.equal(41,42));`]) {
    const f = registered(t, { source }), result = f.finish();
    const isAssertion = source.includes('assert.equal');
    assert.equal(result.status, isAssertion ? 'failed' : 'unverified');
    assert.equal(Object.hasOwn(result, 'artifactPath'), isAssertion);
    const receipt = { schemaVersion: 2, runId: 'run-test', nodeId: f.node.id, attemptId: 'attempt-1', attempt: 1,
      phase: 'finished', actionId: f.node.action.id, actionVersion: 1, planVersion: 1, planHash: H, taskHash: H,
      sourceHash: H, runtimeHash: H, instructionsHash: H, skills: [], permissions: [], grantedPermissions: [],
      termination: { stopped: true, uncertain: false, timedOut: false, outputLimit: false, signal: null,
        ticketHash: H, execution: { kind: 'registered-check', actionId: f.node.action.id, checkRegistryHash: f.plan.checkRegistryHash } },
      startedAt: '2026-10-12T10:00:00.000Z', finishedAt: '2026-10-12T10:00:00.010Z', durationMs: 10,
      exitCode: 1, verdict: 'fail', checks: [{ id: f.node.id, passed: false, exitCode: 1, durationMs: 10,
        summary: 'failed', inputHash: f.before.hash, verification: result }], artifacts: [], changedFiles: [], failureReason: null,
      beforeFingerprint: f.before.hash, afterFingerprint: f.before.hash, actor: 'operator', operationId: 'operation-1', previousReceipt: null };
    const routed = classifyDevelopmentFailure({ state: { runId: 'run-test', planHash: H }, plan: f.plan,
      definition: f.node, node: { status: 'failed' }, receipt });
    assert.equal(routed.category, isAssertion ? 'verification' : 'unknown');
    assert.equal(routed.route, isAssertion ? 'diagnosis-repair' : 'diagnostic');
    assert.notEqual(routed.route, 'source-repair');
    if (isAssertion) for (const key of ['artifactPath', 'artifactHash', 'environmentHash']) {
      const missing = structuredClone(receipt); delete missing.checks[0].verification[key];
      assert.equal(classifyDevelopmentFailure({ state: { runId: 'run-test', planHash: H }, plan: f.plan,
        definition: f.node, node: { status: 'failed' }, receipt: missing }).route, 'diagnostic');
    }
  }
});

test('historical absent report fields keep identical parsed bytes; Android recipe is format-specific', () => {
  const legacy = { version: 1, format: 'flowcairn-node-test/v1', path: 'out/report.json', requiredScenarios: [CASE] };
  assert.equal(hashObject(VerificationReportSpecSchema.parse(legacy)), hashObject(legacy));
  const android = { ...legacy, format: ANDROID_NODE_REPORT_FORMAT, android: { sourcePaths: ['app/Main.java'] } };
  assert.equal(hashObject(VerificationReportSpecSchema.parse(android)), hashObject(android));
  for (const invalid of [{ ...android, android: undefined }, { ...legacy, android: android.android },
    { ...android, android: { sourcePaths: ['app/Main.java', 'app/Main.java'] } }])
    assert.equal(VerificationReportSpecSchema.safeParse(invalid).success, false);
});

test('native Android capability registers only typed Android report; component/Node/JUnit formats stay unavailable', () => {
  const stack = { hash: H, scope: ['app'], domains: ['mobile'], packages: [] };
  for (const format of [ANDROID_NODE_REPORT_FORMAT, 'flowcairn-node-test/v1', 'jest-json', 'junit-xml']) {
    const selected = selectDevelopmentSkills({ action: 'ai-implement', stack, task: { goal: 'Native behavior', instructions: '', scope: ['app'] },
      policy: { version: 2, capabilities: [{ id: 'mobile-android-scenario', checkIds: ['native'], scope: ['app'] }] },
      availableCheckIds: ['native'], checkDefinitions: [{ id: 'native', report: { format } }] });
    assert.equal(selected.capabilities[0].status, format === ANDROID_NODE_REPORT_FORMAT ? 'registered' : 'unavailable');
    assert.equal(selected.capabilities[0].acceptance, 'unverified');
  }
});

test('artifact hash helper cannot read an unregistered path or path traversal', t => {
  const f = registered(t);
  assert.throws(() => hashRegisteredAndroidArtifact(f.root, ['out'], 'AndroidManifest.xml'), { code: 'ANDROID_ARTIFACT_SCOPE' });
  assert.throws(() => hashRegisteredAndroidArtifact(f.root, ['out'], 'out/../AndroidManifest.xml'));
});
