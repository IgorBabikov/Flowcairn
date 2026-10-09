import { lstatHostSync as lstatSync } from './host-filesystem.mjs';
import { classifySource } from './source-policy.mjs';
import { opendirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { scanSourceFile } from './source-file-scan.mjs';
import { TextDecoder } from 'node:util';
import { GraphError, canonicalJson, sha256 } from './io.mjs';
import { isSensitivePath } from './registry.mjs';

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
  try {
    const { hash, size, mode, secret } = scanSourceFile(file);
    return { path: relative, hash, size, mode, privateContent: secret };
  } catch (error) { fail(error.code === 'SOURCE_FILE_CHANGED' ? 'DIRECT_CHANGED' : error.code, `Не удалось проверить файл: ${relative}`); }
}

function scan(root, outputPaths) {
  const files = [], privateFiles = [];
  const pending = [{ directory: root, relative: '' }];
  while (pending.length) {
    const { directory, relative } = pending.pop();
    const before = lstatSync(directory);
    if (!before.isDirectory() || before.isSymbolicLink()) fail('DIRECT_DIRECTORY', 'Каталог проекта изменился');
    const dir = opendirSync(directory, /** @type {any} */ ({ encoding: 'buffer' }));
    try {
      let entry;
      while ((entry = dir.readSync())) {
        const name = pathName(entry.name);
        const target = path.join(directory, name), file = relative ? `${relative}/${name}` : name;
        if (PRIVATE_ROOTS.has(name)) {
          const excluded = lstatSync(target);
          if (excluded.isSymbolicLink()) fail('DIRECT_LINK', `Недопустимая ссылка: ${file}`);
          continue;
        }
        if (['dependency', 'output'].includes(classifySource(file).reason) || outputPaths.some((prefix) => within(file, prefix))) {
          if (lstatSync(target).isSymbolicLink()) fail('DIRECT_LINK', `Недопустимая ссылка в результатах: ${file}`);
          continue;
        }
        const stat = lstatSync(target);
        if (stat.isSymbolicLink()) fail('DIRECT_LINK', `Недопустимая ссылка: ${file}`);
        if (stat.isDirectory()) { pending.push({ directory: target, relative: file }); continue; }
        const { privateContent, ...descriptor } = readRegular(target, file);
        if (isSensitivePath(file) || privateContent) privateFiles.push({ path: file, hash: descriptor.hash });
        else files.push(descriptor);
      }
    } finally { dir.closeSync(); }
    const after = lstatSync(directory);
    if (after.ino !== before.ino || after.dev !== before.dev || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
      fail('DIRECT_CHANGED', `Каталог проекта изменился во время проверки: ${relative || '.'}`);
  }
  const byPath = (left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  return { files: files.sort(byPath), privateFiles: privateFiles.sort(byPath) };
}

export function validateDirectOutputPaths(outputPaths) {
  if (!Array.isArray(outputPaths) || outputPaths.length > 128)
    fail('DIRECT_OPTIONS', 'Слишком много путей проверки');
  const outputs = stable(outputPaths);
  if (outputs.some((value) => typeof value !== 'string' || !value || value.startsWith('/') || value.includes('..') ||
    value.split('/').some((part) => !part || PRIVATE_ROOTS.has(part) || isSensitivePath(part)) ||
    ['src', 'app', 'lib', 'scripts', 'test', 'tests', 'package.json'].some((source) => within(source, value))))
    fail('DIRECT_OPTIONS', 'Каталог исходников нельзя исключить как результат сборки');
  return outputs;
}

/** Hash the live project directory. Sensitive files affect freshness but never enter AI file lists. */
export function fingerprintDirectWorkspace(root, { outputPaths = [], baselinePaths = [] } = {}) {
  const canonical = realpathSync(root);
  if (!lstatSync(canonical).isDirectory()) fail('DIRECT_ROOT', 'Нужен каталог проекта');
  if (!Array.isArray(baselinePaths) || baselinePaths.length > 512) fail('DIRECT_OPTIONS', 'Слишком много путей проверки');
  const outputs = validateDirectOutputPaths(outputPaths);
  const first = scan(canonical, outputs), second = scan(canonical, outputs);
  if (canonicalJson(first) !== canonicalJson(second)) fail('DIRECT_CHANGED', 'Проект изменился во время проверки');
  if (baselinePaths.some((file) => !second.files.some((entry) => entry.path === file)))
    fail('BASELINE_PATH_MISSING', 'Ожидаемый файл проекта отсутствует');
  const git = { head: null, indexHash: sha256(canonicalJson(second.privateFiles)) };
  const result = { files: second.files, git };
  return { ...result, hash: sha256(canonicalJson(result)) };
}
