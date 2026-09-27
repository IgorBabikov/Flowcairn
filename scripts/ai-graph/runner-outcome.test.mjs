import test from 'node:test';
import assert from 'node:assert/strict';
import { runnerOutcome } from './lib/runner-outcome.mjs';

test('supervisor failures survive graceful CLI exit zero', () => {
  for (const failureReason of ['TIMEOUT', 'PARENT_DISCONNECTED', 'OUTPUT_LIMIT']) {
    const result = runnerOutcome({ final: { exitCode: 0, failureReason } });
    assert.equal(result.exitCode, 1);
    assert.equal(result.failureReason, failureReason);
  }
});

test('the parent watchdog retains its timeout after durable stop replay', () => {
  assert.deepEqual(runnerOutcome({ final: { exitCode: 0, failureReason: 'PARENT_DISCONNECTED' }, controlTimedOut: true }),
    { exitCode: 1, failureReason: 'TIMEOUT', timedOut: true, outputLimit: false });
  assert.equal(runnerOutcome({ final: { exitCode: 0, failureReason: null }, controlTimedOut: true }).exitCode, 0);
});

test('operator abort remains cancelled even when the child exits gracefully', () => {
  const result = runnerOutcome({ final: { exitCode: 0, failureReason: null }, aborted: true });
  assert.equal(result.exitCode, 1);
  assert.equal(result.failureReason, 'ABORTED');
});
