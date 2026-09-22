import { useEffect, useId, useRef, useState } from 'react';
import type { ApiError, ContextSelection, IntakePreview } from './contracts';
import { StatusLoader } from './StatusLoader';

/** A preview grants no permissions. The server validates every edited path again. */
export function TaskContextPicker({ initial, busy, onCheck, onStart, startLabel = 'Начать анализ' }: {
  initial: IntakePreview;
  busy: boolean;
  onCheck: (selection?: ContextSelection) => Promise<IntakePreview>;
  onStart: (selection: ContextSelection, contextHash: string) => void;
  startLabel?: string;
}) {
  const id = useId();
  const [preview, setPreview] = useState(initial);
  const [scope, setScope] = useState(initial.scope.join('\n'));
  const [resolutions, setResolutions] = useState<ContextSelection['resolutions']>([]);
  const [dirty, setDirty] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [needsFreshPreview, setNeedsFreshPreview] = useState(false);
  const request = useRef(0);
  const locked = useRef(false);
  useEffect(() => () => { request.current += 1; }, []);
  const selection = (): ContextSelection => ({ previewHash: preview.previewHash,
    scope: [...new Set([...scope.split('\n'), ...resolutions.filter(item => item.kind !== 'example').map(item => item.path ?? '')]
      .map(path => path.trim()).filter(Boolean))],
    resolutions: resolutions.map(item => item.kind === 'example' ? { reference: item.reference, kind: item.kind }
      : { ...item, ...(item.path ? { path: item.path.trim() } : {}) }) });
  const updateResolution = (reference: string, update: Partial<ContextSelection['resolutions'][number]>) => {
    setDirty(true); setError('');
    setResolutions(current => {
      const previous = current.find(item => item.reference === reference);
      return [...current.filter(item => item.reference !== reference), { reference, kind: 'existing', ...previous, ...update }];
    });
  };
  const check = async (fresh = false) => {
    if (locked.current || busy) return;
    locked.current = true;
    const version = ++request.current;
    setChecking(true); setError('');
    try {
      const result = await onCheck(fresh ? undefined : selection());
      if (version !== request.current) return;
      setPreview(result); setScope(result.scope.join('\n')); setDirty(false);
      if (fresh) setResolutions([]);
      setNeedsFreshPreview(false);
    } catch (reason) {
      if (version === request.current) {
        const failure = reason as ApiError;
        setError(failure.code === 'NETWORK_UNCERTAIN' ? 'Не удалось получить проверку контекста. Повторите запрос.' : failure.message || 'Проверка не завершена. Повторите запрос.');
        setNeedsFreshPreview(['STALE_CONTEXT', 'STALE_PREVIEW'].includes(failure.code));
      }
    } finally {
      if (version === request.current) { locked.current = false; setChecking(false); }
    }
  };
  return <section className="task-context-picker" aria-labelledby={`${id}-heading`} aria-busy={checking}>
    <h3 id={`${id}-heading`}>Контекст задачи</h3>
    <p>Проверьте файлы и папки, с которыми связана задача. Пути указываются от корня проекта.</p>
    <label htmlFor={`${id}-scope`}>Файлы и папки задачи — по одному пути на строку</label>
    <textarea id={`${id}-scope`} value={scope} disabled={busy || checking} spellCheck={false}
      onChange={event => { setScope(event.target.value); setDirty(true); setError(''); }} />
    {preview.references.map((reference, index) => {
      const choice = resolutions.find(item => item.reference === reference.reference);
      if (reference.status === 'resolved' && !choice) return <p className="context-resolved" key={reference.reference}>Найдено: <code>{reference.reference}</code></p>;
      return <fieldset key={reference.reference} disabled={busy || checking} className="context-reference">
        <legend><code>{reference.reference}</code></legend>
        <p>{({ missing: 'Файл не найден в доступном контексте.', ambiguous: 'Найдено несколько совпадений. Укажите нужный путь.', unavailable: 'Файл недоступен для этой задачи.', resolved: 'Уточнение проверено.' })[reference.status]}</p>
        <label htmlFor={`${id}-kind-${index}`}>Как использовать {reference.reference}</label>
        <select id={`${id}-kind-${index}`} value={choice?.kind ?? ''} onChange={event => {
          const kind = event.target.value as 'existing' | 'create' | 'example';
          updateResolution(reference.reference, { kind });
        }}>
          <option value="" disabled>Выберите назначение</option>
          {reference.status !== 'unavailable' && <option value="existing">Использовать существующий файл</option>}
          {reference.status !== 'unavailable' && <option value="create">Создать новый файл</option>}
          <option value="example">Справочная ссылка или ограничение, доступ к файлу не нужен</option>
        </select>
        {choice && choice.kind !== 'example' && <>
          <label htmlFor={`${id}-path-${index}`}>{choice.kind === 'create' ? 'Путь нового файла' : 'Путь существующего файла'}</label>
          <input id={`${id}-path-${index}`} list={`${id}-paths-${index}`} value={choice.path ?? ''} spellCheck={false}
            onChange={event => updateResolution(reference.reference, { path: event.target.value })} />
          <p>Этот путь будет включен в контекст после проверки.</p>
          <datalist id={`${id}-paths-${index}`}>{[...new Set([...reference.matches, ...preview.candidates])].map(path => <option key={path} value={path} />)}</datalist>
        </>}
      </fieldset>;
    })}
    {preview.issues.length > 0 && <div className="context-issues" role="status"><p>Перед запуском нужно уточнить:</p><ul>{preview.issues.map((issue, index) => <li key={`${index}:${issue}`}>{issue}</li>)}</ul></div>}
    {preview.feedback.length > 0 && <ul className="context-feedback">{preview.feedback.map((text, index) => <li key={`${index}:${text}`}>{text}</li>)}</ul>}
    {error && <p className="field-error" role="alert">{error}</p>}
    <div className="context-actions">
      <button type="button" className="button" disabled={busy || checking} onClick={() => void check(needsFreshPreview)}>
        {checking ? <StatusLoader kind="button" label="Проверяем контекст…" inline announce={false} /> : needsFreshPreview ? 'Обновить контекст проекта' : 'Проверить контекст снова'}
      </button>
      <button type="button" className="button primary" disabled={busy || checking || dirty || !preview.ready || Boolean(error)}
        onClick={() => { if (!locked.current && !busy && !dirty && preview.ready && !error) onStart(selection(), preview.contextHash); }}>
        {startLabel}
      </button>
    </div>
    {dirty && <p role="status">Контекст изменен. Проверьте его перед запуском.</p>}
  </section>;
}
