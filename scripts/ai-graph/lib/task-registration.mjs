// Shared domain registration for CLI and local UI. No browser or CLI dependencies.
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { GraphError, hashObject, sha256 } from './io.mjs';
import { loadProjectProfile, RUNTIME_ROOT } from './project.mjs';
import { Id, TaskInputSchema } from './schemas.mjs';
import { WorkflowService, sanitizeText } from './service.mjs';
const OWNER_FILE = '.ai-orchestrator/flowcairn-install.json';
const PROFILE = '.flowcairn.json';
const CHECKS = ['typecheck', 'lint', 'tests', 'build'];
function fail(code, message) {
  throw new GraphError(code, message);
}
function git(root, args) {
  return execFileSync('/usr/bin/git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function projectRoot(input = process.cwd()) {
  const root = realpathSync(path.resolve(input));
  let top;
  try {
    top = realpathSync(git(root, ['rev-parse', '--show-toplevel']));
  } catch {
    fail('GIT_REQUIRED', 'Укажите корень существующего Git-репозитория через --root.');
  }
  if (root !== top) fail('PROJECT_ROOT', `Команду нужно выполнить из корня Git: ${top}`);
  return root;
}
function readRegular(file, max = 1024 * 1024) {
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
function existsNoFollow(file) {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
function readProjectFile(root, relative, max) {
  for (
    let cursor = path.dirname(path.join(root, relative));
    cursor !== root;
    cursor = path.dirname(cursor)
  ) {
    if (!cursor.startsWith(root + path.sep) || lstatSync(cursor).isSymbolicLink())
      fail('UNSAFE_FILE', 'Путь manifest содержит ссылку или выходит за проект.');
  }
  return readRegular(path.join(root, relative), max);
}
function writeNew(file, content, mode = 0o600) {
  const fd = openSync(file, 'wx', mode);
  const original = fstatSync(fd);
  try {
    writeFileSync(fd, content);
  } catch (error) {
    try {
      const current = lstatSync(file);
      if (current.isFile() && current.dev === original.dev && current.ino === original.ino)
        unlinkSync(file);
    } catch {
      /* A replacement is not ours to remove. */
    }
    throw error;
  } finally {
    closeSync(fd);
  }
}


function owner(root) {
  let value;
  try {
    value = JSON.parse(readRegular(path.join(root, OWNER_FILE), 1024 * 1024).toString('utf8'));
  } catch {
    fail('INIT_REQUIRED', 'Сначала выполните flowcairn init.');
  }
  if (
    value.tool !== 'flowcairn' ||
    typeof value.owner !== 'string' ||
    !/^flowcairn-[a-f0-9-]+$/.test(value.owner)
  )
    fail('INSTALL_CONFLICT', 'Некорректная локальная установка.');
  return value.owner;
}
function orchestrator(root, command, args) {
  const result = spawnSync(
    process.execPath,
    [path.join(RUNTIME_ROOT, 'scripts/ai-orchestrator.mjs'), command, '--root', root, ...args],
    { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 120000 },
  );
  let value;
  try {
    value = JSON.parse(result.status === 0 ? result.stdout : result.stderr);
  } catch {
    fail('ORCHESTRATOR_ERROR', 'Orchestrator не вернул корректный ответ.');
  }
  if (result.status !== 0 || value.ok !== true)
    fail(
      value.error?.code ?? 'ORCHESTRATOR_ERROR',
      ['SOURCE_SNAPSHOT_MISMATCH', 'SOURCE_HEAD_MISMATCH'].includes(value.error?.code)
        ? 'Исходники изменились во время сохранения снимка. Граф не создан. Проверьте git status и повторите task.'
        : sanitizeText(value.error?.message ?? 'Операция Orchestrator не выполнена.'),
    );
  return value;
}

export async function createTask(input, taskInput, options = {}) {
  const root = projectRoot(input),
    profile = loadProjectProfile(root),
    ownerId = owner(root);
  let task = TaskInputSchema.parse(taskInput);
  if (options.run !== undefined) Id.parse(options.run);
  if (options.operation !== undefined) Id.parse(options.operation);
  if (
    task.checks.some(
      (check) => !CHECKS.includes(check) || !profile.checks.some((allowed) => allowed === check),
    )
  )
    fail(
      'CHECK_UNSUPPORTED',
      'Доступны только tests, typecheck, lint и build, включенные в профиль проекта.',
    );
  const stateFile = path.join(root, '.ai-orchestrator/state.json');
  const firstTask = !existsNoFollow(stateFile);
  if (options.contextHash && options.service?.project().contextHash !== options.contextHash)
    fail('STALE_CONTEXT', 'Контекст проекта изменился до регистрации');
  if (!firstTask && git(root, ['status', '--porcelain', '--untracked-files=all']))
    fail(
      'DIRTY_ROOT',
      'В проекте есть незакоммиченные файлы. Сохраните изменения в Git; Flowcairn не коммитит и не прячет их автоматически. TaskSpec удобно хранить в .ai-orchestrator/.',
    );
  const service = options.service ?? (await WorkflowService.open({ root }));
  try {
  let source;
  if (firstTask) {
    const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z'])
      .split('\0')
      .filter(Boolean);
    const installation = JSON.parse(
      readProjectFile(root, OWNER_FILE, 1024 * 1024).toString('utf8'),
    );
    const owned = [
      ...(sha256(readRegular(path.join(root, PROFILE))) === installation.profileHash
        ? [PROFILE]
        : []),
      ...(existsNoFollow(path.join(root, '.gitignore')) &&
      sha256(readRegular(path.join(root, '.gitignore'))) === installation.ignoreAfterHash
        ? ['.gitignore']
        : []),
    ];
    const changed = git(root, ['diff', 'HEAD', '--name-only', '-z']).split('\0').filter(Boolean);
    if (!options.snapshot && changed.some((file) => !owned.includes(file)))
      fail(
        'DIRTY_ROOT',
        'Есть незакоммиченные изменения проекта. Проверьте git diff и сохраните их в Git либо добавьте --snapshot: это явно включает текущее состояние отслеживаемых файлов в локальный снимок первого графа. AI не запускается.',
      );
    task = TaskInputSchema.parse({
      ...task,
      includeUntracked: [
        ...new Set([...task.includeUntracked, ...owned.filter((file) => untracked.includes(file))]),
      ],
    });
    if (!options.snapshot && untracked.some((file) => !task.includeUntracked.includes(file)))
      fail(
        'UNTRACKED_FILES',
        'Есть новые файлы вне явного списка снимка. Проверьте git status. Сохраните их в Git или перечислите через --include-untracked path1,path2 (includeUntracked в JSON). Не включайте секреты.',
      );
    source = await service.adapters.capture(task);
    if (options.contextHash && service.project().contextHash !== options.contextHash)
      fail('STALE_CONTEXT', 'Исходники изменились во время сохранения snapshot');
    orchestrator(root, 'init', [
      '--owner',
      ownerId,
      '--goal',
      'Локальные задачи Flowcairn с отдельной приемкой и Git-доставкой',
      '--mode',
      'autonomous',
      '--max-tasks',
      '100',
      '--max-retries',
      '2',
      '--max-workers',
      '1',
      '--bootstrap-source-bundle',
      source.bundlePath,
    ]);
  }
  const state = JSON.parse(readRegular(stateFile, 16 * 1024 * 1024).toString('utf8'));
  if (state.owner !== ownerId || state.runStatus !== 'active')
    fail(
      'ORCHESTRATOR_NOT_READY',
      'Существующий Orchestrator принадлежит другому владельцу или закрыт. Используйте предусмотренное продолжение новой цели; состояние не удаляется.',
    );
  const existing = state.tasks.find((item) => item.id === task.id);
  if (!existing) {
    const descriptor = {
      id: task.id,
      title: task.goal,
      outcome: task.goal,
      why: 'Явная постановка задачи оператором Flowcairn',
      sourceDocs: [PROFILE],
      scope: task.scope,
      resources: task.resources ?? [],
      dependsOn: [],
      acceptance: task.acceptance,
      checks: [['/usr/bin/git', 'diff', '--check']],
      model: profile.ai.model,
      effort: 'medium',
    };
    const file = path.join(root, '.ai-orchestrator', `task-${randomUUID()}.json`);
    writeNew(file, JSON.stringify(descriptor, null, 2) + '\n');
    orchestrator(root, 'add', ['--owner', ownerId, '--spec', file]);
  } else if (
    existing.outcome !== task.goal ||
    hashObject(existing.scope) !== hashObject(task.scope) ||
    hashObject(existing.acceptance) !== hashObject(task.acceptance)
  ) {
    fail(
      'TASK_CONFLICT',
      'ID задачи уже зарегистрирован с другим содержимым. Используйте новый ID.',
    );
  }
  return await service.create(task, {
    runId: options.run ?? `run-${randomUUID()}`,
    ...(options.operation ? { operationId: options.operation } : {}),
    ...(source ? { sourceOverride: source } : {}),
    ...(options.stage ? { stage: options.stage } : {}),
    ...(options.naturalIntakeHash ? { naturalIntakeHash: options.naturalIntakeHash } : {}),
    ...(options.actor ? { actor: options.actor } : {}),
  });
  } finally { if (!options.service) service.close(); }
}
