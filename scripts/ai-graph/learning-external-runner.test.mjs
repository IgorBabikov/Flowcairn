import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import { externalLearningToolchain, preflightExternalLearning, externalLearningCommand, assertClaudeLearningAuthentication } from './lib/learning-external-runner.mjs';
import { runPreparedProcess } from './lib/runner.mjs';
import { sha256 } from './lib/io.mjs';

// Explicit controlled CLI emulator. It uses no account, network or real token.
const fake = String.raw`
import readline from 'node:readline';import fs from 'node:fs';import path from 'node:path';
const mode=fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR,'scenario'),'utf8');
if(process.argv.includes('auth')){const authFile=path.join(process.env.CLAUDE_CONFIG_DIR,'auth-fixture.json');console.log(fs.existsSync(authFile)?fs.readFileSync(authFile,'utf8'):JSON.stringify({loggedIn:mode!=='authfail',authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:'pro'}));process.exit(0);}
fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR,'protocol-started'),'true');
const send=m=>process.stdout.write(JSON.stringify(m)+'\n');
const modelIndex=process.argv.indexOf('--model'),effortIndex=process.argv.indexOf('--effort');
const model=modelIndex<0?'fixture-model':process.argv[modelIndex+1],effort=effortIndex<0?'high':process.argv[effortIndex+1];
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.type==='control_request'){
  const response=m.request.subtype==='initialize'?{commands:[],agents:[],models:[],account:{},pid:process.pid}
    :m.request.subtype==='get_settings'?{effective:{disableAllHooks:true},sources:[{source:'flagSettings',settings:{disableAllHooks:true}}],applied:{model,effort,advisor:null,ultracode:false}}:{mcpServers:[]};
  send({type:'control_response',response:{subtype:'success',request_id:m.request_id,response}});
 }else{
  fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR,'sent-input'),m.message.content);
  if(mode==='hang'){setInterval(()=>{},1000);return;}
  if(mode==='bad-json'){process.stdout.write('broken\n');return;}
  send({type:'result',subtype:'success',is_error:false,structured_output:{text:'simulated lesson'}});
  if(mode==='nonzero')process.exitCode=4;
 }
});
`;
function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'fc-external-learning-'))), scratch = path.join(root, 'scratch'), config = path.join(root, 'config');
  mkdirSync(scratch, { mode: 0o700 }); mkdirSync(config, { mode: 0o700 });
  mkdirSync(path.join(root, '.ai-orchestrator', 'graph', 'runner-tickets'), { recursive: true, mode: 0o700 });
  const executable = path.join(root, 'fixture-cli'); writeFileSync(executable, `#!${process.execPath}\n${fake}`, { mode: 0o700 });
  writeFileSync(path.join(config, 'scenario'), 'success');
  const old = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = config;
  t.after(() => { if (old === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = old; rmSync(root, { recursive: true, force: true }); });
  for (const [file, content] of [['input.txt', 'saved fixture material'], ['schema.json', '{"type":"object"}'], ['result.json', '']])
    writeFileSync(path.join(scratch, file), content, { mode: 0o600 });
  const toolchain = externalLearningToolchain({ node: process.execPath, provider: { provider: 'claude', executable, version: '2.1.198 (Claude Code)' } });
  const selection = { model: 'provider-default', reasoningEffort: undefined };
  const prepare = () => preflightExternalLearning({ toolchain, scratch, ...selection });
  const command = receipt => externalLearningCommand({ receipt, scratch, schemaFile: path.join(scratch, 'schema.json'), resultFile: path.join(scratch, 'result.json'), ...selection });
  return { root, scratch, config, executable, toolchain, selection, prepare, command,
    scenario: mode => writeFileSync(path.join(config, 'scenario'), mode), result: () => readFileSync(path.join(scratch, 'result.json'), 'utf8') };
}
test('simulated native adapter executes through actual supervisor/worker with exact prompt and result ownership', async t => {
  const f = fixture(t), receipt = await f.prepare(), command = f.command(receipt);
  assert.equal(receipt.effectiveModel, 'fixture-model'); assert.equal(receipt.effectiveReasoningEffort, 'high');
  assert.equal(receipt.allowed, true); assert.equal(command.executable, process.execPath);
  let started = false;
  const completion = await runPreparedProcess({ root: f.root, actionId: 'learning-lesson', command, input: 'saved fixture material', timeoutMs: 10000, maxOutputBytes: 2 * 1024 * 1024,
    onStart: () => { started = true; }, beforeGo: binding => { assert.equal(started, true); assert.equal(binding.inputHash, sha256('saved fixture material')); } });
  assert.equal(completion.exitCode, 0); assert.equal(completion.stopped, true); assert.equal(completion.uncertain, false);
  assert.deepEqual(JSON.parse(f.result()), { text: 'simulated lesson' });
  assert.equal(readFileSync(path.join(f.config, 'sent-input'), 'utf8'), 'saved fixture material');
});
test('configuration and executable drift fail before command; fabricated receipt cannot launch', async t => {
  const f = fixture(t), receipt = await f.prepare();
  assert.throws(() => f.command({ ...receipt }), { code: 'LEARNING_CLAUDE_PREFLIGHT_REQUIRED' });
  writeFileSync(path.join(f.config, 'settings.json'), '{"effortLevel":"medium"}');
  assert.throws(() => f.command(receipt), { code: 'LEARNING_PROVIDER_DRIFT' });
  rmSync(path.join(f.config, 'settings.json')); appendFileSync(f.executable, '\n// changed');
  assert.throws(() => f.command(receipt), { code: 'LEARNING_NATIVE_TOOLCHAIN_DRIFT' });
});
test('worker rechecks current settings and input/schema binding before giving material to CLI', async t => {
  const f = fixture(t), receipt = await f.prepare(), command = f.command(receipt);
  writeFileSync(path.join(f.config, 'settings.json'), '{"effortLevel":"medium"}');
  const completion = await runPreparedProcess({ root: f.root, actionId: 'learning-lesson', command, input: 'saved fixture material', timeoutMs: 10000,
    maxOutputBytes: 2 * 1024 * 1024, onStart: () => {}, beforeGo: () => {} });
  assert.notEqual(completion.exitCode, 0); assert.equal(completion.stopped, true); assert.equal(f.result(), '');
});
test('auth false with exit zero is refusal; no synthetic success reaches inference', async t => {
  const f = fixture(t); f.scenario('authfail');
  await assert.rejects(f.prepare(), { code: 'LEARNING_PROVIDER_AUTH_REQUIRED' });
  assert.throws(() => assertClaudeLearningAuthentication(f.executable, { ...process.env, CLAUDE_CONFIG_DIR: f.config }, f.scratch), { code: 'LEARNING_PROVIDER_AUTH_REQUIRED' });
  assert.equal(f.result(), '');
});
test('mixed credential auth is refused before protocol, while pure personal status remains accepted', async t => {
  const f = fixture(t), authFile = path.join(f.config, 'auth-fixture.json');
  for (const subscriptionType of ['pro', 'max']) {
    const pure = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType };
    writeFileSync(authFile, JSON.stringify(pure));
    assert.doesNotThrow(() => assertClaudeLearningAuthentication(f.executable, { ...process.env, CLAUDE_CONFIG_DIR: f.config }, f.scratch));
    // apiKeySource is a native field. Malformed/unknown values are negative
    // protocol fixtures; they are not claimed to be observed native statuses.
    for (const apiKeySource of ['config', '/login managed key', 'apiKeyHelper', 'ANTHROPIC_API_KEY', 'unknown', '', null, false]) {
      writeFileSync(authFile, JSON.stringify({ ...pure, apiKeySource }));
      await assert.rejects(f.prepare(), { code: 'LEARNING_MANAGED_POLICY_UNVERIFIED' });
      assert.equal(existsSync(path.join(f.config, 'protocol-started')), false);
      assert.equal(f.result(), '');
    }
  }
});
test('worker refuses newly mixed credentials even when a prior personal preflight receipt exists', async t => {
  const f = fixture(t), receipt = await f.prepare(), command = f.command(receipt);
  rmSync(path.join(f.config, 'protocol-started'));
  writeFileSync(path.join(f.config, 'auth-fixture.json'), JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'pro', apiKeySource: 'config' }));
  const completion = await runPreparedProcess({ root: f.root, actionId: 'learning-lesson', command, input: 'saved fixture material', timeoutMs: 10000,
    maxOutputBytes: 2 * 1024 * 1024, onStart: () => {}, beforeGo: () => {} });
  assert.notEqual(completion.exitCode, 0); assert.equal(completion.stopped, true); assert.equal(completion.uncertain, false);
  assert.equal(existsSync(path.join(f.config, 'protocol-started')), false);
  assert.equal(existsSync(path.join(f.config, 'sent-input')), false); assert.equal(f.result(), '');
});
for (const scenario of ['bad-json', 'nonzero', 'hang']) test(`simulated supervisor ${scenario} keeps result empty and confirms process termination`, async t => {
  const f = fixture(t), receipt = await f.prepare(), command = f.command(receipt); f.scenario(scenario);
  const completion = await runPreparedProcess({ root: f.root, actionId: 'learning-question', command, input: 'saved fixture material', timeoutMs: scenario === 'hang' ? 1500 : 10000,
    maxOutputBytes: 2 * 1024 * 1024, onStart: () => {}, beforeGo: () => {} });
  assert.notEqual(completion.exitCode, 0); assert.equal(completion.stopped, true); assert.equal(completion.uncertain, false); assert.equal(f.result(), '');
  if (scenario === 'hang') assert.equal(completion.timedOut, true);
});
test('simulated cancellation terminates both trusted worker and child without accepting a late answer', async t => {
  const f = fixture(t), receipt = await f.prepare(), command = f.command(receipt); f.scenario('hang');
  const controller = new AbortController(); let timer;
  const completion = await runPreparedProcess({ root: f.root, actionId: 'learning-question', command, input: 'saved fixture material', timeoutMs: 10000,
    maxOutputBytes: 2 * 1024 * 1024, signal: controller.signal, onStart: () => { timer = setTimeout(() => controller.abort(), 1000); }, beforeGo: () => {} });
  clearTimeout(timer); assert.equal(completion.stopped, true); assert.equal(completion.uncertain, false); assert.equal(f.result(), '');
});
