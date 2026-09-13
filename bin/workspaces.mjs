import { spawnSync } from 'node:child_process';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { parseDocument } from 'yaml';
import picomatch from 'picomatch';
import { GraphError } from '../scripts/ai-graph/lib/io.mjs';
import { assertJsonBounds } from '../scripts/ai-graph/lib/schemas.mjs';

const MAX_CONFIG_BYTES = 128 * 1024;
const MAX_GIT_BYTES = 4 * 1024 * 1024;
const MAX_GIT_PATHS = 20000;
const MAX_MANIFESTS = 256;
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

function physicalFile(root, relative, maxBytes = 16 * 1024 * 1024) {
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
      (last ? !stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes : !stat.isDirectory())
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
    const file = physicalFile(root, 'pnpm-workspace.yaml', MAX_CONFIG_BYTES);
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let text;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_CONFIG_BYTES)
        fail(
          'WORKSPACES_FILE',
          'Конфигурация workspace должна быть обычным файлом до 128 КиБ, без ссылок.',
        );
      text = readFileSync(fd, 'utf8');
    } finally {
      closeSync(fd);
    }
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
  if (!Array.isArray(patterns) || patterns.length > 64)
    fail('WORKSPACES_PATTERNS', 'Шаблоны workspace должны быть массивом до 64 элементов.');
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
  const result = spawnSync(
    '/usr/bin/git',
    ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args],
    {
      cwd: root,
      encoding: 'buffer',
      maxBuffer: MAX_GIT_BYTES,
      timeout: 10000,
      shell: false,
      env: {
        PATH: '/usr/bin:/bin',
        LC_ALL: 'C',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
    },
  );
  if (result.error || result.status !== 0 || result.signal)
    fail('WORKSPACES_GIT', 'Не удалось получить список файлов workspace в пределах лимита.');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
  } catch {
    fail('WORKSPACES_PATH', 'Пути workspace должны иметь корректную кодировку UTF-8.');
  }
  if (text && !text.endsWith('\0'))
    fail('WORKSPACES_GIT', 'Git вернул неполный список путей workspace.');
  const entries = [...new Set(text.split('\0').filter(Boolean))];
  if (entries.length > MAX_GIT_PATHS)
    fail('WORKSPACES_GIT', 'Число файлов workspace превышает лимит.');
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
  if (manifests.length > MAX_MANIFESTS)
    fail('WORKSPACES_PATTERNS', 'Слишком много manifests workspace.');
  return manifests.sort();
}
