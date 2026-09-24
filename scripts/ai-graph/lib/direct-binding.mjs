import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isPrivateMode, noFollowReadFlags, sameHostPath } from './host-filesystem.mjs';
import { GraphError, canonicalJson } from './io.mjs';
import { fingerprintDirectWorkspace } from './direct-workspace.mjs';
import { GraphStore } from './store.mjs';

const fail = (code, reason) => { throw new GraphError(code, reason); };
const bindingPath = (root) => path.join(root, '.ai-orchestrator', 'graph', 'direct-binding.json');

function readBinding(root) {
  const file = bindingPath(root);
  if (!existsSync(file)) return null;
  let fd;
  try {
    const before = lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail('DIRECT_BINDING', 'Запись владельца проекта повреждена');
    fd = openSync(file, noFollowReadFlags());
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev || stat.nlink !== 1 || !isPrivateMode(stat) || stat.size > 4096)
      fail('DIRECT_BINDING', 'Запись владельца проекта повреждена');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } catch (error) {
    if (error instanceof GraphError) throw error;
    fail('DIRECT_BINDING', 'Запись владельца проекта недоступна');
  } finally { if (fd !== undefined) closeSync(fd); }
}

function writeBinding(root, binding) {
  const file = bindingPath(root), temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${canonicalJson(binding)}\n`, { flag: 'wx', mode: 0o600 });
  try {
    const existing = readBinding(root);
    if (existing && existing.runId !== binding.previousRunId && existing.runId !== binding.runId)
      fail('DIRECT_BUSY', 'Другой запуск владеет текущим проектом');
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) {
      const stat = lstatSync(temporary);
      if (stat.isFile() && stat.nlink === 1) { try { unlinkSync(temporary); } catch { /* Preserve unsafe replacement. */ } }
    }
  }
}

/** Rebind only after a stopped run; every write still checks current source bytes. */
export function replaceDirectBinding({ root, binding, runId, newRunId, sourceHash, previousRunStopped }) {
  if (previousRunStopped !== true || binding.runId !== runId) fail('DIRECT_BINDING', 'Предыдущая работа не остановлена');
  verifyDirectBinding(root, binding);
  const current = fingerprintDirectWorkspace(root, { outputPaths: binding.outputPaths ?? [] });
  if (current.hash !== sourceHash) fail('DIRECT_DRIFT', 'Текущий проект изменился во время подготовки плана');
  const next = { ...binding, runId: newRunId, sourceHash, previousRunId: runId };
  writeBinding(root, next);
  return next;
}

export function verifyDirectBinding(root, binding) {
  if (!binding || !sameHostPath(binding.worktree, realpathSync(root)) || binding.mode !== 'direct')
    fail('DIRECT_BINDING', 'Работа относится к другому проекту');
  const live = readBinding(root);
  if (!live || canonicalJson(live) !== canonicalJson(binding)) fail('DIRECT_BINDING', 'Владелец текущего проекта изменился');
  return binding;
}

export function allocateDirectBinding({ root, task, runId, sourceHash, owner, existingBinding, outputPaths }) {
  if (existingBinding) return verifyDirectBinding(root, existingBinding);
  const current = fingerprintDirectWorkspace(root, { outputPaths });
  if (current.hash !== sourceHash) fail('DIRECT_DRIFT', 'Проект изменился после сохранения исходной задачи');
  const prior = readBinding(root);
  if (prior?.runId === runId) {
    if (prior.taskId !== task.id || prior.sourceHash !== sourceHash || prior.owner !== owner ||
        !sameHostPath(prior.worktree, realpathSync(root)))
      fail('DIRECT_BINDING', 'Владелец текущего запуска изменился');
    return prior;
  }
  if (prior) {
    const store = new GraphStore(root), state = store.readRun(prior.runId);
    const plan = store.readObject('plans', state.planHash);
    if (state.activeOperation || !['passed', 'failed', 'cancelled', 'stale'].includes(state.status) ||
        (state.status === 'passed' && plan.stage === 'planning') ||
        Object.values(state.nodes).some((node) => node.status === 'uncertain'))
      fail('DIRECT_BUSY', 'Другая задача еще использует текущий проект');
  }
  const binding = { mode: 'direct', worktree: realpathSync(root), taskId: task.id, attemptId: 1,
    leaseId: randomUUID(), sourceHash, runId, owner, outputPaths,
    ...(prior ? { previousRunId: prior.runId } : {}) };
  writeBinding(root, binding);
  return binding;
}

export function withDirectBindingFence(root, binding, callback) {
  if (typeof callback !== 'function' || callback.constructor?.name === 'AsyncFunction')
    fail('DIRECT_FENCE', 'Запись требует синхронной проверенной операции');
  verifyDirectBinding(root, binding);
  const result = callback(binding);
  if (result?.then) fail('DIRECT_FENCE', 'Синхронная операция вернула Promise');
  return result;
}
