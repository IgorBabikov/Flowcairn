import type { WorkflowController } from '../workflow-controller-types';
import { humanText } from '../presentation';
import { QuestScroll } from './QuestScroll';
import { RuntimeNotices } from './RuntimeNotices';

export function QuestIntake({ controller: c, onClose }: { controller: WorkflowController; onClose: () => void }) {
  const fields = c.taskDraft;
  const locked = c.busy || Boolean(c.pending) || c.projectContextRefreshing;
  const allowed = c.project?.capabilities.intake.allowed === true;
  const valid = fields.title.trim().length > 0 && fields.description.trim().length >= 3 && fields.taskNumber.trim().length > 0;
  const update = (name: keyof typeof fields, value: string) => c.setTaskDraft({ ...fields, [name]: value });
  return <QuestScroll title="Новое поручение" onClose={onClose} closeDisabled={locked} footer={<button className="game-primary" type="submit" form="quest-intake"
    disabled={locked || !allowed || !valid}>{c.busy ? 'Начинаем анализ…' : 'Начать анализ'}</button>}>
    <RuntimeNotices controller={c} />
    {c.displayedError && !c.pending && <button className="game-text-action" type="button" disabled={locked}
      onClick={() => void c.refreshProjectContext()}>{c.projectContextRefreshing ? 'Обновляем контекст…' : 'Обновить контекст'}</button>}
    <form id="quest-intake" className="quest-intake" onSubmit={event => {
      event.preventDefault();
      if (!locked && allowed && valid) void c.createRun({ title: fields.title.trim(), description: fields.description.trim(), taskNumber: fields.taskNumber.trim() });
    }}>
      <label htmlFor="quest-name">Название</label>
      <input id="quest-name" name="title" value={fields.title} onChange={event => update('title', event.target.value)} required maxLength={160}
        disabled={locked} placeholder="Что нужно изменить?" />
      <label htmlFor="quest-description">Что нужно сделать</label>
      <textarea id="quest-description" name="description" value={fields.description} onChange={event => update('description', event.target.value)}
        required minLength={3} disabled={locked} placeholder="Цель, нужные файлы и ограничения" />
      <label htmlFor="quest-number">Номер задачи</label>
      <input id="quest-number" name="taskNumber" value={fields.taskNumber} onChange={event => update('taskNumber', event.target.value)}
        required maxLength={80} disabled={locked} placeholder="Например, PROJ-123" />
      {c.project?.schemaVersion === 3 && <fieldset disabled={locked}><legend>Когда изучать решение?</legend>
        <label className="quest-radio"><input type="radio" name="learning-mode" value="after-stage" checked={c.learningMode === 'after-stage'} onChange={() => c.setLearningMode('after-stage')} />По этапам</label>
        <label className="quest-radio"><input type="radio" name="learning-mode" value="after-task" checked={c.learningMode === 'after-task'} onChange={() => c.setLearningMode('after-task')} />После всей задачи</label>
        <p className="game-hint">{c.learningMode === 'after-stage' ? 'После проверенного этапа работа ждет вашего решения.' : 'Учебные паузы не прерывают выполнение. Ошибки и разрешения по-прежнему требуют решения.'}</p>
      </fieldset>}
      <p className="game-hint">Сначала подготовим план. Изменения — после вашего согласия.</p>
      {!allowed && <p role="status">{humanText(c.project?.capabilities.intake.reason) || 'Создание задачи сейчас недоступно.'}</p>}
      {c.busy && <p role="status">Подготавливаем снимок проекта и задачу…</p>}
    </form>
  </QuestScroll>;
}
