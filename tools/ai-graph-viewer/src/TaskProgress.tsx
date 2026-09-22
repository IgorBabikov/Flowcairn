import type { Snapshot } from './contracts';
import type { ExecutionPresentation } from './execution-presentation';
import { nodeTitle, StatusIcon } from './presentation';

function activeNodeIndex(snapshot: Snapshot) {
  const explicit = snapshot.nodes.findIndex(node => node.id === snapshot.activeNodeId);
  if (explicit >= 0) return explicit;
  return snapshot.nodes.findIndex(node => ['running', 'failed', 'uncertain', 'waiting-for-human', 'ready'].includes(node.status));
}

export function TaskProgress({
  snapshot,
  execution,
}: {
  snapshot: Snapshot;
  execution: ExecutionPresentation;
}) {
  const work = snapshot.nodes.filter(node => node.action.kind !== 'gate');
  const completed = work.filter(node => node.status === 'passed').length;
  const sourceIndex = activeNodeIndex(snapshot);
  const activeId = sourceIndex >= 0 ? snapshot.nodes[sourceIndex]?.id : undefined;
  const currentIndex = Math.max(0, work.findIndex(node => node.id === activeId));
  const visible = execution.kind === 'stopping' || execution.kind === 'stop-uncertain'
    ? work.slice(currentIndex, currentIndex + 1)
    : work.slice(currentIndex, currentIndex + 4);

  if (work.length === 0) return null;

  return (
    <section className="task-progress" aria-labelledby="task-progress-heading">
      <div className="task-progress-head">
        <div>
          <h3 id="task-progress-heading">
            {execution.kind === 'stopping' ? 'Текущий этап' : 'Что происходит сейчас'}
          </h3>
          <p>{completed} из {work.length} этапов завершено по данным исполнителя</p>
        </div>
        <span className="task-progress-count" aria-hidden="true">{completed}/{work.length}</span>
      </div>
      <div
        className="task-progress-track"
        role="progressbar"
        aria-label="Завершенные этапы"
        aria-valuemin={0}
        aria-valuemax={work.length}
        aria-valuenow={completed}
      >
        {work.map(node => <i key={node.id} data-complete={node.status === 'passed' ? 'true' : undefined} />)}
      </div>
      <ol className="task-progress-steps">
        {visible.map((node, index) => (
          <li key={node.id} data-current={node.id === activeId || (index === 0 && sourceIndex < 0) ? 'true' : undefined}>
            <span className="task-step-mark"><StatusIcon status={node.status} /></span>
            <div>
              <strong>{nodeTitle(node, 'ru')}</strong>
              <p>{node.outcome}</p>
            </div>
          </li>
        ))}
      </ol>
      {currentIndex + visible.length < work.length && execution.kind !== 'stopping' && execution.kind !== 'stop-uncertain' && (
        <p className="task-progress-more">Далее еще {work.length - currentIndex - visible.length} этапа</p>
      )}
    </section>
  );
}
