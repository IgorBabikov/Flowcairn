import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
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
  const adapters = { dataVersion: 3, project: profile, identity: () => identity, skills: () => skills,
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
  return { root, calls, beforeEffects, create, settle, plan: service.plan('qa-stages'),
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

test('hold survives reopen and mode change; direct commands cannot bypass it and exact Continue replay after completion is inert', async t => {
  const f = await fixture(t); await f.approve();
  const held = f.state(), hold = held.continuation, second = f.plan.executionStages.stages[1].implementationNodeIds[0];
  assert.equal(hold.kind, 'learning-hold'); assert.equal(f.observations(), '[1,1]\n');
  await f.reopen();
  const beforeReads = hashObject(f.state()), calls = [...f.calls];
  for (let i = 0; i < 3; i++) {
    f.snapshot();
    const material = f.service.learningMaterial('qa-stages', hold.materialHash);
    const source = material.sources.find(item => item.path === 'alpha.json' && item.role === 'after');
    assert.equal(f.service.learningSource('qa-stages', hold.materialHash, source.id).text, '1\n');
  }
  assert.equal(hashObject(f.state()), beforeReads); assert.deepEqual(f.calls, calls);
  await f.service.command('qa-stages', 'set-learning-mode', request(f.snapshot(), { mode: 'after-task' }));
  assert.deepEqual(f.state().continuation, hold);
  for (const [command, extra] of [['run', {}], ['run', { nodeId: second }],
    ['rerun-check', { nodeId: f.plan.executionStages.stages[0].checkNodeIds[0] }]])
    await assert.rejects(f.service.command('qa-stages', command, request(f.snapshot(), extra)));
  assert.equal(f.state().nodes[second].attempts, 0);
  const continuation = request(f.snapshot(), { holdId: hold.holdId, disposition: 'defer' });
  await f.service.command('qa-stages', 'continue-learning', continuation); await f.settle();
  assert.equal(f.snapshot().proof.status, 'PROVEN'); assert.equal(f.observations(), '[1,1]\n[1,2]\n');
  assert.equal(f.state().learning.progress[hold.materialHash], 'deferred');
  const finished = hashObject(f.state()); await f.reopen();
  await f.service.command('qa-stages', 'continue-learning', continuation); await f.settle();
  assert.equal(hashObject(f.state()), finished); assert.equal(f.observations(), '[1,1]\n[1,2]\n');
  assert.equal(f.beforeEffects.length, 2);
});

test('source-stale hold denies Continue; successor reads trusted ancestor material but an unrelated run cannot', async t => {
  const f = await fixture(t); await f.approve();
  const hold = f.state().continuation, continuation = request(f.snapshot(), { holdId: hold.holdId, disposition: 'continue' });
  writeFileSync(path.join(f.root, 'beta.json'), '3\n');
  await assert.rejects(f.service.command('qa-stages', 'continue-learning', continuation), { code: 'WORKSPACE_DRIFT' });
  assert.deepEqual(f.state().continuation, hold); assert.equal(f.observations(), '[1,1]\n');
  const successor = await f.service.command('qa-stages', 'replan', request(f.snapshot())); await f.settle();
  const other = await f.create('QA-UNRELATED', 'qa-unrelated');
  const before = hashObject(f.service.store.listRunIds().map(id => f.service.store.readRun(id)));
  const material = f.service.learningMaterial(successor.runId, hold.materialHash);
  assert.equal(material.material.runId, 'qa-stages');
  assert.notEqual(material.material.planHash, successor.planHash);
  const source = material.sources.find(item => item.path === 'beta.json' && item.role === 'context');
  assert.equal(f.service.learningSource(successor.runId, hold.materialHash, source.id).text, '1\n');
  assert.throws(() => f.service.learningMaterial(other.runId, hold.materialHash), { code: 'LEARNING_MATERIAL_DENIED' });
  assert.throws(() => f.service.learningSource(other.runId, hold.materialHash, source.id), { code: 'LEARNING_MATERIAL_DENIED' });
  assert.equal(hashObject(f.service.store.listRunIds().map(id => f.service.store.readRun(id))), before);
  assert.equal(f.observations(), '[1,1]\n');
});

test('after-task final PROVEN uses final checks while intermediate result and source bytes remain historical', async t => {
  const f = await fixture(t, { mode: 'after-task' }); await f.approve();
  const snapshot = f.snapshot(), state = f.state(), stages = f.plan.executionStages.stages;
  assert.equal(snapshot.proof.status, 'PROVEN', JSON.stringify(snapshot.proof));
  assert.equal(f.observations(), '[1,1]\n[1,2]\n');
  assert.ok(f.service.store.history('qa-stages', { limit: 1000 }).every(item => item.continuation.kind === 'open'));
  const first = f.service.learningMaterial('qa-stages', state.learning.stages[stages[0].id].materialHash);
  const final = f.service.learningMaterial('qa-stages', state.learning.finalMaterialHash);
  assert.notEqual(first.material.resultHash, final.material.resultHash);
  assert.equal(final.material.resultHash, state.workspaceFingerprint.hash);
  assert.equal(final.material.kind, 'task');
  const source = final.sources.find(item => item.path === 'beta.json' && item.role === 'after');
  assert.equal(f.service.learningSource('qa-stages', final.id, source.id).text, '2\n');
  assert.equal(first.freshness.state, 'stale');
  const intermediateReceipt = state.nodes[stages[0].checkNodeIds[0]].receipts.at(-1);
  const finalReceipt = state.nodes[f.plan.executionStages.finalCheckNodeIds[0]].receipts.at(-1);
  assert.ok(snapshot.proof.certificate.receiptIds.includes(finalReceipt));
  assert.ok(!snapshot.proof.certificate.receiptIds.includes(intermediateReceipt));
  assert.equal(snapshot.learning.stages[0].status, 'verified');
  assert.equal(snapshot.learning.stages[0].freshness, 'stale');
});

test('unsafe source identity before capture blocks the effect; missing context permits only explicitly partial materials', async t => {
  const unsafe = await fixture(t, { unsafeBefore: true }); await unsafe.approve();
  assert.equal(unsafe.state().learning.failure.code, 'LEARNING_CAPTURE_UNAVAILABLE');
  assert.equal(unsafe.beforeEffects.length, 0); assert.equal(unsafe.observations(), '');
  assert.equal(unsafe.calls.length, 0, 'No injected AI or real check may start after unsafe before capture');
  const firstCapture = Object.values(unsafe.state().learning.captures)[0].before;
  assert.ok(firstCapture.gaps.some(gap => gap.code === 'capture-unavailable'));
  const ordinary = await fixture(t, { mode: 'after-task', partial: true }); await ordinary.approve();
  assert.equal(ordinary.snapshot().proof.status, 'PROVEN');
  assert.equal(ordinary.observations(), '[1,1]\n[1,2]\n');
  for (const id of [ordinary.state().learning.finalMaterialHash, ...Object.values(ordinary.state().learning.stages).map(stage => stage.materialHash)]) {
    const material = ordinary.service.learningMaterial('qa-stages', id).material;
    assert.equal(material.status, 'partial');
    assert.ok(material.gaps.some(gap => gap.code === 'missing-context'));
  }
});

test('an expired hold cannot be continued after reopen and refusal leaves state and effects unchanged', async t => {
  const f = await fixture(t); await f.approve(); await f.reopen();
  const snapshot = f.snapshot(), hold = f.state().continuation;
  const continuation = request(snapshot, { holdId: hold.holdId, disposition: 'continue' });
  const before = hashObject(f.state()), calls = [...f.calls];
  t.mock.method(Date, 'now', () => snapshot.approvalExpiresAt + 1000);
  await assert.rejects(f.service.command('qa-stages', 'continue-learning', continuation), { code: 'CONTROL_DENIED' });
  await f.settle();
  assert.equal(hashObject(f.state()), before); assert.deepEqual(f.calls, calls);
  assert.equal(f.observations(), '[1,1]\n');
});
