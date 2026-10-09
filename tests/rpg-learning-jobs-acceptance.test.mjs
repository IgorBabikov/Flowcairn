import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, cpSync, readdirSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Readable } from 'node:stream';
import { control } from '../tools/ai-graph-viewer/controller.mjs';
import { readLearningMaterial, readLearningSourcePage } from '../scripts/ai-graph/lib/learning-material.mjs';
import { prepareLearningProvider, readPreparedLearningInput, parseLearningProviderOutput, disposeLearningProvider } from '../scripts/ai-graph/lib/learning-provider.mjs';
import { readLearningJobs } from '../scripts/ai-graph/lib/learning-job-state.mjs';
import { captureBeforeContents, buildAttemptDiff } from '../scripts/ai-graph/lib/artifacts.mjs';
import { inspectProjectChecks } from '../scripts/ai-graph/lib/check-profile.mjs';
import { SKILL_ROUTES } from '../scripts/ai-graph/lib/config.mjs';
import { inspectDirectChanges } from '../scripts/ai-graph/lib/direct-fingerprint.mjs';
import { fingerprintDirectWorkspace } from '../scripts/ai-graph/lib/direct-workspace.mjs';
import { hashObject, sha256 } from '../scripts/ai-graph/lib/io.mjs';
import { compileTaskProposal } from '../scripts/ai-graph/lib/planning.mjs';
import { ProjectProfileSchema, trustedLocalChecksHash } from '../scripts/ai-graph/lib/project.mjs';
import { runRegisteredAction } from '../scripts/ai-graph/lib/runner.mjs';
import { TaskSpecV3Schema } from '../scripts/ai-graph/lib/schemas.mjs';
import { WorkflowService } from '../scripts/ai-graph/lib/service.mjs';
import { GraphStore } from '../scripts/ai-graph/lib/store.mjs';
import { prepareToolchain, verifyToolchain } from '../scripts/ai-graph/lib/toolchain.mjs';

const skillText = 'Independent stage fixture', identity = sha256(skillText);
const skills = [...new Set(Object.values(SKILL_ROUTES).flat())].map(id => ({ id, path: `skills/${id}/SKILL.md`, hash: identity }));
const request = (snapshot, extra = {}) => ({ operationId: `qa-${randomUUID()}`, expectedRevision: snapshot.revision, planHash: snapshot.planHash, ...extra });
const criterion = 'Оба изменения сохраняют инвариант пары';
const assertion = 'assert(a === 1 && (b === 1 || b === 2));';

async function fixture(t, { mode = 'after-stage', partial = false, unsafeBefore = false } = {}) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-qa-stages-')));
  let service;
  t.after(async () => {
    if (service) { await Promise.all([...service.drives.values()]); service.close(); }
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(path.join(root, 'alpha.json'), '0\n');
  writeFileSync(path.join(root, 'beta.json'), '1\n');
  writeFileSync(path.join(root, 'verify.mjs'), `import assert from 'node:assert/strict'; import { readFileSync, appendFileSync } from 'node:fs';\nconst a = JSON.parse(readFileSync('alpha.json')), b = JSON.parse(readFileSync('beta.json'));\n${assertion}\nappendFileSync('out/observed', JSON.stringify([a,b]) + '\\n');\n`);
  mkdirSync(path.join(root, 'out'));
  const profile = ProjectProfileSchema.parse({ version: 2, workspaceMode: 'direct', integrationBranch: 'main',
    contextPaths: [], manifests: [], checks: ['pair'], checkMode: 'trusted-local', outputPaths: ['out'], ai: { provider: 'codex', model: 'injected' },
    checkProfile: { version: 1, requiredCheckIds: ['pair'], environment: [], definitions: [{ id: 'pair', title: 'Проверить пару', purpose: criterion,
      command: { executable: process.execPath, argv: ['verify.mjs'], cwd: '.' }, inputPaths: ['verify.mjs'], outputPaths: ['out'], timeoutMs: 5000, maxOutputBytes: 65536 }] } });
  writeFileSync(path.join(root, '.flowcairn.json'), JSON.stringify(profile));
  mkdirSync(path.join(root, '.ai-orchestrator/graph/runner-tickets'), { recursive: true, mode: 0o700 });
  for (const dir of ['.ai-orchestrator', '.ai-orchestrator/graph']) chmodSync(path.join(root, dir), 0o700);
  writeFileSync(path.join(root, '.ai-orchestrator/flowcairn-install.json'), JSON.stringify({ tool: 'flowcairn', owner: `flowcairn-${randomUUID()}`,
    trustedLocalChecksHash: trustedLocalChecksHash(root, profile) }), { mode: 0o600 });
  const fingerprint = () => fingerprintDirectWorkspace(root, { outputPaths: profile.outputPaths });
  const input = { id: 'QA-STAGES', goal: criterion, instructions: 'Сначала alpha=1, затем beta=2; два разных исходника.', scope: ['alpha.json', 'beta.json'],
    contextPaths: ['verify.mjs', ...(partial ? ['not-captured.custom'] : [])], acceptance: [criterion], checks: ['pair'], learningMode: mode,
    limits: { timeoutMs: 5000, maxAttempts: 1, maxReplans: 2 } };
  const task = TaskSpecV3Schema.parse({ ...input, schemaVersion: 3, sourceHash: fingerprint().hash });
  const steps = ['alpha.json', 'beta.json'].map((file, index) => ({ id: `file-${index + 1}`, title: `Изменить ${file}`, outcome: `Сохранено ${index + 1}`,
    paths: [file], readPaths: ['verify.mjs'], needs: [], requirementIds: ['req-001'] }));
  const proposal = { summary: criterion, verdict: 'pass', skillsUsed: [], findings: [], changedFiles: [], edits: [], plan: [], steps,
    contractProposal: { requirements: [{ id: 'req-001', title: criterion, mandatory: true, verification: { method: 'check', checkIds: ['check-pair'], criterion,
      paths: ['verify.mjs'] } }], optionalImprovements: [], constraints: [], assumptions: [], unknowns: [] } };
  const compiled = compileTaskProposal(task, proposal, { runtimeHash: identity, skills, checks: inspectProjectChecks(root, profile), workflow: 'autonomous' });
  const calls = [], beforeEffects = [];
  let injectedRace = false;
  const adapters = { dataVersion: 3, project: profile, identity: () => identity, ownerIdentity: () => hashObject('qa-live-owner'), skills: () => skills,
    checkRegistry: () => inspectProjectChecks(root, profile), hasReadConsent: () => true,
    capture: () => ({ manifest: { sourceHash: fingerprint().hash }, bundlePath: 'qa-injected-source-binding' }),
    allocate: ({ task: selected, runId }) => ({ mode: 'direct', worktree: root, taskId: selected.id, attemptId: 1, leaseId: 'qa', sourceHash: fingerprint().hash, runId }),
    replaceBinding: ({ binding, newRunId, sourceHash }) => ({ ...binding, runId: newRunId, sourceHash }), verifyBinding: () => true,
    fingerprint, inspectChanges: inspectDirectChanges, diff: buildAttemptDiff,
    prepareToolchain: () => prepareToolchain({ root, worktree: root }), verifyToolchain: (worktree, manifest) => verifyToolchain({ root, worktree, manifest }),
    captureBefore: (...args) => {
      const captured = captureBeforeContents(...args);
      if (unsafeBefore && !injectedRace && args[2].action.id === 'ai-implement') {
        injectedRace = true;
        rmSync(path.join(root, 'alpha.json'));
        symlinkSync(path.join(root, 'beta.json'), path.join(root, 'alpha.json'));
      }
      return captured;
    },
    applyEdits: (_worktree, _before, node, _task, edits) => {
      const store = new GraphStore(root), state = store.readRun('qa-stages');
      const stage = compiled.plan.executionStages.stages.find(item => item.implementationNodeIds.includes(node.id));
      const before = state.learning.captures[stage.id].before;
      const source = store.readObject('learning-sources', before.sourceCatalogHash).sources.find(item => item.path === edits[0].path && item.role === 'before');
      assert.equal(source.chunkHashes.map(id => store.readObject('learning-source-chunks', id).text).join(''), readFileSync(path.join(root, edits[0].path), 'utf8'));
      beforeEffects.push(before);
      for (const edit of edits) writeFileSync(path.join(root, edit.path), edit.content);
    },
    runner: { ai: { available: true }, checks: { available: true } },
    loadSkills: ids => ids.map(name => ({ name, text: skillText, hash: identity, path: `skills/${name}/SKILL.md` })),
    execute: async args => {
      calls.push(args.node.id);
      if (args.node.action.id.startsWith('check-')) return runRegisteredAction(args);
      args.onStart({ ticket: 'qa-injected-ai', pid: process.pid });
      const output = { summary: criterion, verdict: 'pass', skillsUsed: args.node.skills, findings: [], changedFiles: [], edits: [], plan: [] };
      if (args.node.action.id === 'ai-implement') {
        const file = args.node.resources.writes[0], value = file === 'alpha.json' ? 1 : 2;
        output.changedFiles = [file];
        output.edits = [{ path: file, content: `${value}\n`, previousHash: sha256(readFileSync(path.join(root, file))), executable: false }];
      }
      if (args.node.action.id === 'ai-review') {
        output.reviewEvidenceHash = hashObject(args.reviewEvidence);
        output.requirementAssessments = [{ requirementId: 'req-001', criterion, checkIds: ['check-pair'], verdict: 'pass', reason: 'Проверка пары выполнена.',
          citations: [{ path: 'verify.mjs', startLine: 3, quote: assertion }] }];
      }
      return { exitCode: 0, stopped: true, uncertain: false, output };
    },
  };
  service = await WorkflowService.open({ root, adapters });
  const create = (id = 'QA-STAGES', runId = 'qa-stages') => service.create({ ...input, id }, { runId, operationId: `create-${runId}`,
    stage: 'execution', workflow: 'autonomous', draft: { nodes: compiled.plan.nodes }, taskContract: compiled.plan.taskContract });
  await create();
  const settle = async () => { for (let i = 0; i < 10 && service.drives.size; i++) await Promise.all([...service.drives.values()]); };
  return { root, adapters, calls, beforeEffects, create, settle, plan: service.plan('qa-stages'),
    get service() { return service; },
    state: () => service.store.readRun('qa-stages'), snapshot: () => service.snapshot('qa-stages'),
    observations: () => existsSync(path.join(root, 'out/observed')) ? readFileSync(path.join(root, 'out/observed'), 'utf8') : '',
    approve: async () => {
      const snapshot = service.snapshot('qa-stages'), gate = snapshot.gates.find(item => item.type === 'approve-plan');
      await service.command('qa-stages', 'gate', request(snapshot, { nodeId: gate.nodeId, decision: 'approve', permissions: gate.requiredPermissions, challenge: gate.challenge }));
      await settle(); return service.snapshot('qa-stages');
    },
    reopen: async () => { await settle(); assert.equal(service.close(), true); service = await WorkflowService.open({ root, adapters }); await settle(); },
  };
}

const completion = (extra = {}) => ({ exitCode: 0, stopped: true, uncertain: false, timedOut: false, outputLimit: false, signal: null, failureReason: null, ...extra });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const executionPart = state => Object.fromEntries(['status', 'nodes', 'permissions', 'continuation', 'workspaceFingerprint', 'planHash', 'taskHash', 'activeOperation', 'finalDisposition'].map(key => [key, state[key]]));

async function jobsFixture(t) {
  let f;
  const handles = [], counts = { prepare: 0, execute: 0, dispose: 0 };
  const runtime = { policy: { denyGlobs: [], outputPaths: ['out'], forbiddenPaths: [] }, preparationGate: null, forgedOutput: null };
  t.after(async () => {
    for (const handle of handles) handle.wait.resolve(completion({ exitCode: 1, failureReason: 'QA_CLEANUP' }));
    if (f) await Promise.allSettled([...f.service.learningJobs.tasks.values()]);
    for (const handle of handles) if (existsSync(handle.prepared.scratch)) disposeLearningProvider(handle.prepared, { stopped: true });
  });
  f = await fixture(t);
  f.adapters.learningSourcePolicy = () => runtime.policy;
  f.adapters.learningRunner = {
    capability: () => ({ allowed: true, reason: null }),
    prepare: async input => {
      counts.prepare++;
      const prepared = prepareLearningProvider({ ...input, provider: 'codex', model: 'qa-injected-model' });
      const material = readLearningMaterial(input), source = material.sources.find(item => item.path === 'alpha.json' && item.role === 'after');
      const anchor = { sourceId: source.id, fileHash: source.fileHash, startLine: 1, endLine: 1,
        quote: readLearningSourcePage({ ...input, sourceId: source.id, startLine: 1, lineCount: 1 }).text };
      const lesson = { title: 'Сохраненное значение', scope: 'alpha.json', steps: [{ id: 'step-one', title: 'Значение', caller: 'Файл', anchors: [anchor],
        input: 'Учебное значение', transformations: ['Прочитать сохраненное значение'], output: anchor.quote, next: null, purpose: 'Понять изменение',
        changeConsequence: 'Изменится значение', alternatives: [], origin: { kind: 'teaching-example', label: 'Пример', receiptId: null, artifactId: null, anchor: null } }],
        questions: [], wholeFlow: 'Чтение сохраненной версии', takeaways: [], limitations: ['Ответ injected, модель не запускалась.'] };
      const answer = { text: 'Ответ по сохраненному источнику', anchors: [input.question?.anchor ?? anchor], limitations: ['Injected ответ.'] };
      const handle = { prepared, wait: deferred(), anchor, lesson, output: JSON.stringify(input.question ? answer : lesson),
        input: readPreparedLearningInput(prepared), inputHash: prepared.inputHash, schemaHash: prepared.schemaHash, methodHash: prepared.methodHash,
        materialHash: prepared.materialHash, preparationHash: prepared.preparationHash, kind: prepared.kind,
        providerBinding: { provider: 'qa-injected', model: 'qa-injected-model', toolchainHash: identity, preflightHash: identity, policyHash: identity },
        command: { executable: process.execPath, args: ['never-spawn-this-fixture'], cwd: prepared.scratch, env: {} } };
      handles.push(handle);
      if (runtime.preparationGate) await runtime.preparationGate.promise;
      return handle;
    },
    beforeGo: handle => assert.equal(readPreparedLearningInput(handle.prepared), handle.input),
    execute: async (handle, callbacks) => {
      counts.execute++;
      const store = new GraphStore(f.root), state = store.readRun('qa-stages');
      const job = readLearningJobs(store, state).find(({ job }) => job.inputHash === handle.inputHash && job.status === 'running').job;
      const input = store.readObject('operations', job.inputObjectHash);
      assert.equal(sha256(input.promptParts.join('')), handle.inputHash, 'Input must be durable before the provider runner');
      assert.equal(job.commandHash, hashObject(handle.command));
      callbacks.onStart({ pid: process.pid, ticket: 'qa-learning-process' });
      callbacks.beforeGo();
      return handle.wait.promise;
    },
    parse: (handle, result, policy) => runtime.forgedOutput ?? parseLearningProviderOutput(handle.prepared, { output: handle.output, completion: result, policy }),
    dispose: (handle, result) => { counts.dispose++; disposeLearningProvider(handle.prepared, result); },
  };
  await f.approve();
  assert.equal(f.state().continuation.kind, 'learning-hold');
  const materialHash = f.state().continuation.materialHash;
  return { ...f, runtime, handles, counts, materialHash,
    request: extra => request(f.snapshot(), { materialHash, ...extra }),
    finish: async (index = handles.length - 1, result = completion()) => { handles[index].wait.resolve(result); await Promise.allSettled([...f.service.learningJobs.tasks.values()]); await tick(); },
  };
}

async function controllerPost(service, action, body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.headers = { 'content-type': 'application/json' };
  let serialized;
  const response = { statusCode: null, setHeader: () => {}, end: value => { serialized = value; } };
  await control(service, req, response, new URL(`/api/runs/qa-stages/learning/commands/${action}`, 'http://127.0.0.1'));
  return { status: response.statusCode, body: JSON.parse(serialized) };
}

test('Generate and Ask return canonical 202 DTOs; exact replay and saved-object GETs cause no inference or state writes', async t => {
  const f = await jobsFixture(t), start = f.request();
  const accepted = await controllerPost(f.service, 'generate-lesson', start);
  assert.equal(accepted.status, 202); assert.equal(accepted.body.ok, true);
  assert.deepEqual(Object.keys(accepted.body.result).sort(), ['jobId', 'snapshot']);
  await tick();
  const jobId = accepted.body.result.jobId;
  const replay = await controllerPost(f.service, 'generate-lesson', start);
  assert.equal(replay.body.result.jobId, jobId); assert.equal(f.counts.prepare, 1); assert.equal(f.counts.execute, 1);
  await f.finish();
  const ready = f.service.learningObject('qa-stages', 'job', jobId);
  assert.equal(ready.status, 'ready');
  const lesson = f.service.learningObject('qa-stages', 'lesson', ready.result.lessonHash);
  const answerRequest = f.request({ lessonHash: lesson.id, anchor: lesson.lesson.steps[0].anchors[0], question: 'Что сохранено?' });
  const ask = await controllerPost(f.service, 'ask-lesson', answerRequest);
  assert.equal(ask.status, 202); await f.finish();
  const answerJob = f.service.learningObject('qa-stages', 'job', ask.body.result.jobId);
  const before = hashObject(f.state()), counts = { ...f.counts };
  for (let i = 0; i < 3; i++) {
    f.snapshot(); f.service.learningMaterial('qa-stages', f.materialHash);
    f.service.learningObject('qa-stages', 'lesson', lesson.id);
    const answer = f.service.learningObject('qa-stages', 'answer', answerJob.result.answerHash);
    assert.equal(answer.lessonHash, lesson.id); assert.equal(answer.question, answerRequest.question);
    assert.deepEqual(answer.anchor, answerRequest.anchor);
  }
  assert.equal(hashObject(f.state()), before); assert.deepEqual(f.counts, counts);
  assert.equal(f.counts.execute, 2);
  assert.equal(f.state().continuation.kind, 'learning-hold', 'Learning never releases the execution hold');
});

test('late lesson completion after Continue preserves final execution proof and progress changed during generation', async t => {
  const f = await jobsFixture(t), hold = f.state().continuation;
  const started = await f.service.command('qa-stages', 'generate-lesson', f.request()); await tick();
  assert.equal(f.service.close(), false, 'An active owned learning job prevents service close');
  await f.service.command('qa-stages', 'continue-learning', request(f.snapshot(), { holdId: hold.holdId, disposition: 'defer' }));
  await f.settle();
  assert.equal(f.snapshot().proof.status, 'PROVEN');
  await f.service.command('qa-stages', 'set-learning-progress', f.request({ progress: 'read' }));
  const final = f.state(), execution = executionPart(final), certificate = f.snapshot().proof.certificate.id;
  assert.equal(f.service.learningObject('qa-stages', 'job', started.jobId).status, 'running');
  await f.finish();
  assert.equal(f.service.learningObject('qa-stages', 'job', started.jobId).status, 'ready');
  assert.deepEqual(executionPart(f.state()), execution);
  assert.deepEqual(f.state().learning.progress, final.learning.progress);
  assert.deepEqual(f.state().learning.captures, final.learning.captures);
  assert.equal(f.state().learning.finalMaterialHash, final.learning.finalMaterialHash);
  assert.equal(f.snapshot().proof.certificate.id, certificate);
  assert.equal(f.state().learning.progress[f.materialHash], 'read');
  assert.equal(f.observations(), '[1,1]\n[1,2]\n');
});

test('policy revoked during preparation creates no job; a forged parsed output cannot be published ready', async t => {
  const f = await jobsFixture(t), before = hashObject(f.state());
  f.runtime.preparationGate = deferred();
  const pending = f.service.command('qa-stages', 'generate-lesson', f.request());
  await tick();
  f.runtime.policy = { denyGlobs: ['alpha.json'], outputPaths: ['out'], forbiddenPaths: [] };
  f.runtime.preparationGate.resolve();
  await assert.rejects(pending, { code: 'LEARNING_SOURCE_DENIED' });
  assert.equal(hashObject(f.state()), before); assert.equal(f.counts.execute, 0);
  assert.equal(Object.keys(f.state().learning.jobs).length, 0);
  f.runtime.policy = { denyGlobs: [], outputPaths: ['out'], forbiddenPaths: [] }; f.runtime.preparationGate = null;
  const started = await f.service.command('qa-stages', 'generate-lesson', f.request()); await tick();
  const handle = f.handles.at(-1), execution = executionPart(f.state());
  f.runtime.forgedOutput = { ...structuredClone(handle.lesson), version: 1, materialHash: handle.materialHash, methodHash: handle.methodHash };
  f.runtime.forgedOutput.steps[0].anchors[0].quote = 'NOT_THE_SAVED_SOURCE';
  await f.finish();
  const failed = f.service.learningObject('qa-stages', 'job', started.jobId);
  assert.equal(failed.status, 'failed'); assert.equal(failed.result, null); assert.equal(failed.error.code, 'LEARNING_ANCHOR_INVALID');
  assert.deepEqual(executionPart(f.state()), execution);
  assert.equal(f.counts.execute, 1);
});

test('reopened running history never replays inference; unknown stop stays uncertain, confirmed stop fails the job, and drift only closes execution', async t => {
  const f = await jobsFixture(t);
  const started = await f.service.command('qa-stages', 'generate-lesson', f.request()); await tick();
  const running = readLearningJobs(f.service.store, f.state()).find(({ job }) => job.id === started.jobId).job;
  assert.ok(running.process);
  const cloneRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-qa-job-reopen-')));
  cpSync(f.root, cloneRoot, { recursive: true });
  const secure = directory => {
    chmodSync(directory, 0o700);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name); if (entry.isDirectory()) secure(file); else chmodSync(file, 0o600);
    }
  };
  secure(path.join(cloneRoot, '.ai-orchestrator'));
  let reopened;
  t.after(() => { reopened?.close(); rmSync(cloneRoot, { recursive: true, force: true }); });
  const counts = { ...f.counts }, execution = executionPart(f.state());
  const adapters = { ...f.adapters, identity: () => hashObject('runtime-updated'), ownerIdentity: () => hashObject('new-service-owner'),
    inspectProcess: async metadata => { assert.deepEqual(metadata, running.process); return { stopped: false, uncertain: true }; } };
  reopened = await WorkflowService.open({ root: cloneRoot, adapters });
  assert.equal(reopened.learningObject('qa-stages', 'job', started.jobId).status, 'uncertain');
  const snapshot = reopened.snapshot('qa-stages');
  assert.equal(snapshot.integrity.valid, false);
  assert.equal(snapshot.capabilities.openLearning.allowed, true);
  assert.equal(snapshot.capabilities.run.allowed, false);
  const stable = hashObject(reopened.store.readRun('qa-stages'));
  reopened.snapshot('qa-stages'); reopened.learningMaterial('qa-stages', f.materialHash);
  assert.equal(hashObject(reopened.store.readRun('qa-stages')), stable);
  await assert.rejects(reopened.command('qa-stages', 'generate-lesson', request(snapshot, { materialHash: f.materialHash })), { code: 'CONTROL_DENIED' });
  assert.equal(reopened.close(), true);
  reopened = await WorkflowService.open({ root: cloneRoot, adapters: { ...adapters, ownerIdentity: () => hashObject('another-service-owner'),
    inspectProcess: async metadata => { assert.deepEqual(metadata, running.process); return { stopped: true, uncertain: false, result: { exitCode: 1 } }; } } });
  const interrupted = reopened.learningObject('qa-stages', 'job', started.jobId);
  assert.equal(interrupted.status, 'failed'); assert.equal(interrupted.error.code, 'LEARNING_INTERRUPTED');
  assert.deepEqual(executionPart(reopened.store.readRun('qa-stages')), execution);
  assert.deepEqual(f.counts, counts, 'Reopen must not prepare/execute/dispose the original job or recover paid inference');
});
