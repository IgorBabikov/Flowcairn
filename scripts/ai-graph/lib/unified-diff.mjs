import { gitNullDevice } from './host-executables.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GraphError, sha256 } from './io.mjs';

export const MAX_DIFF_BYTES = 3 * 1024 * 1024;
export const DIFF_TIMEOUT_MS = 10_000;
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const WORKER = fileURLToPath(new URL('./diff-worker.mjs', import.meta.url));
const unavailable = () => new GraphError('DIFF_UNAVAILABLE', 'Не удалось получить полный ограниченный diff начала и конца попытки');

export function diffHeader(file, previous, current) {
  return `diff --git ${JSON.stringify(`a/${file}`)} ${JSON.stringify(`b/${file}`)}\n${!previous ? `new file mode ${current.mode}\n` : !current ? `deleted file mode ${previous.mode}\n` : previous.mode !== current.mode ? `old mode ${previous.mode}\nnew mode ${current.mode}\n` : ''}`;
}

/** Fixed Node worker computes exact hunks from private bytes; no Git or shell.
 * @param {{signal?: AbortSignal}} [options]
 */
export async function unifiedDiff(file, previous, current, oldBytes, newBytes, options = {}) {
  const { signal } = options;
  if (signal?.aborted || oldBytes.length > MAX_INPUT_BYTES || newBytes.length > MAX_INPUT_BYTES) throw unavailable();
  const header = diffHeader(file, previous, current);
  if (oldBytes.equals(newBytes)) return header;
  const prefix = `${header}--- ${previous ? JSON.stringify(`a/${file}`) : gitNullDevice}\n+++ ${current ? JSON.stringify(`b/${file}`) : gitNullDevice}\n`;
  const budget = MAX_DIFF_BYTES - Buffer.byteLength(prefix);
  if (budget <= 0) throw unavailable();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'flowcairn-diff-'));
  try {
    const canonicalDirectory = await realpath(directory);
    const metadata = { version: 1, before: { size: oldBytes.length, hash: sha256(oldBytes) },
      after: { size: newBytes.length, hash: sha256(newBytes) }, budget };
    const input = JSON.stringify(metadata);
    const written = await Promise.allSettled([
      writeFile(path.join(directory, 'before'), oldBytes, { mode: 0o600, flag: 'wx' }),
      writeFile(path.join(directory, 'after'), newBytes, { mode: 0o600, flag: 'wx' }),
      writeFile(path.join(directory, 'input.json'), input, { mode: 0o600, flag: 'wx' }),
    ]);
    if (written.some(result => result.status === 'rejected')) throw unavailable();
    if (signal?.aborted) throw unavailable();
    const body = await new Promise((resolve, reject) => {
      const env = { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
        ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, TEMP: directory, TMP: directory } : {}) };
      const child = spawn(process.execPath, ['--max-old-space-size=128', WORKER, canonicalDirectory, sha256(input)],
        { cwd: canonicalDirectory, shell: false, stdio: ['ignore', 'pipe', 'ignore'], env });
      const chunks = [];
      let bytes = 0, failed = false;
      const stop = () => { failed = true; child.kill('SIGKILL'); };
      const timer = setTimeout(stop, DIFF_TIMEOUT_MS);
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) stop();
      child.stdout.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > budget) { chunks.length = 0; stop(); } else if (!failed) chunks.push(chunk);
      });
      child.once('error', () => { failed = true; });
      child.once('close', (code) => {
        clearTimeout(timer); signal?.removeEventListener('abort', stop);
        if (failed || code !== 0) reject(unavailable());
        else resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });
    if (typeof body !== 'string' || !body.startsWith('@@ ') || !body.endsWith('\n')) throw unavailable();
    return prefix + body;
  } catch { throw unavailable(); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
