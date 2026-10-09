import { isReadApiError } from '../api';
import { ErrorNotice } from '../ui-controls';
import type { WorkflowController } from '../workflow-controller-types';

export function RuntimeNotices({ controller: c }: { controller: WorkflowController }) {
  return <div className="rpg-runtime-notices">
    {c.stopError && <ErrorNotice error={c.stopError} labels={c.labels} pending={c.interruptPending}
      busy={c.stopBusy} onDismiss={() => c.setStopError(null)} onRetry={() => {
        if (c.interruptPending) void c.sendInterrupt(c.interruptPending);
        else if (c.selectedRunId) void c.refreshSnapshot(c.selectedRunId, false);
      }} />}
    {c.displayedError && <ErrorNotice error={c.displayedError} labels={c.labels} pending={c.pending}
      busy={c.busy} onRetry={() => c.pending ? void c.sendOperation(c.pending) : void c.load()}
      onDismiss={() => c.error ? c.setError(null) : isReadApiError(c.displayedError) && c.clearReadError(c.displayedError.readResource)} />}
    {c.notice && <p role="status">{c.notice}</p>}
  </div>;
}
