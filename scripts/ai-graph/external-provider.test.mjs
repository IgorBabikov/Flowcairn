import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, linkSync, mkdtempSync, mkdirSync, realpathSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { compilePlanningPlan } from './lib/planning.mjs';
import { makeExternalConsent, probeExternalProvider, providerToolchain } from './lib/providers.mjs';
import { SKILL_ROUTES } from './lib/config.mjs';
import { hashObject, sha256 } from './lib/io.mjs';
import { WorkflowService } from './lib/service.mjs';
import { providerCliCommand, assertProviderArgv } from './lib/provider-cli-command.mjs';
import { providerEnvironment, providerCandidates, assertProviderExecutablePlatform, exactClaudeReadRule } from './lib/provider-process-platform.mjs';

const node = process.execPath;
const worker = fileURLToPath(new URL('./lib/external-worker.mjs', import.meta.url));
const fixtures = new Set();
function fixture() { const directory = mkdtempSync(path.join(os.tmpdir(), 'flowcairn-external-provider-')); fixtures.add(directory); return directory; }
test.after(() => { for (const directory of fixtures) rmSync(directory, { recursive: true, force: true }); });
function fakeCli(directory, response = '{"result":"{\\"summary\\":\\"ok\\"}"}', version = 'fixture-cli 1.0', help = '--print --output-format --sandbox --mode', authenticated = true) {
  const file = path.join(directory, 'fake-provider');
  writeFileSync(file, `#!${node}\nconst fs=require('node:fs'),args=process.argv.slice(2),help=${JSON.stringify(help)},authenticated=${JSON.stringify(authenticated)};if (args[0] === '--version') process.stdout.write(${JSON.stringify(version + '\n')}); else if (args[0] === 'auth' && args[1] === 'status') {process.stdout.write(JSON.stringify({loggedIn:authenticated})+'\\n');process.exitCode=authenticated?0:1;} else if (args[0] === 'status') {process.stdout.write(JSON.stringify({authenticated})+'\\n');process.exitCode=authenticated?0:1;} else if (args.includes('--help')) {if(['--setting-sources','--strict-mcp-config','--no-session-persistence','--permission-mode','--tools','--output-format','--json-schema','--print','--sandbox','--mode'].some(flag=>args.includes(flag)&&!help.includes(flag))) process.exitCode=2; else process.stdout.write(help+'\\n');} else {const assert=require('node:assert/strict'); if(!args.includes('--print')) { for(const [flag,value] of [['--tools','Read,Grep,Glob'],['--permission-mode','dontAsk']])assert.equal(args[args.indexOf(flag)+1],value);assert.ok(args.includes('--strict-mcp-config'));assert.ok(args.includes('--no-session-persistence'));assert.ok(args.includes('--json-schema'));assert.equal(args.includes('--bare'),false);}process.stdout.write(${JSON.stringify(response)});}\n`);
  chmodSync(file, 0o700); return file;
}
function officialClaudeCli(directory, response = '{"result":"{\\"summary\\":\\"ok\\"}"}', packageVersion = '2.1.198', authenticated = true) {
  const source = fakeCli(directory, response, `${packageVersion} (Claude Code)`, undefined, authenticated);
  const packageRoot = path.join(directory, 'node_modules', '@anthropic-ai', 'claude-code');
  mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
  writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version: packageVersion }));
  const executable = path.join(packageRoot, 'bin', 'claude.exe');
  linkSync(source, executable);
  return executable;
}
function workerFixture(response, { provider = 'claude', version = 'fixture-cli 1.0', prompt = 'synthetic fixture only', review } = {}) {
  const root = realpathSync(fixture()), projectRoot = path.join(root, 'project'), runtime = path.join(root, 'runtime'), home = path.join(root, 'home');
  for (const directory of [projectRoot, runtime, home]) mkdirSync(directory);
  writeFileSync(path.join(projectRoot, 'source.txt'), 'native project source');
  const executable = fakeCli(runtime, response);
  const source = path.join(runtime, 'input.json'), result = path.join(runtime, 'result.json');
  if (review?.content) {
    const file = path.join(runtime, 'review.json'); writeFileSync(file, review.content, { mode: 0o600 });
    review = { path: file, bytes: Buffer.byteLength(review.content), hash: sha256(review.content) };
  }
  const input = { version: 2, provider, executable, versionPin: version, prompt,
    schema: { type: 'object' }, projectRoot, deniedPaths: ['.env', '**/credentials.json'], ...(review ? { review } : {}) };
  writeFileSync(source, JSON.stringify(input)); writeFileSync(result, '', { mode: 0o600 });
  const run = () => spawnSync(node, [worker, source, result], { cwd: runtime, encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: home } });
  return { run, result, input, home, executable };
}

for (const provider of ['claude', 'cursor']) {
  test(`${provider} command keeps project cwd and native auth without bypass flags`, () => {
    const f = workerFixture(undefined, { provider });
    const command = providerCliCommand(f.input, { env: { HOME: f.home, NODE_OPTIONS: '--inspect', ANTHROPIC_API_KEY: 'synthetic-not-inherited' } });
    assert.equal(command.cwd, f.input.projectRoot); assert.equal(command.env.HOME, f.home);
    assert.equal(command.env.NODE_OPTIONS, undefined); assert.equal(command.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(command.executable, f.executable);
    for (const flag of ['--force', '--yolo', '--trust', '--dangerously-skip-permissions', '--config']) assert.equal(command.args.includes(flag), false);
    if (provider === 'claude') {
      assert.equal(command.args.includes('--setting-sources'), false);
      assert.equal(command.args[command.args.indexOf('--tools') + 1], 'Read,Grep,Glob');
      assert.equal(command.args.includes('--allowedTools'), false);
      assert.ok(command.args.includes('Read(./.env)')); assert.ok(command.args.includes('Read(./**/credentials.json)'));
      assert.ok(command.args.includes('mcp__*')); assert.ok(command.args.includes('--strict-mcp-config'));
    } else assert.deepEqual(command.args.slice(0, 7), ['--print', '--output-format', 'json', '--sandbox', 'enabled', '--mode', 'ask']);
  });
  test(`${provider} worker accepts pinned synthetic result through native CLI`, () => {
    const f = workerFixture(undefined, { provider }); const run = f.run();
    assert.equal(run.status, 0, run.stderr); assert.deepEqual(JSON.parse(readFileSync(f.result, 'utf8')), { summary: 'ok' });
  });
}

test('Claude worker accepts structured output and sends review evidence in the same request', () => {
  const f = workerFixture('{"structured_output":{"summary":"structured"}}', { review: { content: 'complete safe review fixture', hash: 'a'.repeat(64) } });
  const command = providerCliCommand(f.input);
  assert.ok(!command.input.includes('complete safe review fixture'));
  assert.ok(command.args.includes(exactClaudeReadRule(f.input.review.path)));
  assert.ok(command.input.includes(f.input.review.path));
  const run = f.run(); assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(readFileSync(f.result, 'utf8')), { summary: 'structured' });
});

test('native CLI observes actual project cwd and original configured HOME', () => {
  const f = workerFixture();
  writeFileSync(f.executable, `#!${node}\nconst fs=require('node:fs'),assert=require('node:assert/strict');
    if(process.argv.includes('--version')){process.stdout.write('fixture-cli 1.0');process.exit(0);}
    assert.equal(process.cwd(),${JSON.stringify(f.input.projectRoot)});assert.equal(process.env.HOME,${JSON.stringify(f.home)});
    assert.equal(fs.readFileSync('source.txt','utf8'),'native project source');
    process.stdout.write(JSON.stringify({structured_output:{summary:'native cwd verified'}}));`);
  const run = f.run(); assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(readFileSync(f.result, 'utf8')), { summary: 'native cwd verified' });
});

test('external worker returns fixed auth errors and rejects version or output drift', () => {
  for (const [response, version, code] of [
    ['{"is_error":true,"result":"private failure details"}', 'fixture-cli 1.0', 'PROVIDER_AUTH_REQUIRED'],
    ['not-json', 'fixture-cli 1.0', 'PROVIDER_OUTPUT_INVALID'],
    ['not-json', 'different', 'PROVIDER_VERSION_DRIFT'],
    [JSON.stringify({ structured_output: { summary: 'password=synthetic-private-value' } }), 'fixture-cli 1.0', 'UNSAFE_SOURCE'],
  ]) {
    const f = workerFixture(response, { version }); const run = f.run();
    assert.notEqual(run.status, 0); assert.equal(run.stderr.trim(), code); assert.equal(readFileSync(f.result, 'utf8'), '');
    assert.doesNotMatch(run.stdout + run.stderr, /private failure|synthetic-private/);
  }
});

test('Claude worker exports only reported numeric usage metadata', () => {
  const f = workerFixture(JSON.stringify({ result: '{"summary":"ok"}',
    usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 4 },
    total_cost_usd: 0.001, session_id: 'private-session-id' }));
  const run = f.run(); assert.equal(run.status, 0, run.stderr);
  const event = JSON.parse(run.stdout); assert.equal(event.type, 'flowcairn.provider-usage');
  assert.equal(event.usage.totalTokens, 64); assert.equal(event.usage.costUsd, 0.001);
  assert.equal(run.stdout.includes('private-session-id'), false);
});

test('provider command rejects malformed native deny rules and unsafe or stale review files', () => {
  const f = workerFixture();
  for (const denial of ['../outside', '/absolute', 'file) Bash(*)', 'file\nnext']) {
    assert.throws(() => providerCliCommand({ ...f.input, deniedPaths: [denial] }), { code: 'PROVIDER_DENIAL_INVALID' });
  }
  const unsafe = workerFixture(undefined, { review: { content: 'password=synthetic-private-value' } });
  assert.throws(() => providerCliCommand(unsafe.input), { code: 'UNSAFE_SOURCE' });
  const stale = workerFixture(undefined, { review: { content: 'safe review content' } });
  writeFileSync(stale.input.review.path, 'changed review content');
  assert.throws(() => providerCliCommand(stale.input), { code: 'PROVIDER_REVIEW_INVALID' });
});

test('provider probe pins the exact CLI version and rejects later drift', () => {
  const root = fixture(), executable = officialClaudeCli(root);
  const probe = probeExternalProvider('claude', { executable }); assert.equal(probe.available, true);
  assert.equal(providerToolchain({ provider: 'claude', providerPath: executable, providerVersion: probe.version }).version, probe.version);
  assert.throws(() => providerToolchain({ provider: 'claude', providerPath: executable, providerVersion: 'other' }), { code: 'PROVIDER_VERSION_DRIFT' });
});

test('Claude probe refuses an official CLI older than the safe non-interactive contract', () => {
  const root = fixture(), executable = officialClaudeCli(root, undefined, '2.1.197');
  const probe = probeExternalProvider('claude', { executable });
  assert.equal(probe.available, false);
});

test('Cursor probe refuses a CLI without the required safe non-interactive flags', () => {
  const root = fixture(), executable = fakeCli(root, '{"result":"{\\"summary\\":\\"ok\\"}"}', 'fixture-cli 1.0', '--output-format');
  const probe = probeExternalProvider('cursor', { executable });
  assert.equal(probe.available, false);
});

test('provider probe refuses a CLI without an authenticated local session', () => {
  const root = fixture(), executable = officialClaudeCli(root, undefined, '2.1.198', false);
  assert.deepEqual(probeExternalProvider('claude', { executable }), { available: false, reason: 'PROVIDER_AUTH_REQUIRED' });
  const cursor = fakeCli(fixture(), undefined, 'fixture-cursor 1.0', undefined, false);
  assert.deepEqual(probeExternalProvider('cursor', { executable: cursor }), { available: false, reason: 'PROVIDER_AUTH_REQUIRED' });
});

test('official Claude npm package may use a hard-linked native executable', () => {
  const root = fixture(), packageRoot = path.join(root, 'node_modules', '@anthropic-ai', 'claude-code');
  mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
  writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.198' }));
  const binary = path.join(packageRoot, 'bin', 'claude.exe');
  const source = fakeCli(root, '{"result":"{\\"summary\\":\\"ok\\"}"}', '2.1.198 (Claude Code)'); linkSync(source, binary);
  const bin = path.join(root, 'bin'); mkdirSync(bin); symlinkSync(binary, path.join(bin, 'claude'));
  const probe = probeExternalProvider('claude', { env: { PATH: bin } });
  assert.equal(probe.available, true); assert.equal(probe.version, '2.1.198 (Claude Code)');
});

test('official Claude version text with parentheses is accepted by the project profile', async () => {
  const { ProjectProfileSchema } = await import('./lib/project.mjs');
  const root = fixture(), executable = officialClaudeCli(root);
  assert.equal(ProjectProfileSchema.parse({ version: 1, integrationBranch: 'main', packageManager: 'npm', contextPaths: [], checks: [], outputPaths: [], manifests: ['package.json'], ai: { provider: 'claude', model: 'provider-default', providerPath: executable, providerVersion: '2.1.198 (Claude Code)' } }).ai.providerVersion, '2.1.198 (Claude Code)');
});

test('external providers receive an immutable provider-consent gate before any AI node', () => {
  const task = { schemaVersion: 2, id: 'EXT-TEST', goal: 'synthetic', instructions: 'synthetic', scope: ['src'], contextPaths: [], forbiddenPaths: [], includeUntracked: [], acceptance: ['synthetic'], checks: [], resources: [], limits: { maxAttempts: 1, maxReplans: 0, timeoutMs: 5000 }, sourceHash: 'a'.repeat(64) };
  const skillHash = hashObject('synthetic-skill');
  const context = { runtimeHash: 'b'.repeat(64), skills: [...new Set(Object.values(SKILL_ROUTES).flat())].map((id) => ({ id, path: `skills/${id}/SKILL.md`, hash: skillHash })), provider: 'claude' };
  const plan = compilePlanningPlan(task, context).plan;
  assert.equal(plan.nodes[0].action.id, 'human-provider-consent');
  assert.ok(plan.nodes.find((item) => item.action.id === 'human-approve').needs.includes('provider-consent'));
  assert.ok(plan.nodes.find((item) => item.action.id === 'ai-plan').needs.includes('approve-plan'));
});

test('consent payload is typed and binds the CLI, plan, scope and exclusions', () => {
  const value = makeExternalConsent({ provider: 'cursor', planHash: 'a'.repeat(64), scopeHash: 'b'.repeat(64), instructionsHash: 'c'.repeat(64), skillsHash: 'd'.repeat(64), artifactsHash: 'e'.repeat(64), toolchain: { executable: '/synthetic/cursor-agent', version: 'fixture-cli 1.0' } });
  assert.equal(value.excluded.length, 5); assert.equal(value.cliVersion, 'fixture-cli 1.0');
});

test('missing consent blocks the graph, then the gate stores its immutable hash in the receipt', async () => {
  const root = fixture(), executable = officialClaudeCli(root), hash = 'a'.repeat(64);
  const skills = [...new Set(Object.values(SKILL_ROUTES).flat())].map((id) => ({ id, path: `skills/${id}/SKILL.md`, hash }));
  const task = { id: 'EXT-GATE', goal: 'synthetic', instructions: 'synthetic', scope: ['src'], contextPaths: [], forbiddenPaths: [], includeUntracked: [], acceptance: ['synthetic'], checks: [], resources: [], limits: { maxAttempts: 1, maxReplans: 0, timeoutMs: 5000 } };
  const adapters = {
    project: { contextPaths: [], manifests: [], outputPaths: [], ai: { provider: 'claude', providerPath: executable, providerVersion: '2.1.198 (Claude Code)' } },
    identity: () => 'b'.repeat(64), skills: () => skills, capture: () => ({ manifest: { sourceHash: hash }, bundlePath: 'synthetic' }),
    resolveSkills: (node) => node.action.id.startsWith('ai-') ? [...node.skills] : [], resolveReadPaths: (node) => node.resources.reads,
    runner: { ai: { available: true, reason: null }, checks: { available: true, reason: null } },
  };
  const service = await WorkflowService.open({ root, adapters });
  const initial = await service.create(task, { runId: 'ext-gate', stage: 'planning' });
  const gate = initial.gates[0];
  assert.equal(gate.type, 'provider-consent'); assert.deepEqual(gate.requiredPermissions, []);
  const next = await service.command(initial.runId, 'gate', { operationId: 'approve-provider-consent', expectedRevision: initial.revision, planHash: initial.planHash, nodeId: gate.nodeId, decision: 'approve', permissions: [], challenge: gate.challenge });
  const receipt = service.receipt(next.runId, next.nodes.find((node) => node.id === 'provider-consent').receiptIds.at(-1));
  assert.match(receipt.providerConsentHash ?? '', /^[a-f0-9]{64}$/);
  service.close();
});


test('512 KiB review stays outside prompt and synthetic CLI reads the complete exact file', () => {
  const content = 'safe review line\n'.repeat(32768).slice(0, 512 * 1024);
  const f = workerFixture(undefined, { review: { content } });
  const command = providerCliCommand(f.input);
  assert.ok(Buffer.byteLength(command.input) < 2048);
  assert.equal(command.args[command.args.indexOf('--allowedTools') + 1], exactClaudeReadRule(f.input.review.path));
  assert.equal(command.args.includes('--add-dir'), false);
  writeFileSync(f.executable, `#!${node}\nconst fs=require('node:fs'),assert=require('node:assert/strict'),crypto=require('node:crypto');
    if(process.argv.includes('--version')){process.stdout.write('fixture-cli 1.0');process.exit(0);}
    const bytes=fs.readFileSync(${JSON.stringify(f.input.review.path)});
    assert.equal(bytes.length,${f.input.review.bytes});assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),${JSON.stringify(f.input.review.hash)});
    process.stdout.write(JSON.stringify({structured_output:{summary:'complete review read'}}));`);
  const run = f.run(); assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(readFileSync(f.result, 'utf8')), { summary: 'complete review read' });
});

test('Windows provider environment preserves native system/auth paths without loader variables', () => {
  const env = { Path: 'C:\\Tools;C:\\Windows\\System32', SYSTEMROOT: 'C:\\Windows', WINDIR: 'C:\\Windows',
    COMSPEC: 'C:\\Windows\\System32\\cmd.exe', PATHEXT: '.EXE;.CMD', TEMP: 'C:\\Temp', TMP: 'C:\\Temp',
    USERPROFILE: 'C:\\Users\\Fixture', APPDATA: 'C:\\Users\\Fixture\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\Fixture\\AppData\\Local',
    NODE_OPTIONS: '--inspect', ANTHROPIC_API_KEY: 'synthetic-not-inherited' };
  const result = providerEnvironment(env, 'win32');
  assert.equal(result.PATH, env.Path); assert.equal(result.SystemRoot, env.SYSTEMROOT); assert.equal(result.ComSpec, env.COMSPEC);
  for (const key of ['WINDIR','PATHEXT','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA']) assert.equal(result[key], env[key]);
  assert.equal(result.NODE_OPTIONS, undefined); assert.equal(result.ANTHROPIC_API_KEY, undefined);
  assert.ok(providerCandidates('claude', env, 'win32').includes('C:\\Tools\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'));
  assert.ok(providerCandidates('cursor', env, 'win32').includes('C:\\Tools\\cursor-agent.exe'));
  for (const file of ['C:\\Tools\\agent.cmd','C:\\Tools\\agent.bat','C:\\Tools\\cli.js']) assert.throws(() => assertProviderExecutablePlatform(file, 'win32'), { code: 'PROVIDER_NATIVE_EXECUTABLE_REQUIRED' });
  assert.doesNotThrow(() => assertProviderExecutablePlatform('C:\\Tools\\agent.exe', 'win32'));
  assert.equal(exactClaudeReadRule('C:\\Users\\Fixture\\review.json','win32'), 'Read(//c/Users/Fixture/review.json)');
  assert.throws(() => exactClaudeReadRule('C:\\Users\\Fixture\\*.json','win32'), { code: 'PROVIDER_REVIEW_INVALID' });
});


test('Claude large prompt travels over stdin while Windows argv bounds remain explicit', () => {
  const f = workerFixture(undefined, { prompt: 'a'.repeat(40000) });
  const command = providerCliCommand(f.input);
  assert.ok(command.input.length >= 40000);
  assert.ok(command.args.every((arg) => arg.length < 40000));
  assert.equal(command.args.includes('--setting-sources'), false);
  assert.doesNotThrow(() => assertProviderArgv('C:\\cli.exe', command.args, 'win32'));
  assert.throws(() => assertProviderArgv('C:\\cli.exe', ['a'.repeat(40000)], 'win32'), { code: 'PROVIDER_ARGV_LIMIT' });
  assert.doesNotThrow(() => assertProviderArgv('/usr/bin/cli', ['a'.repeat(40000)], 'linux'));
});
