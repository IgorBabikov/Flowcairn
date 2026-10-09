import { Fragment, useCallback, useState, type ReactNode } from 'react';
import { api } from '../api';
import type { LearningMaterialResponse, LearningSourceResponse, SourceAnchor, SourceFreshness } from '../contracts';
import { freshnessLabels } from './learning-projection';
import { anchorPageMatch, sourceRoleLabels } from './source-page';
import { learningReadMessage, useBoundRead } from './use-bound-read';

export type SourceSelection = { sourceId: string; startLine: number; anchor: SourceAnchor | null; lineCount?: number; startColumn?: number };
export function SavedSourcePanel({ runId, material, selection, onSelect, canRead, deniedReason, freshness = 'unknown', renderQuestion }: {
  runId: string; material: LearningMaterialResponse; selection: SourceSelection | null;
  onSelect: (selection: SourceSelection) => void; canRead: boolean; deniedReason: string | null; freshness?: SourceFreshness; renderQuestion?: (anchor: SourceAnchor | null) => ReactNode;
}) {
  const source = material.sources.find(item => item.id === selection?.sourceId) ?? material.sources[0] ?? null;
  const startLine = selection && source?.id === selection.sourceId ? selection.startLine : 1;
  const lineCount = selection?.sourceId === source?.id ? selection?.lineCount ?? 100 : 100;
  const startColumn = selection?.sourceId === source?.id ? selection?.startColumn ?? 0 : 0;
  const anchor = selection && source?.id === selection.sourceId ? selection.anchor : null;
  const load = useCallback((signal: AbortSignal) => {
    if (!source) return Promise.reject({ code: 'SOURCE_UNAVAILABLE', message: 'Сохраненный исходник отсутствует.', retryable: false });
    return api.learningSource(runId, material.id, source, startLine, lineCount, signal, startColumn);
  }, [runId, material.id, source, startLine, lineCount, startColumn]);
  const result = useBoundRead(source ? `${runId}:${material.id}:${source.id}:${source.fileHash}:${startLine}:${lineCount}:${startColumn}` : null, load, canRead);
  const [fontSize, setFontSize] = useState(15);
  const match = result.data && anchorPageMatch(result.data, anchor);
  const page = result.data;
  const [copyState, setCopyState] = useState<{ key: string; message: string } | null>(null);
  const pageKey = page ? `${page.sourceId}:${page.fileHash}:${page.startLine}:${page.endLine}:${page.startColumn ?? 0}` : '';
  const copyPage = async () => {
    if (!page) return;
    try { await navigator.clipboard.writeText(page.text); setCopyState({ key: pageKey, message: 'Показанные строки скопированы.' }); }
    catch { setCopyState({ key: pageKey, message: 'Не удалось скопировать автоматически. Можно выделить текст кода.' }); }
  };
  const navigate = (line: number, column = 0) => { if (source) onSelect({ sourceId: source.id, startLine: line, startColumn: column, anchor, lineCount }); };
  return <section className="saved-source-panel" aria-label="Сохраненный исходник">
    <label><span className="source-file-label">Версия файла</span><select value={source?.id ?? ''} disabled={!canRead || !material.sources.length}
      onChange={event => onSelect({ sourceId: event.target.value, startLine: 1, anchor: null })}>
      {!source && <option value="">Нет сохраненных файлов</option>}
      {material.sources.map(item => <option key={item.id} value={item.id}>{sourceRoleLabels[item.role]} · {item.path}</option>)}
    </select></label>
    {material.material.status !== 'complete' && <p className="source-context-warning" role="status">Контекст {material.material.status === 'partial' ? 'неполный' : 'недоступен'} · ограничения ниже</p>}
    {!canRead && <p role="status">{deniedReason || 'Чтение сейчас недоступно. Ранее загруженный фрагмент не является актуальной проверкой проекта.'}</p>}
    {source && <>
      {material.material.runId !== runId && <p>Историческая версия предыдущего запуска.</p>}
      <p className={`code-source-line learning-freshness--${freshness}`} role="status">Только чтение · {freshnessLabels[freshness]}{page && ` · ${page.startLine}–${page.endLine} / ${page.totalLines}`}</p>
      {result.state === 'loading' && <p role="status">Читаем сохраненный диапазон…</p>}
      {result.error && <div role="alert"><p>{learningReadMessage(result.error)}</p><code>{result.error.code}</code>
        <button className="game-text-action" type="button" disabled={!canRead} onClick={result.reload}>Повторить чтение</button></div>}
      {page && <>
        {(page.partial || page.startColumn) && <p role="status">Строка {page.startLine} показана частями. {page.next ? 'Продолжение доступно кнопкой «Дальше».' : 'Показана последняя часть.'}</p>}
        {page.totalLines === 0 && <p>Сохранен пустой файл.</p>}
        {anchor && match && !match.complete && <p>Показана часть ссылки разбора: строки {anchor.startLine}–{anchor.endLine}.</p>}
        {match && match.matches === false && <p role="alert">Цитата урока не совпадает с сохраненными строками. Используйте исходник и отчеты для проверки.</p>}
        <div className="source-pagination" aria-label="Страницы сохраненного исходника">
          <button className="game-text-action" type="button" aria-label="Предыдущие строки" disabled={!canRead || startLine <= 1 && startColumn === 0} onClick={() => navigate(startColumn ? startLine : Math.max(1, startLine - lineCount))}>Назад</button>
          <button className="game-text-action" type="button" aria-label="Следующие строки" disabled={!canRead || !page.next} onClick={() => { if (page.next) navigate(page.next.startLine, page.next.startColumn ?? 0); }}>Дальше</button>
          <button className="game-text-action" type="button" aria-label="Копировать показанные строки" onClick={() => void copyPage()}>Копировать</button>
        </div>
        {copyState?.key === pageKey && <p role="status">{copyState.message}</p>}
        <SavedCode page={page} fontSize={fontSize} anchor={match?.matches ? anchor : null} />
        {renderQuestion && <div key={`${pageKey}:${anchor?.startLine ?? ''}:${anchor?.endLine ?? ''}`}>{renderQuestion(questionAnchor(page, match?.matches && match.complete ? anchor : null))}</div>}
      </>}
      <details className="source-tools"><summary>Диапазон и версия</summary>{material.material.gaps.length > 0 && <ul>{material.material.gaps.map((gap,index) => <li key={index}>{gap.path}: {gap.reason}</li>)}</ul>}<p>Путь: <code>{source.path}</code></p><p>Материал: <code>{material.id}</code></p><p>Файл: <code>{source.fileHash}</code></p><p>Владелец: <code>{material.material.runId}</code></p><p>Контекст доступа: <code>{runId}</code></p>
      <div className="code-sheet-controls"><label>Размер кода<select value={fontSize} onChange={event => setFontSize(Number(event.target.value))}>
        <option value={15}>15</option><option value={18}>18</option><option value={21}>21</option></select></label></div>
      <form className="source-range" key={`${source.id}:${startLine}`} onSubmit={event => {
        event.preventDefault();
        const form = event.currentTarget;
        const value = Number(new FormData(form).get('startLine'));
        const count = Number(new FormData(form).get('lineCount'));
        if (canRead && Number.isSafeInteger(value) && value >= 1 && value <= Math.max(1, source.lineCount) && Number.isSafeInteger(count) && count >= 1 && count <= 200) onSelect({ sourceId: source.id, startLine: value, lineCount: count, anchor: null });
      }}>
        <label>С строки<input name="startLine" type="number" min={1} max={Math.max(1, source.lineCount)} defaultValue={startLine} disabled={!canRead} /></label>
        <label>Число строк<input name="lineCount" type="number" min={1} max={200} defaultValue={lineCount} disabled={!canRead} /></label>
        <button className="game-text-action" type="submit" disabled={!canRead || result.state === 'loading'}>Показать диапазон</button>
      </form></details>
    </>}
  </section>;
}
export function SavedCode({ page, fontSize, anchor }: { page: LearningSourceResponse; fontSize: number; anchor: SourceAnchor | null }) {
  const lines = page.totalLines === 0 ? [] : page.text.split('\n');
  return <pre className="saved-code" style={{ fontSize }} aria-label={`Сохраненный код: строки ${page.startLine}–${page.endLine}`}><code>
    {lines.map((line, index) => <Fragment key={page.startLine + index}><span data-line={page.startLine + index}
      className={anchor && page.startLine + index >= anchor.startLine && page.startLine + index <= anchor.endLine ? 'source-line-selected' : undefined}
      title={`Строка ${page.startLine + index}`}>{line}</span>{index < lines.length - 1 ? '\n' : null}</Fragment>)}
  </code></pre>;
}

export function questionAnchor(page: LearningSourceResponse, selected: SourceAnchor | null): SourceAnchor | null {
  if (selected) return selected;
  if (page.partial || page.startColumn || !page.text || new TextEncoder().encode(page.text).length > 8192) return null;
  return { sourceId: page.sourceId, fileHash: page.fileHash, startLine: page.startLine, endLine: page.endLine, quote: page.text };
}
