import assert from 'node:assert/strict';
import test from 'node:test';
import { autonomyForNodes, validAutonomyForNodes } from './lib/autonomy-policy.mjs';

const nodes = (count) => Array.from({ length: count }, () => ({ action: { id: 'ai-implement' } }));

test('trusted autonomy duration grows with implementation steps and stays bounded', () => {
  assert.equal(autonomyForNodes(nodes(4)).maxDurationMs, 30 * 60 * 1000);
  assert.equal(autonomyForNodes(nodes(8)).maxDurationMs, 90 * 60 * 1000);
  assert.equal(autonomyForNodes(nodes(20)).maxDurationMs, 120 * 60 * 1000);
});

test('historical fixed-duration plans remain readable', () => {
  assert.equal(validAutonomyForNodes({ maxRepairCycles: 2, maxDurationMs: 30 * 60 * 1000 }, nodes(8)), true);
  assert.equal(validAutonomyForNodes(autonomyForNodes(nodes(8)), nodes(8)), true);
  assert.equal(validAutonomyForNodes({ maxRepairCycles: 2, maxDurationMs: 45 * 60 * 1000 }, nodes(8)), false);
});
