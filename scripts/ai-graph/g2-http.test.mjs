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
import { once } from 'node:events';
import { startViewer } from '../../tools/ai-graph-viewer/server.mjs';
import { GraphError } from './lib/io.mjs';
import { readLearningMaterial, readLearningSourcePage } from './lib/learning-material.mjs';
import { prepareLearningProvider, readPreparedLearningInput, parseLearningProviderOutput, disposeLearningProvider } from './lib/learning-provider.mjs';
import { LearningJobSchema, LearningLessonResponseSchema, LessonAnswerSchema, LearningMaterialResponseSchema } from './lib/learning-schemas.mjs';

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

const token = 'fixture-g2-http-control-1234567890';
const complete = () => ({ exitCode: 0, stopped: true, uncertain: false, timedOut: false, outputLimit: false, signal: null, failureReason: null });
const tick = () => new Promise(resolve => setImmediate(resolve));

/** Real WorkflowService and HTTP, real local checks; learning execution is a deterministic stub with no provider/preflight. */
async function httpFixture(t, options = {}) {
  let fx, server;
  const handles = [], calls = { prepare: 0, execute: 0, dispose: 0 };
  const runtime = { denyPreflight: false, policy: { denyGlobs: [], outputPaths: ['out'], forbiddenPaths: [] } };
  // This hook is registered before fixture cleanup, so no viewer/job retains the temporary root.
  t.after(async () => {
    for (const handle of handles) handle.finish({ ...complete(), exitCode: 1, failureReason: 'FIXTURE_CLEANUP' });
    if (fx) await Promise.allSettled([...fx.service.learningJobs.tasks.values()]);
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    for (const handle of handles) if (existsSync(handle.prepared.scratch)) disposeLearningProvider(handle.prepared, { stopped: true });
  });
  fx = await fixture(t, options);
  fx.adapters.learningSourcePolicy = () => runtime.policy;
  fx.adapters.learningRunner = {
    capability: () => ({ allowed: true, reason: null }),
    prepare: async input => {
      calls.prepare++;
      if (runtime.denyPreflight) throw new GraphError('LEARNING_MANAGED_POLICY_CONFLICT', 'Учебные ограничения не подтверждены.');
      const prepared = prepareLearningProvider({ ...input, provider: 'codex', model: 'fixture-model' });
      const material = readLearningMaterial(input), source = material.sources.find(item => item.path === 'answer.txt' && item.role === 'after');
      assert.ok(source);
      const anchor = { sourceId: source.id, fileHash: source.fileHash, startLine: 1, endLine: 1,
        quote: readLearningSourcePage({ ...input, sourceId: source.id, startLine: 1, lineCount: 1 }).text };
      const lesson = { title: 'Сохраненное значение', scope: 'answer.txt',
        steps: [{ id: 'step-value', title: 'Значение', caller: 'Файл answer.txt', anchors: [anchor], input: 'Учебный пример',
          transformations: ['Прочитать сохраненное значение'], output: anchor.quote, next: null, purpose: 'Связать результат с кодом',
          changeConsequence: 'Значение изменится', alternatives: [],
          origin: { kind: 'teaching-example', label: 'Учебный пример', receiptId: null, artifactId: null, anchor: null } }],
        questions: [], wholeFlow: 'Прочитать сохраненное значение', takeaways: ['Проверять версию источника'], limitations: ['Ответ создан тестовым исполнителем.'] };
      const answer = { text: `Сохраненное значение: ${anchor.quote}.`, anchors: [input.question?.anchor ?? anchor], limitations: ['Ответ создан тестовым исполнителем.'] };
      let finish;
      const wait = new Promise(resolve => { finish = resolve; });
      const handle = { prepared, wait, finish, anchor, output: JSON.stringify(input.question ? answer : lesson),
        input: readPreparedLearningInput(prepared), inputHash: prepared.inputHash, schemaHash: prepared.schemaHash,
        methodHash: prepared.methodHash, materialHash: prepared.materialHash, preparationHash: prepared.preparationHash, kind: prepared.kind,
        providerBinding: { provider: 'fixture', model: 'fixture-model', toolchainHash: identity, preflightHash: identity, policyHash: identity },
        command: { executable: process.execPath, args: ['fixture-only-no-spawn'], cwd: prepared.scratch, env: {} } };
      handles.push(handle);
      return handle;
    },
    beforeGo: handle => { assert.equal(readPreparedLearningInput(handle.prepared), handle.input); },
    execute: async (handle, callbacks) => {
      calls.execute++;
      callbacks.onStart({ pid: process.pid, ticket: 'fixture-learning-http' });
      callbacks.beforeGo();
      return handle.wait;
    },
    parse: (handle, completion, policy) => parseLearningProviderOutput(handle.prepared, { output: handle.output, completion, policy }),
    dispose: (handle, options) => { calls.dispose++; disposeLearningProvider(handle.prepared, options); },
  };
  const held = await fx.approve();
  assert.equal(held.continuation.kind, 'learning-hold', JSON.stringify(held));
  const materialHash = held.continuation.materialHash;
  assert.ok(materialHash);
  let url;
  const openServer = async () => {
    server = startViewer({ service: fx.service, token, port: 0 });
    await once(server, 'listening');
    url = `http://127.0.0.1:${server.address().port}`;
  };
  await openServer();
  const headers = { 'X-flowcairn-Control': token, Origin: url, 'Content-Type': 'application/json' };
  const getFor = (runId, route, options = {}) => fetch(`${url}/api/runs/${runId}${route}`, { headers, ...options });
  const get = (route, options = {}) => getFor(held.runId, route, options);
  const post = (route, body, options = {}) => get(route, { method: 'POST', body: JSON.stringify(body), ...options });
  const postFor = (runId, route, body) => getFor(runId, route, { method: 'POST', body: JSON.stringify(body) });
  const reopen = async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await fx.reopen(); await openServer(); headers.Origin = url;
  };
  const control = extra => request(fx.snapshot(), { materialHash, ...extra });
  const finish = async () => { await tick(); handles.at(-1).finish(complete()); await Promise.all([...fx.service.learningJobs.tasks.values()]); await tick(); };
  return { fx, held, materialHash, calls, runtime, handles, get, post, getFor, postFor, reopen, headers, control, finish };
}

test('material progress survives HTTP reload/reopen for stage, final and owner history without changing evidence', async t => {
  const f = await httpFixture(t, { maxReplans: 1 }), ownerId = f.held.runId;
  const evidence = new Map();
  const getMaterial = async (runId, materialHash, progress) => {
    const stateBefore = f.fx.service.store.readRun(runId);
    const response = await f.getFor(runId, `/learning/materials/${materialHash}`);
    assert.equal(response.status, 200);
    const body = LearningMaterialResponseSchema.parse(await response.json());
    assert.equal(body.progress, progress);
    assert.equal(body.id, materialHash);
    assert.equal(hashObject(body.material), materialHash);
    assert.equal(hashObject({ version: 1, sources: body.sources }), body.material.sourceCatalogHash);
    assert.equal('progress' in body.material, false);
    const stable = { material: body.material, sources: body.sources };
    if (evidence.has(materialHash)) assert.deepEqual(stable, evidence.get(materialHash));
    else evidence.set(materialHash, stable);
    assert.deepEqual(f.fx.service.store.readRun(runId), stateBefore, 'GET must not persist defaults or change progress');
    return body;
  };
  const mark = async (runId, materialHash, progress) => {
    const snapshot = f.fx.service.snapshot(runId), before = f.fx.service.store.readRun(runId);
    const response = await f.postFor(runId, '/learning/commands/set-progress', request(snapshot, { materialHash, progress }));
    assert.equal(response.status, 200);
    const marked = await response.json();
    assert.equal(marked.ok, true); assert.equal(marked.result.schemaVersion, 3);
    assert.deepEqual(marked.result.proof, snapshot.proof);
    const after = f.fx.service.store.readRun(runId);
    for (const key of ['nodes', 'permissions', 'continuation', 'workspaceFingerprint', 'initialFingerprint', 'sourceHash', 'taskHash', 'planHash'])
      assert.deepEqual(after[key], before[key], `Progress must not change ${key}`);
    assert.equal(after.learning.progress[materialHash], progress);
    return getMaterial(runId, materialHash, progress);
  };

  await getMaterial(ownerId, f.materialHash, 'unread');
  await mark(ownerId, f.materialHash, 'read');
  await f.reopen();
  await getMaterial(ownerId, f.materialHash, 'read');
  const continued = await f.post('/control/continue-learning', request(f.fx.snapshot(), {
    holdId: f.held.continuation.holdId, disposition: 'continue',
  }));
  assert.equal(continued.status, 200);
  await f.fx.settle();
  assert.equal(f.fx.snapshot().proof.status, 'PROVEN');
  const finalHash = f.fx.state().learning.finalMaterialHash;
  await getMaterial(ownerId, finalHash, 'unread');
  await mark(ownerId, finalHash, 'deferred');
  await f.reopen();
  await getMaterial(ownerId, f.materialHash, 'read');
  await getMaterial(ownerId, finalHash, 'deferred');
  assert.equal(f.fx.snapshot().proof.status, 'PROVEN');

  const replan = await f.post('/control/replan', request(f.fx.snapshot()));
  assert.equal(replan.status, 200);
  const successor = (await replan.json()).result.runId;
  assert.notEqual(successor, ownerId);
  for (const [hash, ownerProgress, override] of [[f.materialHash, 'read', 'unread'], [finalHash, 'deferred', 'read']]) {
    const inherited = await getMaterial(successor, hash, ownerProgress);
    assert.equal(inherited.material.runId, ownerId);
    assert.equal(f.fx.service.store.readRun(successor).learning.progress[hash], undefined);
    await mark(successor, hash, override);
    assert.equal(f.fx.service.store.readRun(ownerId).learning.progress[hash], ownerProgress);
  }
  await f.reopen();
  await getMaterial(successor, f.materialHash, 'unread');
  await getMaterial(successor, finalHash, 'read');
  await getMaterial(ownerId, f.materialHash, 'read');
  await getMaterial(ownerId, finalHash, 'deferred');
  assert.equal(f.fx.checks(), '1\n2\n');
  assert.deepEqual(f.calls, { prepare: 0, execute: 0, dispose: 0 });
  f.runtime.policy = { ...f.runtime.policy, denyGlobs: ['answer.txt'] };
  const blocked = await f.getFor(successor, `/learning/materials/${finalHash}`);
  assert.equal(blocked.status, 400);
  const error = await blocked.json();
  assert.equal(error.error.code, 'LEARNING_SOURCE_DENIED');
  assert.equal(error.progress, undefined, 'Unavailable material must not be fabricated as unread');
});

test('actual service HTTP returns job envelopes, keeps Continue independent and serves canonical lesson/answer DTOs', async t => {
  const f = await httpFixture(t), generatedRequest = f.control({});
  const generated = await f.post('/learning/commands/generate-lesson', generatedRequest);
  assert.equal(generated.status, 202);
  const started = await generated.json();
  assert.deepEqual(Object.keys(started).sort(), ['ok', 'result']);
  assert.equal(started.ok, true);
  assert.deepEqual(Object.keys(started.result).sort(), ['jobId', 'snapshot']);
  assert.match(started.result.jobId, /^job-/);
  assert.equal(started.result.snapshot.schemaVersion, 3);
  assert.equal(started.result.snapshot.continuation.kind, 'learning-hold');
  const runningResponse = await f.get(`/learning/jobs/${started.result.jobId}`);
  assert.equal(runningResponse.status, 200);
  const running = LearningJobSchema.parse(await runningResponse.json());
  assert.equal(running.status, 'running'); assert.equal(running.result, null);
  assert.deepEqual(Object.keys(running).sort(), ['error', 'id', 'kind', 'materialHash', 'result', 'status']);

  const progress = await f.post('/learning/commands/set-progress', f.control({ progress: 'read' }));
  assert.equal(progress.status, 200);
  const marked = await progress.json();
  assert.equal(marked.ok, true); assert.equal(marked.result.schemaVersion, 3); assert.equal(marked.result.jobId, undefined);
  assert.equal(marked.result.learning.stages[0].progress, 'read');
  const continued = await f.post('/control/continue-learning', request(f.fx.snapshot(), { holdId: f.held.continuation.holdId, disposition: 'continue' }));
  assert.equal(continued.status, 200);
  assert.equal((await continued.json()).result.continuation.kind, 'open');
  await f.fx.settle();
  assert.equal(f.fx.snapshot().status, 'passed', JSON.stringify(f.fx.snapshot()));
  const executionBeforeCompletion = f.fx.state(), proofBeforeCompletion = f.fx.snapshot().proof;
  await f.finish();
  const after = f.fx.state();
  assert.deepEqual(after.nodes, executionBeforeCompletion.nodes);
  assert.deepEqual(after.continuation, executionBeforeCompletion.continuation);
  assert.deepEqual(after.workspaceFingerprint, executionBeforeCompletion.workspaceFingerprint);
  assert.equal(after.status, executionBeforeCompletion.status);
  assert.equal(after.learning.progress[f.materialHash], 'read');
  assert.deepEqual(f.fx.snapshot().proof, proofBeforeCompletion);
  const readyResponse = await f.get(`/learning/jobs/${started.result.jobId}`);
  assert.equal(readyResponse.status, 200);
  const ready = LearningJobSchema.parse(await readyResponse.json());
  assert.equal(ready.status, 'ready');
  assert.ok('lessonHash' in ready.result);
  const lessonResponse = await f.get(`/learning/lessons/${ready.result.lessonHash}`);
  assert.equal(lessonResponse.status, 200);
  const lesson = LearningLessonResponseSchema.parse(await lessonResponse.json());
  assert.equal(lesson.id, ready.result.lessonHash);
  assert.equal(lesson.lesson.materialHash, f.materialHash);
  assert.equal(lesson.lesson.steps[0].anchors[0].quote, '1'); // Saved first stage survives the second stage's write.

  const asked = await f.post('/learning/commands/ask-lesson', f.control({ lessonHash: lesson.id,
    anchor: lesson.lesson.steps[0].anchors[0], question: 'Какое значение сохранено?' }));
  assert.equal(asked.status, 202);
  const answerStarted = await asked.json();
  assert.equal(answerStarted.ok, true);
  assert.deepEqual(Object.keys(answerStarted.result).sort(), ['jobId', 'snapshot']);
  await f.finish();
  const answerJob = LearningJobSchema.parse(await (await f.get(`/learning/jobs/${answerStarted.result.jobId}`)).json());
  assert.equal(answerJob.status, 'ready'); assert.ok('answerHash' in answerJob.result);
  const answerResponse = await f.get(`/learning/answers/${answerJob.result.answerHash}`);
  assert.equal(answerResponse.status, 200);
  const answer = LessonAnswerSchema.parse(await answerResponse.json());
  assert.equal(answer.materialHash, f.materialHash); assert.equal(answer.lessonHash, lesson.id);
  assert.equal(answer.question, 'Какое значение сохранено?');
  assert.deepEqual(f.fx.snapshot().proof, proofBeforeCompletion);

  const replay = await f.post('/learning/commands/generate-lesson', generatedRequest);
  assert.equal(replay.status, 202); assert.equal((await replay.json()).result.jobId, started.result.jobId);
  assert.equal(f.calls.prepare, 2); assert.equal(f.calls.execute, 2);
  const beforeDeniedReads = f.fx.state();
  f.runtime.policy = { ...f.runtime.policy, denyGlobs: ['answer.txt'] };
  for (const route of [`/learning/jobs/${started.result.jobId}`, `/learning/lessons/${lesson.id}`, `/learning/answers/${answerJob.result.answerHash}`]) {
    const denied = await f.get(route);
    assert.equal(denied.status, 400);
    assert.equal((await denied.json()).error.code, 'LEARNING_SOURCE_DENIED');
  }
  assert.deepEqual(f.fx.state(), beforeDeniedReads);
});

test('actual service HTTP guards auth/query and preflight refusal creates no durable or accepted job', async t => {
  const f = await httpFixture(t), fakeHash = 'a'.repeat(64), before = f.fx.state();
  for (const route of [`/learning/jobs/job-missing`, `/learning/lessons/${fakeHash}`, `/learning/answers/${fakeHash}`]) {
    assert.equal((await f.get(route, { headers: {} })).status, 403);
    assert.equal((await f.get(`${route}?unknown=1`)).status, 400);
  }
  for (const command of ['generate-lesson', 'ask-lesson']) {
    const route = `/learning/commands/${command}`;
    assert.equal((await f.post(route, f.control({}), { headers: { ...f.headers, Origin: 'https://other.example' } })).status, 403);
    assert.equal((await f.post(`${route}?duplicate=1&duplicate=2`, f.control({}))).status, 400);
  }
  assert.equal(f.calls.prepare, 0); assert.equal(f.calls.execute, 0);
  assert.deepEqual(f.fx.state(), before);
  f.runtime.denyPreflight = true;
  const denied = await f.post('/learning/commands/generate-lesson', f.control({}));
  assert.equal(denied.status, 400);
  const body = await denied.json();
  assert.equal(body.ok, false); assert.equal(body.error.code, 'LEARNING_MANAGED_POLICY_CONFLICT');
  assert.equal(body.result, undefined); assert.equal(body.jobId, undefined);
  assert.equal(f.calls.prepare, 1); assert.equal(f.calls.execute, 0);
  assert.deepEqual(f.fx.state(), before);
  assert.deepEqual(f.fx.state().learning.jobs, {});
  const missing = await f.get(`/learning/lessons/${fakeHash}`);
  assert.equal(missing.status, 404); assert.equal((await missing.json()).error.code, 'NOT_FOUND');
});

test('actual service runtime drift closes direct execution controls while historical learning remains readable', async t => {
  const f = await httpFixture(t), before = f.fx.state();
  f.fx.adapters.identity = () => hashObject('changed-runtime');
  const snapshotResponse = await f.get('/snapshot');
  assert.equal(snapshotResponse.status, 200);
  const snapshot = await snapshotResponse.json();
  assert.equal(snapshot.status, 'stale');
  assert.equal(snapshot.capabilities.openLearning.allowed, true);
  for (const capability of ['continueLearning', 'setLearningMode', 'run']) assert.equal(snapshot.capabilities[capability].allowed, false);
  for (const [route, extra] of [
    ['/control/set-learning-mode', { mode: 'after-task' }],
    ['/control/continue-learning', { holdId: f.held.continuation.holdId, disposition: 'continue' }],
    ['/control/run', {}],
  ]) {
    const denied = await f.post(route, request(snapshot, extra));
    assert.equal(denied.status, 400);
    assert.equal((await denied.json()).error.code, 'RUNTIME_DRIFT');
    assert.deepEqual(f.fx.state(), before);
  }
  const saved = await f.get(`/learning/materials/${f.materialHash}`);
  assert.equal(saved.status, 200);
  const material = await saved.json(), source = material.sources.find(item => item.path === 'answer.txt' && item.role === 'after');
  assert.ok(source);
  const page = await f.get(`/learning/materials/${f.materialHash}/sources/${source.id}?startLine=1&lineCount=1`);
  assert.equal(page.status, 200); assert.equal((await page.json()).text, '1');
  assert.deepEqual(f.fx.state(), before);
  const generated = await f.post('/learning/commands/generate-lesson', f.control({}));
  assert.equal(generated.status, 202);
  const started = await generated.json();
  await f.finish();
  const job = await f.get(`/learning/jobs/${started.result.jobId}`);
  assert.equal(job.status, 200); assert.equal((await job.json()).status, 'ready');
  assert.deepEqual(f.fx.state().nodes, before.nodes);
  assert.deepEqual(f.fx.state().continuation, before.continuation);
  assert.equal(f.fx.state().status, before.status);
});
