import type {
  ApiError,
  Artifact,
  ControlRequest,
  GraphPlan,
  HistoryEvent,
  Receipt,
  RunSummary,
  ServiceCapabilities,
  Snapshot,
  IntakeInput,
  ProjectContext,
} from './contracts';
import { isSnapshot } from './contracts';

const SESSION_KEY = 'flowcairn.graph.session';
let cachedSessionToken: string | null | undefined;

// A new launch URL may only change the fragment in an already open tab.
// Reload so the new server session and persisted snapshot are initialized together.
if (typeof window !== 'undefined')
  window.addEventListener('hashchange', () => {
    if (new URLSearchParams(window.location.hash.slice(1)).has('session')) window.location.reload();
  });

export function sessionToken(): string | null {
  if (cachedSessionToken !== undefined) return cachedSessionToken;
  const fragmentToken = new URLSearchParams(window.location.hash.slice(1)).get('session')?.trim();
  if (fragmentToken) {
    cachedSessionToken = fragmentToken;
    try {
      window.sessionStorage.setItem(SESSION_KEY, fragmentToken);
    } catch {
      // The in-memory token still provides a scoped local session.
    }
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    return cachedSessionToken;
  }
  try {
    cachedSessionToken = window.sessionStorage.getItem(SESSION_KEY)?.trim() || null;
  } catch {
    cachedSessionToken = null;
  }
  return cachedSessionToken;
}

function errorFrom(status: number, value: unknown): ApiError {
  const body = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const nested = body.error && typeof body.error === 'object' ? body.error : null;
  const code =
    nested && typeof (nested as Record<string, unknown>).code === 'string'
      ? String((nested as Record<string, unknown>).code)
      : typeof body.error === 'string'
        ? body.error
        : `HTTP_${status}`;
  const message =
    nested && typeof (nested as Record<string, unknown>).message === 'string'
      ? String((nested as Record<string, unknown>).message)
      : status === 403
        ? 'Сессия управления недействительна. Перезапустите локальный viewer.'
        : 'Сервис вернул некорректный ответ.';
  return {
    code,
    message,
    retryable: code !== 'STALE_CONTEXT' && (status >= 500 || status === 409 || status === 429),
  };
}

async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'X-Flowcairn-Control': sessionToken() ?? '',
        ...init.headers,
      },
    });
  } catch {
    throw {
      code: 'NETWORK_UNCERTAIN',
      message: 'Ответ сервера не получен. Результат операции неизвестен.',
      retryable: true,
    } satisfies ApiError;
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) throw errorFrom(response.status, body);
  return body as T;
}

export const api = {
  async listRuns(): Promise<{
    runs: RunSummary[];
    capabilities: ServiceCapabilities;
  }> {
    const body = await requestJson<{
      runs?: RunSummary[];
      capabilities?: ServiceCapabilities;
    }>('/api/runs');
    return {
      runs: Array.isArray(body.runs) ? body.runs : [],
      capabilities: body.capabilities ?? {},
    };
  },
  async project(): Promise<ProjectContext> {
    const body = await requestJson<ProjectContext>('/api/project');
    if (!body || body.schemaVersion !== 2 || typeof body.name !== 'string' ||
        typeof body.contextHash !== 'string' || !Array.isArray(body.contextPaths) ||
        !body.contextPaths.every(path => typeof path === 'string') || !body.ai ||
        typeof body.capabilities?.intake?.allowed !== 'boolean') {
      throw { code: 'INVALID_PROJECT', message: 'Не удалось прочитать контекст проекта. Обновите страницу.', retryable: true } satisfies ApiError;
    }
    return body;
  },
  async intake(input: IntakeInput): Promise<Snapshot> {
    const body = await requestJson<{ result: Snapshot }>('/api/intake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!isSnapshot(body.result)) {
      throw { code: 'INVALID_SNAPSHOT', message: 'Ответ создания задачи поврежден.', retryable: true } satisfies ApiError;
    }
    return body.result;
  },
  async snapshot(runId: string): Promise<Snapshot> {
    const body = await requestJson<unknown>(`/api/runs/${encodeURIComponent(runId)}/snapshot`);
    if (!isSnapshot(body)) {
      throw {
        code: 'INVALID_SNAPSHOT',
        message: 'Snapshot поврежден или несовместим.',
        retryable: true,
      } satisfies ApiError;
    }
    return body;
  },
  plan(runId: string): Promise<GraphPlan> {
    return requestJson(`/api/runs/${encodeURIComponent(runId)}/plan`);
  },
  async events(runId: string, after = -1): Promise<HistoryEvent[]> {
    const body = await requestJson<{ events?: HistoryEvent[] }>(
      `/api/runs/${encodeURIComponent(runId)}/events?after=${after}`,
    );
    return Array.isArray(body.events) ? body.events : [];
  },
  receipt(runId: string, hash: string): Promise<Receipt> {
    return requestJson(`/api/runs/${encodeURIComponent(runId)}/receipts/${hash}`);
  },
  artifact(runId: string, hash: string): Promise<Artifact> {
    return requestJson(`/api/runs/${encodeURIComponent(runId)}/artifacts/${hash}`);
  },
  async control(runId: string, action: string, request: ControlRequest): Promise<Snapshot> {
    const body = await requestJson<{ result: Snapshot }>(
      `/api/runs/${encodeURIComponent(runId)}/control/${action}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      },
    );
    if (!isSnapshot(body.result)) {
      throw {
        code: 'INVALID_SNAPSHOT',
        message: 'Ответ операции поврежден.',
        retryable: true,
      } satisfies ApiError;
    }
    return body.result;
  },
};

export function watchRevisions(
  runId: string,
  after: number,
  onConnect: () => void,
  onRevision: (revision: number) => void,
  onDisconnect: () => void,
  signal: AbortSignal,
): void {
  void (async () => {
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/stream?after=${after}`, {
        cache: 'no-store',
        headers: {
          Accept: 'text/event-stream',
          'X-Flowcairn-Control': sessionToken() ?? '',
        },
        signal,
      });
      if (!response.ok || !response.body) throw new Error('stream unavailable');
      onConnect();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const frames = pending.split('\n\n');
        pending = frames.pop() ?? '';
        for (const frame of frames) {
          const data = frame
            .split('\n')
            .find((line) => line.startsWith('data: '))
            ?.slice(6);
          if (!data) continue;
          const parsed = JSON.parse(data) as { revision?: unknown };
          if (Number.isSafeInteger(parsed.revision)) onRevision(Number(parsed.revision));
        }
      }
      if (!signal.aborted) onDisconnect();
    } catch {
      if (!signal.aborted) onDisconnect();
    }
  })();
}
