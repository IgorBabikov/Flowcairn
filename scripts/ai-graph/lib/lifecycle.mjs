import { randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { GraphError, hashObject } from './io.mjs';
import { GraphStore } from './store.mjs';
import { ReceiptSchema, RunStateSchema } from './schemas.mjs';

export const LIFECYCLE_FENCE = '.ai-orchestrator/lifecycle-uninstall.lock';
export const LIFECYCLE_LEASES = '.ai-orchestrator/runtime-leases';
const leases = new Set();
const field = (value, key) => value && typeof value === 'object' ? value[key] : undefined;
const fail = (code, message) => { throw new GraphError(code, message); };
const processState = (pid) => {
  if (!Number.isSafeInteger(pid) || pid < 1) return 'unknown';
  try { process.kill(pid, 0); return 'active'; }
  catch (error) { return error.code === 'ESRCH' ? 'stopped' : 'unknown'; }
};
const exists = (file) => { try { lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
function directory(parent, name) {
  const file = path.join(parent, name);
  if (!exists(file)) mkdirSync(file, { mode: 0o700 });
  const stat = lstatSync(file);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) fail('LIFECYCLE_UNSAFE', 'Lifecycle storage должен быть private и без ссылок');
  return file;
}
function read(file) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077 || stat.size > 16384) fail('LIFECYCLE_UNSAFE', 'Некорректный lifecycle receipt');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}
function writeNew(file, value) {
  const fd = openSync(file, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); } finally { closeSync(fd); }
}
function paths(root) {
  const canonical = realpathSync(root);
  const control = directory(canonical, '.ai-orchestrator');
  return { root: canonical, control, leases: path.join(control, 'runtime-leases'), fence: path.join(control, 'lifecycle-uninstall.lock') };
}
function records(ctx) {
  if (!exists(ctx.leases)) return [];
  directory(ctx.control, 'runtime-leases');
  const names = readdirSync(ctx.leases);
  if (names.length > 256) fail('LIFECYCLE_LIMIT', 'Слишком много lifecycle receipts');
  return names.sort().map((name) => {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) fail('LIFECYCLE_UNSAFE', 'Неизвестный lifecycle receipt');
    const value = read(path.join(ctx.leases, name));
    if (value.version !== 1 || name !== `${value.identity}.json` || !['service', 'viewer', 'registration'].includes(value.kind) || !Number.isSafeInteger(value.pid) || value.pid < 1 || typeof value.startedAt !== 'string') fail('LIFECYCLE_UNSAFE', 'Некорректная identity lifecycle receipt');
    return { name, ...value };
  });
}
function removeOwn(file, expected) {
  try { if (hashObject(read(file)) === hashObject(expected)) unlinkSync(file); } catch { /* A replacement is not ours. */ }
}
process.once('exit', () => { for (const release of leases) release(); });

/** Live PID always blocks, including PID reuse. No cwd/command-name heuristics or force flag. */
export function acquireRuntimeLease({ root, kind = 'service' }) {
  if (!['service', 'viewer', 'registration'].includes(kind)) fail('LIFECYCLE_KIND', 'Неизвестный lifecycle owner');
  const ctx = paths(root);
  if (exists(ctx.fence)) fail('UNINSTALL_IN_PROGRESS', 'Остановлен запуск runtime: выполняется uninstall');
  const directoryPath = directory(ctx.control, 'runtime-leases');
  const identity = randomUUID();
  const receipt = { version: 1, kind, pid: process.pid, identity, startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString() };
  const file = path.join(directoryPath, `${identity}.json`);
  writeNew(file, receipt);
  let released = false;
  const release = () => {
    if (released) return;
    released = true; leases.delete(release); removeOwn(file, receipt);
    try { rmdirSync(directoryPath); } catch { /* Keep other owners. */ }
  };
  if (exists(ctx.fence)) { release(); fail('UNINSTALL_IN_PROGRESS', 'Uninstall fence появился до активации runtime'); }
  leases.add(release);
  return release;
}

/** Acquire one cooperative fence, verify durable process evidence, then expose a synchronous recheck. */
export async function acquireUninstallGuard({ root }) {
  const ctx = paths(root);
  const owner = { version: 1, pid: process.pid, identity: randomUUID() };
  if (exists(ctx.fence)) {
    const previous = read(path.join(ctx.fence, 'owner.json'));
    if (processState(previous.pid) !== 'stopped') fail('UNINSTALL_BUSY', 'Uninstall уже выполняется или владелец неизвестен');
    // Recover only an unchanged dead owner's cooperative lock, never unknown/live ownership.
    removeOwn(path.join(ctx.fence, 'owner.json'), previous);
    try { rmdirSync(ctx.fence); } catch { fail('UNINSTALL_BUSY', 'Не удалось подтвердить восстановление lifecycle fence'); }
  }
  mkdirSync(ctx.fence, { mode: 0o700 });
  writeNew(path.join(ctx.fence, 'owner.json'), owner);
  let released = false;
  let stoppedOwners = [];
  const release = () => {
    if (released) return; released = true;
    for (const { name, ...receipt } of stoppedOwners) {
      if (processState(receipt.pid) === 'stopped') removeOwn(path.join(ctx.leases, name), receipt);
    }
    removeOwn(path.join(ctx.fence, 'owner.json'), owner);
    try { rmdirSync(ctx.fence); } catch { /* Preserve a replacement. */ }
    try { rmdirSync(ctx.leases); } catch { /* Preserve receipts. */ }
  };
  try {
    const owners = records(ctx);
    if (owners.some((record) => processState(record.pid) !== 'stopped')) fail('UNINSTALL_PROCESS_ACTIVE', 'Сначала закройте viewer и завершите активные операции Flowcairn');
    const store = new GraphStore(ctx.root);
    const ids = store.listRunIds();
    const states = ids.map((id) => store.readRun(id));
    const unknownProcesses = [];
    for (const raw of states) {
      if (raw.kind === 'intake-operation') {
        if (raw.status === 'running') fail('UNINSTALL_PROCESS_UNKNOWN', 'Незавершенная регистрация требует восстановления');
        continue;
      }
      const state = RunStateSchema.parse(raw);
      if (state.activeOperation || state.setupPending || Object.values(state.nodes).some((node) => node.status === 'running'))
        fail('UNINSTALL_PROCESS_UNKNOWN', 'Run требует завершения или recovery до uninstall');
      for (const node of Object.values(state.nodes)) {
        if (!node.process) continue;
        const receipt = node.receipts.map((id) => ReceiptSchema.parse(store.readObject('receipts', id))).find((item) =>
          ['finished', 'recovery'].includes(item.phase) && item.termination?.stopped === true && item.termination.uncertain === false &&
          item.termination.ticketHash === hashObject(node.process) &&
          (field(node.process, 'kind') !== 'docker-check' || field(item.termination.execution, 'removed') === true));
        if (!receipt) unknownProcesses.push(node.process);
      }
    }
    for (const metadata of unknownProcesses) {
      const proof = field(metadata, 'kind') === 'docker-check'
        ? await (await import('./docker-checks.mjs')).inspectCheckProcess({ root: ctx.root, process: metadata })
        : (await import('./runner.mjs')).inspectProcess({ root: ctx.root, process: metadata });
      if (!proof?.stopped || field(proof, 'uncertain') || (field(metadata, 'kind') === 'docker-check' && field(field(proof, 'execution'), 'removed') !== true))
        fail('UNINSTALL_PROCESS_UNKNOWN', 'Нет доказательства остановки descendant process');
    }
    const graphBindings = Object.freeze(states.flatMap((raw) => {
      if (raw.kind === 'intake-operation') return [];
      const state = RunStateSchema.parse(raw);
      const binding = state.binding;
      if (!binding || binding.runId !== state.runId || !binding.owner) return [];
      return [Object.freeze({
        runId: binding.runId,
        taskId: binding.taskId,
        attemptId: binding.attemptId,
        leaseId: binding.leaseId,
        sourceHash: binding.sourceHash,
        worktree: binding.worktree,
        owner: binding.owner,
      })];
    }));
    const inventory = () => {
      const worktrees = new Set(states.flatMap((raw) => [raw.binding, raw.pendingBinding].filter(Boolean).map((binding) => binding.worktree)));
    const worktreeRoot = path.join(ctx.control, 'worktrees');
    if (exists(worktreeRoot)) {
      directory(ctx.control, 'worktrees');
      const children = readdirSync(worktreeRoot);
      if (children.length > 128) fail('LIFECYCLE_LIMIT', 'Слишком много worktrees');
      for (const name of children) {
        const file = path.join(worktreeRoot, name), stat = lstatSync(file);
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNINSTALL_WORKTREE_UNKNOWN', 'Worktree inventory содержит неизвестный объект');
        worktrees.add(realpathSync(file));
      }
    }
    const worktreePaths = [...worktrees].sort();
    if (worktreePaths.length > 128 || worktreePaths.some((file) => !file.startsWith(`${worktreeRoot}${path.sep}`)))
      fail('UNINSTALL_WORKTREE_UNKNOWN', 'Worktree выходит за owned runtime directory');
      return worktreePaths;
    };
    const worktreePaths = inventory();
    for (const { name, ...receipt } of owners) {
      if (processState(receipt.pid) !== 'stopped') fail('UNINSTALL_PROCESS_ACTIVE', 'Lifecycle owner изменился');
      removeOwn(path.join(ctx.leases, name), receipt);
    }
    const baselineOwners = records(ctx);
    if (baselineOwners.length) fail('UNINSTALL_PROCESS_UNKNOWN', 'Не удалось подтвердить cleanup dead receipts');
    try { rmdirSync(ctx.leases); } catch { /* Other owners are caught by the synchronous probe. */ }
    const expected = hashObject({ owners: baselineOwners, states, worktreePaths });
    const processProbe = () => {
      if (released || !existsSync(ctx.fence) || hashObject(read(path.join(ctx.fence, 'owner.json'))) !== hashObject(owner))
        return { state: 'unknown', verified: false, evidence: 'Lifecycle fence потерян' };
      const currentOwners = records(ctx);
      if (currentOwners.some((record) => processState(record.pid) !== 'stopped'))
        return { state: 'active', verified: false, evidence: 'Runtime owner активен' };
      const currentStates = store.listRunIds().map((id) => store.readRun(id));
      const currentPaths = inventory();
      if (hashObject({ owners: currentOwners, states: currentStates, worktreePaths: currentPaths }) !== expected)
        return { state: 'unknown', verified: false, evidence: 'Lifecycle state изменился' };
      return { state: 'stopped', verified: true, evidence: `Lifecycle fence; stopped owner PIDs and immutable process receipts; fingerprint=${expected}` };
    };
    stoppedOwners = owners;
    return { processProbe, graphBindings, worktreePaths, transientPaths: [LIFECYCLE_FENCE], release };
  } catch (error) { release(); throw error; }
}
