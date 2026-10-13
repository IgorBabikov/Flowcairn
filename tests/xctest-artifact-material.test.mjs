import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashObject, sha256 } from '../scripts/ai-graph/lib/io.mjs';
import { boundXCTestMaterialPaths, hashRegisteredXCTestTree } from '../scripts/ai-graph/lib/xctest-artifact-material.mjs';
import { RegisteredCheckSchema } from '../scripts/ai-graph/lib/check-schemas.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flowcairn-ios-tree-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = 'runs/control/tests.xcresult';
  const application = 'runs/control/DerivedData/Build/Products/Debug-iphonesimulator/NativeControl.app';
  mkdirSync(path.join(root, result), { recursive: true });
  mkdirSync(path.join(root, application), { recursive: true });
  const definition = { outputPaths: ['runs'], report: { xctest: { artifactRoot: 'runs', resultName: 'tests.xcresult',
    applicationRelativePath: 'DerivedData/Build/Products/Debug-iphonesimulator/NativeControl.app',
    algorithm: 'sha256-tree-v1' } } };
  return { root, result, application, definition };
}

test('registered tree hashes byte-identical Unicode filenames using canonical UTF-16 key order', t => {
  const f = fixture(t);
  writeFileSync(path.join(f.root, f.result, '\uE000.txt'), 'bmp');
  writeFileSync(path.join(f.root, f.result, '𝄞.txt'), 'astral');
  const expected = hashObject({ '\uE000.txt': sha256('bmp'), '𝄞.txt': sha256('astral') });
  assert.equal(hashRegisteredXCTestTree(f.root, f.definition, f.result), expected);
  assert.deepEqual(boundXCTestMaterialPaths(f.definition, f.result, f.application),
    { resultPath: f.result, applicationPath: f.application });
});

test('empty trees, wrong run pairing and deep directory expansion fail closed', t => {
  const f = fixture(t);
  assert.throws(() => hashRegisteredXCTestTree(f.root, f.definition, f.result), { code: 'XCTEST_ARTIFACT_EMPTY' });
  assert.throws(() => boundXCTestMaterialPaths(f.definition, f.result, f.application.replace('/control/', '/other/')),
    { code: 'XCTEST_ARTIFACT_SCOPE' });
  let nested = path.join(f.root, f.result);
  for (let depth = 0; depth < 66; depth++) { nested = path.join(nested, 'd'); mkdirSync(nested); }
  writeFileSync(path.join(nested, 'Info.plist'), 'deep');
  assert.throws(() => hashRegisteredXCTestTree(f.root, f.definition, f.result), { code: 'XCTEST_ARTIFACT_LIMIT' });
});

test('owner registration requires an explicit algorithm and an output-contained artifact root', () => {
  const definition = { id: 'native', title: 'Native XCTest', purpose: 'Verify current iOS app',
    command: { executable: '/usr/bin/true', argv: [], cwd: '.' }, inputPaths: [], outputPaths: ['runs'],
    timeoutMs: 30000, maxOutputBytes: 2048,
    report: { version: 1, format: 'flowcairn-xctest/v1', path: 'runs/report.json',
      requiredScenarios: ['AppUITests/testOne()'], xctest: { artifactRoot: 'runs', resultName: 'tests.xcresult',
        applicationRelativePath: 'DerivedData/NativeControl.app', algorithm: 'sha256-tree-v1' } } };
  assert.equal(RegisteredCheckSchema.parse(definition).report.xctest.algorithm, 'sha256-tree-v1');
  assert.equal(RegisteredCheckSchema.safeParse({ ...definition,
    report: { ...definition.report, xctest: { ...definition.report.xctest, artifactRoot: 'elsewhere' } } }).success, false);
  assert.equal(RegisteredCheckSchema.safeParse({ ...definition,
    report: { ...definition.report, xctest: { ...definition.report.xctest, algorithm: 'unknown' } } }).success, false);
});
