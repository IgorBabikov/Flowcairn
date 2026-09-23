import type { GraphPlan, Snapshot, GateSnapshot } from './contracts';

export function planDecision(snapshot: Snapshot, plan: GraphPlan | null, unavailable = false) {
  const gate = snapshot.gates.find(item => item.type === 'provider-consent') ?? snapshot.gates.find(item => item.type === 'approve-plan');
  const gateNode = snapshot.nodes.find(node => node.id === gate?.nodeId);
  const reviewable = !unavailable && Boolean(plan && gate && snapshot.integrity.valid && gate.planHash === snapshot.planHash);
  return { gate, gateNode, reviewable };
}

export function PlanDecision({ snapshot, plan, unavailable, busy, feedback, onApprove }: {
  snapshot: Snapshot;
  plan: GraphPlan | null;
  unavailable: boolean;
  busy: boolean;
  feedback: string;
  onApprove: (gate: GateSnapshot) => void;
}) {
  const { gate, gateNode, reviewable } = planDecision(snapshot, plan, unavailable);
  if (!gate) return null;
  return <div className="plan-primary-action">
    <button className="button primary approve-workflow" type="button"
      disabled={busy || !reviewable || !gateNode?.capabilities.approve?.allowed || (gate.type !== 'provider-consent' && Boolean(feedback.trim()))}
      onClick={() => onApprove(gate)}>{gate.type === 'provider-consent' ? 'Разрешить передачу' : 'Согласовать и начать выполнение'}</button>
    {feedback.trim() && <p className="field-hint">Сначала обновите план с вашими правками.</p>}
    {!plan && <p role="status">Проверяем сохраненный план…</p>}
  </div>;
}
