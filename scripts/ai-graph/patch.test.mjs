import assert from 'node:assert/strict';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sha256 } from './lib/io.mjs';
import { applyProposedEdits } from './lib/patch.mjs';

function record(root, relativePath) {
  const file = path.join(root, relativePath);
  const stat = lstatSync(file);
  const body = readFileSync(file);
  return {
    path: relativePath,
    hash: sha256(body),
    mode: stat.mode & 0o111 ? '100755' : '100644',
    size: body.length,
  };
}

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'flowcairn-patch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'src'));
  mkdirSync(path.join(root, 'dist'));
  writeFileSync(path.join(root, 'src/update.txt'), 'before\n');
  writeFileSync(path.join(root, 'src/delete.txt'), 'delete me\n');
  writeFileSync(path.join(root, 'dist/tracked.js'), 'tracked generated baseline\n');
  const before = {
    files: [
      record(root, 'dist/tracked.js'),
      record(root, 'src/delete.txt'),
      record(root, 'src/update.txt'),
    ],
  };
  const node = {
    permissions: ['ai.read', 'workspace.source.write'],
    resources: { writes: ['src/'] },
  };
  const task = {
    scope: ['src/'],
    forbiddenPaths: ['.git', '.ai-orchestrator', 'src/forbidden'],
  };
  return { root, before, node, task };
}

function edit(pathValue, previousHash, content, executable = false) {
  return { path: pathValue, previousHash, content, executable };
}

function temporaryFiles(root) {
  const found = [];
  function walk(directory) {
    for (const name of readdirSync(directory)) {
      const absolute = path.join(directory, name);
      const stat = lstatSync(absolute);
      if (stat.isDirectory() && !stat.isSymbolicLink()) walk(absolute);
      else if (name.startsWith('.graph-patch-')) found.push(absolute);
    }
  }
  walk(root);
  return found;
}

test('atomically creates, updates, deletes, and applies executable mode', (t) => {
  const { root, before, node, task } = fixture(t);
  const update = before.files.find((file) => file.path === 'src/update.txt');
  const deletion = before.files.find((file) => file.path === 'src/delete.txt');

  applyProposedEdits(root, before, node, task, [
    edit('src/update.txt', update.hash, '#!/bin/sh\necho updated\n', true),
    edit('src/nested/new.txt', null, 'new\n'),
    edit('src/delete.txt', deletion.hash, null),
  ]);

  assert.equal(
    readFileSync(path.join(root, 'src/update.txt'), 'utf8'),
    '#!/bin/sh\necho updated\n',
  );
  assert.equal(lstatSync(path.join(root, 'src/update.txt')).mode & 0o777, 0o755);
  assert.equal(readFileSync(path.join(root, 'src/nested/new.txt'), 'utf8'), 'new\n');
  assert.equal(lstatSync(path.join(root, 'src/nested/new.txt')).mode & 0o777, 0o644);
  assert.equal(existsSync(path.join(root, 'src/delete.txt')), false);
  assert.deepEqual(temporaryFiles(root), []);
});

test('rejects scope, protected, traversal, absolute, and empty-segment paths', (t) => {
  const { root, before, node, task } = fixture(t);
  for (const candidate of [
    'outside.txt',
    'src/.env',
    'src/../escape.txt',
    '/tmp/escape.txt',
    'src//empty.txt',
    'src/node_modules/pkg.js',
    'SRC/.GIT/config',
  ]) {
    assert.throws(
      () => applyProposedEdits(root, before, node, task, [edit(candidate, null, 'blocked\n')]),
      (error) => error.code === 'PATCH_DENIED',
      candidate,
    );
  }
  assert.equal(readFileSync(path.join(root, 'src/update.txt'), 'utf8'), 'before\n');
  assert.deepEqual(temporaryFiles(root), []);
});

test('rejects previousHash or content drift', (t) => {
  const { root, before, node, task } = fixture(t);
  const update = before.files.find((file) => file.path === 'src/update.txt');
  assert.throws(
    () =>
      applyProposedEdits(root, before, node, task, [
        edit('src/update.txt', '0'.repeat(64), 'after\n'),
      ]),
    (error) => error.code === 'PATCH_DENIED',
  );
  writeFileSync(path.join(root, 'src/update.txt'), 'changed concurrently\n');
  assert.throws(
    () =>
      applyProposedEdits(root, before, node, task, [
        edit('src/update.txt', update.hash, 'after\n'),
      ]),
    (error) => error.code === 'PATCH_DENIED',
  );
  assert.equal(readFileSync(path.join(root, 'src/update.txt'), 'utf8'), 'changed concurrently\n');
});

test('rejects symlink targets, symlink ancestors, and hardlinks', (t) => {
  const { root, before, node, task } = fixture(t);
  const update = before.files.find((file) => file.path === 'src/update.txt');
  const outsideFile = path.join(root, 'outside.txt');
  writeFileSync(outsideFile, 'outside\n');

  unlinkSync(path.join(root, 'src/update.txt'));
  symlinkSync(outsideFile, path.join(root, 'src/update.txt'));
  assert.throws(
    () =>
      applyProposedEdits(root, before, node, task, [
        edit('src/update.txt', update.hash, 'overwrite\n'),
      ]),
    (error) => error.code === 'PATCH_DENIED',
  );
  assert.equal(readFileSync(outsideFile, 'utf8'), 'outside\n');

  const outsideDirectory = path.join(root, 'outside-directory');
  mkdirSync(outsideDirectory);
  symlinkSync(outsideDirectory, path.join(root, 'src/link'));
  assert.throws(
    () =>
      applyProposedEdits(root, before, node, task, [edit('src/link/escape.txt', null, 'escape\n')]),
    (error) => error.code === 'PATCH_DENIED',
  );
  assert.equal(existsSync(path.join(outsideDirectory, 'escape.txt')), false);

  const hardlink = path.join(root, 'src/hardlink.txt');
  linkSync(outsideFile, hardlink);
  const hardlinkBefore = { files: [...before.files, record(root, 'src/hardlink.txt')] };
  assert.throws(
    () =>
      applyProposedEdits(root, hardlinkBefore, node, task, [
        edit('src/hardlink.txt', hardlinkBefore.files.at(-1).hash, 'overwrite\n'),
      ]),
    (error) => error.code === 'PATCH_DENIED',
  );
  assert.equal(readFileSync(outsideFile, 'utf8'), 'outside\n');
});

test('preflights the entire batch before changing any file', (t) => {
  const { root, before, node, task } = fixture(t);
  const update = before.files.find((file) => file.path === 'src/update.txt');
  assert.throws(
    () =>
      applyProposedEdits(root, before, node, task, [
        edit('src/update.txt', update.hash, 'would change\n'),
        edit('src/new.txt', 'f'.repeat(64), 'invalid second edit\n'),
      ]),
    (error) => error.code === 'PATCH_DENIED',
  );
  assert.equal(readFileSync(path.join(root, 'src/update.txt'), 'utf8'), 'before\n');
  assert.equal(existsSync(path.join(root, 'src/new.txt')), false);
  assert.deepEqual(temporaryFiles(root), []);
});

test('enforces source.write permission and the 1 MiB batch cap', (t) => {
  const { root, before, node, task } = fixture(t);
  assert.throws(
    () =>
      applyProposedEdits(root, before, { ...node, permissions: ['ai.read'] }, task, [
        edit('src/new.txt', null, 'new\n'),
      ]),
    (error) => error.code === 'PATCH_DENIED',
  );
  const content = 'x'.repeat(128 * 1024);
  const oversized = Array.from({ length: 9 }, (_, index) =>
    edit(`src/file-${index}.txt`, null, content),
  );
  assert.throws(
    () => applyProposedEdits(root, before, node, task, oversized),
    (error) => error.code === 'PATCH_DENIED',
  );
  assert.equal(existsSync(path.join(root, 'src/file-0.txt')), false);
  assert.deepEqual(temporaryFiles(root), []);
});

test('forbidden directory aliases are refused before creating any files', (t) => {
  const { root, before, node, task } = fixture(t);
  for (const candidate of ['src/FORBIDDEN/new.txt', 'src/Forbidden/new.txt']) {
    assert.throws(
      () =>
        applyProposedEdits(root, before, node, task, [edit(candidate, null, 'bounded fixture')]),
      /scope/,
    );
    assert.equal(existsSync(path.join(root, candidate)), false);
  }
});
