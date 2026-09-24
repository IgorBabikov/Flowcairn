import { gitExecutable, gitNullDevice, hostSystemEnvironment } from './host-executables.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GraphError } from './io.mjs';

export const MAX_DIFF_BYTES = 3 * 1024 * 1024;

export function diffHeader(file, previous, current) {
  return `diff --git ${JSON.stringify(`a/${file}`)} ${JSON.stringify(`b/${file}`)}\n${!previous ? `new file mode ${current.mode}\n` : !current ? `deleted file mode ${previous.mode}\n` : previous.mode !== current.mode ? `old mode ${previous.mode}\nnew mode ${current.mode}\n` : ''}`;
}

/** Trusted Git computes exact hunks from private attempt bytes, never from HEAD or user config. */
export function unifiedDiff(file, previous, current, oldBytes, newBytes) {
  const header = diffHeader(file, previous, current);
  if (oldBytes.equals(newBytes)) return header;
  const directory = mkdtempSync(path.join(os.tmpdir(), 'flowcairn-diff-'));
  try {
    writeFileSync(path.join(directory, 'before'), oldBytes, { mode: 0o600, flag: 'wx' });
    writeFileSync(path.join(directory, 'after'), newBytes, { mode: 0o600, flag: 'wx' });
    const result = spawnSync(gitExecutable(), [
      'diff', '--no-index', '--text', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames',
      '--diff-algorithm=myers', '--no-indent-heuristic', '--unified=3', '--', 'before', 'after',
    ], { cwd: directory, encoding: 'utf8', timeout: 10000, maxBuffer: MAX_DIFF_BYTES, shell: false,
      env: { ...hostSystemEnvironment(), PATH: '/usr/bin:/bin', HOME: directory, XDG_CONFIG_HOME: directory, LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitNullDevice, GIT_ATTR_NOSYSTEM: '1' } });
    if (result.error || result.status !== 1 || typeof result.stdout !== 'string')
      throw new GraphError('DIFF_UNAVAILABLE', 'Не удалось получить полный ограниченный diff начала и конца попытки');
    const hunk = result.stdout.indexOf('\n@@ ');
    if (hunk < 0) throw new GraphError('DIFF_UNAVAILABLE', 'Git не предоставил проверяемые текстовые hunks');
    return `${header}--- ${previous ? JSON.stringify(`a/${file}`) : gitNullDevice}\n+++ ${current ? JSON.stringify(`b/${file}`) : gitNullDevice}\n${result.stdout.slice(hunk + 1)}`;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
