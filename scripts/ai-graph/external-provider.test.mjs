import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, linkSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { compilePlanningPlan } from './lib/planning.mjs';
import { makeExternalConsent, probeExternalProvider, providerToolchain } from './lib/providers.mjs';
import { SKILL_ROUTES } from './lib/config.mjs';
import { hashObject } from './lib/io.mjs';
import { WorkflowService } from './lib/service.mjs';

const node = process.execPath;
const worker = fileURLToPath(new URL('./lib/external-worker.mjs', import.meta.url));
const fixtures = new Set();
function fixture() { const directory = mkdtempSync(path.join(os.tmpdir(), 'flowcairn-external-provider-')); fixtures.add(directory); return directory; }
test.after(() => { for (const directory of fixtures) rmSync(directory, { recursive: true, force: true }); });
function fakeCli(directory, response = '{"result":"{\\"summary\\":\\"ok\\"}"}', version = 'fixture-cli 1.0', help = '--print --output-format --sandbox --mode', authenticated = true) {
  const file = path.join(directory, 'fake-provider');
  writeFileSync(file, `#!${node}\nconst fs=require('node:fs'),args=process.argv.slice(2),help=${JSON.stringify(help)},authenticated=${JSON.stringify(authenticated)};if (args[0] === '--version') process.stdout.write(${JSON.stringify(version + '\n')}); else if (args[0] === 'auth' && args[1] === 'status') {process.stdout.write(JSON.stringify({loggedIn:authenticated})+'\\n');process.exitCode=authenticated?0:1;} else if (args[0] === 'status') {process.stdout.write(JSON.stringify({authenticated})+'\\n');process.exitCode=authenticated?0:1;} else if (args.includes('--help')) {if(['--setting-sources','--strict-mcp-config','--no-session-persistence','--permission-mode','--tools','--output-format','--json-schema','--print','--sandbox','--mode'].some(flag=>args.includes(flag)&&!help.includes(flag))) process.exitCode=2; else process.stdout.write(help+'\\n');} else {fs.writeFileSync('provider-args.json',JSON.stringify(args));process.stdout.write(${JSON.stringify(response)});}\n`);
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
function input(provider, executable, version = 'fixture-cli 1.0') {
  return { version: 1, provider, executable, versionPin: version, prompt: 'synthetic fixture only', schema: { type: 'object' } };
}

test('external worker accepts only a pinned synthetic CLI result and never needs project source', () => {
  const root = fixture(), executable = fakeCli(root), source = path.join(root, 'input.json'), result = path.join(root, 'result.json');
  writeFileSync(source, JSON.stringify(input('claude', executable))); writeFileSync(result, '', { mode: 0o600 });
  const run = spawnSync(node, [worker, source, result], { cwd: root, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: root } });
  assert.equal(run.status, 0); assert.deepEqual(JSON.parse(readFileSync(result, 'utf8')), { summary: 'ok' });
  const args = JSON.parse(readFileSync(path.join(root, 'provider-args.json'), 'utf8'));
  assert.ok(args.includes('--setting-sources')); assert.equal(args[args.indexOf('--setting-sources') + 1], ''); assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(args.includes('--permission-mode')); assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.ok(args.includes('--tools')); assert.ok(args.includes('')); assert.ok(args.includes('--json-schema'));
  assert.equal(args.includes('--bare'), false); assert.equal(args.includes('--safe-mode'), false); assert.equal(args.includes('--permission-prompts'), false);
});

test('Claude worker accepts structured_output returned by --json-schema', () => {
  const root = fixture(), executable = fakeCli(root, '{"result":"ignored text","structured_output":{"summary":"structured"}}'), source = path.join(root, 'input-claude.json'), result = path.join(root, 'result-claude.json');
  writeFileSync(source, JSON.stringify(input('claude', executable))); writeFileSync(result, '', { mode: 0o600 });
  const run = spawnSync(node, [worker, source, result], { cwd: root, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: root } });
  assert.equal(run.status, 0); assert.deepEqual(JSON.parse(readFileSync(result, 'utf8')), { summary: 'structured' });
});

test('external worker gives a fixed auth error instead of accepting a provider failure envelope', () => {
  const root = fixture(), executable = fakeCli(root, '{"is_error":true,"result":"Not logged in"}'), source = path.join(root, 'input-auth.json'), result = path.join(root, 'result-auth.json');
  writeFileSync(source, JSON.stringify(input('claude', executable))); writeFileSync(result, '', { mode: 0o600 });
  const run = spawnSync(node, [worker, source, result], { cwd: root, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: root } });
  assert.notEqual(run.status, 0); assert.match(run.stderr, /PROVIDER_AUTH_REQUIRED/); assert.equal(readFileSync(result, 'utf8'), '');
});

test('Cursor worker enables the documented sandbox and read-only ask mode inside private workspace', () => {
  const root = fixture(), executable = fakeCli(root), source = path.join(root, 'input-cursor.json'), result = path.join(root, 'result-cursor.json');
  writeFileSync(source, JSON.stringify(input('cursor', executable))); writeFileSync(result, '', { mode: 0o600 });
  const run = spawnSync(node, [worker, source, result], { cwd: root, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: root } });
  assert.equal(run.status, 0);
  const args = JSON.parse(readFileSync(path.join(root, 'provider-args.json'), 'utf8'));
  assert.deepEqual(args.slice(0, 7), ['--print', '--output-format', 'json', '--sandbox', 'enabled', '--mode', 'ask']);
  assert.equal(args.includes('--workspace'), false);
  assert.match(args.at(-1), /JSON Schema/);
  assert.match(args.at(-1), /"type":"object"/);
});

test('external worker rejects version drift and non-JSON provider output before a trusted patch can read it', () => {
  const root = fixture(), executable = fakeCli(root, 'not-json');
  for (const version of ['different-version', 'fixture-cli 1.0']) {
    const source = path.join(root, `input-${version.replace(/[^a-z]/g, '')}.json`), result = path.join(root, `result-${version.replace(/[^a-z]/g, '')}.json`);
    writeFileSync(source, JSON.stringify(input('cursor', executable, version))); writeFileSync(result, '', { mode: 0o600 });
    const run = spawnSync(node, [worker, source, result], { cwd: root, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: root } });
    assert.notEqual(run.status, 0); assert.equal(readFileSync(result, 'utf8'), '');
  }
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
