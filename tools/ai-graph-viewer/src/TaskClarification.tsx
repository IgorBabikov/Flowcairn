import { useEffect, useMemo, useRef, useState } from 'react';
import type { ApiError, ContextSelection, IntakePreview, Snapshot, TaskFields } from './contracts';
import { api } from './api';
import { TaskContextPicker } from './TaskContextPicker';
import { StatusLoader } from './StatusLoader';

export function TaskClarification({ snapshot, busy, onClose, onSubmit }: {
  snapshot: Snapshot;
  busy: boolean;
  onClose: () => void;
  onSubmit: (selection: ContextSelection & { contextHash: string }, feedback: string) => void;
}) {
  const [preview, setPreview] = useState<IntakePreview | null>(null);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const fields = useMemo<TaskFields>(() => ({ title: snapshot.task?.title ?? snapshot.task?.goal ?? '',
    description: snapshot.task?.description ?? snapshot.task?.goal ?? '', taskNumber: snapshot.task?.taskNumber ?? snapshot.task?.id ?? '' }), [snapshot.task]);
  const check = async (selection?: ContextSelection) => {
    const project = await api.project();
    return api.previewIntake({ ...fields, runId: snapshot.runId, contextHash: project.contextHash, ...(selection ? { selection } : {}) });
  };
  useEffect(() => {
    let active = true;
    heading.current?.focus();
    void (async () => {
      try {
        const project = await api.project();
        const result = await api.previewIntake({ ...fields, runId: snapshot.runId, contextHash: project.contextHash });
        if (active) setPreview(result);
      } catch (reason) { if (active) setError((reason as ApiError).message || 'Не удалось загрузить контекст. Повторите запрос.'); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [fields, attempt, snapshot.runId]);
  const reason = snapshot.failureReason || snapshot.nodes.find(node => node.resolutionKind === 'semantic')?.reason;
  return <section className="task-composer task-clarification" aria-labelledby="clarification-heading">
    <header><h2 id="clarification-heading" ref={heading} tabIndex={-1}>Уточнить контекст задачи</h2>
      <button className="button quiet" type="button" disabled={busy} onClick={onClose}>Вернуться к задаче</button></header>
    <p>{fields.title}</p>
    {reason && <p className="runtime-reason">{reason}</p>}
    <p>После проверки контекста анализ продолжится в этой задаче. Исходное описание сохранится.</p>
    {loading && <StatusLoader kind="button" label="Проверяем контекст…" inline />}
    {error && <div role="alert"><p className="field-error">{error}</p><button className="button" type="button" disabled={loading || busy}
      onClick={() => { setError(''); setLoading(true); setAttempt(value => value + 1); }}>Повторить проверку</button></div>}
    <label htmlFor="clarification-feedback">Дополнение к задаче (необязательно)</label>
    <textarea id="clarification-feedback" maxLength={4000} value={feedback} disabled={busy}
      onChange={event => setFeedback(event.target.value)} />
    {preview && <TaskContextPicker initial={preview} busy={busy} onCheck={check} startLabel="Продолжить анализ"
      onStart={(selection, contextHash) => onSubmit({ ...selection, contextHash }, feedback.trim())} />}
  </section>;
}
