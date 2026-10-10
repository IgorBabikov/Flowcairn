import { useState } from 'react';
import { assertCoverageLesson } from './coverage-decoder';
import type { CoverageSource, LearningLessonResponse, LearningMaterialResponse } from '../contracts';
import type { SourceSelection } from './SavedSourcePanel';

const changes = { added: 'Создан файл', removed: 'Удален файл', modified: 'Изменены строки', metadata: 'Изменены метаданные', unknown: 'Изменение не определено', unchanged: 'Предоставленный контекст' };
const states = { unlinked: 'Нет привязки к шагам', partial: 'Привязка к части строк', linked: 'Все строки привязаны к шагам' };
export function CoverageOverview({ material, lesson = null, canRead = true, onSource }: {
  material: LearningMaterialResponse; lesson?: LearningLessonResponse | null; canRead?: boolean; onSource?: (selection: SourceSelection) => void;
}) {
  const [page, setPage] = useState(0);
  const coverage = material.coverage;
  if (!coverage) return <p>Материал прежней версии: карта участков для него не сохранялась.</p>;
  const entries = coverage.pages.flatMap(value => value.entries);
  const limit = 12, index = Math.min(page, Math.max(0, Math.ceil(entries.length / limit) - 1));
  const linkById = new Map(coverage.links.map(link => [link.entryId, link]));
  const titleById = new Map(lesson?.lesson.steps.map(step => [step.id, step.title]) ?? []);
  let validated = canRead && coverage.linking === 'validated' && lesson?.id === coverage.lessonHash && lesson.lesson.materialHash === material.id;
  // A cached lesson may survive a new material response with the same lesson key.
  // Recheck its links synchronously rather than briefly trusting fresh metadata.
  if (validated && lesson) {
    try { assertCoverageLesson(material, lesson.lesson); } catch { validated = false; }
  }
  const open = (value: CoverageSource) => onSource?.({ sourceId: value.sourceId, startLine: value.range?.startLine ?? 1,
    lineCount: value.range ? Math.min(200, value.range.endLine - value.range.startLine + 1) : 100, anchor: null });
  return <details className="learning-material-details">
    <summary>Участки кода и пробелы · {entries.length}</summary>
    <p>Привязка строк к шагам не подтверждает полноту объяснения или понимание кода.</p>
    {coverage.linking === 'unavailable' && <p role="status">Привязки недоступны: сохраненный урок не удалось проверить.</p>}
    {coverage.linking === 'validated' && !validated && <p role="status">Для показа привязок нужен проверенный разбор этой версии материала.</p>}
    <ol start={index * limit + 1}>
      {entries.slice(index * limit, (index + 1) * limit).map(item => {
        const link = linkById.get(item.id);
        return <li key={item.id}>
          <p><strong>{item.kind === 'gap' ? 'Пробел' : changes[item.change!]}</strong>{item.path && <> · <code>{item.path}</code></>}</p>
          {item.reason && <p>{item.reason}</p>}
          {item.kind !== 'gap' && <>
            <p>{validated && link ? states[link.status] : 'Привязки к шагам не подтверждены'}{validated && link?.stepIds.length ? ` · ${link.stepIds.map(id => titleById.get(id) ?? id).join(', ')}` : ''}</p>
            <div className="source-pagination">
              {(['before', 'after'] as const).map(side => {
                const source = item[side]; if (!source) return null;
                return <button key={side} className="game-text-action" type="button" disabled={!canRead || !onSource} onClick={() => open(source)}>
                  {side === 'before' ? 'Открыть до изменений' : item.kind === 'context' ? 'Открыть контекст' : 'Открыть после изменений'}{source.range ? `: ${source.range.startLine}–${source.range.endLine}` : ': файл'}
                </button>;
              })}
            </div>
          </>}
        </li>;
      })}
    </ol>
    {entries.length > limit && <nav className="source-pagination" aria-label="Страницы карты участков">
      <button className="game-text-action" type="button" disabled={index === 0} onClick={() => setPage(index - 1)}>Предыдущие участки</button>
      <span>{index + 1} / {Math.ceil(entries.length / limit)}</span>
      <button className="game-text-action" type="button" disabled={(index + 1) * limit >= entries.length} onClick={() => setPage(index + 1)}>Следующие участки</button>
    </nav>}
  </details>;
}
