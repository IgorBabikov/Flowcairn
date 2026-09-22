import type { ApiError, ArtifactSummary, CapabilityName, GraphNodeSnapshot, GraphPlan, HistoryEvent, RunSummary } from './contracts';
import { humanText, nodeTitle } from './presentation';
import { COPY, STATUS, statusLabel, formatDate, formatDuration, type Locale } from './ui-copy';
import { ActionButton, getCapability } from './ui-controls';

export function NodeDetails({
  node,
  locale,
  busy,
  onAction,
  onGate,
  onReplan,
  replanLabel,
}: {
  node: GraphNodeSnapshot;
  locale: Locale;
  busy: boolean;
  onAction: (action: 'run' | 'retry' | 'rerun-check' | 'recover') => void;
  onGate: () => void;
  onReplan: () => void;
  replanLabel: string;
}) {
  const labels = COPY[locale];
  const actionKinds: Record<string, string> = {
    analysis: 'Анализ', planning: 'Планирование', implementation: 'Внесение изменений',
    checks: 'Проверки', review: 'Проверка изменений', gate: 'Согласование', handoff: 'Передача результата',
    deterministic: 'Детерминированная проверка', ai: 'AI-исполнитель',
  };
  const actions: Array<['run' | 'retry' | 'rerun-check' | 'recover', CapabilityName, string]> = [
    ['run', 'run', labels.run],
    ['retry', 'retry', labels.retry],
    ['rerun-check', 'rerunCheck', labels.rerunCheck],
    ['recover', 'recover', labels.recover],
  ];
  const gateCapability = node.capabilities.approve?.allowed
    ? node.capabilities.approve
    : node.capabilities.accept?.allowed
      ? node.capabilities.accept
      : null;
  return (
    <article className="node-details">
      <header>
        <span className={`status-chip status-${node.status}`}>{statusLabel(node.status, locale, node.resolutionKind)}</span>
        <h2>{nodeTitle(node, locale)}</h2>
        <p>{humanText(node.outcome, locale)}</p>
      </header>
      {node.reason && (
        <div className="runtime-reason" role="status">
          {locale === 'ru' ? 'Причина остановки' : 'Runtime reason'}:{' '}
          {humanText(node.reason, locale)}
        </div>
      )}
      <div className="detail-actions">
        {actions.map(([action, name, label]) => (
          <ActionButton
            key={action}
            capability={getCapability(node.capabilities, name)}
            onClick={() => onAction(action)}
          >
            {busy ? '…' : label}
          </ActionButton>
        ))}
        {gateCapability && (
          <ActionButton capability={gateCapability} onClick={onGate}>
            {node.capabilities.accept?.allowed ? labels.accept : labels.approve}
          </ActionButton>
        )}
        <ActionButton
          capability={getCapability(node.capabilities, 'requestReplan')}
          onClick={onReplan}
        >
          {replanLabel}
        </ActionButton>
      </div>
      <dl className="fact-list">
        <dt>{locale === 'ru' ? 'Действие' : 'Action'}</dt>
        <dd>{node.action.id}</dd>
        <dt>{locale === 'ru' ? 'Тип действия' : 'Action type'}</dt>
        <dd>{locale === 'ru' ? actionKinds[node.action.kind] ?? node.action.kind : node.action.kind}</dd>
        <dt>{labels.mode}</dt>
        <dd>{node.mode === 'write' ? labels.write : labels.read}</dd>
        <dt>{labels.attempt}</dt>
        <dd>{node.attempt}</dd>
        <dt>{labels.duration}</dt>
        <dd>{formatDuration(node.durationMs, locale)}</dd>
        <dt>{labels.dependencies}</dt>
        <dd>{node.needs.join(', ') || labels.none}</dd>
        <dt>{labels.permissions}</dt>
        <dd>{node.permissions.join(', ') || labels.none}</dd>
        <dt>{locale === 'ru' ? 'Пути для чтения' : 'Read paths'}</dt>
        <dd>{node.resources?.reads.join('\n') || labels.none}</dd>
        <dt>{locale === 'ru' ? 'Пути для записи' : 'Write paths'}</dt>
        <dd>{node.resources?.writes.join('\n') || labels.none}</dd>
        <dt>{labels.skills}</dt>
        <dd>
          {node.skills.map((skill) => `${skill.id} · ${skill.hash.slice(0, 8)}`).join('\n') ||
            labels.none}
        </dd>
      </dl>
      {node.changedFiles.length > 0 && (
        <section>
          <h3>{labels.changes}</h3>
          <ul className="path-list">
            {node.changedFiles.map((file) => (
              <li key={file}>
                <code>{file}</code>
              </li>
            ))}
          </ul>
        </section>
      )}
      {node.checks.length > 0 && (
        <section>
          <h3>{labels.checks}</h3>
          {node.checks.map((check) => (
            <div className="check-row" key={check.id}>
              <b>{check.id}</b>
              <span>
                {check.passed ? STATUS[locale].passed : STATUS[locale].failed} ·{' '}
                {formatDuration(check.durationMs, locale)}
              </span>
              <small>{humanText(check.summary, locale)}</small>
            </div>
          ))}
        </section>
      )}
    </article>
  );
}

export function EvidenceList({
  node,
  planning,
  locale,
  onReceipt,
  onArtifact,
}: {
  node: GraphNodeSnapshot | null;
  planning: ArtifactSummary[];
  locale: Locale;
  onReceipt: (hash: string) => void;
  onArtifact: (hash: string) => void;
}) {
  const labels = COPY[locale];
  if (!node && planning.length === 0) return <p className="empty-copy">{labels.selectNode}</p>;
  return (
    <div className="evidence-list">
      <h2>{node ? nodeTitle(node, locale) : labels.evidence}</h2>
      {node?.sourceRunId && <p className="field-hint">Сохраненный анализ из предыдущей версии. Отчеты относятся к исходному запуску <code>{node.sourceRunId}</code>, план <code>{node.sourcePlanHash?.slice(0, 12)}</code>.</p>}
      {node?.receiptIds.map((hash, index) => (
        <button key={hash} onClick={() => onReceipt(hash)} type="button">
          <span>
            {locale === 'ru' ? 'Отчет' : 'Receipt'} {index + 1}
          </span>
          <code>{hash.slice(0, 12)}</code>
        </button>
      ))}
      {[...planning, ...(node?.artifacts ?? [])].map((artifact) => (
        <button key={artifact.id} onClick={() => onArtifact(artifact.id)} type="button">
          <span>{artifact.title}</span>
          <small>
            {artifact.kind} · {Math.ceil(artifact.size / 1024)} KiB
          </small>
        </button>
      ))}
      {!node?.receiptIds.length && !node?.artifacts.length && planning.length === 0 && (
        <p className="empty-copy">{labels.none}</p>
      )}
    </div>
  );
}

export function HistoryPanel({ events, locale }: { events: HistoryEvent[]; locale: Locale }) {
  const labels = COPY[locale];
  if (events.length === 0) return <p className="empty-copy">{labels.none}</p>;
  return (
    <ol className="timeline">
      {events.map((event, index) => {
        const previous = events[index - 1];
        const changes = event.nodes.filter((node) => {
          const before = previous?.nodes.find((item) => item.id === node.id);
          return (
            !before ||
            before.status !== node.status ||
            before.attempt !== node.attempt ||
            before.receiptIds.length !== node.receiptIds.length
          );
        });
        return (
          <li key={event.revision}>
            <div>
              <strong>r{event.revision}</strong>
              <time>{formatDate(event.at, locale)}</time>
            </div>
            <span className={`status-chip status-${event.status}`}>
              {STATUS[locale][event.status]}
            </span>
            {changes.map((node) => (
              <small key={node.id}>
                {node.id}: {STATUS[locale][node.status]} · {labels.attempt} {node.attempt} ·{' '}
                {node.receiptIds.length} {locale === 'ru' ? 'отчетов' : 'receipts'}
              </small>
            ))}
          </li>
        );
      })}
    </ol>
  );
}

function planChanges(plan: GraphPlan | null, other: GraphPlan | null): string[] {
  if (!plan || !other) return [];
  const left = new Map(plan.nodes.map((node) => [node.id, node]));
  const right = new Map(other.nodes.map((node) => [node.id, node]));
  return [...new Set([...left.keys(), ...right.keys()])]
    .sort()
    .filter((id) => JSON.stringify(left.get(id)) !== JSON.stringify(right.get(id)))
    .map((id) => (!left.has(id) ? `+ ${id}` : !right.has(id) ? `− ${id}` : `~ ${id}`));
}

export function PlanPanel({
  plan,
  runs,
  compareRunId,
  comparePlan,
  compareLoading,
  compareError,
  locale,
  onCompare,
}: {
  plan: GraphPlan | null;
  runs: RunSummary[];
  compareRunId: string;
  comparePlan: GraphPlan | null;
  compareLoading: boolean;
  compareError: ApiError | null;
  locale: Locale;
  onCompare: (id: string) => void;
}) {
  const labels = COPY[locale];
  const changes = planChanges(plan, comparePlan);
  if (!plan) return <p className="empty-copy">{labels.unavailable}</p>;
  return (
    <div className="plan-panel">
      <h2>
        {labels.plan} v{plan.version}
      </h2>
      <dl className="fact-list">
        <dt>{labels.taskHash}</dt>
        <dd>
          <code>{plan.taskHash.slice(0, 12)}</code>
        </dd>
        <dt>Runtime</dt>
        <dd>
          <code>{plan.runtimeHash.slice(0, 12)}</code>
        </dd>
        <dt>Registry</dt>
        <dd>
          <code>{plan.registryHash.slice(0, 12)}</code>
        </dd>
        <dt>Policy</dt>
        <dd>
          <code>{plan.policyHash.slice(0, 12)}</code>
        </dd>
      </dl>
      <label>
        {labels.compare}
        <select value={compareRunId} onChange={(event) => void onCompare(event.target.value)}>
          <option value="">—</option>
          {runs.map((run) => (
            <option key={run.runId} value={run.runId}>
              {run.task?.id ?? run.runId} · v{run.planVersion ?? '?'}
            </option>
          ))}
        </select>
      </label>
      {compareRunId && (
        <div className="plan-diff" aria-live="polite">
          {compareLoading ? (
            <p>{labels.compareLoading}</p>
          ) : compareError ? (
            <p role="alert">
              {labels.compareFailed} {compareError.code}
            </p>
          ) : changes.length ? (
            changes.map((line) => <code key={line}>{line}</code>)
          ) : comparePlan ? (
            <p>{labels.noDiff}</p>
          ) : null}
        </div>
      )}
      <details>
        <summary>{locale === 'ru' ? 'Этапы плана' : 'Plan nodes'}</summary>
        <pre>{JSON.stringify(plan.nodes, null, 2)}</pre>
      </details>
    </div>
  );
}
