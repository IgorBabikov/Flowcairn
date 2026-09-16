import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
import fs, {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { syncBuiltinESMExports } from 'node:module';
import { captureSourceBundle, materializeSourceBundle, verifySourceBundle } from './lib/source.mjs';
import { canonicalJson, sha256 } from './lib/io.mjs';

const TEST_TMP_ROOT = realpathSync(os.tmpdir());

function git(root, args) {
  execFileSync('/usr/bin/git', args, { cwd: root, stdio: 'ignore' });
}

function repository() {
  const root = mkdtempSync(path.join(TEST_TMP_ROOT, 'flowcairn-source-repo-'));
  git(root, ['init', '-b', 'develop']);
  writeFileSync(path.join(root, '.gitignore'), 'ignored.txt\n.ai-orchestrator/\n');
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src', 'value.txt'), 'index value\n');
  writeFileSync(path.join(root, 'src', 'binary.bin'), Buffer.from([0, 1, 2, 255]));
  writeFileSync(path.join(root, 'src', 'run.sh'), '#!/bin/sh\nexit 0\n');
  chmodSync(path.join(root, 'src', 'run.sh'), 0o755);
  mkdirSync(path.join(root, 'links'));
  symlinkSync('../src/value.txt', path.join(root, 'links', 'value'));
  writeFileSync(path.join(root, 'rename-old.txt'), 'rename bytes\n');
  git(root, ['add', '.']);

  writeFileSync(path.join(root, 'src', 'value.txt'), 'worktree value\n');
  writeFileSync(path.join(root, 'src', 'binary.bin'), Buffer.from([0, 9, 8, 0, 255]));
  renameSync(path.join(root, 'rename-old.txt'), path.join(root, 'renamed\nfile.txt'));
  writeFileSync(path.join(root, 'allowed\nfile.txt'), 'approved untracked\n');
  writeFileSync(path.join(root, 'ignored.txt'), 'must stay private\n');
  return root;
}

function storage() {
  const parent = mkdtempSync(path.join(TEST_TMP_ROOT, 'flowcairn-source-store-parent-'));
  return path.join(parent, 'sources');
}

test('rejects a storage symlink ancestor without writing outside the allocation', () => {
  const root = repository();
  const allocation = mkdtempSync(path.join(TEST_TMP_ROOT, 'flowcairn-source-allocation-'));
  const outside = mkdtempSync(path.join(TEST_TMP_ROOT, 'flowcairn-source-outside-'));
  mkdirSync(path.join(outside, 'graph'), { mode: 0o700 });
  symlinkSync(outside, path.join(allocation, 'link'));
  assert.throws(
    () => captureSourceBundle(root, path.join(allocation, 'link', 'graph', 'sources')),
    (error) => error.code === 'INSECURE_STORAGE',
  );
  assert.deepEqual(fs.readdirSync(path.join(outside, 'graph')), []);
});

test('captures index, unstaged bytes, binary data, modes, safe links and allowed untracked paths', () => {
  const root = repository();
  const outputRoot = storage();
  const allowedUntracked = ['allowed\nfile.txt', 'renamed\nfile.txt'];

  const first = captureSourceBundle(root, outputRoot, { allowedUntracked });
  const second = captureSourceBundle(root, outputRoot, { allowedUntracked });
  assert.equal(second.bundlePath, first.bundlePath);
  assert.equal(second.manifest.sourceHash, first.manifest.sourceHash);

  const manifest = verifySourceBundle(first.bundlePath);
  assert.equal(manifest.version, 2);
  assert.equal(manifest.source.head, null);
  assert.match(manifest.source.indexIdentity, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(manifest).includes(root), false);
  assert.equal(
    manifest.entries.some((entry) => entry.path === 'ignored.txt'),
    false,
  );

  const value = manifest.entries.find((entry) => entry.path === 'src/value.txt');
  assert.notEqual(value.index.sha256, value.worktree.sha256);
  const binary = manifest.entries.find((entry) => entry.path === 'src/binary.bin');
  assert.equal(binary.index.size, 4);
  assert.equal(binary.worktree.size, 5);
  assert.notEqual(binary.index.sha256, binary.worktree.sha256);
  assert.equal(
    manifest.entries.find((entry) => entry.path === 'src/run.sh').worktree.mode,
    '100755',
  );
  assert.equal(manifest.entries.find((entry) => entry.path === 'rename-old.txt').worktree, null);
  assert.equal(manifest.entries.find((entry) => entry.path === 'renamed\nfile.txt').index, null);

  const target = path.join(realpathSync(path.dirname(outputRoot)), 'materialized');
  const result = materializeSourceBundle(first.bundlePath, target);
  assert.equal(result.sourceHash, manifest.sourceHash);
  assert.deepEqual(
    readFileSync(path.join(target, 'src', 'binary.bin')),
    Buffer.from([0, 9, 8, 0, 255]),
  );
  assert.equal(readFileSync(path.join(target, 'src', 'value.txt'), 'utf8'), 'worktree value\n');
  assert.equal(
    readFileSync(path.join(target, 'allowed\nfile.txt'), 'utf8'),
    'approved untracked\n',
  );
  assert.equal(readFileSync(path.join(target, 'renamed\nfile.txt'), 'utf8'), 'rename bytes\n');
  assert.equal(readlinkSync(path.join(target, 'links', 'value')), '../src/value.txt');
  assert.notEqual(lstatSync(path.join(target, 'src', 'run.sh')).mode & 0o100, 0);
  assert.equal(lstatSync(path.join(target, 'src', 'value.txt')).mode & 0o077, 0);
  assert.equal(lstatSync(outputRoot).mode & 0o077, 0);
});

test('rejects ignored, sensitive and traversal paths from allowedUntracked', () => {
  const root = repository();
  assert.throws(
    () => captureSourceBundle(root, storage(), { allowedUntracked: ['ignored.txt'] }),
    (error) => error.code === 'UNTRACKED_NOT_ALLOWED',
  );
  writeFileSync(path.join(root, '.env'), 'TOKEN=test\n');
  writeFileSync(path.join(root, '.env.local.example'), 'TOKEN=placeholder\n');
  writeFileSync(path.join(root, 'secret-boundary.spec.ts'), 'export const value = true;\n');
  const templates = captureSourceBundle(root, storage(), {
    allowedUntracked: ['.env.local.example', 'secret-boundary.spec.ts'],
  });
  assert.equal(
    templates.manifest.entries.some((entry) => entry.path === '.env.local.example'),
    true,
  );
  assert.equal(
    templates.manifest.entries.some((entry) => entry.path === 'secret-boundary.spec.ts'),
    true,
  );
  assert.throws(
    () => captureSourceBundle(root, storage(), { allowedUntracked: ['.env'] }),
    (error) => error.code === 'SENSITIVE_SOURCE_PATH',
  );
  assert.throws(
    () => captureSourceBundle(root, storage(), { allowedUntracked: ['../outside.txt'] }),
    (error) => error.code === 'UNSAFE_SOURCE_PATH',
  );
});

test('withholds tracked sensitive paths without copying their bytes into the bundle', () => {
  const root = repository();
  writeFileSync(path.join(root, '.npmrc'), '//registry.example.test/:_authToken=private-token\n');
  mkdirSync(path.join(root, 'secrets'));
  writeFileSync(path.join(root, 'secrets', 'api.txt'), 'private-api-value\n');
  git(root, ['add', '.npmrc', 'secrets/api.txt']);
  writeFileSync(path.join(root, '.npmrc'), '//registry.example.test/:_authToken=changed-private-token\n');

  const captured = captureSourceBundle(root, storage());
  assert.deepEqual(captured.manifest.withheldPaths, ['.npmrc', 'secrets/api.txt']);
  assert.equal(captured.manifest.entries.some((entry) => entry.path === '.npmrc'), false);
  assert.equal(captured.manifest.entries.some((entry) => entry.path === 'secrets/api.txt'), false);
  assert.equal(JSON.stringify(captured.manifest).includes('private-token'), false);
  assert.equal(JSON.stringify(captured.manifest).includes('private-api-value'), false);

  const target = path.join(realpathSync(path.dirname(storage())), 'materialized-withheld');
  materializeSourceBundle(captured.bundlePath, target);
  assert.equal(existsSync(path.join(target, '.npmrc')), false);
  assert.equal(existsSync(path.join(target, 'secrets', 'api.txt')), false);
});

test('ignores inherited Git routing variables and uses the requested repository', () => {
  const root = repository();
  const previousGitDirectory = process.env.GIT_DIR;
  const previousIndex = process.env.GIT_INDEX_FILE;
  const previousPath = process.env.PATH;
  process.env.GIT_DIR = path.join(root, 'missing-git-dir');
  process.env.GIT_INDEX_FILE = path.join(root, 'missing-index');
  process.env.PATH = path.join(root, 'missing-path');
  try {
    const captured = captureSourceBundle(root, storage(), {
      allowedUntracked: ['allowed\nfile.txt', 'renamed\nfile.txt'],
    });
    assert.equal(verifySourceBundle(captured.bundlePath).source.head, null);
  } finally {
    if (previousGitDirectory === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previousGitDirectory;
    if (previousIndex === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = previousIndex;
    process.env.PATH = previousPath;
  }
});

test('rejects escaping symlinks, symlink ancestors and hardlinked files', () => {
  const symlinkRoot = repository();
  symlinkSync('../outside.txt', path.join(symlinkRoot, 'escape'));
  assert.throws(
    () => captureSourceBundle(symlinkRoot, storage(), { allowedUntracked: ['escape'] }),
    (error) => error.code === 'UNSAFE_SYMLINK',
  );

  const ancestorRoot = repository();
  mkdirSync(path.join(ancestorRoot, 'nested'));
  writeFileSync(path.join(ancestorRoot, 'nested', 'tracked.txt'), 'tracked\n');
  git(ancestorRoot, ['add', 'nested/tracked.txt']);
  renameSync(path.join(ancestorRoot, 'nested'), path.join(ancestorRoot, 'nested-real'));
  symlinkSync('nested-real', path.join(ancestorRoot, 'nested'));
  assert.throws(
    () => captureSourceBundle(ancestorRoot, storage()),
    (error) => error.code === 'UNSAFE_ANCESTOR_LINK',
  );

  const hardlinkRoot = repository();
  writeFileSync(path.join(hardlinkRoot, 'hard-a.txt'), 'same inode\n');
  linkSync(path.join(hardlinkRoot, 'hard-a.txt'), path.join(hardlinkRoot, 'hard-b.txt'));
  assert.throws(
    () => captureSourceBundle(hardlinkRoot, storage(), { allowedUntracked: ['hard-a.txt'] }),
    (error) => error.code === 'UNSAFE_HARDLINK',
  );
});

test('rejects a symlink target that traverses another bundled symlink before dot-dot', () => {
  const parent = mkdtempSync(path.join(TEST_TMP_ROOT, 'flowcairn-source-symlink-chain-'));
  const targets = [Buffer.from('dir/link/../../outside'), Buffer.from('../safe')];
  const entries = [
    {
      path: 'alias',
      head: null,
      index: null,
      worktree: {
        type: 'symlink',
        mode: '120000',
        size: targets[0].length,
        sha256: sha256(targets[0]),
      },
    },
    {
      path: 'dir/link',
      head: null,
      index: null,
      worktree: {
        type: 'symlink',
        mode: '120000',
        size: targets[1].length,
        sha256: sha256(targets[1]),
      },
    },
  ];
  const manifest = {
    version: 1,
    sourceHash: '',
    source: { head: null, indexIdentity: sha256(canonicalJson([])) },
    entries,
  };
  const body = { ...manifest };
  delete body.sourceHash;
  manifest.sourceHash = sha256(canonicalJson(body));
  const bundle = path.join(parent, manifest.sourceHash);
  const objects = path.join(bundle, 'objects');
  mkdirSync(objects, { recursive: true, mode: 0o700 });
  for (const target of targets) {
    writeFileSync(path.join(objects, sha256(target)), target, { mode: 0o400 });
  }
  writeFileSync(path.join(bundle, 'manifest.json'), `${JSON.stringify(manifest)}\n`, {
    mode: 0o400,
  });
  chmodSync(objects, 0o500);
  chmodSync(bundle, 0o500);
  assert.throws(
    () => verifySourceBundle(bundle),
    (error) => error.code === 'UNSAFE_SYMLINK',
  );
});

test('detects object tampering and refuses an existing materialization target', () => {
  const root = repository();
  const captured = captureSourceBundle(root, storage(), {
    allowedUntracked: ['allowed\nfile.txt', 'renamed\nfile.txt'],
  });
  const target = path.join(
    realpathSync(path.dirname(path.dirname(captured.bundlePath))),
    'existing-target',
  );
  mkdirSync(target);
  assert.throws(
    () => materializeSourceBundle(captured.bundlePath, target),
    (error) => error.code === 'MATERIALIZATION_EXISTS',
  );

  const linkedParent = mkdtempSync(path.join(TEST_TMP_ROOT, 'flowcairn-source-linked-parent-'));
  mkdirSync(path.join(linkedParent, 'real'));
  symlinkSync('real', path.join(linkedParent, 'alias'));
  assert.throws(
    () => materializeSourceBundle(captured.bundlePath, path.join(linkedParent, 'alias', 'target')),
    (error) => error.code === 'UNSAFE_MATERIALIZATION',
  );

  const objectHash = captured.manifest.entries.find((entry) => entry.worktree !== null).worktree
    .sha256;
  const objectPath = path.join(captured.bundlePath, 'objects', objectHash);
  chmodSync(path.dirname(objectPath), 0o700);
  chmodSync(objectPath, 0o600);
  writeFileSync(objectPath, 'tampered');
  assert.throws(
    () => verifySourceBundle(captured.bundlePath),
    (error) => error.code === 'SOURCE_BUNDLE_TAMPERED',
  );
});

test('requires private bundle permissions', () => {
  const root = repository();
  const captured = captureSourceBundle(root, storage(), {
    allowedUntracked: ['allowed\nfile.txt', 'renamed\nfile.txt'],
  });
  chmodSync(captured.bundlePath, 0o755);
  assert.throws(
    () => verifySourceBundle(captured.bundlePath),
    (error) => error.code === 'INSECURE_SOURCE_BUNDLE',
  );
  chmodSync(captured.bundlePath, 0o500);
  chmodSync(path.join(captured.bundlePath, 'manifest.json'), 0o644);
  assert.throws(
    () => verifySourceBundle(captured.bundlePath),
    (error) => error.code === 'INVALID_SOURCE_BUNDLE',
  );
});

test('rejects a bundle whose deduplicated objects expand past the worktree limit', () => {
  const parent = mkdtempSync(path.join(TEST_TMP_ROOT, 'flowcairn-source-logical-limit-'));
  const descriptor = {
    type: 'file',
    mode: '100644',
    size: 64 * 1024 * 1024,
    sha256: 'a'.repeat(64),
  };
  const entries = Array.from({ length: 9 }, (_, index) => ({
    path: `copy-${index}.bin`,
    head: null,
    index: null,
    worktree: descriptor,
  }));
  const manifest = {
    version: 1,
    sourceHash: '',
    source: { head: null, indexIdentity: sha256(canonicalJson([])) },
    entries,
  };
  const body = { ...manifest };
  delete body.sourceHash;
  manifest.sourceHash = sha256(canonicalJson(body));
  const bundle = path.join(parent, manifest.sourceHash);
  mkdirSync(path.join(bundle, 'objects'), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(bundle, 'manifest.json'), `${JSON.stringify(manifest)}\n`, {
    mode: 0o400,
  });
  chmodSync(path.join(bundle, 'objects'), 0o500);
  chmodSync(bundle, 0o500);
  assert.throws(
    () => verifySourceBundle(bundle),
    (error) => error.code === 'SOURCE_LIMIT_EXCEEDED',
  );
});

test('rejects corrupt or dangling detached HEAD instead of treating it as unborn', () => {
  const root = mkdtempSync(path.join(TEST_TMP_ROOT, 'flowcairn-source-corrupt-head-'));
  git(root, ['init', '-b', 'develop']);
  writeFileSync(path.join(root, '.git', 'HEAD'), `${'0'.repeat(40)}\n`);
  assert.throws(
    () => captureSourceBundle(root, storage()),
    (error) => error.code === 'GIT_FAILED',
  );
});

test('propagates a Git spawn error while probing unborn HEAD', (context) => {
  const root = mkdtempSync(path.join(TEST_TMP_ROOT, 'flowcairn-source-head-spawn-error-'));
  git(root, ['init', '-b', 'develop']);
  const originalSpawn = childProcess.spawnSync;
  context.mock.method(childProcess, 'spawnSync', (...args) => {
    if (args[1].includes('rev-parse') && args[1].includes('--verify')) {
      return {
        status: null,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        error: new Error('simulated spawn failure'),
      };
    }
    return originalSpawn(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => captureSourceBundle(root, storage()),
      (error) => error.code === 'GIT_FAILED',
    );
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('caches equal Git blobs by object id', (context) => {
  const root = mkdtempSync(path.join(TEST_TMP_ROOT, 'flowcairn-source-git-cache-'));
  git(root, ['init', '-b', 'develop']);
  writeFileSync(path.join(root, 'one.txt'), 'same bytes\n');
  writeFileSync(path.join(root, 'two.txt'), 'same bytes\n');
  git(root, ['add', '.']);
  const originalSpawn = childProcess.spawnSync;
  let blobReads = 0;
  context.mock.method(childProcess, 'spawnSync', (...args) => {
    if (args[1].includes('cat-file') && args[1].includes('--batch')) blobReads += 1;
    return originalSpawn(...args);
  });
  syncBuiltinESMExports();
  try {
    captureSourceBundle(root, storage());
    assert.equal(blobReads, 1);
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('hundreds of distinct files are captured with two batched Git object reads', context => {
  const root = repository();
  for (let index = 0; index < 300; index++)
    writeFileSync(path.join(root, 'src', `batch-${index}.txt`), `unique ${index}\n`);
  git(root, ['add', 'src']);
  const originalSpawn = childProcess.spawnSync;
  let reads = 0;
  context.mock.method(childProcess, 'spawnSync', (...args) => {
    if (args[1].includes('cat-file')) reads++;
    return originalSpawn(...args);
  });
  syncBuiltinESMExports();
  try {
    const result = captureSourceBundle(root, storage());
    assert.equal(reads, 2);
    assert.equal(result.manifest.entries.filter(entry => entry.path.startsWith('src/batch-')).length, 300);
  } finally { context.mock.restoreAll(); syncBuiltinESMExports(); }
});

for (const corruption of ['header', 'truncated', 'extra', 'oversize']) {
  test(`rejects ${corruption} batch responses`, context => {
    const root = repository();
    const originalSpawn = childProcess.spawnSync;
    context.mock.method(childProcess, 'spawnSync', (...args) => {
      const result = originalSpawn(...args);
      if (corruption === 'oversize' && args[1].includes('--batch-check'))
        result.stdout = Buffer.from(result.stdout.toString('ascii').replace(/blob [0-9]+/, 'blob 999999999'));
      if (args[1].includes('--batch')) {
        if (corruption === 'header') result.stdout[0] = 120;
        if (corruption === 'truncated') result.stdout = result.stdout.subarray(0, result.stdout.length - 2);
        if (corruption === 'extra') result.stdout = Buffer.concat([result.stdout, Buffer.from('x')]);
      }
      return result;
    });
    syncBuiltinESMExports();
    try {
      assert.throws(() => captureSourceBundle(root, storage()), error =>
        ['GIT_FAILED', 'SOURCE_CHANGED', 'SOURCE_LIMIT_EXCEEDED'].includes(error.code));
    } finally { context.mock.restoreAll(); syncBuiltinESMExports(); }
  });
}

test('detects a tracked path appearing during capture', (context) => {
  const root = mkdtempSync(path.join(TEST_TMP_ROOT, 'flowcairn-source-race-'));
  git(root, ['init', '-b', 'develop']);
  writeFileSync(path.join(root, '000-missing.txt'), 'appeared\n');
  git(root, ['add', '.']);
  unlinkSync(path.join(root, '000-missing.txt'));
  const missing = path.join(root, '000-missing.txt');
  const originalSpawn = childProcess.spawnSync;
  let indexReads = 0;
  context.mock.method(childProcess, 'spawnSync', (...args) => {
    const result = originalSpawn(...args);
    if (args[1].includes('ls-files') && args[1].includes('--stage')) {
      indexReads += 1;
      if (indexReads === 2) writeFileSync(missing, 'appeared\n');
    }
    return result;
  });
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => captureSourceBundle(root, storage()),
      (error) => error.code === 'SOURCE_CHANGED',
    );
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('rejects executable mode drift during final materialization verification', (context) => {
  const root = repository();
  const captured = captureSourceBundle(root, storage(), {
    allowedUntracked: ['allowed\nfile.txt', 'renamed\nfile.txt'],
  });
  const target = path.join(
    realpathSync(path.dirname(path.dirname(captured.bundlePath))),
    'mode-drift-target',
  );
  const executable = path.join(target, 'src', 'run.sh');
  const originalLstat = fs.lstatSync;
  let executableReads = 0;
  context.mock.method(fs, 'lstatSync', (...args) => {
    const stat = originalLstat(...args);
    if (args[0] !== executable || args[1]?.bigint !== true) return stat;
    executableReads += 1;
    if (executableReads < 2) return stat;
    return new Proxy(stat, {
      get(value, property) {
        if (property === 'mode') return value.mode & ~0o111n;
        const result = Reflect.get(value, property, value);
        return typeof result === 'function' ? result.bind(value) : result;
      },
    });
  });
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => materializeSourceBundle(captured.bundlePath, target),
      (error) => error.code === 'SOURCE_BUNDLE_TAMPERED',
    );
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
