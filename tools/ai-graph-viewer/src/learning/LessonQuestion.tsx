import { useState } from 'react';
import type { LearningMaterialResponse, LessonAnswer, SourceAnchor } from '../contracts';
import type { WorkflowController } from '../workflow-controller-types';
import { LearningJobNotice } from './LearningActions';
import type { useLearningJob } from './use-learning-job';
import { contentCapability } from './content-command';

export function sameAnchor(left: SourceAnchor | null, right: SourceAnchor | null): boolean {
  return Boolean(left && right && left.sourceId === right.sourceId && left.fileHash === right.fileHash
    && left.startLine === right.startLine && left.endLine === right.endLine && left.quote === right.quote);
}
export function LessonQuestion({ controller: c, runId, material, anchor, answer, onAnchor, answerError, readAnswer, observation }: {
  controller: WorkflowController; runId: string; material: LearningMaterialResponse; anchor: SourceAnchor | null;
  observation?: ReturnType<typeof useLearningJob> | null; answer: LessonAnswer | null; answerError: string | null; readAnswer: () => void; onAnchor: (anchor: SourceAnchor) => void;
}) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const intent = anchor && material.lessonHash ? { action: 'ask-lesson' as const, lessonHash: material.lessonHash, anchor, question } : null;
  const capability = intent ? contentCapability(c.snapshot, runId, material, intent, c.snapshotUnavailable) : { allowed: false, reason: 'Для вопроса нужен готовый разбор и непустой сохраненный диапазон до 8 КиБ.' };
  const matchingAnswer = answer && sameAnchor(anchor, answer.anchor);
  const answerSource = answer && material.sources.find(source => source.id === answer.anchor.sourceId);
  return <section className="lesson-question" aria-label="Вопрос по коду">
    <button className="game-text-action" type="button" disabled={!anchor || !material.lessonHash || c.snapshotUnavailable}
      aria-expanded={open} onClick={() => setOpen(value => !value)}>Задать вопрос по этому месту</button>
    {!anchor && <p className="source-hint">Для вопроса выберите непустой диапазон до 8 КиБ в настройках строк.</p>}
    {open && <form onSubmit={event => { event.preventDefault(); if (intent && capability.allowed) void c.executeLearningContent(runId, material, intent); }}>
      <p>Вопрос к строкам {anchor?.startLine}–{anchor?.endLine}. Ответ опирается на сохраненную версию.</p>
      <label>Ваш вопрос<textarea value={question} maxLength={4000} rows={3} onChange={event => setQuestion(event.target.value)} /></label>
      <button className="game-primary-action" type="submit" disabled={c.busy || Boolean(c.pending) || !capability.allowed}>Отправить вопрос</button>
      {!capability.allowed && <p>{capability.reason}</p>}
    </form>}
    {observation && <LearningJobNotice observation={observation} kind="question" canRead={!c.snapshotUnavailable} />}
    {answerError && <div role="alert"><p>{answerError}</p><button className="game-text-action" type="button" onClick={readAnswer}>Повторить чтение ответа</button></div>}
    {answer && (matchingAnswer ? <article className="lesson-answer" aria-label="Ответ к выбранному фрагменту">
      <h3>Ответ к строкам {answer.anchor.startLine}–{answer.anchor.endLine}</h3><p><strong>Вопрос:</strong> {answer.question}</p><p>{answer.text}</p>
      <div className="source-pagination">{answer.anchors.map((item, index) => <button className="game-text-action" type="button" key={index} onClick={() => onAnchor(item)}>{material.sources.find(source => source.id === item.sourceId)?.path}: {item.startLine}–{item.endLine}</button>)}</div>
      {answer.limitations.length > 0 && <details><summary>Границы ответа</summary><ul>{answer.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul></details>}
    </article> : <div className="answer-other-context" role="status"><p>Есть ответ к другому фрагменту: {answerSource?.path}, строки {answer.anchor.startLine}–{answer.anchor.endLine}.</p>
      <button className="game-text-action" type="button" onClick={() => onAnchor(answer.anchor)}>Показать фрагмент вопроса</button></div>)}
  </section>;
}
