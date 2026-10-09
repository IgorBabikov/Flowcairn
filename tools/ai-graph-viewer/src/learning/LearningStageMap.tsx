import type { Snapshot } from '../contracts';
import { HistoricalMaterials } from './HistoricalMaterials';
import type { WorkflowController } from '../workflow-controller-types';
import { QuestScroll } from '../rpg/QuestScroll';
import { RuntimeNotices } from '../rpg/RuntimeNotices';
import { LearningControls } from './LearningControls';
import { freshnessLabels, learningCapability, learningRun, progressLabels, stageLabels, resultFreshness } from './learning-projection';

export function LearningStageMap({ controller: c, onOpen, onClose }: {
  controller: WorkflowController; onOpen: (runId: string, materialHash: string, predecessors?: Snapshot[]) => void; onClose: () => void;
}) {
  const run = learningRun(c.snapshot);
  const capability = learningCapability(run, 'openLearning');
  const allowed = capability.allowed && !c.snapshotUnavailable;
  return <QuestScroll title="Карта разбора" onClose={onClose} footer={<button className="game-secondary" type="button" onClick={onClose}>Вернуться в мир</button>}>
    <RuntimeNotices controller={c} />
    {!run ? <p>У этого запуска нет совместимого учебного состояния.</p> : <>
      <p>Выполнение и чтение учитываются отдельно. Проверенный этап не означает подтверждение всей задачи.</p>
      {!allowed && <p role="status">{c.snapshotUnavailable ? 'Состояние задачи недоступно. Обновите данные.' : capability.reason || 'Чтение материала сейчас недоступно.'}</p>}
      <ol className="learning-stage-list">{run.learning.stages.map(stage => <li key={stage.id}>
        <h3>{stage.title}</h3><p>{stage.outcome}</p>
        <p>{stageLabels[stage.status]} · {freshnessLabels[resultFreshness(run, stage.checkedResultHash, run.runId, c.snapshotUnavailable)]}</p>
        <p>{progressLabels[stage.progress]} · {stage.materialStatus === 'partial' ? 'Контекст неполный' : stage.materialStatus === 'unavailable' ? 'Исходники недоступны' : stage.materialStatus === 'pending' ? 'Материал еще не сохранен' : 'Материал сохранен'}</p>
        {stage.reason && <p>{stage.reason}</p>}
        <button className="game-text-action" type="button" disabled={!allowed || !stage.materialHash}
          onClick={() => { if (stage.materialHash) onOpen(run.runId, stage.materialHash); }}>Открыть сохраненный материал</button>
        {!stage.materialHash && <p>Ссылка на материал пока отсутствует.</p>}
        {stage.lessonStatus === 'failed' && <p>Разбор не подготовлен. Это не меняет результат исполнения.</p>}
      </li>)}</ol>
      <h3>Итоговая версия</h3>
      <button className="game-text-action" type="button" disabled={!allowed || !run.learning.finalMaterialHash}
        onClick={() => { if (run.learning.finalMaterialHash) onOpen(run.runId, run.learning.finalMaterialHash); }}>Открыть итоговый материал</button>
      {!run.learning.finalMaterialHash && <p>Итоговый материал еще не сохранен.</p>}
      <HistoricalMaterials context={run} allowed={allowed} onOpen={onOpen} />
      <LearningControls controller={c} />
    </>}
  </QuestScroll>;
}
