import { lstatHostSync as lstatSync, fstatHostSync as fstatSync } from '../scripts/ai-graph/lib/host-filesystem.mjs';
import { gitExecutable } from '../scripts/ai-graph/lib/host-executables.mjs';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, openSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { GraphError } from '../scripts/ai-graph/lib/io.mjs';
import { assertRuntimePlatform, assertProjectPlatform } from '../scripts/ai-graph/lib/platform.mjs';
import { CheckProfileSchema } from '../scripts/ai-graph/lib/check-profile.mjs';
import { readInstructionFile } from '../scripts/ai-graph/lib/instructions.mjs';

export const PROFILE = '.flowcairn.json';

function fail(code, message) {
  throw new GraphError(code, message);
}

export function git(root, args) {
  return execFileSync(gitExecutable(), ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
export function csv(value) {
  return typeof value === 'string'
    ? value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
    : [];
}
export function projectRoot(input = process.cwd()) {
  assertRuntimePlatform();
  const root = realpathSync(path.resolve(input));
  assertProjectPlatform(root);
  if (!lstatSync(root).isDirectory()) fail('PROJECT_ROOT', 'Укажите папку проекта.');
  // The host needs Node; the user's source tree needs neither npm nor Git.
  let profile;
  try { profile = JSON.parse(readRegular(path.join(root, PROFILE)).toString('utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!profile || profile.workspaceMode === 'direct') return root;
  let top;
  try {
    top = realpathSync(git(root, ['rev-parse', '--show-toplevel']));
  } catch {
    fail('GIT_REQUIRED', 'Укажите корень существующего Git-репозитория через --root.');
  }
  if (root !== top) fail('PROJECT_ROOT', `Команду нужно выполнить из корня Git: ${top}`);
  return root;
}

/** Explicit CLI import only: bounded project-local JSON, never an executable probe. */
export function readCheckProfile(root, relative) {
  if (typeof relative !== 'string' || relative.length > 512 || !relative.endsWith('.json') ||
      path.isAbsolute(relative) || /[\\\0\r\n]/.test(relative) ||
      relative.split('/').some((part) => !part || part === '.' || part === '..' || part.includes(':')))
    fail('CHECK_PROFILE_PATH', '--check-profile требует относительный путь к JSON внутри проекта.');
  let bytes;
  try { bytes = readInstructionFile(root, relative, 64 * 1024).bytes; }
  catch (error) {
    if (error.code?.startsWith('INSTRUCTION_'))
      fail('UNSAFE_FILE', 'Нужен ограниченный файл профиля без ссылок, секретных путей и изменений во время чтения.');
    throw error;
  }
  try { return CheckProfileSchema.parse(JSON.parse(bytes.toString('utf8'))); }
  catch { fail('CHECK_PROFILE_INVALID', 'Профиль проверок должен соответствовать строгой схеме CheckProfile v1.'); }
}
export function readRegular(file, max = 1024 * 1024) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > max)
      fail('UNSAFE_FILE', 'Ожидался обычный ограниченный файл без ссылок.');
    const bytes = readFileSync(fd);
    if (bytes.length > max) fail('UNSAFE_FILE', 'Файл превысил допустимый размер.');
    return bytes;
  } finally {
    closeSync(fd);
  }
}
export function existsNoFollow(file) {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
