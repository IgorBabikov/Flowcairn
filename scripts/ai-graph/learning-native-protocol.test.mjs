import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, realpathSync, rmSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeLearningArgs, runClaudeLearningProtocol, parseClaudeLearningResult } from './lib/learning-native-claude-protocol.mjs';
import { validateClaudePolicy, validateClaudeConfiguration, claudePolicySnapshot } from './lib/learning-native-claude-policy.mjs';
import { learningNativeEnvironment, learningCodexNativeLayout } from './lib/learning-native-platform.mjs';
import { cursorLearningCandidate, cursorLearningAuthentication, parseCursorLearningResult } from './lib/learning-native-cursor.mjs';

// These are controlled native-protocol shapes, never recorded live inference.
const fakeCli = String.raw`
import readline from 'node:readline';
const mode=process.argv[2];
const emit=m=>process.stdout.write(JSON.stringify(m)+'\n');
const loop=readline.createInterface({input:process.stdin});
loop.on('line',line=>{
 const m=JSON.parse(line);
 if(mode==='malformed'){process.stdout.write('{bad\n');return;}
 if(mode==='overflow'){process.stdout.write('x'.repeat(2*1024*1024+1));return;}
 if(mode==='timeout'){setInterval(()=>{},1000);return;}
 if(m.type==='control_request'){
  let response=m.request.subtype==='initialize'?{commands:[],agents:[],account:{email:'synthetic@example.invalid'},pid:123}
   :m.request.subtype==='get_settings'?{effective:{disableAllHooks:true},sources:[{source:'flagSettings',settings:{disableAllHooks:true}}],applied:{model:'fixture-model',effort:'high',advisor:null,ultracode:false}}
   :{mcpServers:[]};
  emit({type:'control_response',response:{subtype:'success',request_id:m.request_id,response}});
  if(mode==='replay')emit({type:'control_response',response:{subtype:'success',request_id:m.request_id,response}});
 }else if(m.type==='user'){
  if(mode==='tool'){emit({type:'control_request',request_id:'tool',request:{subtype:'can_use_tool'}});return;}
  if(mode==='tool-use'){emit({type:'assistant',message:{content:[{type:'tool_use',name:'Read'}]}});return;}
  const result={type:'result',subtype:'success',is_error:false,structured_output:{text:'Значение из сохраненного материала'}};
  if(mode==='auth') {result.subtype='error_during_execution';result.is_error=true;}
  if(mode==='result-limit')result.structured_output={text:'x'.repeat(65536)};
  emit(result);
  if(mode==='duplicate-result')emit(result);
  if(mode==='nonzero')process.exitCode=2;
 }
});
`;
function scratch(t) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'fc-learning-native-test-')));
  t.after(() => rmSync(dir, { recursive: true, force: true })); return dir;
}
function protocolFixture(t, mode = 'success') {
  const root = scratch(t), cli = path.join(root, 'cli.mjs'); writeFileSync(cli, fakeCli);
  return { command: { executable: process.execPath, args: [cli, mode], cwd: root, env: {} }, selection: { model: 'fixture-model', reasoningEffort: 'high' } };
}
test('simulated protocol preflight never sends input and hash excludes volatile account/pid', async t => {
  const fixture = protocolFixture(t);
  const first = await runClaudeLearningProtocol(fixture), second = await runClaudeLearningProtocol(fixture);
  assert.equal(first.output, null); assert.deepEqual(first, second);
  assert.deepEqual(Object.keys(first.facts).sort(), ['configurationHash', 'effectiveModel', 'effectiveReasoningEffort']);
});
test('simulated protocol sends one bounded prompt only after revalidated configuration', async t => {
  const fixture = protocolFixture(t), preflight = await runClaudeLearningProtocol(fixture);
  let checks = 0;
  const result = await runClaudeLearningProtocol({ ...fixture, input: 'Saved material', expectedConfigurationHash: preflight.facts.configurationHash, beforeInput: () => checks++ });
  assert.equal(checks, 1); assert.equal(JSON.parse(result.output).text, 'Значение из сохраненного материала');
  await assert.rejects(runClaudeLearningProtocol({ ...fixture, input: 'Saved material', expectedConfigurationHash: '0'.repeat(64), beforeInput: () => assert.fail('drift must not send') }), { code: 'LEARNING_PROVIDER_DRIFT' });
});
test('simulated protocol rejects malformed/duplicate/control/auth/nonzero/oversized output and timeout', async t => {
  for (const [mode, code] of [['malformed', 'LEARNING_CLAUDE_PROTOCOL_INVALID'], ['replay', 'LEARNING_CLAUDE_PROTOCOL_INVALID'],
    ['overflow', 'LEARNING_OUTPUT_LIMIT'], ['timeout', 'LEARNING_PROVIDER_TIMEOUT'], ['tool', 'LEARNING_CLAUDE_CONTROLS_UNVERIFIED'],
    ['tool-use', 'LEARNING_CLAUDE_CONTROLS_UNVERIFIED'], ['auth', 'LEARNING_PROVIDER_INCOMPLETE'], ['nonzero', 'LEARNING_PROVIDER_INCOMPLETE'],
    ['result-limit', 'LEARNING_OUTPUT_LIMIT'], ['duplicate-result', 'LEARNING_CLAUDE_PROTOCOL_INVALID']]) {
    await assert.rejects(runClaudeLearningProtocol({ ...protocolFixture(t, mode), input: 'saved', timeoutMs: mode === 'timeout' ? 150 : 2000 }), { code }, mode);
  }
});
test('Claude argv disables tools/customizations without bare mode, auth overrides, fallback or shell', () => {
  const args = claudeLearningArgs({ model: 'fixture-model', reasoningEffort: 'xhigh' });
  assert.equal(args[args.indexOf('--tools') + 1], ''); assert.equal(args[args.indexOf('--effort') + 1], 'xhigh');
  assert.equal(args[args.indexOf('--model') + 1], 'fixture-model');
  for (const flag of ['--safe-mode', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands', '--no-chrome']) assert.ok(args.includes(flag));
  for (const flag of ['--bare', '--fallback-model', '--dangerously-skip-permissions']) assert.equal(args.includes(flag), false);
  assert.equal(claudeLearningArgs({ model: 'provider-default' }).includes('--model'), false);
  assert.throws(() => claudeLearningArgs({ model: 'fixture-model', reasoningEffort: 'ultra' }), { code: 'LEARNING_REASONING_INVALID' });
});
test('managed automation and unknown policy are rejected while restrictive known policy remains applicable', () => {
  assert.deepEqual(validateClaudePolicy({ permissions: { deny: ['Read(**)'] }, allowManagedHooksOnly: true }), { permissions: { deny: ['Read(**)'] }, allowManagedHooksOnly: true });
  for (const policy of [{ hooks: {} }, { env: {} }, { policyHelper: {} }, { statusLine: {} }, { unknown: true }, { permissions: { additionalDirectories: ['/outside'] } }])
    assert.throws(() => validateClaudePolicy(policy), { code: 'LEARNING_MANAGED_POLICY_CONFLICT' });
  const base = { initialization: { commands: [], agents: [] }, mcp: { mcpServers: [] }, settings: { effective: { disableAllHooks: true }, sources: [], applied: { model: 'model', effort: null, advisor: null, ultracode: false } } };
  assert.equal(validateClaudeConfiguration(base, { model: 'provider-default' }).effectiveModel, 'model');
  assert.equal('effectiveReasoningEffort' in validateClaudeConfiguration(base, { model: 'provider-default' }), false);
  assert.throws(() => validateClaudeConfiguration(base, { model: 'different' }), { code: 'LEARNING_PROVIDER_DRIFT' });
  assert.throws(() => validateClaudeConfiguration({ ...base, mcp: { mcpServers: [{ name: 'unexpected' }] } }, { model: 'model' }), { code: 'LEARNING_CLAUDE_CONTROLS_UNVERIFIED' });
});
test('platform construction covers all target triples and removes injected provider/command environment', () => {
  for (const platform of ['darwin', 'win32']) for (const arch of ['arm64', 'x64']) {
    const layout = learningCodexNativeLayout(platform, arch); assert.equal(layout.binary, platform === 'win32' ? 'codex.exe' : 'codex');
    assert.ok(layout.packageName.endsWith(`${platform}-${arch}`));
  }
  const env = learningNativeEnvironment('codex', { SystemRoot: 'C:\\Windows', Path: 'malicious', HOME: 'home', USERPROFILE: 'profile',
    OPENAI_API_KEY: 'synthetic', NODE_OPTIONS: 'malicious', ANTHROPIC_API_KEY: 'synthetic', CODEX_HOME: 'config' }, 'win32');
  assert.equal(env.PATH, 'C:\\Windows\\System32'); assert.equal(env.SYSTEMROOT, 'C:\\Windows'); assert.equal(env.CODEX_HOME, 'config');
  assert.equal('NODE_OPTIONS' in env, false); assert.equal('OPENAI_API_KEY' in env, false); assert.equal('ANTHROPIC_API_KEY' in env, false);
});
test('unsupported OS refuses native layout/environment/policy before any file or CLI metadata access', () => {
  for (const platform of ['freebsd', 'aix']) {
    assert.throws(() => learningCodexNativeLayout(platform, 'x64'), { code: 'LEARNING_CODEX_PLATFORM_UNVERIFIED' });
    assert.throws(() => learningNativeEnvironment('codex', {}, platform), { code: 'LEARNING_PLATFORM_UNSUPPORTED' });
    assert.throws(() => claudePolicySnapshot({}, platform), { code: 'LEARNING_PLATFORM_UNSUPPORTED' });
  }
});
test('Cursor candidate stays denied; recorded auth and result envelopes never imply launch safety', () => {
  const candidate = cursorLearningCandidate({ model: 'configured-model', reasoningEffort: 'high' });
  assert.equal(candidate.allowed, false); assert.equal(candidate.evidence, 'candidate-only');
  assert.ok(candidate.proposedArgs.includes('configured-model[effort=high]'));
  assert.equal(cursorLearningAuthentication({ isAuthenticated: false }), false);
  assert.equal(cursorLearningAuthentication({ isAuthenticated: true }), true);
  assert.equal(cursorLearningAuthentication({ loggedIn: true }), false);
  const text = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '{"text":"fixture"}' });
  assert.deepEqual(parseCursorLearningResult(text), { text: 'fixture' });
  for (const result of ['{}', '{bad', JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: '{}' })]) assert.throws(() => parseCursorLearningResult(result));
  assert.throws(() => parseClaudeLearningResult({ type: 'result', subtype: 'success', is_error: false, structured_output: [] }), { code: 'LEARNING_OUTPUT_INVALID' });
});

const nativeClaude = path.resolve('node_modules/@anthropic-ai/claude-code/bin/claude.exe');
test('native-no-inference: Claude effective settings/model and disabled user hooks with sentinel rules', { skip: !existsSync(nativeClaude) || process.env.FLOWCAIRN_NATIVE_NO_INFERENCE !== '1' }, async t => {
  const root = scratch(t), config = path.join(root, 'config'), cwd = path.join(root, 'work'), marker = path.join(root, 'hook-ran');
  mkdirSync(config); mkdirSync(cwd);
  writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ model: 'claude-sonnet-4-6', effortLevel: 'medium',
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch ${marker}` }] }] } }));
  writeFileSync(path.join(cwd, 'CLAUDE.md'), 'SYNTHETIC_RULE_MUST_NOT_LOAD');
  const args = claudeLearningArgs({ model: 'provider-default' });
  const response = await runClaudeLearningProtocol({ command: { executable: nativeClaude, args, cwd,
    env: { ...learningNativeEnvironment('claude'), CLAUDE_CONFIG_DIR: config } }, selection: { model: 'provider-default' } });
  assert.equal(response.output, null); assert.equal(response.facts.effectiveModel, 'claude-sonnet-4-6');
  assert.equal(response.facts.effectiveReasoningEffort, 'medium'); assert.equal(existsSync(marker), false);
  const withSchema = await runClaudeLearningProtocol({ command: { executable: nativeClaude, args, cwd,
    env: { ...learningNativeEnvironment('claude'), CLAUDE_CONFIG_DIR: config } }, selection: { model: 'provider-default' },
    schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } });
  assert.equal(withSchema.facts.configurationHash, response.facts.configurationHash, 'schema initialization must preserve preflight binding');
  assert.equal(readFileSync(path.join(cwd, 'CLAUDE.md'), 'utf8'), 'SYNTHETIC_RULE_MUST_NOT_LOAD');
  // No prompt means actual model-directed read/write/rule ingestion remains untested.
});
