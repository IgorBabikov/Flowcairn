import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  renameSync,
  chmodSync,
  statSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureBeforeContents, buildAttemptDiff } from './lib/artifacts.mjs';
import { fingerprintWorkspace } from './lib/workspace.mjs';
import { validateChangeEvidence } from './lib/change-evidence.mjs';
import { sha256 } from './lib/io.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'attempt-diff-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('/usr/bin/git', ['init', '-b', 'develop'], { cwd: root, stdio: 'ignore' });
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src/file.txt'), 'original\n');
  execFileSync('/usr/bin/git', ['add', 'src/file.txt'], { cwd: root });
  writeFileSync(
    path.join(root, 'src/file.txt'),
    'user staged baseline differs from working bytes\n',
  );
  const before = fingerprintWorkspace(root);
  const content = captureBeforeContents(root, before, {
    permissions: ['workspace.source.write'],
    resources: { writes: ['src/'] },
  });
  return { root, before, content };
}

test('attempt diff uses captured working bytes, applies cleanly and preserves user baseline', (t) => {
  const { root, before, content } = fixture(t);
  writeFileSync(path.join(root, 'src/file.txt'), 'AI change\n');
  const after = fingerprintWorkspace(root),
    diff = buildAttemptDiff(root, before, after, content);
  assert.equal(diff.complete, true);
  assert.ok(diff.content.includes('-user staged baseline'));
  assert.ok(!diff.content.includes('-original'));
  writeFileSync(path.join(root, 'src/file.txt'), content.get('src/file.txt'));
  execFileSync('/usr/bin/git', ['apply', '--check', '-'], { cwd: root, input: diff.content });
  execFileSync('/usr/bin/git', ['apply', '-'], { cwd: root, input: diff.content });
  assert.equal(readFileSync(path.join(root, 'src/file.txt'), 'utf8'), 'AI change\n');
});

test('new, deleted, Unicode and no-final-newline changes are hash-bound and readable', (t) => {
  const { root, before, content } = fixture(t);
  unlinkSync(path.join(root, 'src/file.txt'));
  writeFileSync(path.join(root, 'src/новый.txt'), 'new content');
  const after = fingerprintWorkspace(root),
    diff = buildAttemptDiff(root, before, after, content);
  assert.equal(diff.complete, true);
  assert.ok(diff.content.includes('new file mode'));
  assert.ok(diff.content.includes('deleted file mode'));
  assert.ok(diff.content.includes('No newline at end of file'));
  writeFileSync(path.join(root, 'src/file.txt'), content.get('src/file.txt'));
  unlinkSync(path.join(root, 'src/новый.txt'));
  execFileSync('/usr/bin/git', ['apply', '-'], { cwd: root, input: diff.content });
  assert.equal(readFileSync(path.join(root, 'src/новый.txt'), 'utf8'), 'new content');
});

test('missing before bytes, changed after bytes and sensitive content cannot create complete proof', (t) => {
  const { root, before, content } = fixture(t);
  writeFileSync(path.join(root, 'src/file.txt'), 'after');
  const after = fingerprintWorkspace(root);
  assert.throws(() => buildAttemptDiff(root, before, after, new Map()), {
    code: 'DIFF_BEFORE_MISSING',
  });
  writeFileSync(path.join(root, 'src/file.txt'), 'changed again');
  assert.throws(() => buildAttemptDiff(root, before, after, content), { code: 'ARTIFACT_SOURCE' });
  writeFileSync(path.join(root, 'src/file.txt'), 'sk-aaaaaaaaaaaaaaaaaaaaaaaa');
  const sensitive = fingerprintWorkspace(root);
  const diff = buildAttemptDiff(root, before, sensitive, content);
  assert.equal(diff.complete, false);
  assert.ok(!diff.content.includes('sk-aaaa'));
});

const largeDictionary = (prefix) => Object.fromEntries(Array.from({ length: 5000 }, (_, index) => [`key-${index}`, `${prefix}-${index}-${'value '.repeat(42)}`]));
function capture(root) {
  const before = fingerprintWorkspace(root);
  return { before, contents: captureBeforeContents(root, before, { permissions: ['workspace.source.write'], resources: { writes: ['src'] } }) };
}

test('megabyte moves, JSON member edits and full deletions have exact compact operation evidence', (t) => {
  const { root } = fixture(t);
  const moved = JSON.stringify(largeDictionary('move'), null, 2) + '\n';
  const edited = largeDictionary('edit');
  const deleted = JSON.stringify(largeDictionary('delete'));
  assert.ok(Buffer.byteLength(moved) > 1024 * 1024);
  for (const [file, value] of [['move.json', moved], ['edit.json', JSON.stringify(edited)], ['delete.json', deleted]])
    writeFileSync(path.join(root, 'src', file), value);
  const { before, contents } = capture(root);
  renameSync(path.join(root, 'src/move.json'), path.join(root, 'src/moved.json'));
  unlinkSync(path.join(root, 'src/delete.json'));
  const removed = edited['key-17']; delete edited['key-17']; edited['key-27'] = 'replacement'; edited['new-key'] = { enabled: true };
  writeFileSync(path.join(root, 'src/edit.json'), JSON.stringify(edited, null, 2));
  const after = fingerprintWorkspace(root), diff = buildAttemptDiff(root, before, after, contents);
  assert.equal(diff.complete, true); assert.equal(diff.mediaType, 'application/json');
  assert.ok(Buffer.byteLength(diff.content) < 10 * 1024);
  const report = validateChangeEvidence(diff.content, { changedFiles: ['src/move.json', 'src/moved.json', 'src/edit.json', 'src/delete.json'], beforeFingerprint: before.hash, afterFingerprint: after.hash });
  const move = report.operations.find((item) => item.kind === 'move');
  assert.equal(move.from, 'src/move.json'); assert.equal(move.to, 'src/moved.json'); assert.equal(move.byteIdentical, true);
  assert.equal(move.before.hash, sha256(moved)); assert.deepEqual(move.before, move.after);
  const change = report.operations.find((item) => item.kind === 'json-entries');
  assert.deepEqual(change.removed, [{ key: 'key-17', value: JSON.stringify(removed) }]);
  assert.equal(change.replaced[0].key, 'key-27'); assert.equal(change.added[0].key, 'new-key');
  assert.equal(change.beforeEntryCount, 5000); assert.equal(change.afterEntryCount, 5000); assert.equal(change.unchangedEntryCount, 4998);
  assert.equal(change.layout, 'outer-whitespace-and-member-order-not-reproduced');
  const deletion = report.operations.find((item) => item.kind === 'delete');
  assert.equal(deletion.contentIncluded, false); assert.equal(deletion.before.hash, sha256(deleted)); assert.equal(deletion.jsonEntryCount, 5000);
  assert.ok(!diff.content.includes('delete-4999'));
});

test('ordinary large source edits use bounded real hunks that reconstruct exact attempt bytes', (t) => {
  const { root } = fixture(t);
  const lines = Array.from({ length: 6000 }, (_, index) => `export const value${index} = '${'text '.repeat(40)}';`);
  const original = lines.join('\n') + '\n'; assert.ok(Buffer.byteLength(original) > 1024 * 1024);
  writeFileSync(path.join(root, 'src/file.txt'), original);
  const { before, contents } = capture(root);
  lines[3000] = 'export const value3000 = 42;'; const target = lines.join('\n') + '\n';
  writeFileSync(path.join(root, 'src/file.txt'), target);
  const diff = buildAttemptDiff(root, before, fingerprintWorkspace(root), contents);
  assert.equal(diff.complete, true); assert.equal(diff.mediaType, 'text/x-diff'); assert.ok(Buffer.byteLength(diff.content) < 3000);
  writeFileSync(path.join(root, 'src/file.txt'), original);
  execFileSync('/usr/bin/git', ['apply', '-'], { cwd: root, input: diff.content });
  assert.equal(readFileSync(path.join(root, 'src/file.txt'), 'utf8'), target);
});

test('sensitive bytes cannot be hidden behind move, JSON or full deletion descriptors', (t) => {
  for (const operation of ['move', 'json', 'delete']) {
    const { root } = fixture(t); const value = largeDictionary(operation); value.token = 'sk-aaaaaaaaaaaaaaaaaaaaaaaa';
    writeFileSync(path.join(root, 'src/sensitive-data.json'), JSON.stringify(value));
    const { before, contents } = capture(root);
    if (operation === 'move') renameSync(path.join(root, 'src/sensitive-data.json'), path.join(root, 'src/moved.json'));
    else if (operation === 'delete') unlinkSync(path.join(root, 'src/sensitive-data.json'));
    else { delete value['key-17']; writeFileSync(path.join(root, 'src/sensitive-data.json'), JSON.stringify(value)); }
    const diff = buildAttemptDiff(root, before, fingerprintWorkspace(root), contents);
    assert.equal(diff.complete, false); assert.match(diff.content, /^Content withheld:/); assert.ok(!diff.content.includes('sk-aaaa'));
  }
});

test('equal-content rename with a mode change is never attested as byte-and-mode identical move', (t) => {
  const { root } = fixture(t); const { before, contents } = capture(root);
  renameSync(path.join(root, 'src/file.txt'), path.join(root, 'src/renamed.txt'));
  chmodSync(path.join(root, 'src/renamed.txt'), 0o755);
  const diff = buildAttemptDiff(root, before, fingerprintWorkspace(root), contents);
  assert.equal(diff.mediaType, 'text/x-diff'); assert.equal(diff.complete, true);
});

test('empty-file creation and mode-only changes remain applicable unified diffs', (t) => {
  const { root } = fixture(t); const { before, contents } = capture(root);
  writeFileSync(path.join(root, 'src/empty.txt'), ''); chmodSync(path.join(root, 'src/file.txt'), 0o755);
  const diff = buildAttemptDiff(root, before, fingerprintWorkspace(root), contents);
  assert.equal(diff.complete, true); assert.equal(diff.mediaType, 'text/x-diff');
  unlinkSync(path.join(root, 'src/empty.txt')); chmodSync(path.join(root, 'src/file.txt'), 0o644);
  execFileSync('/usr/bin/git', ['apply', '-'], { cwd: root, input: diff.content });
  assert.equal(readFileSync(path.join(root, 'src/empty.txt')).length, 0); assert.ok(statSync(path.join(root, 'src/file.txt')).mode & 0o111);
});

test('oversized unstructured replacement never returns a truncated complete diff', (t) => {
  const { root } = fixture(t);
  writeFileSync(path.join(root, 'src/file.txt'), 'x'.repeat(2 * 1024 * 1024));
  const { before, contents } = capture(root);
  writeFileSync(path.join(root, 'src/file.txt'), 'y'.repeat(2 * 1024 * 1024));
  const diff = buildAttemptDiff(root, before, fingerprintWorkspace(root), contents);
  assert.equal(diff.complete, false); assert.match(diff.content, /^Diff exceeds/); assert.ok(diff.content.length < 200);
});
