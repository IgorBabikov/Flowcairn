import type { GraphNodeSnapshot, GraphPlan, Snapshot } from './contracts';
import { nodeTitle, StatusIcon } from './presentation';
import { statusLabel } from './ui-copy';

export function workRequirements(node: GraphNodeSnapshot, snapshot: Snapshot, plan: GraphPlan | null) {
  return (snapshot.proof?.contract?.requirements ?? plan?.taskContract?.requirements ?? []).filter(item => item.workIds.includes(node.id));
}

export function workVerification(node: GraphNodeSnapshot, snapshot: Snapshot, plan: GraphPlan | null) {
  const linked = workRequirements(node, snapshot, plan);
  if (!linked.length) return 'Способ проверки не указан';
  const labels: Record<string, string> = { tests: 'Тесты', typecheck: 'Проверка типов', lint: 'Проверка стиля кода', build: 'Сборка' };
  const methods = [...new Set(linked.flatMap(item => item.verification.method === 'check'
    ? item.verification.checkIds.length ? item.verification.checkIds.map(id => labels[id] ?? id) : ['Проверка проекта']
    : [item.verification.method === 'human' ? 'Личная приемка' : 'Проверка исходников']))];
  return methods.join(' · ');
}

export function WideWorkList({ snapshot, plan, selectedId, onSelect }: {
  snapshot: Snapshot; plan: GraphPlan | null; selectedId: string | null; onSelect: (id: string) => void;
}) {
  const work = snapshot.nodes.filter(node => node.action.kind !== 'gate');
  return <div className="wide-work-list" role="group" aria-label="Шаги плана">
    <div className="wide-work-columns" aria-hidden="true"><span>Работа</span><span>Ожидаемый результат</span><span>Проверка</span></div>
    {!work.length && <p className="empty-copy">План работы еще не сформирован.</p>}
    {work.map((node, index) => <button className="wide-work-row" type="button" key={node.id}
      data-active={node.status === 'running' ? 'true' : undefined} aria-pressed={selectedId === node.id} aria-label={`Шаг ${index + 1}: ${nodeTitle(node, 'ru')}`}
      onClick={() => onSelect(node.id)}>
      <span className="wide-work-name"><span className="wide-work-number">{String(index + 1).padStart(2, '0')}</span>
        <span><strong>{nodeTitle(node, 'ru')}</strong><small><StatusIcon status={node.status} />{statusLabel(node.status, 'ru')}</small></span></span>
      <span className="wide-work-outcome">{node.outcome || 'Результат этапа еще не описан'}</span>
      <span className="wide-work-verification">{workVerification(node, snapshot, plan)}</span>
    </button>)}
  </div>;
}
