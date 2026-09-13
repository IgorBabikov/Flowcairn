import { resolveAction } from './registry.mjs';

export function initialNodes(plan) {
  return Object.fromEntries(
    plan.nodes.map((node) => [
      node.id,
      {
        status: 'pending',
        attempts: 0,
        receipts: [],
        artifacts: [],
        checks: [],
        changedFiles: [],
        reason: null,
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        retrySafe: false,
      },
    ]),
  );
}

/** Only runtime uses this reducer; the UI receives its projected states and capabilities. */
export function reconcile(state, plan) {
  const next = structuredClone(state);
  if (next.finalDisposition || next.status === 'stale' || next.status === 'uncertain') return next;
  for (const definition of plan.nodes) {
    const node = next.nodes[definition.id];
    if (!['pending', 'ready', 'waiting-for-human'].includes(node.status)) continue;
    const blocked = definition.needs.find((id) => next.nodes[id].status !== 'passed');
    if (blocked) {
      node.status = 'pending';
      node.reason = `Ожидается ${blocked}: ${next.nodes[blocked].status}`;
      continue;
    }
    if (resolveAction(definition.action.id).kind === 'gate') {
      node.status = 'waiting-for-human';
      node.reason = 'Ожидается решение оператора';
      continue;
    }
    const missing = definition.permissions.filter((p) => !next.permissions.includes(p));
    if (missing.length) {
      node.status = 'pending';
      node.reason = `Нет разрешения: ${missing.join(', ')}`;
      continue;
    }
    node.status = 'ready';
    node.reason = null;
  }
  const statuses = Object.values(next.nodes).map((node) => node.status);
  next.status = statuses.includes('running')
    ? 'running'
    : statuses.includes('uncertain')
      ? 'uncertain'
      : statuses.includes('failed')
        ? 'failed'
        : statuses.includes('waiting-for-human')
          ? 'waiting-for-human'
          : statuses.every((s) => s === 'passed')
            ? 'passed'
            : statuses.includes('ready')
              ? 'ready'
              : 'pending';
  return next;
}

const capability = (allowed, reason = null) => ({ allowed, reason: allowed ? null : reason });
export function calculateCapabilities(
  state,
  plan,
  {
    integrity = true,
    historical = false,
    runner = { ai: { available: false }, checks: { available: false } },
    orphan = false,
    terminalRecovery = false,
    lock = null,
  } = {},
) {
  const closed = Boolean(state.finalDisposition) || state.status === 'stale';
  const runningControl = Object.entries(state.operations ?? {}).some(
    ([id, operation]) => operation.status === 'running' && id !== state.activeOperation?.id,
  );
  const busy = Boolean(state.activeOperation) || runningControl;
  const usable = integrity && !closed && !busy && !lock;
  const reason = !integrity
    ? 'Integrity не подтверждена'
    : closed
      ? 'Run закрыт'
      : busy
        ? 'Действие уже выполняется'
        : lock
          ? 'Run заблокирован другим writer'
          : 'Операция недоступна в текущем состоянии';
  const nodes = {};
  for (const definition of plan.nodes) {
    const node = state.nodes[definition.id],
      action = historical
        ? { kind: definition.success.kind, retrySafe: false }
        : resolveAction(definition.action.id);
    const executionAvailable = definition.action.id.startsWith('ai-')
      ? runner.ai.available
      : definition.action.id.startsWith('check-')
        ? runner.checks.available
        : true;
    const retry =
      usable &&
      !historical &&
      state.status !== 'uncertain' &&
      node.status === 'failed' &&
      node.retrySafe &&
      action.retrySafe &&
      node.attempts < definition.retry.maxAttempts &&
      definition.permissions.every((p) => state.permissions.includes(p)) &&
      definition.needs.every((id) => state.nodes[id].status === 'passed') &&
      executionAvailable;
    const approve =
      usable &&
      !historical &&
      node.status === 'waiting-for-human' &&
      definition.action.id === 'human-approve';
    const accept =
      usable &&
      !historical &&
      node.status === 'waiting-for-human' &&
      definition.action.id === 'human-accept';
    nodes[definition.id] = {
      run: capability(
        usable && !historical && node.status === 'ready' && executionAvailable,
        executionAvailable ? reason : 'Runner не прошел проверку изоляции',
      ),
      retry: capability(
        retry,
        node.retrySafe ? reason : 'Повтор этой попытки не доказан безопасным',
      ),
      approve: capability(approve, reason),
      accept: capability(accept, reason),
      reject: capability(approve || accept, reason),
      recover: capability(
        integrity &&
          (!closed || terminalRecovery) &&
          !runningControl &&
          (terminalRecovery || orphan || (!state.activeOperation && node.status === 'uncertain')),
        reason,
      ),
      openReceipt: capability(node.receipts.length > 0, 'Receipt еще нет'),
      rerunCheck: capability(
        retry && action.kind === 'checks',
        'Нужна безопасная failed-попытка; passed checks повторяются в новой версии',
      ),
      requestReplan: capability(
        usable &&
          state.status !== 'running' &&
          (state.status !== 'uncertain' || state.recovered === true) &&
          state.planVersion <= state.maxReplans,
        reason,
      ),
    };
  }
  const values = Object.values(nodes);
  return {
    nodes,
    run: {
      run: capability(
        usable && state.status !== 'uncertain' && values.some((n) => n.run.allowed),
        reason,
      ),
      retry: capability(
        values.some((n) => n.retry.allowed),
        'Нет безопасной попытки для повтора',
      ),
      approve: capability(
        values.some((n) => n.approve.allowed || n.accept.allowed),
        reason,
      ),
      reject: capability(
        values.some((n) => n.reject.allowed),
        reason,
      ),
      recover: capability(
        integrity &&
          (!closed || terminalRecovery) &&
          !runningControl &&
          (terminalRecovery ||
            orphan ||
            (!state.activeOperation &&
              (state.status === 'uncertain' || Boolean(lock?.recoverable)))),
        reason,
      ),
      stop: capability(!closed && Boolean(state.activeOperation) && !orphan, reason),
      requestReplan: capability(
        usable &&
          state.status !== 'running' &&
          (state.status !== 'uncertain' || state.recovered === true) &&
          state.planVersion <= state.maxReplans,
        reason,
      ),
      openReceipt: capability(
        values.some((n) => n.openReceipt.allowed),
        'Receipt еще нет',
      ),
      rerunCheck: capability(
        values.some((n) => n.rerunCheck.allowed),
        'Нет безопасной failed-проверки',
      ),
    },
  };
}
