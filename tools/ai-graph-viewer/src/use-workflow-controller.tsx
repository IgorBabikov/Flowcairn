import { useCallback,useEffect,useMemo,useRef,useState } from 'react';
import { api,isReadApiError,sessionToken,snapshotResource,watchRevisions,type ReadApiError } from './api';
import type { ApiError,GateSnapshot,GraphPlan,HistoryEvent,ProjectContext,RunSummary,Snapshot,TaskFields,LearningMode,LearningMaterialResponse } from './contracts';
import { operationId,type PendingControlOperation,type PendingCreateOperation,type PendingOperation,type LearningActivity } from './control-operations';
import { executionPresentation } from './execution-presentation';
import { type Evidence } from './ExecutionDialogs';
import { hashPlan } from './plan-identity';
import { humanText } from './presentation';
import type { ProofEvidence } from './proof-contracts';
import { newestRunsByTask,relevantNodeId } from './run-selection';
import { type TaskOverviewActions } from './TaskOverview';
import { getCapability } from './ui-controls';
import { COPY,type Locale } from './ui-copy';
import { workflowProjection } from './workflow-projection';
import { learningRun } from './learning/learning-projection';
import { contentCapability, contentOperation, type ContentIntent } from './learning/content-command';
import { learningCommandCapability, learningOperation, type LearningIntent } from './learning/learning-commands';


type SnapshotRefresh = {
  promise: Promise<void>;
  targetRevision: number;
  reportErrors: boolean;
};

export function useWorkflowController() {
  const [learningActivities, setLearningActivities] = useState<Record<string, LearningActivity>>({});
  const [learningMode, setLearningMode] = useState<LearningMode>('after-stage');
  const [taskDraft, setTaskDraft] = useState<TaskFields>({ title: '', description: '', taskNumber: '' });
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [diagnosticPage, setDiagnosticPage] = useState<'result' | 'nodes' | 'evidence' | 'history' | 'plan'>('result');
  const [taskContextOpen, setTaskContextOpen] = useState(true);
  const [planFeedbackOpen, setPlanFeedbackOpen] = useState(false);
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
  const [projectContextRefreshing, setProjectContextRefreshing] = useState(false);
  const projectRefreshInFlight = useRef(false);
  const [project, setProject] = useState<ProjectContext | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [snapshotUnavailable, setSnapshotUnavailable] = useState(false);
  const [plan, setPlan] = useState<GraphPlan | null>(null);
  const [events, setEvents] = useState<HistoryEvent[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [readErrors, setReadErrors] = useState<Record<string, ReadApiError>>({});
  const displayedError = error ?? Object.values(readErrors)[0] ?? null;
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
  const [clarifying, setClarifying] = useState<Snapshot | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [showDraft, setShowDraft] = useState(false);
  const [planFeedbackDraft, setPlanFeedbackDraft] = useState('');
  const [gate, setGate] = useState<GateSnapshot | null>(null);
  const gateDialog = useRef<HTMLDialogElement>(null);
  const selectedRunRef = useRef<string | null>(null);
  const snapshotRef = useRef<Snapshot | null>(null);
  const historyRevisionRef = useRef(-1);
  const runsRequestRef = useRef(0);
  const loadRequestRef = useRef(0);
  const comparisonRequestRef = useRef(0);
  const inFlightRef = useRef(false);
  const stopInFlightRef = useRef(false);
  const pollInFlightRef = useRef(false);
  const snapshotRefreshesRef = useRef(new Map<string, SnapshotRefresh>());
  const snapshotReadSequenceRef = useRef(new Map<string, number>());
  const snapshotSettledReadRef = useRef(new Map<string, number>());
  const visibleRuns = useMemo(() => newestRunsByTask(runs), [runs]);

  const clearReadError = useCallback((resource: string) => {
    const recovered = (current: ApiError | null) =>
      isReadApiError(current) && current.readResource === resource ? null : current;
    // A follow-up GET after a confirmed command can reach these existing error channels.
    setError(recovered);
    setStopError(recovered);
    setReadErrors(current => {
      if (!Object.hasOwn(current, resource)) return current;
      const remaining = { ...current };
      delete remaining[resource];
      return remaining;
    });
  }, []);
  const reportReadError = useCallback((reason: unknown) => {
    const failure = reason as ApiError;
    if (isReadApiError(failure)) setReadErrors(current => ({ ...current, [failure.readResource]: failure }));
    else setError(current => current ?? failure);
  }, []);
  const beginSnapshotRead = useCallback((runId: string) => {
    const sequence = (snapshotReadSequenceRef.current.get(runId) ?? 0) + 1;
    snapshotReadSequenceRef.current.set(runId, sequence);
    return sequence;
  }, []);
  const newerSnapshotReadSettled = useCallback((runId: string, sequence: number) =>
    (snapshotSettledReadRef.current.get(runId) ?? 0) > sequence, []);

  const selectRun = useCallback((runId: string | null) => {
    if (selectedRunRef.current !== runId) {
      if (selectedRunRef.current) clearReadError(snapshotResource(selectedRunRef.current));
      snapshotRef.current = null;
      historyRevisionRef.current = -1;
      setSnapshot(null);
      setSnapshotUnavailable(false);
      setPlan(null);
      setEvents([]);
      setSelectedNodeId(null);
      setDiagnosticPage('result');
      setEvidence(null);
      setCompareRunId('');
      setComparePlan(null);
      setCompareLoading(false);
      setCompareError(null);
      comparisonRequestRef.current += 1;
      setShowDraft(false);
      setClarifying(null);
      setPlanFeedbackDraft('');
      setPlanFeedbackOpen(false);
      setTaskContextOpen(true);
    }
    selectedRunRef.current = runId;
    setSelectedRunId(runId);
  }, [clearReadError]);

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
      const job = learningRun(next)?.learning.activeJob;
      if (job) setLearningActivities(current => current[next.runId]?.jobId === job.id ? current : {
        ...Object.fromEntries(Object.entries(current).slice(-19)),
        [next.runId]: { runId: next.runId, jobId: job.id, kind: job.kind, materialHash: job.materialHash },
      });
      snapshotRef.current = next;
      setSnapshot(next);
      setSnapshotUnavailable(false);
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
    let result;
    try { result = await api.listRuns(); }
    catch (reason) { if (request !== runsRequestRef.current) return; throw reason; }
    if (request !== runsRequestRef.current) return;
    setRuns(result.runs);
    clearReadError('/api/runs');
    if (result.runs.length === 0) {
      selectRun(null);
      return;
    }
    const current = selectedRunRef.current;
    if (!current || !result.runs.some((run) => run.runId === current))
      selectRun(newestRunsByTask(result.runs)[0]?.runId ?? null);
  }, [clearReadError, selectRun]);

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
        let readSequence = 0;
        try {
          let authoritativeBlocked = false;
          let caughtUp = false;
          for (let attempt = 0; attempt < 2 && selectedRunRef.current === runId; attempt += 1) {
            readSequence = beginSnapshotRead(runId);
            const next = await api.snapshot(runId);
            if (newerSnapshotReadSettled(runId, readSequence)) return;
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
            snapshotSettledReadRef.current.set(runId, readSequence);
            clearReadError(snapshotResource(runId));
            setSelectedNodeId((current) =>
              current && workflowProjection(next).nodes.some((node) => node.id === current)
                ? current
                : relevantNodeId(next),
            );
            if ((next.revision ?? -1) > previousRevision)
              await refreshHistory(runId).catch(() => undefined);
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
          if (selectedRunRef.current === runId && !newerSnapshotReadSettled(runId, readSequence)) {
            snapshotSettledReadRef.current.set(runId, readSequence);
            setSnapshotUnavailable(true);
            if (refresh.reportErrors || !snapshotRef.current) reportReadError(reason);
          }
        } finally {
          if (snapshotRefreshesRef.current.get(runId) === refresh)
            snapshotRefreshesRef.current.delete(runId);
        }
      })();
      snapshotRefreshesRef.current.set(runId, refresh);
      return refresh.promise;
    },
    [beginSnapshotRead, clearReadError, commitSnapshot, newerSnapshotReadSettled, refreshHistory, reportReadError],
  );

  const load = useCallback(async () => {
    const request = ++loadRequestRef.current;
    setLoading(true);
    try {
      await Promise.all([refreshRuns(), api.project().then(context => {
        if (request !== loadRequestRef.current) return;
        setProject(context);
        clearReadError('/api/project');
      })]);
    } catch (reason) {
      if (request === loadRequestRef.current) reportReadError(reason);
    } finally {
      if (request === loadRequestRef.current) setLoading(false);
    }
  }, [clearReadError, refreshRuns, reportReadError]);

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
      const readSequence = beginSnapshotRead(selectedRunId);
      Promise.allSettled([
        api.snapshot(selectedRunId),
        api.plan(selectedRunId),
        api.events(selectedRunId),
      ])
        .then(async ([snapshotResult, planResult, eventsResult]) => {
          if (!active) return;
          if (newerSnapshotReadSettled(selectedRunId, readSequence)) {
            // A newer GET settled while the initial plan/history were still loading.
          } else if (snapshotResult.status === 'fulfilled') {
            const accepted = commitSnapshot(snapshotResult.value, { expectedRunId: selectedRunId });
            if (accepted) {
              snapshotSettledReadRef.current.set(selectedRunId, readSequence);
              clearReadError(snapshotResource(selectedRunId));
              setSelectedNodeId(current => current && workflowProjection(snapshotResult.value).nodes.some(node => node.id === current)
                ? current : relevantNodeId(snapshotResult.value));
            }
          } else {
            snapshotSettledReadRef.current.set(selectedRunId, readSequence);
            setSnapshotUnavailable(true);
            reportReadError(snapshotResult.reason);
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
  }, [beginSnapshotRead, clearReadError, commitHistory, commitPlan, commitSnapshot, newerSnapshotReadSettled, reportReadError, selectedRunId]);

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
  const currentNodeId = snapshot ? relevantNodeId(snapshot) : null;
  const selectDiagnosticNode = (id: string) => {
    if (!visualSnapshot?.nodes.some(node => node.id === id)) return;
    setSelectedNodeId(id);
    setDiagnosticPage(visualSnapshot.nodes.find(node => node.id === id)?.sourceRunId ? 'evidence' : 'nodes');
  };

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
      if (apiError.code === 'NETWORK_UNCERTAIN') {
        setInterruptPending(null);
        setStopError(null);
        setNotice('Проверяем, была ли принята команда…');
        await refreshSnapshot(operation.runId, true);
        const refreshed = snapshotRef.current;
        if (refreshed?.runId !== operation.runId || refreshed.execution?.stopRequested !== true) {
          setNotice('');
          setStopError({
            code: 'STOP_ACCEPTANCE_UNKNOWN',
            message: 'Не удалось подтвердить, принята ли команда остановки.',
            retryable: true,
          });
        } else setNotice('');
        return;
      }
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
      let next: Snapshot;
      if (operation.kind === 'create') next = await api.intake(operation.input);
      else if (operation.kind === 'control') next = await api.control(operation.runId, operation.action, operation.request);
      else if (operation.action === 'set-progress') next = await api.setLearningProgress(operation.runId, operation.request);
      else {
        const accepted = operation.action === 'generate-lesson'
          ? await api.generateLesson(operation.runId, operation.request)
          : await api.askLesson(operation.runId, operation.request);
        next = accepted.snapshot;
        const activity: LearningActivity = { runId: operation.runId, jobId: accepted.jobId, materialHash: operation.request.materialHash,
          kind: operation.action === 'generate-lesson' ? 'lesson' : 'question',
          ...(operation.action === 'ask-lesson' ? { question: { lessonHash: operation.request.lessonHash, anchor: operation.request.anchor, question: operation.request.question } } : {}) };
        setLearningActivities(current => ({ ...Object.fromEntries(Object.entries(current).slice(-19)), [operation.runId]: activity }));
      }
      const successor =
        operation.kind === 'control' &&
        ['replan', 'recover', 'revise-plan'].includes(operation.action) &&
        next.supersedesRunId === operation.runId;
      if (operation.kind !== 'create' && next.runId !== operation.runId && !successor) {
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
      if (operation.kind === 'create') { setShowCreate(false); setTaskDraft({ title: '', description: '', taskNumber: '' }); }
      if (operation.kind === 'control' && ('contextSelection' in operation.request && operation.request.contextSelection)) setClarifying(null);
      setPending(null);
      setError(null);
      setNotice(operation.kind === 'learning' && operation.action === 'set-progress' ? 'Отметка сохранена. Она не означает подтверждение кода или освоение навыка.' : '');
      await refreshHistory(next.runId).catch(() => undefined);
      await refreshRuns();
    } catch (reason) {
      const apiError = reason as ApiError;
      setError(apiError);
      if (
        apiError.code === 'REVISION_CONFLICT' ||
        apiError.code === 'PLAN_CONFLICT' ||
        apiError.code === 'HOLD_CONFLICT' ||
        !apiError.retryable
      ) {
        setPending(null);
        if (operation.kind !== 'create') {
          if (('contextSelection' in operation.request && operation.request.contextSelection)) setClarifying(null);
          await refreshSnapshot(operation.runId, true);
        }
        else {
          // Registration may have changed bootstrap state before failing.
          // Refresh metadata for the next manual attempt, preserving the
          // actual failure and the user's task text.
          await api.project().then(context => setProject(context)).catch(() => undefined);
          await refreshRuns().catch(() => undefined);
        }
      }
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  }

  async function executeLearning(intent: LearningIntent) {
    if (inFlightRef.current) return;
    if (pending) { setNotice('Сначала уточните результат предыдущей команды или повторите тот же запрос.'); return; }
    const current = snapshotRef.current;
    if (current?.runId !== snapshot?.runId) { setNotice('Выбранный запуск изменился. Проверьте действие в актуальной задаче.'); return; }
    const capability = learningCommandCapability(current, intent, snapshotUnavailable);
    if (!capability.allowed || !current) { setNotice(capability.reason || labels.unavailable); return; }
    await sendOperation(learningOperation(current, intent, operationId(intent.action)));
  }

  async function executeLearningContent(contextRunId: string, material: LearningMaterialResponse, intent: ContentIntent) {
    if (inFlightRef.current) return;
    if (pending) { setNotice('Сначала уточните результат предыдущей команды или повторите тот же запрос.'); return; }
    const current = snapshotRef.current;
    if (current?.runId !== snapshot?.runId) { setNotice('Выбранный запуск изменился. Проверьте действие в актуальной задаче.'); return; }
    const capability = contentCapability(current, contextRunId, material, intent, snapshotUnavailable);
    if (!capability.allowed || !current) { setNotice(capability.reason || labels.unavailable); return; }
    await sendOperation(contentOperation(current, material, intent, operationId(intent.action)));
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

  async function openProofEvidence(item: ProofEvidence, artifactId?: string) {
    if (!snapshot?.integrity.valid || !snapshot.proof?.evidence.some(evidence => evidence.id === item.id)) return;
    try {
      if (artifactId && item.artifactIds.includes(artifactId)) {
        setEvidence({ type: 'artifact', value: await api.artifact(item.runId, artifactId) });
      } else if (item.receiptId) {
        setEvidence({ type: 'receipt', value: await api.receipt(item.runId, item.receiptId) });
      }
    } catch (reason) { setError(reason as ApiError); }
  }

  function acceptRequirement(requirementId: string, reason: string) {
    const proof = snapshot?.proof;
    if (!snapshot?.planHash || snapshot.revision == null || !proof?.acceptance?.allowed || !proof.acceptance.challenge || busy || pending || snapshotUnavailable) return;
    const id = operationId('verify-requirement');
    void sendOperation({ kind: 'control', key: `${snapshot.runId}:requirement:${requirementId}`, operationId: id,
      runId: snapshot.runId, action: 'verify-requirement', request: { operationId: id, expectedRevision: snapshot.revision,
        planHash: snapshot.planHash, requirementId, resultHash: proof.resultHash, reason, decision: 'accept', challenge: proof.acceptance.challenge } });
  }

  async function openProofArtifact(artifactId: string) {
    if (!snapshot?.nodes.some(node => node.artifacts.some(artifact => artifact.id === artifactId))) return;
    try { setEvidence({ type: 'artifact', value: await api.artifact(snapshot.runId, artifactId) }); }
    catch (reason) { setError(reason as ApiError); }
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

  async function refreshProjectContext() {
    if (inFlightRef.current || pending || projectRefreshInFlight.current) return;
    projectRefreshInFlight.current = true;
    setProjectContextRefreshing(true);
    try {
      const context = await api.project();
      setProject(context);
      clearReadError('/api/project');
      setError(null);
    } catch (reason) {
      setError(reason as ApiError);
    } finally {
      projectRefreshInFlight.current = false;
      setProjectContextRefreshing(false);
    }
  }

  async function createRun(fields: TaskFields) {
    if (!project?.capabilities.intake.allowed || inFlightRef.current || projectRefreshInFlight.current) return;
    const existing = pending?.kind === 'create' ? pending : null;
    const id = operationId('intake');
    const operation: PendingCreateOperation = existing ?? {
      kind: 'create', key: 'create', operationId: id,
      input: { ...fields, operationId: id, contextHash: project.contextHash, ...(project.schemaVersion === 3 ? { learningMode } : {}) },
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
  const execution = executionPresentation(snapshot, stopBusy);
  const isStopping = execution.kind === 'stopping';
  const composing = showCreate || (!snapshot && !selectedRunId);
  const overviewActions: TaskOverviewActions = {
    onApprove: approveWorkflow, onRevise: reviseWorkflow, onStart: () => void execute('run'),
    onSetup: () => setShowSetup(true), onClarify: () => { if (snapshot) setClarifying(snapshot); }, onReplan: requestReplan,
    onRecover: (nodeId) => void execute('recover', nodeId), onOpenEvidence: openProofEvidence,
    onOpenArtifact: openProofArtifact, onAcceptRequirement: acceptRequirement,
    onOpenTechnical: (nodeId) => { setDiagnosticsOpen(true); setDiagnosticPage('nodes'); if (nodeId) setSelectedNodeId(nodeId); },
  };

  return {
    taskContextOpen, setTaskContextOpen, planFeedbackOpen,
    setPlanFeedbackOpen, locale, setLocale, labels, runs,
    project, projectContextRefreshing, refreshProjectContext, selectedRunId, snapshot, snapshotUnavailable, plan,
    events, loading, error, setError,
    displayedError, stopError, setStopError, notice, setNotice,
    streamConnected, pending, interruptPending, busy, stopBusy,
    evidence, setEvidence, compareRunId, comparePlan, compareLoading,
    compareError, showCreate, setShowCreate, clarifying, setClarifying,
    showSetup, setShowSetup, showDraft, setShowDraft, planFeedbackDraft,
    setPlanFeedbackDraft, gate, setGate, gateDialog, snapshotRef, visibleRuns, clearReadError,
    selectRun, refreshRuns, refreshSnapshot,
    load, selectedNode, selectedNodeId, diagnosticNodes: visualSnapshot?.nodes ?? [], currentNodeId, selectDiagnosticNode,
    execute, sendInterrupt, sendOperation, openReceipt,
    openArtifact, selectComparison, openGate, requestReplan, planningActionLabel,
    execution, isStopping, composing, overviewActions, authenticated, reportReadError,
    diagnosticsOpen, setDiagnosticsOpen, diagnosticPage, setDiagnosticPage,
    taskDraft, setTaskDraft, createRun, learningMode, setLearningMode, executeLearning, executeLearningContent, learningActivities
  };
}
