import { useModalLifecycle } from './use-modal';
import React, { useState } from 'react';
import type { Artifact, GateSnapshot, GraphNodeSnapshot, GraphPlan, Receipt } from './contracts';
import { humanText, nodeTitle } from './presentation';
import { COPY, type Locale } from './ui-copy';
import { getCapability } from './ui-controls';

export type Evidence = { type: 'receipt'; value: Receipt } | { type: 'artifact'; value: Artifact };


export function DraftDialog({
  locale,
  plan,
  runId,
  planHash,
  expectedRevision,
  busy,
  onClose,
  onSubmit,
}: {
  locale: Locale;
  plan: GraphPlan;
  runId: string;
  planHash: string;
  expectedRevision: number;
  busy: boolean;
  onClose: () => void;
  onSubmit: (
    nodes: unknown[],
    binding: { runId: string; planHash: string; expectedRevision: number },
  ) => void;
}) {
  const labels = COPY[locale];
  const { dialogRef, onCancel } = useModalLifecycle(onClose);
  const [binding] = useState({ runId, planHash, expectedRevision });
  const [value, setValue] = useState(JSON.stringify(plan.nodes, null, 2));
  const [error, setError] = useState('');
  return (
    <dialog
      className="sheet-dialog"
      ref={dialogRef}
      onCancel={onCancel}
      aria-labelledby="draft-title"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          try {
            const nodes = JSON.parse(value);
            if (!Array.isArray(nodes)) throw new Error();
            setError('');
            onSubmit(nodes, binding);
          } catch {
            setError(labels.invalidJson);
          }
        }}
      >
        <header>
          <div>
            <h2 id="draft-title">{labels.draftTitle}</h2>
            <p>{labels.draftHint}</p>
          </div>
          <button className="button quiet" onClick={onClose} type="button">
            {labels.cancel}
          </button>
        </header>
        <textarea
          className="code-editor"
          aria-label={locale === 'ru' ? 'JSON nodes новой версии' : 'New version nodes JSON'}
          spellCheck={false}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          aria-describedby="draft-error"
        />
        {error && (
          <p className="field-error" id="draft-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button className="button quiet" onClick={onClose} type="button">
            {labels.cancel}
          </button>
          <button className="button primary" disabled={busy} type="submit">
            {labels.validateReplan}
          </button>
        </div>
      </form>
    </dialog>
  );
}

export const GateDialog = React.forwardRef<
  HTMLDialogElement,
  {
    gate: GateSnapshot | null;
    node: GraphNodeSnapshot | null;
    planNodes: GraphNodeSnapshot[];
    locale: Locale;
    busy: boolean;
    onClose: () => void;
    onSubmit: (decision: 'approve' | 'accept' | 'reject', reason: string) => void;
  }
>(function GateDialog({ gate, node, planNodes, locale, busy, onClose, onSubmit }, ref) {
  const labels = COPY[locale];
  const [confirmed, setConfirmed] = useState(false);
  const [reject, setReject] = useState(false);
  const [reason, setReason] = useState('');
  if (!gate) return <dialog ref={ref} />;
  const skills = [...new Set(planNodes.flatMap(item => item.skills.map(skill => `${skill.id} · ${skill.hash.slice(0, 12)}`)))];
  const checks = planNodes.filter(item => item.action.kind === 'checks');
  const decision = reject ? 'reject' : gate.type === 'accept-result' ? 'accept' : 'approve';
  const capability = getCapability(
    node?.capabilities ?? {},
    reject ? 'reject' : gate.type === 'accept-result' ? 'accept' : 'approve',
  );
  return (
    <dialog
      className="gate-dialog"
      ref={ref}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      aria-labelledby="gate-title"
    >
      <form
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (confirmed && capability.allowed && (!reject || reason.trim()))
            onSubmit(decision, reason.trim());
        }}
      >
        <header>
          <div>
            <h2 id="gate-title">{labels.gateTitle}</h2>
            <p>{humanText(gate.title, locale)}</p>
          </div>
          <button className="button quiet" onClick={onClose} type="button">
            {labels.cancel}
          </button>
        </header>
        <dl className="gate-facts">
          <dt>{labels.planHash}</dt>
          <dd>
            <code>{gate.planHash}</code>
          </dd>
          <dt>{labels.scope}</dt>
          <dd>{gate.scope.join('\n')}</dd>
          <dt>{locale === 'ru' ? 'Пути для чтения' : 'Read paths'}</dt>
          <dd>{gate.readPaths?.join('\n') || labels.none}</dd>
          <dt>{labels.permissions}</dt>
          <dd>{gate.requiredPermissions.join('\n') || labels.none}</dd>
          <dt>{labels.skills}</dt>
          <dd>{skills.join('\n') || labels.none}</dd>
          <dt>{labels.checks}</dt>
          <dd>{checks.map(item => `${nodeTitle(item, locale)} (${item.action.id})`).join('\n') || (locale === 'ru' ? 'В этой версии плана не указаны' : 'Not specified in this plan')}</dd>
          <dt>{labels.risks}</dt>
          <dd>{gate.risks.join('\n')}</dd>
          <dt>{labels.evidence}</dt>
          <dd>{gate.evidence.length ? `${gate.evidence.length} ${locale === 'ru' ? 'материалов' : 'artifacts'}` : labels.none}</dd>
          <dt>{labels.consequences}</dt>
          <dd>{reject ? gate.consequences.reject : gate.consequences.approve}</dd>
        </dl>
        <label className="confirmation">
          <input
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
            type="checkbox"
          />
          {gate.type === 'provider-consent' && locale === 'ru'
            ? 'Я понимаю, что flowcairn передаст только перечисленные данные выбранному AI-провайдеру.'
            : labels.confirmation}
        </label>
        <label className="confirmation">
          <input
            checked={reject}
            onChange={(event) => setReject(event.target.checked)}
            type="checkbox"
          />
          {labels.reject}
        </label>
        {reject && (
          <label>
            {labels.reason}
            <textarea
              required
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={1000}
            />
          </label>
        )}
        <div className="dialog-actions">
          <button className="button quiet" onClick={onClose} type="button">
            {labels.cancel}
          </button>
          <button
            className={reject ? 'button danger' : 'button primary'}
            disabled={!confirmed || !capability.allowed || busy || (reject && !reason.trim())}
            title={capability.allowed ? undefined : humanText(capability.reason) || undefined}
            type="submit"
          >
            {busy ? '…' : labels.submitDecision}
          </button>
        </div>
      </form>
    </dialog>
  );
});

export function EvidenceDialog({
  evidence,
  locale,
  onClose,
}: {
  evidence: Evidence;
  locale: Locale;
  onClose: () => void;
}) {
  const labels = COPY[locale];
  const { dialogRef, onCancel } = useModalLifecycle(onClose);
  const content =
    evidence.type === 'artifact' ? evidence.value.content : JSON.stringify(evidence.value, null, 2);
  return (
    <dialog
      className="evidence-dialog"
      ref={dialogRef}
      onCancel={onCancel}
      aria-labelledby="evidence-title"
    >
      <header>
        <div>
          <h2 id="evidence-title">
            {evidence.type === 'artifact'
              ? evidence.value.title
              : `${locale === 'ru' ? 'Отчет проверки' : 'Check report'} ${evidence.value.attempt}`}
          </h2>
          <p>
            {evidence.type === 'artifact'
              ? `${evidence.value.kind} · ${evidence.value.mediaType}`
              : `${evidence.value.verdict} · ${evidence.value.phase}`}
          </p>
        </div>
        <button className="button quiet" onClick={onClose} type="button">
          {labels.dismiss}
        </button>
      </header>
      <pre>{content}</pre>
    </dialog>
  );
}
