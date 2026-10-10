import assert from 'node:assert/strict';
import test from 'node:test';
import { hashObject, sha256 } from './lib/io.mjs';
import { cursorNativeLearningTransport, parseCursorNativeLearningCompletion } from './lib/learning-native-cursor-transport.mjs';

const options = () => ({ executable: '/fixture/agent', cwd: '/fixture/material', prompt: 'Immutable saved source fixture',
  schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  env: { HOME: '/fixture/home', PATH: '/untrusted/path', NODE_OPTIONS: 'untrusted', CURSOR_CONFIG_DIR: '/fixture/cursor-config', CURSOR_DATA_DIR: '/fixture/cursor-data' }, platform: 'darwin' });
const completion = () => ({ exitCode: 0, stopped: true, uncertain: false, timedOut: false, outputLimit: false, signal: null, failureReason: null });
// Documented Cursor --print --output-format json envelope, not live inference.
// https://cursor.com/docs/cli/reference/output-format
const stdout = result => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1234, duration_api_ms: 1234,
  result: JSON.stringify(result), session_id: '00000000-0000-0000-0000-000000000000', request_id: 'synthetic' }) + '\n';

test('Cursor native-client proposal keeps ask/sandbox, selected profile and saved material without issuing launch authority', () => {
  const input = options(), result = cursorNativeLearningTransport(input);
  assert.equal(result.boundaryTier, 'native-client-learning'); assert.equal(result.launchAuthorized, false);
  assert.deepEqual(result.command.args.slice(0, 7), ['--print', '--output-format', 'json', '--mode', 'ask', '--sandbox', 'enabled']);
  for (const flag of ['--force', '--yolo', '--approve-mcps', '--trust', '--plugin-dir', '--continue', '--resume']) assert.equal(result.command.args.includes(flag), false);
  assert.equal(result.command.env.HOME, input.env.HOME); assert.equal(result.command.env.CURSOR_CONFIG_DIR, input.env.CURSOR_CONFIG_DIR);
  assert.equal(result.command.env.CURSOR_DATA_DIR, input.env.CURSOR_DATA_DIR); assert.equal('NODE_OPTIONS' in result.command.env, false);
  assert.equal(result.command.cwd, input.cwd); assert.equal(result.stdin, ''); assert.ok(result.command.args.at(-1).startsWith(input.prompt));
  assert.equal(result.sourceInputHash, sha256(input.prompt)); assert.equal(result.commandHash, hashObject(result.command));
  assert.ok(result.requiredGuards.includes('explicit-boundary-consent')); assert.ok(result.requiredGuards.includes('native-automation-preflight'));
  assert.equal('effectiveModel' in result, false); assert.equal('effectivePolicyHash' in result, false);
});
test('explicit model/effort propagate; provider-default stays an intent with no fabricated effective value', () => {
  const concrete = cursorNativeLearningTransport({ ...options(), model: 'claude-opus-4-8', reasoningEffort: 'high' });
  assert.equal(concrete.command.args[concrete.command.args.indexOf('--model') + 1], 'claude-opus-4-8[effort=high]');
  assert.equal(concrete.reasoningEffortIntent, 'high');
  assert.equal(cursorNativeLearningTransport(options()).command.args.includes('--model'), false);
  assert.throws(() => cursorNativeLearningTransport({ ...options(), reasoningEffort: 'high' }), { code: 'LEARNING_REASONING_INVALID' });
});
test('auth/endpoint overrides refuse rather than silently switching account or receiver', () => {
  for (const key of ['CURSOR_API_KEY', 'CURSOR_AUTH_TOKEN', 'CURSOR_API_ENDPOINT']) {
    const input = options(); input.env[key] = 'synthetic-private-marker';
    assert.throws(() => cursorNativeLearningTransport(input), error => error.code === 'LEARNING_CURSOR_PROFILE_UNVERIFIED' && !error.message.includes('synthetic-private-marker'));
  }
});
test('native argument and schema limits fail without truncation, including Windows CreateProcess limit', () => {
  assert.throws(() => cursorNativeLearningTransport({ ...options(), platform: 'freebsd' }), { code: 'LEARNING_PLATFORM_UNSUPPORTED' });
  assert.throws(() => cursorNativeLearningTransport({ ...options(), prompt: 'x'.repeat(128 * 1024) }), { code: 'LEARNING_INPUT_LIMIT' });
  assert.throws(() => cursorNativeLearningTransport({ ...options(), schema: { description: 'x'.repeat(65536) } }), { code: 'LEARNING_SCHEMA_LIMIT' });
  const windows = { ...options(), executable: 'C:\\fixture\\agent.exe', cwd: 'C:\\fixture\\material', env: { USERPROFILE: 'C:\\fixture\\home' }, platform: 'win32', prompt: 'x'.repeat(33000) };
  assert.throws(() => cursorNativeLearningTransport(windows), { code: 'PROVIDER_ARGV_LIMIT' });
  assert.throws(() => cursorNativeLearningTransport({ ...windows, executable: 'C:\\fixture\\agent.cmd', prompt: 'small' }), { code: 'LEARNING_CURSOR_COMMAND_INVALID' });
});
test('documented successful Cursor envelope yields only JSON content for subsequent source-bound validation', () => {
  const parsed = parseCursorNativeLearningCompletion(stdout({ text: 'simulated lesson' }), completion());
  assert.deepEqual(JSON.parse(parsed), { text: 'simulated lesson' });
  assert.equal(parsed.toString().includes('session_id'), false);
});
test('nonzero/auth failure/timeout/cancellation/uncertain/output-limit completion cannot accept valid stdout', () => {
  for (const change of [{ exitCode: 1 }, { stopped: false }, { uncertain: true }, { timedOut: true }, { outputLimit: true },
    { signal: 'SIGTERM' }, { failureReason: 'PROVIDER_AUTH_REQUIRED' }, { uncertain: undefined }]) {
    assert.throws(() => parseCursorNativeLearningCompletion(stdout({ text: 'ignored' }), { ...completion(), ...change }), { code: 'LEARNING_PROVIDER_INCOMPLETE' });
  }
});
test('malformed/duplicate/fenced/oversized output and invalid UTF-8 fail without salvage or echoing raw data', () => {
  for (const output of ['{bad', stdout({}) + stdout({}), '```json\n' + stdout({}) + '```', stdout([]), JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: '{}' })])
    assert.throws(() => parseCursorNativeLearningCompletion(output, completion()));
  assert.throws(() => parseCursorNativeLearningCompletion(stdout({ text: 'x'.repeat(65536) }), completion()), { code: 'LEARNING_OUTPUT_LIMIT' });
  assert.throws(() => parseCursorNativeLearningCompletion(Buffer.from([0xff]), completion()), { code: 'LEARNING_OUTPUT_INVALID' });
});
