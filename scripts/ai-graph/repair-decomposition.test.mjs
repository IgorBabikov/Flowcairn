import assert from 'node:assert/strict';
import test from 'node:test';
import { repairExecutionSteps } from './lib/repair-decomposition.mjs';

test('timed-out module-wide work is split without changing the write scope', () => {
  const modules = Array.from({ length: 25 }, (_, index) => `src/modules/module-${index + 1}`);
  const aggregator = 'src/localization/tmg.ru.json';
  const plan = { taskContract: { requirements: [{ id: 'req-modules', workIds: ['step-modules'] }] },
    nodes: [{ id: 'step-modules', action: { id: 'ai-implement' }, title: 'Перенести переводы',
      outcome: 'Модульные словари готовы', needs: ['approve-plan'],
      resources: { writes: [aggregator, ...modules], reads: [aggregator, 'src/modules'] } }] };
  const state = { workspaceFingerprint: { files: [
    { path: aggregator }, ...modules.map((entry) => ({ path: `${entry}/index.ts` }))] },
    nodes: { 'step-modules': { status: 'uncertain', changedFiles: [], receipts: ['timed-out'] } } };
  const readReceipt = () => ({ phase: 'finished', beforeFingerprint: 'same', afterFingerprint: 'same',
    termination: { timedOut: true, stopped: true } });
  const result = repairExecutionSteps(plan, state, readReceipt);
  assert.equal(result.steps.length, 5);
  assert.deepEqual(result.steps.map((step) => step.paths.length), [6, 6, 6, 6, 6]);
  assert.deepEqual(result.steps.flatMap((step) => step.paths).filter((file) => file !== aggregator), modules);
  assert.ok(result.steps.every((step) => step.paths.includes(aggregator) && step.requirementIds.includes('req-modules')));
  assert.deepEqual(result.steps[1].needs, [result.steps[0].id]);
  assert.deepEqual(result.isolatedReadStepIds, result.steps.map((step) => step.id));
  assert.equal(result.repairReadPaths[result.steps[0].id].filter((file) => file.startsWith('src/modules/')).length, 5);
  assert.ok(!result.repairReadPaths[result.steps[0].id].includes('src/modules'));
});

test('ordinary repair keeps implementation steps unchanged', () => {
  const plan = { taskContract: { requirements: [] }, nodes: [{ id: 'step-one', action: { id: 'ai-implement' },
    title: 'Изменить файл', outcome: 'Готово', needs: ['approve-plan'],
    resources: { writes: ['src/a.ts'], reads: ['src/a.ts'] } }] };
  const state = { workspaceFingerprint: { files: [{ path: 'src/a.ts' }] },
    nodes: { 'step-one': { status: 'failed', changedFiles: [], receipts: ['failed'] } } };
  assert.deepEqual(repairExecutionSteps(plan, state, () => ({ phase: 'finished' })).steps,
    [{ id: 'fix-1', title: 'Изменить файл', outcome: 'Готово', paths: ['src/a.ts'],
      requirementIds: [], needs: [] }]);
});

test('a later repair preserves narrow reads of previously split parts', () => {
  const modules = Array.from({ length: 10 }, (_, index) => `src/modules/module-${index + 1}`);
  const aggregator = 'src/localization/tmg.ru.json';
  const plan = { taskContract: { requirements: [] }, nodes: [0, 1].map((part) => ({
    id: `step-fix-2-part-${part + 1}`, action: { id: 'ai-implement' }, title: 'Перенести переводы',
    outcome: 'Готово', needs: part ? ['step-fix-2-part-1'] : ['approve-plan'],
    resources: { writes: [aggregator, ...modules.slice(part * 5, (part + 1) * 5)],
      reads: [aggregator, 'src/modules', ...modules] },
  })) };
  const state = { workspaceFingerprint: { files: [
    { path: aggregator }, ...modules.map((entry) => ({ path: `${entry}/index.ts` }))] },
    nodes: Object.fromEntries(plan.nodes.map((node) => [node.id,
      { status: 'passed', changedFiles: [], receipts: ['finished'] }])) };
  const result = repairExecutionSteps(plan, state, () => ({ phase: 'finished' }));
  assert.equal(result.steps.length, 2);
  assert.equal(result.isolatedReadStepIds.length, 2);
  assert.deepEqual(result.repairReadPaths['fix-1'].filter((file) => file.startsWith('src/modules/')), modules.slice(0, 5));
  assert.deepEqual(result.repairReadPaths['fix-2'].filter((file) => file.startsWith('src/modules/')), modules.slice(5));
});
