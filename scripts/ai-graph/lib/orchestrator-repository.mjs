import { gitExecutable } from './host-executables.mjs';
import { spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import path from 'node:path';
import { loadProjectProfile } from './project.mjs';
import { CliError } from './orchestrator-task-contract.mjs';

// Fixed Git operations and worktree assertions shared by registry commands and graph bindings.
const GIT_TIMEOUT_MS = 15_000;

export function integrationBranch(root) {
  return loadProjectProfile(root).integrationBranch;
}

export function integrationRef(root) {
  return `refs/heads/${integrationBranch(root)}`;
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, timeout?: number, allowFailure?: boolean, env?: Record<string, string>}} options
 */
export function run(command, args, { cwd, timeout = 120_000, allowFailure = false, env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout,
    maxBuffer: 20 * 1024 * 1024,
    env: env ?? { ...process.env, CI: process.env.CI ?? 'true' },
    shell: false,
  });
  const output = {
    command: [command, ...args],
    status: result.status,
    signal: result.signal,
    error: result.error?.message ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
  if (!allowFailure && result.error) {
    const errorCode = typeof result.error === 'object' && 'code' in result.error
      ? result.error.code
      : null;
    throw new CliError(
      errorCode === 'ETIMEDOUT' && command === gitExecutable() ? 'GIT_TIMEOUT' : 'COMMAND_FAILED',
      errorCode === 'ETIMEDOUT' && command === gitExecutable() ? 'Git не ответил за отведенное время.' : `${command} failed`,
      output,
    );
  }
  if (!allowFailure && result.status !== 0) {
    throw new CliError('COMMAND_FAILED', `${command} failed`, output);
  }
  return output;
}

export function git(root, args, options = {}) {
  return run(gitExecutable(), ['-C', root, '-c', 'core.fsmonitor=false', ...args], {
    ...options,
    timeout: options.timeout ?? GIT_TIMEOUT_MS,
  });
}

export function gitText(root, args) {
  return git(root, args).stdout.trim();
}

export function assertIntegrationRoot(root, { clean = true } = {}) {
  const branch = gitText(root, ['branch', '--show-current']);
  if (branch !== integrationBranch(root)) {
    throw new CliError(
      'WRONG_BRANCH',
      `Canonical root must be on ${integrationBranch(root)}, found: ${branch || '(detached)'}`,
    );
  }
  if (clean) {
    const dirty = gitText(root, ['status', '--porcelain=v1', '--untracked-files=all']);
    if (dirty) {
      throw new CliError('DIRTY_ROOT', 'Canonical integration worktree has uncommitted changes', {
        paths: dirty.split('\n').map((line) => line.slice(3)),
      });
    }
  }
}

export function isAncestor(root, ancestor, descendant) {
  const result = git(root, ['merge-base', '--is-ancestor', ancestor, descendant], {
    allowFailure: true,
  });
  return result.status === 0;
}

export function assertMergeHooksReady(worktree) {
  const configured = git(worktree, ['config', '--path', '--get', 'core.hooksPath'], {
    allowFailure: true,
  });
  if (configured.status === 1 && configured.stdout.trim() === '') return;
  if (configured.status !== 0 || configured.stdout.trim() === '') {
    throw new CliError('HOOKS_NOT_READY', 'Configured core.hooksPath cannot be resolved');
  }
  const value = configured.stdout.trim();
  const hooksPath = path.isAbsolute(value) ? value : path.resolve(worktree, value);
  let stat;
  try {
    stat = lstatSync(hooksPath);
  } catch {
    throw new CliError('HOOKS_NOT_READY', `Configured hooks directory is missing: ${hooksPath}`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new CliError('HOOKS_NOT_READY', `Configured hooks path is not a directory: ${hooksPath}`);
  }
}

export function assertWorktreeAt(root, worktree, sha) {
  const actual = gitText(worktree, ['rev-parse', 'HEAD']);
  if (actual !== sha) {
    throw new CliError('HEAD_MISMATCH', `Expected ${sha}, found ${actual} in ${worktree}`);
  }
  const dirty = gitText(worktree, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (dirty) {
    throw new CliError('DIRTY_WORKTREE', `Worktree is dirty: ${worktree}`, {
      paths: dirty.split('\n').map((line) => line.slice(3)),
    });
  }
  if (!isAncestor(root, sha, actual)) {
    throw new CliError(
      'HEAD_MISMATCH',
      `Commit is not available from canonical repository: ${sha}`,
    );
  }
}

export function parseNameStatus(result) {
  const tokens = result.split('\0').filter(Boolean);
  const files = [];
  for (let index = 0; index < tokens.length; ) {
    const status = tokens[index++];
    const first = tokens[index++];
    if (!status || !first) break;
    files.push(first);
    if (status.startsWith('R') || status.startsWith('C')) {
      const second = tokens[index++];
      if (second) files.push(second);
    }
  }
  return [...new Set(files)].sort();
}

export function diffPaths(root, base, commit) {
  return parseNameStatus(git(root, ['diff', '--name-status', '-z', `${base}..${commit}`]).stdout);
}

export function historyPaths(root, base, commit) {
  const merges = gitText(root, ['rev-list', '--min-parents=2', `${base}..${commit}`]);
  if (merges) {
    throw new CliError(
      'WORKER_MERGE_FORBIDDEN',
      'Worker history must be linear; merge commits require Orchestrator integration',
    );
  }
  const commits = gitText(root, ['rev-list', '--reverse', `${base}..${commit}`])
    .split('\n')
    .filter(Boolean);
  const files = commits.flatMap((sha) =>
    parseNameStatus(
      git(root, ['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-z', sha]).stdout,
    ),
  );
  return [...new Set(files)].sort();
}

export function changedWorktreePaths(worktree) {
  const tracked = [
    ...gitText(worktree, ['diff', '--name-only', 'HEAD']).split('\n'),
    ...gitText(worktree, ['diff', '--cached', '--name-only', 'HEAD']).split('\n'),
    ...gitText(worktree, ['ls-files', '--others', '--exclude-standard']).split('\n'),
  ].filter(Boolean);
  return [...new Set(tracked)].sort();
}
