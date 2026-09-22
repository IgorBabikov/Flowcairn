import React from 'react';
import type { ApiError, Capability, CapabilityName, RunSummary, Snapshot } from './contracts';
import type { TaskProof } from './proof-contracts';
import type { PendingOperation } from './control-operations';
import { humanText, runtimeProblem } from './presentation';
import { COPY, statusLabel, formatDate, type Locale } from './ui-copy';
import { TechnicalDetails } from './TechnicalDetails';

export function getCapability(set: Partial<Record<CapabilityName, Capability>>, name: CapabilityName) {
  return set[name] ?? { allowed: false, reason: 'Сервер не сообщил о доступности действия' };
}

export function ActionButton({
  capability,
  children,
  onClick,
  compact = false,
}: {
  capability: Capability;
  children: React.ReactNode;
  onClick: () => void;
  compact?: boolean;
}) {
  if (!capability.allowed) return null;
  return (
    <button
      className={compact ? 'button compact' : 'button'}
      disabled={!capability.allowed}
      onClick={onClick}
      title={capability.allowed ? undefined : humanText(capability.reason) || undefined}
      type="button"
    >
      {children}
    </button>
  );
}

export function RunButton({
  run,
  locale,
  proof,
  proofUnavailable,
  active,
  onClick,
}: {
  run: RunSummary;
  locale: Locale;
  proof?: TaskProof | undefined;
  proofUnavailable: boolean;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      aria-current={active ? 'page' : undefined}
      className={`run-row${active ? ' active' : ''}`}
      onClick={onClick}
      type="button"
    >
      <span className={`status-mark status-${proofUnavailable ? 'uncertain' : proof && proof.status !== 'PROVEN' && run.status === 'passed' ? 'waiting-for-human' : run.status}`} aria-hidden="true" />
      <span>
        <strong>{run.task?.taskNumber ?? run.task?.id ?? run.runId}</strong>
        <small>{run.task?.goal ?? run.integrity.reason ?? run.runId}</small>
        <small title={run.runId}>Версия плана {run.planVersion ?? '—'}</small>
      </span>
      <em>{proofUnavailable ? (locale === 'ru' ? 'Состояние недоступно' : 'State unavailable') : proof?.status === 'PROVEN' ? (locale === 'ru' ? 'Результат подтвержден' : 'Result confirmed') : run.status === 'passed' ? (locale === 'ru' ? proof ? 'Не подтверждено' : 'Исполнение завершено' : proof ? 'Not confirmed' : 'Execution finished') : statusLabel(run.status, locale, run.resolutionKind) ?? run.status}</em>
    </button>
  );
}

export function RunHealth({ snapshot, locale }: { snapshot: Snapshot; locale: Locale }) {
  const labels = COPY[locale];
  return (
    <section className="run-health">
      <h3>{labels.status}</h3>
      <dl>
        <dt>{labels.integrity}</dt>
        <dd className={snapshot.integrity.valid ? 'positive' : 'negative'}>
          {snapshot.integrity.valid ? labels.healthy : humanText(snapshot.integrity.reason, locale)}
        </dd>
        <dt>{labels.runner} AI</dt>
        <dd>
          {snapshot.runner?.ai.available
            ? locale === 'ru'
              ? 'Провайдер настроен'
              : 'Provider configured'
            : humanText(snapshot.runner?.ai.reason, locale) || labels.unavailable}
        </dd>
        <dt>
          {labels.runner} {labels.checks.toLowerCase()}
        </dt>
        <dd>
          {snapshot.runner?.checks.available
            ? locale === 'ru'
              ? 'Доступны'
              : 'Available'
            : humanText(snapshot.runner?.checks.reason, locale) || labels.unavailable}
        </dd>
        <dt>{labels.updated}</dt>
        <dd>{formatDate(snapshot.updatedAt, locale)}</dd>
      </dl>
    </section>
  );
}

export function ErrorNotice({
  error,
  labels,
  pending,
  busy,
  onRetry,
  onDismiss,
}: {
  error: ApiError;
  labels: (typeof COPY)[Locale];
  pending: PendingOperation | null;
  busy: boolean;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const problem = runtimeProblem(`${error.code}: ${error.message}`);
  return (
    <section className="error-banner" role="alert">
      <div>
        <strong>{problem?.title ?? labels.operationFailed}</strong>
        <p>
          {(problem?.summary ?? humanText(error.message)) || 'Не удалось завершить действие.'}
        </p>
        {problem && <p className="error-next-step"><strong>Что делать:</strong> {problem.action}</p>}
        <TechnicalDetails code={error.code} message={error.message} />
      </div>
      <div>
        {(pending || error.retryable) && (
          <button className="button" disabled={busy} onClick={onRetry} type="button">
            {pending ? labels.retrySame : labels.retryLoad}
          </button>
        )}
        <button className="button quiet" onClick={onDismiss} type="button">
          {labels.dismiss}
        </button>
      </div>
    </section>
  );
}

export function LoadingState({ label }: { label: string }) {
  return (
    <main className="loading-state" aria-busy="true">
      <div className="loading-mark">
        <i />
        <i />
        <i />
      </div>
      <p>{label}</p>
      <div className="skeleton" />
      <div className="skeleton short" />
    </main>
  );
}
export function MissingSession({ labels }: { labels: (typeof COPY)[Locale] }) {
  return (
    <main className="render-error" role="alert">
      <h1>{labels.missingSession}</h1>
      <p>{labels.missingSessionHint}</p>
    </main>
  );
}
export function EmptyGraph({ labels }: { labels: (typeof COPY)[Locale] }) {
  return (
    <div className="empty-graph">
      <div className="empty-path" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <h2>{labels.graph}</h2>
      <p>{labels.noRuns}</p>
    </div>
  );
}

export class AppErrorBoundary extends React.Component<
  { children: React.ReactNode; locale?: Locale },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      const locale = this.props.locale ?? 'ru';
      return (
        <main className="render-error" role="alert">
          <h1>{locale === 'ru' ? 'Интерфейс не отобразился' : 'The interface could not render'}</h1>
          <p>
            {locale === 'ru'
              ? 'Сохраненное состояние не изменено. Перезагрузите viewer.'
              : 'Committed state is unchanged. Reload the viewer.'}
          </p>
          <button className="button primary" onClick={() => window.location.reload()} type="button">
            {locale === 'ru' ? 'Перезагрузить' : 'Reload'}
          </button>
        </main>
      );
    }
    return this.props.children;
  }
}
