import type { ApiError, Capability, SavedSource, SourceAnchor } from '../contracts';

export const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
export const text = (value: unknown, max = 4000): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
export const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const id = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9-]{1,79}$/.test(value);
export const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
export const choice = (value: unknown, values: readonly string[]) => typeof value === 'string' && values.includes(value);
export const nullable = <T>(value: unknown, check: (value: unknown) => value is T): value is T | null => value === null || check(value);
export const list = <T>(value: unknown, check: (value: unknown) => value is T, max: number): value is T[] => Array.isArray(value) && value.length <= max && value.every(item => check(item));
export const uniqueIds = (items: Array<{ id: string }>) => new Set(items.map(item => item.id)).size === items.length;
export function invalidLearning(message = 'Учебный материал поврежден или несовместим. Повторите чтение сохраненной версии.'): never {
  throw { code: 'INVALID_LEARNING_DATA', message, retryable: false } satisfies ApiError;
}
export function assertLearning(condition: unknown, message?: string): asserts condition {
  if (!condition) invalidLearning(message);
}
export function relativePath(value: unknown): value is string {
  return text(value, 512) && !value.includes('\\') && !value.includes('\0') && !/^(\/|[a-z]:)/i.test(value)
    && value.split('/').every(part => part && part !== '.' && part !== '..');
}
export function capability(value: unknown): value is Capability {
  return record(value) && typeof value.allowed === 'boolean' && nullable(value.reason, text)
    && (value.label === undefined || text(value.label, 160));
}
export function savedSource(value: unknown): value is SavedSource {
  return record(value) && id(value.id) && relativePath(value.path) && hash(value.fileHash)
    && integer(value.bytes, 0, 256 * 1024) && choice(value.mode, ['100644', '100755'])
    && choice(value.role, ['before', 'after', 'context']) && list(value.chunkHashes, hash, 256) && integer(value.lineCount);
}
export function sourceAnchor(value: unknown): value is SourceAnchor {
  return record(value) && id(value.sourceId) && hash(value.fileHash) && integer(value.startLine, 1) && integer(value.endLine, value.startLine)
    && text(value.quote, 8192) && new TextEncoder().encode(value.quote).length <= 8192;
}
export function anchorInCatalog(anchor: SourceAnchor, sources: SavedSource[]) {
  const source = sources.find(item => item.id === anchor.sourceId);
  return Boolean(source && source.fileHash === anchor.fileHash && anchor.endLine <= source.lineCount);
}
