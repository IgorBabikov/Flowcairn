import type { GateSnapshot, GraphPlan, Snapshot } from './contracts';
import type { ProofEvidence } from './proof-contracts';
import type { ExecutionPresentation } from './execution-presentation';
import { CollapsibleText } from './CollapsibleText';
import { ExecutionStatus } from './ExecutionStatus';
import { TaskCockpit } from './TaskCockpit';
import { TaskProgress } from './TaskProgress';
import { WorkflowPanel } from './WorkflowPanel';

type TaskOverviewActions = {
  onApprove: (gate: GateSnapshot) => void;
  onRevise: (feedback: string) => void;
  onStart: () => void;
  onSetup: () => void;
  onClarify: () => void;
  onOpenEvidence: (evidence: ProofEvidence, artifactId?: string) => void;
  onOpenArtifact: (artifactId: string) => void;
  onAcceptRequirement?: (requirementId: string, reason: string) => void;
  onOpenTechnical: () => void;
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
  const executionFocused = !snapshot.proof && execution.kind !== 'idle';
  const status = unavailable || !snapshot.integrity.valid
    ? 'Состояние недоступно'
    : snapshot.status === 'uncertain' && snapshot.resolutionKind === 'semantic'
      ? 'Нужно уточнение'
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
      {snapshot.contextClarification && <div className="context-recovery">
        <p>Уточните файлы и папки задачи, чтобы продолжить анализ.</p>
        <button className="button primary" type="button" disabled={busy || !snapshot.capabilities.requestReplan?.allowed}
          onClick={actions.onClarify}>Уточнить контекст</button>
      </div>}
      {executionFocused ? (
        <TaskProgress snapshot={snapshot} execution={execution} />
      ) : snapshot.proof ? (
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
      <footer className="task-overview-footer">
        <button className="technical-view-link" type="button" aria-label="Граф · детали исполнения" onClick={actions.onOpenTechnical}>
          <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20">
            <circle cx="5" cy="18" r="2" /><circle cx="12" cy="6" r="2" /><circle cx="19" cy="18" r="2" />
            <path d="M6.4 16.4 10.8 8M13.2 8l4.4 8.4M7 18h10" />
          </svg>
          Граф и технические детали
        </button>
      </footer>
    </article>
  );
}
