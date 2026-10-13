import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fixture } from '../scripts/ai-graph/test-support/provable-work.mjs';
import { inspectCheckProfile } from '../scripts/ai-graph/lib/check-profile.mjs';
import { inspectMobileWorkPreflight } from '../scripts/ai-graph/lib/mobile-work-preflight.mjs';
import { hashObject } from '../scripts/ai-graph/lib/io.mjs';

async function setup(t, rejectAt, { componentOnly = false } = {}) {
  const f = await fixture(t);
  const adapters = f.service.adapters;
  const definition = structuredClone(adapters.checkRegistry().definitions[0]);
  // Native registration is used only for negative callsite tests; its command
  // must not run. The component case retains the original real Node verifier.
  if (!componentOnly) definition.report.format = 'flowcairn-xctest/v1';
  definition.title = componentOnly ? 'Ordinary component control fixture' : 'Native prewrite negative fixture';
  definition.purpose = componentOnly ? 'Preserve the original Node behavior criterion; no native obligation'
    : 'Test known native preflight refusal; no native acceptance claim';
  const checkProfile = { version: 1, requiredCheckIds: ['tests'], definitions: [definition], environment: [] };
  const profile = { version: 2, manifests: [], checks: ['tests'], checkMode: 'trusted-local', outputPaths: ['reports'], checkProfile,
    developmentWorkflow: { version: 1, capabilities: ['build', 'scenario'].map(role => ({ id: `mobile-ios-${role}`, checkIds: ['tests'],
      ...(componentOnly ? { scope: ['Other'] } : {}) })) },
    ai: { model: 'injected fixture' } };
  adapters.workflowPolicy = 'developer-v1';
  adapters.checkRegistry = () => inspectCheckProfile(f.worktree, checkProfile);
  const calls = [], preflight = [];
  let writes = 0, proposals = 0;
  const execute = adapters.execute, apply = adapters.applyEdits;
  adapters.execute = async args => {
    calls.push(args.node.action.id);
    const result = await execute(args);
    if (args.node.action.id === 'ai-implement' && result.output?.edits?.length) proposals++;
    return result;
  };
  adapters.applyEdits = (...args) => { writes++; return apply(...args); };
  adapters.verifyWorkPreflight = (root, node, task, plan) => {
    const call = preflight.length + 1;
    try {
      const result = inspectMobileWorkPreflight({ root, profile, node, task, plan,
        // Inject only a host fact, not a fabricated SDK status or model result.
        // The real guard refuses explicit iOS on Windows independently of manifest discovery.
        hostPlatform: componentOnly || call === rejectAt ? 'win32' : 'darwin' });
      preflight.push({ call, result });
      return result;
    } catch (error) { preflight.push({ call, error: error.code }); throw error; }
  };
  const oracle = readFileSync(path.join(f.worktree, 'src/answer.test.mjs'));
  const source = readFileSync(path.join(f.worktree, 'src/answer.mjs'));
  return { f, calls, preflight, writes: () => writes, proposals: () => proposals, oracle, source };
}

async function assertStopped(c, result, expectedImplementations) {
  assert.equal(result.status, 'failed', JSON.stringify({ status: result.status, reason: result.failureReason, nodes: result.nodes }));
  assert.notEqual(result.proof.status, 'PROVEN');
  assert.equal(result.proof.certificate, null);
  assert.equal(c.calls.filter(action => action === 'ai-implement').length, expectedImplementations);
  assert.equal(c.writes(), 0);
  assert.equal(c.f.checks(), 0);
  assert.deepEqual(c.f.checkExitCodes(), []);
  assert.deepEqual(readFileSync(path.join(c.f.worktree, 'src/answer.mjs')), c.source);
  assert.deepEqual(readFileSync(path.join(c.f.worktree, 'src/answer.test.mjs')), c.oracle);
  const state = c.f.service.store.readRun(result.runId);
  const plan = c.f.service.store.readObject('plans', state.planHash);
  const work = plan.nodes.find(node => node.action.id === 'ai-implement');
  assert(work);
  assert.equal(state.nodes[work.id].status, 'failed');
  const receiptId = state.nodes[work.id].receipts.at(-1);
  const receipt = c.f.service.store.readObject('receipts', receiptId);
  assert.equal(hashObject(receipt), receiptId);
  assert.equal(receipt.phase, 'finished');
  assert.equal(receipt.verdict, 'fail');
  assert.match(receipt.failureReason, /^SDK_MISSING/);
  assert.equal(receipt.beforeFingerprint, receipt.afterFingerprint);
  assert.deepEqual(receipt.changedFiles, []);
  assert.equal(receipt.termination.stopped, true);
  assert.equal(receipt.termination.uncertain, false);
  const beforeRestart = { planHash: state.planHash, receipts: state.nodes[work.id].receipts, fingerprint: c.f.fingerprint().hash };
  await c.f.restart();
  const restarted = c.f.service.snapshot(result.runId);
  const stored = c.f.service.store.readRun(result.runId);
  assert.equal(restarted.status, 'failed');
  assert.notEqual(restarted.proof.status, 'PROVEN');
  assert.equal(stored.planHash, beforeRestart.planHash);
  assert.deepEqual(stored.nodes[work.id].receipts, beforeRestart.receipts);
  assert.equal(c.f.fingerprint().hash, beforeRestart.fingerprint);
  assert.equal(c.calls.filter(action => action === 'ai-implement').length, expectedImplementations);
  assert.equal(c.writes(), 0);
}

test('WorkflowService native preflight refuses known missing platform before inference with zero source effects', async t => {
  const c = await setup(t, 1);
  const result = await c.f.run();
  assert.deepEqual(c.preflight, [{ call: 1, error: 'SDK_MISSING' }]);
  assert.equal(c.proposals(), 0);
  await assertStopped(c, result, 0);
});

test('WorkflowService rechecks native preflight after AI proposal and refuses broker write when the environment changes', async t => {
  const c = await setup(t, 2);
  const result = await c.f.run();
  assert.equal(c.preflight.length, 2);
  assert.equal(c.preflight[0].result.status, 'needs-probe');
  assert.equal(c.preflight[0].result.acceptance, 'unverified');
  assert(c.preflight[0].result.findings.some(finding => finding.code === 'MOBILE_FRAMEWORK_UNKNOWN'));
  assert.deepEqual(c.preflight[1], { call: 2, error: 'SDK_MISSING' });
  assert.equal(c.proposals(), 1);
  await assertStopped(c, result, 1);
});

test('WorkflowService component work does not inherit a native obligation from a capability in another scope', async t => {
  const c = await setup(t, 0, { componentOnly: true });
  const result = await c.f.run();
  assert.equal(result.status, 'passed', JSON.stringify({ status: result.status, reason: result.failureReason, preflight: c.preflight }));
  assert.equal(result.proof.status, 'PROVEN', 'This proves only the original Node behavior criterion, never native mobile acceptance');
  assert.deepEqual(c.preflight, [{ call: 1, result: null }, { call: 2, result: null }]);
  assert.equal(c.calls.filter(action => action === 'ai-implement').length, 1);
  assert.equal(c.writes(), 1);
  assert.equal(c.proposals(), 1);
  assert.equal(c.f.checks(), 1);
  assert.deepEqual(c.f.checkExitCodes(), [0]);
  assert.deepEqual(readFileSync(path.join(c.f.worktree, 'src/answer.test.mjs')), c.oracle);
});
