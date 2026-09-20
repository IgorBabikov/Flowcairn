import assert from 'node:assert/strict';
import test from 'node:test';
import { canReplanRejectedImplementation } from './lib/manual-continuation.mjs';

const plan = { workflow: 'autonomous', stage: 'execution',
  nodes: [{ id: 'step', action: { id: 'ai-implement' } }] };
const state = { status: 'failed', activeOperation: null, finalDisposition: null,
  planVersion: 9, nodes: { step: { status: 'failed', changedFiles: [], receipts: ['receipt'] } } };
const receipt = { phase: 'finished', verdict: 'fail', beforeFingerprint: 'same',
  afterFingerprint: 'same', termination: { stopped: true, uncertain: false } };

test('a stopped rejected AI edit allows a fresh gated plan after automatic budget', () => {
  assert.equal(canReplanRejectedImplementation(state, plan, () => receipt), true);
  assert.equal(canReplanRejectedImplementation(state, plan, () => ({ ...receipt, afterFingerprint: 'changed' })), false);
  assert.equal(canReplanRejectedImplementation(state, plan, () => ({ ...receipt,
    termination: { stopped: false, uncertain: true } })), false);
  assert.equal(canReplanRejectedImplementation({ ...state, nodes: { step: { ...state.nodes.step,
    changedFiles: ['src/file.ts'] } } }, plan, () => receipt), false);
});
