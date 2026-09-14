import { useState } from 'react';
import type { GateSnapshot, GraphPlan, Snapshot } from './contracts';
import { humanText, nodeTitle, StatusIcon } from './presentation';

/** Пользователь видит только подтвержденное исполнителем состояние. */
export function WorkflowPanel({ snapshot, plan, busy, onApprove, onRevise }: {
  snapshot: Snapshot;
  plan: GraphPlan | null;
  busy: boolean;
  onApprove: (gate: GateSnapshot) => void;
  onRevise: (feedback: string) => void;
}) {
  const [feedback, setFeedback] = useState('');
  const gate = snapshot.gates.find(item => item.type === 'approve-plan');
  const gateNode = snapshot.nodes.find(node => node.id === gate?.nodeId);
  const approved = Boolean(snapshot.nodes.find(node => node.id === 'approve-plan' && node.status === 'passed'));
  const done = snapshot.integrity.valid && snapshot.status === 'passed' && snapshot.completion === 'ready-for-review' && !snapshot.failureReason;
  const blocked = Boolean(snapshot.failureReason) || ['failed', 'uncertain', 'stale'].includes(snapshot.status) || !snapshot.integrity.valid;
  const current = snapshot.nodes.find(node => node.id === snapshot.activeNodeId) ?? snapshot.nodes.find(node => ['failed', 'uncertain', 'running'].includes(node.status));
  const reviewable = Boolean(plan && gate && snapshot.integrity.valid && gate.planHash === snapshot.planHash);
  const changes = [...new Set(snapshot.nodes.flatMap(node => node.changedFiles))];
  const checks = snapshot.nodes.flatMap(node => node.checks);
  return <section className="workflow-panel" aria-label="План и результат">
    <h2>{done ? 'Готово к вашему ревью' : blocked ? 'Работа приостановлена' : gate ? 'План работы' : approved ? 'Выполняем задачу' : 'Разбираемся в задаче'}</h2>
    <p className="workflow-summary" role="status">{done
      ? 'Реализация и проверки завершены. Проверьте изменения, затем создайте коммит и PR.'
      : blocked ? humanText(snapshot.failureReason || current?.reason || snapshot.integrity.reason) || 'Откройте отчеты этапа: продолжение требует проверки.'
      : gate ? 'Проверьте шаги и границы изменений. Можно дополнить план перед разработкой.'
      : approved ? 'Реализация, проверки и исправления пройдут автоматически. Можно вернуться к результату позже.'
      : 'Изучаем проект и требования. Затем покажем план для согласования.'}</p>
    {current && !done && !blocked && <p className="current-stage"><StatusIcon status={current.status} /><span>{nodeTitle(current, 'ru')}</span></p>}
    <ol className="workflow-steps">
      {snapshot.nodes.filter(node => node.action.kind !== 'gate').map(node => <li key={node.id}>
        <StatusIcon status={node.status} />
        <div><strong>{nodeTitle(node, 'ru')}</strong><p>{node.status === 'passed' ? 'Результат: ' : 'Ожидаемый результат: '}{node.outcome}</p></div>
      </li>)}
    </ol>
    {gate && <>
      <section className="plan-boundaries">
        <h3>Границы изменений</h3>
        <ul className="path-list">{gate.scope.map(path => <li key={path}><code>{path}</code></li>)}</ul>
        {gate.risks.length > 0 && <><h3>На что обратить внимание</h3><ul>{gate.risks.map(risk => <li key={risk}>{humanText(risk)}</li>)}</ul></>}
        <p>{humanText(gate.consequences.approve)}</p>
      </section>
      {snapshot.capabilities.revisePlan?.allowed && <form className="plan-feedback" onSubmit={event => {
        event.preventDefault();
        if (feedback.trim() && !busy && reviewable) onRevise(feedback.trim());
      }}>
        <label htmlFor="plan-feedback">Что дополнить или исправить?</label>
        <textarea id="plan-feedback" value={feedback} maxLength={4000} disabled={busy}
          onChange={event => setFeedback(event.target.value)} />
        <button className="button" type="submit" disabled={!feedback.trim() || busy || !reviewable}>Обновить план</button>
      </form>}
      <button className="button primary approve-workflow" type="button" disabled={busy || !reviewable || !gateNode?.capabilities.approve?.allowed || Boolean(feedback.trim())}
        onClick={() => onApprove(gate)}>Согласен</button>
      {feedback.trim() && <p className="field-hint">Сначала обновите план с вашими правками.</p>}
      {!plan && <p role="status">Проверяем сохраненный план…</p>}
      <details className="plan-technical"><summary>Права и подтверждение</summary>
        <p>Чтение: {gate.readPaths?.join(', ') || 'не указано'}</p>
        <p>Права: {gate.requiredPermissions.join(', ') || 'не указаны'}</p>
        <p>Инструкции: {[...new Set(snapshot.nodes.flatMap(node => node.skills.map(skill => skill.id)))].join(', ')}</p>
        <p>Версия плана: {snapshot.planVersion}</p><code>{gate.planHash}</code>
      </details>
    </>}
    {done && snapshot.delivery && <section className="plan-boundaries">
      <h3>Рабочая копия с результатом</h3>
      <p>Откройте эту папку внутри проекта в редакторе для личного ревью, коммита и PR.</p>
      <code>{snapshot.delivery.workspacePath}</code>
    </section>}
    {(done || approved) && <>
      {changes.length > 0 && <><h3>Измененные файлы</h3><ul className="path-list">{changes.map(path => <li key={path}><code>{path}</code></li>)}</ul></>}
      {checks.length > 0 && <><h3>Проверки</h3><ul className="result-checks">{checks.map((check, index) => <li key={`${check.id}-${index}`}><StatusIcon status={check.passed ? 'passed' : 'failed'} /><span>{check.id}: {check.passed ? 'пройдена' : 'не пройдена'}</span></li>)}</ul></>}
    </>}
  </section>;
}
