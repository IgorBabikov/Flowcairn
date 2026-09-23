import { useState } from 'react';
import type { GateSnapshot, GraphPlan, Snapshot } from './contracts';
import type { ProofEvidence } from './proof-contracts';
import type { ExecutionPresentation } from './execution-presentation';
import { CollapsibleText } from './CollapsibleText';
import { ExecutionStatus } from './ExecutionStatus';
import { TaskCockpit } from './TaskCockpit';
import { TaskProgress } from './TaskProgress';
import { WorkflowPanel } from './WorkflowPanel';
import { WideTaskContext } from './WideTaskContext';
import { WideWorkList } from './WideWorkList';
import { planDecision } from './PlanDecision';
import { taskStatusLabel } from './task-presentation';

export type TaskOverviewActions = {
  onApprove: (gate: GateSnapshot) => void;
  onRevise: (feedback: string) => void;
  onStart: () => void;
  onSetup: () => void;
  onClarify: () => void;
  onReplan: () => void;
  onRecover: (nodeId?: string) => void;
  onOpenEvidence: (evidence: ProofEvidence, artifactId?: string) => void;
  onOpenArtifact: (artifactId: string) => void;
  onAcceptRequirement?: (requirementId: string, reason: string) => void;
  onOpenTechnical: (nodeId?: string) => void;
};


export function TaskOverview({
  snapshot,
  wide = false,
  contextOpen,
  onContextChange,
  feedbackOpen,
  onFeedbackToggle,
  plan,
  busy,
  unavailable = false,
  execution,
  feedback,
  onFeedbackChange,
  actions,
}: {
  wide?: boolean;
  contextOpen: boolean;
  onContextChange: (open: boolean) => void;
  feedbackOpen?: boolean;
  onFeedbackToggle?: (open: boolean) => void;
  snapshot: Snapshot;
  plan: GraphPlan | null;
  busy: boolean;
  unavailable?: boolean;
  execution: ExecutionPresentation;
  feedback: string;
  onFeedbackChange: (value: string) => void;
  actions: TaskOverviewActions;
}) {
  const [selectedWorkId, setSelectedWorkId] = useState<string | null>(null);
  const { gate } = planDecision(snapshot, plan, unavailable);
  const showContext = wide && (!snapshot.proof || Boolean(gate));
  const selectWork = (id: string) => { setSelectedWorkId(id); onContextChange(true); };
  const title = snapshot.task?.title || snapshot.task?.goal || 'Задача';
  const description = snapshot.task?.description || snapshot.task?.goal || '';
  const executionFocused = !unavailable && snapshot.integrity.valid && !snapshot.proof && execution.kind !== 'idle';
  const status = taskStatusLabel(snapshot, execution, unavailable);
  return (
    <article className={`task-overview${wide ? ' is-wide' : ''}${showContext && contextOpen ? ' with-context' : ''}`} aria-label="Обзор задачи">
      {!wide && <header className="task-heading">
        {snapshot.task?.taskNumber && <p className="task-number">{snapshot.task.taskNumber}</p>}
        <div className="task-heading-line">
          <h2>{title}</h2>
          <span className={`proof-status${!unavailable && snapshot.integrity.valid && status === execution.title ? ' visually-hidden' : ''}`} data-testid="task-proof-status">{status}</span>
        </div>
        <details className="task-description"><summary>Описание задачи</summary>
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
        </details>
      </header>}

      <div className="task-content-layout"><div className="task-content-primary">
      {!unavailable && snapshot.integrity.valid && <ExecutionStatus value={execution} />}
      {(execution.kind === 'stop-uncertain' || snapshot.proof?.status === 'STALE') && <div className="task-next-action">
        {execution.kind === 'stop-uncertain' && !unavailable && snapshot.integrity.valid &&
          (snapshot.capabilities.recover?.allowed || snapshot.nodes.some(node => node.capabilities.recover?.allowed))
          ? <button className="button primary" type="button" disabled={busy}
              onClick={() => actions.onRecover(snapshot.capabilities.recover?.allowed ? undefined : snapshot.nodes.find(node => node.capabilities.recover?.allowed)?.id)}>Проверить остановку</button>
          : <><p>{unavailable ? 'Дождитесь обновления состояния. Действия временно недоступны.'
              : execution.kind === 'stop-uncertain' ? 'Откройте этап и его отчеты, чтобы проверить причину. Новый запуск пока небезопасен.'
              : 'Прежние доказательства устарели. Откройте этап и доступные действия для повторной проверки.'}</p>
            <button className="button" type="button" onClick={() => actions.onOpenTechnical()}>Открыть этап и отчеты</button></>}
      </div>}
      {snapshot.status === 'cancelled' && <div className="context-recovery">
        <p>Предыдущий процесс завершен. Новый план начнет отдельную подтверждаемую попытку.</p>
        <button className="button primary" type="button" disabled={busy || !snapshot.capabilities.requestReplan?.allowed}
          onClick={actions.onReplan}>Подготовить новый план</button>
      </div>}
      {snapshot.status === 'failed' && snapshot.capabilities.requestReplan?.allowed && <div className="context-recovery">
        <p>Ошибка сохранена в отчете. Новая версия плана начнет отдельную попытку без повторного использования неизвестного результата.</p>
        <button className="button primary" type="button" disabled={busy}
          onClick={actions.onReplan}>Повторить с новым планом</button>
      </div>}
      {snapshot.contextClarification && <div className="context-recovery">
        <p>Уточните файлы и папки задачи, чтобы продолжить анализ.</p>
        <button className="button primary" type="button" disabled={busy || !snapshot.capabilities.requestReplan?.allowed}
          onClick={actions.onClarify}>Уточнить контекст</button>
      </div>}
      {executionFocused && !(wide && gate) ? (
        <><TaskProgress snapshot={snapshot} execution={execution} summaryOnly={wide} />
          {wide && <WideWorkList snapshot={snapshot} plan={plan} selectedId={selectedWorkId} onSelect={selectWork} />}</>
      ) : snapshot.proof && !(wide && gate) ? (
        <TaskCockpit
          snapshot={snapshot}
          wide={wide}
          busy={busy}
          unavailable={unavailable}
          embedded
          onOpenEvidence={actions.onOpenEvidence}
          onOpenArtifact={actions.onOpenArtifact}
          onAcceptRequirement={actions.onAcceptRequirement}
        />
      ) : (
        <WorkflowPanel
          wide={wide}
          selectedWorkId={selectedWorkId}
          onSelectWork={selectWork}
          feedbackOpen={feedbackOpen}
          onFeedbackToggle={onFeedbackToggle}
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
      </div>
      {showContext && contextOpen && <WideTaskContext snapshot={snapshot} plan={plan} selectedId={selectedWorkId} unavailable={unavailable}
        onBack={() => setSelectedWorkId(null)} onClose={() => onContextChange(false)} onOpenWork={actions.onOpenTechnical} />}
      </div>
    </article>
  );
}
