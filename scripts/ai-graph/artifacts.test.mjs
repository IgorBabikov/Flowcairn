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
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureBeforeContents, buildAttemptDiff } from './lib/artifacts.mjs';
import { fingerprintWorkspace } from './lib/workspace.mjs';

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
