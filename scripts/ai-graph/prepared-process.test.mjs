import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GraphError, hashObject, sha256 } from './lib/io.mjs';
import { runPreparedProcess, learningProviderToolchain } from './lib/runner.mjs';

const success = 'const fs=require("node:fs"); let text=""; process.stdin.setEncoding("utf8"); process.stdin.on("data",chunk=>text+=chunk); process.stdin.on("end",()=>{fs.writeFileSync(process.argv[1],text); process.stdout.write("done"); process.stderr.write("diagnostic");});';
function fixture(t, script = success) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-prepared-root-')));
  const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-prepared-input-')));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(scratch, { recursive: true, force: true }); });
  const tickets = path.join(root, '.ai-orchestrator/graph/runner-tickets');
  mkdirSync(tickets, { recursive: true, mode: 0o700 });
  for (const directory of ['.ai-orchestrator', '.ai-orchestrator/graph', '.ai-orchestrator/graph/runner-tickets'])
    chmodSync(path.join(root, directory), 0o700);
  const output = path.join(scratch, 'result.json');
  const command = { executable: process.execPath, args: ['-e', script, output], cwd: scratch,
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', NO_COLOR: '1' } };
  const run = (options = {}) => runPreparedProcess({ root, actionId: 'learning-lesson', command, input: '{"lesson":"fixture"}',
    timeoutMs: 5000, maxOutputBytes: 65536, onStart: () => {}, beforeGo: () => {}, ...options });
  return { root, scratch, tickets, command, output, run };
}

test('prepared transport persists ownership before GO and returns only completion/digests', async (t) => {
  const fx = fixture(t), order = [];
  let metadata;
  const result = await fx.run({
    onStart: (process) => {
      metadata = process; order.push('start');
      assert.equal(existsSync(fx.output), false);
      const ticket = JSON.parse(readFileSync(path.join(fx.root, process.ticket), 'utf8'));
      assert.equal(ticket.state, 'supervisor-ready');
      assert.equal(ticket.commandHash, hashObject(fx.command));
      assert.equal(ticket.ticketHash, process.ticketHash);
    },
    beforeGo: ({ commandHash, inputHash }) => {
      order.push('go'); assert.equal(existsSync(fx.output), false);
      assert.equal(commandHash, metadata.commandHash);
      assert.equal(inputHash, sha256('{"lesson":"fixture"}'));
    },
  });
  assert.deepEqual(order, ['start', 'go']);
  assert.equal(result.exitCode, 0); assert.equal(result.stopped, true); assert.equal(result.uncertain, false);
  assert.equal(result.timedOut, false); assert.equal(result.outputLimit, false); assert.equal(result.signal, null);
  assert.equal(result.failureReason, null); assert.deepEqual(result.process, metadata);
  assert.deepEqual(result.output, { stdoutDigest: sha256('done'), stderrDigest: sha256('diagnostic'), stdoutBytes: 4, stderrBytes: 10 });
  assert.equal(readFileSync(fx.output, 'utf8'), '{"lesson":"fixture"}', 'caller owns JSON extraction and scratch cleanup');
  assert.equal(JSON.stringify(result).includes('fixture'), false);
  assert.equal(JSON.parse(readFileSync(path.join(fx.root, metadata.ticket), 'utf8')).state, 'finished');
  assert.equal(existsSync(path.join(fx.root, '.flowcairn.json')), false, 'dispatch does not require a live project profile');
});

test('nonzero local process completion is never a successful preparation', async (t) => {
  const fx = fixture(t, 'process.stdin.resume(); process.stdin.on("end",()=>process.exit(7));');
  const result = await fx.run({ actionId: 'learning-question' });
  assert.equal(result.exitCode, 7); assert.equal(result.failureReason, 'NON_ZERO_EXIT');
  assert.equal(result.stopped, true); assert.equal(result.uncertain, false);
});

test('timeout survives graceful child exit zero and stops the supervised group', async (t) => {
  const fx = fixture(t, 'process.stdin.resume(); process.on("SIGTERM",()=>process.exit(0)); setInterval(()=>{},100);');
  const result = await fx.run({ timeoutMs: 1000 });
  assert.equal(result.failureReason, 'TIMEOUT'); assert.equal(result.timedOut, true);
  assert.notEqual(result.exitCode, 0); assert.equal(result.stopped, true); assert.equal(result.uncertain, false);
});

test('output cap is enforced without returning raw process text', async (t) => {
  const fx = fixture(t, 'process.stdin.resume(); setInterval(()=>process.stdout.write("x".repeat(16384)),10);');
  const result = await fx.run({ maxOutputBytes: 1024 });
  assert.equal(result.failureReason, 'OUTPUT_LIMIT'); assert.equal(result.outputLimit, true);
  assert.equal(result.stopped, true); assert.equal(result.uncertain, false);
  assert.equal(JSON.stringify(result).includes('xxxx'), false);
});

test('abort during dispatch preserves ABORTED even when child exits gracefully', async (t) => {
  const controller = new AbortController();
  const fx = fixture(t, 'process.stdin.resume(); process.on("SIGTERM",()=>process.exit(0)); setInterval(()=>{},100);');
  const result = await fx.run({ signal: controller.signal, beforeGo: () => { setTimeout(() => controller.abort(), 150); } });
  assert.equal(result.failureReason, 'ABORTED'); assert.notEqual(result.exitCode, 0);
  assert.equal(result.stopped, true); assert.equal(result.uncertain, false);
});

test('an already-aborted action never receives GO', async (t) => {
  const controller = new AbortController(); controller.abort();
  const fx = fixture(t);
  const result = await fx.run({ signal: controller.signal });
  assert.equal(result.failureReason, 'ABORTED'); assert.equal(result.stopped, true);
  assert.equal(existsSync(fx.output), false);
});

for (const step of ['onStart', 'beforeGo']) test(`${step} refusal prevents every child effect`, async (t) => {
  const fx = fixture(t);
  const result = await fx.run({ [step]: () => { throw new GraphError('JOB_OWNERSHIP_CHANGED', 'Fixture ownership changed'); } });
  assert.equal(result.failureReason, 'JOB_OWNERSHIP_CHANGED'); assert.equal(result.stopped, true); assert.equal(result.uncertain, false);
  assert.equal(result.execution.processStarted, false);
  assert.equal(existsSync(fx.output), false);
});

for (const step of ['onStart', 'beforeGo']) test(`async ${step} cannot cross the synchronous GO fence`, async (t) => {
  const fx = fixture(t);
  const result = await fx.run({ [step]: () => Promise.resolve() });
  assert.equal(result.failureReason, step === 'onStart' ? 'RUNNER_START_CALLBACK_ASYNC' : 'RUNNER_BEFORE_GO_ASYNC');
  assert.equal(result.stopped, true); assert.equal(existsSync(fx.output), false);
});

test('caller mutation after reservation cannot change the command sent to supervisor', async (t) => {
  const fx = fixture(t);
  const result = await fx.run({ onStart: () => { fx.command.args = ['-e', 'process.exit(9)']; fx.command.env.EXTRA = 'not-approved'; } });
  assert.equal(result.exitCode, 0);
  assert.equal(readFileSync(fx.output, 'utf8'), '{"lesson":"fixture"}');
});

test('oversized input and invalid control bounds fail before reserving a process', async (t) => {
  const fx = fixture(t); let calls = 0;
  for (const fields of [{ input: 'x'.repeat(128 * 1024 + 1) }, { timeoutMs: 999 }, { maxOutputBytes: 1023 }, { actionId: '../forged' }])
    await assert.rejects(fx.run({ ...fields, onStart: () => { calls++; } }), { code: 'RUNNER_CONTROL_INVALID' });
  assert.equal(calls, 0); assert.deepEqual(readdirSync(fx.tickets), []);
});

test('control storage symlinks cannot redirect supervisor tickets', async (t) => {
  const fx = fixture(t), moved = path.join(fx.root, 'moved-tickets');
  mkdirSync(moved, { mode: 0o700 }); rmSync(fx.tickets, { recursive: true }); symlinkSync(moved, fx.tickets, 'dir');
  await assert.rejects(fx.run(), { code: 'RUNNER_TICKETS_INVALID' });
  assert.deepEqual(readdirSync(moved), []);
});

test('the prepared transport never parses or removes a fixed result file', async (t) => {
  const fx = fixture(t, 'require("node:fs").writeFileSync(process.argv[1],"not JSON"); process.stdin.resume();');
  const result = await fx.run();
  assert.equal(result.exitCode, 0); assert.equal(result.stopped, true);
  assert.equal(readFileSync(fx.output, 'utf8'), 'not JSON');
});

test('learning toolchain getter refuses another provider before discovery or login', () => {
  for (const provider of ['claude', 'cursor', undefined])
    assert.throws(() => learningProviderToolchain({ provider, model: 'provider-default' }), { code: 'LEARNING_PROVIDER_UNSUPPORTED' });
});
