import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkflowService } from './lib/service.mjs';
import { TaskSpecSchema } from './lib/schemas.mjs';
import { compileTaskProposal } from './lib/planning.mjs';
import { SKILL_ROUTES } from './lib/config.mjs';
import { hashObject } from './lib/io.mjs';

// Exercise the real service/driver/store boundary with a controlled asynchronous
// host diff. No AI process or native client is invoked by this fixture.
async function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'driver-async-')));
  const hash = hashObject('driver-async'), calls = [], services = [];
  let value = 'before', applyCount = 0, enter, release, diffSignal;
  const started = new Promise(resolve => { enter = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const skills = [...new Set(Object.values(SKILL_ROUTES).flat())]
    .map(id => ({ id, path: `skills/${id}/SKILL.md`, hash }));
  const fingerprint = () => {
    const files = [{ path: 'src/value.txt', hash: hashObject(value), mode: '100644', size: value.length }];
    const git = { head: hash, indexHash: hash };
    return { files, git, hash: hashObject({ files, git }) };
  };
  const input = { id: 'DRIVER-ASYNC', goal: 'Change value', instructions: 'Change value in src/value.txt',
    scope: ['src'], acceptance: ['Value is changed'], checks: [] };
  const task = TaskSpecSchema.parse({ ...input, schemaVersion: 2, sourceHash: hash });
  const plan = compileTaskProposal(task, { summary: 'Change value', verdict: 'pass', skillsUsed: [],
    findings: [], changedFiles: [], edits: [], plan: [],
    steps: [{ id: 'value', title: 'Change value', outcome: 'Value is changed', paths: ['src/value.txt'], needs: [] }],
  }, { runtimeHash: hash, skills, workflow: 'autonomous' }).plan;
  const adapters = {
    identity: () => hash, skills: () => skills,
    capture: () => ({ manifest: { sourceHash: hash }, bundlePath: 'synthetic' }),
    allocate: ({ runId }) => ({ worktree: root, taskId: input.id, runId, attemptId: 1, leaseId: 'fixture', sourceHash: hash }),
    verifyBinding: () => true, fingerprint, captureBefore: () => new Map(),
    inspectChanges: (before, after) => ({ allowed: true, changedFiles: before.hash === after.hash ? [] : ['src/value.txt'], violations: [] }),
    applyEdits: (_root, _before, _node, _task, edits) => { applyCount++; value = edits[0].content; },
    diff: async (_root, _before, _after, _contents, { signal }) => {
      diffSignal = signal; enter(); await held;
      return { content: '--- a/src/value.txt\n+++ b/src/value.txt\n@@ -1 +1 @@\n-before\n+after\n', complete: true };
    },
    runner: { ai: { available: true }, checks: { available: true } },
    inspectProcess: () => ({ stopped: true, uncertain: false }),
    loadSkills: ids => ids.map(name => ({ name, text: 'fixture', hash, path: `skills/${name}/SKILL.md` })),
    execute: async ({ node, onStart, reviewEvidence }) => {
      calls.push(node.action.id); await onStart({ pid: process.pid, ticket: 'fixture' });
      const implementation = node.action.id === 'ai-implement';
      return { exitCode: 0, stopped: true, uncertain: false, output: {
        summary: 'Fixture result', verdict: 'pass', skillsUsed: node.skills, findings: [], plan: [],
        changedFiles: implementation ? ['src/value.txt'] : [],
        edits: implementation ? [{ path: 'src/value.txt', previousHash: hashObject(value), content: 'after', executable: false }] : [],
        ...(reviewEvidence ? { reviewEvidenceHash: hashObject(reviewEvidence) } : {}),
      } };
    },
  };
  const service = await WorkflowService.open({ root, adapters }); services.push(service);
  t.after(async () => {
    release();
    for (const item of services) { await Promise.allSettled([...item.drives.values()]); item.close(); }
    rmSync(root, { recursive: true, force: true });
  });
  const initial = await service.create(input, { runId: 'driver-async', workflow: 'autonomous', stage: 'execution', draft: { nodes: plan.nodes } });
  const request = (snapshot, extra = {}) => ({ operationId: `op-${randomUUID()}`, expectedRevision: snapshot.revision, planHash: snapshot.planHash, ...extra });
  const approval = request(initial, { nodeId: 'approve-plan', decision: 'approve', permissions: initial.gates[0].requiredPermissions, challenge: initial.gates[0].challenge });
  await service.command(initial.runId, 'gate', approval);
  await started;
  const pending = service.drives.get(initial.runId);
  assert.ok(pending, 'the driver tracks the entire asynchronous run');
  assert.deepEqual(calls, ['ai-implement']);
  assert.equal(applyCount, 1);
  assert.equal(service.close(), false);
  return { service, request, approval, pending, calls, release, signal: () => diffSignal,
    applyCount: () => applyCount, drift: () => { value = 'external'; },
    reopen: async () => { const item = await WorkflowService.open({ root, adapters }); services.push(item); return item; },
  };
}

for (const event of ['unchanged', 'revision', 'restart', 'stop', 'workspace-drift', 'ownership-lost'])
  test(`autonomous driver waits for async diff and fences ${event}`, { timeout: 10000 }, async t => {
    const f = await fixture(t), runId = 'driver-async';
    let reopened;
    if (event === 'revision') {
      const state = f.service.store.readRun(runId);
      f.service.store.updateRun(runId, state.revision, current => ({ ...current }));
    } else if (event === 'restart') {
      reopened = await f.reopen();
      assert.equal(reopened.drives.size, 0, 'startup cannot schedule an owned operation');
      assert.deepEqual(f.calls, ['ai-implement']);
    } else if (event === 'stop') {
      await f.service.command(runId, 'stop', f.request(f.service.snapshot(runId)));
      assert.equal(f.signal().aborted, true);
    } else if (event === 'workspace-drift') f.drift();
    else if (event === 'ownership-lost') {
      const state = f.service.store.readRun(runId);
      f.service.store.updateRun(runId, state.revision, current => ({ ...current,
        activeOperation: { ...current.activeOperation, id: 'replacement-owner' } }));
    }
    assert.deepEqual(f.calls, ['ai-implement'], 'nothing downstream starts during diff');
    f.release(); await f.pending;
    const state = f.service.store.readRun(runId), node = state.nodes['step-value'];
    assert.equal(f.service.drives.size, 0);
    assert.equal(f.applyCount(), 1);
    if (['unchanged', 'revision', 'restart'].includes(event)) {
      assert.equal(state.status, 'passed');
      assert.equal(f.service.snapshot(runId).integrity.valid, true);
      assert.equal(node.status, 'passed');
      assert.deepEqual(f.calls, ['ai-implement', 'ai-review']);
      const count = f.calls.length;
      await f.service.command(runId, 'gate', f.approval);
      await Promise.all([...f.service.drives.values()]);
      assert.equal(f.calls.length, count, 'approval replay cannot duplicate execution');
      if (reopened) assert.equal(reopened.snapshot(runId).status, 'passed');
    } else {
      assert.notEqual(node.status, 'passed');
      assert.deepEqual(node.artifacts, []);
      assert.equal(node.receipts.some(id => {
        const receipt = f.service.store.readObject('receipts', id);
        return receipt.phase === 'finished' && receipt.verdict === 'pass';
      }), false);
      assert.deepEqual(f.calls, ['ai-implement']);
      assert.equal(state.successorRunId, undefined, 'uncertain diff does not launch autonomous repair');
      if (event === 'ownership-lost') assert.equal(state.activeOperation.id, 'replacement-owner');
      if (event === 'stop') assert.equal(state.stopResult.state, 'stopped');
    }
  });
