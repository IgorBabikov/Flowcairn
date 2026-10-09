import type { GraphPlan, Snapshot } from './contracts';
import { nodeTitle } from './presentation';

const methodLabels = { check: 'Выполнение проверки', 'source-review': 'Проверка исходных данных', human: 'Личная приемка' };

/** The plan's explicit criteria, not a claim that the work is already verified. */
export function PlanRequirements({ snapshot, plan, unavailable = false }: { snapshot: Snapshot; plan: GraphPlan | null; unavailable?: boolean }) {
  const contract = plan?.taskContract ?? snapshot.proof?.contract;
  if (unavailable || !snapshot.integrity.valid) return <p role="status">Критерии будут доступны после обновления состояния.</p>;
  return <section className="plan-requirements" aria-label="Критерии плана">
    <h3>Что должно получиться</h3>
    {contract?.requirements.length ? <ol>{contract.requirements.map(requirement => <li key={requirement.id}>
      <strong>{requirement.title}</strong>
      <p>{requirement.mandatory ? 'Обязательное требование' : 'Необязательное улучшение'}</p>
      {requirement.verification.criterion.trim() !== requirement.title.trim() && <p>{requirement.verification.criterion}</p>}
      <dl>
        <dt>Как проверяется</dt><dd>{methodLabels[requirement.verification.method]}
          {requirement.verification.method === 'check' && <>: {requirement.verification.checkIds.join(', ') || 'конкретные проверки не указаны'}</>}</dd>
        <dt>Связанная работа</dt><dd>{requirement.workIds.length ? <ul>{requirement.workIds.map(id => {
          const node = snapshot.nodes.find(item => item.id === id);
          return <li key={id}>{node ? nodeTitle(node, 'ru') : 'Работа не найдена в текущем плане'} · <code>{id}</code></li>;
        })}</ul> : 'Связанные работы не указаны'}</dd>
        {requirement.verification.paths.length > 0 && <><dt>Файлы проверки</dt><dd>{requirement.verification.paths.map(path => <div key={path}><code>{path}</code></div>)}</dd></>}
      </dl>
    </li>)}</ol> : <>
      <p>Способ проверки не указан. Контракт требований пока не передан; исходные критерии не являются доказательством выполнения.</p>
      <h4>Исходные критерии задачи</h4>
      {snapshot.task?.acceptance.length ? <ol>{snapshot.task.acceptance.map((criterion,index) => <li key={index}>{criterion}</li>)}</ol>
        : <p>Исходные критерии задачи не переданы.</p>}
    </>}
  </section>;
}
