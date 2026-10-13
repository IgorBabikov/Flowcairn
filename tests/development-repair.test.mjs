import test from 'node:test';
import assert from 'node:assert/strict';
import { repairExecutionSteps } from '../scripts/ai-graph/lib/repair-decomposition.mjs';

const contract = 'ExportV1 = { text: string }; preserve the full text';

test('repair preserves interface identity, contracts and producer dependencies through immutable replan', () => {
  const plan = { workflowPolicy: 'developer-v1', taskContract: { requirements: [{ id: 'req-text', workIds: ['step-format', 'step-export'] }] }, nodes: [
    { id: 'step-format', action: { id: 'ai-implement' }, title: 'Format', outcome: 'Typed text format', needs: ['approve-plan'],
      resources: { writes: ['src/format.mjs'], reads: ['src/format.mjs'] }, produces: [{ id: 'text-v1', contract }] },
    { id: 'step-export', action: { id: 'ai-implement' }, title: 'Export', outcome: 'Download text', needs: ['step-format', 'check-format'],
      resources: { writes: ['src/export.mjs'], reads: ['src/format.mjs', 'src/export.mjs'] }, consumes: [{ id: 'text-v1', producerId: 'step-format', contract }] },
  ] };
  const state = { workspaceFingerprint: { files: [] }, nodes: Object.fromEntries(plan.nodes.map((node) => [node.id, { status: 'failed', changedFiles: [], receipts: [] }])) };
  const result = repairExecutionSteps(plan, state, () => null);
  assert.deepEqual(result.steps[0].produces, plan.nodes[0].produces);
  assert.deepEqual(result.steps[1].consumes, [{ id: 'text-v1', producerId: 'fix-1', contract }]);
  assert.deepEqual(result.steps[1].needs, ['fix-1']);
  assert.equal(plan.nodes[1].consumes[0].producerId, 'step-format', 'historical metadata is not mutated');
});

test('developer policy does not split a coherent outcome by arbitrary directory counts after a timeout', () => {
  const paths = ['src/shared.json', ...Array.from({ length: 25 }, (_, i) => `src/module-${i}`)];
  const plan = { workflowPolicy: 'developer-v1', taskContract: { requirements: [] }, nodes: [{ id: 'step-one', action: { id: 'ai-implement' },
    title: 'Coherent migration', outcome: 'Preserve all consumers', needs: ['approve-plan'], resources: { writes: paths, reads: ['src'] } }] };
  const state = { workspaceFingerprint: { files: paths.slice(1).map((entry) => ({ path: `${entry}/index.mjs` })) },
    nodes: { 'step-one': { status: 'uncertain', changedFiles: [], receipts: ['timeout'] } } };
  const result = repairExecutionSteps(plan, state, () => ({ phase: 'finished', beforeFingerprint: 'same', afterFingerprint: 'same', termination: { timedOut: true, stopped: true } }));
  assert.equal(result.steps.length, 1);
  assert.deepEqual(result.steps[0].paths, paths);
  assert.equal(result.isolatedReadStepIds.length, 0);
});
