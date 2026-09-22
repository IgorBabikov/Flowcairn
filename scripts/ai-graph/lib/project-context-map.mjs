import path from 'node:path';
import { isTaskContextPath } from './task-context.mjs';

/** A bounded names-only index lets the analyst ask for context without reading the root. */
export function projectContextMap(files, task, outputPaths = [], round = 0) {
  const options = { outputPaths, forbiddenPaths: task.forbiddenPaths };
  const text = `${task.goal}\n${task.instructions}`.toLowerCase();
  const terms = text.match(/[a-z][a-z0-9_-]{3,}/g) ?? [];
  const paths = new Map();
  for (const file of files) {
    if (!isTaskContextPath(file.path, options)) continue;
    const relevant = terms.some((term) => file.path.toLowerCase().includes(term));
    if (!file.path.includes('/') || relevant) paths.set(file.path, relevant ? 0 : 1);
    for (let directory = path.posix.dirname(file.path); directory !== '.'; directory = path.posix.dirname(directory))
      if (directory.split('/').length <= 3 && isTaskContextPath(directory, options))
        paths.set(`${directory}/`, Math.min(paths.get(`${directory}/`) ?? 99, relevant ? 0 : directory.split('/').length + 1));
  }
  const ordered = [...paths].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
  const selected = [];
  let bytes = 0;
  for (const [value] of ordered) {
    if (selected.length >= 192 || bytes + Buffer.byteLength(value) + 4 > 8 * 1024) break;
    selected.push(value); bytes += Buffer.byteLength(value) + 4;
  }
  return { paths: selected, truncated: selected.length < ordered.length, round, remainingRounds: Math.max(0, 4 - round),
    notice: 'Только имена из снимка проекта. Эти пути не разрешают чтение: запроси необходимые contextRequests. Отсутствие имени в сокращенном списке не доказывает отсутствие файла.' };
}
