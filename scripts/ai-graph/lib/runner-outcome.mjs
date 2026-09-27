/** A graceful child exit never cancels a supervisor failure or an operator stop. */
export function runnerOutcome({ final, controlFailure = null, controlTimedOut = false, aborted = false }) {
  const failureReason = aborted ? 'ABORTED'
    : controlTimedOut && final?.failureReason === 'PARENT_DISCONNECTED' ? 'TIMEOUT'
      : final?.failureReason ?? controlFailure?.code ?? controlFailure?.message ?? null;
  const exitCode = controlFailure ? 1 : final?.exitCode ?? null;
  return { exitCode: failureReason && exitCode === 0 ? 1 : exitCode, failureReason,
    timedOut: failureReason === 'TIMEOUT', outputLimit: failureReason === 'OUTPUT_LIMIT' };
}
