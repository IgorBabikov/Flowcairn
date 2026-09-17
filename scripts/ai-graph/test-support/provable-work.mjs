import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkflowService } from '../lib/service.mjs';
import { hashObject, sha256 } from '../lib/io.mjs';
import { SKILL_ROUTES } from '../lib/config.mjs';

export const identity = hashObject('provable-work-runtime');
const title = 'Функция answer возвращает 42';
const assertion = 'assert.equal(answer(), 42);';
const skills = [...new Set(Object.values(SKILL_ROUTES).flat())].map((id) => ({ id, path: `skills/${id}/SKILL.md`, hash: identity }));
export const request = (snapshot, extra = {}) => ({ operationId: `op-${randomUUID()}`, expectedRevision: snapshot.revision, planHash: snapshot.planHash, ...extra });

export async function fixture(t, { repair = false, method = 'check', missingAssessment = false, badCitation = false, reviewFailures = 0 } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flowcairn-proof-e2e-'));
  const worktree = path.join(root, '.ai-orchestrator', 'worktrees', 'proof-1');
  mkdirSync(path.join(worktree, 'src'), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(worktree, 'src/answer.mjs'), 'export const answer = () => 0;\n');
  writeFileSync(path.join(worktree, 'src/answer.test.mjs'), `import assert from 'node:assert/strict';\nimport { answer } from './answer.mjs';\n${assertion}\n`);
  const fingerprint = () => {
    const files = ['src/answer.mjs', 'src/answer.test.mjs'].map((file) => {
      const bytes = readFileSync(path.join(worktree, file));
      return { path: file, hash: sha256(bytes), size: bytes.length, mode: '100644' };
    });
    return { hash: hashObject(files), files, git: { head: 'a'.repeat(40), indexHash: identity } };
  };
  const changes = (before, after) => ({ allowed: true, changedFiles: after.files.filter((file) => before.files.find((old) => old.path === file.path)?.hash !== file.hash).map((file) => file.path) });
  let implementationCalls = 0, actualChecks = 0;
  const actualCheckExitCodes = [];
  const baseOutput = { summary: 'Обработано', verdict: 'pass', skillsUsed: [], findings: [], changedFiles: [], edits: [], plan: [] };
  const adapters = {
    identity: () => identity, skills: () => skills, hasReadConsent: () => true,
    projectSummary: () => ({ schemaVersion: 2, name: 'Проверка настоящего runtime', contextHash: identity, contextPaths: [], scopeCandidates: ['src'], checks: ['tests'],
      ai: { provider: 'deterministic-test', model: 'injected fixture' }, capabilities: { intake: { allowed: false, reason: 'Изолированная проверка runtime' } } }),
    capture: () => ({ manifest: { sourceHash: fingerprint().hash }, bundlePath: 'fixture-source' }),
    allocate: ({ task, runId }) => ({ worktree, taskId: task.id, attemptId: 1, leaseId: 'fixture', sourceHash: fingerprint().hash, runId }),
    verifyBinding: () => true, replaceBinding: ({ binding, newRunId, sourceHash }) => ({ ...binding, runId: newRunId, sourceHash }),
    fingerprint, inspectChanges: changes,
    applyEdits: (_root, _before, _node, _task, edits) => { for (const edit of edits) writeFileSync(path.join(worktree, edit.path), edit.content); },
    diff: (_root, before, after) => ({ content: before.hash === after.hash ? '' : '--- a/src/answer.mjs\n+++ b/src/answer.mjs\n+export const answer = () => 42;', complete: true }),
    runner: { ai: { available: true }, checks: { available: true } },
    loadSkills: (ids) => ids.map((name) => ({ name, text: 'fixture', hash: identity, path: `skills/${name}/SKILL.md` })),
    execute: async ({ node, onStart, reviewEvidence, plan }) => {
      await onStart({ ticket: 'fixture', pid: process.pid });
      if (node.action.id === 'check-tests') {
        actualChecks++;
        // Node's outer test runner marker makes a nested --test silently skip files with exit 0.
        const env = { ...process.env };
        delete env.NODE_TEST_CONTEXT;
        const result = spawnSync(process.execPath, ['--test', 'src/answer.test.mjs'], { cwd: worktree, env, encoding: 'utf8', timeout: 10000 });
        assert.equal(result.error, undefined);
        actualCheckExitCodes.push(result.status);
        return { exitCode: result.status, stopped: true, uncertain: false };
      }
      const output = { ...baseOutput, skillsUsed: node.skills };
      if (node.action.id === 'ai-analyze') output.analysis = { requirements: [title], constraints: [], projectFacts: [{ path: 'src/answer.mjs', fact: 'Экспортируется answer' }], acceptance: [title], risks: [] };
      if (node.action.id === 'ai-plan') {
        output.steps = [{ id: 'answer', title, outcome: title, needs: [], paths: ['src/answer.mjs'], requirementIds: ['req-001'] }];
        output.contractProposal = { requirements: [{ id: 'req-001', title, mandatory: true,
          verification: { method, checkIds: method === 'check' ? ['check-tests'] : [], criterion: title, paths: ['src/answer.test.mjs'] } }],
          optionalImprovements: [], constraints: [], assumptions: [], unknowns: [] };
      }
      if (node.action.id === 'ai-implement') {
        const value = repair && implementationCalls++ === 0 ? 41 : 42;
        const content = `export const answer = () => ${value};\n`;
        if (readFileSync(path.join(worktree, 'src/answer.mjs'), 'utf8') !== content) {
          output.changedFiles = ['src/answer.mjs'];
          output.edits = [{ path: 'src/answer.mjs', previousHash: fingerprint().files[0].hash, content, executable: false }];
        }
      }
      if (node.action.id === 'ai-review') {
        output.reviewEvidenceHash = hashObject(reviewEvidence);
        if (method !== 'human' && !missingAssessment) output.requirementAssessments = plan.taskContract.requirements.map((item) => ({
          requirementId: item.id, criterion: item.verification.criterion, checkIds: item.verification.checkIds,
          verdict: reviewFailures-- > 0 ? 'fail' : 'pass', reason: 'Реальная зарегистрированная проверка исполнила assertion для answer',
          citations: [{ path: 'src/answer.test.mjs', startLine: 3, quote: badCitation ? 'assert.equal(answer(), 999);' : assertion }],
        }));
      }
      return { exitCode: 0, stopped: true, uncertain: false, output };
    },
  };
  let service = await WorkflowService.open({ root, adapters });
  t.after(async () => { await Promise.all([...service.drives.values()]); service.close(); rmSync(root, { recursive: true, force: true }); });
  const settle = async (snapshot) => {
    for (let i = 0; i < 12; i++) {
      await Promise.all([...service.drives.values()]);
      snapshot = service.snapshot(snapshot.runId);
      if (snapshot.successorRunId) { snapshot = service.snapshot(snapshot.successorRunId); continue; }
      return snapshot;
    }
    throw new Error('Task did not settle');
  };
  const run = async () => {
    let snapshot = await service.create({ id: 'TASK-PROOF', goal: title, instructions: title, acceptance: [title], scope: ['src'], checks: ['tests'] },
      { runId: 'proof-task', operationId: 'create-proof', stage: 'planning', workflow: 'autonomous' });
    snapshot = await service.command(snapshot.runId, 'run', request(snapshot));
    snapshot = await service.command(snapshot.runId, 'replan', request(snapshot));
    const gate = snapshot.gates.find((item) => item.type === 'approve-plan');
    snapshot = await service.command(snapshot.runId, 'gate', request(snapshot, { nodeId: gate.nodeId, decision: 'approve', permissions: gate.requiredPermissions, challenge: gate.challenge }));
    return settle(snapshot);
  };
  return { run, settle, root, worktree, fingerprint, checks: () => actualChecks, checkExitCodes: () => [...actualCheckExitCodes], get service() { return service; },
    restart: async () => { assert.equal(service.close(), true); service = await WorkflowService.open({ root, adapters }); return service; } };
}
