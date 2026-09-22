import path from 'node:path';
import { z } from 'zod';
import { GraphError } from './io.mjs';
import { RelativePath } from './schemas.mjs';
import { isInstructionPath, isWithin } from './registry.mjs';
import { isTaskContextPath } from './task-context.mjs';

const Request = z.strictObject({
  path: RelativePath,
  purpose: z.enum(['read', 'write']),
  reason: z.string().trim().min(1).max(1000),
});
const Descriptor = z.strictObject({
  path: z.string().min(1).max(512),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().min(0),
  mode: z.enum(['100644', '100755']),
});
const unique = (values) => [...new Set(values)].sort();
const normalize = (value) => value.normalize('NFC').toLowerCase();
const invalid = (message) => { throw new GraphError('CONTEXT_REQUEST_INVALID', message); };
const limit = (message) => { throw new GraphError('CONTEXT_REQUEST_LIMIT', message); };

/** Resolve proposed paths against a trusted fingerprint, without reading bytes or granting execution rights.
 * The caller must prove a stopped planning phase and create a fresh immutable plan.
 * Filesystem containment, links and fingerprint freshness remain the fingerprint provider's responsibility.
 */
export function resolveContextRequests({ task, requests, files, outputPaths = [], provider = 'codex' }) {
  if (task?.contextDiscovery !== true) invalid('Автоматическое уточнение контекста не разрешено для этой задачи.');
  if (!Array.isArray(requests)) invalid('Ожидается список запросов дополнительного контекста.');
  if (requests.length > 16) limit('За один этап можно запросить не более 16 дополнительных путей.');
  const parsed = z.array(Request).safeParse(requests);
  if (!parsed.success) invalid('Запрос контекста должен содержать безопасный относительный путь, цель и краткую причину.');
  if (!['codex', 'claude', 'cursor'].includes(provider)) invalid('Неизвестный исполнитель дополнительного контекста.');
  const inventory = z.array(Descriptor).max(20_000).safeParse(files);
  if (!inventory.success) invalid('Нужен проверенный список обычных файлов текущего проекта.');
  if (!Array.isArray(task.scope) || !Array.isArray(task.contextPaths)) invalid('У задачи отсутствует исходная область контекста.');
  const policy = { outputPaths, forbiddenPaths: task.forbiddenPaths ?? [] };
  const safe = (candidate) => isTaskContextPath(candidate, policy);
  const allFiles = new Map();
  const available = new Set();
  const aliases = new Map();
  const remember = (candidate) => {
    const key = normalize(candidate);
    const current = aliases.get(key) ?? new Set();
    current.add(candidate);
    aliases.set(key, current);
  };
  for (const file of inventory.data) {
    if (allFiles.has(file.path)) invalid('Список файлов содержит повторяющиеся пути.');
    allFiles.set(file.path, file);
    remember(file.path);
    if (safe(file.path)) available.add(file.path);
    for (let directory = path.posix.dirname(file.path); directory !== '.' && directory !== '/'; directory = path.posix.dirname(directory)) {
      remember(directory);
      if (safe(directory) && safe(file.path)) available.add(directory);
    }
  }
  const scope = new Set(task.scope);
  const contextPaths = new Set(task.contextPaths);
  const notes = [];
  const seen = new Set();
  for (const request of parsed.data) {
    const candidate = request.path.replace(/\/$/, '');
    if (!safe(candidate)) invalid('Дополнительный путь закрыт политикой проекта или исключен из исходного контекста.');
    const key = `${request.purpose}:${candidate}`;
    if (seen.has(key)) invalid('Один и тот же запрос контекста повторяется.');
    seen.add(key);
    const equivalent = aliases.get(normalize(candidate));
    if (equivalent && !equivalent.has(candidate)) invalid('Регистр или написание пути не совпадает с текущим списком файлов. Используйте точное имя.');
    for (let ancestor = path.posix.dirname(candidate); ancestor !== '.'; ancestor = path.posix.dirname(ancestor)) {
      if (allFiles.has(ancestor) || [...(aliases.get(normalize(ancestor)) ?? [])].some((name) => allFiles.has(name)))
        invalid('Родитель запрошенного пути является файлом, а не папкой.');
      const variants = aliases.get(normalize(ancestor));
      if (variants && !variants.has(ancestor)) invalid('Написание родительской папки не совпадает с текущим списком файлов.');
    }
    if (request.purpose === 'read') {
      if (!available.has(candidate)) invalid('Запрошенный для чтения файл или папка отсутствует в доступном снимке проекта.');
      contextPaths.add(candidate);
    } else {
      scope.add(candidate);
    }
    notes.push(`${request.purpose === 'read' ? 'Дополнительное чтение' : 'Предлагаемая область изменений'}: ${candidate}. Причина: ${request.reason.replace(/\s+/g, ' ')}`);
  }
  const nextScope = unique([...scope]);
  const nextContextPaths = unique([...contextPaths]);
  if (nextScope.length > 64) limit('После уточнения область изменений превышает 64 пути. Нужна более узкая декомпозиция задачи.');
  if (nextContextPaths.length > 32) limit('После уточнения контекст чтения превышает 32 пути. Нужна более узкая декомпозиция задачи.');
  if (provider !== 'codex') {
    const reads = unique([...nextScope, ...nextContextPaths]);
    const selected = inventory.data.filter((file) => safe(file.path) && reads.some((root) => isWithin(file.path, root)) &&
      (!isInstructionPath(file.path) || reads.includes(file.path)));
    if (selected.length > 256 || selected.reduce((sum, file) => sum + file.size, 0) > 512 * 1024)
      limit('Дополнительный контекст внешнего AI превышает 256 файлов или 512 КиБ. Запросите более узкие пути.');
  }
  return { scope: nextScope, contextPaths: nextContextPaths, notes };
}
