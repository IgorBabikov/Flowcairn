import { TaskClarification } from '../TaskClarification';
import { operationId } from '../control-operations';
import type { WorkflowController } from '../workflow-controller-types';
import { QuestScroll } from './QuestScroll';
import { RuntimeNotices } from './RuntimeNotices';

export function QuestClarification({ controller: c, onClose }: { controller: WorkflowController; onClose: () => void }) {
  const snapshot = c.clarifying;
  if (!snapshot) return null;
  return <QuestScroll title="Уточнить поручение" onClose={onClose} footer={<button type="button" className="game-secondary" onClick={() => c.setClarifying(null)}>Вернуться к плану</button>}>
    <RuntimeNotices controller={c} />
    <TaskClarification key={`${snapshot.runId}:${snapshot.planHash}:${snapshot.revision}`} snapshot={snapshot} busy={c.busy || Boolean(c.pending)} onClose={() => c.setClarifying(null)}
      onSubmit={(contextSelection, feedback) => {
        if (c.busy || c.pending || !snapshot.planHash || snapshot.revision == null) return;
        const id = operationId('replan');
        void c.sendOperation({ kind: 'control', key: `${snapshot.runId}:replan`, operationId: id, runId: snapshot.runId, action: 'replan',
          request: { operationId: id, expectedRevision: snapshot.revision, planHash: snapshot.planHash, contextSelection, ...(feedback ? { feedback } : {}) } });
      }} />
  </QuestScroll>;
}
