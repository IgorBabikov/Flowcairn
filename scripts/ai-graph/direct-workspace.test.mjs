import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fingerprintDirectWorkspace } from './lib/direct-workspace.mjs';
import { captureDirectSource, verifyDirectSource } from './lib/direct-source.mjs';
import { allocateDirectBinding, replaceDirectBinding, verifyDirectBinding } from './lib/direct-binding.mjs';
import { taskContextInventory } from './lib/intake.mjs';
import { directAdapters } from './lib/direct-adapters.mjs';
import { instructionDenials } from './lib/runner-ai-command.mjs';
import { projectContextPaths } from './lib/project.mjs';
import { compareWorkspaces } from './lib/workspace.mjs';
import { inspectDirectChanges } from './lib/direct-fingerprint.mjs';
import { canonicalJson, sha256 } from './lib/io.mjs';

const fixture = (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flowcairn-direct-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src', 'feature.js'), 'export const ready = true;\n');
  writeFileSync(path.join(root, '.npmrc'), 'private-example-for-fingerprint-only\n');
  return root;
};

test('project without Git hashes live files but withholds private configuration', (t) => {
  const root = fixture(t);
  mkdirSync(path.join(root, '.ai', 'tasks'), { recursive: true });
  writeFileSync(path.join(root, '.ai', 'tasks', 'previous-run.json'), '{"status":"failed"}\n');
  const first = fingerprintDirectWorkspace(root);
  assert.deepEqual(first.files.map((entry) => entry.path), ['src/feature.js']);
  assert.ok(!JSON.stringify(first).includes('private-example'));
  writeFileSync(path.join(root, '.ai', 'tasks', 'previous-run.json'), '{"status":"passed"}\n');
  assert.equal(fingerprintDirectWorkspace(root).hash, first.hash);
  writeFileSync(path.join(root, '.npmrc'), 'different-private-example\n');
  const second = fingerprintDirectWorkspace(root);
  assert.notEqual(second.hash, first.hash);
  assert.deepEqual(second.files, first.files);
});

test('direct source stores only verified immutable descriptors and excludes outputs', (t) => {
  const root = fixture(t);
  mkdirSync(path.join(root, 'dist'));
  writeFileSync(path.join(root, 'dist', 'result.js'), 'generated');
  const source = captureDirectSource(root, { outputPaths: ['dist'] });
  assert.equal(verifyDirectSource(source.bundlePath), source.manifest.sourceHash);
  const body = readFileSync(source.bundlePath, 'utf8');
  assert.ok(!body.includes('private-example'));
  assert.ok(!body.includes('result.js'));
  writeFileSync(path.join(root, 'src', 'feature.js'), 'export const ready = false;\n');
  assert.notEqual(captureDirectSource(root, { outputPaths: ['dist'] }).manifest.sourceHash, source.manifest.sourceHash);
});

test('direct project rejects links in source and protected roots', (t) => {
  const root = fixture(t);
  symlinkSync(path.join(root, 'src', 'feature.js'), path.join(root, 'src', 'alias.js'));
  assert.throws(() => fingerprintDirectWorkspace(root), (error) => error.code === 'DIRECT_LINK');
});

test('direct file order satisfies the verifier when a folder and sibling file share a prefix', (t) => {
  const root = fixture(t);
  mkdirSync(path.join(root, 'src', 'banner'));
  writeFileSync(path.join(root, 'src', 'banner', 'Success.svg'), '<svg/>');
  writeFileSync(path.join(root, 'src', 'banner.ts'), 'export const banner = true;\n');
  const fingerprint = fingerprintDirectWorkspace(root);
  assert.deepEqual(compareWorkspaces(fingerprint, fingerprint), []);
  assert.ok(fingerprint.files.findIndex((file) => file.path === 'src/banner.ts') <
    fingerprint.files.findIndex((file) => file.path === 'src/banner/Success.svg'));
  const legacyFiles = [...fingerprint.files].reverse(), legacy = { files: legacyFiles, git: fingerprint.git,
    hash: sha256(canonicalJson({ files: legacyFiles, git: fingerprint.git })) };
  assert.deepEqual(inspectDirectChanges(legacy, fingerprint,
    { permissions: ['ai.read'], resources: { writes: [] } },
    { scope: ['src'], forbiddenPaths: [] }), { allowed: true, changedFiles: [], violations: [] });
});

test('direct binding stays in the current project and rebinds only after verified source change', (t) => {
  const root = fixture(t), profile = { outputPaths: [] };
  const first = captureDirectSource(root, profile);
  const binding = allocateDirectBinding({ root, task: { id: 'task-direct' }, runId: 'run-direct-one',
    sourceHash: first.manifest.sourceHash, owner: 'local-operator', outputPaths: [] });
  assert.equal(binding.worktree, realpathSync(root));
  assert.deepEqual(verifyDirectBinding(root, binding), binding);
  assert.deepEqual(allocateDirectBinding({ root, task: { id: 'task-direct' }, runId: 'run-direct-one',
    sourceHash: first.manifest.sourceHash, owner: 'local-operator', outputPaths: [] }), binding);
  writeFileSync(path.join(root, 'src', 'feature.js'), 'export const ready = false;\n');
  const next = captureDirectSource(root, profile);
  const rebound = replaceDirectBinding({ root, binding, runId: binding.runId, newRunId: 'run-direct-two',
    sourceHash: next.manifest.sourceHash, previousRunStopped: true });
  assert.equal(rebound.runId, 'run-direct-two');
  assert.throws(() => verifyDirectBinding(root, binding), (error) => error.code === 'DIRECT_BINDING');
  assert.deepEqual(verifyDirectBinding(root, rebound), rebound);
});

test('explicit private files cannot enter a direct task', async (t) => {
  const root = fixture(t);
  const adapters = directAdapters(root, { outputPaths: [], manifests: [], ai: { provider: 'codex', model: 'test' } }, {});
  let created = false;
  await assert.rejects(adapters.registerTask(root, { includeUntracked: ['.npmrc'] }, {
    service: { create: () => { created = true; } },
  }), { code: 'DIRECT_SCOPE' });
  assert.equal(created, false);
});

test('natural direct intake can select package.json but never macOS metadata', (t) => {
  const root = fixture(t);
  writeFileSync(path.join(root, 'package.json'), '{"name":"fixture"}\n');
  writeFileSync(path.join(root, '.DS_Store'), 'not project source');
  const adapters = directAdapters(root, { outputPaths: [], manifests: ['package.json'], contextPaths: [],
    checks: [], ai: { provider: 'codex', model: 'test' } },
  { identity: () => 'test-runtime', instructionPaths: () => [] });
  const project = adapters.projectSummary();
  assert.ok(project.scopeCandidates.includes('package.json'));
  assert.ok(!project.scopeCandidates.includes('.DS_Store'));
});

test('toolchain dependency paths do not become direct source exclusions', (t) => {
  const root = fixture(t), profile = { workspaceMode: 'direct', outputPaths: [], manifests: [],
    contextPaths: [], checks: [], ai: { provider: 'codex', model: 'test' } };
  const adapters = directAdapters(root, profile, { identity: () => 'test-runtime', instructionPaths: () => [] });
  assert.equal(adapters.fingerprint(root, { dependencyPaths: ['node_modules'] }).hash,
    adapters.fingerprint(root).hash);
  assert.deepEqual(instructionDenials(root, { resources: { reads: [] } }, profile,
    { dependencyPaths: ['node_modules'] }), []);
});

test('direct project does not silently send README as planning context', (t) => {
  const root = fixture(t);
  writeFileSync(path.join(root, 'README.md'), '# Internal document\n');
  writeFileSync(path.join(root, 'package.json'), '{"name":"fixture"}\n');
  const profile = { workspaceMode: 'direct', contextPaths: [], manifests: ['package.json'], ai: { provider: 'codex' } };
  assert.deepEqual(projectContextPaths(root, profile), ['package.json']);
  assert.deepEqual(projectContextPaths(root, { ...profile, contextPaths: ['README.md'] }),
    ['README.md', 'package.json']);
});


test('AI inventories include ignored safe names and exclude content secrets and project denials', (t) => {
  const root = fixture(t);
  writeFileSync(path.join(root, '.gitignore'), 'ignored.md\n');
  writeFileSync(path.join(root, 'ignored.md'), 'safe ignored project note');
  writeFileSync(path.join(root, 'internal.md'), 'confidential note');
  writeFileSync(path.join(root, 'ordinary.json'), JSON.stringify({ value: ['ghp_', 'A'.repeat(36)].join('') }));
  const profile = { outputPaths: [], aiDenyGlobs: ['internal.*'], manifests: [], contextPaths: ['internal.md'],
    checks: [], ai: { provider: 'codex', model: 'test' } };
  const adapters = directAdapters(root, profile, { identity: () => 'test-runtime', instructionPaths: () => [] });
  const project = adapters.projectSummary();
  for (const inventory of [adapters.taskContextInventory(), taskContextInventory(root, profile)]) {
    assert.ok(inventory.files.includes('ignored.md'));
    assert.ok(!inventory.files.includes('internal.md'));
    assert.ok(!inventory.files.includes('ordinary.json'));
    assert.ok(!inventory.files.includes('.npmrc'));
  }
  assert.ok(!project.contextPaths.includes('internal.md'));
  assert.ok(!project.scopeCandidates.includes('internal.md'));
  const rawBefore = adapters.fingerprint(root);
  assert.ok(rawBefore.files.some((entry) => entry.path === 'internal.md'));
  writeFileSync(path.join(root, 'internal.md'), 'changed confidential note');
  assert.notEqual(adapters.fingerprint(root).hash, rawBefore.hash);
  assert.notEqual(adapters.projectSummary().contextHash, project.contextHash);
});
