import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { captureVerificationReport, readFreshVerificationReport } from '../scripts/ai-graph/lib/verification-report-file.mjs';
import { inspectCheckProfile, validateCheckProfile } from '../scripts/ai-graph/lib/check-profile.mjs';

const spec = { version: 1, format: 'playwright-json', path: 'reports/browser.json', requiredScenarios: ['search'] };
function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'flowcairn-report-file-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'reports'));
  return { root, write: (text) => writeFileSync(path.join(root, spec.path), text) };
}

test('registered report reader requires a current completed JSON artifact', (t) => {
  const f = fixture(t);
  assert.equal(captureVerificationReport(f.root, spec), null);
  assert.throws(() => readFreshVerificationReport(f.root, spec), { code: 'CHECK_REPORT_MISSING' });
  f.write('{"suites":[]}');
  const before = captureVerificationReport(f.root, spec);
  assert.throws(() => readFreshVerificationReport(f.root, spec, before), { code: 'CHECK_REPORT_STALE' });
  f.write('{"suites":[{"title":"search"}]}');
  const after = readFreshVerificationReport(f.root, spec, before);
  assert.notEqual(after.hash, before.hash);
  assert.equal(after.value.suites[0].title, 'search');
  f.write('{"suites":[');
  assert.throws(() => readFreshVerificationReport(f.root, spec), { code: 'CHECK_REPORT_INVALID' });
});

test('report paths, directory links, symlinks and hardlinks cannot escape the registered project', (t) => {
  const f = fixture(t);
  assert.throws(() => captureVerificationReport(f.root, { ...spec, path: '../outside.json' }));
  assert.throws(() => captureVerificationReport(f.root, { ...spec, path: '.env' }));
  writeFileSync(path.join(f.root, 'real.json'), '{}');
  symlinkSync(path.join(f.root, 'real.json'), path.join(f.root, spec.path));
  assert.throws(() => captureVerificationReport(f.root, spec), { code: 'CHECK_PATH_UNSAFE' });
  rmSync(path.join(f.root, spec.path));
  linkSync(path.join(f.root, 'real.json'), path.join(f.root, spec.path));
  assert.throws(() => captureVerificationReport(f.root, spec), { code: 'CHECK_REPORT_UNSAFE' });
});

test('registration cannot turn a source file into the verifier report or add executable report metadata', () => {
  const check = { id: 'browser', title: 'Browser', purpose: 'Search', command: { executable: 'node', argv: [], cwd: '.' },
    inputPaths: ['test.mjs'], outputPaths: ['reports'], timeoutMs: 5000, maxOutputBytes: 65536, report: spec };
  const profile = (definition) => ({ version: 1, requiredCheckIds: ['browser'], environment: [], definitions: [definition] });
  validateCheckProfile(profile(check));
  assert.throws(() => validateCheckProfile(profile({ ...check, report: { ...spec, path: 'src/search.mjs' } })), { code: 'CHECK_REPORT_UNSAFE' });
  assert.throws(() => validateCheckProfile(profile({ ...check, report: { ...spec, executable: '/bin/sh' } })));
});

test('explicit dependency/tool identities invalidate a previous registered toolchain when their bytes change', (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.root, 'tool-version.json'), '{"version":"1"}');
  const definition = { id: 'browser', title: 'Browser', purpose: 'SDK identity', command: { executable: process.execPath, argv: ['--version'], cwd: '.' },
    inputPaths: [], identityFiles: ['tool-version.json'], outputPaths: ['reports'], timeoutMs: 5000, maxOutputBytes: 65536, report: spec };
  const profile = { version: 1, requiredCheckIds: ['browser'], environment: [], definitions: [definition] };
  const before = inspectCheckProfile(f.root, profile);
  writeFileSync(path.join(f.root, 'tool-version.json'), '{"version":"2"}');
  const after = inspectCheckProfile(f.root, profile);
  assert.notEqual(after.bindings[0].toolchainHash, before.bindings[0].toolchainHash);
  assert.equal(after.bindings[0].executableHash, before.bindings[0].executableHash);
});
