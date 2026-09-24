import { lstatHostSync as lstatSync, fstatHostSync as fstatSync } from '../scripts/ai-graph/lib/host-filesystem.mjs';
import { gitExecutable } from '../scripts/ai-graph/lib/host-executables.mjs';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, existsSync, openSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { GraphError } from '../scripts/ai-graph/lib/io.mjs';
import { assertRuntimePlatform, assertProjectPlatform } from '../scripts/ai-graph/lib/platform.mjs';

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
  if (!existsSync(path.join(root, 'package.json')))
    fail('PACKAGE_JSON', 'Укажите папку Node-проекта с package.json');
  // New direct projects need their own package root, not a preexisting Git repository.
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
