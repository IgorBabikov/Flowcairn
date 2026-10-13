import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fixture as proofFixture, request } from '../scripts/ai-graph/test-support/provable-work.mjs';
import { ReceiptSchema } from '../scripts/ai-graph/lib/schemas.mjs';
import { hashObject } from '../scripts/ai-graph/lib/io.mjs';

const REQUIREMENTS = ['Функция answer возвращает 42', 'Повторный вызов answer возвращает 42'];
const CONSTRAINTS = ['Не изменять тестовый oracle', 'Не добавлять зависимости и внешние действия'];
const INPUT = { id: 'PLAN-CORRECTION-INTEGRATION', goal: 'Исправить answer с сохранением исходного контракта',
  instructions: `${REQUIREMENTS.join('. ')}. ${CONSTRAINTS.join('. ')}.`,
  acceptance: REQUIREMENTS, scope: ['src/answer.mjs'], contextPaths: ['src/answer.test.mjs'],
  forbiddenPaths: ['out-of-scope'], checks: ['tests'], limits: { maxAttempts: 1, maxReplans: 3, timeoutMs: 60000 } };

function proposal(task, kind = 'valid') {
  const contract = 'answer(): number; result is 42';
  const steps = [
    { id: 'produce', title: 'Реализовать answer', outcome: REQUIREMENTS[0], needs: [], paths: ['src/answer.mjs'],
      requirementIds: ['req-001'], produces: [{ id: 'answer-api-v1', contract }] },
    { id: 'consume', title: 'Сохранить повторяемое поведение', outcome: REQUIREMENTS[1], needs: ['produce'], paths: ['src/answer.mjs'],
      requirementIds: ['req-002'], consumes: [{ id: 'answer-api-v1', producerId: 'produce', contract }] },
  ];
  if (kind === 'coverage') steps.pop();
  if (kind === 'interface') steps[1].consumes[0].contract = 'answer(): string; incompatible result';
  const requirements = task.acceptance.map((title, index) => ({ id: `req-${String(index + 1).padStart(3, '0')}`,
    title, mandatory: true, verification: { method: 'check', checkIds: ['check-tests'], criterion: title, paths: ['src/answer.test.mjs'] } }));
  if (kind === 'criterion') requirements[1].verification.criterion = 'Вернуть какое-нибудь значение';
  return { steps, contractProposal: { requirements, optionalImprovements: [],
    constraints: kind === 'drop-constraints' ? [] : CONSTRAINTS, assumptions: [], unknowns: [] } };
}

async function fixture(t, sequence, { discover = false, dataVersion = 2 } = {}) {
  const f = await proofFixture(t), base = f.service.adapters.execute;
  f.service.adapters.dataVersion = dataVersion;
  f.service.adapters.workflowPolicy = 'developer-v1';
  const calls = [], writes = [], source = readFileSync(path.join(f.worktree, 'src/answer.mjs'));
  const apply = f.service.adapters.applyEdits;
  f.service.adapters.applyEdits = (...args) => { writes.push(args[2].id); return apply(...args); };
  let plannerCalls = 0, analyzerCalls = 0;
  f.service.adapters.execute = async invocation => {
    calls.push({ action: invocation.node.action.id, runId: invocation.state?.runId ?? null,
      acceptance: [...invocation.task.acceptance], scope: [...invocation.task.scope], checks: [...invocation.task.checks] });
    const result = await base(invocation);
    if (invocation.node.action.id === 'ai-analyze') {
      result.output.analysis.requirements = [...invocation.task.acceptance];
      result.output.analysis.acceptance = [...invocation.task.acceptance];
      result.output.analysis.constraints = [...CONSTRAINTS];
      if (discover && analyzerCalls++ === 0) {
        result.output.verdict = 'uncertain';
        result.output.contextRequests = [{ path: 'src/answer.test.mjs', purpose: 'read', reason: 'Нужен неизменный oracle до planning' }];
      }
    }
    if (invocation.node.action.id === 'ai-plan') {
      const kind = sequence[Math.min(plannerCalls++, sequence.length - 1)];
      Object.assign(result.output, proposal(invocation.task, kind));
    }
    return result;
  };
  // The oracle is read-only context outside the precise source-write scope.
  const input = { ...INPUT, contextPaths: discover ? [] : INPUT.contextPaths,
    ...(discover ? { contextDiscovery: true } : {}) };
  const first = await f.service.create(input, { runId: 'plan-correction-first', workflow: 'autonomous', stage: 'planning' });
  const initialBytes = readFileSync(path.join(f.root, '.ai-orchestrator/graph/plans', first.planHash + '.json'));
  // A real close/open activates the existing startup driver from its ready state.
  await f.restart();
  const final = await f.settle(first);
  return { ...f, get service() { return f.service; }, restart: f.restart, first, final, calls, writes, source,
    input, initialBytes, plannerCalls: () => plannerCalls };
}

function history(f) {
  return f.service.store.listRunIds().map(id => f.service.store.readRun(id)).sort((a, b) => a.planVersion - b.planVersion);
}

function inspect(f) {
  const records = history(f);
  for (const state of records) {
    const task = f.service.store.readObject('tasks', state.taskHash), plan = f.service.store.readObject('plans', state.planHash);
    assert.equal(hashObject(task), state.taskHash);
    assert.equal(hashObject(plan), state.planHash);
    assert.deepEqual(task.acceptance, INPUT.acceptance);
    assert.deepEqual(task.scope, INPUT.scope);
    assert.deepEqual(task.checks, INPUT.checks);
    assert.equal(task.goal, INPUT.goal);
    assert.equal(task.instructions, INPUT.instructions);
    assert.deepEqual(task.forbiddenPaths, f.input.forbiddenPaths);
    assert.ok((state.planCorrectionCycles ?? 0) <= 2);
    assert.equal(state.permissions.some(permission => permission.includes('write')), false);
    for (const node of Object.values(state.nodes)) for (const id of node.receipts) {
      const receipt = ReceiptSchema.parse(f.service.store.readObject('receipts', id));
      assert.equal(hashObject(receipt), id);
      if (receipt.phase === 'finished') {
        assert.equal(receipt.termination.stopped, true);
        assert.equal(receipt.termination.uncertain, false);
        assert.equal(receipt.beforeFingerprint, receipt.afterFingerprint);
        assert.deepEqual(receipt.changedFiles, []);
      }
    }
    if (plan.stage === 'execution') {
      assert.deepEqual(plan.taskContract.requirements.map(r => ({ id: r.id, title: r.title, criterion: r.verification.criterion })),
        REQUIREMENTS.map((title, index) => ({ id: `req-${String(index + 1).padStart(3, '0')}`, title, criterion: title })));
      assert.deepEqual(plan.taskContract.constraints, CONSTRAINTS);
      assert.deepEqual(plan.taskContract.scope, INPUT.scope);
      assert.ok(plan.nodes.some(n => n.action.id === 'check-tests'));
    }
  }
  assert.equal(f.calls.some(call => call.action === 'ai-implement'), false);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(readFileSync(path.join(f.worktree, 'src/answer.mjs')), f.source);
  assert.deepEqual(readFileSync(path.join(f.root, '.ai-orchestrator/graph/plans', f.first.planHash + '.json')), f.initialBytes);
  return records;
}

function failedPlanReceipts(f) {
  return history(f).flatMap(state => Object.values(state.nodes).flatMap(node => node.receipts)
    .map(id => ReceiptSchema.parse(f.service.store.readObject('receipts', id)))
    .filter(receipt => receipt.actionId === 'ai-plan' && receipt.phase === 'finished' && receipt.verdict === 'fail'));
}

test('mandatory coverage failure is corrected by real service before source writes', { timeout: 30000 }, async t => {
  const f = await fixture(t, ['coverage', 'valid']);
  const records = inspect(f), failed = failedPlanReceipts(f);
  assert.equal(f.plannerCalls(), 2);
  assert.equal(failed.length, 1);
  assert.match(failed[0].failureReason, /^PLAN_REQUIREMENT_COVERAGE:/);
  assert.equal(f.final.phase, 'execution');
  assert.equal(f.final.status, 'waiting-for-human');
  assert.equal(records.at(-1).planCorrectionCycles, 1);
  assert.equal(f.final.proof.status === 'PROVEN', false);
});

test('incompatible produced/consumed interface cannot reach source write before correction', { timeout: 30000 }, async t => {
  const f = await fixture(t, ['interface', 'valid']);
  inspect(f);
  assert.match(failedPlanReceipts(f)[0].failureReason, /^PLAN_INTERFACE_MISMATCH:/);
  const last = history(f).at(-1), plan = f.service.store.readObject('plans', last.planHash);
  const producer = plan.nodes.find(n => n.id === 'step-produce'), consumer = plan.nodes.find(n => n.id === 'step-consume');
  assert.equal(consumer.consumes[0].producerId, producer.id);
  assert.equal(consumer.consumes[0].contract, producer.produces[0].contract);
  assert.ok(consumer.needs.includes(producer.id));
  assert.equal(last.planCorrectionCycles, 1);
});

test('only two automatic corrections occur and exhausted lineage survives real close/open', { timeout: 30000 }, async t => {
  const f = await fixture(t, ['coverage']);
  const before = inspect(f);
  assert.equal(f.plannerCalls(), 3, 'initial proposal plus at most two corrected proposals');
  assert.equal(before.length, 3);
  assert.deepEqual(before.map(s => s.planCorrectionCycles ?? 0), [0, 1, 2]);
  assert.equal(f.final.phase, 'planning'); assert.equal(f.final.status, 'failed');
  const immutable = before.map(s => ({ runId: s.runId, planHash: s.planHash, taskHash: s.taskHash,
    planBytes: readFileSync(path.join(f.root, '.ai-orchestrator/graph/plans', s.planHash + '.json')) }));
  const finalId = f.final.runId;
  await f.restart(); await Promise.all([...f.service.drives.values()]);
  const after = inspect(f);
  assert.equal(after.at(-1).planCorrectionCycles, 2);
  assert.equal(f.plannerCalls(), 3, 'restart cannot reset budget or execute another proposal');
  for (const saved of immutable) {
    const current = f.service.store.readRun(saved.runId);
    assert.equal(current.planHash, saved.planHash); assert.equal(current.taskHash, saved.taskHash);
    assert.deepEqual(readFileSync(path.join(f.root, '.ai-orchestrator/graph/plans', saved.planHash + '.json')), saved.planBytes);
  }
  const snapshot = f.service.snapshot(finalId);
  await assert.rejects(f.service.command(finalId, 'replan', request(snapshot, { feedback: 'Исправить тот же план без новых прав' })),
    error => error.code === 'PLAN_CORRECTION_BUDGET_EXHAUSTED');
  assert.equal(history(f).length, 3);
});

test('coverage then weakened criterion consume two corrections without losing original intent', { timeout: 30000 }, async t => {
  const f = await fixture(t, ['coverage', 'criterion', 'valid']);
  const records = inspect(f), failed = failedPlanReceipts(f);
  assert.equal(f.plannerCalls(), 3);
  assert.deepEqual(failed.map(r => r.failureReason.split(':')[0]), ['PLAN_REQUIREMENT_COVERAGE', 'CONTRACT_ACCEPTANCE_WEAKENED']);
  assert.equal(records.at(-1).planCorrectionCycles, 2);
  assert.equal(f.final.phase, 'execution');
  for (let index = 1; index < records.length; index++) {
    const plan = f.service.store.readObject('plans', records[index].planHash);
    assert.equal(plan.parentPlanHash, records[index - 1].planHash);
    assert.notEqual(plan.parentPlanHash, records[index].planHash);
  }
  await f.restart(); await Promise.all([...f.service.drives.values()]);
  assert.equal(history(f).at(-1).planCorrectionCycles, 2);
});

test('real read-context discovery and execution promotion do not consume correction budget', { timeout: 30000 }, async t => {
  const f = await fixture(t, ['coverage', 'valid'], { discover: true });
  const records = inspect(f);
  assert.equal(f.calls.filter(call => call.action === 'ai-analyze').length, 2);
  assert.equal(f.plannerCalls(), 2);
  const last = records.at(-1);
  assert.equal(last.contextDiscoveryRound, 1);
  assert.equal(last.planningTransitions, 2, 'one context discovery plus execution promotion');
  assert.equal(last.planCorrectionCycles, 1, 'only the failed proposal consumes correction budget');
  assert.ok(records.some(s => s.contextDiscoveryRound === 1 && (s.planCorrectionCycles ?? 0) === 0));
  await f.restart(); await Promise.all([...f.service.drives.values()]);
  assert.equal(history(f).at(-1).planCorrectionCycles, 1);
});

test('a corrected planner cannot silently discard original analysis constraints', { timeout: 30000 }, async t => {
  const f = await fixture(t, ['coverage', 'drop-constraints']);
  // The semantic oracle remains the original constraint list. Rejection or an
  // execution contract preserving it are both safe; an empty promoted list is not.
  const last = history(f).at(-1), plan = f.service.store.readObject('plans', last.planHash);
  if (plan.stage === 'execution') assert.deepEqual(plan.taskContract.constraints, CONSTRAINTS,
    'planning corrections must preserve original constraints even when corrected provider omits them');
  assert.deepEqual(f.writes, []);
});

test('human revise-plan transition retains the consumed automatic correction counter', { timeout: 30000 }, async t => {
  const f = await fixture(t, ['coverage', 'valid']);
  inspect(f);
  assert.equal(history(f).at(-1).planCorrectionCycles, 1);
  const revised = await f.service.command(f.final.runId, 'revise-plan', request(f.final, { feedback: 'Уточнить порядок работ; критерии, constraints и scope сохраняются' }));
  f.final = await f.settle(revised);
  inspect(f);
  assert.equal(history(f).at(-1).planCorrectionCycles, 1,
    'a planning transition cannot reset the durable automatic correction budget');
  await f.restart(); await Promise.all([...f.service.drives.values()]);
  assert.equal(history(f).at(-1).planCorrectionCycles, 1);
});

test('V3 real stage plans preserve both structural correction evidence and durable budget', { timeout: 30000 }, async t => {
  const f = await fixture(t, ['coverage', 'interface', 'valid'], { dataVersion: 3 });
  const records = inspect(f);
  assert.ok(records.every(s => s.schemaVersion === 3));
  assert.deepEqual(failedPlanReceipts(f).map(r => r.failureReason.split(':')[0]),
    ['PLAN_REQUIREMENT_COVERAGE', 'PLAN_INTERFACE_MISMATCH']);
  const last = records.at(-1), plan = f.service.store.readObject('plans', last.planHash);
  assert.equal(last.planCorrectionCycles, 2);
  assert.equal(plan.schemaVersion, 3);
  assert.equal(plan.executionStages.stages.length, 2);
  assert.equal(f.final.status, 'waiting-for-human');
  await f.restart(); await Promise.all([...f.service.drives.values()]);
  assert.equal(history(f).at(-1).planCorrectionCycles, 2);
});
