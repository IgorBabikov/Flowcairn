import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildDiffArtifact,
  compareWorkspaces,
  fingerprintWorkspace,
  inspectWorkspaceChanges,
} from './lib/workspace.mjs';

const TEST_TMP_ROOT = realpathSync(os.tmpdir());

function git(root, args) {
  execFileSync('/usr/bin/git', args, { cwd: root, stdio: 'ignore' });
}

function repository() {
  const root = mkdtempSync(path.join(TEST_TMP_ROOT, 'flowcairn-workspace-repo-'));
  git(root, ['init', '-b', 'develop']);
  writeFileSync(
    path.join(root, '.gitignore'),
    'ignored.txt\n*.cache\noutput/\n.ai-orchestrator/\n',
  );
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src', 'tracked.txt'), 'initial\n');
  writeFileSync(path.join(root, 'ignored.txt'), 'ignored baseline\n');
  mkdirSync(path.join(root, 'output'));
  writeFileSync(path.join(root, 'output', 'report.json'), '{"temporary":true}\n');
  git(root, ['add', '.gitignore', 'src/tracked.txt']);
  return root;
}

function fingerprint(root, options = {}) {
  return fingerprintWorkspace(root, {
    baselinePaths: ['ignored.txt'],
    outputPaths: ['output'],
    ...options,
  });
}

test('fingerprints tracked, ignored baseline and untracked bytes while excluding trusted outputs', () => {
  const root = repository();
  const unusual = 'src/новый\nфайл.txt';
  writeFileSync(path.join(root, unusual), 'unicode\n');
  const first = fingerprint(root);
  assert.equal(first.git.head, null);
  assert.match(first.git.indexHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    first.files.map((file) => file.path),
    ['.gitignore', 'ignored.txt', 'src/tracked.txt', unusual].sort(),
  );
  assert.equal(
    first.files.some((file) => file.path.startsWith('output/')),
    false,
  );

  writeFileSync(path.join(root, 'ignored.txt'), 'changed ignored baseline\n');
  writeFileSync(path.join(root, 'late.cache'), 'new ignored input\n');
  const second = fingerprint(root);
  assert.deepEqual(compareWorkspaces(first, second), ['ignored.txt', 'late.cache']);
});

test('trusted output mutation is the only omitted workspace change', () => {
  const root = repository();
  const before = fingerprint(root);
  writeFileSync(path.join(root, 'output', 'report.json'), '{"temporary":false}\n');
  const afterOutput = fingerprint(root);
  assert.equal(afterOutput.hash, before.hash);

  writeFileSync(path.join(root, 'unexpected.txt'), 'new source\n');
  const afterSource = fingerprint(root);
  assert.deepEqual(compareWorkspaces(afterOutput, afterSource), ['unexpected.txt']);
});

test('refuses to exclude an unignored or tracked source path', () => {
  const root = repository();
  assert.throws(
    () => fingerprint(root, { outputPaths: ['unignored-output'] }),
    (error) => error.code === 'INVALID_OUTPUT_PATH',
  );
  assert.throws(
    () => fingerprint(root, { outputPaths: ['src'] }),
    (error) => error.code === 'INVALID_OUTPUT_PATH',
  );
});

test('can exclude the trusted private control output without ignoring sibling source files', () => {
  const root = repository();
  mkdirSync(path.join(root, '.ai-orchestrator'));
  writeFileSync(path.join(root, '.ai-orchestrator', 'state.json'), '{}\n');
  const result = fingerprint(root, { outputPaths: ['output', '.ai-orchestrator'] });
  assert.equal(
    result.files.some((file) => file.path.startsWith('.ai-orchestrator/')),
    false,
  );
});

test('reports rename with Unicode and newline paths as sorted delete and add entries', () => {
  const root = repository();
  const oldPath = 'src/old\nname.txt';
  const newPath = 'src/новое\nимя.txt';
  writeFileSync(path.join(root, oldPath), 'rename me\n');
  const before = fingerprint(root);
  renameSync(path.join(root, oldPath), path.join(root, newPath));
  const after = fingerprint(root);
  assert.deepEqual(compareWorkspaces(before, after), [oldPath, newPath].sort());
});

test('binds executable mode changes and permits non-secret env templates', () => {
  const root = repository();
  writeFileSync(path.join(root, '.env.local.example'), 'TOKEN=placeholder\n');
  const before = fingerprint(root);
  chmodSync(path.join(root, 'src', 'tracked.txt'), 0o755);
  const after = fingerprint(root);
  assert.equal(after.files.find((file) => file.path === 'src/tracked.txt').mode, '100755');
  assert.deepEqual(compareWorkspaces(before, after), ['src/tracked.txt']);
});

test('binds index metadata and always reports Git metadata changes as violations', () => {
  const root = repository();
  const before = fingerprint(root);
  writeFileSync(path.join(root, 'src', 'staged.txt'), 'staged\n');
  git(root, ['add', 'src/staged.txt']);
  const after = fingerprint(root);
  assert.deepEqual(compareWorkspaces(before, after), ['@git/index', 'src/staged.txt']);

  const result = inspectWorkspaceChanges(
    before,
    after,
    {
      permissions: ['workspace.source.write'],
      resources: { reads: [], writes: ['src'] },
    },
    { scope: ['src'], forbiddenPaths: [] },
  );
  assert.equal(result.allowed, false);
  assert.deepEqual(result.violations, [{ code: 'GIT_METADATA_CHANGED', path: '@git/index' }]);
});

test('allows only declared source writes and blocks read actions, forbidden and out-of-scope writes', () => {
  const root = repository();
  const before = fingerprint(root);
  writeFileSync(path.join(root, 'src', 'tracked.txt'), 'changed\n');
  const sourceAfter = fingerprint(root);
  const task = { scope: ['src'], forbiddenPaths: ['src/blocked'] };
  const writer = {
    permissions: ['workspace.source.write'],
    resources: { reads: [], writes: ['src'] },
  };
  assert.deepEqual(inspectWorkspaceChanges(before, sourceAfter, writer, task), {
    allowed: true,
    changedFiles: ['src/tracked.txt'],
    violations: [],
  });

  const readAction = { permissions: ['ai.read'], resources: { reads: ['src'], writes: [] } };
  assert.deepEqual(inspectWorkspaceChanges(before, sourceAfter, readAction, task).violations, [
    { code: 'SOURCE_WRITE_PERMISSION_REQUIRED', path: 'src/tracked.txt' },
  ]);

  mkdirSync(path.join(root, 'docs'));
  writeFileSync(path.join(root, 'docs', 'outside.txt'), 'outside\n');
  const outsideAfter = fingerprint(root);
  assert.equal(
    inspectWorkspaceChanges(sourceAfter, outsideAfter, writer, task).violations[0].code,
    'OUT_OF_SCOPE_CHANGE',
  );

  mkdirSync(path.join(root, 'src', 'blocked'));
  writeFileSync(path.join(root, 'src', 'blocked', 'value.txt'), 'blocked\n');
  const forbiddenAfter = fingerprint(root);
  assert.equal(
    inspectWorkspaceChanges(outsideAfter, forbiddenAfter, writer, task).violations[0].code,
    'FORBIDDEN_PATH_CHANGED',
  );
});

test('rejects traversal, sensitive paths, symlinks and hardlinks', () => {
  const traversalRoot = repository();
  assert.throws(
    () => fingerprint(traversalRoot, { baselinePaths: ['../outside'] }),
    (error) => error.code === 'UNSAFE_WORKSPACE_PATH',
  );

  const sensitiveRoot = repository();
  writeFileSync(path.join(sensitiveRoot, '.env'), 'TOKEN=private\n');
  assert.throws(
    () => fingerprint(sensitiveRoot),
    (error) => error.code === 'SENSITIVE_WORKSPACE_PATH',
  );

  const symlinkRoot = repository();
  symlinkSync('../outside', path.join(symlinkRoot, 'src', 'escape'));
  assert.throws(
    () => fingerprint(symlinkRoot),
    (error) => error.code === 'UNSAFE_WORKSPACE_ENTRY',
  );

  const hardlinkRoot = repository();
  writeFileSync(path.join(hardlinkRoot, 'first.txt'), 'same inode\n');
  linkSync(path.join(hardlinkRoot, 'first.txt'), path.join(hardlinkRoot, 'second.txt'));
  assert.throws(
    () => fingerprint(hardlinkRoot),
    (error) => error.code === 'UNSAFE_HARDLINK',
  );
});

test('builds bounded metadata evidence without exposing changed file contents', () => {
  const root = repository();
  const before = fingerprint(root);
  writeFileSync(path.join(root, 'src', 'tracked.txt'), 'PASSWORD=do-not-leak\n');
  const after = fingerprint(root);
  const artifact = buildDiffArtifact(root, before, after);
  assert.equal(artifact.complete, false);
  assert.ok(Buffer.byteLength(artifact.content) <= 32 * 1024);
  assert.equal(artifact.content.includes('do-not-leak'), false);
  assert.equal(artifact.content.includes('src/tracked.txt'), true);
  assert.equal(artifact.content.includes(root), false);
});

test('ignores inherited Git routing, config and external diff variables', () => {
  const root = repository();
  const keys = [
    'GIT_DIR',
    'GIT_INDEX_FILE',
    'GIT_CONFIG_SYSTEM',
    'GIT_CONFIG_GLOBAL',
    'GIT_EXTERNAL_DIFF',
    'PATH',
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.GIT_DIR = path.join(root, 'wrong-git-dir');
  process.env.GIT_INDEX_FILE = path.join(root, 'wrong-index');
  process.env.GIT_CONFIG_SYSTEM = path.join(root, 'wrong-system-config');
  process.env.GIT_CONFIG_GLOBAL = path.join(root, 'wrong-global-config');
  process.env.GIT_EXTERNAL_DIFF = path.join(root, 'must-not-run');
  process.env.PATH = path.join(root, 'wrong-path');
  try {
    const before = fingerprint(root);
    writeFileSync(path.join(root, 'src', 'tracked.txt'), 'changed safely\n');
    const after = fingerprint(root);
    const artifact = buildDiffArtifact(root, before, after);
    assert.equal(artifact.content.includes('changed safely'), false);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('rejects malformed scope contracts instead of inferring write permission', () => {
  const root = repository();
  const fingerprintValue = fingerprint(root);
  assert.throws(
    () =>
      inspectWorkspaceChanges(
        fingerprintValue,
        fingerprintValue,
        { permissions: ['workspace.source.write'], resources: {} },
        { scope: ['src'], forbiddenPaths: [] },
      ),
    (error) => error.code === 'INVALID_WORKSPACE_OPTIONS',
  );
});

test('rejects a tampered persisted fingerprint', () => {
  const root = repository();
  const value = fingerprint(root);
  const tampered = structuredClone(value);
  tampered.files[0].size += 1;
  assert.throws(
    () => compareWorkspaces(value, tampered),
    (error) => error.code === 'INVALID_WORKSPACE_FINGERPRINT',
  );
});
