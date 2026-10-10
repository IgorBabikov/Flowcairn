import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { SourceAnchor } from '../contracts';
import type { WorkflowController } from '../workflow-controller-types';
import { LearningCodex } from '../rpg/LearningCodex';
import type { CodexNavigation } from '../rpg/use-codex-reading';
import { RuntimeNotices } from '../rpg/RuntimeNotices';
import { LearningActions } from './LearningActions';
import { LessonQuestion } from './LessonQuestion';
import { useLearningJob } from './use-learning-job';
import { LearningControls } from './LearningControls';
import { LessonExplanation } from './LessonExplanation';
import { MaterialOverview } from './MaterialOverview';
import { SavedSourcePanel, type SourceSelection } from './SavedSourcePanel';
import { sourceSelectionForAnchor } from './source-page';
import { freshnessLabels, learningCapability, learningRun, materialFreshness } from './learning-projection';
import { learningReadMessage, useBoundRead } from './use-bound-read';
import { ChapterNavigation } from './ChapterNavigation';
import { LearningPracticePanel } from './LearningPracticePanel';

export type LearningBinding = { runId: string; materialHash: string; chapterBookHash?: string | null };
export function LearningReader({ controller: c, binding, onMap, onClose }: {
  controller: WorkflowController; binding: LearningBinding; onMap: () => void; onClose: () => void;
}) {
  const current = learningRun(c.snapshot);
  const capability = learningCapability(current, 'openLearning');
  const sameRun = current?.runId === binding.runId;
  const canRead = sameRun && capability.allowed && !c.snapshotUnavailable;
  const deniedReason = !sameRun ? 'Открыта сохраненная версия другого запуска. Выберите этот запуск в журнале, чтобы продолжить чтение.'
    : c.snapshotUnavailable ? 'Текущее состояние недоступно. Ранее загруженный материал не подтверждает актуальность проекта.'
    : capability.reason;
  const readMaterial = useCallback((signal: AbortSignal) => api.learningMaterial(binding.runId, binding.materialHash, signal), [binding.runId, binding.materialHash]);
  const material = useBoundRead(`${binding.runId}:${binding.materialHash}:${current?.revision ?? "unknown"}`, readMaterial, canRead);
  const readLesson = useCallback((signal: AbortSignal) => {
    if (!material.data?.lessonHash) return Promise.reject({ code: 'LESSON_ABSENT', message: 'Готового разбора пока нет.', retryable: false });
    return api.learningLesson(binding.runId, material.data.lessonHash, material.data, signal);
  }, [binding.runId, material.data]);
  const lesson = useBoundRead(material.data?.lessonHash ? `${binding.runId}:${binding.materialHash}:${material.data.lessonHash}` : null, readLesson, canRead);
  const readChapterBook = useCallback((signal: AbortSignal) => {
    return api.learningChapterBook(binding.runId, binding.materialHash, binding.chapterBookHash ?? undefined, signal);
  }, [binding.chapterBookHash, binding.materialHash, binding.runId]);
  const chapterBook = useBoundRead(`${binding.runId}:${binding.materialHash}:chapters:${binding.chapterBookHash ?? 'latest'}`, readChapterBook, canRead);
  const accepted = c.learningActivities[binding.runId];
  const active = current?.learning.activeJob;
  const activity = active?.materialHash === binding.materialHash && active.id !== accepted?.jobId
    ? { runId: binding.runId, jobId: active.id, materialHash: active.materialHash, kind: active.kind }
    : accepted?.materialHash === binding.materialHash ? accepted : null;
  const job = useLearningJob(activity, canRead);
  const reloadMaterial = material.reload;
  const refreshedJob = useRef<string | null>(null);
  useEffect(() => {
    if (!job.job || job.job.status === 'running' || refreshedJob.current === job.job.id) return;
    refreshedJob.current = job.job.id;
    reloadMaterial();
    void c.refreshSnapshot(binding.runId);
  }, [job.job, reloadMaterial, c, binding.runId]);
  const answerHash = job.job?.status === 'ready' && job.job.result && 'answerHash' in job.job.result ? job.job.result.answerHash : null;
  const expectedQuestion = accepted?.jobId === activity?.jobId ? accepted?.question : undefined;
  const readAnswer = useCallback((signal: AbortSignal) => {
    if (!material.data || !answerHash) return Promise.reject({ code: 'ANSWER_ABSENT', message: 'Ответ еще не готов.', retryable: false });
    return api.learningAnswer(binding.runId, answerHash, material.data, expectedQuestion, signal);
  }, [material.data, answerHash, binding.runId, expectedQuestion]);
  const answer = useBoundRead(answerHash ? `${binding.runId}:${binding.materialHash}:${answerHash}` : null, readAnswer, canRead && Boolean(material.data));
  const [stepIndex, setStepIndex] = useState(0);
  const [navigation, setNavigation] = useState<CodexNavigation>({ id: 0, page: 'explanation' });
  const [selection, setSelection] = useState<SourceSelection | null>(null);
  const [chapterId, setChapterId] = useState<string | null>(null);
  const selectedStep = lesson.data?.lesson.steps[Math.min(stepIndex, lesson.data.lesson.steps.length - 1)];
  const firstAnchor = selectedStep?.anchors[0];
  const selectedSource = selection ?? (firstAnchor ? sourceSelectionForAnchor(firstAnchor) : null);
  const onAnchor = (anchor: SourceAnchor) => {
    setSelection(sourceSelectionForAnchor(anchor));
    setNavigation(previous => ({ id: previous.id + 1, page: 'source' }));
  };
  const freshness = materialFreshness(current, material.data?.material ?? null, binding.runId, c.snapshotUnavailable);
  const title = lesson.data?.lesson.title || (material.data?.material.kind === 'task' ? 'Итоговый материал' : 'Сохраненный материал');
  return <LearningCodex title={title} navigation={navigation} onClose={onClose} notices={<RuntimeNotices controller={c} />}
    footer={<LearningControls controller={c} materialBinding={binding} compact />}
    explanation={<>
      <button className="game-text-action" type="button" onClick={onMap}>К карте этапов</button>
      {!canRead && <p role="status">{deniedReason || 'Чтение сейчас недоступно.'}</p>}
      {chapterBook.data && <ChapterNavigation book={chapterBook.data} selectedId={chapterId} onSelect={setChapterId} />}
      {material.state === 'loading' && <p role="status">Читаем сохраненный материал…</p>}
      {material.error && <div role="alert"><p>{learningReadMessage(material.error)}</p><code>{material.error.code}</code>
        <button className="game-text-action" type="button" disabled={!canRead} onClick={material.reload}>Повторить чтение материала</button></div>}
      {lesson.state === 'loading' && <p role="status">Читаем готовый разбор…</p>}
      {lesson.error && <div role="alert"><p>{learningReadMessage(lesson.error)}</p>
        <p>Ошибка чтения урока не меняет результат исполнения и доступность продолжения.</p>
        <button className="game-text-action" type="button" disabled={!canRead} onClick={lesson.reload}>Повторить чтение разбора</button></div>}
      {lesson.data && <LessonExplanation lesson={lesson.data.lesson} stepIndex={Math.min(stepIndex, lesson.data.lesson.steps.length - 1)}
        onAnchor={onAnchor} onStep={index => {
          setStepIndex(index);
          const anchor = lesson.data.lesson.steps[index]?.anchors[0];
          setSelection(anchor ? sourceSelectionForAnchor(anchor) : null);
          setNavigation(previous => ({ id: previous.id + 1, page: 'explanation' }));
        }} />}
      {lesson.data && <LearningPracticePanel controller={c} runId={binding.runId} material={material.data!} lesson={lesson.data.lesson} canRead={canRead} />}
      {material.data && <>
        <LearningActions controller={c} runId={binding.runId} material={material.data} job={job} {...(activity ? { kind: activity.kind } : {})} />
        <details className="learning-material-details"><summary>Цель, версия и полнота контекста</summary>
          <p className={`learning-freshness learning-freshness--${freshness}`}>{freshnessLabels[freshness]} · сохраненная версия остается неизменной.</p>
          {material.data.material.runId !== binding.runId && <p>Исторический материал. Владелец: <code>{material.data.material.runId}</code>. Контекст доступа: <code>{binding.runId}</code>.</p>}
          {material.data.freshness.reason && <p>{material.data.freshness.reason}</p>}
          <button className="game-text-action" type="button" disabled={!sameRun} onClick={() => void c.refreshSnapshot(binding.runId)}>Обновить состояние проекта</button>
          <MaterialOverview material={material.data} freshness={freshness} lesson={lesson.data} canRead={canRead} onSource={value => {
            setSelection(value);
            setNavigation(previous => ({ id: previous.id + 1, page: 'source' }));
          }} />
        </details>
      </>}

    </>}
    sourcePanel={material.data ? <SavedSourcePanel runId={binding.runId} material={material.data} selection={selectedSource} onSelect={setSelection}
      canRead={canRead} deniedReason={deniedReason ?? null} freshness={freshness}
      renderQuestion={anchor => lesson.data ? <LessonQuestion controller={c} runId={binding.runId} material={material.data!} anchor={anchor}
        observation={activity?.kind === 'question' ? job : null} answer={answer.data} answerError={answer.error ? learningReadMessage(answer.error) : null} readAnswer={answer.reload} onAnchor={onAnchor} /> : null} /> : <p role="status">{!canRead ? deniedReason || 'Чтение сейчас недоступно.' : 'Исходники появятся после чтения сохраненного материала.'}</p>} />;
}
