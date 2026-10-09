import type { WorkflowController } from '../workflow-controller-types';
import { EvidenceList, NodeDetails } from '../ExecutionDetails';
import { humanText, nodeTitle } from '../presentation';
import { statusLabel } from '../ui-copy';
import { getCapability } from '../ui-controls';

export function DiagnosticNodes({ controller: c, evidence }: { controller: WorkflowController; evidence: boolean }) {
  const node = c.selectedNode;
  const actionLabels: Record<string,string> = { run:c.labels.run, retry:c.labels.retry, rerunCheck:c.labels.rerunCheck, recover:c.labels.recover,
    approve:c.labels.approve, accept:c.labels.accept, reject:c.labels.reject, requestReplan:c.labels.replan };
  const denied = Object.entries(node?.capabilities ?? {}).filter(([name, capability]) => name in actionLabels && !capability.allowed && capability.reason);
  return <section aria-label={c.locale === 'ru' ? 'Этапы исполнения' : 'Execution steps'}>
    <div className="diagnostic-node-picker">
      <label>{c.locale === 'ru' ? 'Выбранный этап' : 'Selected step'}
        <select data-testid="diagnostic-node-select" value={node?.id ?? ''} onChange={event => c.selectDiagnosticNode(event.target.value)}>
          <option value="" disabled>{c.labels.selectNode}</option>
          {c.diagnosticNodes.map(item => <option key={item.id} value={item.id}>{nodeTitle(item, c.locale)} · {statusLabel(item.status, c.locale, item.resolutionKind)}{item.sourceRunId ? ' · history' : ''}</option>)}
        </select>
      </label>
      <button className="game-text-action" type="button" disabled={!c.currentNodeId} onClick={() => { if (c.currentNodeId) c.selectDiagnosticNode(c.currentNodeId); }}>{c.locale === 'ru' ? 'Текущий этап' : 'Current step'}</button>
    </div>
    {node && <p className="diagnostic-node-identity"><code>{node.id}</code>{node.sourceRunId && <> · {c.locale === 'ru' ? 'Исходный запуск' : 'Owner run'}: <code>{node.sourceRunId}</code></>}</p>}
    {evidence ? <EvidenceList node={node} planning={node?.sourceRunId ? [] : c.snapshot?.planningArtifacts ?? []} locale={c.locale}
      onReceipt={c.openReceipt} onArtifact={c.openArtifact} /> : node ? <>
      <fieldset className="diagnostic-node-details" disabled={c.busy || Boolean(c.pending) || c.snapshotUnavailable} data-testid="diagnostic-node-details" data-node-id={node.id}>
        <NodeDetails node={node} locale={c.locale} busy={c.busy} onAction={action => void c.execute(action, node.id)}
          onGate={() => { const gate = c.snapshot?.gates.find(item => item.nodeId === node.id); if (gate) c.openGate(gate); }}
          onReplan={c.requestReplan} replanLabel={getCapability(node.capabilities, 'requestReplan').label ?? c.labels.replan} />
      </fieldset>
      {denied.length > 0 && <details className="diagnostic-denied"><summary>{c.locale === 'ru' ? 'Почему некоторые действия недоступны' : 'Why some actions are unavailable'}</summary>
        <dl>{denied.map(([name, capability]) => <div key={name}><dt>{actionLabels[name]}</dt><dd>{humanText(capability.reason,c.locale)}</dd></div>)}</dl>
      </details>}
      <button className="game-text-action" type="button" onClick={() => c.setDiagnosticPage('evidence')}>{c.locale === 'ru' ? 'Отчеты выбранного этапа' : 'Selected step evidence'}</button>
    </> : <p>{c.labels.selectNode}</p>}
  </section>;
}
