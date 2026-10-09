import { useState } from 'react';
import type { WorkflowController } from '../workflow-controller-types';
import { HistoryPanel, PlanPanel } from '../ExecutionDetails';
import { TaskOverview } from '../TaskOverview';
import { ActionButton, getCapability } from '../ui-controls';
import { CloseObject } from './GameControls';
import { WorkingObjectArt } from './WorkingObjectArt';
import { RuntimeNotices } from './RuntimeNotices';
import { DiagnosticNodes } from './DiagnosticNodes';

const names = { result: ['Результат', 'Result'], nodes: ['Этапы', 'Steps'], evidence: ['Отчеты', 'Evidence'], history: ['История', 'History'], plan: ['План', 'Plan'] };
type Page = keyof typeof names;
export function DiagnosticBook({ controller: c, onClose, onQuest }: { controller: WorkflowController; onClose: () => void; onQuest: () => void }) {
  const [artFailed, setArtFailed] = useState(false);
  const s = c.snapshot;
  const pages: Page[] = s?.workflow === 'autonomous' ? ['result', 'nodes', 'evidence', 'history'] : ['result', 'nodes', 'evidence', 'history', 'plan'];
  const page = pages.includes(c.diagnosticPage) ? c.diagnosticPage : 'result';
  const title = c.locale === 'ru' ? 'Книга диагностики' : 'Diagnostic book';
  return <section className={`diagnostic-book${artFailed ? ' art-unavailable' : ''}`} data-testid="diagnostic-book">
    <WorkingObjectArt kind="codex" onFailure={() => setArtFailed(true)} />
    <CloseObject label={c.locale === 'ru' ? 'Закрыть книгу диагностики' : 'Close diagnostic book'} onClose={onClose} />
    <div className="diagnostic-paper" data-surface-body>
      <header className="diagnostic-heading"><h2 data-overlay-heading tabIndex={-1}>{title}</h2>
        <p>{s?.task?.title || s?.task?.goal || c.labels.loading}</p>
      </header>
      <div className="diagnostic-tools">
        <button className="game-text-action" type="button" disabled={!s} onClick={() => { if (s) void c.refreshSnapshot(s.runId); }}>{c.labels.refresh}</button>
        <button className="game-text-action" type="button" onClick={() => c.setLocale(c.locale === 'ru' ? 'en' : 'ru')}>{c.labels.language}</button>
        <button className="game-text-action" type="button" onClick={() => document.documentElement.toggleAttribute('data-dark')}>{c.labels.theme}</button>
        <span role="status">{c.streamConnected ? c.labels.live : c.labels.disconnected}</span>
        {c.isStopping ? <button type="button" className="game-secondary" disabled>{c.locale === 'ru' ? 'Останавливаем…' : 'Stopping…'}</button>
          : <ActionButton capability={getCapability(s?.capabilities ?? {}, 'stop')} onClick={() => void c.execute('stop')}>{c.labels.stop}</ActionButton>}
        {s?.workflow !== 'autonomous' && <fieldset disabled={c.busy || Boolean(c.pending) || c.snapshotUnavailable}>
          <ActionButton capability={getCapability(s?.capabilities ?? {}, 'run')} onClick={() => void c.execute('run')}>{c.labels.run}</ActionButton>
        </fieldset>}
      </div>
      <RuntimeNotices controller={c} />
      {c.snapshotUnavailable && <p role="alert">{c.locale === 'ru' ? 'Текущее состояние недоступно. Сохраненные сведения не подтверждают актуальность результата; действия отключены.' : 'Current state unavailable. Saved information does not confirm the current result; actions are disabled.'}</p>}
      <nav role="tablist" aria-label={title} className="diagnostic-chapters">
        {pages.map((name, index) => <button key={name} id={`diagnostic-tab-${name}`} role="tab" type="button" aria-selected={page === name}
          aria-controls="diagnostic-content" tabIndex={page === name ? 0 : -1} onClick={() => c.setDiagnosticPage(name)} onKeyDown={event => {
            const next = event.key === 'ArrowRight' ? (index + 1) % pages.length : event.key === 'ArrowLeft' ? (index + pages.length - 1) % pages.length
              : event.key === 'Home' ? 0 : event.key === 'End' ? pages.length - 1 : null;
            if (next === null) return; event.preventDefault(); const target = pages[next]!;
            c.setDiagnosticPage(target); document.getElementById(`diagnostic-tab-${target}`)?.focus();
          }}>{names[name][c.locale === 'ru' ? 0 : 1]}</button>)}
      </nav>
      <div id="diagnostic-content" role="tabpanel" aria-labelledby={`diagnostic-tab-${page}`} tabIndex={0}>
        {!s ? <p role="status">{c.loading ? c.labels.loading : c.labels.noRuns}</p> : <>
          <details className="diagnostic-version"><summary>{c.locale === 'ru' ? 'Версия запуска' : 'Run version'}</summary>
            <dl><dt>Run</dt><dd><code>{s.runId}</code></dd><dt>{c.locale === 'ru' ? 'Версия плана' : 'Plan version'}</dt><dd data-testid="plan-version">{s.planVersion ?? '—'}</dd>
              <dt>{c.labels.revision}</dt><dd data-testid="run-revision">{s.revision ?? '—'}</dd><dt>{c.labels.planHash}</dt><dd><code>{s.planHash}</code></dd></dl>
          </details>
          {page === 'result' && <TaskOverview key={s.runId} snapshot={s} plan={c.plan} busy={c.busy || Boolean(c.pending)} unavailable={c.snapshotUnavailable}
            execution={c.execution} feedback={c.planFeedbackDraft} onFeedbackChange={c.setPlanFeedbackDraft}
            contextOpen={c.taskContextOpen} onContextChange={c.setTaskContextOpen} feedbackOpen={c.planFeedbackOpen} onFeedbackToggle={c.setPlanFeedbackOpen}
            actions={{ ...c.overviewActions, onClarify: () => { c.overviewActions.onClarify(); onQuest(); } }} />}
          {(page === 'nodes' || page === 'evidence') && <DiagnosticNodes controller={c} evidence={page === 'evidence'} />}
          {page === 'history' && <HistoryPanel events={c.events} locale={c.locale} />}
          {page === 'plan' && s.workflow !== 'autonomous' && <>
            <button className="game-text-action" type="button" disabled={c.busy || Boolean(c.pending) || c.snapshotUnavailable || !getCapability(s.capabilities, 'requestReplan').allowed} onClick={c.requestReplan}>{c.planningActionLabel}</button>
            <PlanPanel plan={c.plan} runs={c.runs.filter(run => run.runId !== c.selectedRunId)} compareRunId={c.compareRunId} comparePlan={c.comparePlan}
              compareLoading={c.compareLoading} compareError={c.compareError} locale={c.locale} onCompare={c.selectComparison} />
          </>}
        </>}
      </div>
    </div>
  </section>;
}
