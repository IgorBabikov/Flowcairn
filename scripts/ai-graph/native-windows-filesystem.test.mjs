import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, linkSync, renameSync, symlinkSync, lstatSync, fstatSync, openSync, closeSync, chmodSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPrivateMode, isTrustedMode, assertPrivateMode, sameHostPath, isPathWithin, noFollowReadFlags, fsyncParentDirectory, canonicalStatDevice, crossStatIdentity, lstatHostSync, fstatHostSync, HOST_FILESYSTEM_TESTING, realpathHostSync } from './lib/host-filesystem.mjs';
import { gitExecutable, gitNullDevice, hostSystemEnvironment } from './lib/host-executables.mjs';
import { captureSourceBundle, materializeSourceBundle } from './lib/source.mjs';
import { inspectProjectSource, readProjectSourcePage } from './lib/project-source-access.mjs';
import { fingerprintDirectWorkspace } from './lib/direct-workspace.mjs';
import { captureDirectSource, verifyDirectSource } from './lib/direct-source.mjs';
import { allocateDirectBinding, verifyDirectBinding } from './lib/direct-binding.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'native-fs-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('Windows mode handling does not confuse synthesized stat modes with ACL evidence', () => {
  for (const mode of [0o666, 0o777, 0o666n, 0o777n]) {
    assert.equal(isPrivateMode({ mode }, 'win32'), true);
    assert.equal(isTrustedMode({ mode }, 'win32'), true);
    assert.doesNotThrow(() => assertPrivateMode({ mode }, 'win32'));
    assert.equal(isPrivateMode({ mode }, 'linux'), false);
    assert.equal(isTrustedMode({ mode }, 'darwin'), false);
  }
  assert.equal(isPrivateMode({ mode: 0o600 }, 'darwin'), true);
  assert.equal(isTrustedMode({ mode: 0o755n }, 'linux'), true);
  assert.throws(() => assertPrivateMode({ mode: 0o644 }, 'linux'));
});

test('Windows drive, separator, case and UNC containment stay component-bounded', () => {
  assert.equal(sameHostPath('C:\\Users\\User\\Project', 'c:/users/user/project', 'win32'), true);
  assert.equal(sameHostPath('\\\\?\\C:\\Users\\User\\Project', 'C:\\Users\\User\\Project', 'win32'), true);
  assert.equal(sameHostPath('\\\\?\\UNC\\host\\share\\project', '\\\\host\\share\\project', 'win32'), true);
  for (const candidate of ['c:/Project/src/file.js', 'C:\\PROJECT']) assert.equal(isPathWithin('C:\\Project', candidate, 'win32'), true);
  for (const candidate of ['c:/Project-copy/private', 'D:\\Project\\source', 'C:\\Project\\..\\private']) assert.equal(isPathWithin('C:\\Project', candidate, 'win32'), false);
  assert.equal(isPathWithin('\\\\host\\share\\project', '\\\\other\\share\\project', 'win32'), false);
  assert.equal(sameHostPath('/Project', '/project', 'linux'), false);
});

test('Windows directory fsync explicitly reports missing durability guarantee', (t) => {
  const root = fixture(t);
  assert.deepEqual(fsyncParentDirectory(root, 'win32'), { synced: false, reason: 'directory-fsync-unsupported' });
  assert.equal(Number.isInteger(noFollowReadFlags()), true);
  if (process.platform !== 'win32') assert.deepEqual(fsyncParentDirectory(root), { synced: true, reason: null });
});

test('host-native no-Git direct fingerprint/source/binding/page flow uses original project', (t) => {
  const root = fixture(t);
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src', 'main.js'), 'export const value = 1;');
  const profile = { outputPaths: [] };
  const initial = fingerprintDirectWorkspace(root);
  const source = captureDirectSource(root, profile);
  assert.equal(verifyDirectSource(source.bundlePath), initial.hash);
  const binding = allocateDirectBinding({ root, task: { id: 'native-task' }, runId: 'native-run', sourceHash: source.manifest.sourceHash,
    owner: 'local-operator', outputPaths: [] });
  assert.deepEqual(verifyDirectBinding(root, binding), binding);
  const index = inspectProjectSource(root);
  assert.equal(index.root, root);
  assert.equal(readProjectSourcePage(index, { path: 'src/main.js' }).text, 'export const value = 1;');
  writeFileSync(path.join(root, 'src', 'main.js'), 'export const value = 2;');
  assert.notEqual(fingerprintDirectWorkspace(root).hash, initial.hash);
  assert.throws(() => readProjectSourcePage(index, { path: 'src/main.js' }));
});

test('native record hardlinks and directory junction/symlink escapes remain rejected', (t) => {
  const root = fixture(t);
  writeFileSync(path.join(root, 'main.js'), 'safe');
  const source = captureDirectSource(root, { outputPaths: [] });
  const link = path.join(root, 'record-alias');
  linkSync(source.bundlePath, link);
  assert.throws(() => verifyDirectSource(source.bundlePath));
  rmSync(link);
  const storage = path.dirname(source.bundlePath), moved = `${storage}-moved`;
  renameSync(storage, moved);
  symlinkSync(moved, storage, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => captureDirectSource(root, { outputPaths: [] }));
});


test('Windows device normalization matches libuv low32 representation without losing other identity fields', () => {
  const stat = { dev: 0xabcdeff123456789n, ino: 123456789012345678n, mode: 0o100666n, nlink: 1n, size: 4n, mtimeNs: 123456789012345n, ctimeNs: 123456789012346n };
  const handle = { ...stat, dev: 0x23456789n };
  assert.equal(canonicalStatDevice(stat, 'win32'), handle.dev);
  assert.equal(crossStatIdentity(stat, 'win32'), crossStatIdentity(handle, 'win32'));
  assert.notEqual(crossStatIdentity(stat, 'linux'), crossStatIdentity(handle, 'linux'));
  for (const field of ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs']) {
    assert.notEqual(crossStatIdentity(stat, 'win32'), crossStatIdentity({ ...handle, [field]: handle[field] + 1n }, 'win32'), field);
  }
  assert.throws(() => canonicalStatDevice({ dev: Number(stat.dev) }, 'win32'));
});

test('new fixture path and descriptor stat identities agree on the current native host', (t) => {
  const root = fixture(t);
  const file = path.join(root, 'stat-fixture.txt');
  writeFileSync(file, 'safe');
  const before = lstatSync(file, { bigint: true });
  const fd = openSync(file, noFollowReadFlags());
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (process.platform === 'win32') {
      const fields = ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'];
      const values = (stat) => Object.fromEntries(fields.map((key) => [key, String(stat[key])]));
      // Only this newly created, public four-byte fixture; no project paths/data.
      t.diagnostic(JSON.stringify({ node: process.versions.node, uv: process.versions.uv, pathStat: values(before), fdStat: values(opened) }));
    }
    assert.equal(crossStatIdentity(lstatHostSync(file, { bigint: true })), crossStatIdentity(fstatHostSync(fd, { bigint: true })));
    assert.equal(lstatSync(file, { bigint: true }).dev, before.dev);
    assert.equal(fstatSync(fd, { bigint: true }).dev, opened.dev);
  } finally { closeSync(fd); }
});


test('Windows missing path dev is recovered from a stable descriptor, never treated as wildcard', () => {
  const base = { dev: 0n, ino: 1125899908200345n, mode: 33206n, nlink: 1n, size: 4n,
    mtimeNs: 1790246620547666000n, ctimeNs: 1790246620547666000n, birthtimeNs: 1790246620547666000n,
    isFile: () => true };
  const handle = { ...base, dev: 3606225537n };
  let closed = 0;
  const { completeWindowsFileStat } = HOST_FILESYSTEM_TESTING;
  const result = completeWindowsFileStat('synthetic-fixture', { ...base }, () => ({ ...base }), {
    open: () => 123, handleStat: () => ({ ...handle }), close: (fd) => { assert.equal(fd, 123); closed++; },
  });
  assert.equal(result.dev, handle.dev);
  assert.equal(closed, 1);
  assert.equal(crossStatIdentity(result, 'win32'), crossStatIdentity(handle, 'win32'));
  for (const field of ['ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs', 'birthtimeNs']) {
    closed = 0;
    assert.throws(() => completeWindowsFileStat('synthetic-fixture', { ...base }, () => ({ ...base, [field]: base[field] + 1n }), {
      open: () => 123, handleStat: () => ({ ...handle }), close: () => { closed++; },
    }), { code: 'ESTALE' });
    assert.equal(closed, 1);
  }
  let calls = 0;
  assert.throws(() => completeWindowsFileStat('synthetic-fixture', { ...base }, () => ({ ...base }), {
    open: () => 123, handleStat: () => ({ ...handle, dev: ++calls === 1 ? handle.dev : handle.dev + 1n }), close: () => {},
  }), { code: 'ESTALE' });
  const link = { ...base, isFile: () => false };
  assert.equal(completeWindowsFileStat('synthetic-fixture', link, () => { throw Error('Must not follow'); }), link);
});


test('native Git worktree capture/materialization and live pages retain source freshness', { timeout: 20000 }, (t) => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'native-git-fixture-')));
  t.after(() => {
    const writable = (file) => {
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) return;
      chmodSync(file, stat.isDirectory() ? 0o700 : 0o600);
      if (stat.isDirectory()) for (const name of readdirSync(file)) writable(path.join(file, name));
    };
    writable(base);
    rmSync(base, { recursive: true, force: true });
  });
  const root = path.join(base, 'repo'), worktree = path.join(base, 'worktree');
  mkdirSync(root, { mode: 0o700 });
  const git = (cwd, ...args) => execFileSync(gitExecutable(), ['-c', `core.hooksPath=${gitNullDevice}`, ...args], {
    cwd, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
    env: { ...hostSystemEnvironment(), PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitNullDevice },
  });
  git(root, 'init', '--initial-branch=main');
  git(root, 'config', '--local', 'user.name', 'Native fixture');
  git(root, 'config', '--local', 'user.email', 'fixture@example.invalid');
  git(root, 'config', '--local', 'core.autocrlf', 'false');
  git(root, 'config', '--local', 'commit.gpgsign', 'false');
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src', 'value.txt'), 'original source\n');
  writeFileSync(path.join(root, '.gitignore'), '.ai-orchestrator/\n');
  writeFileSync(path.join(root, 'src', 'run.sh'), '#!/bin/sh\necho native-fixture\n');
  git(root, 'add', '.');
  git(root, 'update-index', '--chmod=+x', 'src/run.sh');
  git(root, 'commit', '-m', 'Native fixture baseline');
  git(root, 'worktree', 'add', '--detach', worktree, 'HEAD');
  const reportedRoot = git(worktree, 'rev-parse', '--show-toplevel').trim();
  if (process.platform === 'win32') t.diagnostic(JSON.stringify({
    fixtureRequested: worktree, fixtureGitReported: reportedRoot,
    fixtureNativeRequested: realpathHostSync(worktree), fixtureNativeReported: realpathHostSync(reportedRoot),
  }));
  assert.equal(sameHostPath(realpathHostSync(worktree), realpathHostSync(reportedRoot)), true);
  const index = inspectProjectSource(worktree);
  assert.equal(readProjectSourcePage(index, { path: 'src/value.txt' }).text, 'original source\n');
  const captured = captureSourceBundle(worktree, path.join(base, 'sources'));
  const script = captured.manifest.entries.find((entry) => entry.path === 'src/run.sh');
  assert.equal(script.index.mode, '100755');
  assert.equal(script.worktree.mode, '100755');
  const materialized = path.join(base, 'materialized');
  assert.equal(materializeSourceBundle(captured.bundlePath, materialized).sourceHash, captured.manifest.sourceHash);
  assert.equal(readFileSync(path.join(materialized, 'src/run.sh'), 'utf8'), '#!/bin/sh\necho native-fixture\n');
  const restored = inspectProjectSource(materialized);
  assert.equal(readProjectSourcePage(restored, { path: 'src/value.txt' }).text, 'original source\n');
  writeFileSync(path.join(worktree, 'src', 'value.txt'), 'changed worktree\n');
  assert.notEqual(inspectProjectSource(worktree).hash, index.hash);
  assert.throws(() => readProjectSourcePage(index, { path: 'src/value.txt' }), { code: 'UNSAFE_PROJECT_SOURCE' });
  assert.notEqual(captureSourceBundle(worktree, path.join(base, 'sources')).manifest.sourceHash, captured.manifest.sourceHash);
  assert.equal(readFileSync(path.join(root, 'src', 'value.txt'), 'utf8'), 'original source\n');
  assert.equal(readProjectSourcePage(restored, { path: 'src/value.txt' }).text, 'original source\n');
});


test('explicit existing-path canonicalization preserves lexical alias rejection', (t) => {
  const root = fixture(t), target = path.join(root, 'target'), alias = path.join(root, 'alias');
  mkdirSync(target);
  symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(sameHostPath(target, alias), false);
  assert.equal(sameHostPath(realpathHostSync(target), realpathHostSync(alias)), true);
  assert.throws(() => realpathHostSync(path.join(root, 'missing')));
  assert.equal(isPathWithin(root, path.join(root, 'missing')), true);
});

test('native Windows existing 8.3 alias resolves to the same exact directory', { skip: process.platform !== 'win32' }, (t) => {
  const root = fixture(t);
  // Windows TEMP can use an existing 8.3 ancestor (e.g. RUNNER~1 in CI).
  // Use that actual alias directly, without shell quoting or creating aliases.
  const canonical = realpathHostSync(root);
  if (!root.includes('~') || sameHostPath(root, canonical)) {
    t.skip('This temporary directory does not expose an 8.3 alias'); return;
  }
  assert.equal(sameHostPath(realpathHostSync(root), realpathHostSync(canonical)), true);
  const sibling = `${root}-sibling`;
  mkdirSync(sibling);
  try { assert.equal(sameHostPath(realpathHostSync(root), realpathHostSync(sibling)), false); }
  finally { rmSync(sibling, { recursive: true, force: true }); }
});
