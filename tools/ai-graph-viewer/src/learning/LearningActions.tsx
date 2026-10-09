import type { LearningMaterialResponse, LearningProgress } from '../contracts';
import type { WorkflowController } from '../workflow-controller-types';
import { contentCapability } from './content-command';
import type { useLearningJob } from './use-learning-job';

export function LearningActions({ controller: c, runId, material, job, kind }: {
  controller: WorkflowController; runId: string; material: LearningMaterialResponse;
  job: ReturnType<typeof useLearningJob>; kind?: 'lesson' | 'question';
}) {
  const generate = contentCapability(c.snapshot, runId, material, { action: 'generate-lesson' }, c.snapshotUnavailable);
  const progress = contentCapability(c.snapshot, runId, material, { action: 'set-progress', progress: 'read' }, c.snapshotUnavailable);
  const progressValue = material.progress;
  const disabled = c.busy || Boolean(c.pending);
  const setProgress = (value: LearningProgress) => void c.executeLearningContent(runId, material, { action: 'set-progress', progress: value });
  return <section className="learning-actions" aria-label="Действия с разбором">
    {!material.lessonHash && <>
      <p>Разбор объяснит сохраненный код. Подготовка запускается только по вашей команде.</p>
      <button className="game-primary-action" type="button" disabled={disabled || !generate.allowed}
        onClick={() => void c.executeLearningContent(runId, material, { action: 'generate-lesson' })}>Подготовить разбор</button>
      {!generate.allowed && <p>{generate.reason}</p>}
    </>}
    {kind !== 'question' && <LearningJobNotice observation={job} kind={kind} canRead={!c.snapshotUnavailable} />}
    <details className="reading-progress"><summary>Отметка чтения{progressValue ? `: ${progressLabel(progressValue)}` : ''}</summary>
      <p>Личная отметка. Чтение и продолжение работы не подтверждают освоение навыка или правильность кода.</p>
      <div className="source-pagination">
        <button className="game-text-action" type="button" disabled={disabled || !progress.allowed} onClick={() => setProgress('read')}>Я прочитал</button>
        <button className="game-text-action" type="button" disabled={disabled || !progress.allowed} onClick={() => setProgress('deferred')}>Отложить чтение</button>
        <button className="game-text-action" type="button" disabled={disabled || !progress.allowed} onClick={() => setProgress('unread')}>Еще не прочитано</button>
      </div>
      {!progress.allowed && <p>{progress.reason}</p>}
    </details>
  </section>;
}
export function progressLabel(progress: LearningProgress) { return { unread: 'еще не прочитано', read: 'прочитано', deferred: 'отложено' }[progress]; }
export function LearningJobNotice({ observation: { job, paused, error, refresh }, kind, canRead }: {
  observation: ReturnType<typeof useLearningJob>; kind: 'lesson' | 'question' | undefined; canRead: boolean;
}) {
  if (!job && !error && !paused) return null;
  return <div className="learning-job-notice" role="status">
    {job?.status === 'running' && <p>{kind === 'question' ? 'Готовим ответ к выбранному фрагменту…' : 'Готовим разбор сохраненного кода…'} Ожидание не меняет состояние выполнения.</p>}
    {job?.status === 'ready' && <p>{kind === 'question' ? 'Ответ готов и привязан к фрагменту вопроса.' : 'Разбор готов.'}</p>}
    {(job?.status === 'failed' || job?.status === 'uncertain') && <p>{job.status === 'uncertain' ? 'Результат учебного запроса неизвестен.' : 'Учебный запрос не выполнен.'} {job.error?.message || 'Сервис не сообщил подробности.'} {job.error?.code && <code>{job.error.code}</code>} Состояние выполнения задачи не изменено.</p>}
    {(paused || error) && <><p>{error || 'Автообновление остановлено через две минуты. Новый AI-запрос не запускался.'}</p>
      <button className="game-text-action" type="button" disabled={!canRead} onClick={refresh}>Обновить статус запроса</button></>}
  </div>;
}
