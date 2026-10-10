import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkflowService } from './lib/service.mjs';
import { SKILL_ROUTES } from './lib/config.mjs';
import { hashObject } from './lib/io.mjs';

const hash = hashObject('consent-regression');
const skills = [...new Set(Object.values(SKILL_ROUTES).flat())].map(id => ({ id, path: `skills/${id}/SKILL.md`, hash }));
const input = { id: 'CONSENT-TEST', goal: 'Fix typo', instructions: 'Fix typo in the title', scope: ['README.md'], acceptance: ['Title is corrected'], checks: [] };
const request = (s, extra = {}) => ({ operationId: `op-${randomUUID()}`, expectedRevision: s.revision, planHash: s.planHash, ...extra });

async function fixture(t, provider, { workflow = 'autonomous', available = false, dataVersion = 2, reviewFails = 0 } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flowcairn-consent-'));
  const executable = provider === 'claude' ? path.join(root, 'node_modules/@anthropic-ai/claude-code/bin/claude.exe') : path.join(root, 'fake-cursor');
  mkdirSync(path.dirname(executable), { recursive: true });
  if (provider === 'claude') writeFileSync(path.join(path.dirname(executable), '../package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.198' }));
  const version = provider === 'claude' ? '2.1.198 (Claude Code)' : 'fixture-cli 1.0';
  // Only the toolchain probe runs a process. AI execution below is an injected fixture.
  writeFileSync(executable, `#!${process.execPath}\nconst args=process.argv.slice(2);
    if(args[0]==='--version') console.log(${JSON.stringify(version)});
    else if(args.includes('--help')) console.log('--print --output-format --sandbox --mode');
    else if(args[0]==='auth') console.log('{"loggedIn":true}');
    else if(args[0]==='status') {
      require('node:assert/strict').deepEqual(args, ['status', '--format', 'json']);
      console.log(JSON.stringify({isAuthenticated:true}));
    }
    else throw Error('Live inference forbidden');`, { mode: 0o700 });
  const calls = [];
  const git = { head: 'a'.repeat(40), indexHash: hash }, files = [];
  const adapters = {
    dataVersion, hasReadConsent: () => true, identity: () => hash, skills: () => skills,
    checkRegistry: () => ({ version: 1, profileHash: hash, definitions: [], bindings: [] }),
    project: { contextPaths: [], manifests: [], outputPaths: [], ai: { provider, providerPath: executable, providerVersion: version } },
    capture: () => ({ manifest: { sourceHash: hash }, bundlePath: 'synthetic' }),
    allocate: ({ task, runId }) => ({ worktree: root, taskId: task.id, runId, attemptId: 1, leaseId: 'synthetic', sourceHash: hash }),
    verifyBinding: () => true, replaceBinding: ({ binding, newRunId }) => ({ ...binding, runId: newRunId }),
    fingerprint: () => ({ hash: hashObject({ files, git }), files, git }),
    inspectChanges: () => ({ allowed: true, changedFiles: [] }), applyEdits: () => {}, diff: () => ({ content: '', complete: true }),
    resolveSkills: node => node.action.id.startsWith('ai-') ? [...node.skills] : [], resolveReadPaths: node => node.resources.reads,
    loadSkills: ids => ids.map(name => ({ name, text: 'synthetic skill', hash, path: `skills/${name}/SKILL.md` })),
    runner: { ai: { available }, checks: { available: true } },
    execute: async ({ node, onStart, providerConsent, reviewEvidence }) => {
      calls.push({ action: node.action.id, providerConsent });
      await onStart({ ticket: 'synthetic', pid: process.pid });
      const failed = node.action.id === 'ai-review' && reviewFails-- > 0;
      return { exitCode: 0, stopped: true, uncertain: false, output: {
        summary: 'Synthetic result', verdict: failed ? 'fail' : 'pass', skillsUsed: node.skills,
        findings: failed ? [{ severity: 'blocking', path: 'README.md', message: 'Title still wrong' }] : [], changedFiles: [], edits: [], plan: [],
        ...(node.action.id === 'ai-plan' ? { steps: [{ id: 'fix-title', title: 'Fix title', outcome: 'Title is corrected', needs: [], paths: ['README.md'], requirementIds: ['req-001'] }] } : {}),
        ...(reviewEvidence ? { reviewEvidenceHash: hashObject(reviewEvidence) } : {}),
      } };
    },
  };
  const service = await WorkflowService.open({ root, adapters });
  t.after(async () => { await Promise.all([...service.drives.values()]); service.close(); rmSync(root, { recursive: true, force: true }); });
  const initial = await service.create(input, { runId: 'consent-test', workflow, stage: 'planning' });
  const settle = async s => {
    for (let i = 0; i < 8; i++) {
      await Promise.all([...service.drives.values()]); s = service.snapshot(s.runId);
      if (s.successorRunId) { s = service.snapshot(s.successorRunId); continue; }
      return s;
    }
    throw Error('Too many transitions');
  };
  const gateRequest = (s, nodeId = 'provider-consent', decision = 'approve') => {
    const gate = s.gates.find(item => item.nodeId === nodeId);
    assert.ok(gate, JSON.stringify(s.integrity));
    return request(s, { nodeId, decision, permissions: gate.requiredPermissions, challenge: gate.challenge });
  };
  const decide = (s, nodeId, decision) => service.command(s.runId, 'gate', gateRequest(s, nodeId, decision));
  return { service, initial, calls, settle, gateRequest, decide };
}

for (const provider of ['claude', 'cursor']) {
  for (const scenario of ['approved', 'missing-consent', 'expired', 'exact-deadline', 'invalid-grant']) {
    test(`${provider} repair restart ${scenario} respects durable consent, policy and deadline`, async t => {
      const f = await fixture(t, provider, { available: true, reviewFails: 1 });
      let s = await f.settle(await f.decide(f.initial));
      s = await f.decide(s);
      s = await f.settle(await f.decide(s, 'approve-plan'));
      assert.equal(f.service.store.readRun(s.runId).policyGrant.cycle, 1);
      let command;
      if (scenario !== 'missing-consent') {
        // Simulate process loss after durable gate write, before the queued drive.
        f.service.drives.set(s.runId, Promise.resolve());
        try { command = f.gateRequest(s); s = await f.service.command(s.runId, 'gate', command); }
        finally { f.service.drives.delete(s.runId); }
        assert.equal(f.service.store.readRun(s.runId).nodes['approve-plan'].status, 'waiting-for-human');
      }
      const before = f.service.store.readRun(s.runId), calls = f.calls.length;
      assert.deepEqual(before.permissions, []);
      if (scenario === 'invalid-grant') f.service.store.updateRun(s.runId, before.revision,
        state => ({ ...state, policyGrant: { ...state.policyGrant, planHash: hashObject('unrelated plan') } }));
      assert.equal(f.service.close(), true);
      const plan = f.service.store.readObject('plans', before.planHash);
      const clock = ['expired', 'exact-deadline'].includes(scenario) ? t.mock.method(Date, 'now',
        () => Date.parse(before.policyGrant.startedAt) + plan.autonomy.maxDurationMs + (scenario === 'expired' ? 1 : 0)) : null;
      let reopened;
      try {
        reopened = await WorkflowService.open({ root: f.service.root, adapters: f.service.adapters });
        await Promise.all([...reopened.drives.values()]);
        const after = reopened.snapshot(s.runId), state = reopened.store.readRun(s.runId);
        assert.equal(after.integrity.valid, scenario !== 'invalid-grant', after.integrity.reason);
        if (scenario === 'approved') {
          assert.equal(after.status, 'passed');
          assert.equal(f.calls.filter(call => call.action === 'ai-implement').length, 2);
          assert.ok(state.permissions.includes('workspace.source.write'));
          assert.equal(state.nodes['approve-plan'].receipts.length, 1);
          assert.equal(state.policyGrant.startedAt, before.policyGrant.startedAt);
          const completedCalls = f.calls.length;
          await reopened.command(s.runId, 'gate', command);
          await Promise.all([...reopened.drives.values()]);
          assert.equal(f.calls.length, completedCalls, 'gate replay must not execute repair twice');
        } else {
          assert.equal(f.calls.length, calls);
          assert.deepEqual(state.permissions, []);
          assert.equal(state.nodes['approve-plan'].receipts.length, 0);
          if (['expired', 'exact-deadline'].includes(scenario)) {
            assert.match(state.failureReason, /Истек срок/);
            await assert.rejects(reopened.command(s.runId, 'run', request(after)), { code: 'CONTROL_DENIED' });
          }
          if (scenario === 'missing-consent') {
            await reopened.command(s.runId, 'gate', f.gateRequest(after));
            await Promise.all([...reopened.drives.values()]);
            assert.equal(reopened.snapshot(s.runId).status, 'passed');
            assert.equal(f.calls.filter(call => call.action === 'ai-implement').length, 2);
            assert.equal(reopened.store.readRun(s.runId).nodes['approve-plan'].receipts.length, 1);
          }
        }
      } finally {
        if (reopened) { await Promise.all([...reopened.drives.values()]); assert.equal(reopened.close(), true); }
        clock?.mock.restore();
      }
    });
  }

  for (const decision of ['approve', 'reject']) test(`${provider} autonomous provider ${decision} preserves V3 read permission and replays once`, async t => {
    const f = await fixture(t, provider, { dataVersion: 3 });
    const command = f.gateRequest(f.initial, 'provider-consent', decision);
    let s = await f.service.command(f.initial.runId, 'gate', command);
    assert.equal(s.integrity.valid, true, s.integrity.reason);
    s = await f.settle(s);
    const state = f.service.store.readRun(s.runId);
    assert.deepEqual(state.permissions, ['ai.read']);
    const receiptIds = state.nodes['provider-consent'].receipts;
    assert.equal(receiptIds.length, 1);
    const receipt = f.service.receipt(s.runId, receiptIds[0]);
    assert.deepEqual(receipt.grantedPermissions, ['ai.read']);
    assert.equal(Boolean(receipt.providerConsentHash), decision === 'approve');
    if (decision === 'reject') assert.equal(s.finalDisposition, 'rejected');
    const replayed = await f.service.command(s.runId, 'gate', command);
    assert.equal(replayed.integrity.valid, true);
    assert.deepEqual(f.service.store.readRun(s.runId).nodes['provider-consent'].receipts, receiptIds);
    await assert.rejects(f.service.command(s.runId, 'gate', { ...command, decision: decision === 'approve' ? 'reject' : 'approve' }), { code: 'IDEMPOTENCY_CONFLICT' });
    assert.equal(f.calls.length, 0);
  });

  test(`${provider} autonomous plan and repair each require fresh consent without losing permission integrity`, async t => {
    const f = await fixture(t, provider, { available: true, reviewFails: 1 });
    let s = await f.settle(await f.decide(f.initial));
    assert.equal(s.integrity.valid, true, s.integrity.reason);
    assert.equal(s.phase, 'execution');
    const firstConsent = f.calls[0].providerConsent.hash;
    assert.equal(f.service.store.readRun(s.runId).providerConsentHash, undefined);
    await assert.rejects(f.service.command(s.runId, 'gate', {
      ...f.gateRequest(s), planHash: f.initial.planHash,
    }), { code: 'PLAN_CONFLICT' });
    assert.equal(f.calls.some(call => call.action === 'ai-implement'), false);
    s = await f.decide(s);
    assert.deepEqual(f.service.store.readRun(s.runId).permissions, []);
    s = await f.settle(await f.decide(s, 'approve-plan'));
    assert.equal(s.integrity.valid, true, s.integrity.reason);
    const repair = f.service.store.readRun(s.runId);
    assert.equal(repair.policyGrant.cycle, 1);
    assert.equal(repair.providerConsentHash, undefined);
    assert.equal(repair.nodes['approve-plan'].status, 'pending');
    assert.equal(f.calls.filter(call => call.action === 'ai-implement').length, 1);
    s = await f.settle(await f.decide(s));
    assert.equal(s.integrity.valid, true, s.integrity.reason);
    assert.equal(s.status, 'passed');
    assert.equal(f.calls.filter(call => call.action === 'ai-implement').length, 2);
    const consentHashes = new Set(f.calls.map(call => call.providerConsent.hash));
    assert.equal(consentHashes.size, 3);
    assert.ok(consentHashes.has(firstConsent));
    const final = f.service.store.readRun(s.runId);
    assert.ok(final.permissions.includes('workspace.source.write'));
    assert.deepEqual(f.service.receipt(s.runId, final.nodes['provider-consent'].receipts[0]).grantedPermissions, []);
    f.service.store.updateRun(final.runId, final.revision, state => ({ ...state, permissions: ['ai.read'] }));
    assert.equal(f.service.snapshot(s.runId).integrity.valid, false, 'repair permissions must still match the approved plan');
  });

  test(`${provider} manual consent receipt remains bound to initial grants after plan approval`, async t => {
    const f = await fixture(t, provider, { workflow: 'manual' });
    let s = await f.decide(f.initial);
    const consentReceipt = f.service.store.readRun(s.runId).nodes['provider-consent'].receipts[0];
    assert.deepEqual(f.service.receipt(s.runId, consentReceipt).grantedPermissions, []);
    s = await f.decide(s, 'approve-plan');
    assert.equal(s.integrity.valid, true, s.integrity.reason);
    assert.deepEqual(f.service.store.readRun(s.runId).permissions, ['ai.read']);
    assert.deepEqual(f.service.receipt(s.runId, consentReceipt).grantedPermissions, []);
    assert.equal(f.calls.length, 0);
  });

  test(`${provider} provider consent cannot grant workspace writes or weaken receipt validation`, async t => {
    const f = await fixture(t, provider);
    await assert.rejects(f.service.command(f.initial.runId, 'gate', { ...f.gateRequest(f.initial), permissions: ['workspace.source.write'] }), { code: 'PERMISSION_GRANT' });
    const s = await f.settle(await f.decide(f.initial));
    const state = f.service.store.readRun(s.runId);
    const receipt = f.service.store.readObject('receipts', state.nodes['provider-consent'].receipts[0]);
    const forged = f.service.store.putObject('receipts', { ...receipt, grantedPermissions: [] });
    state.nodes['provider-consent'].receipts = [forged];
    f.service.store.updateRun(state.runId, state.revision, () => state);
    assert.equal(f.service.snapshot(s.runId).integrity.valid, false);
  });
}
