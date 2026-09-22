import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkflowService } from './lib/service.mjs';
import { hashObject } from './lib/io.mjs';
import { SKILL_ROUTES } from './lib/config.mjs';
import { resultKind } from './lib/result-classification.mjs';

const request = (snapshot, extra = {}) => ({ operationId: `op-${randomUUID()}`, expectedRevision: snapshot.revision, planHash: snapshot.planHash, ...extra });
const fields = { title: 'Перенести словарь', description: 'Перенести tmg.ru.json в src/localization и обновить src/index.ts', taskNumber: 'MOVE-1' };

async function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flowcairn-intake-context-'));
  const worktree = path.join(root, 'workspace');
  mkdirSync(worktree);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hash = hashObject('context-fixture');
  let files = ['package.json', 'src/index.ts', 'src/localization/index.ts'];
  const fingerprint = () => {
    const descriptors = files.map((file) => ({ path: file, hash, size: 10, mode: '100644' }));
    const git = { head: null, indexHash: hash };
    return { files: descriptors, git, hash: hashObject({ files: descriptors, git }) };
  };
  const project = () => ({ schemaVersion: 2, name: 'fixture', contextHash: hashObject(files), sourceHash: fingerprint().hash,
    contextPaths: [], scopeCandidates: [...new Set(files.map((file) => file.split('/')[0]))], checks: [],
    ai: { provider: 'codex', model: 'fixture' }, capabilities: { intake: { allowed: true } } });
  const skills = [...new Set(Object.values(SKILL_ROUTES).flat())].map((id) => ({ id, path: `skills/${id}/SKILL.md`, hash }));
  const calls = [];
  let uncertain = true, processUncertain = false;
  const adapters = {
    identity: () => hash, skills: () => skills, hasReadConsent: () => true,
    projectSummary: project, taskContextInventory: () => ({ files, sourceHash: fingerprint().hash }),
    capture: () => ({ bundlePath: 'fixture-source', manifest: { sourceHash: fingerprint().hash } }),
    registerTask: (_root, task, options) => options.service.create(task, { runId: options.run, operationId: options.operation,
      stage: options.stage, workflow: options.workflow, naturalIntakeHash: options.naturalIntakeHash, expectedSourceHash: options.expectedSourceHash }),
    allocate: ({ task, runId, sourceHash }) => ({ worktree, taskId: task.id, attemptId: 1, leaseId: 'fixture', sourceHash, runId }),
    verifyBinding: () => true, replaceBinding: ({ binding, newRunId }) => ({ ...binding, runId: newRunId }),
    fingerprint, inspectChanges: () => ({ allowed: true, changedFiles: [] }),
    runner: { ai: { available: true }, checks: { available: true } },
    loadSkills: (ids) => ids.map((name) => ({ name, path: `skills/${name}/SKILL.md`, hash, text: 'fixture' })),
    execute: async ({ node, task, onStart, priorEvidence }) => {
      calls.push({ action: node.action.id, task, priorEvidence });
      await onStart({ ticket: 'fixture', pid: process.pid });
      if (processUncertain) return { exitCode: null, stopped: false, uncertain: true };
      const analysis = { requirements: ['Сохранить все переводы'], constraints: [],
        projectFacts: [{ path: 'src/index.ts', fact: 'Есть подключение словаря' }], acceptance: ['Словарь подключен'], risks: [] };
      return { exitCode: 0, stopped: true, uncertain: false, output: {
        summary: 'Нужен исходный словарь', verdict: uncertain ? 'uncertain' : 'pass', skillsUsed: node.skills,
        findings: uncertain ? [{ severity: 'blocking', message: 'Для переноса нужен исходный tmg.ru.json', path: null }] : [],
        changedFiles: [], edits: [], plan: [],
        ...(node.action.id === 'ai-analyze' ? { analysis } : {}),
        ...(node.action.id === 'ai-plan' ? { steps: [{ id: 'move', title: 'Перенести словарь', outcome: 'Сохранить все переводы', needs: [], paths: ['src/index.ts'] }] } : {}),
      } };
    },
  };
  const service = await WorkflowService.open({ root, adapters });
  const settle = async (snapshot) => {
    for (let turn = 0; turn < 6; turn++) {
      await Promise.all([...service.drives.values()]);
      snapshot = service.snapshot(snapshot.runId);
      if (snapshot.successorRunId) { snapshot = service.snapshot(snapshot.successorRunId); continue; }
      return snapshot;
    }
    throw Error('Unexpected scheduling loop');
  };
  return { root, service, adapters, calls, project, settle, addFile: (file) => { files = [...files, file]; },
    setUncertain: (value) => { uncertain = value; }, setProcessUncertain: () => { processUncertain = true; } };
}

test('missing source starts autonomous analysis with a truthful note, without a manual path gate', async (t) => {
  const f = await fixture(t);
  const body = { ...fields, contextHash: f.project().contextHash };
  const preview = f.service.previewIntake(body);
  assert.equal(preview.ready, false);
  assert.equal(preview.references.find((ref) => ref.reference === 'tmg.ru.json').status, 'missing');
  const snapshot = await f.settle(await f.service.intake({ ...body, operationId: 'intake-missing' }));
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].task.contextDiscovery, true);
  assert.match(f.calls[0].task.contextNotes[0], /tmg.ru.json/);
  assert.ok(f.calls[0].priorEvidence.contextInventory.paths.includes('src/'));
  assert.equal(snapshot.contextClarification, true, 'A real unresolved semantic blocker still has an escape path');
});

test('resolved selection is hash-bound, idempotent, and stored as context notes without rewriting the task', async (t) => {
  const f = await fixture(t);
  f.addFile('translations/ru.json');
  const body = { ...fields, contextHash: f.project().contextHash };
  const preview = f.service.previewIntake(body);
  const selection = { previewHash: preview.previewHash, scope: [...preview.scope, 'translations/ru.json'],
    resolutions: [{ reference: 'tmg.ru.json', kind: 'existing', path: 'translations/ru.json' }] };
  assert.equal(f.service.previewIntake({ ...body, selection }).ready, true);
  const input = { ...body, selection, operationId: 'intake-resolved' };
  let snapshot = await f.settle(await f.service.intake(input));
  assert.equal(snapshot.status, 'uncertain');
  assert.equal(snapshot.resolutionKind, 'semantic');
  assert.equal(snapshot.contextClarification, true);
  assert.equal(snapshot.nodes.find((node) => node.id === 'analyze').resolutionKind, 'semantic');
  assert.equal(f.service.listRuns()[0].resolutionKind, 'semantic');
  assert.equal(snapshot.capabilities.recover.allowed, false);
  assert.deepEqual(f.calls.map((call) => call.action), ['ai-analyze']);
  assert.equal(f.calls[0].task.instructions, fields.description);
  assert.match(f.calls[0].task.contextNotes[0], /translations\/ru.json/);
  assert.equal((await f.service.intake(input)).runId, snapshot.runId);
  await assert.rejects(f.service.intake({ ...input, selection: { ...selection, scope: ['src'] } }), { code: 'IDEMPOTENCY_CONFLICT' });
  await f.settle(snapshot);
  assert.equal(f.calls.length, 1);
});

test('stale preview never creates a run or invokes AI', async (t) => {
  const f = await fixture(t);
  const body = { title: 'Проверить src/index.ts', description: 'Проверить текущую реализацию', taskNumber: 'CHECK-1', contextHash: f.project().contextHash };
  const preview = f.service.previewIntake(body);
  f.addFile('new.txt');
  await assert.rejects(f.service.intake({ ...body, operationId: 'intake-stale', selection: { previewHash: preview.previewHash, scope: preview.scope, resolutions: [] } }), { code: 'STALE_CONTEXT' });
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.service.store.listRunIds(), []);
});

test('source changing after preview but during capture cannot become an executable run', async (t) => {
  const f = await fixture(t);
  const capture = f.adapters.capture;
  f.adapters.capture = () => { f.addFile('changed.txt'); return capture(); };
  const body = { title: 'Проверить src/index.ts', description: 'Проверить текущую реализацию', taskNumber: 'CHECK-1', contextHash: f.project().contextHash };
  await assert.rejects(f.service.intake({ ...body, operationId: 'intake-race' }), { code: 'STALE_CONTEXT' });
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.service.listRuns(), []);
});

test('context clarification creates a fresh planning version preserving obligations and old receipts', async (t) => {
  const f = await fixture(t);
  // A legacy failed intake has no reference preflight. Keep it as the real old-run scenario.
  let snapshot = await f.service.create({ id: 'TASK-CONTEXT-OLD', goal: fields.title, instructions: fields.description,
    taskNumber: fields.taskNumber, intakeKind: 'natural', scope: ['src'], acceptance: [fields.description], checks: [] },
  { runId: 'run-context-old', stage: 'planning', workflow: 'autonomous' });
  snapshot = await f.service.command(snapshot.runId, 'run', request(snapshot));
  assert.equal(snapshot.status, 'uncertain');
  const previous = snapshot;
  f.adapters.identity = () => hashObject('updated-runtime');
  assert.equal(f.service.snapshot(previous.runId).contextClarification, true, 'A safe historical planning stop remains recoverable after a runtime update');
  f.adapters.identity = () => hashObject('context-fixture');
  const oldReceiptId = previous.nodes.find((node) => node.id === 'analyze').receiptIds.at(-1);
  const oldReceipt = f.service.receipt(previous.runId, oldReceiptId);
  f.addFile('translations/ru.json');
  const body = { ...fields, contextHash: f.project().contextHash };
  const preview = f.service.previewIntake(body);
  assert.equal(f.service.previewIntake({ ...body, runId: previous.runId, description: 'Сокращенное описание из UI' }).previewHash,
    preview.previewHash, 'Recovery uses immutable task text, not truncated display text');
  const contextSelection = { contextHash: body.contextHash, previewHash: preview.previewHash,
    scope: [...preview.scope, 'translations/ru.json'], resolutions: [{ reference: 'tmg.ru.json', kind: 'existing', path: 'translations/ru.json' }] };
  const command = request(snapshot, { contextSelection, feedback: 'Исходный словарь находится в translations/ru.json' });
  snapshot = await f.settle(await f.service.command(snapshot.runId, 'replan', command));
  assert.notEqual(snapshot.runId, previous.runId);
  assert.equal(snapshot.supersedesRunId, previous.runId);
  assert.notEqual(snapshot.planHash, previous.planHash);
  assert.deepEqual(f.service.receipt(previous.runId, oldReceiptId), oldReceipt);
  assert.deepEqual(f.calls.map((call) => call.action), ['ai-analyze', 'ai-analyze']);
  const latest = f.calls.at(-1);
  assert.ok(latest.task.scope.includes('translations/ru.json'));
  assert.equal(latest.task.instructions, fields.description);
  assert.equal(latest.priorEvidence.analysis, undefined);
  assert.deepEqual(f.service.store.readRun(snapshot.runId).permissions, ['ai.read']);
  assert.equal((await f.service.command(previous.runId, 'replan', command)).runId, snapshot.runId);
  await assert.rejects(f.service.command(previous.runId, 'replan', { ...command, feedback: 'changed' }), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('unconfirmed process termination cannot be turned into context clarification', async (t) => {
  const f = await fixture(t);
  f.setProcessUncertain();
  const simple = { title: 'Проверить src/index.ts', description: 'Проверить текущую реализацию', taskNumber: 'CHECK-1', contextHash: f.project().contextHash };
  const preview = f.service.previewIntake(simple);
  const snapshot = await f.settle(await f.service.intake({ ...simple, operationId: 'intake-process' }));
  assert.equal(snapshot.resolutionKind, 'process');
  assert.equal(snapshot.contextClarification, false);
  assert.equal(snapshot.capabilities.recover.allowed, true);
  await assert.rejects(f.service.command(snapshot.runId, 'replan', request(snapshot, { contextSelection: {
    contextHash: simple.contextHash, previewHash: preview.previewHash, scope: preview.scope, resolutions: [] },
  })), { code: 'RECOVERY_REQUIRED' });
  assert.equal(f.calls.length, 1);
});

test('only unchanged successful process completion qualifies as semantic uncertainty', () => {
  const base = { phase: 'finished', actionId: 'ai-analyze', verdict: 'uncertain', exitCode: 0,
    beforeFingerprint: 'same', afterFingerprint: 'same', termination: { stopped: true, uncertain: false } };
  const node = { status: 'uncertain', receipts: ['receipt'] };
  assert.equal(resultKind(node, () => base), 'semantic');
  for (const changes of [{ exitCode: 1 }, { afterFingerprint: 'other' }, { phase: 'started' }, { termination: { stopped: false } }, { actionId: 'check-tests' }])
    assert.equal(resultKind(node, () => ({ ...base, ...changes })), 'process');
  assert.equal(resultKind(node, () => { throw Error('missing'); }), 'process');
});

test('one submission discovers missing context and reaches a separately approved plan without human path choices', async (t) => {
  const f = await fixture(t);
  f.addFile('translations/ru.json');
  const execute = f.adapters.execute;
  f.adapters.execute = async (options) => {
    const needsSource = options.node.action.id === 'ai-analyze' && !options.task.contextPaths.includes('translations/ru.json');
    f.setUncertain(needsSource);
    const result = await execute(options);
    if (needsSource) result.output.contextRequests = [
      { path: 'translations/ru.json', purpose: 'read', reason: 'Проверить исходные переводы' },
      { path: 'translations/ru.json', purpose: 'write', reason: 'Перенести исходный словарь' },
    ];
    return result;
  };
  const first = await f.service.intake({ ...fields, contextHash: f.project().contextHash, operationId: 'intake-autonomous' });
  const snapshot = await f.settle(first);
  assert.equal(snapshot.phase, 'execution');
  assert.equal(snapshot.status, 'waiting-for-human');
  assert.deepEqual(f.calls.map((call) => call.action), ['ai-analyze', 'ai-analyze', 'ai-plan']);
  assert.equal(snapshot.gates.length, 1);
  assert.equal(snapshot.gates[0].type, 'approve-plan');
  assert.ok(f.calls[1].task.contextPaths.includes('translations/ru.json'));
  assert.ok(f.calls[1].task.scope.includes('translations/ru.json'));
  assert.equal(f.calls[1].priorEvidence.analysis, undefined, 'Changed context requires fresh analysis');
  assert.equal(f.calls[1].task.instructions, fields.description);
  assert.deepEqual(f.service.store.readRun(snapshot.runId).permissions, []);
  assert.equal(f.service.store.readRun(snapshot.runId).contextDiscoveryRound, 1);
  assert.equal(f.service.receipt(first.runId, f.service.snapshot(first.runId).nodes[0].receiptIds.at(-1)).verdict, 'uncertain');
});

test('invalid context requests never gain private access and stop after a bounded autonomous attempt budget', async (t) => {
  const f = await fixture(t);
  const execute = f.adapters.execute;
  f.adapters.execute = async (options) => {
    const result = await execute(options);
    result.output.contextRequests = [{ path: '.env', purpose: 'read', reason: 'Проверить настройки' }];
    return result;
  };
  const first = await f.service.intake({ ...fields, contextHash: f.project().contextHash, operationId: 'intake-bounded' });
  const snapshot = await f.settle(first);
  assert.equal(f.calls.length, 5);
  assert.equal(snapshot.status, 'uncertain');
  assert.match(snapshot.failureReason, /четыре этапа/);
  assert.ok(f.calls.every((call) => !call.task.scope.includes('.env') && !call.task.contextPaths.includes('.env')));
  assert.equal(f.service.store.readRun(snapshot.runId).contextDiscoveryRound, 4);
  assert.equal(snapshot.capabilities.run.allowed, false);
});
