import { spawn } from 'node:child_process';
import { GraphError } from './io.mjs';

/** Resolve only after the owned process and its output pipes have closed. */
export function boundedProcess(command, args, { cwd, timeoutMs, maxBytes = 1024 * 1024, input = '', timeoutCode = 'PROCESS_TIMEOUT' }) {
  return new Promise((resolve, reject) => {
    const detached = process.platform !== 'win32';
    const child = spawn(command, args, { cwd, detached, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    let bytes = 0, failure = null, killTimer, closed = null, escalated = false;
    const finish = () => {
      if (!closed || (failure && !escalated)) return;
      if (failure) reject(failure);
      else resolve(closed);
    };
    const kill = signal => {
      try {
        if (detached && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* The owned group may already have exited. */ }
    };
    const stop = error => {
      if (failure) return;
      failure = error;
      kill('SIGTERM');
      killTimer = setTimeout(() => {
        kill('SIGKILL');
        escalated = true;
        finish();
      }, 500);
    };
    const timer = setTimeout(() => stop(new GraphError(timeoutCode, 'Подготовка задачи превысила допустимое время. Результат операции нужно проверить перед повтором.')), timeoutMs);
    const collect = target => chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) stop(new GraphError('PROCESS_OUTPUT_LIMIT', 'Ответ служебного процесса превышает лимит.'));
      else target.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.stdin.on('error', () => { /* Early exit is handled by close/error. */ });
    child.once('error', error => { clearTimeout(timer); clearTimeout(killTimer); reject(error); });
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      closed = { status, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
      finish();
    });
    child.stdin.end(input);
  });
}
