import path from 'node:path';
import { GraphError } from './io.mjs';
import { isInstructionPath } from './registry.mjs';

const normalized = (value) => value.normalize('NFKC').toLowerCase().replaceAll('ё', 'е');
const within = (candidate, scope) => candidate === scope || candidate.startsWith(`${scope}/`);

/** Select a bounded starting area from names only; no project contents enter this decision. */
export function selectDirectTaskScope(description, filePaths, candidates) {
  const text = normalized(description);
  const files = new Set(filePaths);
  const allowed = new Set(candidates);
  const directories = new Set();
  for (const file of files) {
    for (let directory = path.posix.dirname(file); directory !== '.'; directory = path.posix.dirname(directory))
      directories.add(directory);
  }
  const available = new Set([...files, ...directories]);
  const selected = new Set();
  const nameCounts = new Map();
  for (const file of files) {
    const name = normalized(path.posix.basename(file));
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
  const add = (candidate, explicit = false) => {
    if (!available.has(candidate)) return;
    if ([...allowed].some((root) => within(candidate, root)) ||
        (explicit && files.has(candidate) && isInstructionPath(candidate) && text.includes(normalized(candidate))))
      selected.add(candidate);
  };

  for (const file of files) {
    const name = normalized(path.posix.basename(file));
    const parent = path.posix.dirname(file);
    const parentName = normalized(path.posix.basename(parent));
    const explicit = text.includes(normalized(file)) || text.includes(`${parentName}/${name}`);
    if (!explicit && (name.length < 4 || !name.includes('.') || nameCounts.get(name) !== 1 || !text.includes(name))) continue;
    add(parent === '.' ? file : parent, explicit);
  }
  for (const directory of directories) {
    const parts = directory.split('/');
    if (parts.length > 2) continue;
    const name = normalized(parts.at(-1));
    if (text.includes(normalized(directory)) || (name.length >= 5 && text.includes(name))) add(directory);
  }
  if (/\bnpm\b|\brun\s+[a-z][a-z0-9:_-]*\b|package\.json/.test(text)) add('package.json');
  if (/webpack|вебпак/.test(text)) {
    for (const candidate of allowed) if (candidate.startsWith('webpack')) add(candidate);
  }
  if (/тип|type|interface/.test(text)) add('src/interfaces');
  if (/тест|test|проверк/.test(text)) add('test-setup.ts');

  const result = [...selected].filter((candidate) =>
    ![...selected].some((other) => other !== candidate && within(other, candidate))).sort();
  if (result.length > 64) throw new GraphError('INTAKE_SCOPE_LIMIT', 'Область задачи превышает допустимый предел');
  if (result.length) return result;
  const fallback = [...allowed].filter((candidate) => !candidate.startsWith('.') && available.has(candidate)).sort();
  if (fallback.length > 0 && fallback.length <= 8) return fallback;
  throw new GraphError('INTAKE_SCOPE_UNCLEAR', 'Не удалось ограничить область задачи по ее описанию и файлам проекта');
}
