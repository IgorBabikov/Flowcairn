import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path'; import os from 'node:os';
import { parse } from 'smol-toml';
import { preflightCodexLearning, codexLearningCommand, LEARNING_RUNNER_TESTING as helpers } from './lib/learning-runner.mjs';

function fixture(t) {
  const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-learning-runner-')));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  return scratch;
}
function effective(scratch, names = []) {
  return { requirements: null,
    config: { features: { ...Object.fromEntries(helpers.disabled.map(key => [key, false])), skip_host_skill_discovery: true },
      mcp_servers: Object.fromEntries(names.map(name => [name, { enabled: false }])), approval_policy: 'never', web_search: 'disabled', model_provider: 'openai',
      project_doc_max_bytes: 0, check_for_update_on_startup: false, project_root_markers: ['schema.json'], project_doc_fallback_filenames: [], notify: [], default_permissions: 'flowcairn-learning',
      permissions: { 'flowcairn-learning': { filesystem: { glob_scan_max_depth: null, ...helpers.filesystem(scratch) }, network: { enabled: false } } },
      shell_environment_policy: { inherit: 'none' } },
    layers: [{ name: { type: 'user' }, config: { mcp_servers: Object.fromEntries(names.map(name => [name, { enabled: true }])) } },
      { name: { type: 'sessionFlags' }, config: { mcp_servers: Object.fromEntries(names.map(name => [name, { enabled: false }])) } }] };
}

test('effective native profile and integration controls pass without requiring empty SDK internals', (t) => {
  const scratch = fixture(t), input = effective(scratch, ['user-server']);
  const result = helpers.validateConfiguration(input, scratch, ['user-server']);
  assert.equal(result.mcpDisabled, true); assert.equal(result.readonlyFilesystem, true);
  assert.deepEqual(result.retainedMcp, []); // exec ignores this user layer entirely
  input.layers.push({ name: { type: 'system' }, config: { mcp_servers: { 'system-server': { enabled: true } } } });
  input.config.mcp_servers['system-server'] = { enabled: false };
  assert.deepEqual(helpers.validateConfiguration(input, scratch, ['user-server', 'system-server']).retainedMcp, ['system-server']);
});

test('managed pins are explicit conflicts; unknown or broadened effective controls fail closed', (t) => {
  const scratch = fixture(t);
  for (const requirements of [{ featureRequirements: { hooks: true } }, { featureRequirements: { skip_host_skill_discovery: false } },
    { allowedApprovalPolicies: ['on-request'] }, { allowedWebSearchModes: ['live'] }, { defaultPermissions: 'other' }, { allowedPermissionProfiles: {} }]) {
    assert.throws(() => helpers.validateConfiguration({ ...effective(scratch), requirements }, scratch, []), { code: 'LEARNING_MANAGED_POLICY_CONFLICT' });
  }
  for (const modify of [
    value => { value.config.features.hooks = true; },
    value => { value.config.mcp_servers.unexpected = { enabled: true }; },
    value => { value.config.permissions['flowcairn-learning'].filesystem['/outside'] = 'read'; },
    value => { value.config.permissions['flowcairn-learning'].filesystem[scratch] = 'write'; },
    value => { value.config.permissions['flowcairn-learning'].network.enabled = true; },
    value => { value.config.notify = ['external-command']; },
  ]) { const value = effective(scratch); modify(value); assert.throws(() => helpers.validateConfiguration(value, scratch, []), { code: 'LEARNING_CODEX_CONTROLS_UNVERIFIED' }); }
  assert.throws(() => helpers.validateConfiguration({ ...effective(scratch), layers: undefined }, scratch, []), { code: 'LEARNING_CODEX_CONFIG_UNAVAILABLE' });
});

test('metadata read returns only integration keys and handles profile entries without exposing values', (t) => {
  const scratch = fixture(t), file = path.join(scratch, 'config.toml');
  writeFileSync(file, '[mcp_servers.alpha]\ncommand="synthetic-command"\n[mcp_servers.alpha.env]\nPRIVATE_VALUE="not-for-output"\n[profiles.test.mcp_servers.beta]\nurl="http://localhost:1"\n', { mode: 0o600 });
  assert.deepEqual(helpers.mcpKeysFromFiles([file]), ['alpha', 'beta']);
  writeFileSync(file, '[mcp_servers."bad.name"]\ncommand="synthetic"\n');
  assert.throws(() => helpers.mcpKeysFromFiles([file]), { code: 'LEARNING_CODEX_CONFIG_UNSUPPORTED' });
});

test('Codex argv applies independent controls with exact read-only policy and no inherited auth values', (t) => {
  const scratch = fixture(t), settings = helpers.controls(scratch, ['system-server']);
  const command = helpers.buildCommand({ node: process.execPath, codexEntry: '/verified/codex.js' }, settings, scratch,
    path.join(scratch, 'schema.json'), path.join(scratch, 'result.json'), 'configured-model');
  assert.equal(command.cwd, scratch);
  for (const flag of ['--ignore-user-config', '--ignore-rules', '--strict-config', '--ephemeral', '--output-schema', '--output-last-message', '--cd', '--model']) assert.ok(command.args.includes(flag));
  assert.equal(command.args.at(-1), '-');
  assert.ok(command.args.includes('features.hooks=false'));
  assert.ok(command.args.includes('mcp_servers.system-server.enabled=false'));
  assert.equal(command.args.some(value => value.includes('bypass') || value.includes('workspace-write')), false);
  const fsConfig = settings.find(value => value.startsWith('permissions.flowcairn-learning.filesystem='));
  const parsed = parse(fsConfig).permissions['flowcairn-learning'].filesystem;
  assert.deepEqual(parsed, helpers.filesystem(scratch));
  assert.equal('ANTHROPIC_API_KEY' in command.env, false); assert.equal('OPENAI_API_KEY' in command.env, false);
  assert.equal(Object.isFrozen(command.args), true);
});

test('read-only config protocol sends only initialize/read methods and terminates the helper', async (t) => {
  const scratch = fixture(t), entry = path.join(scratch, 'fake-cli.mjs'), record = path.join(scratch, 'methods.json');
  const data = effective(scratch);
  writeFileSync(entry, `import fs from 'node:fs';import readline from 'node:readline';
const methods=[];const input=readline.createInterface({input:process.stdin});
input.on('line',line=>{const message=JSON.parse(line);methods.push(message.method);fs.writeFileSync(${JSON.stringify(record)},JSON.stringify(methods));
if(message.method==='initialize')process.stdout.write(JSON.stringify({id:message.id,result:{}})+'\\n');
if(message.method==='configRequirements/read')process.stdout.write(JSON.stringify({id:message.id,result:{requirements:null}})+'\\n');
if(message.method==='config/read')process.stdout.write(JSON.stringify({id:message.id,result:${JSON.stringify(data)}})+'\\n');});
`);
  const result = await helpers.readConfiguration({ node: process.execPath, codexEntry: entry }, scratch, helpers.controls(scratch, []));
  assert.equal(result.config.features.hooks, false);
  assert.deepEqual(JSON.parse(readFileSync(record, 'utf8')), ['initialize','initialized','configRequirements/read','config/read']);
});

test('RPC managed-feature errors produce a static conflict code without returning diagnostics', async (t) => {
  const scratch = fixture(t), entry = path.join(scratch, 'conflict.mjs');
  writeFileSync(entry, 'process.stderr.write("features hooks=false conflicts with managed requirement hooks=true; synthetic-private-marker"); process.exit(1);');
  await assert.rejects(helpers.readConfiguration({ node: process.execPath, codexEntry: entry }, scratch, []), error =>
    error.code === 'LEARNING_MANAGED_POLICY_CONFLICT' && !error.message.includes('synthetic-private-marker'));
});

test('unknown versions and forged preflight receipts never yield a command', async (t) => {
  const scratch = fixture(t);
  for (const codexVersion of ['unknown', '0.157.2', '0.158.0', '0.157.1-alpha.1'])
    await assert.rejects(preflightCodexLearning({ scratch, toolchain: { identity: { codexVersion, nodeVersion: process.version } } }),
      { code: process.platform === 'darwin' ? 'LEARNING_CODEX_VERSION_UNSUPPORTED' : 'LEARNING_CODEX_PLATFORM_UNVERIFIED' });
  assert.throws(() => codexLearningCommand({ receipt: { allowed: true }, scratch, schemaFile: '', resultFile: '', model: 'configured-model' }), { code: 'LEARNING_CODEX_PREFLIGHT_REQUIRED' });
});
