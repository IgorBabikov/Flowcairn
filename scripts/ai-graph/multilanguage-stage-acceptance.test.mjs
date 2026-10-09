import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SKILL_ROUTES } from './lib/config.mjs';
import { hashObject, sha256 } from './lib/io.mjs';
import { ProjectProfileSchema, trustedLocalChecksHash } from './lib/project.mjs';
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

const skillText = 'Synthetic acceptance skill', identity = sha256(skillText);
const clang = '/Library/Developer/CommandLineTools/usr/bin/clang';
const skills = [...new Set(Object.values(SKILL_ROUTES).flat())]
  .map(id => ({ id, path: `skills/${id}/SKILL.md`, hash: identity }));
const request = (snapshot, extra = {}) => ({ operationId: `op-${randomUUID()}`,
  expectedRevision: snapshot.revision, planHash: snapshot.planHash, ...extra });

function configuration(root, kind) {
  if (kind === 'c') {
    const executable = clang;
    assert.ok(existsSync(executable), 'Installed clang is required; this test does not download a toolchain.');
    return { file: 'answer.c', executable, argv: ['-fsyntax-only', 'answer.c'], inputPaths: [],
      criterion: 'Измененный C-код проходит проверку синтаксиса установленным clang',
      code: value => `int answer(void) { return ${value}; }\n`, invalid: 'int answer( { return; }\n',
      citation: text => ({ path: 'answer.c', startLine: 1, quote: text.trimEnd() }) };
  }
  if (kind === 'unknown') {
    const assertion = "if (!/^answer := [12]\\n$/.test(readFileSync('program.customlang', 'utf8'))) process.exit(7);";
    writeFileSync(path.join(root, 'verify.mjs'), `import { readFileSync } from 'node:fs';\n${assertion}\n`);
    return { file: 'program.customlang', executable: process.execPath, argv: ['verify.mjs'], inputPaths: ['verify.mjs'],
      criterion: 'Явный verifier принимает синтетическую запись answer := 1 или 2',
      code: value => `answer := ${value}\n`, invalid: 'answer := 9\n',
      citation: () => ({ path: 'verify.mjs', startLine: 2, quote: assertion }) };
  }
  const assertion = "assert namespace['value'] in (1, 2)";
  writeFileSync(path.join(root, 'verify.py'), `from pathlib import Path\nnamespace = {}\nexec(Path('answer.py').read_text(), namespace)\n${assertion}\n`);
  return { file: 'answer.py', executable: resolveCheckExecutable(root, 'python3').executable, argv: ['-B', 'verify.py'], inputPaths: ['verify.py'],
    criterion: 'Python-код задает значение 1 или 2', code: value => `value = ${value}\n`, invalid: 'value = 9\n',
    citation: () => ({ path: 'verify.py', startLine: 4, quote: assertion }) };
}

/** Adapted from stage-execution.test.mjs: real service/store/capture/checks,
 * injected AI outputs and allocation. Manual gates keep a deliberate failure
 * observable without entering an unrelated automatic repair cycle. */
async function fixture(t, kind, failSecond = false) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-multilanguage-stage-')));
  let service;
  t.after(async () => {
    if (service) { await Promise.allSettled([...service.drives.values()]); assert.equal(service.close(), true); }
    rmSync(root, { recursive: true, force: true });
  });
  const config = configuration(root, kind), checkId = `verify-${kind}`;
  writeFileSync(path.join(root, config.file), config.code(0));
  const profile = ProjectProfileSchema.parse({ version: 2, workspaceMode: 'direct', integrationBranch: 'direct', contextPaths: [],
    checks: [checkId], checkMode: 'trusted-local', outputPaths: [], manifests: [], ai: { provider: 'codex', model: 'injected' },
    checkProfile: { version: 1, requiredCheckIds: [checkId], environment: [], definitions: [{ id: checkId,
      title: `Проверка ${kind}`, purpose: config.criterion, command: { executable: config.executable, argv: config.argv, cwd: '.' },
      inputPaths: config.inputPaths, outputPaths: [], timeoutMs: 20000, maxOutputBytes: 65536 }] } });
  writeFileSync(path.join(root, '.flowcairn.json'), JSON.stringify(profile));
  mkdirSync(path.join(root, '.ai-orchestrator/graph/runner-tickets'), { recursive: true, mode: 0o700 });
  for (const name of ['.ai-orchestrator', '.ai-orchestrator/graph']) chmodSync(path.join(root, name), 0o700);
  writeFileSync(path.join(root, '.ai-orchestrator/flowcairn-install.json'), JSON.stringify({ tool: 'flowcairn',
    owner: `flowcairn-${randomUUID()}`, trustedLocalChecksHash: trustedLocalChecksHash(root, profile) }), { mode: 0o600 });
  assert.equal(existsSync(path.join(root, 'package.json')), false);
  const fingerprint = () => fingerprintDirectWorkspace(root);
  const input = { id: 'MULTILANGUAGE-STAGES', goal: config.criterion, instructions: 'Выполнить два последовательных изменения исходника.',
    scope: [config.file], contextPaths: config.inputPaths, acceptance: [config.criterion], checks: [checkId], learningMode: 'after-stage',
    limits: { maxAttempts: 1, maxReplans: 0, timeoutMs: 20000 } };
  const task = TaskSpecV3Schema.parse({ ...input, schemaVersion: 3, sourceHash: fingerprint().hash });
  const proposal = { summary: 'Два проверяемых изменения', verdict: 'pass', skillsUsed: [], findings: [], changedFiles: [], edits: [], plan: [],
    steps: [1, 2].map(value => ({ id: `change-${value}`, title: `Изменение ${value}`, outcome: config.criterion, needs: [],
      paths: [config.file], readPaths: config.inputPaths, requirementIds: ['req-001'] })),
    contractProposal: { requirements: [{ id: 'req-001', title: config.criterion, mandatory: true,
      verification: { method: 'check', checkIds: [`check-${checkId}`], criterion: config.criterion,
        paths: config.inputPaths.length ? config.inputPaths : [config.file] } }],
      optionalImprovements: [], constraints: [], assumptions: [], unknowns: [] } };
  const compiled = compileTaskProposal(task, proposal, { runtimeHash: identity, skills, checks: inspectProjectChecks(root, profile) });
  const checks = [], writes = [], calls = [];
  const adapters = { dataVersion: 3, project: profile, identity: () => identity, skills: () => skills,
    checkRegistry: () => inspectProjectChecks(root, profile),
    capture: () => ({ manifest: { sourceHash: fingerprint().hash }, bundlePath: 'synthetic-source' }),
    allocate: ({ task, runId }) => ({ mode: 'direct', worktree: root, taskId: task.id, runId, attemptId: 1,
      leaseId: 'synthetic-lease', sourceHash: fingerprint().hash }),
    verifyBinding: () => true, fingerprint, inspectChanges: inspectDirectChanges,
    prepareToolchain: () => prepareToolchain({ root, worktree: root }),
    verifyToolchain: (worktree, manifest) => verifyToolchain({ root, worktree, manifest }),
    captureBefore: captureBeforeContents, diff: buildAttemptDiff,
    applyEdits: (_worktree, _before, node, _task, edits) => {
      const state = new GraphStore(root).readRun('multi-stages');
      const stage = compiled.plan.executionStages.stages.find(stage => stage.implementationNodeIds.includes(node.id));
      assert.ok(state.learning.captures[stage.id].before.sourceCatalogHash, 'Before reference must be durable before the write.');
      writes.push(node.id);
      for (const edit of edits) writeFileSync(path.join(root, edit.path), edit.content);
    },
    runner: { ai: { available: true }, checks: { available: true } },
    loadSkills: ids => ids.map(name => ({ name, text: skillText, hash: identity, path: `skills/${name}/SKILL.md` })),
    execute: async invocation => {
      calls.push(invocation.node.id);
      if (invocation.node.action.id.startsWith('check-')) {
        const result = await runRegisteredAction(invocation);
        checks.push({ nodeId: invocation.node.id, inputHash: invocation.beforeFingerprint.hash, result });
        return result;
      }
      invocation.onStart({ pid: process.pid, ticket: 'injected-ai-output' });
      const output = { summary: 'Синтетический ответ без модели', verdict: 'pass', skillsUsed: invocation.node.skills,
        findings: [], changedFiles: [], edits: [], plan: [] };
      if (invocation.node.action.id === 'ai-implement') {
        const index = compiled.plan.executionStages.stages.findIndex(stage => stage.implementationNodeIds.includes(invocation.node.id));
        assert.equal(checks.length, index, 'Next implementation must wait for its preceding real check.');
        output.changedFiles = [config.file];
        output.edits = [{ path: config.file, previousHash: sha256(readFileSync(path.join(root, config.file))),
          content: failSecond && index === 1 ? config.invalid : config.code(index + 1), executable: false }];
      } else if (invocation.node.action.id === 'ai-review') {
        output.reviewEvidenceHash = hashObject(invocation.reviewEvidence);
        output.requirementAssessments = [{ requirementId: 'req-001', criterion: config.criterion, checkIds: [`check-${checkId}`],
          verdict: 'pass', reason: 'Обе зарегистрированные проверки завершились успешно.',
          citations: [config.citation(readFileSync(path.join(root, config.file), 'utf8'))] }];
      }
      return { exitCode: 0, stopped: true, uncertain: false, output };
    },
  };
  service = await WorkflowService.open({ root, adapters });
  await service.create(input, { runId: 'multi-stages', operationId: 'create-multi', stage: 'execution',
    draft: { nodes: compiled.plan.nodes }, taskContract: compiled.plan.taskContract });
  const snapshot = () => service.snapshot('multi-stages');
  const command = (name, extra = {}) => service.command('multi-stages', name, request(snapshot(), extra));
  const settle = () => Promise.all([...service.drives.values()]);
  const approve = snapshot().gates.find(gate => gate.type === 'approve-plan');
  await command('gate', { nodeId: approve.nodeId, decision: 'approve', permissions: approve.requiredPermissions, challenge: approve.challenge });
  await command('run');
  const first = snapshot();
  assert.equal(first.status, 'learning-hold', JSON.stringify(first));
  assert.equal(checks.length, 1); assert.equal(checks[0].result.exitCode, 0);
  assert.equal(writes.length, 1); assert.notEqual(first.proof.status, 'PROVEN');
  const firstMaterial = service.learningMaterial('multi-stages', first.continuation.materialHash);
  await command('continue-learning', { holdId: first.continuation.holdId, disposition: 'continue' });
  await settle(); await command('run');
  return { root, config, service, checks, writes, calls, first, firstMaterial, snapshot, command,
    state: () => service.store.readRun('multi-stages'), plan: service.plan('multi-stages') };
}

function verifiedChecks(fx) {
  const stageChecks = fx.plan.executionStages.stages.flatMap(stage => stage.checkNodeIds);
  assert.equal(fx.checks.length, 2); assert.equal(fx.writes.length, 2);
  const records = stageChecks.map((nodeId, index) => {
    const node = fx.state().nodes[nodeId], id = node.receipts.at(-1), receipt = fx.service.receipt('multi-stages', id);
    assert.equal(receipt.phase, 'finished'); assert.equal(receipt.beforeFingerprint, fx.checks[index].inputHash);
    assert.equal(receipt.afterFingerprint, receipt.beforeFingerprint);
    assert.equal(receipt.termination.stopped, true); assert.equal(receipt.termination.uncertain, false);
    assert.equal(receipt.termination.execution.kind, 'registered-check');
    assert.ok(receipt.termination.ticketHash); assert.equal(receipt.exitCode, fx.checks[index].result.exitCode);
    assert.equal(receipt.checks[0].inputHash, receipt.beforeFingerprint);
    return { id, receipt };
  });
  assert.notEqual(records[0].receipt.beforeFingerprint, records[1].receipt.beforeFingerprint);
  return records;
}

for (const kind of ['c', 'unknown']) test(`${kind}: two real sequential checks reach final PROVEN on the changed source`, async t => {
  if (kind === 'c' && !existsSync(clang)) { t.skip('Installed clang unavailable: C acceptance remains unverified; no SDK is installed.'); return; }
  const fx = await fixture(t, kind), records = verifiedChecks(fx);
  for (const { receipt } of records) { assert.equal(receipt.verdict, 'pass'); assert.equal(receipt.exitCode, 0); }
  const gate = fx.snapshot().gates.find(gate => gate.type === 'accept-result');
  assert.ok(gate);
  await fx.command('gate', { nodeId: gate.nodeId, decision: 'accept', challenge: gate.challenge });
  const final = fx.snapshot(), state = fx.state();
  assert.equal(final.proof.status, 'PROVEN', JSON.stringify(final.proof));
  assert.equal(final.proof.coverage.required, 1); assert.equal(final.proof.coverage.proven, 1);
  assert.ok(final.proof.certificate.receiptIds.includes(records[1].id));
  assert.equal(final.proof.certificate.receiptIds.includes(records[0].id), false);
  assert.equal(readFileSync(path.join(fx.root, fx.config.file), 'utf8'), fx.config.code(2));
  const material = fx.service.learningMaterial('multi-stages', state.learning.finalMaterialHash);
  assert.equal(material.material.kind, 'task'); assert.equal(material.material.resultHash, state.workspaceFingerprint.hash);
  assert.notEqual(material.material.resultHash, fx.firstMaterial.material.resultHash);
  const oldSource = fx.firstMaterial.sources.find(source => source.path === fx.config.file && source.role === 'after');
  assert.equal(fx.service.learningSource('multi-stages', fx.firstMaterial.id, oldSource.id).text, fx.config.code(1));
  t.diagnostic(JSON.stringify({ kind, scope: kind === 'c' ? 'C syntax via installed clang' : 'synthetic extension via explicit Node verifier',
    checks: records.map(({ id, receipt }) => ({ receiptId: id, resultHash: receipt.afterFingerprint, exitCode: receipt.exitCode })),
    proof: final.proof.status, finalMaterialHash: state.learning.finalMaterialHash }));
});

for (const kind of ['c', 'unknown', 'python']) test(`${kind}: deliberate second-stage check failure cannot produce final PROVEN`, async t => {
  if (kind === 'c' && !existsSync(clang)) { t.skip('Installed clang unavailable: C acceptance remains unverified; no SDK is installed.'); return; }
  const fx = await fixture(t, kind, true), records = verifiedChecks(fx), failed = records[1].receipt;
  assert.equal(records[0].receipt.verdict, 'pass');
  assert.equal(failed.verdict, 'fail'); assert.notEqual(failed.exitCode, 0); assert.notEqual(failed.exitCode, null);
  assert.equal(failed.checks[0].passed, false); assert.equal(fx.snapshot().status, 'failed');
  assert.equal(fx.snapshot().proof.status, 'FAILED'); assert.equal(fx.snapshot().proof.certificate, null);
  assert.equal(fx.snapshot().proof.requirements[0].status, 'failed');
  assert.equal(fx.state().learning.stages['stage-02'], undefined); assert.equal(fx.state().learning.finalMaterialHash, undefined);
  assert.equal(fx.calls.includes(fx.plan.executionStages.finalReviewNodeId), false);
  assert.equal(fx.state().nodes[fx.plan.executionStages.handoffNodeId].attempts, 0);
  assert.equal(readFileSync(path.join(fx.root, fx.config.file), 'utf8'), fx.config.invalid);
  await assert.rejects(fx.command('run'));
  assert.equal(fx.checks.length, 2, 'No implicit retry of the failed verifier.');
  t.diagnostic(JSON.stringify({ kind, resultHashes: records.map(({ receipt }) => receipt.afterFingerprint),
    exitCodes: records.map(({ receipt }) => receipt.exitCode), proof: fx.snapshot().proof.status, finalMaterial: false }));
});
