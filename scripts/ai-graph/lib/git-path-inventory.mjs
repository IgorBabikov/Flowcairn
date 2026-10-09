import { spawnSync } from 'node:child_process';
import { openSync, closeSync, readSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitExecutable, gitNullDevice, hostSystemEnvironment } from './host-executables.mjs';
import { GraphError } from './io.mjs';

/** Complete NUL-delimited Git output, spilled to a private temporary file.
 * Directory/file totals never become maxBuffer or item-count failures.
 * A failed/timed-out Git process is not parsed as a complete inventory.
 */
export function readGitPathInventory(root, args) {
  const scratch = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'flowcairn-git-paths-'));
  let fd;
  const fail = () => { throw new GraphError('WORKSPACES_GIT', 'Не удалось получить полный стабильный список Git-путей workspace.'); };
  try {
    fd = openSync(path.join(scratch, 'paths'), 'wx+', 0o600);
    const result = spawnSync(gitExecutable(), ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args], {
      cwd: root, stdio: ['ignore', fd, 'ignore'], timeout: 10000, shell: false,
      env: { ...hostSystemEnvironment(), PATH: '/usr/bin:/bin', LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitNullDevice },
    });
    if (result.error || result.status !== 0 || result.signal) fail();
    const buffer = Buffer.alloc(64 * 1024), decoder = new TextDecoder('utf-8', { fatal: true });
    const paths = new Set(); let offset = 0, pending = '';
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, offset);
      if (!count) break;
      offset += count;
      const text = pending + decoder.decode(buffer.subarray(0, count), { stream: true });
      const pieces = text.split('\0'); pending = pieces.pop();
      for (const entry of pieces) if (entry) paths.add(entry);
    }
    pending += decoder.decode();
    if (pending) fail();
    return [...paths];
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(scratch, { recursive: true, force: true });
  }
}
