import test from 'node:test';
import assert from 'node:assert/strict';
import { AutonomousDriver } from './lib/service-driver.mjs';
import { GraphError } from './lib/io.mjs';

function fixture(overrides = {}) {
  const state = { schemaVersion: 3, runId: 'run-driver', revision: 7, planHash: 'plan', actor: 'operator',
    status: 'ready', learning: {}, continuation: { kind: 'open' }, nodes: {} };
  const plan = { workflow: 'autonomous', stage: 'planning', nodes: [] };
  const writes = [], calls = [];
  const host = {
    listRunIds: () => [state.runId], readRun: () => state,
    read: () => ({ state, plan, task: {} }),
    capabilities: () => ({ run: { run: { allowed: true }, requestReplan: { allowed: false } } }),
    executionDeadline: () => null,
    write: (current, patch) => { assert.equal(current, state); writes.push(patch); Object.assign(state, patch); },
    run: async (runId, request, actor) => { calls.push({ runId, request, actor }); state.stopRequested = true; },
    ...overrides,
  };
  const driver = new AutonomousDriver(host);
  return { driver, host, state, plan, writes, calls };
}

test('duplicate wakeups invoke the host once and reread stop before a successor', async () => {
  const f = fixture();
  f.driver.schedule(f.state.runId);
  const pending = f.driver.pending.get(f.state.runId);
  f.driver.schedule(f.state.runId);
  assert.equal(f.driver.pending.get(f.state.runId), pending);
  assert.equal(f.calls.length, 0, 'scheduling yields before executing');
  await pending;
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].request.expectedRevision, 7);
  assert.equal(f.calls[0].actor, 'operator');
  assert.equal(f.driver.pending.size, 0);
});

test('a non-progressing host is bounded and never receives concurrent run calls', async () => {
  const f = fixture();
  let active = 0, peak = 0, calls = 0;
  f.host.run = async () => { calls++; peak = Math.max(peak, ++active); await Promise.resolve(); active--; };
  f.driver.schedule(f.state.runId);
  await f.driver.pending.get(f.state.runId);
  assert.equal(calls, 12);
  assert.equal(peak, 1);
});

for (const patch of [
  { stopRequested: true }, { setupPending: true }, { activeOperation: { id: 'owned' } },
  { finalDisposition: 'cancelled' }, { learning: { failure: { code: 'capture' } } },
  { continuation: { kind: 'learning-hold' } }, { schemaVersion: 1 },
]) test(`startup skips held or owned work: ${JSON.stringify(patch)}`, () => {
  const f = fixture({ read: () => { throw Error('held work must not reach verified read'); } });
  Object.assign(f.state, patch);
  f.driver.resumeReadyWork();
  assert.equal(f.driver.pending.size, 0);
});

test('a rejected verified startup read leaves the run diagnostic without scheduling', () => {
  const f = fixture({ read: () => { throw new GraphError('POLICY_GRANT', 'invalid grant'); } });
  f.driver.resumeReadyWork();
  assert.equal(f.driver.pending.size, 0);
  assert.deepEqual(f.writes, []);
});

for (const activeOperation of [null, { id: 'other-owner' }]) test(`scheduler error preserves operation ownership: ${Boolean(activeOperation)}`, async () => {
  const f = fixture({ read: () => { throw new GraphError('STATE_INTEGRITY', 'invalid state'); } });
  f.state.activeOperation = activeOperation;
  f.driver.schedule(f.state.runId);
  await f.driver.pending.get(f.state.runId);
  assert.equal(f.driver.pending.size, 0);
  assert.deepEqual(f.writes, activeOperation ? [] : [{ failureReason: 'STATE_INTEGRITY: invalid state' }]);
});

test('a scheduler diagnostic write failure rejects the tracked promise and releases the wakeup', async () => {
  const f = fixture({ read: () => { throw Error('private detail'); }, write: () => { throw new GraphError('REVISION_CONFLICT', 'stale'); } });
  f.driver.schedule(f.state.runId);
  await assert.rejects(f.driver.pending.get(f.state.runId), { code: 'REVISION_CONFLICT' });
  assert.equal(f.driver.pending.size, 0);
});
