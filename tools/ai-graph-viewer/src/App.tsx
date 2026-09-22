import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MarkerType, type ReactFlowInstance, type Edge } from '@xyflow/react';
import { api, sessionToken, watchRevisions } from './api';
import { humanText } from './presentation';
import { TaskComposer } from './TaskComposer';
import { TaskClarification } from './TaskClarification';
import { TaskOverview } from './TaskOverview';
import { ExecutionGraph } from './ExecutionGraph';
import type { ProofEvidence } from './proof-contracts';
import { SetupPanel } from './SetupPanel';
import { workflowProjection } from './workflow-projection';
import type { ApiError, GateSnapshot, GraphPlan, HistoryEvent, RunSummary, ProjectContext, Snapshot, TaskFields } from './contracts';
import { COPY, type Locale } from './ui-copy';
import { operationId, type PendingControlOperation, type PendingCreateOperation, type PendingOperation } from './control-operations';
import { hashPlan } from './plan-identity';
import { newestRunsByTask, relevantNodeId } from './run-selection';
import { NODE_TYPES, layoutNodes } from './GraphNodes';
import { ActionButton, RunButton, RunHealth, ErrorNotice, LoadingState, MissingSession, EmptyGraph, getCapability } from './ui-controls';
import { NodeDetails, EvidenceList, HistoryPanel, PlanPanel } from './ExecutionDetails';
import { DraftDialog, GateDialog, EvidenceDialog, type Evidence } from './ExecutionDialogs';
import { ExecutionStatus } from './ExecutionStatus';
import { executionPresentation } from './execution-presentation';
import { AppFrame, InitialLoadingFrame } from './AppFrame';
import { StatusLoader } from './StatusLoader';
export { AppErrorBoundary } from './ui-controls';

type SnapshotRefresh = {
  promise: Promise<void>;
  targetRevision: number;
  reportErrors: boolean;
};

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
  const [snapshotUnavailable, setSnapshotUnavailable] = useState(false);
  const [plan, setPlan] = useState<GraphPlan | null>(null);
  const [events, setEvents] = useState<HistoryEvent[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [tab, setTab] = useState<'overview' | 'evidence' | 'history' | 'plan'>('overview');
  const [taskView, setTaskView] = useState<'overview' | 'graph'>('overview');
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
  const [clarifying, setClarifying] = useState<Snapshot | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [showDraft, setShowDraft] = useState(false);
  const [planFeedbackDraft, setPlanFeedbackDraft] = useState('');
  const [runsOpen, setRunsOpen] = useState(false);
  const [compactDetails, setCompactDetails] = useState(false);
  const [gate, setGate] = useState<GateSnapshot | null>(null);
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance | null>(null);
  const gateDialog = useRef<HTMLDialogElement>(null);
  const runsButton = useRef<HTMLButtonElement>(null);
  const mobileRunsDialog = useRef<HTMLDialogElement>(null);
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

  useEffect(() => {
    const query = window.matchMedia('(max-width: 1179px)');
    const update = () => setCompactDetails(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    if (runsOpen) {
      const dialog = mobileRunsDialog.current;
      if (dialog && !dialog.open) dialog.showModal();
      dialog?.querySelector<HTMLButtonElement>('button')?.focus();
    }
  }, [runsOpen]);

  const dismissRuns = useCallback(() => {
    if (mobileRunsDialog.current?.open) mobileRunsDialog.current.close();
    setRunsOpen(false);
  }, []);

  const closeRuns = useCallback(() => {
    dismissRuns();
    queueMicrotask(() => runsButton.current?.focus());
  }, [dismissRuns]);

  useEffect(() => {
    const query = window.matchMedia('(max-width: 720px)');
    const closeOnDesktop = () => {
      if (!query.matches && runsOpen) dismissRuns();
    };
    closeOnDesktop();
    query.addEventListener('change', closeOnDesktop);
    return () => query.removeEventListener('change', closeOnDesktop);
  }, [dismissRuns, runsOpen]);

  const selectRun = useCallback((runId: string | null) => {
    if (selectedRunRef.current !== runId) {
      snapshotRef.current = null;
      historyRevisionRef.current = -1;
      setSnapshot(null);
      setSnapshotUnavailable(false);
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
      setClarifying(null);
      setPlanFeedbackDraft('');
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
    const result = await api.listRuns();
    if (request !== runsRequestRef.current) return;
    setRuns(result.runs);
    if (result.runs.length === 0) {
      selectRun(null);
      return;
    }
    const current = selectedRunRef.current;
    if (!current || !result.runs.some((run) => run.runId === current))
      selectRun(newestRunsByTask(result.runs)[0]?.runId ?? null);
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
          if (selectedRunRef.current === runId) setSnapshotUnavailable(true);
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
            setSnapshotUnavailable(true);
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
      if (operation.kind === 'control' && operation.request.contextSelection) setClarifying(null);
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
        if (operation.kind === 'control') {
          if (operation.request.contextSelection) setClarifying(null);
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
    if (snapshot.contextClarification) { setClarifying(snapshot); return; }
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
  const execution = executionPresentation(snapshot, stopBusy);
  const isStopping = execution.kind === 'stopping';
  const composing = showCreate || (!snapshot && !selectedRunId);
  const showingTask = !composing && Boolean(snapshot) && taskView === 'overview';
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
  if (loading && runs.length === 0) return <InitialLoadingFrame label={labels.loading} />;

  return (
    <AppFrame className={snapshot?.workflow === 'autonomous' ? 'autonomous' : ''}>
      <a className="skip-link" href="#main-content">
        {locale === 'ru' ? 'Перейти к задаче' : 'Skip to task'}
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
          <button className="button quiet project-settings-button" type="button" aria-expanded={showSetup} onClick={() => setShowSetup(!showSetup)}>
            <svg className="mobile-action-icon" aria-hidden="true" viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="3" /><path d="M19 13.5v-3l-2-.7-.8-1.9.9-1.9-2.1-2.1-1.9.9-1.9-.8-.7-2h-3l-.7 2-1.9.8-1.9-.9L1.6 6l.9 1.9-.8 1.9-2 .7v3l2 .7.8 1.9-.9 1.9 2.1 2.1 1.9-.9 1.9.8.7 2h3l.7-2 1.9-.8 1.9.9 2.1-2.1-.9-1.9.8-1.9z" /></svg>
            <span className="button-label">Настройки проекта</span>
          </button>
          <button ref={runsButton} className="button quiet mobile-runs-button" type="button" aria-expanded={runsOpen} onClick={() => setRunsOpen(true)}>
            <svg className="mobile-action-icon" aria-hidden="true" viewBox="0 0 24 24" width="20" height="20"><path d="M6 7h13M6 12h13M6 17h13" /><circle cx="3" cy="7" r="1" /><circle cx="3" cy="12" r="1" /><circle cx="3" cy="17" r="1" /></svg>
            <span className="button-label">Показать запуски</span>
          </button>
          <span className={streamConnected ? 'connection live' : 'connection'}>
            {streamConnected ? labels.live : labels.disconnected}
          </span>
          {!composing && snapshot?.workflow !== 'autonomous' && <>
          <button
            className="button quiet locale-button"
            onClick={() => setLocale(locale === 'ru' ? 'en' : 'ru')}
            type="button"
          >
            <span className="button-label">{labels.language}</span>
            <span className="mobile-action-text" aria-hidden="true">{locale === 'ru' ? 'EN' : 'RU'}</span>
          </button>
          </>}
          <button
            className="button quiet theme-button"
            onClick={() => document.documentElement.toggleAttribute('data-dark')}
            type="button"
          >
            <svg className="mobile-action-icon" aria-hidden="true" viewBox="0 0 24 24" width="20" height="20"><path d="M20 15.5A8 8 0 0 1 8.5 4 8.1 8.1 0 1 0 20 15.5z" /></svg>
            <span className="button-label">{labels.theme}</span>
          </button>
          {isStopping ? (
            <button className="button stop-action" type="button" disabled>
              <span className="button-spinner" aria-hidden="true" />
              Останавливаем…
            </button>
          ) : (
            <ActionButton
              capability={
                snapshot
                  ? getCapability(snapshot.capabilities, 'stop')
                  : { allowed: false, reason: labels.unavailable }
              }
              onClick={() => void execute('stop')}
            >
              {labels.stop}
            </ActionButton>
          )}
          <ActionButton
            capability={
              snapshot
                ? (snapshot.workflow === 'autonomous' ? { allowed: false, reason: null } : getCapability(snapshot.capabilities, 'run'))
                : { allowed: false, reason: labels.unavailable }
            }
            onClick={() => void execute('run')}
          >
            {busy ? <StatusLoader kind="button" label={labels.loading} inline announce={false} /> : labels.run}
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
      {!composing && taskView === 'graph' && <nav className="task-view-switch" aria-label="Представление задачи">
        <button type="button" aria-pressed="false" onClick={() => { setTaskView('overview'); setTab('overview'); }}>Задача</button>
        <button type="button" aria-pressed="true">Граф · детали исполнения</button>
      </nav>}
      <section className={`operator-layout${composing ? ' composing' : ''}${runs.length === 0 ? ' no-runs' : ''}${showingTask || clarifying ? ' task-layout' : ''}`}>
        <aside className="run-rail desktop-run-rail" aria-label={labels.runs} data-testid="run-rail">
          <div className="rail-heading">
            <h2>{labels.runs}</h2>
            <div className="rail-actions">
              <button
                aria-label={labels.refresh}
                className="button compact quiet icon-button"
                onClick={() => void refreshRuns()}
                title={labels.refresh}
                type="button"
              >
                <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18">
                  <path d="M20 7v5h-5M4 17v-5h5" />
                  <path d="M6.2 8.2A7 7 0 0 1 18.7 10M17.8 15.8A7 7 0 0 1 5.3 14" />
                </svg>
              </button>
              <button
                id="new-task"
                aria-label={labels.create}
                type="button"
                className="button compact rail-create"
                disabled={!project?.capabilities.intake.allowed}
                onClick={() => { setError(null); setShowCreate(true); }}
              >{labels.createCompact}</button>
            </div>
          </div>
          <div className="run-list">
            {visibleRuns.map((run) => (
              <RunButton
                key={run.runId}
                run={run}
                locale={locale}
                proof={run.runId === snapshot?.runId ? snapshot.proof : undefined}
                proofUnavailable={run.runId === snapshot?.runId && snapshotUnavailable}
                active={run.runId === selectedRunId || Boolean(run.task?.taskNumber && run.task.taskNumber === snapshot?.task?.taskNumber && run.task.id === snapshot?.task?.id)}
                onClick={() => selectRun(run.runId)}
              />
            ))}
            {runs.length === 0 && <p className="empty-copy">{labels.noRuns}</p>}
          </div>
          {snapshot && <details className="health-details"><summary>Состояние проекта</summary><RunHealth snapshot={snapshot} locale={locale} /></details>}
        </aside>

        <div className="main-content" data-testid="main-content" id="main-content">
        {composing ? composer : clarifying ? <TaskClarification key={`${clarifying.runId}:${clarifying.planHash}:${clarifying.revision}`}
          snapshot={clarifying} busy={busy || Boolean(pending)} onClose={() => setClarifying(null)}
          onSubmit={(contextSelection, feedback) => {
            if (busy || pending || !clarifying.planHash || clarifying.revision == null) return;
            const id = operationId('replan');
            void sendOperation({ kind: 'control', key: `${clarifying.runId}:replan`, operationId: id,
              runId: clarifying.runId, action: 'replan', request: { operationId: id,
                expectedRevision: clarifying.revision, planHash: clarifying.planHash, contextSelection,
                ...(feedback ? { feedback } : {}),
              } });
          }} /> : showingTask && snapshot ? <TaskOverview
          key={snapshot.runId}
          snapshot={snapshot}
          plan={plan}
          busy={busy || Boolean(pending)}
          unavailable={snapshotUnavailable}
          execution={execution}
          feedback={planFeedbackDraft}
          onFeedbackChange={setPlanFeedbackDraft}
          actions={{
            onApprove: approveWorkflow,
            onRevise: reviseWorkflow,
            onStart: () => void execute('run'),
            onSetup: () => setShowSetup(true),
            onClarify: requestReplan,
            onOpenEvidence: openProofEvidence,
            onOpenArtifact: openProofArtifact,
            onAcceptRequirement: acceptRequirement,
            onOpenTechnical: () => setTaskView('graph'),
          }}
        /> : <section className="graph-region" id="graph-canvas" aria-label={labels.graph}>
          <ExecutionStatus value={execution} />
          {(snapshot?.workflow !== 'autonomous' || snapshot?.contextClarification) && snapshot?.phase === 'planning' && getCapability(snapshot.capabilities, 'requestReplan').allowed && (
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
              <ExecutionGraph runId={snapshot.runId} edges={graphEdges} nodes={graphNodes}
                currentNodeId={currentGraphNodeId} locale={locale} nodeTypes={NODE_TYPES} onInit={setFlowInstance} />
            ) : selectedRunId && !snapshot ? (
              <LoadingState label={labels.loading} />
            ) : snapshot && !snapshot.integrity.valid ? (
              <p role="alert">{humanText(snapshot.integrity.reason, locale)}</p>
            ) : (
              <EmptyGraph labels={labels} />
            )}
          </div>
        </section>}
        </div>

        {!composing && !clarifying && taskView === 'graph' && selectedNode && <aside
          className="detail-panel"
          aria-label={compactDetails ? 'Детали исполнения' : labels.details}
          role={compactDetails ? 'dialog' : undefined}
        >
          {compactDetails && <button className="button quiet detail-close" type="button" onClick={() => setSelectedNodeId(null)}>Закрыть детали</button>}
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
            {tab === 'overview' &&
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

      {runsOpen && <dialog
        ref={mobileRunsDialog}
        className="mobile-runs-dialog"
        aria-labelledby="mobile-runs-title"
        onCancel={(event) => { event.preventDefault(); closeRuns(); }}
      >
        <header><h2 id="mobile-runs-title">Запуски</h2><button className="button quiet" type="button" onClick={closeRuns}>Закрыть</button></header>
        <div className="run-list">
          {visibleRuns.map((run) => <RunButton
            key={run.runId}
            run={run}
            locale={locale}
            proof={run.runId === snapshot?.runId ? snapshot.proof : undefined}
            proofUnavailable={run.runId === snapshot?.runId && snapshotUnavailable}
            active={run.runId === selectedRunId}
            onClick={() => { selectRun(run.runId); closeRuns(); }}
          />)}
          {visibleRuns.length === 0 && <p className="empty-copy">{labels.noRuns}</p>}
          {snapshot && <details className="health-details"><summary>Состояние проекта</summary><RunHealth snapshot={snapshot} locale={locale} /></details>}
        </div>
      </dialog>}

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
    </AppFrame>
  );
}
