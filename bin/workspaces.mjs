import { readGitPathInventory } from '../scripts/ai-graph/lib/git-path-inventory.mjs';
import { collectInstructionFile } from '../scripts/ai-graph/lib/instruction-reader.mjs';
import {
  lstatSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';
import picomatch from 'picomatch';
import { GraphError } from '../scripts/ai-graph/lib/io.mjs';
import { assertJsonBounds } from '../scripts/ai-graph/lib/schemas.mjs';

const EXCLUDED_SEGMENTS = new Set(['node_modules', '.git', '.ai-orchestrator']);
const PATHSPECS = [...EXCLUDED_SEGMENTS].map((name) => `:(exclude,glob)**/${name}/**`);
const fail = (code, message) => {
  throw new GraphError(code, message);
};

function relativePath(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 4096 ||
    value.includes('\\') ||
    [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
    path.posix.isAbsolute(value) ||
    /^[a-z]:/i.test(value) ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  )
    fail(
      'WORKSPACES_PATH',
      'Путь workspace должен быть относительным и оставаться внутри проекта.',
    );
  return value;
}

function physicalFile(root, relative) {
  relativePath(relative);
  const pieces = relative.split('/');
  let candidate = root;
  for (let index = 0; index < pieces.length; index++) {
    candidate = path.join(candidate, pieces[index]);
    let stat;
    try {
      stat = lstatSync(candidate);
    } catch {
      fail('WORKSPACES_FILE', 'Manifest workspace отсутствует или недоступен для чтения.');
    }
    const last = index === pieces.length - 1;
    if (
      stat.isSymbolicLink() ||
      (last ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())
    )
      fail(
        'WORKSPACES_FILE',
        'Файлы workspace и родительские папки должны быть внутри проекта, без ссылок.',
      );
    if (!realpathSync(candidate).startsWith(`${root}${path.sep}`))
      fail('WORKSPACES_PATH', 'Manifest workspace выходит за пределы проекта.');
  }
  return candidate;
}

function workspacePatterns(root, pkg, manager) {
  const yamlPath = path.join(root, 'pnpm-workspace.yaml');
  let yamlPresent = false;
  try {
    lstatSync(yamlPath);
    yamlPresent = true;
  } catch (error) {
    if (error.code !== 'ENOENT')
      fail('WORKSPACES_FILE', 'Не удалось проверить конфигурацию workspace.');
  }
  if (manager === 'pnpm' && yamlPresent) {
    const file = physicalFile(root, 'pnpm-workspace.yaml');
    const text = collectInstructionFile(file).bytes.toString('utf8');
    try {
      const doc = parseDocument(text, { strict: true, uniqueKeys: true });
      if (doc.errors.length || doc.warnings.length)
        fail('WORKSPACES_YAML', 'YAML workspace содержит ошибки или неподдерживаемые теги.');
      const data = doc.toJS({ maxAliasCount: 50 });
      assertJsonBounds(data, 10000);
      if (!data || typeof data !== 'object' || Array.isArray(data))
        fail('WORKSPACES_YAML', 'В pnpm-workspace.yaml нужен объект настроек.');
      if (!Object.hasOwn(data, 'packages')) return [];
      if (!Array.isArray(data.packages))
        fail('WORKSPACES_YAML', 'Поле packages должно быть массивом.');
      return data.packages;
    } catch (error) {
      if (error instanceof GraphError && error.code === 'WORKSPACES_YAML') throw error;
      fail(
        'WORKSPACES_YAML',
        'YAML workspace некорректен или превышает лимит ссылок и вложенности.',
      );
    }
  }
  if (pkg.workspaces === undefined) return [];
  if (Array.isArray(pkg.workspaces)) return pkg.workspaces;
  if (
    pkg.workspaces &&
    typeof pkg.workspaces === 'object' &&
    Array.isArray(pkg.workspaces.packages)
  )
    return pkg.workspaces.packages;
  fail(
    'WORKSPACES_PATTERNS',
    'Поле workspaces в package.json должно быть массивом или объектом с packages.',
  );
}

function compilePatterns(patterns) {
  if (!Array.isArray(patterns))
    fail('WORKSPACES_PATTERNS', 'Шаблоны workspace должны быть массивом.');
  const positive = [],
    negative = [];
  for (const raw of patterns) {
    if (typeof raw !== 'string' || !raw || raw.length > 512)
      fail('WORKSPACES_PATTERNS', 'Шаблон workspace должен быть непустой строкой до 512 символов.');
    const excluded = raw.startsWith('!');
    const pattern = (excluded ? raw.slice(1) : raw).replace(/\/$/, '');
    relativePath(pattern);
    if (pattern.includes('..'))
      fail('WORKSPACES_PATTERNS', 'Шаблон workspace не может переходить в родительские папки.');
    if (pattern.split('/').some((part) => EXCLUDED_SEGMENTS.has(part)))
      fail(
        'WORKSPACES_PATTERNS',
        'Шаблон workspace не может включать папки зависимостей и служебного состояния.',
      );
    try {
      (excluded ? negative : positive).push(picomatch(pattern, { dot: true, nonegate: true }));
    } catch {
      fail('WORKSPACES_PATTERNS', 'Некорректный шаблон workspace.');
    }
  }
  if (patterns.length && !positive.length)
    fail('WORKSPACES_PATTERNS', 'Нужен хотя бы один включающий шаблон workspace.');
  return (directory) =>
    positive.some((match) => match(directory)) && !negative.some((match) => match(directory));
}

function gitPaths(root, ignored) {
  const args = ignored
    ? [
        'ls-files',
        '--others',
        '--ignored',
        '--exclude-standard',
        '-z',
        '--',
        ':(glob)**/package.json',
        ...PATHSPECS,
      ]
    : ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.', ...PATHSPECS];
  const entries = readGitPathInventory(root, args);
  return entries.filter((file) => !file.split('/').some((part) => EXCLUDED_SEGMENTS.has(part)));
}

/** Returns child manifests only. The caller keeps root/lock/config manifests intact. */
export function discoverWorkspaceManifests(root, pkg, manager) {
  const canonical = realpathSync(root);
  const patterns = workspacePatterns(canonical, pkg, manager);
  const matches = compilePatterns(patterns);
  if (patterns.length === 0) return [];
  const manifests = [];
  for (const file of gitPaths(canonical, false)) {
    relativePath(file);
    const directory = path.posix.dirname(file);
    if (file.endsWith('/package.json') && matches(directory)) {
      physicalFile(canonical, file);
      manifests.push(file);
    } else if (matches(file)) {
      // A tracked directory symlink has no descendant Git files; reject it explicitly.
      let stat;
      try {
        stat = lstatSync(path.join(canonical, file));
      } catch {
        continue;
      }
      if (stat.isSymbolicLink())
        fail('WORKSPACES_FILE', 'Папка workspace не может быть символической ссылкой.');
    }
  }
  if (
    gitPaths(canonical, true).some(
      (file) => file.endsWith('/package.json') && matches(path.posix.dirname(file)),
    )
  )
    fail(
      'WORKSPACES_IGNORED',
      'Git игнорирует найденные manifests workspace. Уберите их из ignore или явно исключите из workspace.',
    );
  return manifests.sort();
}
