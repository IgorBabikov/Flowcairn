// TEST ONLY. Synthetic AI responses; real service, store, patch, checks and receipts.
// Never imported by the viewer build or shipped to npm.
import { randomUUID, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { WorkflowService } from '../../../scripts/ai-graph/lib/service.mjs';
import { SKILL_ROUTES } from '../../../scripts/ai-graph/lib/config.mjs';
import { hashObject, sha256 } from '../../../scripts/ai-graph/lib/io.mjs';
import { captureBeforeContents, buildAttemptDiff } from '../../../scripts/ai-graph/lib/artifacts.mjs';
import { applyProposedEdits } from '../../../scripts/ai-graph/lib/patch.mjs';
import { inspectDirectChanges } from '../../../scripts/ai-graph/lib/direct-fingerprint.mjs';
import { fingerprintDirectWorkspace } from '../../../scripts/ai-graph/lib/direct-workspace.mjs';
import { inspectProjectChecks, checkProfileSummary } from '../../../scripts/ai-graph/lib/check-profile.mjs';
import { ProjectProfileSchema, trustedLocalChecksHash } from '../../../scripts/ai-graph/lib/project.mjs';
import { prepareToolchain, verifyToolchain } from '../../../scripts/ai-graph/lib/toolchain.mjs';
import { runRegisteredAction } from '../../../scripts/ai-graph/lib/runner.mjs';
import { validateReviewEvidence } from '../../../scripts/ai-graph/lib/review-evidence.mjs';
import { startViewer } from '../server.mjs';

export const guildGoal = 'Сохранить счетчик равным двум';
export const guildInstruction = 'В counter.json сохранить число 2. Проверить verify.mjs.';
const skillText = 'TEST ONLY: deterministic guild fixture skill';
const identity = sha256(skillText);
const skills = [...new Set(Object.values(SKILL_ROUTES).flat())].map(id => ({ id, path: `skills/${id}/SKILL.md`, hash: identity }));
export const guildRequest = (snapshot, extra = {}) => ({ operationId: `guild-${randomUUID()}`, expectedRevision: snapshot.revision, planHash: snapshot.planHash, ...extra });

/** Holding the adapter response keeps real activeOperation/process receipts visible. */
export async function createGuildFixture({ repair = false, hold = false, dist = process.env.FLOWCAIRN_GUILD_DIST, port = 0 } = {}) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-guild-test-only-')));
  writeFileSync(path.join(root, 'counter.json'), '0\n');
  const assertion = 'assert.equal(JSON.parse(readFileSync("counter.json", "utf8")), 2);';
  writeFileSync(path.join(root, 'verify.mjs'), `import assert from 'node:assert/strict';\nimport { readFileSync, appendFileSync } from 'node:fs';\n${assertion}\nappendFileSync('out/checks.log', 'passed\\n');\n`);
  mkdirSync(path.join(root, 'out'));
  const profile = ProjectProfileSchema.parse({ version: 2, workspaceMode: 'direct', integrationBranch: 'main', contextPaths: [], manifests: [], checks: ['counter'], checkMode: 'trusted-local', outputPaths: ['out'], ai: { provider: 'codex', model: 'test-only-synthetic' },
    checkProfile: { version: 1, requiredCheckIds: ['counter'], environment: [], definitions: [{ id: 'counter', title: 'Проверить счетчик', purpose: guildGoal,
      command: { executable: process.execPath, argv: ['verify.mjs'], cwd: '.' }, inputPaths: ['verify.mjs'], outputPaths: ['out'], timeoutMs: 5000, maxOutputBytes: 65536 }] } });
  writeFileSync(path.join(root, '.flowcairn.json'), JSON.stringify(profile));
  mkdirSync(path.join(root, '.ai-orchestrator/graph/runner-tickets'), { recursive: true, mode: 0o700 });
  for (const dir of ['.ai-orchestrator', '.ai-orchestrator/graph']) chmodSync(path.join(root, dir), 0o700);
  writeFileSync(path.join(root, '.ai-orchestrator/flowcairn-install.json'), JSON.stringify({ tool: 'flowcairn', owner: `flowcairn-${randomUUID()}`, trustedLocalChecksHash: trustedLocalChecksHash(root, profile) }), { mode: 0o600 });
  const fingerprint = () => fingerprintDirectWorkspace(root, { outputPaths: profile.outputPaths });
  const contextHash = hashObject('guild-test-only-context');
  const calls = [], observations = [], waiting = new Map();
  let implementCount = 0, checkCount = 0, service, server;
  const adapters = {
    dataVersion: 3, project: profile, identity: () => identity, skills: () => skills, hasReadConsent: () => true,
    projectSummary: () => ({ schemaVersion: 3, name: 'TEST ONLY — гильдия', contextHash, sourceHash: fingerprint().hash, contextPaths: ['verify.mjs'], scopeCandidates: ['counter.json'], ...checkProfileSummary(root, profile), checkIds: ['counter'], ai: { provider: 'codex', model: 'test-only-synthetic' }, capabilities: { intake: { allowed: true, reason: null } } }),
    taskContextInventory: () => ({ sourceHash: fingerprint().hash, files: ['counter.json', 'verify.mjs'] }),
    // Only registration/source allocation is injected; all plan and execution gates are real.
    registerTask: (_root, task, options) => service.create(task, { runId: options.run, operationId: options.operation, stage: 'planning', workflow: 'autonomous', naturalIntakeHash: options.naturalIntakeHash, expectedSourceHash: options.expectedSourceHash }),
    checkRegistry: () => inspectProjectChecks(root, profile),
    capture: () => ({ manifest: { sourceHash: fingerprint().hash }, bundlePath: 'test-only-source-binding' }),
    allocate: ({ task, runId }) => ({ mode: 'direct', worktree: root, taskId: task.id, attemptId: 1, leaseId: 'test-only', sourceHash: fingerprint().hash, runId }),
    replaceBinding: ({ binding, newRunId, sourceHash }) => ({ ...binding, runId: newRunId, sourceHash }), verifyBinding: () => true,
    fingerprint, inspectChanges: inspectDirectChanges, captureBefore: captureBeforeContents, applyEdits: applyProposedEdits, diff: buildAttemptDiff,
    prepareToolchain: () => prepareToolchain({ root, worktree: root }), verifyToolchain: (worktree, manifest) => verifyToolchain({ root, worktree, manifest }),
    runner: { ai: { available: true }, checks: { available: true } },
    loadSkills: ids => ids.map(name => ({ name, text: skillText, hash: identity, path: `skills/${name}/SKILL.md` })),
    execute: async args => {
      const { node, onStart, reviewEvidence, task, plan } = args;
      const index = calls.length;
      calls.push({ nodeId: node.id, action: node.action.id, runId: args.runId ?? null, index });
      if (!node.action.id.startsWith('check-')) await onStart({ ticket: `guild-test-only-${index}`, pid: process.pid });
      if (hold) await new Promise(resolve => waiting.set(index, { action: node.action.id, nodeId: node.id, release: resolve }));
      if (node.action.id.startsWith('check-')) {
        checkCount++;
        const result = await runRegisteredAction(args);
        observations.push({ kind: 'real-node-check', exitCode: result.exitCode, value: readFileSync(path.join(root, 'counter.json'), 'utf8') });
        return result;
      }
      const output = { summary: `TEST ONLY: ${node.action.id}`, verdict: 'pass', skillsUsed: node.skills, findings: [], changedFiles: [], edits: [], plan: [] };
      if (node.action.id === 'ai-analyze') output.analysis = { requirements: [guildGoal], constraints: [], projectFacts: [{ path: 'counter.json', fact: 'Сейчас счетчик равен нулю' }], acceptance: [guildGoal], risks: [] };
      if (node.action.id === 'ai-plan') {
        output.steps = [{ id: 'counter-two', title: 'Изменить счетчик', outcome: guildGoal, paths: ['counter.json'], readPaths: ['verify.mjs'], needs: [], requirementIds: ['req-001'] }];
        output.contractProposal = { requirements: [{ id: 'req-001', title: guildGoal, mandatory: true, verification: { method: 'check', checkIds: ['check-counter'], criterion: guildGoal, paths: ['verify.mjs'] } }], optionalImprovements: [], constraints: [], assumptions: [], unknowns: [] };
      }
      if (node.action.id === 'ai-implement') {
        implementCount++;
        const value = repair && implementCount === 1 ? 1 : 2;
        output.changedFiles = ['counter.json'];
        output.edits = [{ path: 'counter.json', content: `${value}\n`, previousHash: sha256(readFileSync(path.join(root, 'counter.json'))), executable: false }];
      }
      if (node.action.id === 'ai-review') {
        output.reviewEvidenceHash = validateReviewEvidence(reviewEvidence, { node, task, plan }).hash;
        output.requirementAssessments = [{ requirementId: 'req-001', criterion: guildGoal, checkIds: ['check-counter'], verdict: 'pass', reason: 'Реальный verifier прочитал число 2', citations: [{ path: 'verify.mjs', startLine: 3, quote: assertion }] }];
      }
      return { exitCode: 0, stopped: true, uncertain: false, output };
    },
  };
  service = await WorkflowService.open({ root, adapters });
  // Suppress native account probing in this explicit fixture only; execution is unchanged.
  service.onboarding = async () => ({ configured: true, profileHash: identity, providers: [{ id: 'codex', label: 'TEST ONLY synthetic', supported: true, state: 'available', reason: null }], values: { provider: 'codex', model: 'test-only-synthetic', modelMode: 'manual', reasoningEffort: 'medium', testPolicy: 'keep', checkMode: 'trusted-local', checks: ['counter'], readConsent: true }, limitations: ['TEST ONLY. No external AI or account calls.'] });
  const token = randomBytes(24).toString('base64url');
  if (dist) {
    try { server = startViewer({ service, token, port, dist }); await once(server, 'listening'); }
    catch (error) { service.close(); rmSync(root, { recursive: true, force: true }); throw error; }
  }
  const current = () => {
    const runs = service.listRuns(), superseded = new Set(runs.map(run => service.store.readRun(run.runId).supersedesRunId));
    const leaf = runs.find(run => !superseded.has(run.runId)); return leaf ? service.snapshot(leaf.runId) : null;
  };
  const settle = async () => { for (let i = 0; i < 12 && service.drives.size; i++) await Promise.all([...service.drives.values()]); return current(); };
  return { root, service, server, token, url: server ? `http://127.0.0.1:${server.address().port}` : null, calls, observations,
    current, get counts() { return { implement: implementCount, check: checkCount }; },
    pending: () => [...waiting.entries()].map(([index, item]) => ({ index, action: item.action, nodeId: item.nodeId })),
    release: index => { const item = waiting.get(index ?? waiting.keys().next().value); if (!item) throw Error('No held fixture action'); waiting.delete(index ?? waiting.keys().next().value); item.release(); },
    settle,
    intake: () => service.intake({ title: guildGoal, description: guildInstruction, taskNumber: 'GUILD-TEST-ONLY', operationId: `intake-${randomUUID()}`, contextHash, learningMode: 'after-task' }),
    approve: async () => { const s = current(), gate = s.gates.find(item => item.type === 'approve-plan'); if (!gate) throw Error('No real plan gate'); return service.command(s.runId, 'gate', guildRequest(s, { nodeId: gate.nodeId, decision: 'approve', permissions: gate.requiredPermissions, challenge: gate.challenge })); },
    evidence: () => ({ label: 'TEST ONLY synthetic AI; actual WorkflowService/store/checks/receipts', calls, observations, snapshot: current(), history: service.listRuns().map(run => ({ runId: run.runId, states: service.store.history(run.runId, { limit: 1000 }) })) }),
    close: async () => { hold = false; for (const item of waiting.values()) item.release(); waiting.clear(); await settle(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } service.close(); rmSync(root, { recursive: true, force: true }); },
  };
}
