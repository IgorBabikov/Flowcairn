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
const examples = {
  answer: {
    title: 'Функция answer возвращает 42', sourcePath: 'src/answer.mjs', testPath: 'src/answer.test.mjs',
    exportedName: 'answer', initial: 'export const answer = () => 0;\n',
    passing: 'export const answer = () => 42;\n', failing: 'export const answer = () => 41;\n',
    assertion: 'assert.equal(answer(), 42);', fact: 'Экспортируется answer',
  },
  'password-reset': {
    title: 'Защитить восстановление пароля ссылкой со сроком действия',
    requirements: [
      'Действующая ссылка позволяет сбросить пароль',
      'Ссылка прекращает действовать в момент истечения срока',
      'Просроченная ссылка не позволяет сбросить пароль',
    ],
    sourcePath: 'src/reset-link.mjs', testPath: 'src/reset-link.test.mjs', exportedName: 'canUseResetLink',
    initial: 'export const canUseResetLink = () => true;\n',
    passing: 'export const canUseResetLink = ({ validUntil, now }) => now < validUntil;\n',
    failing: 'export const canUseResetLink = () => true;\n',
    assertion: [
      'assert.equal(canUseResetLink({ validUntil: 2000, now: 1999 }), true);',
      'assert.equal(canUseResetLink({ validUntil: 2000, now: 2000 }), false);',
      'assert.equal(canUseResetLink({ validUntil: 2000, now: 2001 }), false);',
    ].join('\n'),
    fact: 'Экспортируется проверка срока действия ссылки',
  },
};
const skills = [...new Set(Object.values(SKILL_ROUTES).flat())].map((id) => ({ id, path: `skills/${id}/SKILL.md`, hash: identity }));
export const request = (snapshot, extra = {}) => ({ operationId: `op-${randomUUID()}`, expectedRevision: snapshot.revision, planHash: snapshot.planHash, ...extra });

export async function fixture(t, { repair = false, method = 'check', missingAssessment = false, badCitation = false, reviewFailures = 0, example = 'answer' } = {}) {
  const sample = examples[example];
  if (!sample) throw new Error('Unknown proof test example');
  const { title, assertion, sourcePath, testPath } = sample;
  const requirements = sample.requirements ?? [title];
  const root = mkdtempSync(path.join(os.tmpdir(), 'flowcairn-proof-e2e-'));
  const worktree = path.join(root, '.ai-orchestrator', 'worktrees', 'proof-1');
  mkdirSync(path.join(worktree, 'src'), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(worktree, sourcePath), sample.initial);
  writeFileSync(path.join(worktree, testPath), `import assert from 'node:assert/strict';\nimport { ${sample.exportedName} } from './${path.basename(sourcePath)}';\n${assertion}\n`);
  const fingerprint = () => {
    const files = [sourcePath, testPath].map((file) => {
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
    diff: (_root, before, after) => ({ content: before.hash === after.hash ? '' : `--- a/${sourcePath}\n+++ b/${sourcePath}\n+${sample.passing.trim()}`, complete: true }),
    runner: { ai: { available: true }, checks: { available: true } },
    loadSkills: (ids) => ids.map((name) => ({ name, text: 'fixture', hash: identity, path: `skills/${name}/SKILL.md` })),
    execute: async ({ node, onStart, reviewEvidence, plan }) => {
      await onStart({ ticket: 'fixture', pid: process.pid });
      if (node.action.id === 'check-tests') {
        actualChecks++;
        // Node's outer test runner marker makes a nested --test silently skip files with exit 0.
        const env = { ...process.env };
        delete env.NODE_TEST_CONTEXT;
        const result = spawnSync(process.execPath, ['--test', testPath], { cwd: worktree, env, encoding: 'utf8', timeout: 10000 });
        assert.equal(result.error, undefined);
        actualCheckExitCodes.push(result.status);
        return { exitCode: result.status, stopped: true, uncertain: false };
      }
      const output = { ...baseOutput, skillsUsed: node.skills };
      if (node.action.id === 'ai-analyze') output.analysis = { requirements, constraints: [], projectFacts: [{ path: sourcePath, fact: sample.fact }], acceptance: requirements, risks: [] };
      if (node.action.id === 'ai-plan') {
        output.steps = [{ id: 'answer', title, outcome: title, needs: [], paths: [sourcePath], requirementIds: requirements.map((_, index) => `req-${String(index + 1).padStart(3, '0')}`) }];
        output.contractProposal = { requirements: requirements.map((requirement, index) => ({ id: `req-${String(index + 1).padStart(3, '0')}`, title: requirement, mandatory: true,
          verification: { method, checkIds: method === 'check' ? ['check-tests'] : [], criterion: requirement, paths: [testPath] } })),
          optionalImprovements: [], constraints: [], assumptions: [], unknowns: [] };
      }
      if (node.action.id === 'ai-implement') {
        const content = repair && implementationCalls++ === 0 ? sample.failing : sample.passing;
        if (readFileSync(path.join(worktree, sourcePath), 'utf8') !== content) {
          output.changedFiles = [sourcePath];
          output.edits = [{ path: sourcePath, previousHash: fingerprint().files[0].hash, content, executable: false }];
        }
      }
      if (node.action.id === 'ai-review') {
        output.reviewEvidenceHash = hashObject(reviewEvidence);
        if (method !== 'human' && !missingAssessment) output.requirementAssessments = plan.taskContract.requirements.map((item, index) => ({
          requirementId: item.id, criterion: item.verification.criterion, checkIds: item.verification.checkIds,
          verdict: reviewFailures-- > 0 ? 'fail' : 'pass', reason: 'Зарегистрированная проверка исполнила тестовый сценарий',
          citations: [{ path: testPath, startLine: 3 + index, quote: badCitation ? 'assert.equal(answer(), 999);' : assertion.split('\n')[index] }],
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
  const run = async ({ onPlan } = {}) => {
    let snapshot = await service.create({ id: 'TASK-PROOF', goal: title, instructions: title, acceptance: requirements, scope: ['src'], checks: ['tests'] },
      { runId: 'proof-task', operationId: 'create-proof', stage: 'planning', workflow: 'autonomous' });
    snapshot = await service.command(snapshot.runId, 'run', request(snapshot));
    snapshot = await service.command(snapshot.runId, 'replan', request(snapshot));
    if (onPlan) await onPlan(snapshot);
    const gate = snapshot.gates.find((item) => item.type === 'approve-plan');
    snapshot = await service.command(snapshot.runId, 'gate', request(snapshot, { nodeId: gate.nodeId, decision: 'approve', permissions: gate.requiredPermissions, challenge: gate.challenge }));
    return settle(snapshot);
  };
  return { run, settle, root, worktree, fingerprint, checks: () => actualChecks, checkExitCodes: () => [...actualCheckExitCodes], get service() { return service; },
    restart: async () => { assert.equal(service.close(), true); service = await WorkflowService.open({ root, adapters }); return service; } };
}
