import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkflowService } from './lib/service.mjs';
import { TaskSpecSchema } from './lib/schemas.mjs';
import { compilePlanningPlan, compileTaskProposal } from './lib/planning.mjs';
import { runRegisteredAction } from './lib/runner.mjs';
import { validatePlan } from './lib/validator.mjs';
import { SKILL_ROUTES } from './lib/config.mjs';
import { hashObject } from './lib/io.mjs';

const hash = hashObject('synthetic planning fixture');
const skills = [...new Set(Object.values(SKILL_ROUTES).flat())].sort().map((id) => ({ id, path: `skills/${id}/SKILL.md`, hash }));
const context = { runtimeHash: hash, skills };
const input = { id: 'TASK-PLAN', goal: 'Добавить экспорт заметок', instructions: 'Экспортировать заметки в текстовый файл с проверкой формата',
  scope: ['src/'], contextPaths: ['AGENTS.md'], acceptance: ['Экспорт содержит все заметки'], checks: ['tests'] };
const task = TaskSpecSchema.parse({ ...input, schemaVersion: 2, sourceHash: hash });
const proposal = (steps) => ({ summary: 'План по исходникам', verdict: 'pass', skillsUsed: ['project-context'], findings: [], changedFiles: [], edits: [], plan: [], steps });
const steps = [
  { id: 'format', title: 'Формат экспорта', outcome: 'Формат сохраняет заголовок и текст заметки', needs: [], paths: ['src/format.mjs'] },
  { id: 'export', title: 'Экспорт заметок', outcome: 'Заметки экспортируются выбранным способом', needs: ['format'], paths: ['src/export.mjs'] },
];
const request = (snapshot, extra = {}) => ({ operationId: `op-${randomUUID()}`, expectedRevision: snapshot.revision, planHash: snapshot.planHash, ...extra });

async function fixture(t, { output = proposal(steps), maxReplans = 2 } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flowcairn-planning-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let identity = hash, calls = 0, registrations = 0;
  let currentOutput = output, reviewVerdict = 'pass', observedFeedback = null;
  const fingerprint = () => ({ hash, files: [], git: { head: 'a'.repeat(40), indexHash: hash } });
  const adapters = {
    identity: () => identity, skills: () => skills,
    capture: () => ({ manifest: { sourceHash: hash }, bundlePath: 'synthetic-source' }),
    allocate: ({ task, runId }) => ({ worktree: root, taskId: task.id, attemptId: 1, leaseId: 'synthetic-lease', sourceHash: hash, runId }),
    verifyBinding: () => true,
    replaceBinding: ({ binding, newRunId }) => ({ ...binding, runId: newRunId }),
    fingerprint, inspectChanges: () => ({ allowed: true, changedFiles: [] }),
    applyEdits: () => {}, diff: () => ({ content: '', complete: true }),
    runner: { ai: { available: true, reason: null }, checks: { available: true, reason: null } },
    inspectProcess: () => ({ stopped: true, uncertain: false }),
    loadSkills: (ids) => ids.map((name) => ({ name, text: 'fixture skill', hash, path: `skills/${name}/SKILL.md` })),
    projectSummary: () => ({ schemaVersion: 2, name: 'synthetic-project', contextHash: identity, contextPaths: ['AGENTS.md'], scopeCandidates: ['src/'], checks: ['tests'], ai: { provider: 'codex', model: 'fixture' }, capabilities: { intake: { allowed: true, reason: null } } }),
    registerTask: async (_root, task, options) => { registrations++; return options.service.create(task, { runId: options.run, operationId: options.operation, stage: options.stage, naturalIntakeHash: options.naturalIntakeHash }); },
    execute: async ({ node, onStart, reviewEvidence, priorEvidence }) => {
      if (node.action.id === 'ai-implement') observedFeedback = priorEvidence.reviewFindings;
      calls++; await onStart({ ticket: 'synthetic-ticket', pid: process.pid });
      return { exitCode: 0, stopped: true, uncertain: false,
        output: node.action.id === 'ai-plan' ? { ...currentOutput, skillsUsed: node.skills } :
          node.action.id.startsWith('ai-') ? { summary: 'Проверено', verdict: node.action.id === 'ai-review' ? reviewVerdict : 'pass', skillsUsed: node.skills, findings: node.action.id === 'ai-review' && reviewVerdict === 'fail' ? [{ severity: 'blocking', message: 'Исправить потерю данных при экспорте', path: 'src/export.mjs' }] : [], changedFiles: [], edits: [], plan: [], ...(reviewEvidence ? { reviewEvidenceHash: hashObject(reviewEvidence) } : {}) } : null };
    },
  };
  const service = await WorkflowService.open({ root, adapters });
  const snapshot = await service.create({ ...input, limits: { maxReplans } }, { runId: 'run-planning-fixture', stage: 'planning' });
  const approve = (s) => service.command(s.runId, 'gate', request(s, { nodeId: 'approve-plan', decision: 'approve', permissions: s.gates[0].requiredPermissions, challenge: s.gates[0].challenge }));
  return { service, snapshot, approve, calls: () => calls, registrations: () => registrations,
    review: (verdict) => { reviewVerdict = verdict; }, feedback: () => observedFeedback,
    drift: () => { identity = hashObject('changed rules'); }, output: (next) => { currentOutput = next; } };
}

test('planner compiler produces different semantic graphs while mandatory checks and gates stay trusted', () => {
  const one = compileTaskProposal(task, proposal([steps[0]]), context).plan;
  const two = compileTaskProposal(task, proposal(steps), context).plan;
  assert.notEqual(hashObject(one), hashObject(two));
  assert.equal(one.nodes.filter((n) => n.action.id === 'ai-implement').length, 1);
  assert.equal(two.nodes.filter((n) => n.action.id === 'ai-implement').length, 2);
  assert.deepEqual(two.nodes.find((n) => n.id === 'step-export').needs, ['step-format']);
  for (const plan of [one, two]) {
    assert.ok(Object.isFrozen(plan));
    for (const action of ['human-approve', 'workspace-check', 'check-tests', 'ai-review', 'human-accept'])
      assert.ok(plan.nodes.some((n) => n.action.id === action));
  }
});

test('planner proposals cannot select actions, Skills, permissions, broaden scope or introduce cycles', () => {
  for (const field of ['action', 'skills', 'permissions', 'command']) {
    assert.throws(() => compileTaskProposal(task, proposal([{ ...steps[0], [field]: 'untrusted' }]), context), (error) => error.code === 'PLANNING_SCHEMA');
  }
  assert.throws(() => compileTaskProposal(task, proposal([{ ...steps[0], paths: ['outside/file'] }]), context), (e) => e.code === 'PLANNING_SCOPE');
  assert.throws(() => compileTaskProposal(task, proposal([{ ...steps[0], paths: ['src/.env'] }]), context), (e) => e.code === 'PLANNING_SCOPE');
  assert.throws(() => compileTaskProposal(task, proposal([{ ...steps[0], needs: ['format'] }]), context), (e) => e.code === 'PLANNING_CYCLE');
  assert.throws(() => compileTaskProposal(task, proposal([{ ...steps[0], needs: ['missing'] }]), context), (e) => e.code === 'PLANNING_DEPENDENCY');
  const stage = structuredClone(compilePlanningPlan(task, context).plan);
  stage.nodes[1].permissions.push('workspace.source.write');
  assert.throws(() => validatePlan(stage, task, context), (e) => e.code === 'PERMISSION_MISMATCH');
});

test('planning needs exact AI read consent; promotion creates immutable separately approved execution', async (t) => {
  const f = await fixture(t, { maxReplans: 0 });
  const original = f.snapshot;
  assert.equal(original.phase, 'planning');
  assert.equal(original.capabilities.requestReplan.allowed, false);
  assert.equal(original.nodes.every((node) => node.capabilities.requestReplan.allowed === false), true);
  assert.equal(f.calls(), 0);
  assert.deepEqual(original.gates[0].requiredPermissions, ['ai.read']);
  await assert.rejects(f.service.command(original.runId, 'run', request(original)), (e) => e.code === 'CONTROL_DENIED');
  await assert.rejects(f.service.command(original.runId, 'replan', request(original)), (e) => e.code === 'REPLAN_DENIED');
  const approved = await f.approve(original);
  const planned = await f.service.command(approved.runId, 'run', request(approved));
  assert.equal(planned.nodes.find((n) => n.id === 'plan-task').status, 'passed');
  assert.equal(planned.gates.length, 0);
  assert.equal(planned.capabilities.requestReplan.allowed, true);
  assert.equal(planned.capabilities.requestReplan.label, 'Показать план реализации');
  assert.equal(planned.nodes.every((node) => node.capabilities.requestReplan.allowed === true), true);
  const compileRequest = request(planned);
  const next = await f.service.command(planned.runId, 'replan', compileRequest);
  assert.equal(next.phase, 'execution');
  assert.notEqual(next.runId, original.runId);
  assert.equal(next.nodes.filter((n) => n.action.id === 'ai-implement').length, 2);
  assert.equal(next.nodes.every((n) => n.attempt === 0), true);
  assert.ok(next.gates[0].requiredPermissions.includes('workspace.source.write'));
  assert.equal(f.service.store.readRun(original.runId).planHash, original.planHash);
  assert.equal(f.service.store.readRun(next.runId).permissions.length, 0);
  assert.equal(next.capabilities.requestReplan.allowed, false, 'zero replan budget survives initial staging');
  assert.equal((await f.service.command(planned.runId, 'replan', compileRequest)).runId, next.runId);
  assert.equal(f.calls(), 1, 'compilation does not call AI');
});

test('natural intake assigns IDs, survives service reopen and deduplicates concurrent requests', async (t) => {
  const f = await fixture(t);
  const body = { prompt: 'Добавь экспорт всех заметок', operationId: 'intake-duplicate', contextHash: hash };
  const [first, second] = await Promise.all([f.service.intake(body), f.service.intake(body)]);
  assert.equal(first.runId, second.runId);
  assert.equal(f.registrations(), 1);
  assert.equal(f.calls(), 0);
  const reopened = await WorkflowService.open({ root: f.service.root, adapters: f.service.adapters });
  assert.equal((await reopened.intake(body)).runId, first.runId);
  await assert.rejects(reopened.intake({ ...body, prompt: 'Другой запрос' }), (e) => e.code === 'IDEMPOTENCY_CONFLICT');
  assert.equal(reopened.listRuns().some((run) => run.runId.startsWith('registration-')), false);
  f.drift();
  await assert.rejects(reopened.intake({ ...body, operationId: 'intake-stale' }), (e) => e.code === 'STALE_CONTEXT');
  assert.equal((await reopened.intake(body)).status, 'stale');
});

test('changed rules invalidate planning approval and prevent promoting prior AI result', async (t) => {
  const f = await fixture(t);
  const approved = await f.approve(f.snapshot);
  const planned = await f.service.command(approved.runId, 'run', request(approved));
  f.drift();
  assert.equal(f.service.snapshot(planned.runId).status, 'stale');
  await assert.rejects(f.service.command(planned.runId, 'replan', request(planned)), (e) => e.code === 'RUNTIME_DRIFT');
});

for (const verdict of ['fail', 'uncertain']) test(`planning ${verdict} never produces executable proposal or unsafe retry`, async (t) => {
  const f = await fixture(t, { output: { ...proposal([]), verdict } });
  const approved = await f.approve(f.snapshot);
  const planned = await f.service.command(approved.runId, 'run', request(approved));
  assert.equal(planned.status, verdict === 'fail' ? 'failed' : 'uncertain');
  assert.equal(planned.nodes.find((node) => node.id === 'accept-result').reason, `Ожидается plan-task: ${verdict === 'fail' ? 'failed' : 'uncertain'}`);
  assert.equal(planned.nodes.find((n) => n.id === 'plan-task').capabilities.retry.allowed, false);
  if (verdict === 'fail') {
    assert.equal(planned.capabilities.requestReplan.label, 'Повторить планирование');
    const next = await f.service.command(planned.runId, 'replan', request(planned));
    assert.equal(next.phase, 'planning');
    assert.deepEqual(next.gates[0].requiredPermissions, ['ai.read']);
  } else {
    await assert.rejects(f.service.command(planned.runId, 'replan', request(planned)), (e) => e.code === 'RECOVERY_REQUIRED');
  }
});


test('review failure creates a bounded new fix version with full findings, fresh checks and approval', async (t) => {
  const f = await fixture(t, { maxReplans: 1 });
  let s = await f.approve(f.snapshot);
  s = await f.service.command(s.runId, 'run', request(s));
  s = await f.service.command(s.runId, 'replan', request(s));
  const implementationHash = s.planHash;
  f.review('fail');
  s = await f.approve(s);
  s = await f.service.command(s.runId, 'run', request(s));
  assert.equal(s.nodes.find((n) => n.action.id === 'ai-review').status, 'failed');
  const previousRunId = s.runId;
  s = await f.service.command(s.runId, 'replan', request(s));
  assert.equal(s.phase, 'execution');
  assert.equal(s.planVersion, 3);
  const fixedPlan = f.service.plan(s.runId);
  assert.equal(fixedPlan.stage, 'execution');
  assert.equal(s.nodes.filter((node) => node.action.id === 'ai-implement').length, 2, 'fix preserves semantic task steps');
  assert.equal(f.service.store.readRun(previousRunId).planHash, implementationHash);
  assert.equal(s.nodes.find((n) => n.action.id === 'check-tests').status, 'pending');
  assert.equal(s.nodes.every((n) => n.attempt === 0), true);
  assert.equal(s.capabilities.requestReplan.allowed, false);
  f.review('pass');
  s = await f.approve(s);
  s = await f.service.command(s.runId, 'run', request(s));
  assert.equal(s.nodes.find((n) => n.action.id === 'ai-review').status, 'passed');
  assert.ok(JSON.stringify(f.feedback()).includes('Исправить потерю данных при экспорте'));
  assert.equal(s.gates[0].type, 'accept-result');
  assert.equal(s.finalDisposition, null, 'runtime never accepts for the operator');
});

test('close cannot release service while create is awaiting source capture', async (t) => {
  const f = await fixture(t);
  let resume;
  f.service.adapters.capture = () => new Promise((resolve) => { resume = resolve; });
  const pending = f.service.create(input, { runId: 'run-pending-create' });
  assert.equal(f.service.close(), false);
  resume({ manifest: { sourceHash: hash }, bundlePath: 'synthetic-source' });
  await pending;
  assert.equal(f.service.close(), true);
  await assert.rejects(f.service.create(input), (error) => error.code === 'SERVICE_CLOSED');
});

test('exported runner rejects omitted/swapped per-node Skills before any allocation or process', async () => {
  const plan = compileTaskProposal(task, proposal(steps), context).plan;
  const node = plan.nodes.find((entry) => entry.action.id === 'ai-implement');
  for (const replacement of [[], ['code-review']]) {
    await assert.rejects(runRegisteredAction({ root: '/nonexistent-fixture-root', worktree: '/nonexistent-fixture-worktree',
      node: { ...structuredClone(node), skills: replacement }, task, plan, skills: [], toolchain: null,
      outputDirectory: '/nonexistent-output', signal: new AbortController().signal, onStart: () => {} }),
    (error) => error.code === 'RUNNER_NODE_MISMATCH');
  }
});
