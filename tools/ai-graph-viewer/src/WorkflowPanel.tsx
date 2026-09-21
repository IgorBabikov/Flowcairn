import { useState } from 'react';
import type { GateSnapshot, GraphPlan, Snapshot } from './contracts';
import { humanText, nodeTitle, runtimeProblem, StatusIcon } from './presentation';

/** Пользователь видит только подтвержденное исполнителем состояние. */
export function WorkflowPanel({ snapshot, plan, busy, stateUnavailable = false, onApprove, onRevise, onStart, onSetup }: {
  snapshot: Snapshot;
  plan: GraphPlan | null;
  busy: boolean;
  stateUnavailable?: boolean;
  onApprove: (gate: GateSnapshot) => void;
  onRevise: (feedback: string) => void;
  onStart: () => void;
  onSetup: () => void;
}) {
  const [feedback, setFeedback] = useState('');
  const gate = snapshot.gates.find(item => item.type === 'provider-consent') ?? snapshot.gates.find(item => item.type === 'approve-plan');
  const gateNode = snapshot.nodes.find(node => node.id === gate?.nodeId);
  const approved = Boolean(snapshot.nodes.find(node => node.id === 'approve-plan' && node.status === 'passed'));
  const executionDone = snapshot.status === 'passed' && snapshot.completion === 'ready-for-review';
  const done = !stateUnavailable && snapshot.integrity.valid && executionDone && !snapshot.failureReason && (!snapshot.proof || snapshot.proof.status === 'PROVEN');
  const awaitingProof = snapshot.integrity.valid && executionDone && Boolean(snapshot.proof) && !done;
  const readyWithoutGate = snapshot.status === 'ready' && !gate;
  const waitingToStart = snapshot.phase === 'planning' && readyWithoutGate;
  const unavailableRawReason = readyWithoutGate && snapshot.capabilities.run?.allowed === false
    ? (snapshot.runner?.ai.available === false ? snapshot.runner.ai.reason : snapshot.capabilities.run.reason)
    : null;
  const unavailableReason = humanText(unavailableRawReason) || (unavailableRawReason ? 'Исполнитель сейчас недоступен.' : null);
  const blocked = stateUnavailable || Boolean(snapshot.failureReason || unavailableReason) || ['failed', 'uncertain', 'stale'].includes(snapshot.status) || !snapshot.integrity.valid;
  const current = snapshot.nodes.find(node => node.id === snapshot.activeNodeId) ?? snapshot.nodes.find(node => ['failed', 'uncertain', 'running'].includes(node.status));
  const problem = runtimeProblem(snapshot.failureReason || unavailableRawReason || current?.reason || snapshot.integrity.reason);
  const reviewable = !stateUnavailable && Boolean(plan && gate && snapshot.integrity.valid && gate.planHash === snapshot.planHash);
  const changes = [...new Set(snapshot.nodes.flatMap(node => node.changedFiles))];
  const checks = snapshot.nodes.flatMap(node => node.checks.map(check => ({ ...check, nodeId: node.id, receiptIds: node.receiptIds })));
  return <section className="workflow-panel" aria-label="План и результат">
    <h2>{done ? 'Готово к вашему ревью' : blocked ? problem?.title ?? 'Работа приостановлена' : awaitingProof ? 'Осталось доказать результат' : gate?.type === 'provider-consent' ? 'Согласие на передачу данных' : gate ? 'План работы' : approved ? 'Выполняем задачу' : 'Разбираемся в задаче'}</h2>
    <p className="workflow-summary" role="status">{done
      ? snapshot.proof ? 'Все обязательные требования подтверждены. Откройте доказательства и результаты работы.' : 'Реализация и проверки завершены. Проверьте изменения, затем создайте коммит и PR.'
      : stateUnavailable ? 'Текущее состояние недоступно. Дождитесь успешного обновления перед продолжением.'
      : blocked ? (problem?.summary ?? humanText(snapshot.failureReason || unavailableReason || current?.reason || snapshot.integrity.reason)) || 'Откройте отчеты этапа: продолжение требует проверки.'
      : awaitingProof ? 'Этапы исполнения завершены. Откройте требования: для завершения задачи нужны актуальные доказательства каждого обязательного результата.'
      : gate?.type === 'provider-consent' ? 'Проверьте, какие данные могут быть переданы выбранному AI. Без согласия передача не начнется.'
      : gate ? 'Проверьте шаги и границы изменений. Можно дополнить план перед разработкой.'
      : approved ? 'Реализация, проверки и исправления пройдут автоматически. Можно вернуться к результату позже.'
      : waitingToStart ? 'Анализ еще не начался. Начните работу, чтобы получить план для согласования.'
      : 'Изучаем проект и требования. Затем покажем план для согласования.'}</p>
    {blocked && problem && <section className="workflow-problem" role="alert">
      <strong>Что делать дальше</strong>
      <p>{problem.action}</p>
      {unavailableReason && <p><button className="button compact" type="button" onClick={onSetup}>Настройки проекта</button></p>}
    </section>}
    {unavailableReason && !problem && <div className="workflow-start-help">
      <p>Проверьте выбранный AI-клиент в настройках проекта. После исправления установки перезапустите flowcairn.</p>
      <button className="button" type="button" onClick={onSetup}>Настройки проекта</button>
    </div>}
    {waitingToStart && !blocked && snapshot.capabilities.run?.allowed &&
      <button className="button primary" type="button" disabled={busy} onClick={onStart}>Начать анализ</button>}
    {current && !done && !blocked && <p className="current-stage"><StatusIcon status={current.status} /><span>{nodeTitle(current, 'ru')}</span></p>}
    <ol className="workflow-steps">
      {snapshot.nodes.filter(node => node.action.kind !== 'gate').map(node => <li key={node.id}>
        <StatusIcon status={node.status} />
        <div><strong>{nodeTitle(node, 'ru')}</strong><p>{node.status === 'passed' ? 'Результат: ' : 'Ожидаемый результат: '}{node.outcome}</p></div>
      </li>)}
    </ol>
    {gate && <>
      <section className="plan-boundaries">
        <h3>{gate.type === 'provider-consent' ? 'Границы передачи' : 'Границы изменений'}</h3>
        <ul className="path-list">{gate.scope.map(path => <li key={path}><code>{path}</code></li>)}</ul>
        {gate.risks.length > 0 && <><h3>На что обратить внимание</h3><ul>{gate.risks.map(risk => <li key={risk}>{humanText(risk)}</li>)}</ul></>}
        <p>{humanText(gate.consequences.approve)}</p>
      </section>
      {gate.type !== 'provider-consent' && snapshot.capabilities.revisePlan?.allowed && <form className="plan-feedback" onSubmit={event => {
        event.preventDefault();
        if (feedback.trim() && !busy && reviewable) onRevise(feedback.trim());
      }}>
        <label htmlFor="plan-feedback">Что дополнить или исправить?</label>
        <textarea id="plan-feedback" value={feedback} maxLength={4000} disabled={busy}
          onChange={event => setFeedback(event.target.value)} />
        <button className="button" type="submit" disabled={!feedback.trim() || busy || !reviewable}>Обновить план</button>
      </form>}
      <button className="button primary approve-workflow" type="button" disabled={busy || !reviewable || !gateNode?.capabilities.approve?.allowed || (gate.type !== 'provider-consent' && Boolean(feedback.trim()))}
        onClick={() => onApprove(gate)}>{gate.type === 'provider-consent' ? 'Разрешить передачу' : 'Согласен'}</button>
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
      <h3>{snapshot.delivery.mode === 'direct' ? 'Результат в текущем проекте' : 'Рабочая копия с результатом'}</h3>
      <p>{snapshot.delivery.mode === 'direct'
        ? 'Изменения уже находятся в папке проекта. Просмотрите их перед коммитом и PR.'
        : 'Откройте эту папку внутри проекта в редакторе для личного ревью, коммита и PR.'}</p>
      <code>{snapshot.delivery.workspacePath}</code>
    </section>}
    {(done || approved) && <>
      {changes.length > 0 && <><h3>Измененные файлы</h3><ul className="path-list">{changes.map(path => <li key={path}><code>{path}</code></li>)}</ul></>}
      {checks.length > 0 && <><h3>Проверки</h3><ul className="result-checks">{checks.map((check, index) => {
        const proof = snapshot.proof;
        const evidence = proof?.evidence.filter(item => item.method === 'check' && item.nodeId === check.nodeId &&
          item.runId === snapshot.runId && item.receiptId && check.receiptIds.includes(item.receiptId)).at(-1);
        const unavailable = stateUnavailable || !snapshot.integrity.valid || (proof && !proof.resultHash);
        const stale = proof && (check.inputHash !== proof.resultHash || evidence?.freshness === 'stale');
        const unconfirmed = proof && (!evidence || !['passed', 'failed'].includes(evidence.status));
        const passed = check.passed && (!proof || evidence?.status === 'passed');
        const status = unavailable || unconfirmed && !stale ? 'uncertain' : stale ? 'stale' : passed ? 'passed' : 'failed';
        const label = unavailable ? 'актуальность не подтверждена' : stale ? 'устарела, нужна перепроверка' : unconfirmed ? 'результат не подтвержден' : passed ? 'пройдена' : 'не пройдена';
        return <li key={`${check.id}-${index}`}><StatusIcon status={status} /><span>{check.id}: {label}</span></li>;
      })}</ul></>}
    </>}
  </section>;
}
