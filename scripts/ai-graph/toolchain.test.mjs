import assert from 'node:assert/strict';
import {
  chmodSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareToolchain, verifyToolchain } from './lib/toolchain.mjs';

function fixture() {
  const base = mkdtempSync(path.join(tmpdir(), 'flowcairn-toolchain-'));
  const root = path.join(base, 'repo');
  const worktree = path.join(root, '.ai-orchestrator', 'worktrees', 'task-1');
  mkdirSync(
    path.join(root, 'node_modules', '.pnpm', 'typescript@1', 'node_modules', 'typescript', 'bin'),
    {
      recursive: true,
    },
  );
  mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
  mkdirSync(path.join(root, 'packages', 'shared', 'node_modules', '@scope'), { recursive: true });
  mkdirSync(path.join(worktree, 'packages', 'shared'), { recursive: true });
  writeFileSync(path.join(root, 'package.json'), '{}');
  writeFileSync(
    path.join(root, '.flowcairn.json'),
    JSON.stringify({
      version: 1,
      integrationBranch: 'main',
      packageManager: 'pnpm',
      contextPaths: [],
      checks: ['tests'],
      outputPaths: [],
      manifests: ['package.json', 'pnpm-lock.yaml', 'packages/shared/package.json'],
      ai: { provider: 'openai', model: 'fixture-model' },
    }),
  );
  writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  writeFileSync(path.join(root, 'packages', 'shared', 'package.json'), '{"name":"@aiec/shared"}\n');
  writeFileSync(
    path.join(
      root,
      'node_modules',
      '.pnpm',
      'typescript@1',
      'node_modules',
      'typescript',
      'package.json',
    ),
    '{"name":"typescript","version":"1.0.0"}\n',
  );
  writeFileSync(
    path.join(
      root,
      'node_modules',
      '.pnpm',
      'typescript@1',
      'node_modules',
      'typescript',
      'bin',
      'tsc',
    ),
    'console.log("tsc")\n',
  );
  symlinkSync(
    path.join(root, 'node_modules', '.pnpm', 'typescript@1', 'node_modules', 'typescript'),
    path.join(root, 'node_modules', 'typescript'),
  );
  writeFileSync(path.join(root, 'node_modules', '.bin', 'tsc'), '#!/bin/sh\nexit 0\n', {
    mode: 0o755,
  });
  symlinkSync(
    path.join(root, 'packages', 'shared'),
    path.join(root, 'packages', 'shared', 'node_modules', '@scope', 'self'),
  );
  return { base, root, worktree };
}

test('projects a deterministic read-only toolchain and remaps workspace links', () => {
  const { base, root, worktree } = fixture();
  try {
    const manifest = prepareToolchain({ root, worktree });
    assert.deepEqual(manifest.dependencyPaths, ['node_modules', 'packages/shared/node_modules']);
    assert.deepEqual(manifest.readRoots, [
      realpathSync(path.join(root, 'node_modules')),
      realpathSync(path.join(root, 'packages/shared/node_modules')),
    ]);
    assert.match(manifest.hash, /^[a-f0-9]{64}$/);
    assert.equal(lstatSync(path.join(worktree, 'node_modules')).isSymbolicLink(), false);
    assert.equal(lstatSync(path.join(worktree, 'node_modules')).mode & 0o777, 0o700);
    assert.equal(
      lstatSync(path.join(worktree, 'packages/shared/node_modules')).mode & 0o777,
      0o700,
    );
    assert.equal(
      readlinkSync(path.join(worktree, 'packages/shared/node_modules/@scope/self')),
      path.join(realpathSync(worktree), 'packages', 'shared'),
    );
    assert.equal(
      readFileSync(path.join(worktree, 'node_modules/.bin/tsc'), 'utf8'),
      '#!/bin/sh\nexit 0\n',
    );
    assert.equal(lstatSync(path.join(worktree, 'node_modules/.bin/tsc')).mode & 0o777, 0o500);
    assert.deepEqual(prepareToolchain({ root, worktree }), manifest);
    assert.deepEqual(verifyToolchain({ root, worktree, manifest }), manifest);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('verification rejects projection drift without repairing it', () => {
  const { base, root, worktree } = fixture();
  try {
    const manifest = prepareToolchain({ root, worktree });
    const wrapper = path.join(worktree, 'node_modules/.bin/tsc');
    chmodSync(wrapper, 0o700);
    assert.throws(
      () => verifyToolchain({ root, worktree, manifest }),
      (error) => error.code === 'TOOLCHAIN_DRIFT',
    );
    assert.throws(
      () => prepareToolchain({ root, worktree }),
      (error) => error.code === 'TOOLCHAIN_DRIFT',
    );
    assert.equal(lstatSync(wrapper).mode & 0o777, 0o700);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('rejects symlinked dependency roots and worktrees outside orchestrator storage', () => {
  const { base, root, worktree } = fixture();
  try {
    const outside = path.join(base, 'outside');
    mkdirSync(outside);
    assert.throws(
      () => prepareToolchain({ root, worktree: outside }),
      (error) => error.code === 'INVALID_TOOLCHAIN_WORKTREE',
    );
    const moved = path.join(base, 'dependencies');
    renameSync(path.join(root, 'node_modules'), moved);
    symlinkSync(moved, path.join(root, 'node_modules'));
    assert.throws(
      () => prepareToolchain({ root, worktree }),
      (error) => error.code === 'TOOLCHAIN_UNAVAILABLE',
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('rejects a remapped workspace dependency that escapes through a symlink', () => {
  const { base, root, worktree } = fixture();
  try {
    const outside = path.join(base, 'outside-package');
    mkdirSync(outside);
    renameSync(path.join(worktree, 'packages/shared'), path.join(worktree, 'packages/original'));
    symlinkSync(outside, path.join(worktree, 'packages/shared'));
    assert.throws(
      () => prepareToolchain({ root, worktree }),
      (error) => error.code === 'UNSAFE_TOOLCHAIN_TARGET',
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});


function npmWorkspaceFixture(t, { rootDependencies = false } = {}) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'flowcairn-npm-workspace-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const worktree = path.join(root, '.ai-orchestrator', 'worktrees', 'task-1');
  const nestedRoot = path.join(root, 'packages/app/node_modules');
  mkdirSync(path.join(nestedRoot, 'nesteddep'), { recursive: true });
  mkdirSync(path.join(worktree, 'packages/app'), { recursive: true });
  if (rootDependencies) mkdirSync(path.join(root, 'node_modules/rootdep'), { recursive: true });
  writeFileSync(path.join(root, 'package.json'), '{"workspaces":["packages/*"]}');
  writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}');
  writeFileSync(path.join(root, 'packages/app/package.json'), '{"name":"app"}');
  writeFileSync(path.join(nestedRoot, 'nesteddep/package.json'), '{"name":"nesteddep"}');
  writeFileSync(path.join(nestedRoot, 'nesteddep/index.js'), 'export const nested = true;');
  writeFileSync(path.join(root, '.flowcairn.json'), JSON.stringify({
    version: 1, integrationBranch: 'main', packageManager: 'npm', contextPaths: [],
    checks: ['tests'], outputPaths: [],
    manifests: ['package.json', 'package-lock.json', 'packages/app/package.json'],
    ai: { provider: 'openai', model: 'fixture-model' },
  }));
  return { base, root, worktree, nestedRoot };
}

test('projects declared npm nonhoisted packages and internal links with optional root dependencies', (t) => {
  for (const rootDependencies of [false, true]) {
    const { root, worktree, nestedRoot } = npmWorkspaceFixture(t, { rootDependencies });
    symlinkSync('./nesteddep', path.join(nestedRoot, 'alias'));
    const manifest = prepareToolchain({ root, worktree });
    assert.deepEqual(manifest.dependencyPaths, [
      ...(rootDependencies ? ['node_modules'] : []), 'packages/app/node_modules',
    ]);
    assert.deepEqual(manifest.readRoots, [
      ...(rootDependencies ? [realpathSync(path.join(root, 'node_modules'))] : []), nestedRoot,
    ]);
    for (const name of ['nesteddep', 'alias']) {
      const projected = path.join(worktree, 'packages/app/node_modules', name);
      assert.equal(readlinkSync(projected), path.join(nestedRoot, 'nesteddep'));
      assert.equal(readFileSync(path.join(projected, 'index.js'), 'utf8'), 'export const nested = true;');
    }
    assert.equal(lstatSync(path.join(worktree, 'packages/app/node_modules')).mode & 0o777, 0o700);
    assert.deepEqual(verifyToolchain({ root, worktree, manifest }), manifest);
    assert.deepEqual(prepareToolchain({ root, worktree }), manifest);
    symlinkSync('./nesteddep', path.join(nestedRoot, 'added-after-prepare'));
    assert.throws(() => verifyToolchain({ root, worktree, manifest }), { code: 'TOOLCHAIN_DRIFT' });
  }
});

test('nested dependency links reject external and undeclared dependency roots', (t) => {
  for (const external of [true, false]) {
    const { base, root, worktree, nestedRoot } = npmWorkspaceFixture(t);
    const target = external ? path.join(base, 'outside') : path.join(root, 'unlisted/node_modules/pkg');
    mkdirSync(target, { recursive: true });
    if (!external) mkdirSync(path.join(worktree, 'unlisted/node_modules/pkg'), { recursive: true });
    symlinkSync(target, path.join(nestedRoot, 'escape'));
    assert.throws(() => prepareToolchain({ root, worktree }), { code: 'UNSAFE_TOOLCHAIN_SOURCE' });
  }
});

test('nested declared dependency root cannot be a symlink', (t) => {
  const { base, root, worktree, nestedRoot } = npmWorkspaceFixture(t);
  const moved = path.join(base, 'moved-dependencies');
  renameSync(nestedRoot, moved);
  symlinkSync(moved, nestedRoot);
  assert.throws(() => prepareToolchain({ root, worktree }), { code: 'UNSAFE_TOOLCHAIN_SOURCE' });
});

test('npm lockfile hardlinks remain rejected', (t) => {
  const { base, root, worktree } = npmWorkspaceFixture(t);
  linkSync(path.join(root, 'package-lock.json'), path.join(base, 'lock-copy.json'));
  assert.throws(() => prepareToolchain({ root, worktree }), { code: 'UNSAFE_TOOLCHAIN_SOURCE' });
});
