import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverWorkspaceManifests } from '../bin/workspaces.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-workspaces-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('/usr/bin/git', ['init', '--initial-branch=main'], { cwd: root, stdio: 'ignore' });
  const write = (file, content) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  };
  const pkg = (directory) =>
    write(`${directory}/package.json`, JSON.stringify({ name: directory }));
  return { root, write, pkg };
}

test('pnpm YAML packages are authoritative without package.json workspaces', (t) => {
  const { root, write, pkg } = fixture(t);
  pkg('packages/a');
  pkg('packages/b');
  pkg('other/unused');
  write('pnpm-workspace.yaml', 'packages:\n  - packages/*\n');
  assert.deepEqual(discoverWorkspaceManifests(root, {}, 'pnpm'), [
    'packages/a/package.json',
    'packages/b/package.json',
  ]);
  assert.deepEqual(discoverWorkspaceManifests(root, { workspaces: ['other/*'] }, 'pnpm'), [
    'packages/a/package.json',
    'packages/b/package.json',
  ]);
});

test('supports nested, brace, dot-directory patterns and explicit exclusions', (t) => {
  const { root, write, pkg } = fixture(t);
  for (const directory of [
    'packages/a',
    'packages/skip',
    'apps/deep/web',
    'apps/.hidden/web',
    'other/no',
  ])
    pkg(directory);
  write('pnpm-workspace.yaml', 'packages:\n  - "{packages,apps}/**"\n  - "!packages/skip"\n');
  assert.deepEqual(discoverWorkspaceManifests(root, {}, 'pnpm'), [
    'apps/.hidden/web/package.json',
    'apps/deep/web/package.json',
    'packages/a/package.json',
  ]);
});

test('npm accepts both workspace array and packages object, returns children only', (t) => {
  const { root, pkg, write } = fixture(t);
  write('package.json', '{}');
  pkg('modules/one');
  pkg('modules/two');
  assert.deepEqual(
    discoverWorkspaceManifests(root, { workspaces: ['modules/*', '!modules/two'] }, 'npm'),
    ['modules/one/package.json'],
  );
  assert.deepEqual(
    discoverWorkspaceManifests(root, { workspaces: { packages: ['modules/*'] } }, 'npm'),
    ['modules/one/package.json', 'modules/two/package.json'],
  );
  assert.deepEqual(discoverWorkspaceManifests(root, {}, 'npm'), []);
});

test('Git-tracked and untracked visible manifests are deduplicated without index changes', (t) => {
  const { root, pkg } = fixture(t);
  pkg('packages/tracked');
  execFileSync('/usr/bin/git', ['add', 'packages/tracked/package.json'], { cwd: root });
  pkg('packages/untracked');
  const indexBefore = readFileSync(path.join(root, '.git/index'));
  assert.deepEqual(discoverWorkspaceManifests(root, { workspaces: ['packages/*'] }, 'npm'), [
    'packages/tracked/package.json',
    'packages/untracked/package.json',
  ]);
  assert.deepEqual(readFileSync(path.join(root, '.git/index')), indexBefore);
});

test('malformed YAML, duplicate keys, unknown tags and alias expansion fail closed', (t) => {
  const { root, write } = fixture(t);
  for (const yaml of [
    'packages: [unterminated',
    'packages: [a]\npackages: [b]\n',
    'packages: !unknown ["packages/*"]\n',
    'a: &a ["packages/*"]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]\nc: [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]\npackages: *a\n',
  ]) {
    write('pnpm-workspace.yaml', yaml);
    assert.throws(() => discoverWorkspaceManifests(root, {}, 'pnpm'), { code: 'WORKSPACES_YAML' });
  }
});

test('workspace patterns reject escaping, absolute, control and oversized forms', (t) => {
  const { root } = fixture(t);
  for (const pattern of [
    '../outside',
    '/outside',
    'C:/outside',
    'packages/../outside',
    '{../outside,packages}/*',
    'packages/\nfoo',
    'packages\\foo',
    'x'.repeat(513),
  ]) {
    assert.throws(
      () => discoverWorkspaceManifests(root, { workspaces: [pattern] }, 'npm'),
      (error) => error.code.startsWith('WORKSPACES_'),
    );
  }
});

test('workspace directory and manifest symlinks are rejected', (t) => {
  const { root, pkg, write } = fixture(t);
  pkg('real');
  mkdirSync(path.join(root, 'packages'));
  symlinkSync('../real', path.join(root, 'packages/link'));
  assert.throws(() => discoverWorkspaceManifests(root, { workspaces: ['packages/*'] }, 'npm'), {
    code: 'WORKSPACES_FILE',
  });
  rmSync(path.join(root, 'packages/link'));
  write('packages/file/target.json', '{}');
  symlinkSync('target.json', path.join(root, 'packages/file/package.json'));
  assert.throws(() => discoverWorkspaceManifests(root, { workspaces: ['packages/*'] }, 'npm'), {
    code: 'WORKSPACES_FILE',
  });
});

test('pnpm workspace configuration symlinks, including dangling links, are rejected', (t) => {
  const { root } = fixture(t);
  symlinkSync('missing.yaml', path.join(root, 'pnpm-workspace.yaml'));
  assert.throws(() => discoverWorkspaceManifests(root, {}, 'pnpm'), { code: 'WORKSPACES_FILE' });
});

test('matched ignored manifests fail; explicit exclusions and dependencies stay excluded', (t) => {
  const { root, pkg, write } = fixture(t);
  pkg('packages/visible');
  pkg('packages/ignored');
  pkg('node_modules/dependency');
  pkg('.ai-orchestrator/private');
  write('.gitignore', 'packages/ignored/\nnode_modules/\n.ai-orchestrator/\n');
  assert.throws(() => discoverWorkspaceManifests(root, { workspaces: ['**'] }, 'npm'), {
    code: 'WORKSPACES_IGNORED',
  });
  assert.deepEqual(
    discoverWorkspaceManifests(root, { workspaces: ['**', '!packages/ignored'] }, 'npm'),
    ['packages/visible/package.json'],
  );
});

test('pnpm settings-only YAML is a single-package project; malformed present packages still fails', (t) => {
  const { root, write } = fixture(t);
  write('pnpm-workspace.yaml', 'onlyBuiltDependencies: []\n');
  assert.deepEqual(discoverWorkspaceManifests(root, {}, 'pnpm'), []);
  for (const value of ['null', '{}', 'packages/*']) {
    write('pnpm-workspace.yaml', `packages: ${value}\n`);
    assert.throws(() => discoverWorkspaceManifests(root, {}, 'pnpm'), { code: 'WORKSPACES_YAML' });
  }
});
