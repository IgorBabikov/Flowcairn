import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { GraphError, hashObject, sha256 } from './lib/io.mjs';
import { createLearningJobAdapter } from './lib/learning-job-adapter.mjs';

const hash = value => hashObject(value);
const complete = () => ({ exitCode: 0, stopped: true, uncertain: false, timedOut: false, outputLimit: false, signal: null, failureReason: null, durationMs: 1 });
const root = path.join(os.tmpdir(), 'flowcairn-adapter-root');

function fixture({ prompt = 'Saved fixture code', kind = 'lesson', preflight = 'allowed' } = {}) {
  const events = [], transportCalls = [], disposals = [];
  let ai = { provider: 'codex', model: 'configured-model' }, defaults = { model: 'provider-default' }, text = prompt, output = Buffer.from('{"fixture":true}');
  let command = { executable: process.execPath, args: ['fixture-only'], cwd: path.join(os.tmpdir(), 'flowcairn-adapter-scratch'), env: { LANG: 'C.UTF-8' } };
  const input = { store: {}, materialHash: hash('material'), methodHash: hash('method'), policy: {},
    binding: { runId: 'run-test', planHash: hash('plan'), taskHash: hash('task'), materialHashes: [hash('material')] },
    ...(kind === 'question' ? { question: { text: 'Что происходит?', lessonHash: hash('lesson'), anchor: {} } } : {}) };
  const receipt = { allowed: preflight === 'allowed', provider: 'codex', cliVersion: 'fixture-version', policyHash: hash('preflight'),
    verifiedAt: '2026-10-08T12:00:00.000Z', code: preflight === 'allowed' ? null : 'LEARNING_MANAGED_POLICY_CONFLICT', reason: 'Fixture refusal' };
  const prepared = { capability: { allowed: false, code: 'LEARNING_CODEX_PREFLIGHT_REQUIRED', reason: 'Fixture preflight required' },
    inputHash: sha256(text), schemaHash: hash('schema'), methodHash: input.methodHash, materialHash: input.materialHash,
    preparationHash: hash('preparation'), kind, timeoutMs: 120000, maxOutputBytes: 2 * 1024 * 1024 };
  const api = {
    capability: ({ provider }) => ({ allowed: false, code: 'LEARNING_PROVIDER_UNSUPPORTED', reason: `Fixture ${provider} unsupported` }),
    prepare: options => { events.push('prepare'); assert.equal(options.materialHash, input.materialHash); return prepared; },
    preflight: async (value, { toolchain }) => { events.push('preflight'); assert.equal(value, prepared); assert.equal(toolchain.digest, hash('toolchain'));
      if (preflight === 'throw') throw new GraphError('LEARNING_MANAGED_POLICY_CONFLICT', 'Fixture policy denied');
      prepared.capability = receipt; return receipt; },
    command: value => { events.push('command'); assert.equal(value, prepared); return command; },
    readInput: value => { events.push('readInput'); assert.equal(value, prepared); return text; },
    readResult: value => { events.push('readResult'); assert.equal(value, prepared); return output; },
    parse: (value, result) => { events.push('parse'); assert.equal(value, prepared); return { kind, materialHash: value.materialHash, ...result }; },
    dispose: (value, options) => { events.push('dispose'); assert.equal(value, prepared); disposals.push(options); },
  };
  const transport = async options => {
    events.push('transport'); transportCalls.push(options);
    options.onStart({ ticket: 'fixture-ticket' });
    options.beforeGo({ commandHash: hashObject(options.command), inputHash: sha256(options.input) });
    events.push('dispatched');
    return complete();
  };
  const settings = () => ai, toolchain = () => { events.push('toolchain'); return { digest: hash('toolchain') }; };
  const create = (overrides = {}) => createLearningJobAdapter({ root, settings, toolchain, transport, providerApi: api, modelSettings: () => defaults, ...overrides });
  return { adapter: create(), create, input, prepared, receipt, api, events, transportCalls, disposals,
    settings: value => { ai = value; }, defaults: value => { defaults = value; }, prompt: value => { text = value; }, command: value => { command = value; }, output: value => { output = value; } };
}

test('cheap capability requires a concrete Codex model without any real preflight, toolchain probe or fallback', async () => {
  let ai = { provider: 'codex', model: 'configured-model' };
  const adapter = createLearningJobAdapter({ root, settings: () => ai,
    modelSettings: () => ({ model: 'provider-default' }), toolchain: () => assert.fail('Capability must not inspect/probe CLI'), transport: () => assert.fail('No provider execution') });
  assert.deepEqual(adapter.capability(), { allowed: true, reason: null });
  for (const provider of ['claude', 'cursor', 'unknown']) {
    ai = { provider, model: 'configured-model' };
    assert.equal(adapter.capability().allowed, false);
    await assert.rejects(adapter.prepare({}), error => /^LEARNING_/.test(error.code));
  }
  for (const model of [undefined, '', 'provider-default', 'default', 'auto', '../invalid model']) {
    ai = { provider: 'codex', model };
    assert.equal(adapter.capability().allowed, false);
    await assert.rejects(adapter.prepare({}), { code: 'LEARNING_MODEL_INVALID' });
  }
});

test('preparation exposes immutable hashes and memory-only command/input after successful explicit preflight', async () => {
  const f = fixture(), handle = await f.adapter.prepare(f.input);
  assert.equal(handle.input, 'Saved fixture code');
  assert.equal(handle.inputHash, sha256(handle.input));
  assert.deepEqual(handle.providerBinding, { provider: 'codex', model: 'configured-model', toolchainHash: hash('toolchain'), preflightHash: hashObject(f.receipt), policyHash: f.receipt.policyHash });
  assert.equal(handle.preparationHash, f.prepared.preparationHash);
  assert.equal(handle.materialHash, f.input.materialHash);
  assert.equal(handle.methodHash, f.input.methodHash);
  assert.equal(handle.schemaHash, f.prepared.schemaHash);
  assert.equal(handle.timeoutMs, 120000);
  assert.equal(handle.maxOutputBytes, 2 * 1024 * 1024);
  for (const object of [handle, handle.command, handle.command.args, handle.command.env, handle.providerBinding]) assert.equal(Object.isFrozen(object), true);
  assert.equal('prepared' in handle, false);
  assert.equal('scratch' in handle, false);
  assert.ok(f.events.indexOf('prepare') < f.events.indexOf('preflight'));
  assert.ok(f.events.indexOf('preflight') < f.events.indexOf('command'));
  assert.equal(f.transportCalls.length, 0);
});

test('provider-default resolves to the configured Codex model and config changes are rechecked before go', async () => {
  const f = fixture();
  f.settings({ provider: 'codex', model: 'provider-default', modelMode: 'provider' });
  f.defaults({ model: 'configured-provider-model' });
  const prepare = f.api.prepare;
  f.api.prepare = options => { assert.equal(options.model, 'configured-provider-model'); return prepare(options); };
  assert.equal(f.adapter.capability().allowed, true);
  const handle = await f.adapter.prepare(f.input);
  assert.equal(handle.providerBinding.model, 'configured-provider-model');
  f.defaults({ model: 'changed-provider-model' });
  assert.throws(() => f.adapter.beforeGo(handle), { code: 'LEARNING_PROVIDER_DRIFT' });
  f.defaults({ model: 'provider-default' });
  assert.equal(f.adapter.capability().allowed, false);
});

test('failed or false preflight disposes unstarted scratch before returning any handle', async () => {
  for (const preflight of ['denied', 'throw']) {
    const f = fixture({ preflight });
    await assert.rejects(f.adapter.prepare(f.input), { code: 'LEARNING_MANAGED_POLICY_CONFLICT' });
    assert.deepEqual(f.disposals, [{ stopped: true }]);
    assert.equal(f.transportCalls.length, 0);
  }
  const f = fixture();
  f.api.preflight = async () => ({ ...f.receipt, allowed: true }); // Prepared capability remains false.
  await assert.rejects(f.adapter.prepare(f.input), { code: 'LEARNING_CODEX_PREFLIGHT_REQUIRED' });
  assert.deepEqual(f.disposals, [{ stopped: true }]);
});

test('128 KiB UTF-8 input and control packet bounds fail closed before job commit without truncating', async () => {
  const large = fixture({ prompt: 'Ж'.repeat(65537) });
  await assert.rejects(large.adapter.prepare(large.input), { code: 'LEARNING_INPUT_LIMIT' });
  assert.equal(large.events.includes('preflight'), false);
  assert.equal(large.events.includes('toolchain'), false);
  assert.deepEqual(large.disposals, [{ stopped: true }]);
  const edge = fixture({ prompt: 'Ж'.repeat(65536) });
  assert.equal(Buffer.byteLength((await edge.adapter.prepare(edge.input)).input), 128 * 1024);
  const packet = fixture();
  packet.command({ executable: process.execPath, args: [], cwd: root, env: { LARGE: 'x'.repeat(256 * 1024) } });
  await assert.rejects(packet.adapter.prepare(packet.input), { code: 'LEARNING_TRANSPORT_LIMIT' });
  assert.deepEqual(packet.disposals, [{ stopped: true }]);
});

test('beforeGo rechecks current model, exact L2 input and exact command identity', async () => {
  for (const mutate of [f => f.settings({ provider: 'codex', model: 'changed-model' }), f => f.prompt('Changed saved input'),
    f => f.command({ executable: process.execPath, args: ['changed'], cwd: root, env: {} })]) {
    const f = fixture(), handle = await f.adapter.prepare(f.input);
    mutate(f);
    assert.throws(() => f.adapter.beforeGo(handle), error => ['LEARNING_PROVIDER_DRIFT', 'LEARNING_PREPARATION_CHANGED'].includes(error.code));
    assert.equal(f.transportCalls.length, 0);
  }
  const f = fixture();
  const original = f.api.preflight;
  f.api.preflight = async (...args) => { const result = await original(...args); f.settings({ provider: 'codex', model: 'changed-during-preflight' }); return result; };
  await assert.rejects(f.adapter.prepare(f.input), { code: 'LEARNING_PROVIDER_DRIFT' });
  assert.deepEqual(f.disposals, [{ stopped: true }]);
});

test('supervisor receives only learning action, exact bounds and input after durable start and host guards', async () => {
  for (const kind of ['lesson', 'question']) {
    const f = fixture({ kind }), handle = await f.adapter.prepare(f.input), signal = new AbortController().signal;
    f.events.length = 0;
    const completion = await f.adapter.execute(handle, { signal,
      onStart: metadata => { assert.equal(metadata.ticket, 'fixture-ticket'); f.events.push('durable-start'); },
      beforeGo: () => { f.events.push('host-before-go'); } });
    assert.deepEqual(completion, complete());
    assert.deepEqual(f.events, ['transport', 'durable-start', 'host-before-go', 'readInput', 'command', 'dispatched']);
    const call = f.transportCalls[0];
    assert.equal(call.root, root); assert.equal(call.actionId, `learning-${kind}`);
    assert.equal(call.input, handle.input); assert.deepEqual(call.command, handle.command); assert.equal(call.signal, signal);
    assert.equal(call.timeoutMs, handle.timeoutMs); assert.equal(call.maxOutputBytes, handle.maxOutputBytes);
    await assert.rejects(f.adapter.execute(handle, { onStart: () => {}, beforeGo: () => {} }), { code: 'LEARNING_ATTEMPT_USED' });
    assert.equal(f.transportCalls.length, 1);
  }
});

test('drift after durable start and async callbacks cannot dispatch or silently retry', async () => {
  const drift = fixture(), handle = await drift.adapter.prepare(drift.input);
  await assert.rejects(drift.adapter.execute(handle, { onStart: () => { drift.settings({ provider: 'codex', model: 'changed-before-go' }); }, beforeGo: () => {} }), { code: 'LEARNING_PROVIDER_DRIFT' });
  assert.equal(drift.events.includes('dispatched'), false);
  for (const callbacks of [{ onStart: () => Promise.resolve(), beforeGo: () => {} }, { onStart: () => {}, beforeGo: () => Promise.resolve() }]) {
    const f = fixture(), prepared = await f.adapter.prepare(f.input);
    await assert.rejects(f.adapter.execute(prepared, callbacks), { code: 'LEARNING_CALLBACK_ASYNC' });
    assert.equal(f.events.includes('dispatched'), false);
  }
});

test('transport cannot skip durable start or substitute its command/input binding', async () => {
  for (const started of [false, true]) {
    const f = fixture();
    const adapter = f.create({ transport: async options => {
      if (started) options.onStart({ ticket: 'fixture' });
      options.beforeGo({ commandHash: hash('wrong-command'), inputHash: sha256(options.input) });
      assert.fail('Invalid transport binding must not dispatch');
    } });
    const handle = await adapter.prepare(f.input);
    await assert.rejects(adapter.execute(handle, { onStart: () => {}, beforeGo: () => {} }), { code: started ? 'LEARNING_PREPARATION_CHANGED' : 'LEARNING_START_UNCOMMITTED' });
  }
});

test('parse consumes only bounded result file bytes and forwards current policy with confirmed completion', async () => {
  const f = fixture(), handle = await f.adapter.prepare(f.input), completion = { ...complete(), output: 'Ignored process stdout' }, policy = { denyGlobs: ['new-rule'] };
  const result = f.adapter.parse(handle, completion, policy);
  assert.deepEqual(result.output, Buffer.from('{"fixture":true}'));
  assert.equal(result.policy, policy);
  assert.equal(result.completion, completion);
  f.events.length = 0;
  assert.throws(() => f.adapter.parse(handle, { ...complete(), stopped: false, uncertain: true }, policy), { code: 'LEARNING_PROVIDER_INCOMPLETE' });
  assert.equal(f.events.includes('readResult'), false);
  f.output(Buffer.alloc(65537));
  assert.throws(() => f.adapter.parse(handle, complete(), policy), { code: 'LEARNING_OUTPUT_LIMIT' });
  f.output(Buffer.from('{}'));
  f.api.parse = () => { throw new GraphError('LEARNING_SOURCE_DENIED', 'Policy changed'); };
  assert.throws(() => f.adapter.parse(handle, complete(), policy), { code: 'LEARNING_SOURCE_DENIED' });
});

test('cleanup requires confirmed stop, is idempotent and accepts only its own handles', async () => {
  const f = fixture(), handle = await f.adapter.prepare(f.input);
  assert.throws(() => f.adapter.dispose(handle, { stopped: false }), { code: 'LEARNING_PROCESS_UNCERTAIN' });
  assert.deepEqual(f.disposals, []);
  assert.throws(() => f.adapter.dispose({ ...handle }, { stopped: true }), { code: 'LEARNING_PREPARATION_INVALID' });
  f.adapter.dispose(handle, { stopped: true }); f.adapter.dispose(handle, { stopped: true });
  assert.deepEqual(f.disposals, [{ stopped: true }]);
  assert.throws(() => f.adapter.beforeGo(handle), { code: 'LEARNING_PREPARATION_INVALID' });
  assert.throws(() => f.adapter.parse(handle, complete(), {}), { code: 'LEARNING_PREPARATION_INVALID' });
});

test('invalid prepared hashes or excessive process budgets are refused and safely disposed', async () => {
  for (const change of [{ inputHash: hash('wrong-input') }, { materialHash: hash('wrong-material') }, { timeoutMs: 120001 }, { maxOutputBytes: 2 * 1024 * 1024 + 1 }]) {
    const f = fixture(); Object.assign(f.prepared, change);
    await assert.rejects(f.adapter.prepare(f.input), error => ['LEARNING_PREPARATION_INVALID', 'LEARNING_TRANSPORT_LIMIT'].includes(error.code));
    assert.deepEqual(f.disposals, [{ stopped: true }]);
    assert.equal(f.transportCalls.length, 0);
  }
});
