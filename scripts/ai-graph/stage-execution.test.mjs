import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SKILL_ROUTES } from './lib/config.mjs';
import { hashObject, sha256 } from './lib/io.mjs';
import { ProjectProfileSchema, projectContextPaths, trustedLocalChecksHash } from './lib/project.mjs';
import { inspectProjectChecks } from './lib/check-profile.mjs';
import { resolveCheckExecutable } from './lib/check-toolchain.mjs';
import { TaskSpecV3Schema } from './lib/schemas.mjs';
import { compileTaskProposal } from './lib/planning.mjs';
import { fingerprintDirectWorkspace } from './lib/direct-workspace.mjs';
import { inspectDirectChanges } from './lib/direct-fingerprint.mjs';
import { captureBeforeContents, buildAttemptDiff } from './lib/artifacts.mjs';
import { prepareToolchain, verifyToolchain } from './lib/toolchain.mjs';
import { runRegisteredAction } from './lib/runner.mjs';
import { GraphStore } from './lib/store.mjs';
import { WorkflowService } from './lib/service.mjs';

const skillText = 'Fixture skill';
const identity = sha256(skillText);
const skills = [...new Set(Object.values(SKILL_ROUTES).flat())]
  .map((id) => ({ id, path: `skills/${id}/SKILL.md`, hash: identity }));
const request = (snapshot, extra = {}) => ({ operationId: `op-${randomUUID()}`,
  expectedRevision: snapshot.revision, planHash: snapshot.planHash, ...extra });

function sourceText(store, catalogHash, role, file = 'answer.txt') {
  const catalog = store.readObject('learning-sources', catalogHash);
  const source = catalog.sources.find((item) => item.path === file && item.role === role);
  assert.ok(source, `Missing saved ${role} ${file}`);
  return source.chunkHashes.map((hash) => store.readObject('learning-source-chunks', hash).text).join('');
}

async function fixture(t, { adapter = 'npm', mode = 'after-stage', partial = false, race = null, maxReplans = 0 } = {}) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-stage-execution-')));
  let service;
  t.after(async () => {
    if (service) { await Promise.all([...service.drives.values()]); service.close(); }
    rmSync(root, { recursive: true, force: true });
  });
  const script = adapter === 'npm' ? 'verify.mjs' : 'verify.py';
  const criterion = 'Ответ находится между 1 и 2';
  const assertion = adapter === 'npm' ? 'if (![1, 2].includes(value)) process.exit(1);' : 'assert value in (1, 2)';
  const checker = adapter === 'npm'
    ? `import { readFileSync, appendFileSync } from 'node:fs';\nconst value = Number(readFileSync('answer.txt', 'utf8'));\n${assertion}\nappendFileSync('out/checks.log', String(value) + '\\n');\n`
    : `from pathlib import Path\nvalue = int(Path('answer.txt').read_text())\n${assertion}\nwith Path('out/checks.log').open('a') as log: log.write(str(value) + '\\n')\n`;
  writeFileSync(path.join(root, 'answer.txt'), '0\n');
  writeFileSync(path.join(root, script), checker);
  mkdirSync(path.join(root, 'out'));
  const checkId = adapter === 'npm' ? 'tests' : 'python-tests';
  const common = { workspaceMode: 'direct', integrationBranch: 'main', contextPaths: [], checks: [checkId],
    checkMode: 'trusted-local', outputPaths: ['out'], ai: { provider: 'codex', model: 'fixture' } };
  let profile;
  if (adapter === 'npm') {
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'stage-fixture', version: '1.0.0', scripts: { test: 'node verify.mjs' } }));
    writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}');
    profile = ProjectProfileSchema.parse({ ...common, version: 1, packageManager: 'npm', checkScripts: { tests: 'test' },
      manifests: ['package.json', 'package-lock.json'] });
  } else {
    const executable = resolveCheckExecutable(root, 'python3').executable;
    profile = ProjectProfileSchema.parse({ ...common, version: 2, manifests: [], checkProfile: {
      version: 1, requiredCheckIds: [checkId], environment: [], definitions: [{ id: checkId, title: 'Проверка Python', purpose: criterion,
        command: { executable, argv: ['-B', script], cwd: '.' }, inputPaths: [script], outputPaths: ['out'],
        timeoutMs: 5000, maxOutputBytes: 65536 }],
    } });
  }
  writeFileSync(path.join(root, '.flowcairn.json'), JSON.stringify(profile));
  mkdirSync(path.join(root, '.ai-orchestrator/graph/runner-tickets'), { recursive: true, mode: 0o700 });
  for (const directory of ['.ai-orchestrator', '.ai-orchestrator/graph']) chmodSync(path.join(root, directory), 0o700);
  writeFileSync(path.join(root, '.ai-orchestrator/flowcairn-install.json'), JSON.stringify({ tool: 'flowcairn',
    owner: `flowcairn-${randomUUID()}`, trustedLocalChecksHash: trustedLocalChecksHash(root, profile) }), { mode: 0o600 });
  const fingerprint = () => fingerprintDirectWorkspace(root, { outputPaths: profile.outputPaths });
  const taskInput = { id: 'TASK-STAGES', goal: 'Изменить ответ двумя проверенными шагами', instructions: 'Сначала записать 1, затем 2.',
    scope: ['answer.txt'], contextPaths: [script, ...projectContextPaths(root, profile), ...(partial ? ['missing-context.txt'] : [])],
    acceptance: [criterion], checks: [checkId], learningMode: mode, limits: { timeoutMs: 5000, maxAttempts: 1, maxReplans } };
  const task = TaskSpecV3Schema.parse({ ...taskInput, schemaVersion: 3, sourceHash: fingerprint().hash });
  const proposal = { summary: 'Два последовательных изменения', verdict: 'pass', skillsUsed: [], findings: [], changedFiles: [], edits: [], plan: [],
    steps: [1, 2].map((value) => ({ id: `value-${value}`, title: `Записать ${value}`, outcome: `Ответ равен ${value}`, needs: [],
      paths: ['answer.txt'], readPaths: [script], requirementIds: ['req-001'] })),
    contractProposal: { requirements: [{ id: 'req-001', title: criterion, mandatory: true,
      verification: { method: 'check', checkIds: [`check-${checkId}`], criterion, paths: [script] } }],
    optionalImprovements: [], constraints: [], assumptions: [], unknowns: [] } };
  const compiled = compileTaskProposal(task, proposal, { runtimeHash: identity, skills,
    checks: inspectProjectChecks(root, profile), workflow: 'autonomous' });
  const calls = [], beforeAtEffect = [];
  let raced = false;
  const adapters = { dataVersion: 3, project: profile, identity: () => identity, skills: () => skills,
    checkRegistry: () => inspectProjectChecks(root, profile), hasReadConsent: () => true,
    capture: () => ({ manifest: { sourceHash: fingerprint().hash }, bundlePath: 'fixture-source' }),
    allocate: ({ task: selected, runId }) => ({ mode: 'direct', worktree: root, taskId: selected.id, attemptId: 1,
      leaseId: 'fixture', sourceHash: fingerprint().hash, runId }),
    replaceBinding: ({ binding, newRunId, sourceHash }) => ({ ...binding, runId: newRunId, sourceHash }),
    verifyBinding: () => true, fingerprint,
    prepareToolchain: () => prepareToolchain({ root, worktree: root }),
    verifyToolchain: (worktree, manifest) => verifyToolchain({ root, worktree, manifest }),
    inspectChanges: (before, after, node, selected) => {
      const result = inspectDirectChanges(before, after, node, selected);
      if (race === 'after' && !raced && node.id === compiled.plan.executionStages.stages[0].boundaryNodeId) {
        raced = true;
        writeFileSync(path.join(root, 'answer.txt'), '9\n');
      }
      return result;
    },
    captureBefore: (...args) => {
      const result = captureBeforeContents(...args);
      if (race === 'before' && !raced && args[2].action.id === 'ai-implement') {
        raced = true;
        writeFileSync(path.join(root, 'answer.txt'), '9\n');
      }
      return result;
    },
    diff: buildAttemptDiff,
    applyEdits: (_worktree, _before, node, _task, edits) => {
      const store = new GraphStore(root), state = store.readRun('stages');
      const stage = compiled.plan.executionStages.stages.find((item) => item.implementationNodeIds.includes(node.id));
      const before = state.learning.captures[stage.id].before;
      assert.deepEqual(Object.keys(before).sort(), ['gaps', 'sourceCatalogHash', 'sourceHash']);
      assert.equal(sourceText(store, before.sourceCatalogHash, 'before'), readFileSync(path.join(root, 'answer.txt'), 'utf8'));
      beforeAtEffect.push(structuredClone(before));
      for (const edit of edits) writeFileSync(path.join(root, edit.path), edit.content);
    },
    runner: { ai: { available: true }, checks: { available: true } }, inspectProcess: () => ({ stopped: true }),
    loadSkills: (ids) => ids.map((name) => ({ name, text: skillText, hash: identity, path: `skills/${name}/SKILL.md` })),
    execute: async (input) => {
      calls.push(input.node.id);
      if (input.node.action.id.startsWith('check-')) return runRegisteredAction(input);
      input.onStart({ ticket: 'fixture-ai', pid: process.pid });
      const output = { summary: 'Подготовлено', verdict: 'pass', skillsUsed: input.node.skills, findings: [], changedFiles: [], edits: [], plan: [] };
      if (input.node.action.id === 'ai-implement') {
        const stage = compiled.plan.executionStages.stages.findIndex((item) => item.implementationNodeIds.includes(input.node.id));
        const state = new GraphStore(root).readRun('stages');
        assert.ok(state.learning.captures[compiled.plan.executionStages.stages[stage].id].before.sourceCatalogHash,
          'The complete before reference must already be durable before invoking the action');
        output.changedFiles = ['answer.txt'];
        output.edits = [{ path: 'answer.txt', previousHash: sha256(readFileSync(path.join(root, 'answer.txt'))), content: `${stage + 1}\n`, executable: false }];
      }
      if (input.node.action.id === 'ai-review') {
        output.reviewEvidenceHash = hashObject(input.reviewEvidence);
        output.requirementAssessments = [{ requirementId: 'req-001', criterion, checkIds: [`check-${checkId}`],
          verdict: 'pass', reason: 'Реальная проверка завершилась успешно.', citations: [{ path: script, startLine: 3, quote: assertion }] }];
      }
      return { exitCode: 0, stopped: true, uncertain: false, output };
    },
  };
  service = await WorkflowService.open({ root, adapters });
  const initial = await service.create(taskInput, { runId: 'stages', operationId: 'create-stages', stage: 'execution', workflow: 'autonomous',
    draft: { nodes: compiled.plan.nodes }, taskContract: compiled.plan.taskContract });
  const plan = service.plan(initial.runId);
  assert.equal(plan.executionStages.stages.length, 2);
  const settle = async () => { for (let round = 0; round < 10 && service.drives.size; round++) await Promise.all([...service.drives.values()]); };
  return { root, profile, script, initial, plan, calls, beforeAtEffect, adapters,
    get service() { return service; },
    state: () => service.store.readRun('stages'), snapshot: () => service.snapshot('stages'), settle,
    checks: () => existsSync(path.join(root, 'out/checks.log')) ? readFileSync(path.join(root, 'out/checks.log'), 'utf8') : '',
    approve: async () => {
      const snapshot = service.snapshot('stages'), gate = snapshot.gates.find((item) => item.type === 'approve-plan');
      assert.ok(gate, JSON.stringify(snapshot));
      await service.command('stages', 'gate', request(snapshot, { nodeId: gate.nodeId, decision: 'approve',
        permissions: gate.requiredPermissions, challenge: gate.challenge }));
      await settle();
      return service.snapshot('stages');
    },
    reopen: async () => { await settle(); assert.equal(service.close(), true); service = await WorkflowService.open({ root, adapters }); await settle(); },
  };
}

function assertHold(fx) {
  const snapshot = fx.snapshot(), state = fx.state(), first = fx.plan.executionStages.stages[0];
  assert.equal(state.status, 'learning-hold', JSON.stringify(snapshot));
  assert.equal(state.continuation.kind, 'learning-hold');
  assert.equal(state.continuation.stageId, first.id);
  assert.equal(state.learning.progress[state.continuation.materialHash], undefined, 'A boundary is not evidence that a lesson was read');
  assert.equal(fx.checks(), '1\n');
  assert.equal(state.nodes[fx.plan.executionStages.stages[1].implementationNodeIds[0]].attempts, 0);
  assert.notEqual(snapshot.proof.status, 'PROVEN');
  return state.continuation;
}

for (const adapter of ['npm', 'python']) test(`${adapter}: durable before and one-CAS stage hold survive reopen; Continue executes stage two once`, async (t) => {
  const fx = await fixture(t, { adapter });
  await fx.approve();
  const hold = assertHold(fx), store = fx.service.store, first = fx.plan.executionStages.stages[0];
  const revisions = store.history('stages', { limit: 1000 });
  const committed = revisions.findIndex((state) => state.nodes[first.boundaryNodeId].status === 'passed');
  assert.ok(committed > 0);
  assert.equal(revisions[committed - 1].learning.stages[first.id], undefined);
  assert.notEqual(revisions[committed - 1].continuation.kind, 'learning-hold');
  const boundary = revisions[committed];
  assert.equal(boundary.learning.stages[first.id].materialHash, hold.materialHash);
  assert.equal(boundary.continuation.holdId, hold.holdId);
  assert.equal(boundary.nodes[first.boundaryNodeId].receipts.at(-1), hold.boundaryReceiptId);
  assert.equal(store.readObject('receipts', hold.boundaryReceiptId).exitCode, 0);
  const stageMaterial = store.readObject('learning-materials', hold.materialHash);
  assert.equal(sourceText(store, stageMaterial.sourceCatalogHash, 'before'), '0\n');
  assert.equal(sourceText(store, stageMaterial.sourceCatalogHash, 'after'), '1\n');
  const heldRevision = fx.state().revision, heldCalls = [...fx.calls];
  await fx.reopen();
  assert.deepEqual(assertHold(fx), hold);
  assert.equal(fx.state().revision, heldRevision);
  assert.deepEqual(fx.calls, heldCalls);
  for (const command of ['run', 'retry']) {
    await assert.rejects(fx.service.command('stages', command, request(fx.snapshot(), command === 'retry'
      ? { nodeId: fx.plan.executionStages.stages[1].implementationNodeIds[0] } : {})));
  }
  assert.deepEqual(fx.calls, heldCalls);
  const continuation = request(fx.snapshot(), { holdId: hold.holdId, disposition: 'continue' });
  await fx.service.command('stages', 'continue-learning', continuation);
  await fx.settle();
  const finished = fx.state(), count = fx.calls.length;
  assert.equal(fx.checks(), '1\n2\n', JSON.stringify(fx.snapshot()));
  assert.equal(fx.snapshot().proof.status, 'PROVEN', JSON.stringify(fx.snapshot()));
  assert.equal(fx.beforeAtEffect.length, 2);
  assert.equal(sourceText(store, fx.beforeAtEffect[1].sourceCatalogHash, 'before'), '1\n');
  assert.deepEqual(finished.learning.progress, {});
  await fx.service.command('stages', 'continue-learning', continuation);
  await fx.settle();
  assert.equal(fx.state().revision, finished.revision);
  assert.equal(fx.calls.length, count);
  await assert.rejects(fx.service.command('stages', 'continue-learning', request(fx.snapshot(),
    { holdId: hold.holdId, disposition: 'continue' })), { code: 'HOLD_CONFLICT' });
  assert.equal(sourceText(store, stageMaterial.sourceCatalogHash, 'after'), '1\n');
  const final = store.readObject('learning-materials', finished.learning.finalMaterialHash);
  assert.equal(final.kind, 'task');
  assert.notEqual(stageMaterial.resultHash, final.resultHash, 'Intermediate verification must not be mistaken for final evidence');
  assert.equal(final.resultHash, finished.learning.finalCapture.sourceHash);
  assert.equal(sourceText(store, final.sourceCatalogHash, 'after'), '2\n');
  await fx.reopen();
  assert.equal(fx.snapshot().proof.status, 'PROVEN');
  assert.equal(fx.checks(), '1\n2\n');
});

test('changing learning mode preserves the current hold; defer records only learning progress', async (t) => {
  const fx = await fixture(t);
  await fx.approve();
  const hold = assertHold(fx), before = [...fx.calls];
  const heldState = fx.state();
  const material = fx.service.learningMaterial('stages', hold.materialHash);
  const source = material.sources.find((item) => item.path === 'answer.txt' && item.role === 'after');
  const page = fx.service.learningSource('stages', hold.materialHash, source.id, { startLine: 1, lineCount: 20 });
  assert.equal(page.text, '1\n');
  assert.deepEqual(fx.state(), heldState, 'Material and source GETs must not write revision, progress, or execution state');
  assert.deepEqual(fx.calls, before);
  const progressRequest = request(fx.snapshot(), { materialHash: hold.materialHash, progress: 'read' });
  await fx.service.command('stages', 'set-learning-progress', progressRequest);
  const readState = fx.state();
  assert.equal(readState.learning.progress[hold.materialHash], 'read');
  assert.deepEqual(readState.continuation, hold);
  for (const key of ['nodes', 'permissions', 'workspaceFingerprint', 'taskHash', 'planHash', 'status'])
    assert.deepEqual(readState[key], heldState[key], `Progress must not change ${key}`);
  for (const key of ['captures', 'stages', 'mode', 'jobs']) assert.deepEqual(readState.learning[key], heldState.learning[key]);
  await fx.service.command('stages', 'set-learning-progress', progressRequest);
  assert.equal(fx.state().revision, readState.revision);
  assert.deepEqual(fx.calls, before);
  await assert.rejects(fx.service.command('stages', 'generate-lesson', request(fx.snapshot(), {
    materialHash: hold.materialHash,
  })), { code: 'CONTROL_DENIED' });
  assert.deepEqual(fx.state(), readState, 'Unavailable generation must not create jobs, events, or a new revision');
  assert.deepEqual(fx.calls, before);
  await fx.service.command('stages', 'set-learning-mode', request(fx.snapshot(), { mode: 'after-task' }));
  await fx.settle();
  assert.deepEqual(fx.state().continuation, hold);
  assert.deepEqual(fx.calls, before);
  assert.equal(fx.state().learning.mode, 'after-task');
  assert.equal(fx.service.plan('stages').learning.initialMode, 'after-stage');
  await fx.service.command('stages', 'continue-learning', request(fx.snapshot(), { holdId: hold.holdId, disposition: 'defer' }));
  await fx.settle();
  assert.equal(fx.checks(), '1\n2\n');
  assert.equal(fx.state().learning.progress[hold.materialHash], 'deferred');
  assert.equal(fx.snapshot().proof.status, 'PROVEN');
});

test('after-task proceeds without a hold and captures final bytes independently of immutable stage material', async (t) => {
  const fx = await fixture(t, { mode: 'after-task' });
  await fx.approve();
  assert.equal(fx.checks(), '1\n2\n', JSON.stringify(fx.snapshot()));
  assert.ok(fx.service.store.history('stages', { limit: 1000 }).every((state) => state.continuation.kind === 'open'));
  const state = fx.state(), store = fx.service.store;
  const first = store.readObject('learning-materials', state.learning.stages['stage-01'].materialHash);
  const final = store.readObject('learning-materials', state.learning.finalMaterialHash);
  assert.equal(sourceText(store, first.sourceCatalogHash, 'after'), '1\n');
  assert.equal(sourceText(store, final.sourceCatalogHash, 'before'), '0\n');
  assert.equal(sourceText(store, final.sourceCatalogHash, 'after'), '2\n');
  assert.notEqual(first.sourceCatalogHash, final.sourceCatalogHash);
  assert.equal(fx.snapshot().proof.status, 'PROVEN');
});

test('explicit replan carries the effective learning mode into the successor task and immutable plan', async (t) => {
  const fx = await fixture(t, { adapter: 'python', maxReplans: 1 });
  await fx.service.command('stages', 'set-learning-mode', request(fx.snapshot(), { mode: 'after-task' }));
  assert.equal(fx.plan.learning.initialMode, 'after-stage');
  await fx.approve();
  assert.equal(fx.checks(), '1\n2\n', JSON.stringify(fx.snapshot()));
  const calls = [...fx.calls];
  const next = await fx.service.command('stages', 'replan', request(fx.snapshot()));
  await fx.settle();
  const successor = fx.service.store.readRun(next.runId);
  assert.notEqual(next.runId, 'stages');
  assert.equal(successor.learning.mode, 'after-task');
  assert.equal(fx.service.plan(next.runId).learning.initialMode, 'after-task');
  assert.equal(fx.service.store.readObject('tasks', successor.taskHash).learningMode, 'after-task');
  assert.equal(fx.service.plan('stages').learning.initialMode, 'after-stage');
  assert.deepEqual(fx.calls, calls, 'A successor still needs its own approval');
});

for (const drift of ['source', 'toolchain', 'deadline']) test(`Continue refuses ${drift} drift without starting the next stage`, async (t) => {
  const fx = await fixture(t, { adapter: drift === 'toolchain' ? 'python' : 'npm' });
  await fx.approve();
  const hold = assertHold(fx), before = [...fx.calls];
  const continuation = request(fx.snapshot(), { holdId: hold.holdId, disposition: 'continue' });
  if (drift === 'source') writeFileSync(path.join(fx.root, 'answer.txt'), '9\n');
  if (drift === 'toolchain') writeFileSync(path.join(fx.root, fx.script), '# changed registered verifier\n');
  if (drift === 'deadline') {
    const currentTime = Date.now();
    t.mock.method(Date, 'now', () => currentTime + fx.plan.autonomy.maxDurationMs + 1000);
  }
  await assert.rejects(fx.service.command('stages', 'continue-learning', continuation), {
    code: { source: 'WORKSPACE_DRIFT', toolchain: 'CHECK_REGISTRY_DRIFT', deadline: 'CONTROL_DENIED' }[drift],
  });
  await fx.settle();
  assert.deepEqual(fx.calls, before);
  assert.deepEqual(fx.state().continuation, hold);
  assert.equal(fx.checks(), '1\n');
});

for (const reason of ['deadline', 'source']) test(`explicit replan supersedes a ${reason}-invalid hold and requires fresh approval`, async (t) => {
  const fx = await fixture(t, { adapter: 'python', maxReplans: 1 });
  await fx.approve();
  const hold = assertHold(fx), calls = [...fx.calls], prior = fx.state();
  if (reason === 'deadline') {
    const currentTime = Date.now();
    t.mock.method(Date, 'now', () => currentTime + fx.plan.autonomy.maxDurationMs + 1000);
  } else writeFileSync(path.join(fx.root, 'answer.txt'), '3\n');
  await assert.rejects(fx.service.command('stages', 'continue-learning', request(fx.snapshot(), {
    holdId: hold.holdId, disposition: 'continue',
  })), { code: reason === 'deadline' ? 'CONTROL_DENIED' : 'WORKSPACE_DRIFT' });
  assert.deepEqual(fx.state().continuation, hold);
  const replan = request(fx.snapshot());
  const next = await fx.service.command('stages', 'replan', replan);
  await fx.settle();
  const superseded = fx.state(), successor = fx.service.store.readRun(next.runId);
  assert.equal(superseded.finalDisposition, 'superseded');
  assert.deepEqual(superseded.continuation, { kind: 'open' });
  assert.deepEqual(superseded.learning.stages, prior.learning.stages);
  assert.equal(superseded.operations[replan.operationId].status, 'finished');
  const addedEvents = superseded.learning.eventIds.filter((id) => !prior.learning.eventIds.includes(id));
  assert.equal(addedEvents.length, 1);
  const event = fx.service.store.readObject('learning-events', addedEvents[0]);
  assert.equal(event.name, 'replan');
  assert.equal(event.request.operationId, replan.operationId);
  assert.deepEqual(event.hold, hold);
  const supersession = fx.service.store.history('stages', { limit: 1000 }).find((state) => state.finalDisposition === 'superseded');
  assert.deepEqual(supersession.continuation, { kind: 'open' });
  assert.ok(supersession.learning.eventIds.includes(addedEvents[0]));
  assert.equal(supersession.operations[replan.operationId].status, 'creating');
  assert.equal(successor.supersedesRunId, 'stages');
  assert.equal(successor.nodes['approve-plan'].status, 'waiting-for-human');
  assert.equal(successor.planVersion, 2);
  assert.equal(successor.maxReplans, 1);
  assert.deepEqual(successor.continuation, { kind: 'open' });
  assert.ok(fx.service.plan(next.runId).nodes.filter((node) => node.action.id === 'ai-implement')
    .every((node) => successor.nodes[node.id].attempts === 0));
  assert.equal(fx.service.snapshot(next.runId).integrity.valid, true);
  assert.equal(fx.service.snapshot('stages').integrity.valid, true);
  assert.deepEqual(fx.calls, calls);
  assert.equal(fx.checks(), '1\n');
});

test('Continue rejects a corrupt saved source chunk while preserving the hold and all remaining work', async (t) => {
  const fx = await fixture(t, { adapter: 'python' });
  await fx.approve();
  const hold = assertHold(fx), heldState = fx.state(), calls = [...fx.calls];
  const continuation = request(fx.snapshot(), { holdId: hold.holdId, disposition: 'continue' });
  const material = fx.service.store.readObject('learning-materials', hold.materialHash);
  const catalog = fx.service.store.readObject('learning-sources', material.sourceCatalogHash);
  const source = catalog.sources.find((item) => item.path === 'answer.txt' && item.role === 'after');
  const chunkFile = path.join(fx.root, '.ai-orchestrator/graph/learning-source-chunks', `${source.chunkHashes[0]}.json`);
  const wrapper = JSON.parse(readFileSync(chunkFile, 'utf8'));
  wrapper.data.text = 'changed saved bytes';
  writeFileSync(chunkFile, JSON.stringify(wrapper));
  await assert.rejects(fx.service.command('stages', 'continue-learning', continuation), { code: 'OBJECT_TAMPERED' });
  await fx.settle();
  assert.deepEqual(fx.state(), heldState, 'An integrity failure cannot publish continuation, progress, or an operation event');
  assert.deepEqual(fx.calls, calls);
  assert.equal(fx.checks(), '1\n');
  assert.equal(readFileSync(path.join(fx.root, 'answer.txt'), 'utf8'), '1\n');
});

for (const race of ['before', 'after']) test(`unsafe ${race} capture stops dependent effects and preserves its original diagnostic`, async (t) => {
  const fx = await fixture(t, { race });
  await fx.approve();
  const state = fx.state();
  assert.equal(state.learning.failure?.code, 'LEARNING_CAPTURE_UNAVAILABLE', JSON.stringify(fx.snapshot()));
  const capture = state.learning.captures['stage-01'][race];
  assert.ok(capture.gaps.some((gap) => gap.code === 'capture-unavailable'));
  assert.ok(new GraphStore(fx.root).readObject('learning-sources', capture.sourceCatalogHash));
  assert.equal(state.learning.stages['stage-01'], undefined);
  assert.equal(state.nodes[fx.plan.executionStages.stages[1].implementationNodeIds[0]].attempts, 0);
  assert.equal(fx.beforeAtEffect.length, race === 'before' ? 0 : 1);
  assert.equal(fx.checks(), race === 'before' ? '' : '1\n');
  assert.notEqual(fx.snapshot().proof.status, 'PROVEN');
});

test('ordinary missing-context gaps remain partial learning material and permit execution', async (t) => {
  const fx = await fixture(t, { partial: true, mode: 'after-task' });
  await fx.approve();
  assert.equal(fx.checks(), '1\n2\n', JSON.stringify(fx.snapshot()));
  const state = fx.state(), material = fx.service.store.readObject('learning-materials', state.learning.finalMaterialHash);
  assert.equal(state.learning.failure, undefined);
  assert.equal(material.status, 'partial');
  assert.ok(material.gaps.some((gap) => gap.code === 'missing-context'));
  assert.equal(fx.snapshot().proof.status, 'PROVEN');
});

for (const point of ['before', 'after']) test(`a pointer failure ${point} boundary CAS cannot lose or manufacture a committed hold`, async (t) => {
  const fx = await fixture(t);
  const store = fx.service.store, originalUpdate = store.updateRun.bind(store);
  let boundaryRevision = null, injected = false;
  t.mock.method(store, 'updateRun', (runId, revision, updater) => originalUpdate(runId, revision, (current) => {
    const next = updater(current);
    if (current.continuation.kind === 'open' && next.continuation.kind === 'learning-hold') boundaryRevision = revision + 1;
    return next;
  }));
  store.fault = (stage, context) => {
    if (!injected && boundaryRevision === context.revision && stage === `pointer.${point}-rename`) {
      injected = true;
      throw new Error(`Injected ${point} boundary commit failure`);
    }
  };
  await fx.approve();
  store.fault = null;
  assert.equal(injected, true, 'The fault must hit the actual boundary CAS');
  assert.equal(fx.checks(), '1\n');
  const state = fx.state(), calls = [...fx.calls], first = fx.plan.executionStages.stages[0];
  assert.equal(state.nodes[fx.plan.executionStages.stages[1].implementationNodeIds[0]].attempts, 0);
  if (point === 'before') {
    assert.equal(state.status, 'uncertain');
    assert.equal(state.continuation.kind, 'open');
    assert.equal(state.learning.stages[first.id], undefined);
    assert.equal(state.nodes[first.boundaryNodeId].status, 'uncertain');
    assert.equal(state.learning.finalMaterialHash, undefined);
    assert.equal(fx.snapshot().integrity.valid, true, JSON.stringify(fx.snapshot()));
    assert.equal(fx.snapshot().capabilities.continueLearning.allowed, false);
  } else {
    assertHold(fx);
    assert.equal(state.activeOperation, null, 'Known live owner must finish bookkeeping after observing the committed CAS');
    const boundary = store.readObject('receipts', state.continuation.boundaryReceiptId);
    const material = store.readObject('learning-materials', state.continuation.materialHash);
    assert.equal(boundary.verdict, 'pass');
    assert.ok(material.checkReceiptIds.includes(state.continuation.boundaryReceiptId));
  }
  await fx.reopen();
  assert.deepEqual(fx.calls, calls);
  assert.deepEqual(fx.state().continuation, state.continuation);
  assert.equal(fx.state().status, state.status);
  assert.equal(fx.checks(), '1\n');
  assert.notEqual(fx.snapshot().proof.status, 'PROVEN');
});
