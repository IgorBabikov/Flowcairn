import assert from 'node:assert/strict';
import {
  chmodSync,
  lstatSync,
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
    assert.deepEqual(manifest.readRoots, [realpathSync(path.join(root, 'node_modules'))]);
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
