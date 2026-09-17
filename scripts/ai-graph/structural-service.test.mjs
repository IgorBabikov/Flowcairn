import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkflowService } from './lib/service.mjs';
import { captureBeforeContents, buildAttemptDiff } from './lib/artifacts.mjs';
import { applyProposedEdits } from './lib/patch.mjs';
import { fingerprintWorkspace, inspectWorkspaceChanges } from './lib/workspace.mjs';
import { validateReviewEvidence } from './lib/review-evidence.mjs';
import { CHANGE_EVIDENCE_FORMAT, validateChangeEvidence } from './lib/change-evidence.mjs';
import { hashObject, sha256 } from './lib/io.mjs';
import { SKILL_ROUTES } from './lib/config.mjs';

const runtimeHash = hashObject('synthetic-structural-runtime');
const goal = 'Перенести большие JSON без изменения значений и удалить устаревший файл';
const request = (snapshot, extra = {}) => ({ operationId: `op-${randomUUID()}`, expectedRevision: snapshot.revision, planHash: snapshot.planHash, ...extra });

async function fixture(t, { malformed = false } = {}) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-structural-service-')));
  const worktree = path.join(root, '.ai-orchestrator', 'worktrees', 'fixture');
  mkdirSync(path.join(worktree, 'src'), { recursive: true, mode: 0o700 });
  execFileSync('/usr/bin/git', ['init', '-b', 'fixture'], { cwd: worktree, stdio: 'ignore' });
  const large = `{"keep":"${'unchanged-'.repeat(18000)}","greeting":"Hello {name}","precise":9007199254740993,"nested":{"count > 1":"Many","true":"One"}}\n`;
  const movable = JSON.stringify({ padding: 'move-'.repeat(220000) });
  const obsolete = JSON.stringify({ obsolete: 'delete-'.repeat(170000) });
  for (const [file, content] of [['base.json', large], ['move.json', movable], ['obsolete.json', obsolete]]) writeFileSync(path.join(worktree, 'src', file), content);
  const assertionLines = [
    "import assert from 'node:assert/strict';",
    "import { existsSync, readFileSync } from 'node:fs';",
    "import { createHash } from 'node:crypto';",
    "const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');",
    "const base = JSON.parse(read('./base.json'));",
    "assert.equal(existsSync(new URL('./move.json', import.meta.url)), false);",
    "assert.equal(existsSync(new URL('./obsolete.json', import.meta.url)), false);",
    `assert.equal(createHash('sha256').update(read('./moved.json')).digest('hex'), '${sha256(movable)}');`,
    `assert.equal(createHash('sha256').update(base.keep).digest('hex'), '${sha256('unchanged-'.repeat(18000))}');`,
    "assert.deepEqual(Object.keys(base), ['keep']);",
    "assert.equal(JSON.parse(read('./modules/first.json')).greeting, 'Hello {name}');",
    "assert.match(read('./modules/first.json'), /\"precise\": 9007199254740993(?:,|\\s*})/);",
    "assert.deepEqual(JSON.parse(read('./modules/second.json')).nested, { 'count > 1': 'Many', true: 'One' });",
  ];
  writeFileSync(path.join(worktree, 'src/verify.test.mjs'), assertionLines.join('\n') + '\n');
  const original = fingerprintWorkspace(worktree);
  const skills = [...new Set(Object.values(SKILL_ROUTES).flat())].map((id) => ({ id, path: `skills/${id}/SKILL.md`, hash: runtimeHash }));
  const checks = [], reviews = [];
  const adapters = {
    identity: () => runtimeHash, skills: () => skills, hasReadConsent: () => true,
    capture: () => ({ manifest: { sourceHash: fingerprintWorkspace(worktree).hash }, bundlePath: 'synthetic-source' }),
    allocate: ({ task, runId }) => ({ worktree, taskId: task.id, attemptId: 1, leaseId: 'synthetic-lease', sourceHash: fingerprintWorkspace(worktree).hash, runId }),
    verifyBinding: () => true,
    replaceBinding: ({ binding, newRunId, sourceHash }) => ({ ...binding, runId: newRunId, sourceHash }),
    fingerprint: (directory) => fingerprintWorkspace(directory), inspectChanges: inspectWorkspaceChanges,
    applyEdits: applyProposedEdits, captureBefore: captureBeforeContents, diff: buildAttemptDiff,
    runner: { ai: { available: true }, checks: { available: true } },
    loadSkills: (ids) => ids.map((name) => ({ name, text: 'Synthetic test instruction', hash: runtimeHash, path: `skills/${name}/SKILL.md` })),
    execute: async ({ node, onStart, task, plan, reviewEvidence }) => {
      await onStart({ ticket: 'synthetic-process', pid: process.pid });
      if (node.action.id === 'check-tests') {
        const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
        const result = spawnSync(process.execPath, ['--test', 'src/verify.test.mjs'], { cwd: worktree, env, encoding: 'utf8', timeout: 10000 });
        assert.equal(result.error, undefined); checks.push(result.status);
        return { exitCode: result.status, stopped: true, uncertain: false };
      }
      const output = { summary: 'Синтетический результат', verdict: 'pass', skillsUsed: node.skills, findings: [], changedFiles: [], edits: [], moves: [], jsonTransfers: [], plan: [] };
      if (node.action.id === 'ai-analyze') output.analysis = { requirements: [goal], constraints: [], projectFacts: [{ path: 'src/base.json', fact: 'Есть большой JSON object' }], acceptance: [goal], risks: [] };
      if (node.action.id === 'ai-plan') {
        output.steps = [{ id: 'migrate', title: goal, outcome: goal, needs: [], paths: ['src'], requirementIds: ['req-001'] }];
        output.contractProposal = { requirements: [{ id: 'req-001', title: goal, mandatory: true,
          verification: { method: 'check', checkIds: ['check-tests'], criterion: goal, paths: ['src/verify.test.mjs'] } }], optionalImprovements: [], constraints: [], assumptions: [], unknowns: [] };
      }
      if (node.action.id === 'ai-implement') {
        const files = new Map(fingerprintWorkspace(worktree).files.map((file) => [file.path, file]));
        output.moves = [{ from: 'src/move.json', to: 'src/moved.json', previousHash: files.get('src/move.json').hash }];
        output.edits = [{ path: 'src/obsolete.json', previousHash: files.get('src/obsolete.json').hash, content: null, executable: false }];
        output.jsonTransfers = [
          { from: 'src/base.json', to: 'src/modules/first.json', previousHash: files.get('src/base.json').hash, targetPreviousHash: null, keys: ['greeting', 'precise'] },
          { from: 'src/base.json', to: 'src/modules/second.json', previousHash: files.get('src/base.json').hash, targetPreviousHash: null, keys: [malformed ? 'absent-key' : 'nested'] },
        ];
        // One source participates in two transfers, but changedFiles is a set of actual paths.
        output.changedFiles = ['src/base.json', 'src/modules/first.json', 'src/modules/second.json', 'src/move.json', 'src/moved.json', 'src/obsolete.json'];
      }
      if (node.action.id === 'ai-review') {
        const verified = validateReviewEvidence(JSON.parse(JSON.stringify(reviewEvidence)), { node, task, plan });
        reviews.push({ bundle: structuredClone(reviewEvidence), node, task, plan, verified });
        output.reviewEvidenceHash = verified.hash;
        output.requirementAssessments = [{ requirementId: 'req-001', verdict: 'pass', criterion: goal, checkIds: ['check-tests'],
          citations: [{ path: 'src/verify.test.mjs', startLine: 6, quote: assertionLines.slice(5).join('\n') }], reason: 'Проверены реальные файлы, отсутствие удаленных источников и точные перенесенные значения' }];
      }
      return { exitCode: 0, stopped: true, uncertain: false, output };
    },
  };
  const service = await WorkflowService.open({ root, adapters });
  t.after(async () => { await Promise.all([...service.drives.values()]); service.close(); rmSync(root, { recursive: true, force: true }); });
  const run = async () => {
    let result = await service.create({ id: 'SYNTHETIC-STRUCTURAL', goal, instructions: goal, acceptance: [goal], scope: ['src'], checks: ['tests'] },
      { runId: 'structural-fixture', operationId: 'create-structural', stage: 'planning', workflow: 'autonomous' });
    result = await service.command(result.runId, 'run', request(result));
    assert.equal(result.status, 'passed', JSON.stringify({ failure: result.failureReason, nodes: result.nodes.map((node) => ({ id: node.id, status: node.status, reason: node.reason })) }));
    result = await service.command(result.runId, 'replan', request(result));
    const gate = result.gates.find((item) => item.type === 'approve-plan');
    assert.ok(gate, JSON.stringify({ status: result.status, failure: result.failureReason }));
    result = await service.command(result.runId, 'gate', request(result, { nodeId: gate.nodeId, decision: 'approve', permissions: gate.requiredPermissions, challenge: gate.challenge }));
    for (let turn = 0; turn < 8; turn++) {
      await Promise.all([...service.drives.values()]); result = service.snapshot(result.runId);
      if (!result.successorRunId) return result;
      result = service.snapshot(result.successorRunId);
    }
    throw new Error('Synthetic task did not settle');
  };
  return { service, worktree, original, movable, obsolete, checks, reviews, run };
}

test('WorkflowService wires large moves, shared-source JSON transfers and deletion into real checks and full typed review', async (t) => {
  const f = await fixture(t); const result = await f.run();
  assert.equal(result.proof.status, 'PROVEN', JSON.stringify(result.proof.blockers));
  assert.deepEqual(f.checks, [0]); assert.equal(f.reviews.length, 1);
  assert.equal(readFileSync(path.join(f.worktree, 'src/moved.json'), 'utf8'), f.movable);
  assert.equal(existsSync(path.join(f.worktree, 'src/move.json')), false);
  assert.equal(existsSync(path.join(f.worktree, 'src/obsolete.json')), false);
  assert.match(readFileSync(path.join(f.worktree, 'src/modules/first.json'), 'utf8'), /9007199254740993/);
  const implementation = result.nodes.find((node) => node.action.id === 'ai-implement');
  assert.equal(implementation.status, 'passed');
  assert.equal(implementation.changedFiles.length, 6); assert.equal(new Set(implementation.changedFiles).size, 6);
  const receipt = f.service.receipt(result.runId, implementation.receiptIds.at(-1));
  const diff = f.service.artifact(result.runId, implementation.artifacts.find((item) => item.kind === 'diff').id);
  const changed = JSON.parse(f.service.artifact(result.runId, implementation.artifacts.find((item) => item.kind === 'changed-files').id).content);
  assert.equal(diff.mediaType, 'application/json'); assert.equal(changed.format, CHANGE_EVIDENCE_FORMAT);
  const report = validateChangeEvidence(diff.content, { changedFiles: receipt.changedFiles, beforeFingerprint: receipt.beforeFingerprint, afterFingerprint: receipt.afterFingerprint });
  assert.ok(Buffer.byteLength(diff.content) < 32 * 1024);
  assert.equal(report.operations.some((item) => item.kind === 'move' && item.before.hash === sha256(f.movable)), true);
  assert.equal(report.operations.some((item) => item.kind === 'delete' && item.before.hash === sha256(f.obsolete)), true);
  const delta = report.operations.find((item) => item.kind === 'json-entries');
  assert.equal(delta.removed.find((item) => item.key === 'precise').value, '9007199254740993');
  const review = f.reviews[0];
  assert.equal(review.verified.hash, hashObject(review.bundle));
  assert.ok(review.verified.bytes < 512 * 1024);
  const tampered = structuredClone(review.bundle); tampered.implementations[0].diff.artifact.content += ' ';
  assert.throws(() => validateReviewEvidence(tampered, review), (error) => error.code === 'REVIEW_EVIDENCE_INVALID');
  writeFileSync(path.join(f.worktree, 'src/moved.json'), f.movable + ' ');
  const stale = f.service.snapshot(result.runId);
  assert.equal(stale.proof.status, 'STALE'); assert.equal(stale.proof.certificate, null);
});

test('malformed JSON transfer prevents every filesystem effect and never reaches checks or a confirmed result', async (t) => {
  const f = await fixture(t, { malformed: true }); const result = await f.run();
  assert.equal(result.status, 'failed'); assert.notEqual(result.proof.status, 'PROVEN'); assert.equal(result.proof.certificate, null);
  assert.deepEqual(f.checks, []); assert.deepEqual(f.reviews, []);
  assert.equal(fingerprintWorkspace(f.worktree).hash, f.original.hash);
  assert.equal(readFileSync(path.join(f.worktree, 'src/move.json'), 'utf8'), f.movable);
  assert.equal(readFileSync(path.join(f.worktree, 'src/obsolete.json'), 'utf8'), f.obsolete);
  assert.equal(existsSync(path.join(f.worktree, 'src/modules')), false);
  assert.equal(existsSync(path.join(f.worktree, 'src/moved.json')), false);
  assert.match(result.nodes.find((node) => node.action.id === 'ai-implement').reason, /PATCH_DENIED/);
});
