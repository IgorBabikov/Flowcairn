import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  MarkerType,
  useUpdateNodeInternals,
  NodeToolbar,
  Position,
  ReactFlow,
  type ReactFlowInstance,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { api, sessionToken, watchRevisions } from './api';
import { humanText, nodeTitle, statusHint, StatusIcon } from './presentation';
import { graphLayout } from './graph-layout';
import { TaskComposer } from './TaskComposer';
import { WorkflowPanel } from './WorkflowPanel';
import { SetupPanel } from './SetupPanel';
import { workflowProjection } from './workflow-projection';
import type {
  ApiError,
  Artifact,
  ArtifactSummary,
  Capability,
  CapabilityName,
  GateSnapshot,
  GraphNodeSnapshot,
  GraphPlan,
  HistoryEvent,
  Receipt,
  RunStatus,
  RunSummary,
  ProjectContext,
  Snapshot,
  IntakeInput,
  TaskFields,
} from './contracts';

type Locale = 'ru' | 'en';
type Evidence = { type: 'receipt'; value: Receipt } | { type: 'artifact'; value: Artifact };
type PendingControlOperation = {
  kind: 'control';
  key: string;
  operationId: string;
  runId: string;
  action: string;
  request: Parameters<typeof api.control>[2];
};
type PendingCreateOperation = {
  kind: 'create';
  key: 'create';
  operationId: string;
  input: IntakeInput;
};
type PendingOperation = PendingControlOperation | PendingCreateOperation;
type SnapshotRefresh = {
  promise: Promise<void>;
  targetRevision: number;
  reportErrors: boolean;
};

const COPY = {
  ru: {
    title: 'Flowcairn',
    subtitle: 'От задачи до проверенного результата.',
    runs: 'Запуски',
    active: 'Активные',
    archive: 'История',
    create: 'Новая задача',
    noRuns: 'Опишите, что нужно сделать. Здесь появится план работы.',
    loading: 'Загружаем сохраненное состояние…',
    retryLoad: 'Повторить загрузку',
    graph: 'Граф выполнения',
    fitAll: 'Весь граф',
    focusCurrent: 'Текущий этап',
    details: 'Детали',
    selectNode: 'Выберите этап, чтобы увидеть права, результаты и доступные действия.',
    run: 'Запустить',
    retry: 'Повторить',
    recover: 'Восстановить',
    stop: 'Остановить',
    rerunCheck: 'Повторить проверку',
    replan: 'Новая версия плана',
    receipt: 'Открыть отчет',
    history: 'Изменения',
    plan: 'План',
    evidence: 'Результаты',
    overview: 'Обзор',
    attempt: 'Попытка',
    duration: 'Длительность',
    mode: 'Режим',
    read: 'Чтение',
    write: 'Запись',
    permissions: 'Права',
    skills: 'Инструкции',
    dependencies: 'Зависимости',
    changes: 'Измененные файлы',
    checks: 'Проверки',
    none: 'Нет',
    unavailable: 'Недоступно',
    integrity: 'Целостность',
    healthy: 'Подтверждена',
    runner: 'Исполнитель',
    compare: 'Сравнить план',
    noDiff: 'Структура планов совпадает.',
    compareLoading: 'Загружаем план для сравнения…',
    compareFailed: 'Не удалось загрузить план для сравнения.',
    refresh: 'Обновить',
    language: 'На английском',
    theme: 'Сменить тему',
    live: 'На связи',
    disconnected: 'Обновляем состояние',
    operationFailed: 'Операция не подтверждена',
    retrySame: 'Повторить тот же запрос',
    dismiss: 'Закрыть',
    gateTitle: 'Подтвердите решение',
    approve: 'Подтвердить план',
    accept: 'Принять результат',
    reject: 'Отклонить',
    confirmation: 'Я проверил границы задачи, риски, результаты и последствия.',
    reason: 'Причина отклонения',
    submitDecision: 'Зафиксировать решение',
    cancel: 'Отмена',
    scope: 'Границы задачи',
    risks: 'Риски',
    consequences: 'Последствия',
    planHash: 'Хеш плана',
    draftTitle: 'Черновик новой версии',
    draftHint: 'Редактируется только копия этапов. Активный план остается неизменяемым.',
    validateReplan: 'Отправить на серверную проверку',
    invalidJson: 'Исправьте JSON черновика перед отправкой.',
    status: 'Статус',
    revision: 'Ревизия',
    updated: 'Обновлен',
    taskHash: 'Хеш задачи',
    missingSession: 'Нет локальной сессии управления',
    missingSessionHint: 'Запустите flowcairn ui --root PROJECT и откройте ссылку из терминала.',
  },
  en: {
    title: 'Flowcairn',
    subtitle: 'Plan, permissions, and evidence from one local Executor.',
    runs: 'Runs',
    active: 'Active',
    archive: 'History',
    create: 'New run',
    noRuns: 'No runs yet. Create a task with exact scope and acceptance.',
    loading: 'Loading committed state…',
    retryLoad: 'Retry loading',
    graph: 'Execution graph',
    fitAll: 'Fit all',
    focusCurrent: 'Current step',
    details: 'Details',
    selectNode: 'Select a step to inspect permissions, evidence, and available actions.',
    run: 'Run',
    retry: 'Retry',
    recover: 'Recover',
    stop: 'Stop',
    rerunCheck: 'Rerun check',
    replan: 'New plan version',
    receipt: 'Open receipt',
    history: 'Changes',
    plan: 'Plan',
    evidence: 'Evidence',
    overview: 'Overview',
    attempt: 'Attempt',
    duration: 'Duration',
    mode: 'Mode',
    read: 'Read',
    write: 'Write',
    permissions: 'Permissions',
    skills: 'Skills',
    dependencies: 'Dependencies',
    changes: 'Changed files',
    checks: 'Checks',
    none: 'None',
    unavailable: 'Unavailable',
    integrity: 'Integrity',
    healthy: 'Verified',
    runner: 'Runner',
    compare: 'Compare plan',
    noDiff: 'Plan structures match.',
    compareLoading: 'Loading comparison plan…',
    compareFailed: 'Could not load the comparison plan.',
    refresh: 'Refresh',
    language: 'Русский',
    theme: 'Switch theme',
    live: 'State is updating from the service',
    disconnected: 'Live channel is unavailable; 2-second polling remains active.',
    operationFailed: 'Operation was not confirmed',
    retrySame: 'Retry the same request',
    dismiss: 'Dismiss',
    gateTitle: 'Confirm the decision',
    approve: 'Approve plan',
    accept: 'Accept result',
    reject: 'Reject',
    confirmation: 'I reviewed the scope, risks, evidence, and consequences.',
    reason: 'Rejection reason',
    submitDecision: 'Record decision',
    cancel: 'Cancel',
    scope: 'Scope',
    risks: 'Risks',
    consequences: 'Consequences',
    planHash: 'Plan hash',
    draftTitle: 'New version draft',
    draftHint: 'Only a copy of nodes is editable. The active plan remains immutable.',
    validateReplan: 'Send for server validation',
    invalidJson: 'Fix the draft JSON before submitting.',
    status: 'Status',
    revision: 'Revision',
    updated: 'Updated',
    taskHash: 'Task hash',
    missingSession: 'Local control session is missing',
    missingSessionHint:
      'Run flowcairn ui --root PROJECT and open the URL printed in your terminal.',
  },
} as const;

const STATUS: Record<Locale, Record<RunStatus, string>> = {
  ru: {
    idle: 'Не начат',
    waiting: 'Ожидает решения',
    pending: 'В очереди',
    ready: 'Готов к запуску',
    running: 'Выполняется',
    'waiting-for-human': 'Нужно решение',
    passed: 'Завершен',
    failed: 'Ошибка',
    uncertain: 'Результат неизвестен',
    stale: 'Устарел',
  },
  en: {
    idle: 'Idle',
    waiting: 'Waiting',
    pending: 'Pending',
    ready: 'Ready',
    running: 'Running',
    'waiting-for-human': 'Decision needed',
    passed: 'Passed',
    failed: 'Failed',
    uncertain: 'Needs inspection',
    stale: 'Stale',
  },
};

function operationId(prefix = 'ui'): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function formatDuration(value: number | null | undefined, locale: Locale = 'ru'): string {
  if (value == null) return '—';
  if (value < 1000) return `${Math.round(value)} ${locale === 'ru' ? 'мс' : 'ms'}`;
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} ${locale === 'ru' ? 'с' : 's'}`;
}

function formatDate(value: string | null | undefined, locale: Locale): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat(locale === 'ru' ? 'ru-RU' : 'en-US', {
        dateStyle: 'short',
        timeStyle: 'medium',
      }).format(date);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

async function hashPlan(value: GraphPlan): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalJson(value)),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function useModalLifecycle(onClose: () => void) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const dialog = dialogRef.current;
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    return () => {
      if (dialog?.open) dialog.close();
      returnFocusRef.current?.focus();
    };
  }, []);
  return {
    dialogRef,
    onCancel: (event: React.SyntheticEvent<HTMLDialogElement>) => {
      event.preventDefault();
      onCloseRef.current();
    },
  };
}

function getCapability(set: Partial<Record<CapabilityName, Capability>>, name: CapabilityName) {
  return set[name] ?? { allowed: false, reason: 'Сервер не сообщил о доступности действия' };
}

function taskLifecycleKey(run: RunSummary): string {
  const task = run.task;
  return task?.id && task.taskNumber ? `${task.id}\u0000${task.taskNumber}` : run.runId;
}

function isNewerPlan(candidate: RunSummary, current: RunSummary): boolean {
  const candidateVersion = candidate.planVersion ?? -1;
  const currentVersion = current.planVersion ?? -1;
  if (candidateVersion !== currentVersion) return candidateVersion > currentVersion;
  if ((candidate.updatedAt ?? '') !== (current.updatedAt ?? ''))
    return (candidate.updatedAt ?? '') > (current.updatedAt ?? '');
  return candidate.runId > current.runId;
}

/** One task lifecycle is shown once, always at its newest immutable plan version. */
function newestRunsByTask(runs: RunSummary[]): RunSummary[] {
  const latest = new Map<string, RunSummary>();
  for (const run of runs) {
    const key = taskLifecycleKey(run);
    const current = latest.get(key);
    if (!current || isNewerPlan(run, current)) latest.set(key, run);
  }
  return runs.filter((run) => latest.get(taskLifecycleKey(run)) === run);
}

function relevantNodeId(snapshot: Snapshot): string | null {
  const ids = new Set(snapshot.nodes.map((node) => node.id));
  if (snapshot.activeNodeId && ids.has(snapshot.activeNodeId)) return snapshot.activeNodeId;
  const gate = snapshot.gates.find((item) => ids.has(item.nodeId));
  if (gate) return gate.nodeId;
  const blocked = snapshot.nodes.find((node) => ['failed', 'uncertain'].includes(node.status));
  if (blocked) return blocked.id;
  if (snapshot.finalDisposition === 'accepted' || snapshot.status === 'passed')
    return snapshot.nodes.at(-1)?.id ?? null;
  return (
    snapshot.nodes.find((node) =>
      ['running', 'waiting-for-human', 'ready', 'uncertain'].includes(node.status),
    )?.id ??
    snapshot.nodes[0]?.id ??
    null
  );
}

type GraphNodeData = GraphNodeSnapshot &
  Record<string, unknown> & {
    locale: Locale;
    sourcePosition: Position;
    targetPosition: Position;
    selected: boolean;
    onOpen: () => void;
    onAction: (name: 'run' | 'retry' | 'rerun-check' | 'recover') => void;
  };

function ActionButton({
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

function GraphNodeCard({ data }: NodeProps<Node<GraphNodeData, 'operator'>>) {
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => {
    updateNodeInternals(data.id);
  }, [data.id, data.sourcePosition, data.targetPosition, updateNodeInternals]);
  const labels = COPY[data.locale];
  const actions: Array<['run' | 'retry' | 'rerun-check' | 'recover', CapabilityName, string]> = [
    ['run', 'run', labels.run],
    ['retry', 'retry', labels.retry],
    ['rerun-check', 'rerunCheck', labels.rerunCheck],
    ['recover', 'recover', labels.recover],
  ];
  return (
    <article
      aria-current={data.selected ? 'step' : undefined}
      className={`graph-node status-${data.status}${data.selected ? ' selected' : ''}`}
      onClick={data.onOpen}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          data.onOpen();
        }
      }}
      aria-label={`${nodeTitle(data, data.locale)}: ${STATUS[data.locale][data.status]}`}
      role="button"
      tabIndex={0}
    >
      <NodeToolbar
        className="node-toolbar"
        isVisible={
          data.selected &&
          actions.some(([, name]) => getCapability(data.capabilities, name).allowed)
        }
        position={Position.Top}
      >
        {actions.map(([action, capabilityName, label]) => {
          const capability = getCapability(data.capabilities, capabilityName);
          return capability.allowed ? (
            <button
              className="toolbar-action"
              key={action}
              onClick={(event) => {
                event.stopPropagation();
                data.onAction(action);
              }}
              type="button"
            >
              {label}
            </button>
          ) : null;
        })}
      </NodeToolbar>
      <Handle type="target" position={data.targetPosition} isConnectable={false} />
      <div className="node-heading">
        <StatusIcon status={data.status} />
        <span className="node-mode">{data.mode === 'write' ? labels.write : labels.read}</span>
      </div>
      <strong>{nodeTitle(data, data.locale)}</strong>
      <span className="node-status">{STATUS[data.locale][data.status]}</span>
      <span className="node-hint">{statusHint(data.status, data.locale)}</span>
      {!data.sourceRunId && <div className="node-meta">
        <span>
          {labels.attempt}: {data.attempt}
        </span>
        <span>{formatDuration(data.durationMs, data.locale)}</span>
        <span>
          {data.receiptIds.length} {data.locale === 'ru' ? 'отчетов' : 'receipts'}
        </span>
      </div>}
      <Handle type="source" position={data.sourcePosition} isConnectable={false} />
    </article>
  );
}

const NODE_TYPES = { operator: GraphNodeCard };

function layoutNodes(
  snapshot: Snapshot,
  locale: Locale,
  selectedNodeId: string | null,
  onOpen: (id: string) => void,
  onAction: (name: Parameters<GraphNodeData['onAction']>[0], nodeId: string) => void,
): Array<Node<GraphNodeData, 'operator'>> {
  const placements = graphLayout(snapshot.nodes);
  const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
  return Array.from(placements, ([id, placement]) => {
    const item = byId.get(id)!;
    return {
      id: item.id,
      type: 'operator',
      className: `execution-node status-${item.status}`,
      style: { '--node-status-color': `var(--status-${item.status})` } as React.CSSProperties,
      ...placement,
      draggable: false,
      selectable: true,
      data: {
        ...item,
        sourcePosition: placement.sourcePosition,
        targetPosition: placement.targetPosition,
        locale,
        selected: selectedNodeId === item.id,
        onOpen: () => onOpen(item.id),
        onAction: (name) => onAction(name, item.id),
      },
    };
  });
}

export function App() {
  const [locale, setLocale] = useState<Locale>('ru');
  const labels = COPY[locale];
  useEffect(() => {
    const update = () =>
      document.documentElement.toggleAttribute('data-page-hidden', document.hidden);
    update();
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  const authenticated = Boolean(sessionToken());
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [project, setProject] = useState<ProjectContext | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [plan, setPlan] = useState<GraphPlan | null>(null);
  const [events, setEvents] = useState<HistoryEvent[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [tab, setTab] = useState<'overview' | 'evidence' | 'history' | 'plan'>('overview');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [stopError, setStopError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState('');
  const [streamConnected, setStreamConnected] = useState(false);
  const [pending, setPending] = useState<PendingOperation | null>(null);
  const [interruptPending, setInterruptPending] = useState<PendingControlOperation | null>(null);
  const [busy, setBusy] = useState(false);
  const [stopBusy, setStopBusy] = useState(false);
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [compareRunId, setCompareRunId] = useState('');
  const [comparePlan, setComparePlan] = useState<GraphPlan | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareError, setCompareError] = useState<ApiError | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [showDraft, setShowDraft] = useState(false);
  const [gate, setGate] = useState<GateSnapshot | null>(null);
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance | null>(null);
  const gateDialog = useRef<HTMLDialogElement>(null);
  const selectedRunRef = useRef<string | null>(null);
  const snapshotRef = useRef<Snapshot | null>(null);
  const historyRevisionRef = useRef(-1);
  const runsRequestRef = useRef(0);
  const comparisonRequestRef = useRef(0);
  const inFlightRef = useRef(false);
  const stopInFlightRef = useRef(false);
  const pollInFlightRef = useRef(false);
  const snapshotRefreshesRef = useRef(new Map<string, SnapshotRefresh>());
  const visibleRuns = useMemo(() => newestRunsByTask(runs), [runs]);

  const selectRun = useCallback((runId: string | null) => {
    if (selectedRunRef.current !== runId) {
      snapshotRef.current = null;
      historyRevisionRef.current = -1;
      setSnapshot(null);
      setPlan(null);
      setEvents([]);
      setSelectedNodeId(null);
      setTab('overview');
      setEvidence(null);
      setCompareRunId('');
      setComparePlan(null);
      setCompareLoading(false);
      setCompareError(null);
      comparisonRequestRef.current += 1;
      setShowDraft(false);
      setFlowInstance(null);
    }
    selectedRunRef.current = runId;
    setSelectedRunId(runId);
  }, []);

  const commitSnapshot = useCallback(
    (next: Snapshot, options: { select?: boolean; expectedRunId?: string } = {}) => {
      const expectedRunId = options.expectedRunId ?? next.runId;
      if (next.runId !== expectedRunId) return false;
      if (!options.select && selectedRunRef.current !== expectedRunId) return false;
      if (options.select) selectRun(next.runId);
      const current = snapshotRef.current;
      if (
        current?.runId === next.runId &&
        current.revision != null &&
        next.revision != null &&
        next.revision < current.revision
      )
        return false;
      snapshotRef.current = next;
      setSnapshot(next);
      return true;
    },
    [selectRun],
  );

  useEffect(() => {
    if (snapshot?.workflow === 'autonomous' && snapshot.successorRunId &&
        snapshot.successorRunId !== snapshot.runId && snapshot.integrity.valid) {
      const successor = snapshot.successorRunId;
      queueMicrotask(() => selectRun(successor));
    }
  }, [snapshot?.workflow, snapshot?.successorRunId, snapshot?.runId, snapshot?.integrity.valid, selectRun]);

  const commitPlan = useCallback(
    async (runId: string, expectedHash: string | undefined, next: GraphPlan | null) => {
      if (!next || !expectedHash || selectedRunRef.current !== runId) return false;
      if ((await hashPlan(next)) !== expectedHash || selectedRunRef.current !== runId) return false;
      const current = snapshotRef.current;
      if (
        current?.runId !== runId ||
        current.planHash !== expectedHash ||
        (current.planVersion != null && current.planVersion !== next.version)
      )
        return false;
      setPlan(next);
      return true;
    },
    [],
  );

  const commitHistory = useCallback((runId: string, next: HistoryEvent[]) => {
    if (selectedRunRef.current !== runId) return false;
    const revision = next.at(-1)?.revision ?? -1;
    if (revision < historyRevisionRef.current) return false;
    historyRevisionRef.current = revision;
    setEvents(next);
    return true;
  }, []);

  const refreshHistory = useCallback(
    async (runId: string) => {
      const next = await api.events(runId);
      commitHistory(runId, next);
    },
    [commitHistory],
  );

  const refreshRuns = useCallback(async () => {
    const request = ++runsRequestRef.current;
    const result = await api.listRuns();
    if (request !== runsRequestRef.current) return;
    setRuns(result.runs);
    if (result.runs.length === 0) {
      selectRun(null);
      return;
    }
    const current = selectedRunRef.current;
    if (!current || !result.runs.some((run) => run.runId === current))
      selectRun(result.runs[0]?.runId ?? null);
  }, [selectRun]);

  const refreshSnapshot = useCallback(
    (runId: string, quiet = false, hintedRevision = -1) => {
      const active = snapshotRefreshesRef.current.get(runId);
      if (active) {
        active.targetRevision = Math.max(active.targetRevision, hintedRevision);
        active.reportErrors ||= !quiet;
        return active.promise;
      }
      const refresh = {
        promise: Promise.resolve(),
        targetRevision: hintedRevision,
        reportErrors: !quiet,
      } satisfies SnapshotRefresh;
      refresh.promise = (async () => {
        try {
          let authoritativeBlocked = false;
          let caughtUp = false;
          for (let attempt = 0; attempt < 2 && selectedRunRef.current === runId; attempt += 1) {
            const next = await api.snapshot(runId);
            const previousRevision =
              snapshotRef.current?.runId === runId ? (snapshotRef.current.revision ?? -1) : -1;
            if (!commitSnapshot(next, { expectedRunId: runId })) {
              if (
                selectedRunRef.current !== runId ||
                (snapshotRef.current?.revision ?? -1) >= refresh.targetRevision
              )
                return;
              continue;
            }
            setSelectedNodeId((current) =>
              current && workflowProjection(next).nodes.some((node) => node.id === current)
                ? current
                : (next.activeNodeId ?? next.nodes[0]?.id ?? null),
            );
            if ((next.revision ?? -1) > previousRevision)
              await refreshHistory(runId).catch(() => undefined);
            if (refresh.reportErrors) setError(null);
            if (next.revision == null) {
              authoritativeBlocked = true;
              break;
            }
            if (next.revision >= refresh.targetRevision) {
              caughtUp = true;
              break;
            }
          }
          if (!authoritativeBlocked && !caughtUp && selectedRunRef.current === runId)
            setStreamConnected(false);
        } catch (reason) {
          if (refresh.reportErrors) setError(reason as ApiError);
        } finally {
          if (snapshotRefreshesRef.current.get(runId) === refresh)
            snapshotRefreshesRef.current.delete(runId);
        }
      })();
      snapshotRefreshesRef.current.set(runId, refresh);
      return refresh.promise;
    },
    [commitSnapshot, refreshHistory],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [, context] = await Promise.all([refreshRuns(), api.project()]);
      setProject(context);
      setError(null);
    } catch (reason) {
      setError(reason as ApiError);
    } finally {
      setLoading(false);
    }
  }, [refreshRuns]);

  useEffect(() => {
    if (authenticated) queueMicrotask(() => void load());
  }, [authenticated, load]);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    if (!selectedRunId) {
      return;
    }
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setLoading(true);
      Promise.allSettled([
        api.snapshot(selectedRunId),
        api.plan(selectedRunId),
        api.events(selectedRunId),
      ])
        .then(async ([snapshotResult, planResult, eventsResult]) => {
          if (!active) return;
          if (snapshotResult.status === 'fulfilled') {
            const accepted = commitSnapshot(snapshotResult.value, { expectedRunId: selectedRunId });
            if (accepted) {
              setError(null);
              setSelectedNodeId(
                snapshotResult.value.activeNodeId ?? snapshotResult.value.nodes[0]?.id ?? null,
              );
            }
          } else {
            setError(snapshotResult.reason as ApiError);
          }
          if (planResult.status === 'fulfilled') {
            const expectedHash =
              snapshotRef.current?.runId === selectedRunId
                ? snapshotRef.current.planHash
                : snapshotResult.status === 'fulfilled'
                  ? snapshotResult.value.planHash
                  : undefined;
            await commitPlan(selectedRunId, expectedHash, planResult.value);
          }
          if (eventsResult.status === 'fulfilled') commitHistory(selectedRunId, eventsResult.value);
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    });
    return () => {
      active = false;
    };
  }, [commitHistory, commitPlan, commitSnapshot, selectedRunId]);

  useEffect(() => {
    const delay = !selectedRunId || streamConnected ? 30_000 : 2_000;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      if (cancelled) return;
      if (!pollInFlightRef.current) {
        pollInFlightRef.current = true;
        await Promise.allSettled([
          ...(selectedRunId ? [refreshSnapshot(selectedRunId, true)] : []),
          refreshRuns(),
        ]);
        pollInFlightRef.current = false;
      }
      if (!cancelled) timer = window.setTimeout(() => void poll(), delay);
    };
    timer = window.setTimeout(() => void poll(), delay);
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [refreshRuns, refreshSnapshot, selectedRunId, streamConnected]);

  useEffect(() => {
    if (!selectedRunId || snapshot?.revision == null) {
      queueMicrotask(() => setStreamConnected(false));
      return;
    }
    const controller = new AbortController();
    let retryTimer: number | undefined;
    const connect = () => {
      setStreamConnected(false);
      watchRevisions(
        selectedRunId,
        snapshot.revision ?? -1,
        () => setStreamConnected(true),
        (revision) => {
          if (revision > (snapshot.revision ?? -1))
            void refreshSnapshot(selectedRunId, true, revision);
        },
        () => {
          setStreamConnected(false);
          retryTimer = window.setTimeout(connect, 5000);
        },
        controller.signal,
      );
    };
    connect();
    return () => {
      controller.abort();
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, [refreshSnapshot, selectedRunId, snapshot?.revision]);

  const visualSnapshot = useMemo(() => snapshot ? workflowProjection(snapshot) : null, [snapshot]);
  const selectedNode = visualSnapshot?.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const graphNodes = useMemo(
    () =>
      visualSnapshot
        ? layoutNodes(visualSnapshot, locale, selectedNodeId, id => {
            setSelectedNodeId(id);
            if (visualSnapshot.nodes.find(node => node.id === id)?.sourceRunId) setTab('evidence');
          }, (action, nodeId) => {
            void execute(action, nodeId);
          })
        : [],
    // execute reads the latest committed snapshot and the selected node id from state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [locale, selectedNodeId, visualSnapshot],
  );
  const graphEdges: Edge[] = useMemo(() => {
    const byId = new Map(visualSnapshot?.nodes.map((node) => [node.id, node]));
    return (visualSnapshot?.edges ?? []).map((edge) => {
      // activeNodeId also points to gates/ready steps; only committed statuses indicate work.
      const active = Boolean(
        snapshot?.integrity.valid &&
        !snapshot.failureReason &&
        !['stale', 'uncertain'].includes(snapshot.status) &&
        byId.get(edge.target)?.status === 'running' &&
        byId.get(edge.source)?.status === 'passed' &&
        byId.get(edge.target)?.needs.includes(edge.source),
      );
      return {
        ...edge,
        type: 'smoothstep',
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
        animated: active,
        className: active ? 'dependency-active' : 'dependency-idle',
        style: { strokeWidth: active ? 2.5 : 1.5 },
      };
    });
  }, [snapshot, visualSnapshot]);
  const currentGraphNodeId = snapshot ? relevantNodeId(snapshot) : null;
  const autonomousRecoveryNode =
    snapshot?.workflow === 'autonomous' &&
    (Boolean(snapshot.failureReason) || ['failed', 'uncertain', 'stale'].includes(snapshot.status)) &&
    selectedNode &&
    !selectedNode.sourceRunId
      ? selectedNode
      : null;

  const focusGraphNode = useCallback(
    (nodeId: string) => {
      if (!flowInstance) return Promise.resolve(false);
      return flowInstance.fitView({
        nodes: [{ id: nodeId }],
        padding: 0.32,
        minZoom: 0.9,
        maxZoom: 1,
        duration: 0,
      });
    },
    [flowInstance],
  );

  async function execute(
    action: 'run' | 'retry' | 'rerun-check' | 'recover' | 'stop',
    nodeId?: string,
  ) {
    if (!snapshot?.planHash || snapshot.revision == null) return;
    if (action === 'stop' ? stopInFlightRef.current : inFlightRef.current) return;
    const capabilityName = action === 'rerun-check' ? 'rerunCheck' : action;
    const capability = nodeId
      ? getCapability(
          snapshot.nodes.find((node) => node.id === nodeId)?.capabilities ?? {},
          capabilityName,
        )
      : getCapability(snapshot.capabilities, capabilityName);
    if (!capability.allowed) {
      setNotice(humanText(capability.reason, locale) || labels.unavailable);
      return;
    }
    const key = `${snapshot.runId}:${action}:${nodeId ?? 'run'}`;
    const existing =
      action === 'stop'
        ? interruptPending?.key === key
          ? interruptPending
          : null
        : pending?.kind === 'control' && pending.key === key
          ? pending
          : null;
    const operation: PendingControlOperation = existing ?? {
      kind: 'control',
      key,
      operationId: operationId(action),
      runId: snapshot.runId,
      action,
      request: {
        operationId: operationId(action),
        expectedRevision: snapshot.revision,
        planHash: snapshot.planHash,
        ...(nodeId ? { nodeId } : {}),
      },
    };
    operation.request.operationId = operation.operationId;
    if (action === 'stop') await sendInterrupt(operation);
    else await sendOperation(operation);
  }

  async function sendInterrupt(operation: PendingControlOperation) {
    if (stopInFlightRef.current) return;
    stopInFlightRef.current = true;
    setStopBusy(true);
    setInterruptPending(operation);
    setNotice('');
    try {
      const next = await api.control(operation.runId, operation.action, operation.request);
      if (next.runId !== operation.runId) {
        throw {
          code: 'INVALID_SNAPSHOT',
          message: 'Ответ остановки относится к другому run.',
          retryable: false,
        } satisfies ApiError;
      }
      commitSnapshot(next, { expectedRunId: operation.runId });
      setInterruptPending(null);
      setStopError(null);
      await refreshHistory(next.runId).catch(() => undefined);
      await refreshRuns();
    } catch (reason) {
      const apiError = reason as ApiError;
      setStopError(apiError);
      if (
        apiError.code === 'REVISION_CONFLICT' ||
        apiError.code === 'PLAN_CONFLICT' ||
        !apiError.retryable
      ) {
        setInterruptPending(null);
        await refreshSnapshot(operation.runId, true);
      }
    } finally {
      stopInFlightRef.current = false;
      setStopBusy(false);
    }
  }

  async function sendOperation(operation: PendingOperation) {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy(true);
    setPending(operation);
    setNotice('');
    try {
      const next =
        operation.kind === 'create'
          ? await api.intake(operation.input)
          : await api.control(operation.runId, operation.action, operation.request);
      const successor =
        operation.kind === 'control' &&
        ['replan', 'recover', 'revise-plan'].includes(operation.action) &&
        next.supersedesRunId === operation.runId;
      if (operation.kind === 'control' && next.runId !== operation.runId && !successor) {
        throw {
          code: 'INVALID_SNAPSHOT',
          message: 'Ответ операции относится к другому run.',
          retryable: false,
        } satisfies ApiError;
      }
      commitSnapshot(
        next,
        operation.kind === 'create' || successor
          ? { select: true }
          : { expectedRunId: operation.runId },
      );
      if (operation.kind === 'create') setShowCreate(false);
      setPending(null);
      setError(null);
      setNotice('');
      await refreshHistory(next.runId).catch(() => undefined);
      await refreshRuns();
    } catch (reason) {
      const apiError = reason as ApiError;
      setError(apiError);
      if (
        apiError.code === 'REVISION_CONFLICT' ||
        apiError.code === 'PLAN_CONFLICT' ||
        !apiError.retryable
      ) {
        setPending(null);
        if (operation.kind === 'control') await refreshSnapshot(operation.runId, true);
        else await refreshRuns().catch(() => undefined);
      }
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  }

  async function openReceipt(hash: string) {
    if (!snapshot || !selectedNode) return;
    const capability = getCapability(selectedNode.capabilities, 'openReceipt');
    if (!capability.allowed)
      return setNotice(humanText(capability.reason, locale) || labels.unavailable);
    try {
      setEvidence({
        type: 'receipt',
        value: await api.receipt(selectedNode.sourceRunId ?? snapshot.runId, hash),
      });
    } catch (reason) {
      setError(reason as ApiError);
    }
  }

  async function openArtifact(hash: string) {
    if (!snapshot) return;
    try {
      setEvidence({
        type: 'artifact',
        value: await api.artifact(selectedNode?.sourceRunId ?? snapshot.runId, hash),
      });
    } catch (reason) {
      setError(reason as ApiError);
    }
  }

  async function selectComparison(runId: string) {
    const request = ++comparisonRequestRef.current;
    setCompareRunId(runId);
    setComparePlan(null);
    setCompareError(null);
    setCompareLoading(Boolean(runId));
    if (!runId) return;
    try {
      const next = await api.plan(runId);
      if (request === comparisonRequestRef.current) setComparePlan(next);
    } catch (reason) {
      if (request === comparisonRequestRef.current) setCompareError(reason as ApiError);
    } finally {
      if (request === comparisonRequestRef.current) setCompareLoading(false);
    }
  }

  function openGate(nextGate: GateSnapshot) {
    setGate(nextGate);
    requestAnimationFrame(() => gateDialog.current?.showModal());
  }

  function requestReplan() {
    if (!snapshot?.planHash || snapshot.revision == null || !getCapability(snapshot.capabilities, 'requestReplan').allowed) return;
    if (snapshot.phase !== 'planning') { setShowDraft(true); return; }
    const id = operationId('replan');
    void sendOperation({kind: 'control', key: `${snapshot.runId}:replan`, operationId: id,
      runId: snapshot.runId, action: 'replan', request: {
        operationId: id, expectedRevision: snapshot.revision, planHash: snapshot.planHash,
      },
    });
  }

  async function createRun(fields: TaskFields) {
    if (!project?.capabilities.intake.allowed || inFlightRef.current) return;
    const existing = pending?.kind === 'create' ? pending : null;
    const id = operationId('intake');
    const operation: PendingCreateOperation = existing ?? {
      kind: 'create', key: 'create', operationId: id,
      input: { ...fields, operationId: id, contextHash: project.contextHash },
    };
    await sendOperation(operation);
  }

  function approveWorkflow(approvedGate: GateSnapshot) {
    if (approvedGate.expiresAt <= Date.now()) {
      setNotice('Согласование устарело. Обновляем план для повторной проверки.');
      if (snapshot) void refreshSnapshot(snapshot.runId, true);
      return;
    }
    if (!snapshot?.planHash || snapshot.revision == null || !plan || pending || busy ||
        !snapshot.integrity.valid || approvedGate.planHash !== snapshot.planHash ||
        approvedGate.expiresAt <= Date.now() ||
        !getCapability(snapshot.nodes.find(node => node.id === approvedGate.nodeId)?.capabilities ?? {}, 'approve').allowed) return;
    const id = operationId('gate');
    void sendOperation({ kind: 'control', key: `${snapshot.runId}:gate:${approvedGate.nodeId}:approve`,
      operationId: id, runId: snapshot.runId, action: 'gate', request: {
        operationId: id, expectedRevision: snapshot.revision, planHash: snapshot.planHash,
        nodeId: approvedGate.nodeId, decision: 'approve', challenge: approvedGate.challenge,
        permissions: approvedGate.requiredPermissions,
      } });
  }

  function reviseWorkflow(feedback: string) {
    if (!snapshot?.planHash || snapshot.revision == null || pending || busy ||
        !getCapability(snapshot.capabilities, 'revisePlan').allowed) return;
    const id = operationId('revise-plan');
    void sendOperation({ kind: 'control', key: `${snapshot.runId}:revise-plan`, operationId: id,
      runId: snapshot.runId, action: 'revise-plan', request: {
        operationId: id, expectedRevision: snapshot.revision, planHash: snapshot.planHash, feedback,
      } });
  }

  const planningActionLabel = getCapability(snapshot?.capabilities ?? {}, 'requestReplan').label ?? labels.replan;
  const composing = showCreate || (!snapshot && !selectedRunId);
  const composer = <TaskComposer
    capability={project?.capabilities.intake ?? null}
    busy={busy} pending={pending?.kind === 'create'} error={error}
    onSubmit={createRun}
    onRetry={() => {
      if (pending?.kind === 'create') void sendOperation(pending);
      else void api.project().then(context => { setProject(context); setError(null); }).catch(reason => setError(reason as ApiError));
    }}
    onClose={snapshot && !busy && pending?.kind !== 'create' ? () => { setShowCreate(false); document.getElementById('new-task')?.focus(); } : undefined}
  />;

  if (!authenticated) return <MissingSession labels={labels} />;
  if (loading && runs.length === 0) return <LoadingState label={labels.loading} />;

  return (
    <main className={`app-shell${snapshot?.workflow === 'autonomous' ? ' autonomous' : ''}`}>
      <a className="skip-link" href="#graph-canvas">
        {labels.graph}
      </a>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <div>
            <h1>{labels.title}</h1>
            <p>{labels.subtitle}</p>
          </div>
        </div>
        <div className="topbar-actions">
          <button className="button quiet" type="button" aria-expanded={showSetup} onClick={() => setShowSetup(!showSetup)}>Настройки проекта</button>
          {runs.length === 0 && <button type="button" className="button quiet" onClick={() => void load()}>{labels.refresh}</button>}
          <span className={streamConnected ? 'connection live' : 'connection'}>
            {streamConnected ? labels.live : labels.disconnected}
          </span>
          {!composing && snapshot?.workflow !== 'autonomous' && <>
          <button
            className="button quiet"
            onClick={() => setLocale(locale === 'ru' ? 'en' : 'ru')}
            type="button"
          >
            {labels.language}
          </button>
          </>}
          <button
            className="button quiet"
            onClick={() => document.documentElement.toggleAttribute('data-dark')}
            type="button"
          >
            {labels.theme}
          </button>
          <ActionButton
            capability={
              snapshot
                ? getCapability(snapshot.capabilities, 'stop')
                : { allowed: false, reason: labels.unavailable }
            }
            onClick={() => void execute('stop')}
          >
            {stopBusy ? '…' : labels.stop}
          </ActionButton>
          <ActionButton
            capability={
              snapshot
                ? (snapshot.workflow === 'autonomous' ? { allowed: false, reason: null } : getCapability(snapshot.capabilities, 'run'))
                : { allowed: false, reason: labels.unavailable }
            }
            onClick={() => void execute('run')}
          >
            {busy ? '…' : labels.run}
          </ActionButton>
        </div>
      </header>

      {stopError && !showCreate && (
        <ErrorNotice
          error={stopError}
          labels={labels}
          pending={interruptPending}
          busy={stopBusy}
          onRetry={() =>
            interruptPending
              ? void sendInterrupt(interruptPending)
              : void refreshSnapshot(selectedRunId!, false)
          }
          onDismiss={() => setStopError(null)}
        />
      )}
      {error && !showCreate && pending?.kind !== 'create' && (
        <ErrorNotice
          error={error}
          labels={labels}
          pending={pending}
          busy={busy}
          onRetry={() => (pending ? void sendOperation(pending) : void load())}
          onDismiss={() => setError(null)}
        />
      )}
      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}

      {showSetup && <SetupPanel onClose={() => setShowSetup(false)} />}
      <section className={`operator-layout${composing ? ' composing' : ''}${runs.length === 0 ? ' no-runs' : ''}`}>
        {runs.length > 0 && <aside className="run-rail" aria-label={labels.runs}>
          <div className="rail-heading">
            <h2>{labels.runs}</h2>
            <button
              className="button compact quiet"
              onClick={() => void refreshRuns()}
              type="button"
            >
              {labels.refresh}
            </button>
            <button
              id="new-task"
              type="button"
              className="button compact quiet"
              disabled={!project?.capabilities.intake.allowed}
              onClick={() => { setError(null); setShowCreate(true); }}
            >{labels.create}</button>

          </div>
          <div className="run-list">
            {visibleRuns.map((run) => (
              <RunButton
                key={run.runId}
                run={run}
                locale={locale}
                active={run.runId === selectedRunId || Boolean(run.task?.taskNumber && run.task.taskNumber === snapshot?.task?.taskNumber && run.task.id === snapshot?.task?.id)}
                onClick={() => selectRun(run.runId)}
              />
            ))}
            {runs.length === 0 && <p className="empty-copy">{labels.noRuns}</p>}
          </div>
          {snapshot && <details className="health-details"><summary>Состояние проекта</summary><RunHealth snapshot={snapshot} locale={locale} /></details>}
        </aside>}

        {composing ? composer : <section className="graph-region" id="graph-canvas" aria-label={labels.graph}>
          {snapshot?.workflow !== 'autonomous' && snapshot?.phase === 'planning' && getCapability(snapshot.capabilities, 'requestReplan').allowed && (
            <div className="next-action"><p>Следующая версия плана будет проверена сервером. Новые права потребуют вашего решения.</p>
              <button className="button primary" type="button" disabled={busy} onClick={requestReplan}>{planningActionLabel}</button></div>
          )}
          <div className="graph-header">
            <div>
              <h2>{labels.graph}</h2>
              <details className="graph-goal">
                <summary>
                  <span>
                    {snapshot?.task?.taskNumber ?? snapshot?.task?.id ?? (selectedRunId ? labels.loading : labels.noRuns)}
                    {snapshot?.task?.goal ? ` · ${snapshot.task.goal}` : ''}
                  </span>
                </summary>
                <p>{snapshot?.task?.description ?? snapshot?.task?.goal ?? (selectedRunId ? labels.loading : labels.noRuns)}</p>
              </details>
            </div>
            {snapshot && (
              <div className="graph-tools">
                <div className="graph-facts">
                  <span>
                    {locale === 'ru' ? 'Версия плана' : 'Plan version'}{' '}
                    <b data-testid="plan-version">{snapshot.planVersion ?? '—'}</b>
                  </span>
                  <span>
                    {labels.revision} <b data-testid="run-revision">{snapshot.revision ?? '—'}</b>
                  </span>
                  <span>
                    {labels.planHash} <code>{snapshot.planHash?.slice(0, 10) ?? '—'}</code>
                  </span>
                </div>
                <div className="graph-view-actions">
                  <button
                    className="button compact quiet"
                    disabled={!flowInstance}
                    onClick={() =>
                      void flowInstance?.fitView({
                        padding: 0.16,
                        minZoom: 0.08,
                        maxZoom: 1,
                        duration: 0,
                      })
                    }
                    type="button"
                  >
                    {labels.fitAll}
                  </button>
                  <button
                    className="button compact quiet"
                    disabled={!flowInstance || !currentGraphNodeId}
                    onClick={() => {
                      if (currentGraphNodeId) void focusGraphNode(currentGraphNodeId);
                    }}
                    type="button"
                  >
                    {labels.focusCurrent}
                  </button>
                </div>
              </div>
            )}
          </div>
          <div className="flow-wrap">
            {snapshot?.nodes.length ? (
              <ReactFlow
                key={snapshot.runId}
                edges={graphEdges}
                elementsSelectable
                fitView
                fitViewOptions={{
                  ...(window.matchMedia('(max-width: 720px)').matches && currentGraphNodeId
                    ? {
                        nodes: [{ id: currentGraphNodeId }],
                        minZoom: 0.9,
                        padding: 0.32,
                      }
                    : { minZoom: 0.08, padding: 0.14 }),
                  maxZoom: 1,
                }}
                maxZoom={1.35}
                minZoom={0.08}
                nodeTypes={NODE_TYPES}
                nodes={graphNodes}
                onlyRenderVisibleElements
                ariaLabelConfig={
                  locale === 'ru'
                    ? {
                        'node.a11yDescription.default':
                          'Нажмите Enter или пробел, чтобы выбрать этап. Escape снимает выбор.',
                        'controls.zoomIn.ariaLabel': 'Приблизить',
                        'controls.zoomOut.ariaLabel': 'Отдалить',
                        'controls.fitView.ariaLabel': 'Показать весь граф',
                        'minimap.ariaLabel': 'Мини-карта графа',
                      }
                    : {}
                }
                nodesConnectable={false}
                nodesDraggable={false}
                onInit={setFlowInstance}
                panOnScroll
                proOptions={{ hideAttribution: false }}
              >
                <Background color="var(--flow-grid)" gap={24} size={1} />
                {(visualSnapshot?.nodes.length ?? 0) > 12 && (
                  <MiniMap
                    ariaLabel={locale === 'ru' ? 'Мини-карта графа' : 'Graph minimap'}
                    pannable
                    zoomable
                    nodeColor={(node) => `var(--status-${String(node.data.status)})`}
                  />
                )}
                <Controls showInteractive={false} />
              </ReactFlow>
            ) : selectedRunId && !snapshot ? (
              <LoadingState label={labels.loading} />
            ) : snapshot && !snapshot.integrity.valid ? (
              <p role="alert">{humanText(snapshot.integrity.reason, locale)}</p>
            ) : (
              <EmptyGraph labels={labels} />
            )}
          </div>
        </section>}

        {!composing && <aside className="detail-panel" aria-label={labels.details}>
          <nav className="detail-tabs" aria-label={labels.details}>
            {(['overview', 'evidence', 'history', 'plan'] as const).map((name) => (
              <button
                aria-selected={tab === name}
                className={tab === name ? 'active' : ''}
                key={name}
                onClick={() => setTab(name)}
                role="tab"
                type="button"
              >
                {labels[name]}
              </button>
            ))}
          </nav>
          <div className="detail-scroll">
            {snapshot?.workflow === 'autonomous' ? (
              <>
                <div hidden={tab !== 'overview' && tab !== 'plan'}><WorkflowPanel key={snapshot.runId} snapshot={snapshot} plan={plan} busy={busy || Boolean(pending)} onApprove={approveWorkflow} onRevise={reviseWorkflow} /></div>
                {tab === 'overview' && autonomousRecoveryNode && (
                  <NodeDetails
                    node={autonomousRecoveryNode}
                    locale={locale}
                    busy={busy}
                    onAction={(action) => void execute(action, autonomousRecoveryNode.id)}
                    onGate={() => undefined}
                    onReplan={requestReplan}
                    replanLabel={getCapability(autonomousRecoveryNode.capabilities, 'requestReplan').label ?? labels.replan}
                  />
                )}
              </>
            ) : tab === 'overview' &&
              (selectedNode ? (
                <NodeDetails
                  node={selectedNode}
                  locale={locale}
                  busy={busy}
                  onAction={(action) => void execute(action, selectedNode.id)}
                  onGate={() => {
                    const found = snapshot?.gates.find((item) => item.nodeId === selectedNode.id);
                    if (found) openGate(found);
                  }}
                  onReplan={requestReplan}
                  replanLabel={getCapability(selectedNode.capabilities, 'requestReplan').label ?? labels.replan}
                />
              ) : (
                <p className="empty-copy">{labels.selectNode}</p>
              ))}
            {tab === 'evidence' && (
              <EvidenceList
                node={selectedNode}
                planning={selectedNode?.sourceRunId ? [] : snapshot?.planningArtifacts ?? []}
                locale={locale}
                onReceipt={openReceipt}
                onArtifact={openArtifact}
              />
            )}
            {tab === 'history' && <HistoryPanel events={events} locale={locale} />}
            {tab === 'plan' && snapshot?.workflow !== 'autonomous' && (
              <PlanPanel
                plan={plan}
                runs={runs.filter((run) => run.runId !== selectedRunId)}
                compareRunId={compareRunId}
                comparePlan={comparePlan}
                compareLoading={compareLoading}
                compareError={compareError}
                locale={locale}
                onCompare={selectComparison}
              />
            )}
          </div>
        </aside>}
      </section>

      {showDraft && snapshot && plan && (
        <DraftDialog
          key={`${snapshot.runId}:${snapshot.planHash ?? ''}`}
          locale={locale}
          plan={plan}
          runId={snapshot.runId}
          planHash={snapshot.planHash!}
          expectedRevision={snapshot.revision!}
          busy={busy}
          onClose={() => setShowDraft(false)}
          onSubmit={(nodes, binding) => {
            const current = snapshotRef.current;
            const capability = getCapability(current?.capabilities ?? {}, 'requestReplan');
            if (!capability.allowed)
              return setNotice(humanText(capability.reason, locale) || labels.unavailable);
            const operation: PendingControlOperation = {
              kind: 'control',
              key: `${binding.runId}:replan`,
              operationId: operationId('replan'),
              runId: binding.runId,
              action: 'replan',
              request: {
                operationId: '',
                expectedRevision: binding.expectedRevision,
                planHash: binding.planHash,
                draft: { nodes },
              },
            };
            operation.request.operationId = operation.operationId;
            setShowDraft(false);
            void sendOperation(operation);
          }}
        />
      )}
      <GateDialog
        key={gate?.challenge ?? 'closed-gate'}
        ref={gateDialog}
        gate={gate}
        planNodes={snapshot?.planHash === gate?.planHash ? snapshot?.nodes ?? [] : []}
        locale={locale}
        busy={busy}
        node={gate ? (snapshot?.nodes.find((node) => node.id === gate.nodeId) ?? null) : null}
        onClose={() => {
          gateDialog.current?.close();
          setGate(null);
        }}
        onSubmit={(decision, reason) => {
          if (!snapshot || !gate) return;
          const op = operationId('gate');
          const operation: PendingControlOperation = {
            kind: 'control',
            key: `${snapshot.runId}:gate:${gate.nodeId}:${decision}`,
            operationId: op,
            runId: snapshot.runId,
            action: 'gate',
            request: {
              operationId: op,
              expectedRevision: snapshot.revision!,
              planHash: snapshot.planHash!,
              nodeId: gate.nodeId,
              decision,
              challenge: gate.challenge,
              ...(decision === 'approve' ? { permissions: gate.requiredPermissions } : {}),
              ...(reason ? { reason } : {}),
            },
          };
          gateDialog.current?.close();
          setGate(null);
          void sendOperation(operation);
        }}
      />
      {evidence && (
        <EvidenceDialog evidence={evidence} locale={locale} onClose={() => setEvidence(null)} />
      )}
    </main>
  );
}

function RunButton({
  run,
  locale,
  active,
  onClick,
}: {
  run: RunSummary;
  locale: Locale;
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
      <span className={`status-mark status-${run.status}`} aria-hidden="true" />
      <span>
        <strong>{run.task?.taskNumber ?? run.task?.id ?? run.runId}</strong>
        <small>{run.task?.goal ?? run.integrity.reason ?? run.runId}</small>
        <small title={run.runId}>Версия плана {run.planVersion ?? '—'}</small>
      </span>
      <em>{STATUS[locale][run.status] ?? run.status}</em>
    </button>
  );
}

function RunHealth({ snapshot, locale }: { snapshot: Snapshot; locale: Locale }) {
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

function NodeDetails({
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
        <span className={`status-chip status-${node.status}`}>{STATUS[locale][node.status]}</span>
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
        <dd>{humanText(node.action.kind, locale)}</dd>
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

function EvidenceList({
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

function HistoryPanel({ events, locale }: { events: HistoryEvent[]; locale: Locale }) {
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

function PlanPanel({
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

function ErrorNotice({
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
  return (
    <section className="error-banner" role="alert">
      <div>
        <strong>{labels.operationFailed}</strong>
        <p>
          {error.code}: {error.message}
        </p>
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

function LoadingState({ label }: { label: string }) {
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
function MissingSession({ labels }: { labels: (typeof COPY)[Locale] }) {
  return (
    <main className="render-error" role="alert">
      <h1>{labels.missingSession}</h1>
      <p>{labels.missingSessionHint}</p>
    </main>
  );
}
function EmptyGraph({ labels }: { labels: (typeof COPY)[Locale] }) {
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

function DraftDialog({
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

const GateDialog = React.forwardRef<
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
          {labels.confirmation}
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

function EvidenceDialog({
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
              : `Receipt ${evidence.value.attempt}`}
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
