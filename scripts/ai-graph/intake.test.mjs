import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, mkdirSync, readFileSync, writeFileSync, chmodSync, readdirSync, lstatSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initializeProject } from '../../bin/flowcairn.mjs';
import { WorkflowService } from './lib/service.mjs';
import { captureSourceBundle, verifySourceBundle } from './lib/source.mjs';
import { GraphError, hashObject } from './lib/io.mjs';
import { SKILL_ROUTES } from './lib/config.mjs';
const hash = hashObject('intake fixture');
const skills = [...new Set(Object.values(SKILL_ROUTES).flat())].sort().map((id) => ({ id, path: `skills/${id}/SKILL.md`, hash }));
const testClaude = path.resolve(import.meta.dirname, '../../tests/fixtures/verified-claude/node_modules/@anthropic-ai/claude-code/bin/claude.exe');
function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-intake-')));
  t.after(() => {
    const unlock = (folder) => { chmodSync(folder, 0o700); for (const name of readdirSync(folder)) { const file = path.join(folder, name); if (lstatSync(file).isDirectory()) unlock(file); } };
    unlock(root); rmSync(root, { recursive: true, force: true });
  });
  const git = (...args) => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }).trim();
  git('init', '--initial-branch=main');
  mkdirSync(path.join(root, 'src')); writeFileSync(path.join(root, 'src/main.mjs'), 'export const value = 1;\n');
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }));
  writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');
  writeFileSync(path.join(root, 'AGENTS.md'), '# Правила проекта\n');
  git('add', '.'); git('commit', '-m', 'fixture baseline');
  const installed = initializeProject(root, { provider: 'claude', 'provider-path': testClaude, checks: 'tests', 'check-mode': 'hardened', 'package-manager': 'npm' });
  return { root, git, profile: installed.profile };
}
async function service(root, profile) {
  return WorkflowService.open({ root, adapters: {
    project: profile, identity: () => hash, skills: () => skills,
    capture: (task) => { const output = path.join(root, '.ai-orchestrator/graph/sources'); mkdirSync(output, { recursive: true, mode: 0o700 }); return captureSourceBundle(root, output, { allowedUntracked: task.includeUntracked }); },
    verifySource: (file) => verifySourceBundle(file).sourceHash,
    runner: { ai: { available: false, reason: 'synthetic no external AI' }, checks: { available: false, reason: 'synthetic' } },
  } });
}
test('first UI intake snapshots approved package/lock/rules changes and excludes unselected scratch', async (t) => {
  const f = fixture(t), s = await service(f.root, f.profile);
  const initialHead = f.git('rev-parse', 'HEAD');
  writeFileSync(path.join(f.root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', type: 'module', scripts: { test: 'node --test' }, devDependencies: { flowcairn: '0.1.2-dev' } }));
  writeFileSync(path.join(f.root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  writeFileSync(path.join(f.root, 'AGENTS.md'), '# Правила проекта\nДополнительные инструкции владельца\n');
  writeFileSync(path.join(f.root, 'scratch.txt'), 'Do not include this file in AI context');
  const preview = s.project();
  assert.equal(preview.bootstrap.required, true);
  assert.ok(preview.bootstrap.changedPaths.includes('package.json'));
  assert.ok(preview.bootstrap.untrackedCandidates.includes('package-lock.json'));
  assert.equal(preview.bootstrap.untrackedCandidates.includes('.flowcairn.json'), false);
  assert.deepEqual(preview.bootstrap.requiredUntracked.map((file) => file.path), ['.flowcairn.json']);
  assert.match(preview.bootstrap.requiredUntracked[0].hash, /^[a-f0-9]{64}$/);
  assert.equal(preview.scopeCandidates.includes('scratch.txt'), false);
  const body = { prompt: 'Исправь значение в src/main.mjs', operationId: 'intake-bootstrap', contextHash: preview.contextHash,
    snapshot: true, snapshotHash: preview.bootstrap.snapshotHash, includeUntracked: ['package-lock.json'] };
  const snapshot = await s.intake(body);
  assert.equal(snapshot.phase, 'planning');
  assert.equal(snapshot.gates.some((gate) => gate.type === 'provider-consent'), true);
  const state = s.store.readRun(snapshot.runId), source = verifySourceBundle(state.sourceBundle);
  assert.ok(source.entries.some((entry) => entry.path === 'package-lock.json'));
  const requiredProfile = source.entries.find((entry) => entry.path === '.flowcairn.json');
  assert.equal(requiredProfile.worktree.sha256, preview.bootstrap.requiredUntracked[0].hash);
  assert.equal(source.entries.some((entry) => entry.path === 'scratch.txt'), false);
  assert.equal(readFileSync(path.join(f.root, 'scratch.txt'), 'utf8'), 'Do not include this file in AI context');
  assert.equal(f.git('rev-parse', 'HEAD'), initialHead);
  assert.equal(state.binding, null);
  assert.equal((await s.intake(body)).runId, snapshot.runId);
});
test('snapshot consent is rejected when the actual bytes change at the same path', async (t) => {
  const f = fixture(t), s = await service(f.root, f.profile);
  const preview = s.project();
  writeFileSync(path.join(f.root, 'AGENTS.md'), '# Changed after preview');
  await assert.rejects(s.intake({ prompt: 'Исправь значение', operationId: 'intake-stale-bytes', contextHash: preview.contextHash,
    snapshot: true, snapshotHash: preview.bootstrap.snapshotHash, includeUntracked: [] }), (error) => error.code === 'STALE_CONTEXT');
  assert.equal(s.store.listRunIds().length, 0);
});

test('modified private registry configuration stays local and does not block a safe source snapshot', async (t) => {
  const f = fixture(t);
  const config = path.join(f.root, '.npmrc');
  writeFileSync(config, 'registry=https://example.invalid/old\n');
  f.git('add', '.npmrc'); f.git('commit', '-m', 'private config fixture');
  const localBytes = Buffer.from('registry=https://example.invalid/current\n');
  writeFileSync(config, localBytes);
  const s = await service(f.root, f.profile);
  const project = s.project();
  assert.equal(project.capabilities.intake.allowed, true);
  assert.equal(project.bootstrap.changedPaths.includes('.npmrc'), false);
  assert.equal(project.scopeCandidates.includes('.npmrc'), false);
  const snapshot = await s.intake({ prompt: 'Изменить значение в src/main.mjs', operationId: 'intake-private-config',
    contextHash: project.contextHash, snapshot: true, snapshotHash: project.bootstrap.snapshotHash });
  const state = s.store.readRun(snapshot.runId);
  const captured = verifySourceBundle(state.sourceBundle);
  assert.ok(captured.withheldPaths.includes('.npmrc'));
  assert.equal(captured.entries.some((entry) => entry.path === '.npmrc'), false);
  assert.deepEqual(readFileSync(config), localBytes);
});

test('modified installer profile loses required ownership and is shown as an optional candidate', async (t) => {
  const f = fixture(t), s = await service(f.root, f.profile);
  const file = path.join(f.root, '.flowcairn.json');
  writeFileSync(file, readFileSync(file, 'utf8') + '\n');
  const preview = s.project();
  assert.equal(preview.bootstrap.requiredUntracked.some((item) => item.path === '.flowcairn.json'), false);
  assert.equal(preview.bootstrap.untrackedCandidates.includes('.flowcairn.json'), true);
});

test('packaged capture worker returns a verified snapshot without executing AI', async (t) => {
  const f = fixture(t);
  const s = await WorkflowService.open({ root: f.root });
  try {
    const source = await s.adapters.capture({ includeUntracked: [] });
    assert.equal(verifySourceBundle(source.bundlePath).sourceHash, source.manifest.sourceHash);
    assert.ok(source.manifest.entries.some(entry => entry.path === 'src/main.mjs'));
  } finally { s.close(); }
});

test('Skill preflight failure does not create a registry or stale the context; retry can succeed', async t => {
  const f = fixture(t), s = await service(f.root, f.profile);
  const preview = s.project();
  const originalSkills = s.adapters.skills;
  s.adapters.skills = () => { throw new GraphError('SKILLS_CONTEXT_TOO_LARGE', 'Skill limit'); };
  const body = { prompt: 'Исправить значение', operationId: 'skill-preflight-retry', contextHash: preview.contextHash,
    snapshot: true, snapshotHash: preview.bootstrap.snapshotHash, includeUntracked: [] };
  await assert.rejects(s.intake(body), { code: 'SKILLS_CONTEXT_TOO_LARGE' });
  assert.equal(existsSync(path.join(f.root, '.ai-orchestrator/state.json')), false);
  assert.equal(s.project().contextHash, preview.contextHash);
  s.adapters.skills = originalSkills;
  assert.equal((await s.intake(body)).phase, 'planning');
});

test('unfinished old bootstrap can be resumed only with its identical snapshot', async t => {
  const f = fixture(t), s = await service(f.root, f.profile);
  let count = 0;
  const originalSkills = s.adapters.skills;
  s.adapters.skills = task => {
    if (++count === 2) throw new GraphError('SKILLS_CONTEXT_TOO_LARGE', 'Old late Skill failure');
    return originalSkills(task);
  };
  const initial = s.project();
  await assert.rejects(s.intake({ prompt: 'Исправить значение', operationId: 'old-late-skill-failure',
    contextHash: initial.contextHash, snapshot: true, snapshotHash: initial.bootstrap.snapshotHash, includeUntracked: [] }),
  { code: 'SKILLS_CONTEXT_TOO_LARGE' });
  assert.equal(existsSync(path.join(f.root, '.ai-orchestrator/state.json')), true);
  s.adapters.skills = originalSkills;
  const current = s.project();
  assert.notEqual(current.contextHash, initial.contextHash);
  const body = { prompt: 'Исправить значение', operationId: 'resume-old-bootstrap', contextHash: current.contextHash,
    snapshot: true, snapshotHash: current.bootstrap.snapshotHash, includeUntracked: [] };
  assert.equal((await s.intake(body)).phase, 'planning');
  writeFileSync(path.join(f.root, 'src/main.mjs'), 'export const value = 2;\n');
  const changed = s.project();
  await assert.rejects(s.intake({ ...body, operationId: 'reject-changed-bootstrap', contextHash: changed.contextHash,
    snapshotHash: changed.bootstrap.snapshotHash }), { code: 'DIRTY_ROOT' });
});
