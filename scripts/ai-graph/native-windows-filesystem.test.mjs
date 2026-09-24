import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, linkSync, renameSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPrivateMode, isTrustedMode, assertPrivateMode, sameHostPath, isPathWithin, noFollowReadFlags, fsyncParentDirectory } from './lib/host-filesystem.mjs';
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
