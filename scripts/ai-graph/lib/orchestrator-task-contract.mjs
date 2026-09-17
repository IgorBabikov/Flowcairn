import path from 'node:path';

export const STATE_DIR = '.ai-orchestrator';
export const TASK_ID = /^[A-Z][A-Z0-9-]{2,40}$/;
const RESOURCE_ID = /^[a-z0-9][a-z0-9:-]{0,80}$/;
const now = () => new Date().toISOString();

export class CliError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.code = code;
    this.details = details;
  }
}


export function safeRelativePath(raw, label) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new CliError('INVALID_SPEC', `${label} must be a non-empty repository-relative path`);
  }
  const normalized = path.posix.normalize(raw.trim().replaceAll('\\', '/')).replace(/\/$/, '');
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.startsWith('/') ||
    normalized === '.git' ||
    normalized.startsWith('.git/') ||
    normalized === STATE_DIR ||
    normalized.startsWith(`${STATE_DIR}/`)
  ) {
    throw new CliError(
      'INVALID_SPEC',
      `${label} escapes or targets orchestrator/Git state: ${raw}`,
    );
  }
  return normalized;
}

export function stringArray(value, label, { nonEmpty = false } = {}) {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    throw new CliError(
      'INVALID_SPEC',
      `${label} must be ${nonEmpty ? 'a non-empty ' : 'an '}array`,
    );
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new CliError('INVALID_SPEC', `${label}[${index}] must be a non-empty string`);
    }
    return entry.trim();
  });
}

/** Legacy task data selects only these inert host checks, never a program or shell. */
export function registeredHostCheck(command, scope) {
  if (Array.isArray(command) && command.length === 3) {
    if (command[0] === '/usr/bin/git' && command[1] === 'diff' && command[2] === '--check')
      return ['/usr/bin/git', 'diff', '--check'];
    if (
      ['/bin/test', '/usr/bin/test'].includes(command[0]) &&
      command[1] === '-f' &&
      typeof command[2] === 'string' &&
      !/[\0\r\n]/.test(command[2])
    ) {
      const file = safeRelativePath(command[2], 'check path');
      if (scope.some((prefix) => file === prefix || file.startsWith(`${prefix}/`)))
        return ['/bin/test', '-f', file];
    }
  }
  throw new CliError(
    'CHECK_NOT_ALLOWED',
    'Разрешены только git diff --check и проверка существования файла внутри scope. Произвольные команды из JSON не исполняются. Тесты и сборку запускайте через зарегистрированные проверки Graph.',
  );
}

export function validateTask(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CliError('INVALID_SPEC', 'Each task spec must be an object');
  }
  if (!TASK_ID.test(raw.id ?? '')) {
    throw new CliError('INVALID_SPEC', 'Task id must use uppercase letters, digits and dashes');
  }
  const text = {};
  for (const key of ['title', 'outcome', 'why']) {
    if (typeof raw[key] !== 'string' || raw[key].trim() === '') {
      throw new CliError('INVALID_SPEC', `${key} must be a non-empty string`);
    }
    text[key] = raw[key].trim();
  }
  const sourceDocs = stringArray(raw.sourceDocs, 'sourceDocs').map((entry, index) =>
    safeRelativePath(entry, `sourceDocs[${index}]`),
  );
  const scope = [
    ...new Set(
      stringArray(raw.scope, 'scope', { nonEmpty: true }).map((entry, index) =>
        safeRelativePath(entry, `scope[${index}]`),
      ),
    ),
  ];
  const resources = [...new Set(stringArray(raw.resources ?? [], 'resources'))];
  for (const resource of resources) {
    if (!RESOURCE_ID.test(resource)) {
      throw new CliError('INVALID_SPEC', `Invalid resource id: ${resource}`);
    }
  }
  const dependsOn = [...new Set(stringArray(raw.dependsOn ?? [], 'dependsOn'))];
  const acceptance = stringArray(raw.acceptance, 'acceptance', { nonEmpty: true });
  if (!Array.isArray(raw.checks) || raw.checks.length === 0) {
    throw new CliError('INVALID_SPEC', 'checks must contain at least one argv array');
  }
  const checks = raw.checks.map((command) => registeredHostCheck(command, scope));
  if (typeof raw.model !== 'string' || raw.model.trim() === '') {
    throw new CliError('INVALID_SPEC', 'model must be a non-empty string');
  }
  if (typeof raw.effort !== 'string' || raw.effort.trim() === '') {
    throw new CliError('INVALID_SPEC', 'effort must be a non-empty string');
  }
  const checkTimeoutMs = raw.checkTimeoutMs === undefined ? 120_000 : Number(raw.checkTimeoutMs);
  if (!Number.isSafeInteger(checkTimeoutMs) || checkTimeoutMs < 1 || checkTimeoutMs > 30 * 60_000) {
    throw new CliError('INVALID_SPEC', 'checkTimeoutMs must be between 1 and 1800000');
  }
  const priority = raw.priority === undefined ? 100 : Number(raw.priority);
  if (!Number.isSafeInteger(priority) || priority < 1 || priority > 999) {
    throw new CliError('INVALID_SPEC', 'priority must be an integer from 1 (highest) to 999');
  }
  return {
    id: raw.id,
    ...text,
    sourceDocs,
    scope,
    resources,
    dependsOn,
    acceptance,
    checks,
    checkTimeoutMs,
    priority,
    model: raw.model.trim(),
    effort: raw.effort.trim(),
    status: 'pending',
    attempts: [],
    candidates: [],
    merge: null,
    createdAt: now(),
  };
}

export function assertDependencyGraph(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!byId.has(dependency)) {
        throw new CliError(
          'MISSING_DEPENDENCY',
          `${task.id} depends on missing task ${dependency}`,
        );
      }
      if (dependency === task.id) {
        throw new CliError('CYCLIC_DEPENDENCY', `${task.id} depends on itself`);
      }
    }
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) {
      throw new CliError('CYCLIC_DEPENDENCY', `Dependency cycle includes ${id}`);
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const task of tasks) visit(task.id);
}
