import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initializeProject } from '../bin/flowcairn.mjs';
import { packageManagerVersion, packageManagerLock, ProjectProfileSchema, resolveProjectCheckScript } from '../scripts/ai-graph/lib/project.mjs';
import { DOCKER_CHECKS_TESTING } from '../scripts/ai-graph/lib/docker-checks.mjs';
import { registeredContainerCheck } from '../scripts/ai-graph/container-check.mjs';
import { prepareToolchain, verifyToolchain } from '../scripts/ai-graph/lib/toolchain.mjs';

const options = { provider: 'openai', model: 'fixture-model' };
function fixture(t, manager = 'yarn', version = '4.9.2') {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-manager-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('/usr/bin/git', ['init', '--initial-branch=main'], { cwd: root, stdio: 'ignore' });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'manager-fixture', version: '1.0.0', packageManager: `${manager}@${version}`, scripts: { test: 'node --test' }, workspaces: ['packages/*'] }));
  mkdirSync(path.join(root, 'packages/app'), { recursive: true });
  writeFileSync(path.join(root, 'packages/app/package.json'), '{"name":"fixture-app","version":"1.0.0"}');
  writeFileSync(path.join(root, packageManagerLock(manager)), manager === 'yarn' ? '__metadata:\n  version: 8\n' : 'lockfileVersion: 9\n');
  if (manager === 'yarn') writeFileSync(path.join(root, '.yarnrc.yml'), 'nodeLinker: node-modules\n');
  return root;
}

test('Yarn4 init discovers lock and workspaces, keeps config out of Docker, pins identity and repeats', (t) => {
  const root = fixture(t);
  const initialized = initializeProject(root, options);
  assert.equal(initialized.profile.packageManager, 'yarn');
  assert.deepEqual(initialized.profile.manifests, ['package.json', 'yarn.lock', 'packages/app/package.json']);
  assert.equal(initializeProject(root, options).created, false);
  const context = DOCKER_CHECKS_TESTING.contextDescription(root, 'sha256:' + 'a'.repeat(64));
  assert.equal(context.packageManagerVersion, '4.9.2');
  assert.equal(context.sources.some((item) => /yarnrc|npmrc/.test(item.source)), false);
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json')));
  pkg.packageManager = 'yarn@4.9.1';
  writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
  assert.notEqual(DOCKER_CHECKS_TESTING.contextDescription(root, 'sha256:' + 'a'.repeat(64)).hash, context.hash);
  assert.deepEqual(registeredContainerCheck('check-tests', { packageManager: 'yarn', checkScript: 'test' }).args, ['/opt/flowcairn/package-manager.cjs', 'run', 'test']);
});

test('hardened init maps a project compile script to the trusted typecheck action', (t) => {
  const root = fixture(t, 'npm');
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json')));
  pkg.scripts = { test: 'node --test', compile: 'tsc --noEmit', lint: 'eslint src', build: 'webpack' };
  writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
  const initialized = initializeProject(root, { ...options, 'check-mode': 'hardened', checks: 'typecheck,lint,tests,build' });
  assert.deepEqual(initialized.profile.checks, ['typecheck', 'lint', 'tests', 'build']);
  assert.equal(initialized.profile.checkMode, 'hardened');
  assert.deepEqual(initialized.profile.checkScripts, { typecheck: 'compile', lint: 'lint', tests: 'test', build: 'build' });
  assert.equal(resolveProjectCheckScript(root, 'check-typecheck', initialized.profile), 'compile');
});

test('manager pins reject remote executable URLs, ranges, tags, legacy Yarn and contradictions', () => {
  for (const value of ['yarn@https://example.invalid/tool.js', 'yarn@latest', 'yarn@^4.9.2', 'yarn@1.22.22', 'npm@10.9.2'])
    assert.throws(() => packageManagerVersion('yarn', { packageManager: value }), { code: 'PACKAGE_MANAGER_VERSION' });
  assert.throws(() => packageManagerLock('bun'), { code: 'PACKAGE_MANAGER' });
  assert.equal(packageManagerVersion('pnpm', { packageManager: 'pnpm@10.11.0' }), '10.11.0');
  assert.equal(packageManagerVersion('npm', {}), 'bundled');
});

test('Yarn PnP, extra config and linked config fail before init writes', (t) => {
  for (const text of ['nodeLinker: pnp\n', 'nodeLinker: node-modules\nnpmAuthToken: fixture-only\n']) {
    const root = fixture(t);
    writeFileSync(path.join(root, '.yarnrc.yml'), text);
    assert.throws(() => initializeProject(root, options), { code: 'YARN_CONFIG' });
    assert.throws(() => readFileSync(path.join(root, '.flowcairn.json')), { code: 'ENOENT' });
  }
  const root = fixture(t);
  rmSync(path.join(root, '.yarnrc.yml'));
  symlinkSync(path.join(root, 'package.json'), path.join(root, '.yarnrc.yml'));
  assert.throws(() => initializeProject(root, options), { code: 'YARN_CONFIG' });
});

test('Yarn lock drives toolchain fingerprint and unsafe changes still refuse projection', (t) => {
  const root = fixture(t);
  initializeProject(root, options);
  writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n.ai-orchestrator/\n');
  mkdirSync(path.join(root, 'node_modules/fixture-app'), { recursive: true });
  writeFileSync(path.join(root, 'node_modules/fixture-app/index.js'), 'export const ok = true;');
  const worktree = path.join(root, '.ai-orchestrator/worktrees/fixture');
  mkdirSync(worktree, { recursive: true });
  const manifest = prepareToolchain({ root, worktree });
  assert.deepEqual(verifyToolchain({ root, worktree, manifest }), manifest);
  writeFileSync(path.join(root, 'yarn.lock'), '__metadata:\n  version: 9\n');
  assert.throws(() => verifyToolchain({ root, worktree, manifest }), { code: 'TOOLCHAIN_DRIFT' });
});

test('Docker source refuses credentials before any container copy', () => {
  for (const name of ['.npmrc', '.env.local', 'nested/credentials.json', 'nested/key.pem']) {
    assert.throws(() => DOCKER_CHECKS_TESTING.validateFingerprint({ hash: 'b'.repeat(64), files: [{ path: name, mode: '100644', size: 1, hash: 'a'.repeat(64) }] }), { code: 'INVALID_CHECK_FINGERPRINT' });
  }
});

test('skill manifest is bounded and optional without changing legacy parsed profile identity', (t) => {
  const root = fixture(t);
  const profile = initializeProject(root, options).profile;
  assert.equal(Object.hasOwn(profile, 'skillManifest'), false);
  const skill = { id: 'project-test', path: '.agents/skills/test/SKILL.md', hash: 'a'.repeat(64), scope: ['.'], actions: ['ai-plan'] };
  assert.equal(ProjectProfileSchema.parse({ ...profile, skillManifest: [skill] }).skillManifest.length, 1);
  assert.throws(() => ProjectProfileSchema.parse({ ...profile, skillManifest: [skill, skill] }));
  assert.throws(() => ProjectProfileSchema.parse({ ...profile, skillManifest: [{ ...skill, path: '../SKILL.md' }] }));
});
