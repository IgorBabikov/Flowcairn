import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { captureSourceBundle, verifySourceBundle } from './source.mjs';
import { CliError } from './orchestrator-task-contract.mjs';
import { integrationBranch, integrationRef } from './orchestrator-repository.mjs';

// Dirty-checkout authorization is always tied to an independently recaptured immutable source.

function comparePath(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function trustedBootstrapGit(root, args) {
  const environment = {};
  for (const key of ['TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_CTYPE']) {
    if (typeof process.env[key] === 'string') environment[key] = process.env[key];
  }
  const result = spawnSync(
    '/usr/bin/git',
    ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args],
    {
      cwd: root,
      encoding: 'buffer',
      timeout: 120_000,
      maxBuffer: 20 * 1024 * 1024,
      shell: false,
      env: {
        ...environment,
        GIT_OPTIONAL_LOCKS: '0',
        GIT_NO_LAZY_FETCH: '1',
        GIT_NO_REPLACE_OBJECTS: '1',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_ATTR_NOSYSTEM: '1',
        LC_ALL: 'C',
      },
    },
  );
  if (result.error || result.signal || result.status !== 0) {
    throw new CliError('COMMAND_FAILED', 'System Git failed during bootstrap verification');
  }
  return result.stdout;
}

function trustedBootstrapGitText(root, args) {
  return trustedBootstrapGit(root, args).toString('utf8').trim();
}

function currentUntrackedPaths(root) {
  return trustedBootstrapGit(root, ['ls-files', '--others', '--exclude-standard', '-z'])
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .sort(comparePath);
}

function makeDirectoriesWritable(directory) {
  if (!existsSync(directory)) return;
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  chmodSync(directory, stat.mode | 0o700);
  for (const entry of readdirSync(directory)) {
    makeDirectoriesWritable(path.join(directory, entry));
  }
}

export function verifyBootstrapSource(root, rawBundlePath) {
  if (typeof rawBundlePath !== 'string' || rawBundlePath.trim() === '') {
    throw new CliError(
      'INVALID_ARGUMENT',
      '--bootstrap-source-bundle must be an immutable source bundle path',
    );
  }
  const bundlePath = path.resolve(rawBundlePath.trim());
  const manifest = verifySourceBundle(bundlePath);
  const branch = trustedBootstrapGitText(root, ['branch', '--show-current']);
  if (branch !== integrationBranch(root)) {
    throw new CliError(
      'WRONG_BRANCH',
      `Canonical root must be on ${integrationBranch(root)}, found: ${branch || '(detached)'}`,
    );
  }
  const developHead = trustedBootstrapGitText(root, ['rev-parse', integrationRef(root)]);
  if (manifest.source.head === null || manifest.source.head !== developHead) {
    throw new CliError(
      'SOURCE_HEAD_MISMATCH',
      'Bootstrap source bundle HEAD does not match current integration branch',
      { expected: developHead, actual: manifest.source.head },
    );
  }

  const expectedUntracked = manifest.entries
    .filter((entry) => entry.head === null && entry.index === null && entry.worktree !== null)
    .map((entry) => entry.path)
    .sort(comparePath);
  const actualUntracked = currentUntrackedPaths(root);
  if (expectedUntracked.some((file) => !actualUntracked.includes(file))) {
    throw new CliError(
      'SOURCE_SNAPSHOT_MISMATCH',
      'Selected untracked paths are missing from the current checkout',
    );
  }

  const verificationRoot = mkdtempSync(
    path.join(realpathSync(tmpdir()), 'flowcairn-orchestrator-bootstrap-'),
  );
  try {
    const current = captureSourceBundle(root, path.join(verificationRoot, 'sources'), {
      allowedUntracked: expectedUntracked,
    });
    if (
      current.manifest.sourceHash !== manifest.sourceHash ||
      JSON.stringify(currentUntrackedPaths(root)) !== JSON.stringify(actualUntracked)
    ) {
      throw new CliError(
        'SOURCE_SNAPSHOT_MISMATCH',
        'Current HEAD, index or worktree does not match the bootstrap source bundle',
        { expected: manifest.sourceHash, actual: current.manifest.sourceHash },
      );
    }
  } finally {
    try {
      makeDirectoriesWritable(verificationRoot);
      rmSync(verificationRoot, { recursive: true, force: true });
    } catch {
      /* Verification cleanup is best-effort and must not replace the source verdict. */
    }
  }
  return manifest.sourceHash;
}
