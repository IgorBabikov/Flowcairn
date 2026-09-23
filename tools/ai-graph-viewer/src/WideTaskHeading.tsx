import type { GraphPlan, Snapshot } from './contracts';
import type { ExecutionPresentation } from './execution-presentation';
import type { TaskOverviewActions } from './TaskOverview';
import { taskStatusLabel } from './task-presentation';
import { PlanDecision, planDecision } from './PlanDecision';

export function WideTaskHeading({ snapshot, plan, execution, unavailable, busy, feedback, actions, onFeedback }: {
  snapshot: Snapshot; plan: GraphPlan | null; execution: ExecutionPresentation; unavailable: boolean;
  busy: boolean; feedback: string; actions: TaskOverviewActions; onFeedback: () => void;
}) {
  const { gate, reviewable } = planDecision(snapshot, plan, unavailable);
  const label = gate && !unavailable && snapshot.integrity.valid && snapshot.status === 'waiting-for-human'
    ? gate.type === 'provider-consent' ? 'Нужно согласие на передачу данных' : 'План ожидает согласования'
    : taskStatusLabel(snapshot, execution, unavailable);
  return <div className="wide-task-heading">
    <div className="wide-heading-copy">
      <p className="task-number">{snapshot.task?.taskNumber ?? snapshot.task?.id ?? 'Задача'}</p>
      <h2>{snapshot.task?.title || snapshot.task?.goal || 'Задача'}</h2>
      <span className="proof-status" data-testid="task-proof-status">{label}</span>
    </div>
    <div className="wide-heading-decision">
      {gate && gate.type !== 'provider-consent' && snapshot.capabilities.revisePlan?.allowed &&
        <button className="button" type="button" disabled={busy || !reviewable} onClick={onFeedback}>Предложить изменения</button>}
      <PlanDecision snapshot={snapshot} plan={plan} unavailable={unavailable} busy={busy} feedback={feedback} onApprove={actions.onApprove} />
    </div>
  </div>;
}
