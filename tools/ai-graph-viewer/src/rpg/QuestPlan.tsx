import { useEffect, useState } from 'react';
import { PlanRequirements } from '../PlanRequirements';
import { planDecision } from '../PlanDecision';
import { humanText, nodeTitle } from '../presentation';
import { statusLabel } from '../ui-copy';
import { taskStatusLabel } from '../task-presentation';
import type { WorkflowController } from '../workflow-controller-types';
import { learningRun } from '../learning/learning-projection';
import { QuestScroll } from './QuestScroll';
import { RuntimeNotices } from './RuntimeNotices';

export function QuestPlan({ controller: c, onClose, onReports, onWork, onLearning }: { controller: WorkflowController; onClose: () => void; onReports: () => void; onWork: () => void; onLearning: () => void }) {
  const s = c.snapshot;
  const decision = s ? planDecision(s, c.plan, c.snapshotUnavailable) : null;
  const gate = decision?.gate;
  const [now, setNow] = useState(Date.now);
  const [requestedStart, setRequestedStart] = useState(false);
  useEffect(() => {
    if (requestedStart && c.execution.kind === 'running' && !c.busy && !c.pending) onWork();
  }, [requestedStart, c.execution.kind, c.busy, c.pending, onWork]);
  useEffect(() => {
    if (!gate) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, Math.min(2147483647, gate.expiresAt - Date.now() + 10)));
    return () => window.clearTimeout(timer);
  }, [gate]);
  const expired = Boolean(gate && gate.expiresAt <= now);
  const locked = c.busy || Boolean(c.pending) || c.snapshotUnavailable;
  const status = s ? taskStatusLabel(s, c.execution, c.snapshotUnavailable) : 'Загружаем поручение…';
  const title = gate?.type === 'provider-consent' ? 'Разрешение на передачу' : gate ? 'План поручения' : 'Поручение';
  const footer = gate ? <button className="game-primary" type="button"
    disabled={locked || expired || !decision?.reviewable || !decision?.gateNode?.capabilities.approve?.allowed || (gate.type !== 'provider-consent' && Boolean(c.planFeedbackDraft.trim()))}
    onClick={() => { setRequestedStart(true); c.overviewActions.onApprove(gate); }}>{c.busy ? 'Отправляем решение…' : gate.type === 'provider-consent' ? 'Разрешить передачу' : 'Согласовать и начать выполнение'}</button>
    : s?.capabilities.run?.allowed && s.phase === 'planning' && s.status === 'ready' ? <button className="game-primary" type="button" disabled={locked || !s.integrity.valid || Boolean(s.failureReason)} onClick={() => { setRequestedStart(true); c.overviewActions.onStart(); }}>Начать анализ</button>
    : <button className="game-primary" type="button" onClick={onReports}>Открыть отчеты и требования</button>;
  return <QuestScroll title={title} onClose={onClose} footer={footer}>
    <RuntimeNotices controller={c} />
    <p className="quest-state" role="status">{status}</p>
    {s && <>
      {learningRun(s) && <button className="game-text-action" type="button" onClick={onLearning}>Карта этапов и разбор</button>}
      <h3>{s.task?.title || s.task?.goal}</h3>
      {s.task?.description && <details><summary>Исходное поручение</summary><p>{s.task.description}</p></details>}
      {expired && <p className="quest-warning" role="alert">Разрешение истекло. Проверьте актуальный план.
        <button className="game-text-action" type="button" onClick={() => void c.refreshSnapshot(s.runId)}>Обновить состояние</button></p>}
      {(s.failureReason || s.integrity.reason) && <p className="quest-warning" role="alert">{humanText(s.failureReason || s.integrity.reason)}</p>}
      {s.proof && <p>{c.snapshotUnavailable || !s.integrity.valid ? 'Актуальность результата не подтверждена.' : `Подтверждено ${s.proof.coverage.proven} из ${s.proof.coverage.required} обязательных требований.`}</p>}
      {s.proof && s.proof.blockers.length > 0 && <details open={['FAILED', 'BLOCKED', 'STALE'].includes(s.proof.status)}><summary>Что требует внимания</summary>
        <ul>{s.proof.blockers.map((reason, index) => <li key={index}>{humanText(reason)}</li>)}</ul>
      </details>}
      {gate?.type === 'approve-plan' && <PlanRequirements snapshot={s} plan={c.plan} unavailable={c.snapshotUnavailable} />}
      <ol className="quest-plan-list">{s.nodes.filter(node => node.action.kind !== 'gate').map(node => <li key={node.id}>
        <strong>{nodeTitle(node, 'ru')}</strong><p>{node.outcome}</p><span>{statusLabel(node.status, 'ru', node.resolutionKind)}</span>
        {node.checks.length > 0 && <p>Проверки: {node.checks.map(check => check.id).join(', ')}</p>}
      </li>)}</ol>
      {gate && <>
        <h3>{gate.type === 'provider-consent' ? 'Какие данные передаем' : 'Границы изменений'}</h3>
        <ul className="quest-paths">{gate.scope.map(path => <li key={path}><code>{path}</code></li>)}</ul>
        <p>{humanText(gate.consequences.approve)}</p>
        <details><summary>Права, риски и версия</summary>
          <p>Чтение: {gate.readPaths?.join(', ') || 'не указано'}</p>
          <p>Разрешения: {gate.requiredPermissions.join(', ') || 'не указаны'}</p>
          {gate.risks.map((risk, index) => <p key={index}>{humanText(risk)}</p>)}
          <p>Версия плана: {s.planVersion}</p><code>{gate.planHash}</code>
          <p>Инструкции: {[...new Set(s.nodes.flatMap(node => node.skills.map(skill => skill.id)))].join(', ') || 'не указаны'}</p>
        </details>
        {gate.type !== 'provider-consent' && s.capabilities.revisePlan?.allowed && <details open={Boolean(c.planFeedbackDraft.trim()) || undefined}><summary>Предложить изменение плана</summary>
          <form className="quest-feedback" onSubmit={event => { event.preventDefault(); if (c.planFeedbackDraft.trim() && decision?.reviewable && !locked) c.overviewActions.onRevise(c.planFeedbackDraft.trim()); }}>
            <label htmlFor="quest-feedback">Что дополнить или исправить?</label><textarea id="quest-feedback" value={c.planFeedbackDraft} maxLength={4000} disabled={locked}
              onChange={event => c.setPlanFeedbackDraft(event.target.value)} />
            <button className="game-secondary" type="submit" disabled={locked || !decision?.reviewable || !c.planFeedbackDraft.trim()}>Обновить план</button>
          </form></details>}
      </>}
      {!gate && s.capabilities.requestReplan?.allowed && <button className="game-secondary" type="button" disabled={locked} onClick={c.overviewActions.onReplan}>Подготовить новый план</button>}
      {(s.capabilities.recover?.allowed || s.nodes.some(node => node.capabilities.recover?.allowed)) && <button className="game-secondary" type="button" disabled={locked}
        onClick={() => c.overviewActions.onRecover(s.capabilities.recover?.allowed ? undefined : s.nodes.find(node => node.capabilities.recover?.allowed)?.id)}>Проверить состояние</button>}
      {s.contextClarification && <button className="game-secondary" type="button" disabled={locked || !s.capabilities.requestReplan?.allowed} onClick={c.overviewActions.onClarify}>Уточнить контекст</button>}
      {s.capabilities.stop?.allowed && <button className="game-secondary" type="button" disabled={c.stopBusy || c.isStopping} onClick={() => void c.execute('stop')}>{c.stopBusy || c.isStopping ? 'Останавливаем…' : 'Остановить выполнение'}</button>}
    </>}
  </QuestScroll>;
}
