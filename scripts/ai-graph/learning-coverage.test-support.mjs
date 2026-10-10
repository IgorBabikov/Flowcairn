import { mkdirSync, mkdtempSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GraphStore } from './lib/store.mjs';
import { sha256, hashObject } from './lib/io.mjs';
import { GraphPlanV3Schema, TaskSpecV3Schema, ReceiptSchema } from './lib/schemas.mjs';
import { captureLearningSources } from './lib/learning-sources.mjs';
import { createLearningMaterial } from './lib/learning-material.mjs';

const hash = hashObject('learning-fixture'), stamp = '2026-10-08T12:00:00.000Z';
const successfulTermination = () => ({ stopped: true, uncertain: false, timedOut: false, outputLimit: false, signal: null, ticketHash: null, execution: null });
export function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-learning-material-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new GraphStore(root);
  const task = TaskSpecV3Schema.parse({ schemaVersion: 3, id: 'LEARNING-TEST', goal: 'Изменить преобразование входа', instructions: 'Пример для локального теста',
    scope: ['main.py'], contextPaths: ['helper.py'], acceptance: ['Вход преобразуется'], checks: ['verify-code'], sourceHash: hash });
  const taskHash = store.putObject('tasks', task);
  const node = (id, action, kind) => ({ id, title: id, outcome: id, needs: [], action: { id: action, version: 1, inputs: {} },
    success: { kind, requiredArtifacts: [] }, permissions: [], skills: [], resources: { reads: ['main.py'], writes: [], exclusive: [] }, retry: { maxAttempts: 1, backoffMs: 0 } });
  const checks = { version: 1, profileHash: hash, definitions: [], bindings: [] };
  const plan = GraphPlanV3Schema.parse({ schemaVersion: 3, stage: 'execution', taskHash, version: 1, parentPlanHash: null,
    sourceHash: hash, runtimeHash: hash, registryHash: hash, policyHash: hash, skills: [], checkRegistryHash: hashObject(checks), checks,
    learning: { version: 1, initialMode: 'after-stage' },
    taskContract: { version: 1, goal: task.goal, instructionsHash: hash, requirements: [{ id: 'req-change', title: task.goal, mandatory: true, origin: 'acceptance',
      verification: { method: 'check', checkIds: ['verify-code'], criterion: 'Вход преобразуется', paths: ['main.py'] }, workIds: ['implement'] }],
      optionalImprovements: [], constraints: [], assumptions: [], unknowns: [], scope: ['main.py'], forbiddenPaths: [], rigor: { level: 'light', reasons: ['Локальная проверка'] } },
    nodes: [node('implement', 'ai-implement', 'implementation'), node('scope-check', 'workspace-check', 'checks'), node('check-code', 'check-verify-code', 'checks'),
      node('review', 'ai-review', 'review'), node('handoff', 'artifact-handoff', 'handoff')],
    executionStages: { version: 1, stages: [{ id: 'stage-one', title: 'Изменение', outcome: 'Вход преобразуется', implementationNodeIds: ['implement'], requirementIds: ['req-change'],
      scopeCheckNodeId: 'scope-check', checkNodeIds: ['check-code'], boundaryNodeId: 'handoff' }], finalCheckNodeIds: ['check-code'], finalReviewNodeId: 'review', handoffNodeId: 'handoff' } });
  const planHash = store.putObject('plans', plan), binding = { runId: 'run-learning', planHash, taskHash };
  const save = (name, text, role) => {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); writeFileSync(path.join(root, name), text);
    return { path: name, role, expected: { hash: sha256(text), size: Buffer.byteLength(text), mode: '100644' } };
  };
  const capture = (entries, sourceHash) => captureLearningSources({ store, projectRoot: root, sourceHash, files: entries });
  const before = capture([save('main.py', 'def inc(x):\n    return x + 1\n', 'before')], hash);
  // Simulate durable caller reference before performing the source write.
  const operationHash = store.putObject('operations', { learningBefore: before });
  const resultHash = hashObject('final-source');
  const after = capture([save('main.py', 'def inc(x):\n    return x + 2\n', 'after'), save('helper.py', 'OFFSET = 2\n', 'context')], resultHash);
  const receipt = (nodeId, actionId, beforeFingerprint = resultHash, afterFingerprint = resultHash, extras = {}) => store.putObject('receipts', ReceiptSchema.parse({
    schemaVersion: 2, ...binding, nodeId, attemptId: 'attempt-one', attempt: 1, phase: 'finished', actionId, actionVersion: 1, planVersion: 1,
    sourceHash: hash, runtimeHash: hash, instructionsHash: hash, skills: [], permissions: [], grantedPermissions: [], termination: successfulTermination(),
    startedAt: stamp, finishedAt: stamp, durationMs: 0, exitCode: 0, verdict: 'pass', checks: [], artifacts: [], changedFiles: [], failureReason: null,
    beforeFingerprint, afterFingerprint, actor: 'local-test', operationId: 'operation-one', previousReceipt: null, ...extras }));
  const implementationReceiptIds = [receipt('implement', 'ai-implement', hash, resultHash)];
  const checkReceiptIds = [receipt('scope-check', 'workspace-check'), receipt('check-code', 'check-verify-code')];
  const reviewReceiptIds = [receipt('review', 'ai-review')];
  const input = { store, binding, stageId: 'stage-one', before: new GraphStore(root).readObject('operations', operationHash).learningBefore,
    after, implementationReceiptIds, checkReceiptIds, reviewReceiptIds, createdAt: stamp };
  const create = (overrides = {}) => createLearningMaterial({ ...input, ...overrides });
  const options = (material) => ({ store, materialHash: material.id, binding: { ...binding, materialHashes: [material.id] } });
  return { root, store, task, plan, binding, save, capture, before, after, input, create, options, receipt, resultHash };
}
