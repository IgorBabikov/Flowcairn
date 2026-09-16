import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync, rmSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initializeProject } from '../bin/flowcairn.mjs';
import { uninstallCommand } from '../bin/uninstall.mjs';
import * as integration from '../scripts/ai-graph/lib/integration.mjs';
import * as uninstall from '../scripts/ai-graph/lib/uninstall.mjs';
import { acquireRuntimeLease } from '../scripts/ai-graph/lib/lifecycle.mjs';

const testClaude = path.resolve(import.meta.dirname, 'fixtures/verified-claude/node_modules/@anthropic-ai/claude-code/bin/claude.exe');
const options = { provider: 'claude', 'provider-path': testClaude };
function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-uninstall-cli-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('/usr/bin/git', ['init', '--initial-branch=main'], { cwd: root, stdio: 'ignore' });
  writeFileSync(path.join(root, 'package.json'), '{"name":"fixture","version":"1.0.0"}');
  writeFileSync(path.join(root, 'AGENTS.md'), '# Existing rules\n');
  writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');
  initializeProject(root, options);
  return root;
}
function fakeLifecycle({ state = 'stopped', released = () => {} } = {}) {
  return async () => ({ ...integration, ...uninstall,
    acquireUninstallGuard: async () => ({
      processProbe: () => ({ state, verified: state === 'stopped', evidence: 'unit-fixture-lifecycle-proof' }),
      worktreePaths: [], release: released,
    }),
  });
}

test('preview is inert; full unchanged init uninstall preserves original rules and ignore; repeat is no-op', async (t) => {
  const root = fixture(t);
  let released = 0;
  const loader = fakeLifecycle({ released: () => released++ });
  const before = readFileSync(path.join(root, '.flowcairn.json'));
  const preview = await uninstallCommand(root, { 'dry-run': true }, loader);
  assert.equal(preview.canRemove, true);
  assert.deepEqual(readFileSync(path.join(root, '.flowcairn.json')), before);
  const result = await uninstallCommand(root, {}, loader);
  assert.equal(result.status, 'complete');
  assert.equal(existsSync(path.join(root, '.flowcairn.json')), false);
  assert.equal(existsSync(path.join(root, '.ai-orchestrator')), false);
  assert.equal(readFileSync(path.join(root, '.gitignore'), 'utf8'), 'node_modules/\n');
  assert.doesNotMatch(readFileSync(path.join(root, '.git/info/exclude'), 'utf8'), /\.ai-orchestrator\//);
  assert.equal(readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), '# Existing rules\n');
  assert.equal((await uninstallCommand(root, {}, loader)).changed, false);
  assert.equal(released, 3);
});

test('active lifecycle and changed owned files refuse all deletion', async (t) => {
  const root = fixture(t);
  const profile = readFileSync(path.join(root, '.flowcairn.json'));
  await assert.rejects(uninstallCommand(root, {}, fakeLifecycle({ state: 'active' })), { code: 'UNINSTALL_PROCESS_UNKNOWN' });
  assert.deepEqual(readFileSync(path.join(root, '.flowcairn.json')), profile);
  writeFileSync(path.join(root, '.ai-orchestrator/task.example.json'), '{}');
  await assert.rejects(uninstallCommand(root, {}, fakeLifecycle()), { code: 'UNINSTALL_MODIFIED_FILE' });
  assert.deepEqual(readFileSync(path.join(root, '.flowcairn.json')), profile);
});

test('unrelated project ignore edits, user results and dependencies remain and status is partial', async (t) => {
  const root = fixture(t);
  writeFileSync(path.join(root, '.gitignore'), readFileSync(path.join(root, '.gitignore'), 'utf8') + 'user-output/\n');
  mkdirSync(path.join(root, '.ai-orchestrator/results'));
  writeFileSync(path.join(root, '.ai-orchestrator/results/user-result.txt'), 'keep');
  writeFileSync(path.join(root, 'package.json'), '{"name":"fixture","devDependencies":{"flowcairn":"0.1.2"}}');
  const result = await uninstallCommand(root, {}, fakeLifecycle());
  assert.equal(result.status, 'partial');
  assert.ok(readFileSync(path.join(root, '.gitignore'), 'utf8').endsWith('user-output/\n'));
  assert.match(readFileSync(path.join(root, '.git/info/exclude'), 'utf8'), /\.ai-orchestrator\//);
  assert.equal(existsSync(path.join(root, '.ai-orchestrator/flowcairn-install.json')), true);
  assert.equal(execFileSync('/usr/bin/git', ['check-ignore', '.ai-orchestrator/results/user-result.txt'], { cwd: root, encoding: 'utf8' }).trim(), '.ai-orchestrator/results/user-result.txt');
  assert.equal(readFileSync(path.join(root, '.ai-orchestrator/results/user-result.txt'), 'utf8'), 'keep');
  assert.match(readFileSync(path.join(root, 'package.json'), 'utf8'), /flowcairn/);
  assert.equal(result.packageRemovalCommand, 'npm uninstall flowcairn');
});

test('adopted profile and linked owner receipt are never removed', async (t) => {
  const root = fixture(t);
  const profile = readFileSync(path.join(root, '.flowcairn.json'));
  rmSync(path.join(root, '.ai-orchestrator'), { recursive: true });
  initializeProject(root, options);
  assert.equal((await uninstallCommand(root, {}, fakeLifecycle())).status, 'partial');
  assert.deepEqual(readFileSync(path.join(root, '.flowcairn.json')), profile);
  initializeProject(root, options);
  rmSync(path.join(root, '.ai-orchestrator/flowcairn-install.json'));
  symlinkSync(path.join(root, '.flowcairn.json'), path.join(root, '.ai-orchestrator/flowcairn-install.json'));
  await assert.rejects(uninstallCommand(root, {}, fakeLifecycle()));
  assert.deepEqual(readFileSync(path.join(root, '.flowcairn.json')), profile);
});

test('new retained data noticed after deactivation keeps the ignore rule and ownership receipt', async (t) => {
  const root = fixture(t);
  const base = await fakeLifecycle()();
  const loader = async () => ({ ...base, uninstallIntegration: (contract) => {
    const result = uninstall.uninstallIntegration(contract);
    writeFileSync(path.join(root, '.ai-orchestrator/new-result.txt'), 'preserve');
    return result;
  } });
  const result = await uninstallCommand(root, {}, loader);
  assert.equal(result.status, 'partial');
  assert.equal(existsSync(path.join(root, '.ai-orchestrator/flowcairn-install.json')), true);
  assert.equal(execFileSync('/usr/bin/git', ['check-ignore', '.ai-orchestrator/new-result.txt'], { cwd: root, encoding: 'utf8' }).trim(), '.ai-orchestrator/new-result.txt');
});

test('real runtime fence refuses a live viewer and reverses fresh config plus managed instructions after release', async (t) => {
  const root = fixture(t);
  const before = readFileSync(path.join(root, 'AGENTS.md'));
  const fingerprint = integration.inspectIntegration({ projectRoot: root }).instructions.fingerprint;
  integration.activateIntegration({ projectRoot: root, consent: true, expectedFingerprint: fingerprint });
  const release = acquireRuntimeLease({ root, kind: 'viewer' });
  try {
    await assert.rejects(uninstallCommand(root), { code: 'UNINSTALL_PROCESS_ACTIVE' });
    assert.equal(existsSync(path.join(root, '.flowcairn.json')), true);
  } finally { release(); }
  const preview = await uninstallCommand(root, { 'dry-run': true });
  assert.equal(preview.canRemove, true);
  assert.equal(existsSync(path.join(root, '.flowcairn.json')), true);
  const result = await uninstallCommand(root);
  assert.equal(result.status, 'complete', JSON.stringify(result));
  assert.equal(existsSync(path.join(root, '.flowcairn.json')), false);
  assert.equal(existsSync(path.join(root, '.ai-orchestrator')), false);
  assert.deepEqual(readFileSync(path.join(root, 'AGENTS.md')), before);
  assert.equal(readFileSync(path.join(root, '.gitignore'), 'utf8'), 'node_modules/\n');
  assert.doesNotMatch(readFileSync(path.join(root, '.git/info/exclude'), 'utf8'), /\.ai-orchestrator\//);
});
