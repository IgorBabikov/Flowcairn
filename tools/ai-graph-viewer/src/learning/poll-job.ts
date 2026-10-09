import type { LearningJob } from '../contracts';

/** GET-only, bounded observation. A stopped observer never retries the command. */
export async function pollJob({ read, signal, receive, pause = delay, now = Date.now, maxReads = 60, budgetMs = 120000 }: {
  read: (signal: AbortSignal) => Promise<LearningJob>; signal: AbortSignal; receive: (job: LearningJob) => void;
  pause?: (ms: number, signal: AbortSignal) => Promise<void>; now?: () => number; maxReads?: number; budgetMs?: number;
}): Promise<'settled' | 'paused' | 'aborted'> {
  const started = now();
  let failures = 0;
  for (let attempt = 0; attempt < maxReads && now() - started < budgetMs; attempt++) {
    if (signal.aborted) return 'aborted';
    const request = new AbortController();
    const abort = () => request.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, Math.min(15000, budgetMs - (now() - started)));
    try {
      const job = await read(request.signal);
      if (signal.aborted) return 'aborted';
      receive(job);
      failures = 0;
      if (job.status !== 'running') return 'settled';
    } catch (error) {
      if (signal.aborted) return 'aborted';
      failures++;
      if (failures >= 3 || (error && typeof error === 'object' && 'retryable' in error && error.retryable === false)) throw error;
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
    }
    if (attempt + 1 < maxReads && now() - started < budgetMs) await pause(Math.min(2000, budgetMs - (now() - started)), signal);
  }
  return signal.aborted ? 'aborted' : 'paused';
}
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}
