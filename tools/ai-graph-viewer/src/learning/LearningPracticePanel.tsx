import { useMemo, useState } from 'react';
import { api } from '../api';
import type { LearningMaterialResponse, LessonMaterial } from '../contracts';
import type { WorkflowController } from '../workflow-controller-types';
import { learningRun } from './learning-projection';

export function LearningPracticePanel({ controller, runId, material, lesson, canRead }: {
  controller: WorkflowController; runId: string; material: LearningMaterialResponse; lesson: LessonMaterial; canRead: boolean;
}) {
  const current = learningRun(controller.snapshot);
  const question = lesson.questions[0];
  const [answer, setAnswer] = useState('');
  const [logHash, setLogHash] = useState<string | null>(null);
  const [attemptHash, setAttemptHash] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canSubmit = Boolean(canRead && current?.revision !== undefined && current.planHash && question && answer.trim() && !busy);
  const request = useMemo(() => current && question ? {
    operationId: `practice-${question.id}-${current.revision}`,
    expectedRevision: current.revision ?? 0,
    planHash: current.planHash ?? '', materialHash: material.id, logHash, chapterBookHash: null, lessonHash: material.lessonHash,
    promptId: question.id, question: question.text, answer: answer.trim(), hints: [], limitations: ['Ответ и оценка не доказывают долговременное освоение навыка.'],
  } : null, [answer, current, logHash, material.id, material.lessonHash, question]);
  const submit = async () => {
    if (!request || !canSubmit) return;
    setBusy(true); setMessage(null);
    try {
      const result = await api.appendLearningPractice(runId, request);
      setLogHash(result.logHash); setAttemptHash(result.attemptHash ?? null); setMessage('Ответ сохранен. Самооценка не меняет результат исполнения.');
      void controller.refreshSnapshot(runId);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Ответ не удалось сохранить.'); }
    finally { setBusy(false); }
  };
  const assess = async (status: 'partially-correct' | 'incorrect') => {
    if (!current || !logHash || !attemptHash || busy) return;
    setBusy(true); setMessage(null);
    try {
      const result = await api.appendLearningPracticeFeedback(runId, { operationId: `feedback-${attemptHash}-${current.revision}`,
        expectedRevision: current.revision ?? 0, planHash: current.planHash ?? '', materialHash: material.id, logHash, attemptHash,
        feedback: { assessment: { status, evaluator: 'human', score: status === 'partially-correct' ? 0.5 : 0, feedback: status === 'partially-correct' ? 'Нужно уточнить часть потока.' : 'Попробуй проследить поток еще раз.', limitations: ['Оценка одной попытки.'] } } });
      setLogHash(result.logHash); setMessage('Обратная связь сохранена отдельно от ответа.');
      void controller.refreshSnapshot(runId);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Обратную связь не удалось сохранить.'); }
    finally { setBusy(false); }
  };
  if (!question) return null;
  return <section className="learning-practice" aria-labelledby="learning-practice-title">
    <h3 id="learning-practice-title">Попробуй сам</h3>
    <p>{question.text}</p>
    <p className="learning-practice__limitation">Ответ и оценка не доказывают долговременное освоение навыка.</p>
    <textarea aria-label="Твой ответ" value={answer} onChange={event => setAnswer(event.target.value)} disabled={!canRead || busy} rows={3} />
    <button className="game-text-action" type="button" disabled={!canSubmit} onClick={() => void submit()}>Сохранить ответ</button>
    {attemptHash && <div className="learning-practice__feedback"><p role="status">Попытка сохранена. Оценка остается отдельным человеческим действием.</p>
      <button className="game-text-action" type="button" disabled={busy} onClick={() => void assess('partially-correct')}>Частично верно</button>
      <button className="game-text-action" type="button" disabled={busy} onClick={() => void assess('incorrect')}>Нужно уточнить</button></div>}
    {message && <p role="status">{message}</p>}
  </section>;
}
