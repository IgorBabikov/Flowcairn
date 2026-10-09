import { useCallback, useEffect, useState } from 'react';
import type { ApiError } from '../contracts';

export type BoundRead<T> = { state: 'idle' | 'loading'; data: null; error: null }
  | { state: 'ready'; data: T; error: null } | { state: 'failed'; data: null; error: ApiError };

/** A view-local read, not a runtime store. Keys prevent late responses crossing source/run versions. */
export function useBoundRead<T>(key: string | null, read: (signal: AbortSignal) => Promise<T>, enabled = true): BoundRead<T> & { reload: () => void } {
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<{ key: string; attempt: number; result: BoundRead<T> } | null>(null);
  useEffect(() => {
    if (key === null || !enabled) return;
    let active = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    void read(controller.signal).then(data => {
      if (active) setSettled({ key, attempt, result: { state: 'ready', data, error: null } });
    }).catch((reason: unknown) => {
      if (active) setSettled({ key, attempt, result: { state: 'failed', data: null, error: normalizeReadError(reason) } });
    }).finally(() => window.clearTimeout(timeout));
    return () => { active = false; controller.abort(); window.clearTimeout(timeout); };
  }, [key, attempt, read, enabled]);
  const result = boundReadResult(key, attempt, enabled, settled);
  const reload = useCallback(() => setAttempt(value => value + 1), []);
  return { ...result, reload };
}
function normalizeReadError(value: unknown): ApiError {
  if (value && typeof value === 'object' && 'code' in value && typeof value.code === 'string' && 'message' in value && typeof value.message === 'string') {
    return { code: value.code, message: value.message, retryable: 'retryable' in value && value.retryable === true };
  }
  return { code: 'LEARNING_READ_FAILED', message: 'Не удалось прочитать сохраненный материал.', retryable: true };
}
export function learningReadMessage(error: ApiError): string {
  if (['NOT_FOUND', 'HTTP_404'].includes(error.code)) return 'Сохраненный материал или учебный API пока недоступен в этом сервисе.';
  if (error.code === 'LEARNING_PAGE_LIMIT') return 'Эта строка превышает допустимый размер страницы. Текст не был обрезан. Можно выбрать другой файл или диапазон.';
  return error.message;
}

/** Revocation takes precedence over cached immutable bytes, even at the same revision. */
export function boundReadResult<T>(key: string | null, attempt: number, enabled: boolean,
  settled: { key: string; attempt: number; result: BoundRead<T> } | null): BoundRead<T> {
  if (key === null || !enabled) return { state: 'idle', data: null, error: null };
  return settled?.key === key && settled.attempt === attempt ? settled.result : { state: 'loading', data: null, error: null };
}
