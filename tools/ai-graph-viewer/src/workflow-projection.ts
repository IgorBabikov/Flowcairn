import type { GraphNodeSnapshot, Snapshot } from './contracts';

/** Сохраненный анализ отображается со ссылками на исходный запуск, не меняя план. */
export function workflowProjection(snapshot: Snapshot): Snapshot {
  if (snapshot.workflow !== 'autonomous' || snapshot.phase !== 'execution') return snapshot;
  const analysis = snapshot.workflowProgress?.find(item => item.action === 'ai-analyze' && item.sourceRunId !== snapshot.runId);
  const approval = snapshot.nodes.find(node => node.id === 'approve-plan');
  if (!analysis || !approval || analysis.status !== 'passed' || !analysis.receiptIds.length) return snapshot;
  const id = `history-${analysis.sourceRunId}-${analysis.nodeId}`;
  const historical: GraphNodeSnapshot = {
    id, title: analysis.title, outcome: analysis.outcome ?? 'Анализ сохранен в предыдущей версии задачи', needs: [],
    action: {id: analysis.action, kind: 'ai'}, status: analysis.status, mode: 'read', permissions: [],
    skills: [], attempt: analysis.attempt ?? 0, startedAt: null, finishedAt: null, durationMs: analysis.durationMs ?? null, reason: null,
    receiptIds: analysis.receiptIds, artifacts: analysis.artifacts, changedFiles: [], checks: [],
    capabilities: {openReceipt:{allowed:true,reason:null}},
    sourceRunId: analysis.sourceRunId, sourcePlanHash: analysis.planHash,
  };
  return {...snapshot, nodes:[historical,...snapshot.nodes.map(node => node.id === approval.id
    ? {...node,title:'План работы',needs:[...node.needs,id]} : node)],
    edges:[{id:`${id}--${approval.id}`,source:id,target:approval.id},...snapshot.edges]};
}
