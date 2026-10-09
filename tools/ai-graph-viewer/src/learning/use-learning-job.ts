import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { LearningJob } from '../contracts';
import type { LearningActivity } from '../control-operations';
import { pollJob } from './poll-job';

export function useLearningJob(activity: LearningActivity | null, enabled: boolean) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; job: LearningJob | null; paused: boolean; error: string | null } | null>(null);
  const runId = activity?.runId, jobId = activity?.jobId, materialHash = activity?.materialHash, kind = activity?.kind;
  const key = runId && jobId ? `${runId}:${jobId}:${materialHash}:${kind}:${attempt}` : null;
  useEffect(() => {
    if (!key || !runId || !jobId || !materialHash || !kind || !enabled) return;
    const controller = new AbortController();
    void pollJob({ signal: controller.signal,
      read: signal => api.learningJob(runId, jobId, materialHash, kind, signal),
      receive: job => setResult({ key, job, paused: false, error: null }),
    }).then(status => {
      if (status === 'paused' && !controller.signal.aborted) setResult(previous => ({ key, job: previous?.key === key ? previous.job : null, paused: true, error: null }));
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setResult(previous => ({ key, job: previous?.key === key ? previous.job : null, paused: true,
        error: error && typeof error === 'object' && 'message' in error ? String(error.message) : 'Не удалось прочитать состояние учебного запроса.' }));
    });
    return () => controller.abort();
  }, [key, runId, jobId, materialHash, kind, enabled]);
  const refresh = useCallback(() => setAttempt(value => value + 1), []);
  return { job: result?.key === key ? result.job : null, paused: result?.key === key && result.paused,
    error: result?.key === key ? result.error : null, refresh };
}
