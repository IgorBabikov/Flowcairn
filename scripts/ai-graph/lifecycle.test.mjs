import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireRuntimeLease, acquireUninstallGuard } from './lib/lifecycle.mjs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { GraphStore } from './lib/store.mjs';
const fixture = (t) => { const root = mkdtempSync(path.join(os.tmpdir(), 'flowcairn-lifecycle-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; };
test('fresh initialized lifecycle proves no owners/worktrees and releases its fence without leftovers', async (t) => {
  const root = fixture(t);
  const guard = await acquireUninstallGuard({ root });
  assert.deepEqual(guard.worktreePaths, []);
  assert.equal(guard.processProbe().state, 'stopped');
  assert.equal(guard.processProbe().verified, true);
  assert.throws(() => acquireRuntimeLease({ root, kind: 'viewer' }), (error) => error.code === 'UNINSTALL_IN_PROGRESS');
  guard.release(); guard.release();
  assert.equal(guard.processProbe().verified, false);
  assert.equal(existsSync(path.join(root, '.ai-orchestrator/lifecycle-uninstall.lock')), false);
  assert.equal(existsSync(path.join(root, '.ai-orchestrator/runtime-leases')), false);
});
test('live service/viewer owner blocks uninstall; normal release permits it', async (t) => {
  const root = fixture(t), service = acquireRuntimeLease({ root, kind: 'service' }), viewer = acquireRuntimeLease({ root, kind: 'viewer' });
  t.after(service); t.after(viewer);
  await assert.rejects(acquireUninstallGuard({ root }), (error) => error.code === 'UNINSTALL_PROCESS_ACTIVE');
  viewer();
  await assert.rejects(acquireUninstallGuard({ root }), (error) => error.code === 'UNINSTALL_PROCESS_ACTIVE');
  service();
  const guard = await acquireUninstallGuard({ root });
  assert.equal(guard.processProbe().verified, true); guard.release();
});
test('probe rejects post-inspection state drift and does not delete worktrees', async (t) => {
  const root = fixture(t);
  mkdirSync(path.join(root, '.ai-orchestrator'), { mode: 0o700 });
  const trees = path.join(root, '.ai-orchestrator/worktrees'); mkdirSync(trees, { mode: 0o700 });
  const tree = path.join(trees, 'task-1'); mkdirSync(tree, { mode: 0o700 }); writeFileSync(path.join(tree, 'result.txt'), 'preserve');
  const guard = await acquireUninstallGuard({ root });
  assert.deepEqual(guard.worktreePaths, [realpathSync(tree)]);
  assert.equal(guard.processProbe().verified, true);
  new GraphStore(root).createRun('registration-late', { kind: 'intake-operation', status: 'finished' });
  assert.equal(guard.processProbe().verified, false);
  guard.release(); assert.equal(existsSync(path.join(tree, 'result.txt')), true);
});
test('orphan registration and unknown lease metadata refuse uninstall', async (t) => {
  const root = fixture(t);
  new GraphStore(root).createRun('registration-orphan', { kind: 'intake-operation', status: 'running', ownerPid: 123456 });
  await assert.rejects(acquireUninstallGuard({ root }), (e) => e.code === 'UNINSTALL_PROCESS_UNKNOWN');
});

test('new worktree after guard inventory invalidates the synchronous proof', async (t) => {
  const root = fixture(t), guard = await acquireUninstallGuard({ root });
  mkdirSync(path.join(root, '.ai-orchestrator/worktrees'), { mode: 0o700 });
  mkdirSync(path.join(root, '.ai-orchestrator/worktrees/new'), { mode: 0o700 });
  assert.equal(guard.processProbe().verified, false); guard.release();
});

test('verified dead lease is removed, but a later edited replacement is preserved', async (t) => {
  const root = fixture(t);
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  assert.equal(child.status, 0);
  const pid = Number(child.stdout); assert.throws(() => process.kill(pid, 0), (error) => error.code === 'ESRCH');
  const folder = path.join(root, '.ai-orchestrator/runtime-leases');
  mkdirSync(path.join(root, '.ai-orchestrator'), { mode: 0o700 }); mkdirSync(folder, { mode: 0o700 });
  const identity = randomUUID(), file = path.join(folder, `${identity}.json`);
  const receipt = { version: 1, kind: 'viewer', pid, identity, startedAt: new Date().toISOString() };
  writeFileSync(file, JSON.stringify(receipt), { mode: 0o600 });
  const guard = await acquireUninstallGuard({ root });
  assert.equal(existsSync(file), false);
  assert.equal(guard.processProbe().verified, true);
  mkdirSync(folder, { mode: 0o700 });
  writeFileSync(file, JSON.stringify({ ...receipt, startedAt: 'edited-replacement' }), { mode: 0o600 });
  assert.equal(guard.processProbe().verified, false);
  guard.release(); assert.equal(existsSync(file), true);
});
