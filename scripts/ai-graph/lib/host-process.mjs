import { windowsProcessInspector } from './windows-job.mjs';
import { hostSystemEnvironment } from './host-executables.mjs';
import { spawnSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

const validPid = (pid) => Number.isSafeInteger(pid) && pid > 0 && pid <= 0xffffffff;
const same = (a, b) => a && b && a.pid === b.pid && a.parentPid === b.parentPid && Number.isFinite(Date.parse(a.startedAt)) && path.win32.isAbsolute(a.executable) && a.startedAt === b.startedAt && a.executable.toLowerCase() === b.executable.toLowerCase();
function systemTool(name) {
  const root = process.env.SystemRoot;
  if (!root || !/^[a-z]:\\[^\r\n]*$/i.test(root)) throw new Error('WINDOWS_SYSTEM_ROOT');
  const file = path.win32.join(root, 'System32', ...name.split('/'));
  const resolved = realpathSync(file);
  if (resolved.toLowerCase() !== file.toLowerCase() || !lstatSync(resolved).isFile()) throw new Error('WINDOWS_SYSTEM_TOOL');
  return resolved;
}

export function listHostProcesses({ run = spawnSync, tool = windowsProcessInspector } = {}) {
  const executable = tool();
  const result = run(executable, ['--inspect-processes'], {
    shell: false, windowsHide: true, encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024,
    env: hostSystemEnvironment(),
  });
  if (result.error) throw new Error(/** @type {NodeJS.ErrnoException} */ (result.error).code === 'ETIMEDOUT' ? 'PROCESS_INSPECTION_TIMEOUT' : 'PROCESS_INSPECTION_SPAWN_FAILED');
  if (result.signal || result.status !== 0) throw new Error('PROCESS_INSPECTION_EXIT_FAILED');
  if (typeof result.stdout !== 'string') throw new Error('PROCESS_INSPECTION_OUTPUT_INVALID');
  let rows;
  try { rows = JSON.parse(result.stdout.replace(/^\uFEFF/, '')); }
  catch { throw new Error('PROCESS_INSPECTION_OUTPUT_INVALID'); }
  if (!Array.isArray(rows) || rows.length > 50000) throw new Error('PROCESS_INSPECTION_FAILED');
  const seen = new Set();
  for (const row of rows) {
    if (!row || !Number.isSafeInteger(row.pid) || row.pid < 0 || !Number.isSafeInteger(row.parentPid) || row.parentPid < 0 || typeof row.startedAt !== 'string' || typeof row.executable !== 'string' || seen.has(row.pid)) throw new Error('PROCESS_INSPECTION_FAILED');
    seen.add(row.pid);
  }
  return rows;
}

export function inspectHostProcess(pid, { platform = process.platform, list = listHostProcesses } = {}) {
  if (!validPid(pid)) throw new Error('INVALID_PROCESS_ID');
  if (platform !== 'win32') throw new Error('PROCESS_IDENTITY_UNSUPPORTED');
  const item = list().find((row) => row.pid === pid);
  if (!item) return null;
  if (!item.startedAt || !Number.isFinite(Date.parse(item.startedAt)) || !path.win32.isAbsolute(item.executable)) throw new Error('PROCESS_IDENTITY_UNKNOWN');
  return { pid: item.pid, parentPid: item.parentPid, startedAt: item.startedAt, executable: item.executable };
}

export function hostGroupAlive(pid, { platform = process.platform, identity = null, list = listHostProcesses, kill = process.kill } = {}) {
  if (!validPid(pid)) return null;
  if (platform === 'win32') {
    if (!identity || identity.pid !== pid) return null;
    try {
      const rows = list();
      const current = rows.find((row) => row.pid === pid);
      // Missing root alone cannot prove that its descendants have stopped.
      if (!current || !same(current, identity)) return null;
      return true;
    } catch { return null; }
  }
  try { kill(-pid, 0); return true; } catch (error) { return error.code === 'ESRCH' ? false : null; }
}

export function stopHostGroup(pid, { platform = process.platform, identity = null, list = listHostProcesses, run = spawnSync, tool = systemTool, kill = process.kill } = {}) {
  if (!validPid(pid)) return false;
  if (platform !== 'win32') {
    try { kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') return false; }
    return hostGroupAlive(pid, { platform, kill }) === false;
  }
  if (!identity || identity.pid !== pid) return false;
  try {
    const before = list();
    const root = before.find((row) => row.pid === pid);
    if (!same(root, identity)) return false;
    const tree = new Map([[pid, root]]);
    for (let changed = true; changed;) {
      changed = false;
      for (const row of before) {
        const parent = tree.get(row.parentPid);
        if (tree.has(row.pid) || !parent) continue;
        if (!Number.isFinite(Date.parse(row.startedAt)) || !path.win32.isAbsolute(row.executable) || Date.parse(row.startedAt) < Date.parse(parent.startedAt)) return false;
        tree.set(row.pid, row); changed = true;
      }
    }
    // Revalidate immediately before targeting a numeric PID; never kill a reused PID.
    const current = list();
    if ([...tree.values()].some((row) => !same(current.find((entry) => entry.pid === row.pid), row))
      || current.some((row) => tree.has(row.parentPid) && !tree.has(row.pid))) return false;
    const result = run(tool('taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
    if (result.error || result.signal || result.status !== 0) return false;
    const after = list();
    // A newly observed descendant or surviving identity leaves termination uncertain.
    return !after.some((row) => tree.has(row.pid) || tree.has(row.parentPid));
  } catch { return false; }
}
