import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, linkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashObject, sha256 } from '../scripts/ai-graph/lib/io.mjs';
import { verifyCurrentCheckArtifacts } from '../scripts/ai-graph/lib/check-artifact-current.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flowcairn-artifact-current-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'out'));
  writeFileSync(path.join(root, 'out/app.apk'), Buffer.from([1, 2, 3, 0]));
  const fingerprint = { hash: hashObject('unchanged source') };
  const definition = { id: 'native', outputPaths: ['out'], report: { format: 'flowcairn-android-node/v1' } };
  const binding = { id: 'native', definitionHash: hashObject(definition), toolchainHash: hashObject('sdk tools') };
  const checks = { definitions: [definition], bindings: [binding] };
  const node = { id: 'check-native-final', action: { id: 'check-native' } };
  const plan = { nodes: [node], checks, checkRegistryHash: hashObject(checks), runtimeHash: hashObject('runtime') };
  const receipt = { runId: 'control', nodeId: node.id, planHash: hashObject(plan), phase: 'finished', verdict: 'pass', exitCode: 0,
    beforeFingerprint: fingerprint.hash, afterFingerprint: fingerprint.hash, termination: { stopped: true, uncertain: false },
    checks: [{ id: node.id, passed: true, inputHash: fingerprint.hash, verification: {
      version: 1, format: definition.report.format, specHash: hashObject(definition.report), inputHash: fingerprint.hash,
      adapterHash: hashObject({ runtimeHash: plan.runtimeHash, format: definition.report.format }),
      checkRegistryHash: plan.checkRegistryHash, definitionHash: binding.definitionHash, toolchainHash: binding.toolchainHash,
      artifactPath: 'out/app.apk', artifactHash: sha256(Buffer.from([1, 2, 3, 0])),
    } }] };
  const state = { runId: receipt.runId, planHash: receipt.planHash, nodes: { [node.id]: { status: 'passed', receipts: [hashObject(receipt)] } } };
  const input = () => ({ root, state, plan, fingerprint, readReceipt: () => receipt });
  const seal = () => { state.nodes[node.id].receipts = [hashObject(receipt)]; };
  return { root, input, seal, receipt, state, plan, fingerprint };
}

test('current actual artifact is checked independently of the source fingerprint', t => {
  const f = fixture(t);
  assert.equal(verifyCurrentCheckArtifacts(f.input()).length, 1);
  writeFileSync(path.join(f.root, 'out/app.apk'), Buffer.from([3, 2, 1, 0]));
  assert.throws(() => verifyCurrentCheckArtifacts(f.input()), { code: 'CHECK_ARTIFACT_DRIFT' });
});
test('missing and linked artifact fail without following a replacement outside output', t => {
  const f = fixture(t);
  rmSync(path.join(f.root, 'out/app.apk'));
  assert.throws(() => verifyCurrentCheckArtifacts(f.input()), { code: 'CHECK_ARTIFACT_DRIFT' });
  writeFileSync(path.join(f.root, 'outside.apk'), Buffer.from([1, 2, 3, 0]));
  symlinkSync('../outside.apk', path.join(f.root, 'out/app.apk'));
  assert.throws(() => verifyCurrentCheckArtifacts(f.input()), { code: 'CHECK_ARTIFACT_DRIFT' });
});
test('an immutable receipt cannot be transplanted or point to non-output material', t => {
  for (const change of [f => { f.receipt.planHash = hashObject('other plan'); },
    f => { f.receipt.checks[0].verification.artifactPath = 'outside.apk'; },
    f => { f.receipt.checks[0].verification.toolchainHash = hashObject('other SDK'); }]) {
    const f = fixture(t); change(f); f.seal();
    assert.throws(() => verifyCurrentCheckArtifacts(f.input()), { code: 'CHECK_ARTIFACT_DRIFT' });
  }
});
test('historical absent material path and source-stale checks retain existing semantics', t => {
  const f = fixture(t);
  delete f.receipt.checks[0].verification.artifactPath; f.seal();
  assert.deepEqual(verifyCurrentCheckArtifacts(f.input()), []);
  f.receipt.checks[0].verification.artifactPath = 'out/missing.apk';
  f.receipt.beforeFingerprint = hashObject('old source'); f.seal();
  assert.deepEqual(verifyCurrentCheckArtifacts(f.input()), []);
});

function iosFixture(t, { legacy = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flowcairn-ios-material-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const resultPath = 'runs/control/tests.xcresult';
  const appPath = 'runs/control/DerivedData/Build/Products/Debug-iphonesimulator/NativeControl.app';
  mkdirSync(path.join(root, resultPath), { recursive: true });
  mkdirSync(path.join(root, appPath), { recursive: true });
  writeFileSync(path.join(root, resultPath, 'Info.plist'), 'result');
  writeFileSync(path.join(root, appPath, 'Info.plist'), 'application');
  const definition = { id: 'native', outputPaths: ['runs'], report: { format: 'flowcairn-xctest/v1',
    ...(!legacy ? { xctest: { artifactRoot: 'runs', resultName: 'tests.xcresult',
      applicationRelativePath: 'DerivedData/Build/Products/Debug-iphonesimulator/NativeControl.app',
      algorithm: 'sha256-tree-v1' } } : {}) } };
  const binding = { id: 'native', definitionHash: hashObject(definition), toolchainHash: hashObject('xcode') };
  const checks = { definitions: [definition], bindings: [binding] };
  const node = { id: 'check-native-final', action: { id: 'check-native' } };
  const plan = { nodes: [node], checks, checkRegistryHash: hashObject(checks), runtimeHash: hashObject('runtime') };
  const fingerprint = { hash: hashObject('unchanged source') };
  const verification = { version: 1, format: definition.report.format, specHash: hashObject(definition.report),
    inputHash: fingerprint.hash, adapterHash: hashObject({ runtimeHash: plan.runtimeHash, format: definition.report.format }),
    checkRegistryHash: plan.checkRegistryHash, definitionHash: binding.definitionHash, toolchainHash: binding.toolchainHash,
    artifactHash: hashObject({ 'Info.plist': sha256('result') }),
    ...(!legacy ? { artifactPath: resultPath, applicationArtifactPath: appPath,
      applicationArtifactHash: hashObject({ 'Info.plist': sha256('application') }) } : {}) };
  const receipt = { runId: 'ios-control', nodeId: node.id, planHash: hashObject(plan), phase: 'finished', verdict: 'pass', exitCode: 0,
    beforeFingerprint: fingerprint.hash, afterFingerprint: fingerprint.hash, termination: { stopped: true, uncertain: false },
    checks: [{ id: node.id, passed: true, inputHash: fingerprint.hash, verification }] };
  const state = { runId: receipt.runId, planHash: receipt.planHash,
    nodes: { [node.id]: { status: 'passed', receipts: [hashObject(receipt)] } } };
  const input = () => ({ root, state, plan, fingerprint, readReceipt: () => receipt });
  const seal = () => { state.nodes[node.id].receipts = [hashObject(receipt)]; };
  return { root, resultPath, appPath, receipt, input, seal, fingerprint };
}

test('current XCTest result and actually tested .app are each rehashed with unchanged source', t => {
  const f = iosFixture(t);
  assert.equal(verifyCurrentCheckArtifacts(f.input()).length, 1);
  writeFileSync(path.join(f.root, f.appPath, 'Info.plist'), 'different app');
  assert.throws(() => verifyCurrentCheckArtifacts(f.input()), { code: 'CHECK_ARTIFACT_DRIFT' });
  writeFileSync(path.join(f.root, f.appPath, 'Info.plist'), 'application');
  writeFileSync(path.join(f.root, f.resultPath, 'Info.plist'), 'different result');
  assert.throws(() => verifyCurrentCheckArtifacts(f.input()), { code: 'CHECK_ARTIFACT_DRIFT' });
});

test('XCTest material guard rejects missing, linked, transplanted and partially bound outputs', t => {
  for (const change of [
    f => rmSync(path.join(f.root, f.appPath), { recursive: true }),
    f => { rmSync(path.join(f.root, f.appPath), { recursive: true }); symlinkSync(path.join(f.root, f.resultPath), path.join(f.root, f.appPath)); },
    f => { f.receipt.checks[0].verification.applicationArtifactPath = f.appPath.replace('/control/', '/other/'); f.seal(); },
    f => { delete f.receipt.checks[0].verification.applicationArtifactHash; f.seal(); },
    f => { f.receipt.checks[0].verification.artifactHash = sha256('wrong'); f.seal(); },
  ]) {
    const f = iosFixture(t); change(f);
    assert.throws(() => verifyCurrentCheckArtifacts(f.input()), { code: 'CHECK_ARTIFACT_DRIFT' });
  }
});

test('native bundle hardlinks and ancestor aliases fail, while historical hash-only XCTest stays historical', t => {
  const linked = iosFixture(t);
  linkSync(path.join(linked.root, linked.resultPath, 'Info.plist'), path.join(linked.root, linked.appPath, 'Linked.plist'));
  assert.throws(() => verifyCurrentCheckArtifacts(linked.input()), { code: 'CHECK_ARTIFACT_DRIFT' });
  const alias = iosFixture(t);
  rmSync(path.join(alias.root, 'runs/control/DerivedData'), { recursive: true });
  mkdirSync(path.join(alias.root, 'other/Build/Products/Debug-iphonesimulator/NativeControl.app'), { recursive: true });
  writeFileSync(path.join(alias.root, 'other/Build/Products/Debug-iphonesimulator/NativeControl.app/Info.plist'), 'application');
  symlinkSync(path.join(alias.root, 'other'), path.join(alias.root, 'runs/control/DerivedData'));
  assert.throws(() => verifyCurrentCheckArtifacts(alias.input()), { code: 'CHECK_ARTIFACT_DRIFT' });
  const historical = iosFixture(t, { legacy: true });
  assert.deepEqual(verifyCurrentCheckArtifacts(historical.input()), []);
});
