import { useState } from 'react';
import type { ProjectContext, Snapshot } from './contracts';
import type { Locale } from './ui-copy';
import { humanText } from './presentation';
import { RunHealth } from './ui-controls';
import { ModalSurface } from './ModalSurface';

export function ProjectStatus({ project, snapshot, unavailable, locale, onSetup }: {
  project: ProjectContext | null;
  snapshot: Snapshot | null;
  unavailable: boolean;
  locale: Locale;
  onSetup: () => void;
}) {
  const [open, setOpen] = useState(false);
  const problem = unavailable || snapshot?.integrity.valid === false || snapshot?.runner?.ai.available === false;
  const ready = Boolean(project?.capabilities.intake.allowed) && !problem;
  const status = problem ? 'Нужна проверка' : !project ? 'Загружаем проект' : ready ? 'Можно создать задачу' : 'Нужна настройка';
  return <>
    <button className="project-status-trigger" type="button" aria-label="Состояние проекта"
      aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
      <span className="project-name">{project?.name || 'Проект'}</span>
      <span className="project-status-caption"><span>Состояние проекта</span><strong>{status}</strong></span>
    </button>
    {open && <ModalSurface title="Состояние проекта" onClose={() => setOpen(false)} className="project-status-dialog">
      <header className="surface-heading"><div><h2>Состояние проекта</h2><p>{project?.name || 'Проект загружается'}</p></div>
        <button className="button quiet" type="button" onClick={() => setOpen(false)}>Закрыть</button>
      </header>
      <div className="surface-body">
        <p className="project-status-summary">{status}</p>
        {!project && <p>Данные проекта еще не получены.</p>}
        {project && !project.capabilities.intake.allowed && <p>{humanText(project.capabilities.intake.reason) || 'Создание задач пока недоступно.'}</p>}
        {project && <dl className="fact-list"><dt>AI-инструмент</dt><dd>{project.ai.provider || 'Не настроен'}</dd>
          <dt>Проверки проекта</dt><dd>{project.checks.join(', ') || 'Не настроены'}</dd></dl>}
        {unavailable ? <p role="status">Состояние выбранной задачи недоступно. Данные предыдущей проверки не подтверждают текущее состояние.</p>
          : snapshot && <section><h3>Выбранная задача</h3><RunHealth snapshot={snapshot} locale={locale} /></section>}
        <button className="button" type="button" onClick={() => { setOpen(false); onSetup(); }}>Настройки проекта</button>
      </div>
    </ModalSurface>}
  </>;
}
