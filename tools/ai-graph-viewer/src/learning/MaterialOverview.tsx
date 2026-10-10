import { CoverageOverview } from './CoverageOverview';
import type { SourceSelection } from './SavedSourcePanel';
import type { LearningLessonResponse, LearningMaterialResponse, SourceFreshness } from '../contracts';
import { freshnessLabels } from './learning-projection';

export function MaterialOverview({ material, freshness = 'unknown', lesson = null, canRead = true, onSource }: { material: LearningMaterialResponse; freshness?: SourceFreshness; lesson?: LearningLessonResponse | null; canRead?: boolean; onSource?: (selection: SourceSelection) => void }) {
  const data = material.material;
  return <section className="material-overview">
    <h3>{data.goal}</h3><p>{data.outcome}</p>
    <p>{data.kind === 'task' ? 'Итоговая версия задачи' : `Материал этапа ${data.stageId}`} · {freshnessLabels[freshness]}</p>
    <p>{data.status === 'complete' ? 'Сохранен объявленный контекст. Это не весь репозиторий и не доказательство завершенности задачи.'
      : data.status === 'partial' ? 'Контекст неполный. Ограничения перечислены ниже.' : 'Материал исходников недоступен.'}</p>
    {data.gaps.length > 0 && <><h4>Пробелы сохраненного контекста</h4><ul>{data.gaps.map((gap, index) => <li key={index}>
      {gap.path && <code>{gap.path}: </code>}{gap.reason} <small>({gap.code})</small>
    </li>)}</ul></>}
    <CoverageOverview key={material.id} material={material} lesson={lesson} canRead={canRead} {...(onSource ? { onSource } : {})} />
    <details><summary>Точная версия и отчеты</summary><p>Запуск: <code>{data.runId}</code></p><p>План: <code>{data.planHash}</code></p>
      <p>Результат: <code>{data.resultHash}</code></p><p>Материал: <code>{material.id}</code></p>
      <p>Сохранено: {data.createdAt}</p>
      <p>Связанные отчеты реализации: {data.implementationReceiptIds.length}; проверок: {data.checkReceiptIds.length}; ревью: {data.reviewReceiptIds.length}.</p>
      <ul>{[...data.implementationReceiptIds, ...data.checkReceiptIds, ...data.reviewReceiptIds].map((receipt, index) => <li key={`${receipt}:${index}`}><code>{receipt}</code></li>)}</ul>
    </details>
  </section>;
}
