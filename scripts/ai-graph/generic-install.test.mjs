import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initializeProject, doctorProject, parseOptions, printInitialization, setupCommand } from '../../bin/flowcairn.mjs';
import { projectRoot, readCheckProfile } from '../../bin/project-files.mjs';
import { inspectOnboarding } from '../../bin/onboarding.mjs';
import { uninstallCommand } from '../../bin/uninstall.mjs';
import { authorLink } from '../../bin/terminal.mjs';
import { hasTrustedLocalChecksBinding, loadProjectProfile, trustedLocalChecksHash } from './lib/project.mjs';

const provider = { provider: 'claude', 'provider-path': path.resolve(import.meta.dirname, '../../tests/fixtures/verified-claude/node_modules/@anthropic-ai/claude-code/bin/claude.exe'), 'read-consent': true };
const read = (root, file) => readFileSync(path.join(root, file), 'utf8');
function fixture(t, files = {}) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-generic-install-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [relative, text] of Object.entries({ 'AGENTS.md': 'Preserve owner instructions.\n', ...files })) {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), text);
  }
  return root;
}
function profile(root, executable = 'flowcairn-test-missing-runtime') {
  // No test executes this project command. Even --version would create a marker.
  writeFileSync(path.join(root, 'verify-tool'), '#!/bin/sh\nprintf executed > command-was-run\n');
  chmodSync(path.join(root, 'verify-tool'), 0o700);
  const value = { version: 1, requiredCheckIds: ['quality'], definitions: [{
    id: 'quality', title: 'Проверить контракт', purpose: 'Проверить результат проекта',
    command: { executable, argv: ['--verify', 'source.unknown'], cwd: '.' },
    inputPaths: ['verify-tool'], outputPaths: [], timeoutMs: 10000, maxOutputBytes: 8192,
  }], environment: [] };
  writeFileSync(path.join(root, 'checks.json'), JSON.stringify(value));
  return value;
}

test('generic entrypoint accepts source directories without package.json or Git', (t) => {
  const root = fixture(t, { 'app.py': 'print("hello")\n' });
  assert.equal(projectRoot(root), root);
  const preview = initializeProject(root, { ...provider, 'dry-run': true });
  assert.equal(preview.profile.version, 2);
  assert.deepEqual(preview.profile.checks, []);
  assert.equal(existsSync(path.join(root, '.flowcairn.json')), false);
  const installed = initializeProject(root, provider);
  assert.equal(installed.profile.packageManager, undefined);
  assert.deepEqual(installed.profile.manifests, []);
  assert.equal(loadProjectProfile(root).version, 2);
  assert.equal(existsSync(path.join(root, 'package.json')), false);
  assert.equal(read(root, 'app.py'), 'print("hello")\n');
});

test('first non-Node launch without checks gives the registration route in terminal and UI settings data', (t) => {
  const root = fixture(t, { 'app.py': 'print("hello")\n' });
  const installed = initializeProject(root, provider);
  let text = '';
  printInitialization(installed, { launching: true, output: { write: (value) => { text += value; } } });
  assert.match(text, /npx flowcairn setup --check-profile checks\.json/);
  assert.match(text, /CHECK-PROFILES\.md/);
  const onboarding = inspectOnboarding(root);
  assert.ok(onboarding.limitations.some((message) => message.includes('npx flowcairn setup --check-profile checks.json')));
  assert.equal(existsSync(path.join(root, 'checks.json')), false);
});

test('npm transport manifests and placeholder scripts do not select the Node adapter', (t) => {
  for (const [source, text] of [['app.py', 'print(1)'], ['main.go', 'package main'], ['source.unknown', 'opaque source']]) {
    const manifest = JSON.stringify({ name: 'tooling', devDependencies: { flowcairn: '0.4.4' }, scripts: { test: 'echo "Error: no test specified" && exit 1' } });
    const root = fixture(t, { [source]: text, 'package.json': manifest, 'package-lock.json': '{}' });
    const installed = initializeProject(root, provider);
    assert.equal(installed.profile.version, 2);
    assert.equal(installed.profile.packageManager, undefined);
    assert.deepEqual(installed.profile.checks, []);
    assert.deepEqual(installed.profile.manifests, []);
    assert.equal(read(root, 'package.json'), manifest);
    assert.equal(read(root, source), text);
  }
});

test('Node project scripts retain the V1 adapter; explicit generic profiles take precedence', (t) => {
  const pkg = JSON.stringify({ scripts: { test: 'node --test' } });
  const legacy = fixture(t, { 'package.json': pkg });
  assert.equal(initializeProject(legacy, provider).profile.version, 1);
  assert.equal(loadProjectProfile(legacy).packageManager, 'npm');
  const root = fixture(t, { 'package.json': pkg, 'source.unknown': 'data' });
  const value = profile(root, './verify-tool');
  const installed = initializeProject(root, { ...provider, 'check-profile': 'checks.json' });
  assert.equal(installed.profile.version, 2);
  assert.deepEqual(installed.profile.checkProfile, value);
  assert.deepEqual(installed.profile.checks, ['quality']);
  assert.equal(installed.profile.checkScripts, undefined);
  assert.equal(installed.profile.packageManager, undefined);
  assert.equal(hasTrustedLocalChecksBinding(root), true);
  assert.equal(existsSync(path.join(root, 'command-was-run')), false);
  assert.equal(read(root, 'package.json'), pkg);
});

test('init registers missing tools for later readiness reporting and is repeatable', async (t) => {
  const root = fixture(t, { 'source.unknown': 'data' });
  profile(root);
  const options = { ...provider, 'check-profile': 'checks.json' };
  const first = initializeProject(root, options);
  const before = read(root, '.ai-orchestrator/flowcairn-install.json');
  assert.equal(first.profile.version, 2);
  assert.equal(initializeProject(root, options).created, false);
  assert.equal(read(root, '.ai-orchestrator/flowcairn-install.json'), before);
  const doctor = await doctorProject(root);
  assert.equal(doctor.ok, false);
  assert.equal(doctor.branch, null);
  assert.equal(doctor.packageManager, undefined);
  assert.equal(doctor.manager.valid, false);
  assert.notEqual(doctor.manager.code, 'PACKAGE_MANAGER');
  assert.equal(existsSync(path.join(root, 'command-was-run')), false);
  assert.equal(inspectOnboarding(root).configured, true);
});

test('doctor inspects a registered executable without running even a version probe', async (t) => {
  const root = fixture(t, { 'source.unknown': 'data' });
  profile(root, './verify-tool');
  initializeProject(root, { ...provider, 'check-profile': 'checks.json' });
  const doctor = await doctorProject(root);
  assert.equal(doctor.manager.valid, true, doctor.manager.message);
  assert.equal(doctor.manager.kind, 'registered-commands');
  assert.equal(doctor.checks.available, true, doctor.checks.reason);
  assert.equal(existsSync(path.join(root, 'command-was-run')), false);
  assert.equal(existsSync(path.join(root, 'node_modules')), false);
});

test('CLI task JSON with explicit untracked files retains configured generic check IDs', (t) => {
  const root = fixture(t, { 'source.unknown': 'data' });
  profile(root, './verify-tool');
  initializeProject(root, { ...provider, 'check-profile': 'checks.json' });
  const spec = path.join(root, '.ai-orchestrator', 'input.json');
  writeFileSync(spec, JSON.stringify({ id: 'GENERIC-JSON', goal: 'Проверить исходник', instructions: 'Проверить исходник',
    scope: ['source.unknown'], acceptance: ['Исходник проверен'], checks: ['quality'] }));
  const output = execFileSync(process.execPath, [path.resolve(import.meta.dirname, '../../bin/flowcairn.mjs'), 'task',
    '--file', spec, '--include-untracked', 'source.unknown', '--snapshot', '--json'], { cwd: root, encoding: 'utf8', timeout: 20000 });
  const response = JSON.parse(output);
  assert.equal(response.ok, true); assert.equal(response.result.schemaVersion, 3);
  assert.ok(response.result.nodes.some((node) => node.action.id === 'check-quality'));
  assert.ok(response.result.nodes.every((node) => node.attempt === 0));
  assert.equal(existsSync(path.join(root, 'command-was-run')), false);
});

test('setup explicitly upgrades a legacy profile and renews registration without changing user files', async (t) => {
  const pkg = JSON.stringify({ scripts: { test: 'node --test' } });
  const root = fixture(t, { 'package.json': pkg, 'source.unknown': 'data' });
  initializeProject(root, provider);
  const previous = read(root, '.flowcairn.json');
  const oldHash = trustedLocalChecksHash(root, loadProjectProfile(root));
  profile(root);
  assert.throws(() => initializeProject(root, { ...provider, 'check-profile': 'checks.json' }), { code: 'CHECK_PROFILE_EXISTS' });
  const preview = await setupCommand(root, { ...provider, 'check-profile': 'checks.json', 'dry-run': true });
  assert.equal(preview.profile.version, 2);
  assert.equal(read(root, '.flowcairn.json'), previous);
  const installed = await setupCommand(root, { ...provider, 'check-profile': 'checks.json' });
  assert.equal(installed.profile.version, 2);
  assert.deepEqual(installed.profile.checks, ['quality']);
  assert.equal(installed.profile.packageManager, undefined);
  assert.notEqual(trustedLocalChecksHash(root, installed.profile), oldHash);
  assert.equal(hasTrustedLocalChecksBinding(root), true);
  assert.equal(read(root, 'package.json'), pkg);
  assert.equal(read(root, 'AGENTS.md'), 'Preserve owner instructions.\n');
  assert.equal(existsSync(path.join(root, 'command-was-run')), false);
});

test('setup without package.json retains a generic registry and rejects unregistered checks', async (t) => {
  const root = fixture(t, { 'source.unknown': 'data' });
  const value = profile(root);
  initializeProject(root, { ...provider, 'check-profile': 'checks.json' });
  await setupCommand(root, { ...provider, 'test-policy': 'add' });
  assert.deepEqual(loadProjectProfile(root).checkProfile, value);
  const before = read(root, '.flowcairn.json');
  await assert.rejects(setupCommand(root, { ...provider, checks: 'not-registered' }), { code: 'CHECK_NOT_REGISTERED' });
  assert.equal(read(root, '.flowcairn.json'), before);
  assert.equal(existsSync(path.join(root, 'package.json')), false);
});

test('registered outputs and input directories do not become mandatory Node manifests', async (t) => {
  const root = fixture(t, { 'tooling/check.txt': 'check configuration' });
  initializeProject(root, provider);
  const value = profile(root);
  value.definitions[0].inputPaths = ['tooling'];
  value.definitions[0].outputPaths = ['check-results'];
  writeFileSync(path.join(root, 'checks.json'), JSON.stringify(value));
  const result = await setupCommand(root, { ...provider, 'check-profile': 'checks.json' });
  assert.deepEqual(result.profile.outputPaths, ['check-results']);
  assert.deepEqual(result.profile.manifests, []);
  assert.equal(hasTrustedLocalChecksBinding(root), true);
  const clone = fixture(t, { 'tooling/check.txt': 'check configuration', 'checks.json': JSON.stringify(value) });
  const initialized = initializeProject(clone, { ...provider, 'check-profile': 'checks.json' });
  assert.deepEqual(initialized.profile.manifests, []);
  assert.deepEqual(initialized.profile.outputPaths, ['check-results']);
});

test('disabling generic checks preserves definitions and repeated init remains inert', async (t) => {
  const root = fixture(t);
  const value = profile(root);
  const options = { ...provider, 'check-profile': 'checks.json', 'check-mode': 'none' };
  initializeProject(root, options);
  assert.equal(initializeProject(root, options).created, false);
  assert.deepEqual(loadProjectProfile(root).checkProfile.definitions, value.definitions);
  assert.deepEqual(loadProjectProfile(root).checkProfile.requiredCheckIds, []);
  const enabled = await setupCommand(root, { ...provider, 'check-profile': 'checks.json', 'check-mode': 'trusted-local' });
  assert.deepEqual(enabled.profile.checks, ['quality']);
});

test('generic profile imports reject traversal, links, excessive size and unknown properties', (t) => {
  const root = fixture(t);
  profile(root);
  for (const relative of ['../checks.json', '/tmp/checks.json', './checks.json', 'dir\\checks.json'])
    assert.throws(() => readCheckProfile(root, relative), { code: 'CHECK_PROFILE_PATH' });
  symlinkSync(path.join(root, 'checks.json'), path.join(root, 'linked.json'));
  assert.throws(() => readCheckProfile(root, 'linked.json'));
  linkSync(path.join(root, 'checks.json'), path.join(root, 'hardlinked.json'));
  assert.throws(() => readCheckProfile(root, 'hardlinked.json'), { code: 'UNSAFE_FILE' });
  writeFileSync(path.join(root, 'large.json'), ' '.repeat(65537));
  assert.throws(() => readCheckProfile(root, 'large.json'), { code: 'UNSAFE_FILE' });
  writeFileSync(path.join(root, '.env.json'), '{}');
  assert.throws(() => readCheckProfile(root, '.env.json'), { code: 'UNSAFE_FILE' });
  writeFileSync(path.join(root, 'extra.json'), JSON.stringify({ version: 1, requiredCheckIds: [], definitions: [], environment: [], runImmediately: true }));
  assert.throws(() => initializeProject(root, { ...provider, 'check-profile': 'extra.json' }), { code: 'CHECK_PROFILE_INVALID' });
  assert.equal(existsSync(path.join(root, '.flowcairn.json')), false);
});

test('safe uninstall preserves generic sources, transport manifest and imported profile', async (t) => {
  const pkg = JSON.stringify({ devDependencies: { flowcairn: '0.4.4' } });
  const root = fixture(t, { 'package.json': pkg, 'app.py': 'print(1)' });
  profile(root);
  initializeProject(root, { ...provider, 'check-profile': 'checks.json' });
  const preview = await uninstallCommand(projectRoot(root), { 'dry-run': true });
  assert.equal(preview.canRemove, true);
  const result = await uninstallCommand(projectRoot(root));
  assert.ok(result.removed.includes('.flowcairn.json'));
  assert.equal(read(root, 'package.json'), pkg);
  assert.equal(read(root, 'app.py'), 'print(1)');
  assert.equal(read(root, 'AGENTS.md'), 'Preserve owner instructions.\n');
  assert.equal(existsSync(path.join(root, 'checks.json')), true);
  assert.equal(existsSync(path.join(root, 'command-was-run')), false);
});

test('CLI profile option and original Telegram onboarding link remain available', () => {
  assert.deepEqual(parseOptions(['--check-profile', 'checks.json']), { 'check-profile': 'checks.json' });
  assert.throws(() => parseOptions(['--check-profile', 'a.json', '--check-profile', 'b.json']), { code: 'ARGUMENT' });
  let text = '';
  printInitialization({ created: true }, { output: { isTTY: false, write: (value) => { text += value; } } });
  assert.match(text, /npx flowcairn/);
  assert.match(authorLink({ isTTY: true }, { TERM: 'xterm' }), /https:\/\/t\.me\/Babikov_build/);
});
