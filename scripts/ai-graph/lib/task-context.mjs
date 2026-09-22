import path from 'node:path';
import { GraphError, hashObject } from './io.mjs';
import { ContextSelectionSchema, RelativePath } from './schemas.mjs';
import { isAuxiliaryContextPath, isSensitivePath, isWithin, overlaps } from './registry.mjs';

const unique = (values) => [...new Set(values)].sort();
const normalized = (value) => value.normalize('NFC').toLowerCase();
const privateNames = new Set(['.git', '.ai', '.ai-orchestrator', '.agents', '.codex', '.claude', '.cursor', '.ds_store', 'node_modules']);
const extensions = new Set('json jsonc yaml yml toml ini cfg conf config xml csv tsv md mdx txt rst html htm css scss sass less js jsx mjs cjs ts tsx mts cts vue svelte py go rs java kt kts swift cs fs cpp cc c h hpp rb php sh bash zsh sql graphql gql proto svg png jpg jpeg webp gif pdf docx xlsx'.split(' '));
const fail = (message) => { throw new GraphError('INTAKE_SCOPE', message); };
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentioned = (text, value) => text.includes(value) && new RegExp(`(?:^|[^\\p{L}\\p{N}_./\\\\-])${escape(value)}(?=$|[^\\p{L}\\p{N}_/\\\\-]|[.,;:!?](?:\\s|$))`, 'u').test(text);

export function isTaskContextPath(file, { outputPaths = [], forbiddenPaths = [] } = {}) {
  return RelativePath.safeParse(file).success && ![...file].some((char) => char.charCodeAt(0) < 32) &&
    normalized(file) !== '.flowcairn.json' &&
    !file.split('/').some((part) => privateNames.has(normalized(part))) &&
    !isSensitivePath(file) && !isAuxiliaryContextPath(file) &&
    ![...outputPaths, ...forbiddenPaths].some((item) => overlaps(normalized(file), normalized(item)));
}

/** Names only. No file is opened and no permission is granted by this preview. */
export function buildTaskContext({ fields, project, files = null, outputPaths = [], forbiddenPaths = [], selection = undefined }) {
  const original = `${fields.title}\n${fields.description}`;
  // URLs, email addresses and version strings are not repository paths.
  const text = original.replace(/(?:https?:\/\/|mailto:)[^\s<>"'`]+|[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, ' ');
  const lower = normalized(text);
  const safety = new Map();
  const safe = (file) => {
    if (safety.has(file)) return safety.get(file);
    const result = isTaskContextPath(file, { outputPaths, forbiddenPaths });
    safety.set(file, result);
    return result;
  };
  const inventory = unique(files ?? []);
  const availableFiles = inventory.filter(safe);
  const candidates = unique(project.scopeCandidates.filter(safe).map((file) => file.replace(/\/$/, '')));
  const directories = new Set();
  for (const file of availableFiles) {
    for (let directory = path.posix.dirname(file); directory !== '.'; directory = path.posix.dirname(directory))
      if (safe(directory)) directories.add(directory);
  }
  const available = unique([...availableFiles, ...directories]);
  const fileSet = new Set(inventory);
  const basenames = new Set(inventory.map((file) => normalized(path.posix.basename(file))));
  const knownName = (value) => /^(?:Dockerfile|Makefile|Procfile|LICENSE|README|\.env(?:\..*)?|\.npmrc)$/i.test(value);
  const refs = new Set();
  // Exact names (including spaces and extensionless files) remain discoverable.
  for (const file of availableFiles) {
    if (mentioned(text, file)) refs.add(file);
  }
  // The token scanner deliberately does not pretend to infer natural-language intent.
  // A missing reference needs a human choice: existing source, new output, or example.
  for (const match of text.matchAll(/(?:\.{0,2}\/)?[\p{L}\p{N}_@.-]+(?:\/[\p{L}\p{N}_@.-]+)*/gu)) {
    const value = match[0].replace(/[.,;:!?]+$/, '').replace(/^\.\//, '');
    const basename = path.posix.basename(value);
    const fileLike = basename.includes('.') && extensions.has(basename.split('.').at(-1).toLowerCase());
    const pathLike = value.includes('/') && (directories.has(value) ||
      candidates.includes(value.split('/')[0]) || /^(?:src|app|lib|bin|scripts|docs|tests?|assets)\//.test(value));
    if (!fileLike && !pathLike && !basenames.has(normalized(basename)) && !knownName(basename)) continue;
    // A token inside a known quoted path containing spaces is not a second reference.
    if ([...refs].some((ref) => ref !== value && ref.includes(' ') && ref.endsWith(value))) continue;
    refs.add(value);
  }
  // A full reference subsumes its basename, but not a different, explicitly named file.
  const references = unique([...refs]).map((reference) => {
    const canonical = normalized(reference);
    const exact = available.filter((file) => file === reference);
    const matches = exact.length ? exact : available.filter((file) => normalized(file) === canonical || normalized(file).endsWith(`/${canonical}`));
    const hidden = !safe(reference) || inventory.some((file) => !safe(file) &&
      (normalized(file) === canonical || normalized(file).endsWith(`/${canonical}`)));
    return { reference, status: matches.length === 1 ? 'resolved' : matches.length > 1 ? 'ambiguous' : hidden ? 'unavailable' : 'missing', matches };
  });
  const scope = new Set(references.filter((ref) => ref.status === 'resolved').map((ref) => ref.matches[0]));
  for (const directory of directories) {
    const name = path.posix.basename(directory);
    if (mentioned(lower, normalized(directory)) || (name.length >= 5 && mentioned(lower, normalized(name)))) scope.add(directory);
  }
  // Bounded hints help descriptions without paths; the preview exposes every choice.
  if (/\bnpm\b|\brun\s+[a-z][a-z0-9:_-]*\b|package\.json/.test(lower) && availableFiles.includes('package.json')) scope.add('package.json');
  if (/webpack|вебпак/.test(lower)) for (const candidate of candidates) if (candidate.startsWith('webpack')) scope.add(candidate);
  if (/тип|type|interface/.test(lower) && directories.has('src/interfaces')) scope.add('src/interfaces');
  if (!scope.size && !references.length && candidates.length <= 8) candidates.forEach((file) => scope.add(file));
  // Trusted legacy adapters may expose roots only. They still require an explicit
  // preview selection for unresolved references; no fabricated inventory is used.
  if (files === null && !scope.size && !references.length && candidates.length <= 64) candidates.forEach((file) => scope.add(file));
  const previewHash = hashObject({ version: 1, fields, contextHash: project.contextHash, inventory: files === null ? null : inventory,
    candidates, contextPaths: unique(project.contextPaths), outputPaths: unique(outputPaths), forbiddenPaths: unique(forbiddenPaths) });
  const feedback = [];
  let selectedScope = [...scope];
  if (selection) {
    const parsed = ContextSelectionSchema.safeParse(selection);
    if (!parsed.success) fail('Некорректный выбор файлов задачи');
    selection = parsed.data;
    if (selection.previewHash !== previewHash) throw new GraphError('STALE_CONTEXT', 'Описание или файлы изменились. Проверьте область задачи заново.');
    if (new Set(selection.scope).size !== selection.scope.length) fail('Пути области задачи повторяются');
    selectedScope = selection.scope.map((file) => file.replace(/\/$/, ''));
    for (const file of selectedScope) {
      if (!safe(file)) fail('Путь недоступен для задачи: выберите обычные файлы проекта, вне закрытых областей и результатов сборки.');
      if (fileSet.has(file) && !availableFiles.includes(file)) fail('Выбранный файл недоступен');
      if (inventory.some((existing) => existing !== file && isWithin(file, existing))) fail('Родитель выбранного пути является файлом');
    }
    const resolved = new Set();
    for (const choice of selection.resolutions) {
      const ref = references.find((item) => item.reference === choice.reference);
      if (!ref || resolved.has(choice.reference)) fail('Уточнение не относится к текущему описанию либо повторяется');
      resolved.add(choice.reference);
      if (ref.status === 'unavailable' && choice.kind !== 'example') fail('Закрытый или исключенный путь нельзя разрешить уточнением задачи');
      if (choice.kind === 'example') {
        ref.status = 'resolved';
        feedback.push(`Пользователь уточнил: ${choice.reference} — пример или справочная ссылка, доступ к этому файлу не требуется. Это не отменяет остальные требования задачи.`);
      } else {
        if (files === null) fail('Для выбора исходного или нового файла нужен доступный снимок файлов проекта');
        if (!safe(choice.path) || !selectedScope.some((root) => isWithin(choice.path, root))) fail('Путь уточнения должен входить в выбранную область задачи');
        if (choice.kind === 'existing' && !available.includes(choice.path)) fail('Выбранный исходный файл отсутствует в доступном снимке проекта');
        if (choice.kind === 'create' && (fileSet.has(choice.path) || directories.has(choice.path))) fail('Новый путь уже существует; выберите существующий файл');
        ref.status = 'resolved';
        feedback.push(choice.kind === 'existing'
          ? `Пользователь указал исходный файл для ${choice.reference}: ${choice.path}.`
          : `Пользователь уточнил: ${choice.reference} обозначает новый файл ${choice.path}. Его еще нет; создание не доказывает перенос или сохранность отсутствующих исходных данных.`);
      }
    }
    for (const ref of references) {
      if (resolved.has(ref.reference)) continue;
      const selectedMatches = ref.matches.filter((file) => selectedScope.some((root) => isWithin(file, root)));
      if (selectedMatches.length === 1) ref.status = 'resolved';
      else if (ref.status === 'resolved') ref.status = 'missing';
    }
  }
  // Keep an explicitly named parent; remove only redundant descendants.
  selectedScope = unique(selectedScope).filter((file, _, all) => !all.some((parent) => parent !== file && isWithin(file, parent)));
  const issues = [];
  if (!selectedScope.length) issues.push('Выберите файлы или папки, к которым относится задача. Можно указать путь нового файла.');
  if (selectedScope.length > 64) issues.push('Выберите не более 64 файлов или папок для одной задачи.');
  if (references.length > 32) issues.push('В описании больше 32 отдельных файлов. Укажите общие папки и оставьте ключевые ссылки.');
  for (const ref of references.slice(0, 32)) {
    if (ref.status === 'missing') issues.push(`Не найден исходный файл «${ref.reference}». Укажите существующий путь или уточните, что файл нужно создать.`);
    if (ref.status === 'ambiguous') issues.push(`Найдено несколько файлов «${ref.reference}». Выберите нужный.`);
    if (ref.status === 'unavailable') issues.push(`«${ref.reference}» относится к закрытому или исключенному контексту. Уточните описание или настройки проекта.`);
  }
  return { contextHash: project.contextHash, previewHash, scope: selectedScope.slice(0, 64), candidates,
    references: references.slice(0, 32), issues, ready: issues.length === 0, feedback };
}

/** Natural intake starts discovery, not an implementation claim or a guessed move. */
export function initialTaskContext(preview, project, confirmed = false) {
  const minimalStart = !confirmed && preview.candidates.includes('package.json') &&
    (!preview.references.length || ['claude', 'cursor'].includes(project.ai?.provider));
  const scope = minimalStart ? ['package.json'] : preview.scope.length ? preview.scope :
    preview.candidates.includes('package.json') ? ['package.json'] : preview.candidates.slice(0, 1);
  if (!scope.length) throw new GraphError('INTAKE_SCOPE_UNCLEAR', 'Нет доступных файлов проекта для анализа');
  const notes = [...preview.feedback, ...preview.references.filter((ref) => ref.status !== 'resolved').map((ref) =>
    `Ссылка ${ref.reference}: ${ref.status === 'ambiguous' ? `несколько совпадений (${ref.matches.slice(0, 8).join(', ')})` : ref.status === 'unavailable' ? 'закрытая или исключенная область' : 'не разрешена по именам доступных файлов'}. Это предварительный поиск, не доказательство отсутствия данных. Исследуй доступный контекст и запроси необходимые пути через contextRequests.`)].slice(0, 32);
  if (minimalStart && notes.length < 32) notes.push('Начальный контекст ограничен manifest проекта. Изучи команды и структуру, затем запроси необходимые исходники через contextRequests; scope пока не является полным планом изменений.');
  return { scope, notes, discovery: true };
}
