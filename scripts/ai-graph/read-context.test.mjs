import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createReadContext } from './lib/read-context.mjs';
import { WorkflowService } from './lib/service.mjs';
import { hashObject } from './lib/io.mjs';
import { SKILL_ROUTES } from './lib/config.mjs';
import { compileTaskProposal } from './lib/planning.mjs';
import { TaskSpecSchema } from './lib/schemas.mjs';
import { resolveAction } from './lib/registry.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flowcairn-read-context-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'AGENTS.md');
  writeFileSync(file, 'first instructions');
  return { root, file };
}

test('read projection shares discovery but the next request and unscoped checks read fresh files', t => {
  const { file } = fixture(t), context = createReadContext();
  let reads = 0;
  const discovery = () => context.memo('instructions', () => {
    reads++;
    return { text: readFileSync(file, 'utf8'), scopes: ['src'] };
  });
  context.run(() => {
    const first = discovery();
    first.scopes.push('outside');
    assert.deepEqual(discovery().scopes, ['src']);
    context.run(() => assert.equal(discovery().text, 'first instructions'));
    assert.equal(reads, 1);
  });
  writeFileSync(file, 'changed instructions');
  context.run(() => {
    assert.equal(discovery().text, 'changed instructions');
    discovery();
    assert.equal(reads, 2);
  });
  discovery();
  discovery();
  assert.equal(reads, 4, 'command-side calls outside a projection must not reuse values');
});

test('discovery keys distinguish action and scope, and exceptions discard the request', () => {
  const context = createReadContext();
  let reads = 0;
  const discover = (action, scope) => context.memo(JSON.stringify(['skills', action, scope]), () => ++reads);
  assert.throws(() => context.run(() => {
    assert.equal(discover('ai-plan', ['src']), 1);
    assert.equal(discover('ai-plan', ['src']), 1);
    assert.equal(discover('ai-review', ['src']), 2);
    assert.equal(discover('ai-plan', ['tests']), 3);
    throw new Error('failed projection');
  }), /failed projection/);
  context.run(() => assert.equal(discover('ai-plan', ['src']), 4));
});

test('read context cannot span asynchronous callbacks or returned promises', () => {
  const context = createReadContext();
  let invoked = false, reads = 0;
  assert.throws(() => context.run(async () => { invoked = true; }), { code: 'READ_CONTEXT_ASYNC' });
  assert.equal(invoked, false);
  assert.throws(() => context.run(() => {
    context.memo('value', () => ++reads);
    return Promise.resolve();
  }), { code: 'READ_CONTEXT_ASYNC' });
  assert.equal(context.memo('value', () => ++reads), 2);
});

test('snapshot and listRuns scope discovery while a subsequent command detects changed context', async t => {
  const { root, file } = fixture(t), context = createReadContext();
  const hash = hashObject('read-context-service');
  const skills = [...new Set(Object.values(SKILL_ROUTES).flat())]
    .map(id => ({ id, path: `skills/${id}/SKILL.md`, hash }));
  let scopes = 0, depth = 0, reads = 0;
  const discovery = () => context.memo('instructions', () => {
    reads++;
    return readFileSync(file, 'utf8');
  });
  const service = await WorkflowService.open({ root, adapters: {
    withReadContext: callback => context.run(() => {
      if (!depth) scopes++;
      depth++;
      try { return callback(); } finally { depth--; }
    }),
    identity: () => hash,
    skills: () => { discovery(); return skills; },
    contextHash: () => hashObject(discovery()),
    capture: () => ({ manifest: { sourceHash: hash }, bundlePath: 'fixture-source' }),
    runner: { ai: { available: true }, checks: { available: true } },
  } });
  t.after(() => service.close());
  const snapshot = await service.create({ id: 'READ-CONTEXT', goal: 'Verify read boundaries',
    instructions: 'Change a synthetic source', scope: ['src'], acceptance: ['Synthetic source checked'], checks: ['graph-tests'] },
  { runId: 'read-context-run' });
  for (const read of [() => service.snapshot(snapshot.runId), () => service.listRuns()]) {
    const previousReads = reads, previousScopes = scopes;
    read();
    assert.equal(reads - previousReads, 1, 'skills and contextHash share one discovery');
    assert.equal(scopes - previousScopes, 1);
    assert.equal(depth, 0);
  }
  writeFileSync(file, 'new instructions after snapshot');
  const gate = snapshot.gates[0];
  await assert.rejects(service.command(snapshot.runId, 'gate', {
    operationId: 'changed-read-context', expectedRevision: snapshot.revision, planHash: snapshot.planHash,
    nodeId: gate.nodeId, decision: 'approve', permissions: gate.requiredPermissions, challenge: gate.challenge,
  }), error => /CONTEXT|DRIFT/.test(error.code));
  assert.equal(service.snapshot(snapshot.runId).integrity.valid, false);
  assert.equal(service.listRuns()[0].integrity.valid, false);
  assert.equal(depth, 0);
});

test('ten-step compilation shares discovery only within each phase and rejects later file drift', async t => {
  const { root, file } = fixture(t), memo = createReadContext();
  const hash = hashObject('ten-step-phase');
  const manifests = [...new Set(Object.values(SKILL_ROUTES).flat())]
    .map(id => ({ id, path: `skills/${id}/SKILL.md`, hash }));
  let active = null, unscopedReads = 0, fingerprints = 0;
  const fingerprint = { files: [], git: { head: null, indexHash: hash } };
  const currentFingerprint = { ...fingerprint, hash: hashObject(fingerprint) };
  const phases = [];
  const withReadContext = callback => {
    if (active) return memo.run(callback);
    active = { instructions: 0, skills: new Map() };
    phases.push(active);
    try { return memo.run(callback); } finally { active = null; }
  };
  const instructions = () => memo.memo('instructions', () => {
    if (active) active.instructions++;
    else unscopedReads++;
    return readFileSync(file, 'utf8');
  });
  const contextual = (action, scope) => {
    const key = JSON.stringify([action, scope]);
    return memo.memo(key, () => {
      if (active) active.skills.set(key, (active.skills.get(key) ?? 0) + 1);
      else unscopedReads++;
      readFileSync(file, 'utf8');
      return resolveAction(action).skills;
    });
  };
  const adapters = {
    withReadContext, identity: () => hash,
    skills: task => {
      for (const action of ['ai-plan', 'ai-analyze', 'ai-implement', 'ai-review']) contextual(action, task.scope);
      instructions();
      return manifests;
    },
    contextHash: () => hashObject(instructions()),
    resolveSkills: (node, task) => node.action.id.startsWith('ai-')
      ? contextual(node.action.id, node.resources.writes.length ? node.resources.writes : task.scope)
      : resolveAction(node.action.id).skills,
    resolveReadPaths: node => { if (node.action.id.startsWith('ai-')) instructions(); return node.resources.reads; },
    capture: () => {
      assert.equal(active, null, 'capture is not inside a discovery phase');
      return { manifest: { sourceHash: hash }, bundlePath: 'fixture-source' };
    },
    verifyBinding: () => true,
    fingerprint: () => {
      assert.equal(active, null, 'workspace freshness is checked outside the discovery phase');
      fingerprints++;
      return currentFingerprint;
    },
    runner: { ai: { available: true }, checks: { available: true } },
  };
  const input = { id: 'TEN-STEPS', goal: 'Ten synthetic outcomes', instructions: 'Implement a bounded synthetic plan',
    scope: ['src'], acceptance: Array.from({ length: 15 }, (_, index) => `Criterion ${index}`), checks: ['tests'] };
  const task = TaskSpecSchema.parse({ ...input, schemaVersion: 2, sourceHash: hash });
  const output = { summary: 'Synthetic plan', verdict: 'pass', skillsUsed: ['project-context'], findings: [], changedFiles: [], edits: [], plan: [],
    steps: Array.from({ length: 10 }, (_, index) => ({ id: `part-${index}`, title: `Part ${index}`, outcome: `Outcome ${index}`,
      needs: index ? [`part-${index - 1}`] : [], paths: [`src/part-${index}.mjs`] })) };
  const context = { runtimeHash: hash, workflow: 'autonomous', skills: manifests,
    resolveSkills: adapters.resolveSkills, resolveReadPaths: adapters.resolveReadPaths, contextHash: hashObject('first instructions') };
  const expected = withReadContext(() => compileTaskProposal(task, output, context).plan);
  phases.length = 0;
  const service = await WorkflowService.open({ root, adapters });
  t.after(() => service.close());
  for (const method of ['putObject', 'createRun', 'updateRun']) {
    const original = service.store[method].bind(service.store);
    service.store[method] = (...args) => {
      assert.equal(active, null, `${method} must not share cached discovery across a mutation`);
      return original(...args);
    };
  }
  const created = await service.create(input, { runId: 'ten-step-run', workflow: 'autonomous', stage: 'execution',
    draft: { nodes: expected.nodes }, taskContract: expected.taskContract });
  assert.equal(unscopedReads, 0, 'compile and validate must batch their repeated discovery');
  assert.equal(created.planHash, hashObject(expected), 'optimization must preserve the exact compiled plan');
  const inspectPhases = () => {
    assert.ok(phases.length >= 2, 'creation and its readback must be independent phases');
    for (const phase of phases) {
      assert.equal(phase.instructions, 1);
      assert.ok([...phase.skills.values()].every(count => count === 1));
    }
    assert.equal(active, null);
  };
  inspectPhases();
  service.store.updateRun(created.runId, created.revision, state => ({ ...state,
    binding: { worktree: root, taskId: input.id, attemptId: 1, leaseId: 'synthetic-lease', sourceHash: hash },
    workspaceFingerprint: currentFingerprint, initialFingerprint: currentFingerprint,
  }));
  const previousCount = phases.length;
  const latest = service.snapshot(created.runId);
  assert.equal(fingerprints, 1, 'proof still performs its independent workspace check');
  assert.ok(phases.length > previousCount, 'next read starts with fresh discovery');
  writeFileSync(file, 'changed rules between phases');
  const gate = latest.gates[0];
  await assert.rejects(service.command(created.runId, 'gate', { operationId: 'changed-ten-step-context',
    expectedRevision: latest.revision, planHash: latest.planHash, nodeId: gate.nodeId,
    decision: 'approve', permissions: gate.requiredPermissions, challenge: gate.challenge }),
  error => /CONTEXT|DRIFT/.test(error.code));
  assert.equal(service.snapshot(created.runId).integrity.valid, false);
  inspectPhases();
});
