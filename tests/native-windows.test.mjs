import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, copyFileSync, chmodSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initializeProject } from '../bin/flowcairn.mjs';
import { runRegisteredAction, inspectCodexInstallation } from '../scripts/ai-graph/lib/runner.mjs';
import { prepareToolchain } from '../scripts/ai-graph/lib/toolchain.mjs';
import { fingerprintDirectWorkspace } from '../scripts/ai-graph/lib/direct-workspace.mjs';
import { TaskSpecSchema, NodeDefinitionSchema, GraphPlanSchema } from '../scripts/ai-graph/lib/schemas.mjs';
import { WorkflowService } from '../scripts/ai-graph/lib/service.mjs';
import { hashObject } from '../scripts/ai-graph/lib/io.mjs';

// CI sets this flag so a shell accidentally routed through WSL cannot pass.
test('Windows CI is a native Windows Node process', () => {
  if (process.env.FLOWCAIRN_REQUIRE_NATIVE_WINDOWS === '1') {
    assert.equal(process.platform, 'win32');
    assert.equal(process.versions.node, '22.13.1');
    assert.equal(process.env.WSL_DISTRO_NAME, undefined);
  }
});

function fixture(t, delay = 0) {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-native-ci-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'project'), cliRoot = path.join(base, 'cli');
  mkdirSync(root);
  const platformName = `${process.platform}-${process.arch}`;
  const cpu = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const triple = `${cpu}-${process.platform === 'win32' ? 'pc-windows-msvc' : process.platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-musl'}`;
  const entry = path.join(cliRoot, 'bin', 'codex.js');
  const nativeRoot = path.join(cliRoot, 'node_modules', '@openai', `codex-${platformName}`);
  const native = path.join(nativeRoot, 'vendor', triple, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
  mkdirSync(path.dirname(entry), { recursive: true });
  mkdirSync(path.dirname(native), { recursive: true });
  writeFileSync(path.join(cliRoot, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '9.9.9' }));
  writeFileSync(path.join(nativeRoot, 'package.json'), JSON.stringify({ name: '@openai/codex', version: `9.9.9-${platformName}` }));
  copyFileSync(process.execPath, native); // Executable fixture only; project source is never copied.
  chmodSync(native, 0o700);
  writeFileSync(entry, `const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex-cli 9.9.9'); process.exit(0); }
if (args[0] === 'login') process.exit(0);
if (args[0] === 'sandbox') { console.log('--permission-profile'); process.exit(0); }
if (args.includes('--help')) { console.log('--ignore-rules --strict-config --ephemeral --skip-git-repo-check --json --output-schema --output-last-message --cd --config --model'); process.exit(0); }
const result = { summary: 'native-fixture-cwd:' + process.cwd(), verdict: 'pass', skillsUsed: [], findings: [], changedFiles: [], edits: [], moves: [], jsonTransfers: [], plan: [], reviewEvidenceHash: null };
process.stdin.resume();
process.stdin.on('end', () => { fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify(result)); console.log('fixture completed'); });
`);
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'native-fixture', version: '1.0.0', scripts: { test: 'node native-check.cjs' } }));
  writeFileSync(path.join(root, 'package-lock.json'), '{"name":"native-fixture","lockfileVersion":3,"packages":{}}');
  writeFileSync(path.join(root, 'native-check.cjs'), `const fs=require('node:fs'); const path=require('node:path'); setTimeout(()=>{fs.mkdirSync('dist',{recursive:true});fs.writeFileSync(path.join('dist','marker.txt'), process.cwd());console.log('native-check-marker');}, ${delay});`);
  for (const file of [entry, path.join(cliRoot, 'package.json'), path.join(nativeRoot, 'package.json')]) chmodSync(file, 0o600);
  const cliProbe = inspectCodexInstallation({ codexPath: entry });
  assert.equal(cliProbe.available, true, JSON.stringify(cliProbe));
  const installed = initializeProject(root, { provider: 'codex', 'codex-path': entry, model: 'fixture-model', 'model-mode': 'manual', 'reasoning-effort': 'medium', checks: 'tests', outputs: 'dist' });
  assert.equal(installed.profile.workspaceMode, 'direct');
  assert.equal(installed.profile.checkMode, 'trusted-local');
  assert.equal(existsSync(path.join(root, '.git')), false);
  const output = path.join(root, '.ai-orchestrator', 'graph', 'native-output');
  mkdirSync(output, { recursive: true, mode: 0o700 });
  mkdirSync(path.join(root, '.ai-orchestrator', 'graph', 'runner-tickets'), { recursive: true, mode: 0o700 });
  return { root, output, cliEntry: entry, toolchain: prepareToolchain({ root, worktree: root }) };
}

function contract(root, actionId, timeoutMs = 15000) {
  const task = TaskSpecSchema.parse({ schemaVersion: 2, id: 'NATIVE-WINDOWS', goal: 'Run a native fixture', instructions: 'Use the registered fixture', scope: ['native-check.cjs'], acceptance: ['Native check completes'], checks: ['tests'], sourceHash: fingerprintDirectWorkspace(root, { outputPaths: ['dist'] }).hash, limits: { maxAttempts: 1, maxReplans: 0, timeoutMs } });
  const node = NodeDefinitionSchema.parse({ id: 'native-step', title: 'Native fixture', outcome: 'Fixture completed', needs: [], action: { id: actionId, version: 1, inputs: {} }, success: { kind: actionId.startsWith('check-') ? 'checks' : 'analysis', requiredArtifacts: [] }, permissions: actionId.startsWith('check-') ? ['workspace.output.write'] : ['ai.read'], skills: [], resources: { reads: ['native-check.cjs'], writes: [], exclusive: [] }, retry: { maxAttempts: 1, backoffMs: 0 } });
  const gate = { ...node, id: 'accept-native', needs: [node.id], action: { id: 'human-accept', version: 1, inputs: {} }, success: { kind: 'gate', requiredArtifacts: [] }, permissions: [] };
  const plan = GraphPlanSchema.parse({ schemaVersion: 2, taskHash: hashObject(task), version: 1, parentPlanHash: null, sourceHash: task.sourceHash, runtimeHash: 'a'.repeat(64), registryHash: 'b'.repeat(64), policyHash: 'c'.repeat(64), skills: [], nodes: [node, gate] });
  return { task, node, plan };
}

async function run(f, actionId, timeoutMs) {
  let started = null;
  const result = await runRegisteredAction({ root: f.root, worktree: f.root, ...contract(f.root, actionId, timeoutMs), skills: [], toolchain: f.toolchain, outputDirectory: f.output, signal: undefined, onStart(metadata) { started = metadata; } });
  assert.ok(started, JSON.stringify(result));
  assert.equal(result.stopped, true, JSON.stringify(result));
  assert.equal(result.uncertain, false, JSON.stringify(result));
  return result;
}

test('no-Git init runs native Node/npm registered check in original directory', { timeout: 45000 }, async (t) => {
  const f = fixture(t);
  const service = await WorkflowService.open({ root: f.root });
  try {
    assert.equal(service.project().schemaVersion, 2);
    const { schemaVersion: _schema, sourceHash: _source, ...taskInput } = contract(f.root, 'check-tests').task;
    const created = await service.create(taskInput, { runId: 'native-workflow', operationId: 'native-create', stage: 'planning' });
    assert.equal(created.runId, 'native-workflow');
  } finally { service.close(); }
  const result = await run(f, 'check-tests');
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.equal(result.failureReason, null, JSON.stringify(result));
  assert.equal(readFileSync(path.join(f.root, 'dist', 'marker.txt'), 'utf8'), f.root);
  assert.match(result.output.stdoutDigest, /^[a-f0-9]{64}$/);
  assert.ok(result.output.stdoutBytes > 0);
  assert.equal('stdout' in result.output, false);
  if (process.platform === 'win32') {
    const ai = await run(f, 'ai-analyze');
    assert.equal(ai.exitCode, 0, JSON.stringify(ai));
    assert.equal(ai.output.summary, `native-fixture-cwd:${f.root}`);
  }
});

test('native registered check timeout terminates the process tree', { timeout: 45000 }, async (t) => {
  const f = fixture(t, 15000);
  const result = await run(f, 'check-tests', 1000);
  assert.equal(result.failureReason, 'TIMEOUT', JSON.stringify(result));
  assert.equal(result.timedOut, true);
  assert.equal(existsSync(path.join(f.root, 'dist', 'marker.txt')), false);
});


test('native Windows fresh npm archive install preserves project files and runs installed CLI', { skip: process.platform !== 'win32', timeout: 240000 }, (t) => {
  const f = fixture(t);
  const directory = path.dirname(f.root), installed = path.join(directory, 'installed-project');
  mkdirSync(installed);
  const owner = '# Existing owner rules\n';
  writeFileSync(path.join(installed, 'AGENTS.md'), owner);
  writeFileSync(path.join(installed, 'package.json'), '{"name":"existing-native-project","version":"1.0.0","private":true}\n');
  const npm = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const runtime = fileURLToPath(new URL('..', import.meta.url));
  const cache = path.join(directory, 'npm-cache');
  const packed = JSON.parse(execFileSync(process.execPath, [npm, 'pack', '--ignore-scripts', '--json', '--cache', cache, '--pack-destination', directory], { cwd: runtime, encoding: 'utf8', timeout: 60000 }));
  execFileSync(process.execPath, [npm, 'install', path.join(directory, packed[0].filename), '--ignore-scripts', '--no-audit', '--no-fund', '--cache', cache], { cwd: installed, encoding: 'utf8', timeout: 120000 });
  const bin = path.join(installed, 'node_modules', 'flowcairn', 'bin', 'flowcairn.mjs');
  const created = JSON.parse(execFileSync(process.execPath, [bin, 'init', '--provider', 'codex', '--codex-path', f.cliEntry, '--model', 'fixture-model', '--model-mode', 'manual', '--reasoning-effort', 'medium', '--check-mode', 'none', '--json'], { cwd: installed, encoding: 'utf8', timeout: 30000 }));
  assert.equal(created.result.profile.workspaceMode, 'direct');
  assert.equal(readFileSync(path.join(installed, 'AGENTS.md'), 'utf8'), owner);
  assert.equal(JSON.parse(readFileSync(path.join(installed, 'package.json'))).name, 'existing-native-project');
  assert.ok(existsSync(path.join(installed, 'node_modules', 'flowcairn', 'scripts', 'ai-graph', 'lib', 'windows-job.cs')));
  assert.equal(existsSync(path.join(installed, '.git')), false);
});
