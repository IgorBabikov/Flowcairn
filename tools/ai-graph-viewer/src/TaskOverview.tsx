import type { GateSnapshot, GraphPlan, Snapshot } from './contracts';
import type { ProofEvidence } from './proof-contracts';
import type { ExecutionPresentation } from './execution-presentation';
import { CollapsibleText } from './CollapsibleText';
import { ExecutionStatus } from './ExecutionStatus';
import { TaskCockpit } from './TaskCockpit';
import { WorkflowPanel } from './WorkflowPanel';

type TaskOverviewActions = {
  onApprove: (gate: GateSnapshot) => void;
  onRevise: (feedback: string) => void;
  onStart: () => void;
  onSetup: () => void;
  onOpenEvidence: (evidence: ProofEvidence, artifactId?: string) => void;
  onOpenArtifact: (artifactId: string) => void;
  onAcceptRequirement?: (requirementId: string, reason: string) => void;
};

const proofLabels = {
  PROVEN: 'Результат подтвержден',
  UNPROVEN: 'Результат пока не подтвержден',
  STALE: 'Нужна повторная проверка',
  FAILED: 'Обнаружена проблема',
  BLOCKED: 'Работа заблокирована',
  RUNNING: 'Работа продолжается',
};

export function TaskOverview({
  snapshot,
  plan,
  busy,
  unavailable = false,
  execution,
  feedback,
  onFeedbackChange,
  actions,
}: {
  snapshot: Snapshot;
  plan: GraphPlan | null;
  busy: boolean;
  unavailable?: boolean;
  execution: ExecutionPresentation;
  feedback: string;
  onFeedbackChange: (value: string) => void;
  actions: TaskOverviewActions;
}) {
  const title = snapshot.task?.title || snapshot.task?.goal || 'Задача';
  const description = snapshot.task?.description || snapshot.task?.goal || '';
  const status = unavailable || !snapshot.integrity.valid
    ? 'Состояние недоступно'
    : snapshot.proof
      ? proofLabels[snapshot.proof.status]
      : execution.kind === 'idle'
        ? 'Подготовка задачи'
        : execution.title;
  return (
    <article className="task-overview" aria-label="Обзор задачи">
      <header className="task-heading">
        {snapshot.task?.taskNumber && <p className="task-number">{snapshot.task.taskNumber}</p>}
        <div className="task-heading-line">
          <h2>{title}</h2>
          <span className="proof-status" data-testid="task-proof-status">{status}</span>
        </div>
        {description && description !== title && (
          <CollapsibleText id={`task-description-${snapshot.runId}`} text={description} />
        )}
        <details className="task-technical">
          <summary>Технические детали</summary>
          <dl>
            <dt>Версия плана</dt><dd data-testid="plan-version">{snapshot.planVersion ?? '—'}</dd>
            <dt>Ревизия</dt><dd data-testid="run-revision">{snapshot.revision ?? '—'}</dd>
            <dt>План</dt><dd><code>{snapshot.planHash?.slice(0, 10) ?? '—'}</code></dd>
          </dl>
        </details>
      </header>
      <ExecutionStatus value={execution} />
      {snapshot.proof ? (
        <TaskCockpit
          snapshot={snapshot}
          busy={busy}
          unavailable={unavailable}
          embedded
          onOpenEvidence={actions.onOpenEvidence}
          onOpenArtifact={actions.onOpenArtifact}
          onAcceptRequirement={actions.onAcceptRequirement}
        />
      ) : (
        <WorkflowPanel
          snapshot={snapshot}
          plan={plan}
          busy={busy}
          stateUnavailable={unavailable}
          embedded
          feedbackValue={feedback}
          onFeedbackChange={onFeedbackChange}
          onApprove={actions.onApprove}
          onRevise={actions.onRevise}
          onStart={actions.onStart}
          onSetup={actions.onSetup}
        />
      )}
    </article>
  );
}
