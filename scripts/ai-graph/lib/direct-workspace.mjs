import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { GraphError, canonicalJson, sha256 } from './io.mjs';
import { isSensitivePath } from './registry.mjs';

const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_DEPTH = 128;
const PRIVATE_ROOTS = new Set(['.git', '.ai', '.ai-orchestrator', '.DS_Store', 'node_modules', '.agents', '.codex', '.claude']);
const decoder = new TextDecoder('utf-8', { fatal: true });
const fail = (code, reason) => { throw new GraphError(code, reason); };
const within = (file, prefix) => file === prefix || file.startsWith(`${prefix}/`);
const stable = (values) => [...new Set(values)].sort();

function pathName(buffer) {
  let value;
  try { value = decoder.decode(buffer); } catch { fail('DIRECT_PATH', 'Имя файла должно быть UTF-8'); }
  if (!value || value === '.' || value === '..' || /[\\/\0\r\n]/.test(value))
    fail('DIRECT_PATH', 'Недопустимое имя файла проекта');
  return value;
}

function readRegular(file, relative) {
  const before = lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_FILE_BYTES)
    fail('DIRECT_FILE', `Небезопасный или слишком большой файл: ${relative}`);
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size)
      fail('DIRECT_CHANGED', `Файл изменился до чтения: ${relative}`);
    const body = readFileSync(fd);
    const after = fstatSync(fd);
    const live = lstatSync(file);
    if (body.length !== before.size || [after, live].some((stat) => stat.ino !== before.ino || stat.dev !== before.dev ||
      stat.size !== before.size || stat.mtimeMs !== before.mtimeMs || stat.ctimeMs !== before.ctimeMs))
      fail('DIRECT_CHANGED', `Файл изменился во время чтения: ${relative}`);
    return { path: relative, hash: sha256(body), size: body.length,
      mode: (before.mode & 0o111) ? '100755' : '100644' };
  } finally { if (fd !== undefined) closeSync(fd); }
}

function scan(root, outputPaths) {
  const files = [], privateFiles = [];
  let totalBytes = 0;
  const walk = (directory, relative, depth) => {
    if (depth > MAX_DEPTH) fail('DIRECT_LIMIT', 'Слишком глубокое дерево проекта');
    const before = lstatSync(directory);
    if (!before.isDirectory() || before.isSymbolicLink()) fail('DIRECT_DIRECTORY', 'Каталог проекта изменился');
    const entries = readdirSync(directory, { withFileTypes: true, encoding: 'buffer' })
      .map((entry) => ({ name: pathName(entry.name) })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const { name } of entries) {
      const target = path.join(directory, name), file = relative ? `${relative}/${name}` : name;
      if (PRIVATE_ROOTS.has(name)) {
        const excluded = lstatSync(target);
        if (excluded.isSymbolicLink()) fail('DIRECT_LINK', `Недопустимая ссылка: ${file}`);
        continue;
      }
      if (outputPaths.some((prefix) => within(file, prefix))) {
        if (lstatSync(target).isSymbolicLink()) fail('DIRECT_LINK', `Недопустимая ссылка в результатах: ${file}`);
        continue;
      }
      const stat = lstatSync(target);
      if (stat.isSymbolicLink()) fail('DIRECT_LINK', `Недопустимая ссылка: ${file}`);
      if (stat.isDirectory()) { walk(target, file, depth + 1); continue; }
      if (files.length + privateFiles.length >= MAX_FILES) fail('DIRECT_LIMIT', 'Слишком много файлов проекта');
      const descriptor = readRegular(target, file);
      totalBytes += descriptor.size;
      if (totalBytes > MAX_TOTAL_BYTES) fail('DIRECT_LIMIT', 'Проект превышает предел проверки');
      if (isSensitivePath(file)) privateFiles.push({ path: file, hash: descriptor.hash });
      else files.push(descriptor);
    }
    const after = lstatSync(directory);
    if (after.ino !== before.ino || after.dev !== before.dev || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
      fail('DIRECT_CHANGED', 'Каталог проекта изменился во время проверки');
  };
  walk(root, '', 0);
  const byPath = (left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  return { files: files.sort(byPath), privateFiles: privateFiles.sort(byPath) };
}

/** Hash the live project directory. Sensitive files affect freshness but never enter AI file lists. */
export function fingerprintDirectWorkspace(root, { outputPaths = [], baselinePaths = [] } = {}) {
  const canonical = realpathSync(root);
  if (!lstatSync(canonical).isDirectory()) fail('DIRECT_ROOT', 'Нужен каталог проекта');
  if (!Array.isArray(outputPaths) || outputPaths.length > 128 || !Array.isArray(baselinePaths) || baselinePaths.length > 512)
    fail('DIRECT_OPTIONS', 'Слишком много путей проверки');
  const outputs = stable(outputPaths);
  if (outputs.some((value) => typeof value !== 'string' || !value || value.startsWith('/') || value.includes('..') ||
    value.split('/').some((part) => !part || PRIVATE_ROOTS.has(part) || isSensitivePath(part)) ||
    ['src', 'app', 'lib', 'scripts', 'test', 'tests', 'package.json'].some((source) => within(source, value))))
    fail('DIRECT_OPTIONS', 'Каталог исходников нельзя исключить как результат сборки');
  const first = scan(canonical, outputs), second = scan(canonical, outputs);
  if (canonicalJson(first) !== canonicalJson(second)) fail('DIRECT_CHANGED', 'Проект изменился во время проверки');
  if (baselinePaths.some((file) => !second.files.some((entry) => entry.path === file)))
    fail('BASELINE_PATH_MISSING', 'Ожидаемый файл проекта отсутствует');
  const git = { head: null, indexHash: sha256(canonicalJson(second.privateFiles)) };
  const result = { files: second.files, git };
  return { ...result, hash: sha256(canonicalJson(result)) };
}
