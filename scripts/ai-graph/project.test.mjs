import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadProjectProfile,
  ProjectProfileSchema,
  projectProfileHash,
  projectContextPaths,
  RUNTIME_ROOT,
} from './lib/project.mjs';
import { runtimeIdentity, WorkflowService } from './lib/service.mjs';
import { defaultAdapters } from './lib/service-adapters.mjs';
import { loadSkill } from './lib/skills.mjs';
const profile = {
  version: 1,
  integrationBranch: 'main',
  packageManager: 'npm',
  contextPaths: [],
  checks: ['tests'],
  outputPaths: ['dist'],
  manifests: [],
  ai: { provider: 'codex', model: 'test-model' },
};
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flowcairn-project-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, '.flowcairn.json'), JSON.stringify(profile));
  return root;
}
test('strict portable project profile does not require a product layout', (t) => {
  const root = fixture(t);
  assert.deepEqual(loadProjectProfile(root), { ...profile, checkMode: 'none' });
  assert.deepEqual(projectContextPaths(root), []);
  assert.equal(projectProfileHash(root).length, 64);
  assert.notEqual(RUNTIME_ROOT, root);
});
test('profile rejects secrets, shell fields, escaping paths and invalid branch refs', () => {
  for (const value of [
    { ...profile, apiKey: 'secret' },
    { ...profile, command: ['sh', '-c', 'x'] },
    { ...profile, contextPaths: ['../outside'] },
    { ...profile, outputPaths: ['.git'] },
    { ...profile, integrationBranch: 'main..bad' },
    { ...profile, ai: { ...profile.ai, apiKey: 'secret' } },
    { ...profile, ai: { ...profile.ai, baseUrl: 'https://user:password@example.com' } },
  ])
    assert.equal(ProjectProfileSchema.safeParse(value).success, false);
});
test('profile symlinks are refused', (t) => {
  const root = fixture(t);
  rmSync(path.join(root, '.flowcairn.json'));
  writeFileSync(path.join(root, 'config.json'), JSON.stringify(profile));
  symlinkSync('config.json', path.join(root, '.flowcairn.json'));
  assert.throws(() => loadProjectProfile(root), { code: 'PROJECT_PROFILE_UNSAFE' });
});
test('package skills resolve independently from the project directory', (t) => {
  const root = fixture(t);
  const skill = loadSkill(root, 'project-context');
  assert.equal(skill.name, 'project-context');
  assert.equal(skill.path, 'skills/project-context/SKILL.md');
});
test('runtime identity pins existing repository instructions and project profile', (t) => {
  const root = fixture(t);
  const initial = runtimeIdentity(root);
  writeFileSync(path.join(root, 'AGENTS.md'), 'Project instructions');
  const instructions = runtimeIdentity(root);
  assert.notEqual(initial, instructions);
  writeFileSync(
    path.join(root, '.flowcairn.json'),
    JSON.stringify({ ...profile, checks: ['lint'] }),
  );
  assert.notEqual(instructions, runtimeIdentity(root));
});
test('default service opens an arbitrary configured root with packaged runtime', async (t) => {
  const root = fixture(t);
  const service = await WorkflowService.open({ root });
  assert.deepEqual(service.capabilities().create, { allowed: true, reason: null });
  assert.equal(service.adapters.project.integrationBranch, 'main');
});

test('context directories contribute bounded identity without requiring product directories', (t) => {
  const root = fixture(t);
  mkdirSync(path.join(root, 'docs'));
  writeFileSync(path.join(root, 'docs', 'context.md'), 'first');
  writeFileSync(
    path.join(root, '.flowcairn.json'),
    JSON.stringify({ ...profile, contextPaths: ['docs/'] }),
  );
  const before = runtimeIdentity(root);
  writeFileSync(path.join(root, 'docs', 'context.md'), 'second');
  assert.notEqual(before, runtimeIdentity(root));
});

test('direct runtime keeps its identity when approved project files change', async (t) => {
  const root = fixture(t);
  writeFileSync(path.join(root, 'AGENTS.md'), 'Initial instructions');
  writeFileSync(path.join(root, 'package.json'), '{"scripts":{"test":"node --test"}}');
  writeFileSync(path.join(root, '.flowcairn.json'), JSON.stringify({ ...profile,
    workspaceMode: 'direct', manifests: ['package.json'], contextPaths: ['AGENTS.md'] }));
  const adapters = await defaultAdapters(root);
  const task = { scope: ['AGENTS.md', 'package.json'], contextPaths: ['AGENTS.md', 'package.json'] };
  const runtime = runtimeIdentity(root), identity = adapters.identity(), context = adapters.contextHash(task);
  writeFileSync(path.join(root, 'package.json'), '{"scripts":{"test":"node --test","build":"echo done"}}');
  writeFileSync(path.join(root, 'AGENTS.md'), 'Updated instructions');
  assert.equal(runtimeIdentity(root), runtime);
  assert.equal(adapters.identity(), identity);
  assert.equal(adapters.contextHash(task), context);
  writeFileSync(path.join(root, '.flowcairn.json'), JSON.stringify({ ...profile,
    workspaceMode: 'direct', manifests: ['package.json'], contextPaths: ['AGENTS.md'], checks: ['lint'] }));
  assert.notEqual(runtimeIdentity(root), runtime);
});

test('default AI context excludes lockfiles while preserving explicit lockfile opt-in', (t) => {
  const root = fixture(t);
  writeFileSync(path.join(root, 'AGENTS.md'), 'Project instructions');
  const configured = {
    ...profile,
    manifests: [
      'package.json',
      'package-lock.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'packages/app/package.json',
    ],
  };
  assert.deepEqual(projectContextPaths(root, configured), [
    'AGENTS.md',
    'package.json',
    'packages/app/package.json',
  ]);
  assert.deepEqual(
    projectContextPaths(root, { ...configured, contextPaths: ['package-lock.json'] }),
    ['AGENTS.md', 'package-lock.json', 'package.json', 'packages/app/package.json'],
  );
  assert.equal(configured.manifests.length, 5, 'Dependency integrity manifest remains complete');
});

test('public service rejects unconfigured and legacy checks before source capture or AI', async (t) => {
  const root = fixture(t);
  const service = await WorkflowService.open({ root });
  let captured = 0;
  let executed = 0;
  service.adapters.capture = () => {
    captured++;
    throw new Error('Unexpected capture');
  };
  service.adapters.execute = async () => {
    executed++;
    throw new Error('Unexpected AI');
  };
  const input = {
    id: 'ORCH-CHECK',
    goal: 'Bound checks',
    instructions: 'Edit one source file',
    scope: ['src/'],
    acceptance: ['File changed'],
  };
  for (const check of ['build', 'graph-tests', 'shared-build']) {
    await assert.rejects(
      () => service.create({ ...input, checks: [check] }, { runId: `run-reject-${check}` }),
      { code: 'CHECK_NOT_CONFIGURED' },
    );
    await assert.rejects(
      () =>
        service.create(
          { ...input, checks: ['tests'] },
          {
            runId: `run-draft-${check}`,
            draft: { nodes: [{ id: 'extra-check', action: { id: `check-${check}` } }] },
          },
        ),
      { code: 'CHECK_NOT_CONFIGURED' },
    );
  }
  assert.equal(captured, 0);
  assert.equal(executed, 0);
  assert.deepEqual(service.store.listRunIds(), []);
});
