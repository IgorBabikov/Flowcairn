import { existsSync } from 'node:fs';
import path from 'node:path';
import { CliError } from './orchestrator-task-contract.mjs';
import { required } from './orchestrator-arguments.mjs';
import { readState, withLock, atomicWrite, assertOwner, getTask, getAttempt, latestAttempt, latestCandidate, pathsFor, branchSlug, taskReference } from './orchestrator-registry.mjs';
import { git, gitText, assertWorktreeAt, assertMergeHooksReady, assertIntegrationRoot, isAncestor, diffPaths, integrationRef } from './orchestrator-repository.mjs';

// A candidate must retain exact worker/check/review SHA evidence before integration.
const now = () => new Date().toISOString();

function completeCandidate(root, state, task, attempt, integration) {
  const branchExists =
    git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${integration.branch}`], {
      allowFailure: true,
    }).status === 0;
  const worktreeExists = existsSync(integration.worktree);
  if (!branchExists && worktreeExists) {
    throw new CliError(
      'CANDIDATE_INCONSISTENT',
      `Candidate worktree exists without branch: ${integration.worktree}`,
    );
  }
  if (!branchExists) {
    git(root, [
      'worktree',
      'add',
      '-b',
      integration.branch,
      integration.worktree,
      integration.baseSha,
    ]);
  } else if (!worktreeExists) {
    git(root, ['worktree', 'add', integration.worktree, integration.branch]);
  }
  const checkedOutBranch = gitText(integration.worktree, ['branch', '--show-current']);
  if (checkedOutBranch !== integration.branch) {
    throw new CliError(
      'CANDIDATE_INCONSISTENT',
      `Candidate worktree is on ${checkedOutBranch || '(detached)'}`,
    );
  }
  let candidateSha = gitText(integration.worktree, ['rev-parse', 'HEAD']);
  if (candidateSha === integration.baseSha) {
    assertWorktreeAt(root, integration.worktree, integration.baseSha);
    assertMergeHooksReady(integration.worktree);
    const fastForward = isAncestor(root, integration.baseSha, attempt.reportedSha);
    const message = `chore(tooling): интегрировал задачу ${task.id.toLowerCase()}\n\nRefs: ${taskReference(task.id)}`;
    const merge = git(
      integration.worktree,
      fastForward
        ? ['merge', '--ff-only', attempt.reportedSha]
        : ['merge', '--no-ff', attempt.reportedSha, '-m', message],
      { allowFailure: true },
    );
    if (merge.status !== 0) {
      integration.status = 'conflicted';
      integration.conflictedAt = now();
      integration.conflict = { stdout: merge.stdout, stderr: merge.stderr };
      atomicWrite(root, state);
      return {
        ok: false,
        command: 'candidate',
        task: task.id,
        status: 'conflicted',
        branch: integration.branch,
        worktree: integration.worktree,
        exitCode: 2,
      };
    }
    candidateSha = gitText(integration.worktree, ['rev-parse', 'HEAD']);
  }
  assertWorktreeAt(root, integration.worktree, candidateSha);
  if (
    !isAncestor(root, integration.baseSha, candidateSha) ||
    !isAncestor(root, attempt.reportedSha, candidateSha)
  ) {
    throw new CliError(
      'CANDIDATE_INCONSISTENT',
      'Candidate does not contain its recorded base and Worker commit',
    );
  }
  const files = diffPaths(root, integration.baseSha, candidateSha);
  const violations = files.filter(
    (file) => !task.scope.some((scope) => file === scope || file.startsWith(`${scope}/`)),
  );
  if (violations.length) {
    integration.status = 'scope-violating';
    integration.scopeViolations = violations;
    atomicWrite(root, state);
    throw new CliError(
      'SCOPE_VIOLATION',
      'Candidate imports changes outside task scope',
      violations,
    );
  }
  integration.sha = candidateSha;
  integration.status = 'built';
  integration.builtAt = now();
  integration.scopeFiles = files;
  atomicWrite(root, state);
  return {
    ok: true,
    command: 'candidate',
    task: task.id,
    attempt: attempt.number,
    candidate: integration,
  };
}

export function candidate(root, options) {
  const owner = required(options, 'owner');
  const taskId = required(options, 'task');
  const attemptNumber = required(options, 'attempt');
  return withLock(root, owner, () => {
    const state = readState(root);
    assertOwner(state, owner);
    if (state.mode !== 'autonomous')
      throw new CliError('MODE_MISMATCH', 'candidate is disabled in review mode');
    assertIntegrationRoot(root);
    const task = getTask(state, taskId);
    const attempt = getAttempt(task, attemptNumber);
    if (attempt !== latestAttempt(task) || attempt.status !== 'reported') {
      throw new CliError('REPORT_REQUIRED', 'Latest attempt must have a verified report');
    }
    if (
      attempt.checks.worker.at(-1)?.status !== 'passed' ||
      attempt.checks.worker.at(-1)?.sha !== attempt.reportedSha
    ) {
      throw new CliError('CHECK_REQUIRED', 'Worker checks must pass at the reported SHA');
    }
    const previous = latestCandidate(task);
    if (previous?.status === 'built' && previous.attemptNumber === attempt.number) {
      throw new CliError('CANDIDATE_EXISTS', `Current candidate already exists: ${previous.sha}`);
    }
    if (previous?.status === 'creating' && previous.attemptNumber === attempt.number) {
      return completeCandidate(root, state, task, attempt, previous);
    }
    if (previous?.status === 'conflicted' && previous.attemptNumber === attempt.number) {
      const dirty = gitText(previous.worktree, [
        'status',
        '--porcelain=v1',
        '--untracked-files=all',
      ]);
      if (dirty || gitText(previous.worktree, ['rev-parse', 'HEAD']) === previous.baseSha) {
        throw new CliError(
          'CONFLICT_UNRESOLVED',
          `Resolve and commit the retained candidate before retrying: ${previous.worktree}`,
        );
      }
      previous.status = 'creating';
      previous.reconciliationStartedAt = now();
      atomicWrite(root, state);
      return completeCandidate(root, state, task, attempt, previous);
    }
    const baseSha = gitText(root, ['rev-parse', integrationRef(root)]);
    if (!isAncestor(root, attempt.baseSha, baseSha)) {
      throw new CliError(
        'DEVELOP_DIVERGED',
        'Worker base is no longer an ancestor of the integration branch; retry from the current tip',
      );
    }
    const revision = task.candidates.length + 1;
    const integration = {
      revision,
      branch: `codex/integrate-${branchSlug(task.id)}-${attempt.number}-r${revision}`,
      worktree: path.join(
        pathsFor(root).worktrees,
        `integrate-${branchSlug(task.id)}-${attempt.number}-r${revision}`,
      ),
      baseSha,
      workerSha: attempt.reportedSha,
      attemptNumber: attempt.number,
      sha: null,
      status: 'creating',
      creatingAt: now(),
      checks: [],
      reviews: [],
    };
    if (
      existsSync(integration.worktree) ||
      git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${integration.branch}`], {
        allowFailure: true,
      }).status === 0
    ) {
      throw new CliError(
        'ARTIFACT_EXISTS',
        `Refusing to reuse integration artifact ${integration.branch}`,
      );
    }
    task.candidates.push(integration);
    atomicWrite(root, state);
    return completeCandidate(root, state, task, attempt, integration);
  });
}

export function review(root, options) {
  const owner = required(options, 'owner');
  return withLock(root, owner, () => {
    const state = readState(root);
    assertOwner(state, owner);
    const task = getTask(state, required(options, 'task'));
    const attempt = getAttempt(task, required(options, 'attempt'));
    if (attempt !== latestAttempt(task))
      throw new CliError('STALE_ATTEMPT', 'Review requires the latest task attempt');
    const integration = latestCandidate(task);
    if (
      !integration ||
      integration.status !== 'built' ||
      integration.attemptNumber !== attempt.number
    ) {
      throw new CliError('CANDIDATE_REQUIRED', 'A current candidate for this attempt is required');
    }
    const commit = required(options, 'commit');
    if (commit !== integration.sha)
      throw new CliError('STALE_REVIEW', `Review must target current candidate ${integration.sha}`);
    if (
      integration.checks.at(-1)?.status !== 'passed' ||
      integration.checks.at(-1)?.sha !== integration.sha
    ) {
      throw new CliError('CHECK_REQUIRED', 'Candidate checks must pass before review is recorded');
    }
    assertWorktreeAt(root, integration.worktree, integration.sha);
    const reviewer = required(options, 'reviewer');
    if (reviewer === attempt.worker || reviewer === attempt.handle) {
      throw new CliError(
        'REVIEW_NOT_INDEPENDENT',
        'Reviewer must differ from the Worker identity and handle',
      );
    }
    const verdict = required(options, 'verdict');
    if (!['pass', 'fail'].includes(verdict))
      throw new CliError('INVALID_ARGUMENT', '--verdict must be pass or fail');
    const receipt = {
      reviewer,
      commit,
      verdict,
      summary: required(options, 'summary'),
      reviewedAt: now(),
    };
    integration.reviews.push(receipt);
    atomicWrite(root, state);
    return {
      ok: verdict === 'pass',
      command: 'review',
      task: task.id,
      attempt: attempt.number,
      review: receipt,
      exitCode: verdict === 'pass' ? 0 : 2,
    };
  });
}

function assertCandidateAccepted(root, task, attempt, integration) {
  if (integration.workerSha !== attempt.reportedSha || !attempt.reportedSha) {
    throw new CliError(
      'INTEGRATION_INVALID',
      'Candidate Worker SHA does not match the verified report',
    );
  }
  if (!integration.sha || !isAncestor(root, integration.workerSha, integration.sha)) {
    throw new CliError(
      'INTEGRATION_INVALID',
      'Candidate does not contain the verified Worker commit',
    );
  }
  if (
    integration.checks.at(-1)?.status !== 'passed' ||
    integration.checks.at(-1)?.sha !== integration.sha
  ) {
    throw new CliError('CHECK_REQUIRED', 'Candidate checks must pass at the exact candidate SHA');
  }
  const acceptedReview = integration.reviews.at(-1);
  if (
    !acceptedReview ||
    acceptedReview.verdict !== 'pass' ||
    acceptedReview.commit !== integration.sha
  ) {
    throw new CliError(
      'REVIEW_REQUIRED',
      'Latest independent review must pass at the exact candidate SHA',
    );
  }
  assertWorktreeAt(root, integration.worktree, integration.sha);
}

export function integrate(root, options) {
  const owner = required(options, 'owner');
  return withLock(root, owner, () => {
    const state = readState(root);
    assertOwner(state, owner);
    if (state.mode !== 'autonomous')
      throw new CliError('MODE_MISMATCH', 'integrate is disabled in review mode');
    assertIntegrationRoot(root);
    const task = getTask(state, required(options, 'task'));
    const attempt = getAttempt(task, required(options, 'attempt'));
    if (attempt !== latestAttempt(task) || !['reported', 'integrated'].includes(attempt.status)) {
      throw new CliError('STALE_ATTEMPT', 'Integration requires the latest reported attempt');
    }
    const integration = latestCandidate(task);
    if (
      !integration ||
      integration.attemptNumber !== attempt.number ||
      !['built', 'merged'].includes(integration.status)
    ) {
      throw new CliError('CANDIDATE_REQUIRED', 'A current candidate is required');
    }
    assertCandidateAccepted(root, task, attempt, integration);
    const currentDevelop = gitText(root, ['rev-parse', integrationRef(root)]);
    if (currentDevelop === integration.sha) {
      integration.status = 'merged';
      integration.mergedAt = integration.mergedAt ?? now();
      task.status = 'done';
      attempt.status = 'integrated';
      task.merge = {
        candidateSha: integration.sha,
        workerSha: integration.workerSha,
        developSha: currentDevelop,
        verifiedAt: now(),
        recovered: true,
      };
      atomicWrite(root, state);
      return {
        ok: true,
        command: 'integrate',
        task: task.id,
        done: true,
        recovered: true,
        developSha: currentDevelop,
      };
    }
    if (integration.status !== 'built')
      throw new CliError(
        'INTEGRATION_INVALID',
        'Recorded merged candidate is no longer at the integration branch',
      );
    if (currentDevelop !== integration.baseSha) {
      integration.status = 'invalidated';
      integration.invalidatedAt = now();
      integration.invalidatedReason = `Integration branch moved from ${integration.baseSha} to ${currentDevelop}`;
      atomicWrite(root, state);
      return {
        ok: false,
        command: 'integrate',
        task: task.id,
        status: 'invalidated',
        reason: integration.invalidatedReason,
        exitCode: 2,
      };
    }
    git(root, ['merge', '--ff-only', integration.sha]);
    const verified = gitText(root, ['rev-parse', integrationRef(root)]);
    if (verified !== integration.sha || !isAncestor(root, integration.workerSha, verified)) {
      throw new CliError(
        'INTEGRATION_INVALID',
        'Fast-forward did not produce the verified candidate ancestry',
      );
    }
    assertIntegrationRoot(root);
    integration.status = 'merged';
    integration.mergedAt = now();
    task.status = 'done';
    attempt.status = 'integrated';
    task.merge = {
      candidateSha: integration.sha,
      workerSha: integration.workerSha,
      developSha: verified,
      verifiedAt: now(),
      recovered: false,
    };
    atomicWrite(root, state);
    return {
      ok: true,
      command: 'integrate',
      task: task.id,
      done: true,
      recovered: false,
      developSha: verified,
    };
  });
}
