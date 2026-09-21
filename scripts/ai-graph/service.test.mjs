import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, lstatSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkflowService } from './lib/service.mjs';
import { canonicalJson, hashObject, GraphError } from './lib/io.mjs';
import { SKILL_ROUTES } from './lib/config.mjs';
import { DOCKER_CHECKS_TESTING } from './lib/docker-checks.mjs';

const hash = hashObject('fixture');
const input = {
  id: 'ORCH-TEST',
  goal: 'Проверить настоящий цикл управления',
  instructions: 'Изменить src/example.txt в заданных границах',
  scope: ['src/'],
  contextPaths: ['AGENTS.md'],
  acceptance: ['Файл исправлен'],
  checks: ['graph-tests'],
};
async function fixture(t, overrides = {}, taskInput = input) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'graph-service-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let value = 'before',
    calls = 0,
    identity = hash;
  const skills = [...new Set(Object.values(SKILL_ROUTES).flat())]
    .sort()
    .map((id) => ({ id, path: `.agents/skills/${id}/SKILL.md`, hash }));
  const fingerprint = () => {
    const files = [
      { path: 'src/example.txt', hash: hashObject(value), mode: '100644', size: value.length },
    ];
    const git = { head: hash, indexHash: hash };
    return { hash: hashObject({ files, git }), files, git };
  };
  const adapters = {
    identity: () => identity,
    skills: () => skills,
    capture: () => ({ manifest: { sourceHash: hash }, bundlePath: 'fixture-source' }),
    allocate: () => ({
      worktree: root,
      taskId: input.id,
      attemptId: 1,
      leaseId: 'fixture',
      sourceHash: hash,
    }),
    verifyBinding: () => true,
    replaceBinding: (options) => ({
      ...options.binding,
      runId: options.newRunId,
      leaseId: 'new-fixture-lease',
      sourceHash: options.sourceHash,
    }),
    fingerprint,
    applyEdits: (_worktree, _before, _node, _task, edits) => {
      if (edits.length) value = edits[0].content;
    },
    inspectChanges: (before, after, node) => ({
      allowed: before.hash === after.hash || node.permissions.includes('workspace.source.write'),
      changedFiles: before.hash === after.hash ? [] : ['src/example.txt'],
      violations: [],
    }),
    diff: () => ({
      content: '--- a/src/example.txt\n+++ b/src/example.txt\n-before\n+after',
      complete: true,
    }),
    runner: { ai: { available: true, reason: null }, checks: { available: true, reason: null } },
    inspectProcess: () => ({ stopped: true }),
    loadSkills: (ids) =>
      ids.map((name) => ({
        name,
        text: 'fixture skill',
        hash,
        path: `.agents/skills/${name}/SKILL.md`,
      })),
    execute: async ({ node, onStart, reviewEvidence }) => {
      calls++;
      if (node.action.id.startsWith('ai-')) {
        const tickets = lstatSync(path.join(root, '.ai-orchestrator/graph/runner-tickets'));
        assert.ok(tickets.isDirectory());
        assert.equal(tickets.mode & 0o077, 0);
      }
      await onStart({ pid: process.pid, ticket: 'fixture-ticket' });
      return {
        exitCode: 0,
        stopped: true,
        uncertain: false,
        output: node.action.id.startsWith('ai-')
          ? {
              summary: 'Задача проверена',
              ...(reviewEvidence ? { reviewEvidenceHash: hashObject(reviewEvidence) } : {}),
              verdict: 'pass',
              skillsUsed: node.skills,
              findings: [],
              changedFiles: node.action.id === 'ai-implement' ? ['src/example.txt'] : [],
              plan: [],
              edits:
                node.action.id === 'ai-implement'
                  ? [
                      {
                        path: 'src/example.txt',
                        previousHash: hashObject(value),
                        content: 'after',
                        executable: false,
                      },
                    ]
                  : [],
            }
          : null,
      };
    },
    ...overrides,
  };
  const service = await WorkflowService.open({ root, adapters });
  const snapshot = await service.create(taskInput, { runId: 'run-fixture' });
  const request = (snapshot, extra = {}) => ({
    operationId: `op-${randomUUID()}`,
    expectedRevision: snapshot.revision,
    planHash: snapshot.planHash,
    ...extra,
  });
  const approve = async (s = snapshot) =>
    service.command(
      s.runId,
      'gate',
      request(s, {
        nodeId: 'approve-plan',
        decision: 'approve',
        permissions: s.gates[0].requiredPermissions,
        challenge: s.gates[0].challenge,
      }),
    );
  return {
    service,
    root,
    adapters,
    snapshot,
    request,
    approve,
    calls: () => calls,
    mutate: () => {
      value += 'external';
    },
    drift: () => {
      identity = hashObject('newruntime');
    },
  };
}

async function orphanedExecution(t, inspectProcess) {
  const originalIdentity = hashObject('first-owner');
  let ownerIdentity = originalIdentity,
    release,
    begun;
  const held = new Promise((resolve) => {
      release = resolve;
    }),
    started = new Promise((resolve) => {
      begun = resolve;
    });
  const f = await fixture(t, {
    ownerIdentity: () => ownerIdentity,
    inspectProcess,
  });
  f.adapters.execute = async ({ onStart }) => {
    await onStart({ pid: process.pid, ticket: 'orphan-child' });
    begun();
    await held;
    return { exitCode: null, stopped: false, uncertain: true };
  };
  let snapshot = await f.approve();
  const running = f.service.command(
    snapshot.runId,
    'run',
    f.request(snapshot, { nodeId: 'analyze' }),
  );
  await started;
  ownerIdentity = hashObject('restarted-owner');
  const restarted = await WorkflowService.open({ root: f.root, adapters: f.adapters });
  snapshot = restarted.snapshot(snapshot.runId);
  let finished = false;
  const finish = async () => {
    if (finished) return;
    finished = true;
    ownerIdentity = originalIdentity;
    release();
    await running;
  };
  t.after(finish);
  return { ...f, restarted, snapshot, finish };
}

test('full persisted cycle: approval → registered actions → receipts → independent review → acceptance', async (t) => {
  const f = await fixture(t);
  assert.equal(f.snapshot.status, 'waiting-for-human');
  assert.equal(f.calls(), 0);
  const persisted = f.service.store.readRun(f.snapshot.runId);
  const envelope = f.service.store.readObject('envelopes', persisted.envelopeHash);
  assert.ok(envelope.readPaths.includes('AGENTS.md'));
  assert.ok(envelope.readPaths.includes('src/'));
  assert.deepEqual(f.snapshot.gates[0].readPaths, envelope.readPaths);
  let s = await f.approve();
  assert.equal(s.status, 'ready');
  s = await f.service.command(s.runId, 'run', f.request(s));
  assert.equal(s.status, 'waiting-for-human');
  assert.equal(s.gates[0].type, 'accept-result');
  assert.equal(f.calls(), 4);
  for (const n of s.nodes.filter((n) => n.status === 'passed')) {
    assert.ok(n.receiptIds.length);
    assert.equal(f.service.receipt(s.runId, n.receiptIds.at(-1)).verdict, 'pass');
  }
  const implementation = s.nodes.find((n) => n.id === 'implement');
  const started = f.service.receipt(s.runId, implementation.receiptIds[0]),
    finished = f.service.receipt(s.runId, implementation.receiptIds[1]);
  assert.equal(started.phase, 'started');
  assert.equal(finished.attemptId, started.attemptId);
  assert.equal(finished.previousReceipt, implementation.receiptIds[0]);
  assert.notEqual(finished.beforeFingerprint, finished.afterFingerprint);
  assert.deepEqual(implementation.changedFiles, ['src/example.txt']);
  s = await f.service.command(
    s.runId,
    'gate',
    f.request(s, { nodeId: 'accept-result', decision: 'accept', challenge: s.gates[0].challenge }),
  );
  assert.equal(s.status, 'passed');
  assert.equal(s.finalDisposition, 'accepted');
  assert.equal(s.capabilities.run.allowed, false);
  assert.ok(f.service.events(s.runId).length > 10);
});

test('human gate rejects forged, missing grants and duplicate conflicting submissions', async (t) => {
  const f = await fixture(t),
    s = f.snapshot;
  await assert.rejects(f.service.command(s.runId, 'run', f.request(s)), { code: 'CONTROL_DENIED' });
  await assert.rejects(
    f.service.command(
      s.runId,
      'gate',
      f.request(s, { nodeId: 'approve-plan', decision: 'approve', challenge: 'forged' }),
    ),
    { code: 'GATE_CHALLENGE' },
  );
  await assert.rejects(
    f.service.command(
      s.runId,
      'gate',
      f.request(s, {
        nodeId: 'approve-plan',
        decision: 'approve',
        challenge: s.gates[0].challenge,
      }),
    ),
    { code: 'PERMISSION_GRANT' },
  );
  const req = f.request(s, {
    nodeId: 'approve-plan',
    decision: 'approve',
    permissions: s.gates[0].requiredPermissions,
    challenge: s.gates[0].challenge,
  });
  const approved = await f.service.command(s.runId, 'gate', req),
    duplicate = await f.service.command(s.runId, 'gate', req);
  assert.equal(approved.revision, duplicate.revision);
  await assert.rejects(f.service.command(s.runId, 'gate', { ...req, decision: 'reject' }), {
    code: 'IDEMPOTENCY_CONFLICT',
  });
  assert.equal(f.calls(), 0);
});

test('backend validates malformed UI input, stale revision and wrong plan', async (t) => {
  const f = await fixture(t);
  let s = await f.approve();
  await assert.rejects(f.service.command(s.runId, 'shell', f.request(s)), {
    code: 'UNKNOWN_CONTROL',
  });
  await assert.rejects(f.service.command(s.runId, 'run', f.request(s, { argv: ['rm'] })));
  await assert.rejects(f.service.command(s.runId, 'run', f.request(s, { expectedRevision: 0 })), {
    code: 'REVISION_CONFLICT',
  });
  await assert.rejects(f.service.command(s.runId, 'run', f.request(s, { planHash: hash })), {
    code: 'PLAN_CONFLICT',
  });
  await assert.rejects(f.service.command(s.runId, 'run', f.request(s, { nodeId: 'missing' })), {
    code: 'NODE_NOT_FOUND',
  });
  assert.equal(f.calls(), 0);
});

test('running is durable before action starts and concurrent start cannot duplicate effects', async (t) => {
  const f = await fixture(t);
  let resolve;
  const wait = new Promise((r) => {
    resolve = r;
  });
  let began;
  const begun = new Promise((r) => {
    began = r;
  });
  f.adapters.execute = async ({ node, onStart }) => {
    const state = f.service.store.readRun('run-fixture');
    assert.equal(state.nodes[node.id].status, 'running');
    assert.equal(state.nodes[node.id].receipts.length, 1);
    await onStart({ pid: process.pid, ticket: 'fixture' });
    began();
    await wait;
    return { exitCode: 1, stopped: true, uncertain: false };
  };
  let s = await f.approve();
  const req = f.request(s, { nodeId: 'analyze' });
  const running = f.service.command(s.runId, 'run', req);
  await begun;
  s = f.service.snapshot(s.runId);
  assert.equal(s.status, 'running');
  assert.equal(s.capabilities.run.allowed, false);
  await assert.rejects(f.service.command(s.runId, 'run', f.request(s)), { code: 'CONTROL_DENIED' });
  assert.equal((await f.service.command(s.runId, 'run', req)).status, 'running');
  resolve();
  s = await running;
  assert.equal(s.status, 'failed');
  assert.equal(s.nodes.find((n) => n.id === 'analyze').capabilities.retry.allowed, false);
});

for (const fence of ['binding', 'runtime'])
  test(`AI patch is fenced when ${fence} ownership changes before return`, async (t) => {
    const f = await fixture(t),
      execute = f.adapters.execute,
      apply = f.adapters.applyEdits;
    let applied = 0;
    f.adapters.applyEdits = (...args) => {
      applied += 1;
      return apply(...args);
    };
    f.adapters.execute = async (options) => {
      const result = await execute(options);
      if (options.node.id === 'implement') {
        if (fence === 'runtime') f.drift();
        else
          f.adapters.verifyBinding = () => {
            throw new GraphError('STALE_GRAPH_BINDING', 'Lease revoked during AI');
          };
      }
      return result;
    };
    let s = await f.approve();
    s = await f.service.command(s.runId, 'run', f.request(s));
    assert.equal(applied, 0);
    assert.equal(f.adapters.fingerprint().files[0].hash, hashObject('before'));
    assert.equal(s.capabilities.run.allowed, false);
  });

test('implementation applies edits inside the trusted binding fence without nested verification', async (t) => {
  const f = await fixture(t),
    verifyBinding = f.adapters.verifyBinding;
  let insideFence = false,
    fences = 0;
  f.adapters.withBindingFence = (binding, callbackSync) => {
    verifyBinding(binding);
    fences += 1;
    insideFence = true;
    try {
      return callbackSync();
    } finally {
      insideFence = false;
    }
  };
  f.adapters.verifyBinding = (binding) => {
    assert.equal(insideFence, false, 'registry fence already owns binding verification');
    return verifyBinding(binding);
  };
  let s = await f.approve();
  s = await f.service.command(s.runId, 'run', f.request(s));
  assert.equal(fences, 1);
  assert.equal(s.nodes.find((node) => node.id === 'implement').status, 'passed');
});

test('orphan execution permits only recovery until child stop is proven', async (t) => {
  let replacements = 0,
    inspections = 0;
  const f = await orphanedExecution(t, () => {
      inspections += 1;
      return { stopped: false, uncertain: true };
    }),
    replaceBinding = f.adapters.replaceBinding;
  f.adapters.replaceBinding = (options) => {
    replacements += 1;
    return replaceBinding(options);
  };
  const s = f.snapshot;
  assert.equal(s.capabilities.recover.allowed, true);
  assert.equal(s.capabilities.requestReplan.allowed, false);
  assert.equal(s.capabilities.stop.allowed, false);
  const originalOperationId = f.restarted.store.readRun(s.runId).activeOperation.id;
  await assert.rejects(f.restarted.command(s.runId, 'replan', f.request(s)), {
    code: 'RECOVERY_REQUIRED',
  });
  await assert.rejects(f.restarted.command(s.runId, 'recover', f.request(s)), {
    code: 'PROCESS_UNCERTAIN',
  });
  const restored = f.restarted.store.readRun(s.runId);
  assert.equal(restored.activeOperation.id, originalOperationId);
  assert.equal(restored.operations[restored.activeOperation.id].status, 'running');
  assert.equal(
    Object.values(restored.operations).filter((operation) => operation.status === 'failed').length,
    1,
  );
  assert.equal(inspections, 1);
  assert.equal(replacements, 0);
  await f.finish();
});

test('recovery deduplicates process identity and reuses its durable stop receipt', async (t) => {
  let inspections = 0;
  const f = await orphanedExecution(t, () => {
    inspections += 1;
    return { stopped: true, uncertain: false };
  });
  const beforeRecovery = f.restarted.store.readRun(f.snapshot.runId);
  f.restarted.store.updateRun(beforeRecovery.runId, beforeRecovery.revision, (current) => ({
    ...current,
    stopRequested: true,
    stopResult: {
      operationId: current.activeOperation.id,
      requestedAt: new Date().toISOString(),
      state: 'requested',
      reason: null,
    },
  }));
  const recoverable = f.restarted.snapshot(f.snapshot.runId);
  let s = await f.restarted.command(recoverable.runId, 'recover', f.request(recoverable));
  assert.equal(inspections, 1);
  const recoveredNode = s.nodes.find((node) => node.id === 'analyze');
  const recoveryReceipt = f.restarted.receipt(s.runId, recoveredNode.receiptIds.at(-1));
  assert.equal(recoveryReceipt.phase, 'recovery');
  assert.equal(recoveryReceipt.termination.stopped, true);
  assert.equal(
    recoveryReceipt.termination.ticketHash,
    hashObject({ pid: process.pid, ticket: 'orphan-child' }),
  );
  const recoveredState = f.restarted.store.readRun(s.runId);
  assert.equal(recoveredState.stopRequested, false);
  assert.equal(recoveredState.stopResult, null);
  s = await f.restarted.command(s.runId, 'recover', f.request(s));
  assert.equal(inspections, 1);
  assert.equal(s.integrity.valid, true);
  await f.finish();
});

test('recovery reservation prevents concurrent replan and stale completion', async (t) => {
  let ownerIdentity = hashObject('recovery-owner-before-restart');
  const f = await fixture(t, { ownerIdentity: () => ownerIdentity });
  f.adapters.execute = async ({ onStart }) => {
    await onStart({ pid: process.pid, ticket: 'uncertain-child' });
    return { exitCode: null, stopped: false, uncertain: true };
  };
  let s = await f.approve();
  s = await f.service.command(s.runId, 'run', f.request(s));
  let release, begun;
  const held = new Promise((resolve) => {
      release = resolve;
    }),
    started = new Promise((resolve) => {
      begun = resolve;
    });
  f.adapters.inspectProcess = async () => {
    begun();
    await held;
    return { stopped: true, uncertain: false };
  };
  const recovering = f.service.command(s.runId, 'recover', f.request(s));
  await started;
  const reserved = f.service.snapshot(s.runId);
  assert.equal(reserved.capabilities.recover.allowed, false);
  assert.equal(reserved.capabilities.requestReplan.allowed, false);
  ownerIdentity = hashObject('recovery-owner-after-restart');
  const restarted = await WorkflowService.open({ root: f.root, adapters: f.adapters });
  const orphanedRecovery = restarted.snapshot(s.runId);
  assert.equal(orphanedRecovery.capabilities.recover.allowed, true);
  assert.equal(orphanedRecovery.capabilities.requestReplan.allowed, false);
  await assert.rejects(f.service.command(s.runId, 'replan', f.request(reserved)), {
    code: 'RECOVERY_REQUIRED',
  });
  await assert.rejects(f.service.command(s.runId, 'recover', f.request(s)), {
    code: 'REVISION_CONFLICT',
  });
  release();
  const recovered = await recovering;
  assert.equal(recovered.integrity.valid, true);
  assert.equal(recovered.status, 'uncertain');
});

test('recovery removes a definitely dead GraphStore lock before its CAS reservation', async (t) => {
  const f = await fixture(t);
  const runId = f.snapshot.runId;
  const lockFile = path.join(f.root, '.ai-orchestrator', 'graph', 'runs', runId, '.lock');
  writeFileSync(
    lockFile,
    `${canonicalJson({
      version: 1,
      owner: '00000000-0000-4000-8000-000000000000',
      pid: 2_147_483_647,
      processStart: '2026-01-01T00:00:00.000Z',
    })}\n`,
    { mode: 0o600 },
  );
  const blocked = f.service.snapshot(runId);
  assert.equal(blocked.capabilities.recover.allowed, true);
  const recovered = await f.service.command(runId, 'recover', f.request(blocked));
  assert.equal(f.service.store.inspectLock(runId), null);
  assert.equal(recovered.integrity.valid, true);
  assert.equal(f.service.store.readRun(runId).recovered, true);
});

test('dead lock recovery rejects a run revision changed before reservation', async (t) => {
  const f = await fixture(t);
  const runId = f.snapshot.runId;
  const lockFile = path.join(f.root, '.ai-orchestrator', 'graph', 'runs', runId, '.lock');
  writeFileSync(
    lockFile,
    `${canonicalJson({
      version: 1,
      owner: '00000000-0000-4000-8000-000000000000',
      pid: 2_147_483_647,
      processStart: '2026-01-01T00:00:00.000Z',
    })}\n`,
    { mode: 0o600 },
  );
  const blocked = f.service.snapshot(runId);
  const recoverLock = f.service.store.recoverLock.bind(f.service.store);
  f.service.store.recoverLock = (lockedRunId) => {
    const result = recoverLock(lockedRunId);
    f.service.store.updateRun(lockedRunId, blocked.revision, (current) => ({
      ...current,
      failureReason: 'Concurrent committed state',
    }));
    return result;
  };
  await assert.rejects(f.service.command(runId, 'recover', f.request(blocked)), {
    code: 'RECOVERY_SUPERSEDED',
  });
  assert.equal(
    Object.values(f.service.store.readRun(runId).operations).some(
      (operation) => operation.status === 'running',
    ),
    false,
  );
});

test('orphan recovery resumes terminal bookkeeping for an already-created successor', async (t) => {
  let ownerIdentity = hashObject('replan-recovery-owner-1');
  const f = await fixture(t, { ownerIdentity: () => ownerIdentity }),
    replaceBinding = f.adapters.replaceBinding;
  let s = await f.approve();
  s = await f.service.command(s.runId, 'run', f.request(s));
  const replanRequest = f.request(s);
  f.adapters.replaceBinding = () => {
    throw new GraphError('TEMPORARY_BINDING', 'Interrupted handoff');
  };
  await assert.rejects(f.service.command(s.runId, 'replan', replanRequest), {
    code: 'TEMPORARY_BINDING',
  });
  f.adapters.replaceBinding = replaceBinding;
  const interrupted = f.service.store.readRun(s.runId);
  const successorId = interrupted.operations[replanRequest.operationId].resultRunId;
  const recoverySnapshot = f.service.snapshot(s.runId);
  const recoveryRequest = f.request(recoverySnapshot);
  const updateRun = f.service.store.updateRun.bind(f.service.store);
  let injected = false,
    crashed = false;
  f.service.store.updateRun = (runId, revision, updater) => {
    const current = f.service.store.readRun(runId);
    if (
      !injected &&
      current.activeOperation?.id === recoveryRequest.operationId &&
      current.operations[replanRequest.operationId]?.status === 'finished'
    ) {
      injected = true;
      crashed = true;
    }
    if (crashed) throw new GraphError('RECOVERY_CRASH', 'Crash before recovery terminal write');
    return updateRun(runId, revision, updater);
  };
  await assert.rejects(f.service.command(s.runId, 'recover', recoveryRequest), {
    code: 'RECOVERY_CRASH',
  });
  f.service.store.updateRun = updateRun;
  assert.equal(injected, true);
  ownerIdentity = hashObject('replan-recovery-owner-2');
  const restarted = await WorkflowService.open({ root: f.root, adapters: f.adapters });
  const orphaned = restarted.snapshot(s.runId);
  assert.equal(orphaned.capabilities.recover.allowed, true);
  assert.equal(orphaned.capabilities.requestReplan.allowed, false);
  const resumed = await restarted.command(s.runId, 'recover', f.request(orphaned));
  assert.equal(resumed.runId, successorId);
  const terminal = restarted.store.readRun(s.runId);
  assert.equal(terminal.activeOperation, null);
  assert.equal(
    Object.values(terminal.operations).some(
      (operation) => operation.status === 'finished' && operation.resultRunId === successorId,
    ),
    true,
  );
});

test('service accepts the Docker adapter durable proof after the container is already absent', async (t) => {
  const f = await fixture(t),
    execute = f.adapters.execute;
  const metadata = {
    version: 1,
    kind: 'docker-check',
    containerId: 'a'.repeat(64),
    imageId: `sha256:${'b'.repeat(64)}`,
    imageHash: 'c'.repeat(64),
    planHash: f.snapshot.planHash,
    contractHash: 'd'.repeat(64),
    securityHash: 'e'.repeat(64),
    actionId: 'check-graph-tests',
    attemptId: 'attempt-durable-proof',
    taskId: input.id,
    nodeId: 'graph-tests',
    name: 'flowcairn-graph-durable-proof',
    labels: {},
  };
  const terminal = {
    State: {
      Running: false,
      Status: 'exited',
      ExitCode: 137,
      FinishedAt: '2026-09-12T12:00:00.000000000Z',
      OOMKilled: false,
    },
  };
  await DOCKER_CHECKS_TESTING.recoverCheckProcess(f.root, metadata, {
    available: () => true,
    inspect: () => terminal,
    wait: async () => ({ exitCode: 137 }),
    writeProof: (inspected, waited) =>
      DOCKER_CHECKS_TESTING.writeStopProof(f.root, metadata, inspected, waited),
    logs: () => null,
    remove: () => true,
  });
  f.adapters.execute = async (options) => {
    if (options.node.id !== 'graph-tests') return execute(options);
    await options.onStart(metadata);
    return { exitCode: null, stopped: false, uncertain: true, process: metadata };
  };
  let proofReads = 0;
  f.adapters.inspectProcess = (processInfo) => {
    proofReads += 1;
    return DOCKER_CHECKS_TESTING.recoverCheckProcess(f.root, processInfo, {
      available: () => false,
      inspect: () => assert.fail('durable replay must not inspect an absent container'),
    });
  };
  let s = await f.approve();
  s = await f.service.command(s.runId, 'run', f.request(s));
  assert.equal(s.status, 'uncertain');
  s = await f.service.command(s.runId, 'recover', f.request(s));
  assert.equal(s.integrity.valid, true);
  assert.equal(f.service.store.readRun(s.runId).recovered, true);
  const receipt = f.service.receipt(
    s.runId,
    s.nodes.find((node) => node.id === 'graph-tests').receiptIds.at(-1),
  );
  assert.equal(receipt.termination.execution.removed, false);
  assert.match(receipt.termination.execution.stopProofHash, /^[a-f0-9]{64}$/);
  s = await f.service.command(s.runId, 'recover', f.request(s));
  assert.equal(proofReads, 2, 'each durable replay is revalidated by the Docker adapter');
  assert.equal(s.integrity.valid, true);
});

test('uncertain write is never retryable; recovery proves stop and requires a new plan', async (t) => {
  const f = await fixture(t);
  f.adapters.execute = async ({ onStart }) => {
    await onStart({ pid: process.pid, ticket: 'fixture' });
    f.mutate();
    return { exitCode: null, stopped: false, uncertain: true };
  };
  let s = await f.approve();
  s = await f.service.command(s.runId, 'run', f.request(s));
  assert.equal(s.status, 'uncertain');
  assert.equal(s.capabilities.retry.allowed, false);
  await assert.rejects(f.service.command(s.runId, 'retry', f.request(s, { nodeId: 'analyze' })), {
    code: 'RETRY_UNSAFE',
  });
  await assert.rejects(f.service.command(s.runId, 'replan', f.request(s)), {
    code: 'RECOVERY_REQUIRED',
  });
  s = await f.service.command(s.runId, 'recover', f.request(s));
  assert.equal(s.status, 'uncertain');
  const next = await f.service.command(s.runId, 'replan', f.request(s));
  assert.equal(next.planVersion, 2);
  assert.equal(next.status, 'waiting-for-human');
  assert.notEqual(next.planHash, s.planHash);
  assert.equal(f.service.snapshot(s.runId).status, 'stale');
});

test('safe failed check retries only against unchanged workspace and within attempt budget', async (t) => {
  const f = await fixture(t),
    execute = f.adapters.execute;
  let failures = 0;
  f.adapters.execute = async (args) =>
    args.node.action.id === 'check-graph-tests' && failures++ === 0
      ? { exitCode: 1, stopped: true, uncertain: false }
      : execute(args);
  let s = await f.approve();
  s = await f.service.command(s.runId, 'run', f.request(s));
  assert.equal(s.status, 'failed');
  assert.equal(s.nodes.find((n) => n.id === 'graph-tests').capabilities.retry.allowed, true);
  s = await f.service.command(s.runId, 'retry', f.request(s, { nodeId: 'graph-tests' }));
  assert.equal(s.nodes.find((n) => n.id === 'graph-tests').attempt, 2);
  assert.equal(s.nodes.find((n) => n.id === 'graph-tests').status, 'passed');
  assert.equal(s.nodes.find((n) => n.id === 'review').status, 'ready');
});

test('workspace drift blocks execution and final acceptance; runtime drift disables snapshot controls', async (t) => {
  const f = await fixture(t);
  let s = await f.approve();
  s = await f.service.command(s.runId, 'run', f.request(s));
  f.mutate();
  await assert.rejects(
    f.service.command(
      s.runId,
      'gate',
      f.request(s, {
        nodeId: 'accept-result',
        decision: 'accept',
        challenge: s.gates[0].challenge,
      }),
    ),
    { code: 'WORKSPACE_DRIFT' },
  );
  f.drift();
  s = f.service.snapshot(s.runId);
  assert.equal(s.integrity.valid, false);
  assert.equal(s.capabilities.run.allowed, false);
});

test('corrupt receipt is visible as blocked run; read endpoints do not rewrite persistence', async (t) => {
  const f = await fixture(t);
  let s = await f.approve();
  const before = f.service.store.readRun(s.runId).revision;
  f.service.snapshot(s.runId);
  f.service.listRuns();
  f.service.events(s.runId);
  assert.equal(f.service.store.readRun(s.runId).revision, before);
  const receipts = path.join(f.root, '.ai-orchestrator/graph/receipts');
  const file = path.join(receipts, readdirSync(receipts)[0]);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  data.data.verdict = 'fail';
  writeFileSync(file, JSON.stringify(data));
  s = f.service.snapshot(s.runId);
  assert.equal(s.integrity.valid, false);
  assert.equal(f.service.listRuns()[0].status, 'stale');
});

test('snapshot and artifacts sanitize AI text, receipts never contain raw output or instructions', async (t) => {
  const f = await fixture(t),
    execute = f.adapters.execute;
  f.adapters.execute = async (args) => {
    const result = await execute(args);
    if (result.output) result.output.summary = 'api_key=secret123 /Users/private/person/file';
    return result;
  };
  let s = await f.approve();
  s = await f.service.command(s.runId, 'run', f.request(s));
  const analysis = s.nodes.find((n) => n.id === 'analyze');
  const artifact = f.service.artifact(s.runId, analysis.artifacts[0].id);
  assert.ok(artifact.content.includes('[redacted]'));
  assert.ok(!artifact.content.includes('secret123'));
  assert.ok(!JSON.stringify(s).includes(f.root));
  const receipt = f.service.receipt(s.runId, analysis.receiptIds.at(-1));
  assert.equal('instructions' in receipt, false);
  assert.equal('stdout' in receipt, false);
  await assert.rejects(async () => f.service.artifact(s.runId, hash), { code: 'NOT_FOUND' });
});

test('semantic rejection never applies proposed edits and remains failed, not uncertain', async (t) => {
  const f = await fixture(t),
    execute = f.adapters.execute;
  let applied = 0;
  f.adapters.applyEdits = () => {
    applied++;
  };
  f.adapters.execute = async (args) => {
    const result = await execute(args);
    if (args.node.action.id === 'ai-implement') result.output.verdict = 'fail';
    return result;
  };
  let s = await f.approve();
  s = await f.service.command(s.runId, 'run', f.request(s));
  assert.equal(s.status, 'failed');
  assert.equal(applied, 0);
  assert.deepEqual(s.nodes.find((n) => n.id === 'implement').changedFiles, []);
});

test('intake replay reuses immutable source and conflicting intake is rejected', async (t) => {
  const f = await fixture(t);
  const state = f.service.store.readRun(f.snapshot.runId);
  f.adapters.capture = () => {
    throw new Error('must not capture again');
  };
  const s = await f.service.create(input, {
    runId: f.snapshot.runId,
    operationId: state.createOperationId,
  });
  assert.equal(s.planHash, f.snapshot.planHash);
  await assert.rejects(
    f.service.create(
      { ...input, goal: 'Another valid goal' },
      { runId: s.runId, operationId: state.createOperationId },
    ),
    { code: 'IDEMPOTENCY_CONFLICT' },
  );
});

test('valid storage hash cannot make forged accepted state executable', async (t) => {
  const f = await fixture(t);
  const state = f.service.store.readRun(f.snapshot.runId);
  f.service.store.updateRun(state.runId, state.revision, (current) => ({
    ...current,
    status: 'passed',
    finalDisposition: 'accepted',
  }));
  const s = f.service.snapshot(state.runId);
  assert.equal(s.integrity.valid, false);
  assert.equal(s.capabilities.run.allowed, false);
});

test('planning envelope and immutable source mismatch close every execution capability', async (t) => {
  const f = await fixture(t);
  const state = f.service.store.readRun(f.snapshot.runId);
  const envelope = f.service.store.readObject('envelopes', state.envelopeHash);
  const envelopeHash = f.service.store.putObject('envelopes', {
    ...envelope,
    sourceHash: hashObject('tampered'),
  });
  f.service.store.updateRun(state.runId, state.revision, (current) => ({
    ...current,
    envelopeHash,
  }));
  assert.equal(f.service.snapshot(state.runId).integrity.valid, false);
  const other = await fixture(t);
  other.adapters.verifySource = () => hashObject('wrong-source');
  assert.equal(other.service.snapshot(other.snapshot.runId).integrity.valid, false);
});

test('replan resumes the same new run after a failed binding handoff', async (t) => {
  const f = await fixture(t),
    replace = f.adapters.replaceBinding;
  let s = await f.approve();
  s = await f.service.command(s.runId, 'run', f.request(s));
  const req = f.request(s);
  let count = 0;
  f.adapters.replaceBinding = (options) => {
    if (count++ === 0) throw new GraphError('TEMPORARY_BINDING', 'Interrupted handoff');
    return replace(options);
  };
  await assert.rejects(f.service.command(s.runId, 'replan', req), { code: 'TEMPORARY_BINDING' });
  const old = f.service.store.readRun(s.runId),
    newId = old.operations[req.operationId].resultRunId;
  assert.equal(f.service.snapshot(newId).capabilities.run.allowed, false);
  const next = await f.service.command(s.runId, 'replan', req);
  assert.equal(next.runId, newId);
  assert.equal(next.planVersion, 2);
  assert.equal(next.status, 'waiting-for-human');
  assert.equal(f.service.listRuns().length, 2);
});

test('allocation failure before execution is recoverable without an implicit action retry', async (t) => {
  const f = await fixture(t),
    allocate = f.adapters.allocate;
  let failures = 0;
  f.adapters.allocate = (options) => {
    if (failures++ === 0) throw new GraphError('ALLOCATION_INTERRUPTED', 'Interrupted setup');
    return allocate(options);
  };
  let s = await f.approve();
  s = await f.service.command(s.runId, 'run', f.request(s));
  assert.equal(s.status, 'failed');
  assert.equal(f.calls(), 0);
  s = await f.service.command(s.runId, 'run', f.request(s));
  assert.equal(s.status, 'waiting-for-human');
});

test('fresh client discovers and resumes an interrupted replan after service restart', async (t) => {
  const f = await fixture(t),
    replace = f.adapters.replaceBinding;
  let s = await f.approve();
  s = await f.service.command(s.runId, 'run', f.request(s));
  f.adapters.replaceBinding = () => {
    throw new GraphError('TEMPORARY_BINDING', 'Interrupted');
  };
  await assert.rejects(f.service.command(s.runId, 'replan', f.request(s)), {
    code: 'TEMPORARY_BINDING',
  });
  f.adapters.replaceBinding = replace;
  const restarted = await WorkflowService.open({ root: f.root, adapters: f.adapters });
  s = restarted.snapshot(s.runId);
  assert.equal(s.capabilities.recover.allowed, true);
  const req = f.request(s),
    next = await restarted.command(s.runId, 'recover', req);
  assert.equal(next.status, 'waiting-for-human');
  assert.equal(next.planVersion, 2);
  assert.equal(restarted.listRuns().length, 2);
  assert.equal((await restarted.command(s.runId, 'recover', req)).runId, next.runId);
});

function historicalRegistryFixture(f, { active = false } = {}) {
  const state = f.service.store.readRun(f.snapshot.runId);
  const plan = f.service.store.readObject('plans', state.planHash);
  plan.registryHash = hashObject('retired-registry');
  plan.policyHash = hashObject('retired-policy');
  plan.nodes.find((n) => n.id === 'analyze').action.id = 'retired-analyzer';
  plan.nodes.find((n) => n.id === 'approve-plan').action.id = 'retired-approval';
  const planHash = f.service.store.putObject('plans', plan);
  const envelope = f.service.store.readObject('envelopes', state.envelopeHash);
  const envelopeHash = f.service.store.putObject('envelopes', {
    ...envelope,
    registryHash: plan.registryHash,
    policyHash: plan.policyHash,
  });
  const nodes = structuredClone(state.nodes);
  for (const node of Object.values(nodes)) {
    let previousReceipt = null;
    node.receipts = node.receipts.map((hash) => {
      const receipt = f.service.store.readObject('receipts', hash);
      const next = f.service.store.putObject('receipts', {
        ...receipt,
        planHash,
        previousReceipt,
        actionId: plan.nodes.find((n) => n.id === receipt.nodeId).action.id,
      });
      previousReceipt = next;
      return next;
    });
  }
  f.service.store.updateRun(state.runId, state.revision, (current) => ({
    ...current,
    planHash,
    envelopeHash,
    nodes,
    ...(active
      ? {
          status: 'running',
          activeOperation: {
            id: 'op-allocation',
            digest: hash,
            ownerPid: process.pid,
            ownerStart: null,
            nodeId: null,
            process: null,
            startedAt: new Date().toISOString(),
          },
        }
      : {}),
  }));
  return f.service.snapshot(state.runId);
}

test('registry drift preserves historical evidence and fresh planning while denying old execution', async (t) => {
  const f = await fixture(t);
  await f.approve();
  let s = historicalRegistryFixture(f);
  assert.equal(s.integrity.valid, false);
  assert.equal(s.nodes.length > 0, true);
  assert.equal(s.capabilities.run.allowed, false);
  assert.equal(s.capabilities.requestReplan.allowed, true);
  assert.equal(
    f.service.plan(s.runId).nodes.find((n) => n.id === 'analyze').action.id,
    'retired-analyzer',
  );
  assert.ok(f.service.events(s.runId).length);
  const receipt = f.service.receipt(
    s.runId,
    s.nodes.find((n) => n.id === 'approve-plan').receiptIds[0],
  );
  assert.equal(receipt.verdict, 'pass');
  await assert.rejects(f.service.command(s.runId, 'run', f.request(s)), { code: 'POLICY_DRIFT' });
  const next = await f.service.command(s.runId, 'replan', f.request(s));
  assert.equal(next.integrity.valid, true);
  assert.equal(next.planVersion, 2);
});

test('registry drift does not prevent stopping an active allocation', async (t) => {
  const f = await fixture(t);
  await f.approve();
  const s = historicalRegistryFixture(f, { active: true });
  assert.equal(s.capabilities.stop.allowed, true);
  await f.service.command(s.runId, 'stop', f.request(s));
  assert.equal(f.service.store.readRun(s.runId).stopRequested, true);
});

test('stop snapshot stays stopping until the owned execution confirms termination', async (t) => {
  let release;
  let started;
  const held = new Promise((resolve) => { release = resolve; });
  const began = new Promise((resolve) => { started = resolve; });
  t.after(() => release?.());
  const f = await fixture(t);
  f.adapters.execute = async ({ onStart }) => {
    await onStart({ pid: process.pid, ticket: 'held-stop-fixture' });
    started();
    await held;
    return { exitCode: null, stopped: true, uncertain: true, failureReason: 'ABORTED' };
  };
  let current = await f.approve();
  const running = f.service.command(
    current.runId,
    'run',
    f.request(current, { nodeId: 'analyze' }),
  );
  await began;
  current = f.service.snapshot(current.runId);
  const stopping = await f.service.command(current.runId, 'stop', f.request(current));
  assert.equal(stopping.execution.state, 'stopping');
  release();
  const finished = await running;
  assert.equal(finished.execution.state, 'stopped');
  assert.equal(finished.status, 'uncertain');
});

test('unconfirmed child termination is projected as stop-uncertain', async (t) => {
  const f = await fixture(t);
  const state = f.service.store.readRun(f.snapshot.runId);
  const next = f.service.store.updateRun(state.runId, state.revision, (current) => ({
    ...current,
    stopRequested: true,
    stopResult: {
      operationId: 'op-stop-proof',
      requestedAt: new Date().toISOString(),
      state: 'uncertain',
      reason: 'PROCESS_STOP_UNCONFIRMED',
    },
  }));
  assert.equal(f.service.snapshot(next.runId).execution.state, 'stop-uncertain');
});

test('legacy states without stopResult have compatible execution projections', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.snapshot.execution, { state: 'idle', stopRequested: false });
  await f.approve();
  const running = historicalRegistryFixture(f, { active: true });
  assert.deepEqual(running.execution, { state: 'running', stopRequested: false });
});

test('stop before child start becomes stopped without a fictitious termination receipt', async (t) => {
  let release;
  let started;
  const held = new Promise((resolve) => { release = resolve; });
  const began = new Promise((resolve) => { started = resolve; });
  t.after(() => release?.());
  const f = await fixture(t);
  const allocate = f.adapters.allocate;
  f.adapters.allocate = async (options) => {
    started();
    await held;
    return allocate(options);
  };
  let current = await f.approve();
  const running = f.service.command(
    current.runId,
    'run',
    f.request(current, { nodeId: 'analyze' }),
  );
  await began;
  current = f.service.snapshot(current.runId);
  const stopping = await f.service.command(current.runId, 'stop', f.request(current));
  assert.equal(stopping.execution.state, 'stopping');
  release();
  const finished = await running;
  assert.equal(finished.execution.state, 'stopped');
  assert.equal(finished.nodes.find((node) => node.id === 'analyze').receiptIds.length, 0);
});

test('review/fix replan carries the failed check evidence into the next AI analysis', async (t) => {
  const f = await fixture(t),
    execute = f.adapters.execute;
  f.adapters.execute = async (args) =>
    args.node.action.id === 'check-graph-tests'
      ? {
          exitCode: 1,
          stopped: true,
          uncertain: false,
          failureReason: 'src/example.txt: expected a complete result',
        }
      : execute(args);
  let s = await f.approve();
  s = await f.service.command(s.runId, 'run', f.request(s));
  assert.equal(s.status, 'failed');
  const next = await f.service.command(s.runId, 'replan', f.request(s));
  let evidence;
  f.adapters.execute = async (args) => {
    evidence = args.priorEvidence;
    return execute(args);
  };
  s = await f.approve(next);
  await f.service.command(s.runId, 'run', f.request(s, { nodeId: 'analyze' }));
  assert.ok(evidence.artifacts.some((a) => a.excerpt.includes('expected a complete result')));
});

test('rejects every AI proposal path before applying any edit and records a known failure', async (t) => {
  const f = await fixture(t);
  const original = f.adapters.execute;
  f.adapters.execute = async (options) => {
    const result = await original(options);
    if (options.node.action.id === 'ai-implement')
      result.output.plan = [{ outcome: 'Unexpected extra write', paths: ['outside/file.txt'] }];
    return result;
  };
  let s = await f.approve();
  s = await f.service.command(s.runId, 'run', f.request(s));
  const implementation = s.nodes.find((n) => n.id === 'implement');
  assert.equal(implementation.status, 'failed');
  assert.deepEqual(implementation.changedFiles, []);
  const receipt = f.service.receipt(s.runId, implementation.receiptIds.at(-1));
  assert.match(receipt.failureReason, /AI_SCOPE/);
  assert.equal(receipt.beforeFingerprint, receipt.afterFingerprint);
  assert.equal(s.nodes.find((n) => n.id === 'workspace-check').status, 'pending');
});

test('released ownership preserves receipts and graph history but grants no execution controls', async (t) => {
  const f = await fixture(t);
  let s = await f.approve();
  s = await f.service.command(s.runId, 'run', f.request(s));
  const receiptId = s.nodes.find((n) => n.id === 'implement').receiptIds.at(-1);
  f.adapters.verifyBinding = () => {
    throw new GraphError('STALE_GRAPH_BINDING', 'Ownership released');
  };
  const historical = f.service.snapshot(s.runId);
  assert.equal(historical.status, 'stale');
  assert.equal(historical.nodes.length, s.nodes.length);
  assert.equal(historical.capabilities.run.allowed, false);
  assert.equal(historical.capabilities.requestReplan.allowed, false);
  assert.equal(historical.capabilities.openReceipt.allowed, true);
  assert.equal(f.service.receipt(s.runId, receiptId).verdict, 'pass');
});

for (const removed of [true, false])
  test(`container recovery requires exact persisted removal proof (removed=${removed})`, async (t) => {
    const f = await fixture(t);
    const original = f.adapters.execute;
    f.adapters.execute = async (options) => {
      if (options.node.action.id !== 'check-graph-tests') return original(options);
      const metadata = {
        kind: 'docker-check',
        containerId: 'a'.repeat(64),
        imageId: `sha256:${'b'.repeat(64)}`,
        attemptId: path.basename(options.outputDirectory).slice('output-'.length),
        nodeId: options.node.id,
        actionId: options.node.action.id,
      };
      await options.onStart(metadata);
      return {
        exitCode: 137,
        stopped: true,
        uncertain: true,
        process: metadata,
        execution: {
          kind: 'docker-check',
          containerId: metadata.containerId,
          imageId: metadata.imageId,
          removed,
        },
      };
    };
    f.adapters.inspectProcess = () => ({ stopped: false, reason: 'CONTAINER_NOT_FOUND' });
    let s = await f.approve();
    s = await f.service.command(s.runId, 'run', f.request(s));
    assert.equal(s.status, 'uncertain');
    if (removed) {
      s = await f.service.command(s.runId, 'recover', f.request(s));
      assert.equal(s.status, 'uncertain');
      assert.equal(s.nodes.find((n) => n.id === 'graph-tests').capabilities.retry.allowed, false);
      assert.equal(f.service.store.readRun(s.runId).recovered, true);
    } else {
      await assert.rejects(
        f.service.command(s.runId, 'recover', f.request(s)),
        (error) => error.code === 'PROCESS_UNCERTAIN',
      );
    }
  });

test('implementation receives current scoped fingerprints for exact patch preconditions', async (t) => {
  const f = await fixture(t);
  const original = f.adapters.execute;
  let observed = false;
  f.adapters.execute = async (options) => {
    if (options.node.id === 'implement') {
      assert.deepEqual(
        options.priorEvidence.workspaceFiles.map((file) => file.path),
        ['src/example.txt'],
      );
      assert.equal(options.priorEvidence.workspaceFiles[0].hash, hashObject('before'));
      assert.equal(options.priorEvidence.workspaceFilesTruncated, false);
      assert.ok(Buffer.byteLength(JSON.stringify(options.priorEvidence)) <= 30 * 1024);
      observed = true;
    }
    return original(options);
  };
  let s = await f.approve();
  s = await f.service.command(s.runId, 'run', f.request(s));
  assert.equal(s.status, 'waiting-for-human');
  assert.equal(observed, true);
});

test('history and revision hints avoid source scans; execution still verifies the source', async (t) => {
  const f = await fixture(t);
  const approved = await f.approve();
  let sourceReads = 0;
  f.adapters.verifySource = () => {
    sourceReads++;
    return hash;
  };
  assert.equal(f.service.revision(approved.runId), approved.revision);
  assert.equal(f.service.listRuns()[0].integrity.checked, 'metadata');
  f.service.plan(approved.runId);
  f.service.events(approved.runId);
  const receipt = f.service.store.readRun(approved.runId).nodes['approve-plan'].receipts[0];
  f.service.receipt(approved.runId, receipt);
  assert.equal(sourceReads, 0);
  f.adapters.verifySource = () => hashObject('corrupt source');
  assert.equal(f.service.snapshot(approved.runId).integrity.valid, false);
  await assert.rejects(f.service.command(approved.runId, 'run', f.request(approved)), {
    code: 'SOURCE_INTEGRITY',
  });
  assert.equal(f.calls(), 0);
});

test('history evaluates current runtime once and keeps stale context visible', async (t) => {
  const f = await fixture(t);
  await f.service.create(input, { runId: 'run-second' });
  let identities = 0;
  f.adapters.identity = () => {
    identities++;
    return hashObject('new runtime');
  };
  const list = f.service.listRuns();
  assert.equal(identities, 1);
  assert.equal(list.length, 2);
  assert.ok(list.every((run) => run.status === 'stale' && !run.integrity.valid));
});

for (const lockState of ['live', 'dead']) {
  test(`pending superseded replan handles a ${lockState} writer lock`, async (t) => {
    const f = await fixture(t),
      replace = f.adapters.replaceBinding;
    let s = await f.approve();
    s = await f.service.command(s.runId, 'run', f.request(s));
    f.adapters.replaceBinding = () => {
      throw new GraphError('INTERRUPTED', 'Interrupted handoff');
    };
    await assert.rejects(f.service.command(s.runId, 'replan', f.request(s)), {
      code: 'INTERRUPTED',
    });
    f.adapters.replaceBinding = replace;
    const old = f.service.store.readRun(s.runId);
    assert.equal(old.finalDisposition, 'superseded');
    const successor = Object.values(old.operations).find((op) => op.resultRunId).resultRunId;
    const lock = path.join(f.root, '.ai-orchestrator/graph/runs', s.runId, '.lock');
    writeFileSync(
      lock,
      JSON.stringify({
        version: 1,
        owner: randomUUID(),
        pid: lockState === 'dead' ? 2_147_483_647 : process.pid,
        processStart: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
    s = f.service.snapshot(s.runId);
    assert.equal(s.capabilities.recover.allowed, lockState === 'dead');
    if (lockState === 'live') {
      await assert.rejects(f.service.command(s.runId, 'recover', f.request(s)), {
        code: 'RECOVERY_DENIED',
      });
      assert.equal(f.service.store.inspectLock(s.runId).status, 'live');
    } else {
      const next = await f.service.command(s.runId, 'recover', f.request(s));
      assert.equal(next.runId, successor);
      assert.equal(f.service.store.inspectLock(s.runId), null);
      assert.equal(next.integrity.valid, true);
    }
  });
}

test('review receives full >32 KiB deletion evidence and binds final receipt to exact input', async (t) => {
  const content = `--- a/src/example.txt\n+++ /dev/null\n-${'x'.repeat(40000)}\n-deleted tail after excerpt limit\n`;
  const f = await fixture(t, { diff: () => ({ content, complete: true }) });
  const execute = f.adapters.execute;
  let reviewedHash;
  f.adapters.execute = async (args) => {
    if (args.node.action.id === 'ai-review') {
      assert.equal(args.reviewEvidence.implementations.length, 1);
      assert.equal(args.reviewEvidence.implementations[0].diff.artifact.content, content);
      assert.ok(Buffer.byteLength(canonicalJson(args.reviewEvidence)) > 32 * 1024);
      assert.ok(Buffer.byteLength(JSON.stringify(args.priorEvidence)) <= 32 * 1024);
      reviewedHash = hashObject(args.reviewEvidence);
    }
    return execute(args);
  };
  let s = await f.approve();
  s = await f.service.command(s.runId, 'run', f.request(s));
  assert.equal(s.status, 'waiting-for-human');
  const review = s.nodes.find((n) => n.id === 'review');
  assert.equal(
    f.service.receipt(s.runId, review.receiptIds.at(-1)).reviewEvidenceHash,
    reviewedHash,
  );
  assert.equal(
    JSON.parse(f.service.artifact(s.runId, review.artifacts[0].id).content).reviewEvidenceHash,
    reviewedHash,
  );
});

test('review missing or wrong evidence acknowledgment cannot pass or enable acceptance', async (t) => {
  for (const acknowledgment of [undefined, null, hashObject('wrong')]) {
    const f = await fixture(t),
      execute = f.adapters.execute;
    f.adapters.execute = async (args) => {
      const result = await execute(args);
      if (args.node.action.id === 'ai-review') {
        if (acknowledgment === undefined) delete result.output.reviewEvidenceHash;
        else result.output.reviewEvidenceHash = acknowledgment;
      }
      return result;
    };
    let s = await f.approve();
    s = await f.service.command(s.runId, 'run', f.request(s));
    assert.equal(s.nodes.find((n) => n.id === 'review').status, 'failed');
    assert.notEqual(s.nodes.find((n) => n.id === 'accept-result').status, 'waiting-for-human');
  }
});

test('oversize full evidence blocks review before adapter invocation without truncation', async (t) => {
  const f = await fixture(t, { diff: () => ({ content: 'x'.repeat(512 * 1024), complete: true }) });
  const execute = f.adapters.execute;
  let reviewCalls = 0;
  f.adapters.execute = async (args) => {
    if (args.node.action.id === 'ai-review') reviewCalls++;
    return execute(args);
  };
  let s = await f.approve();
  s = await f.service.command(s.runId, 'run', f.request(s));
  assert.equal(reviewCalls, 0);
  assert.notEqual(s.nodes.find((n) => n.id === 'review').status, 'passed');
  assert.equal(s.nodes.find((n) => n.id === 'review').status, 'failed');
  assert.match(s.nodes.find((n) => n.id === 'review').reason, /REVIEW_EVIDENCE_LIMIT/);
  assert.notEqual(s.nodes.find((n) => n.id === 'accept-result').status, 'waiting-for-human');
});

test('complete no-op implementation remains reviewable with explicit unchanged fingerprints', async (t) => {
  const f = await fixture(t, { diff: () => ({ content: '', complete: true }) });
  const execute = f.adapters.execute;
  f.adapters.execute = async (args) => {
    const result = await execute(args);
    if (args.node.action.id === 'ai-implement') {
      result.output.edits = [];
      result.output.changedFiles = [];
    }
    if (args.node.action.id === 'ai-review') {
      const entry = args.reviewEvidence.implementations[0];
      assert.equal(entry.receipt.beforeFingerprint, entry.receipt.afterFingerprint);
      assert.equal(entry.diff.artifact.content, '');
    }
    return result;
  };
  let s = await f.approve();
  s = await f.service.command(s.runId, 'run', f.request(s));
  assert.equal(s.status, 'waiting-for-human');
  assert.equal(s.nodes.find((n) => n.id === 'review').status, 'passed');
});

test('profile required checks enter immutable task and cannot be removed by draft JSON', async (t) => {
  const f = await fixture(
    t,
    {
      project: {
        version: 1,
        integrationBranch: 'main',
        packageManager: 'npm',
        contextPaths: [],
        manifests: [],
        outputPaths: [],
        checks: ['typecheck', 'tests'],
        ai: { provider: 'codex', model: 'test-model' },
      },
    },
    { ...input, checks: [] },
  );
  const state = f.service.store.readRun(f.snapshot.runId);
  const task = f.service.store.readObject('tasks', state.taskHash);
  assert.ok(task.checks.includes('typecheck'));
  assert.ok(task.checks.includes('tests'));
  const plan = f.service.store.readObject('plans', state.planHash);
  const draft = {
    nodes: plan.nodes.map((node) =>
      node.id !== 'typecheck'
        ? node
        : { ...node, action: { id: 'workspace-check', version: 1, inputs: {} }, permissions: [] },
    ),
  };
  await assert.rejects(
    () => f.service.create({ ...input, checks: [] }, { runId: 'run-missing-profile-check', draft }),
    { code: 'MISSING_REQUIRED_CHECK' },
  );
});

test('provider migration keeps historical plans readable and denies old execution', async (t) => {
  const f = await fixture(t);
  f.adapters.project = { ai: { provider: 'openai' } };
  f.drift();
  const historical = f.service.snapshot(f.snapshot.runId);
  assert.equal(historical.status, 'stale');
  assert.equal(historical.nodes.length, f.snapshot.nodes.length);
  assert.equal(historical.capabilities.run.allowed, false);
  assert.equal(f.service.plan(f.snapshot.runId).nodes.length, f.snapshot.nodes.length);
  assert.equal(f.service.listRuns()[0].task.id, input.id);
});


test('uncertain implementation keeps a sanitized explanation without saving proposed code', async (t) => {
  const f = await fixture(t);
  let applied = 0;
  f.adapters.applyEdits = () => { applied++; };
  const original = f.adapters.execute;
  f.adapters.execute = async (context) => {
    const result = await original(context);
    if (context.node.action.id === 'ai-implement') {
      result.output.verdict = 'uncertain';
      result.output.summary = 'Не удалось подтвердить ограничение';
      result.output.findings = [{ severity: 'blocking', message: 'Нужно уточнить контракт API', path: 'src/example.txt' }];
      result.output.edits[0].content = 'PROPOSED_CODE_MUST_NOT_BE_STORED';
    }
    return result;
  };
  let snapshot = await f.approve();
  snapshot = await f.service.command(snapshot.runId, 'run', f.request(snapshot));
  const node = snapshot.nodes.find((item) => item.id === 'implement');
  assert.equal(node.status, 'uncertain');
  assert.equal(node.reason, 'Нужно уточнить контракт API');
  const evidence = node.artifacts.find((item) => item.kind === 'review-findings');
  const artifact = f.service.artifact(snapshot.runId, evidence.id);
  assert.match(artifact.content, /Нужно уточнить контракт API/);
  assert.doesNotMatch(artifact.content, /PROPOSED_CODE_MUST_NOT_BE_STORED/);
  assert.equal(applied, 0);
});


test('подтвержденный таймаут сохраняет причину и не разрешает слепой повтор', async (t) => {
  const f = await fixture(t);
  f.adapters.execute = async ({ onStart }) => {
    await onStart({ pid: process.pid, ticket: 'timeout-fixture' });
    return { exitCode: 0, stopped: true, uncertain: true, timedOut: true, failureReason: 'TIMEOUT' };
  };
  let s = await f.approve();
  s = await f.service.command(s.runId, 'run', f.request(s));
  const node = s.nodes.find(item => item.status === 'uncertain');
  assert.match(node.reason, /Истек лимит времени/);
  assert.equal(node.capabilities.retry.allowed, false);
  assert.equal(f.service.receipt(s.runId, node.receiptIds.at(-1)).termination.timedOut, true);
});
