import type { GraphPlan, Snapshot } from './contracts';
import { humanText, nodeTitle } from './presentation';
import { statusLabel } from './ui-copy';
import { workVerification, workRequirements } from './WideWorkList';
import { CollapsibleText } from './CollapsibleText';

export function WideTaskContext({ snapshot, plan, selectedId, unavailable, onBack, onClose, onOpenWork }: {
  snapshot: Snapshot; plan: GraphPlan | null; selectedId: string | null; unavailable: boolean;
  onBack: () => void; onClose: () => void; onOpenWork: (nodeId: string) => void;
}) {
  const node = snapshot.nodes.find(item => item.id === selectedId);
  const gate = snapshot.gates.find(item => item.type === 'provider-consent') ?? snapshot.gates.find(item => item.type === 'approve-plan');
  const contract = snapshot.proof?.contract ?? plan?.taskContract;
  const requirements = contract?.requirements;
  const scope = gate?.scope ?? contract?.scope ?? snapshot.task?.scope ?? [];
  return <aside className="wide-task-context" aria-label="Контекст задачи">
    <header><div><p className="wide-eyebrow">КОНТЕКСТ ЗАДАЧИ</p><h3>{node ? 'Детали этапа' : 'Критерии и границы'}</h3></div>
      <button className="button quiet" type="button" onClick={onClose}>Закрыть контекст</button>
    </header>
    <div className="wide-context-body">
      {unavailable || !snapshot.integrity.valid ? <p role="status">Текущее состояние недоступно. Дождитесь обновления данных.</p> : <>
        {node ? <>
          <button className="text-button wide-context-back" type="button" onClick={onBack}>К критериям задачи</button>
          <h4>{nodeTitle(node, 'ru')}</h4><p className="wide-stage-status">{statusLabel(node.status, 'ru')}</p>
          <section><h4>Ожидаемый результат</h4><p>{node.outcome}</p></section>
          <section><h4>Как проверяется</h4><p>{workVerification(node, snapshot, plan)}</p><p className="field-hint">Статус этапа сам по себе не подтверждает выполнение требования.</p></section>
          {workRequirements(node, snapshot, plan).length > 0 && <section><h4>Связанные критерии</h4><ul>{workRequirements(node, snapshot, plan).map(item => <li key={item.id}>{item.title}</li>)}</ul></section>}
          <section><h4>Файлы этапа</h4>{node.resources?.writes.length ? <ul className="path-list">{node.resources.writes.map(path => <li key={path}><code>{path}</code></li>)}</ul> : <p>Пути для записи не переданы.</p>}</section>
          <button className="button" type="button" onClick={() => onOpenWork(node.id)}>Открыть отчеты этапа</button>
        </> : <section>
          <h4>Что должно получиться</h4>
          {requirements?.length ? <ol className="wide-criteria-list">{requirements.map(item => <li key={item.id}><strong>{item.title}</strong>{item.verification.criterion.trim() !== item.title.trim() && <p>{item.verification.criterion}</p>}{!item.mandatory && <small>Необязательное улучшение</small>}</li>)}</ol>
            : snapshot.task?.acceptance.length ? <><p className="field-hint">Исходные критерии задачи. Доказательства появятся после проверок.</p><ol className="wide-criteria-list">{snapshot.task.acceptance.map((item,index) => <li key={index}>{item}</li>)}</ol></>
            : <p>Критерии еще не сформированы. Выполнение шагов не означает подтвержденный результат.</p>}
        </section>}
        <section><h4>{gate?.type === 'provider-consent' ? 'Границы передачи' : 'Границы изменений'}</h4>
          {scope.length ? <ul className="path-list">{scope.map(path => <li key={path}><code>{path}</code></li>)}</ul> : <p>Область задачи еще не определена.</p>}
          {gate && <p>{humanText(gate.consequences.approve)}</p>}
        </section>
        {Boolean(gate?.risks.length) && <section><h4>На что обратить внимание</h4><ul>{gate!.risks.map((risk,index) => <li key={index}>{humanText(risk)}</li>)}</ul></section>}
        <details><summary>Описание и технические сведения</summary>
          <CollapsibleText id={`wide-description-${snapshot.runId}`} text={snapshot.task?.description || snapshot.task?.goal || 'Описание не передано'} />
          <dl><dt>Версия плана</dt><dd data-testid="plan-version">{snapshot.planVersion ?? '—'}</dd><dt>Ревизия</dt><dd data-testid="run-revision">{snapshot.revision ?? '—'}</dd></dl>
          {gate && <><p>Чтение: {gate.readPaths?.join(', ') || 'не указано'}</p><p>Права: {gate.requiredPermissions.join(', ') || 'не указаны'}</p></>}
          <code>{snapshot.planHash}</code>
        </details>
      </>}
    </div>
  </aside>;
}
