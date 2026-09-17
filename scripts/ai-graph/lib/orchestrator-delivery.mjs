import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CliError, stringArray, registeredHostCheck } from './orchestrator-task-contract.mjs';
import { required } from './orchestrator-arguments.mjs';
import { readState, withLock, atomicWrite, assertOwner, getTask, getAttempt, latestAttempt, latestCandidate, pathOverlaps, pathsFor } from './orchestrator-registry.mjs';
import { run, gitText, assertWorktreeAt, isAncestor, diffPaths, historyPaths, changedWorktreePaths } from './orchestrator-repository.mjs';

// Worker reports and registered checks produce receipts; neither integrates a candidate.
const now = () => new Date().toISOString();

function readResultFile(file) {
  let value;
  try {
    value = JSON.parse(readFileSync(path.resolve(file), 'utf8'));
  } catch (error) {
    throw new CliError('INVALID_RESULT', `Cannot parse result file: ${error.message}`);
  }
  for (const key of ['outcome', 'selfReview', 'nextStep']) {
    if (typeof value[key] !== 'string' || value[key].trim() === '') {
      throw new CliError('INVALID_RESULT', `${key} must be a non-empty string`);
    }
  }
  for (const key of ['changedFiles', 'checks', 'acceptance', 'limitations']) {
    stringArray(value[key], key);
  }
  return {
    outcome: value.outcome.trim(),
    changedFiles: [...new Set(value.changedFiles)].sort(),
    selfReview: value.selfReview.trim(),
    checks: value.checks,
    acceptance: value.acceptance,
    limitations: value.limitations,
    nextStep: value.nextStep.trim(),
  };
}

function assertBoundAttempt(task, attempt, options) {
  if (attempt !== latestAttempt(task) || attempt.status !== 'active') {
    throw new CliError(
      'STALE_ATTEMPT',
      `Attempt ${attempt.number} is not the active attempt for ${task.id}`,
    );
  }
  const handle = required(options, 'handle');
  if (!attempt.handle || attempt.handle !== handle) {
    throw new CliError('STALE_WORKER', 'Worker handle does not match the bound active worker');
  }
}

export function report(root, options, { draft = false } = {}) {
  const owner = required(options, 'owner');
  return withLock(root, owner, () => {
    const state = readState(root);
    assertOwner(state, owner);
    const task = getTask(state, required(options, 'task'));
    const attempt = getAttempt(task, required(options, 'attempt'));
    assertBoundAttempt(task, attempt, options);
    const result = readResultFile(required(options, 'result-file'));
    if (draft) {
      if (state.mode !== 'review')
        throw new CliError('MODE_MISMATCH', 'draft is only valid in review mode');
      const head = gitText(attempt.worktree, ['rev-parse', 'HEAD']);
      if (head !== attempt.baseSha)
        throw new CliError(
          'COMMIT_FORBIDDEN',
          'Review-mode draft must remain at its assigned base commit',
        );
      const files = changedWorktreePaths(attempt.worktree);
      const violations = files.filter(
        (file) => !task.scope.some((scope) => file === scope || file.startsWith(`${scope}/`)),
      );
      if (violations.length)
        throw new CliError('SCOPE_VIOLATION', 'Draft changes paths outside its scope', violations);
      if (JSON.stringify(files) !== JSON.stringify(result.changedFiles)) {
        throw new CliError(
          'RESULT_MISMATCH',
          'Draft changedFiles do not match the retained worktree',
          { expected: files, reported: result.changedFiles },
        );
      }
      attempt.result = result;
      attempt.scopeFiles = files;
      attempt.status = 'drafted';
      attempt.draftedAt = now();
      task.status = 'drafted';
      atomicWrite(root, state);
      return {
        ok: true,
        command: 'draft',
        task: task.id,
        attempt: attempt.number,
        status: task.status,
      };
    }
    if (state.mode !== 'autonomous') {
      throw new CliError(
        'MODE_MISMATCH',
        'Committed worker reports are disabled in review mode; use draft',
      );
    }
    const commit = required(options, 'commit');
    const branchSha = gitText(root, ['rev-parse', `refs/heads/${attempt.branch}`]);
    if (branchSha !== commit)
      throw new CliError('COMMIT_MISMATCH', `Branch head is ${branchSha}, report says ${commit}`);
    assertWorktreeAt(root, attempt.worktree, commit);
    if (!isAncestor(root, attempt.baseSha, commit) || commit === attempt.baseSha) {
      throw new CliError(
        'INVALID_COMMIT',
        'Worker commit must descend from and differ from its base',
      );
    }
    const files = diffPaths(root, attempt.baseSha, commit);
    const touchedHistory = historyPaths(root, attempt.baseSha, commit);
    const violations = touchedHistory.filter(
      (file) =>
        !task.scope.some(
          (scope) => pathOverlaps(file, scope) && (file === scope || file.startsWith(`${scope}/`)),
        ),
    );
    if (violations.length)
      throw new CliError(
        'SCOPE_VIOLATION',
        'Worker commit changes paths outside its scope',
        violations,
      );
    if (JSON.stringify(files) !== JSON.stringify(result.changedFiles)) {
      throw new CliError('RESULT_MISMATCH', 'Result changedFiles do not match Git diff', {
        expected: files,
        reported: result.changedFiles,
      });
    }
    attempt.reportedSha = commit;
    attempt.result = result;
    attempt.scopeFiles = files;
    attempt.historyScopeFiles = touchedHistory;
    attempt.status = 'reported';
    attempt.reportedAt = now();
    task.status = 'reported';
    atomicWrite(root, state);
    return {
      ok: true,
      command: 'report',
      task: task.id,
      attempt: attempt.number,
      commit,
      files,
      done: false,
    };
  });
}

export function runChecks(root, options) {
  const owner = required(options, 'owner');
  return withLock(root, owner, () => {
    const state = readState(root);
    assertOwner(state, owner);
    const task = getTask(state, required(options, 'task'));
    if (!Array.isArray(task.checks) || task.checks.length === 0)
      throw new CliError('CHECK_NOT_ALLOWED', 'Нет зарегистрированных проверок для выполнения.');
    const commands = task.checks.map((command) => registeredHostCheck(command, task.scope));
    const attempt = getAttempt(task, required(options, 'attempt'));
    if (attempt !== latestAttempt(task))
      throw new CliError('STALE_ATTEMPT', 'Checks require the latest task attempt');
    const phase = required(options, 'phase');
    let target;
    if (phase === 'worker') {
      if (attempt.status !== 'reported' || !attempt.reportedSha) {
        throw new CliError('REPORT_REQUIRED', 'A verified worker report is required first');
      }
      target = {
        sha: attempt.reportedSha,
        worktree: attempt.worktree,
        checks: attempt.checks.worker,
      };
    } else if (phase === 'candidate') {
      const candidate = latestCandidate(task);
      if (
        !candidate ||
        candidate.status !== 'built' ||
        candidate.attemptNumber !== attempt.number
      ) {
        throw new CliError(
          'CANDIDATE_REQUIRED',
          'A current integration candidate for this attempt is required',
        );
      }
      target = { sha: candidate.sha, worktree: candidate.worktree, checks: candidate.checks };
    } else {
      throw new CliError('INVALID_ARGUMENT', '--phase must be worker or candidate');
    }
    assertWorktreeAt(root, target.worktree, target.sha);
    const checkRun = { sha: target.sha, startedAt: now(), commands: [], status: 'running' };
    target.checks.push(checkRun);
    atomicWrite(root, state);
    const logDirectory = path.join(pathsFor(root).logs, task.id.toLowerCase());
    mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
    for (let index = 0; index < commands.length; index += 1) {
      const argv = commands[index];
      const result = run(argv[0], argv.slice(1), {
        cwd: target.worktree,
        timeout: task.checkTimeoutMs,
        allowFailure: true,
        env: {
          PATH: '/usr/bin:/bin',
          HOME: '/var/empty',
          CI: 'true',
          LC_ALL: 'C',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_OPTIONAL_LOCKS: '0',
        },
      });
      const logPath = path.join(
        logDirectory,
        `${attempt.number}-${phase}-${Date.now()}-${index + 1}.log`,
      );
      writeFileSync(logPath, `${result.stdout}${result.stderr}`, { mode: 0o600 });
      let integrityError = null;
      try {
        assertWorktreeAt(root, target.worktree, target.sha);
      } catch (error) {
        integrityError = { code: error.code ?? 'CHECK_MUTATED_WORKTREE', message: error.message };
      }
      const passed = result.status === 0 && !result.error && !integrityError;
      checkRun.commands.push({
        argv,
        status: result.status,
        signal: result.signal,
        error: result.error,
        integrityError,
        logPath,
        passed,
      });
      if (!passed) break;
    }
    checkRun.finishedAt = now();
    checkRun.status =
      checkRun.commands.length === task.checks.length &&
      checkRun.commands.every((entry) => entry.passed)
        ? 'passed'
        : 'failed';
    atomicWrite(root, state);
    return {
      ok: checkRun.status === 'passed',
      command: 'check',
      task: task.id,
      attempt: attempt.number,
      phase,
      sha: target.sha,
      status: checkRun.status,
      logs: checkRun.commands.map((entry) => entry.logPath),
      checks: checkRun.commands,
      exitCode: checkRun.status === 'passed' ? 0 : 2,
    };
  });
}
