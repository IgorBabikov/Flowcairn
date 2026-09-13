#!/usr/bin/env node
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GraphError, hashObject, sha256 } from '../scripts/ai-graph/lib/io.mjs';
import {
  ProjectProfileSchema,
  loadProjectProfile,
  RUNTIME_ROOT,
} from '../scripts/ai-graph/lib/project.mjs';
import { TaskInputSchema } from '../scripts/ai-graph/lib/schemas.mjs';
import { WorkflowService, sanitizeText } from '../scripts/ai-graph/lib/service.mjs';
import { runCli } from '../scripts/ai-graph/cli.mjs';
import { probeRunner } from '../scripts/ai-graph/lib/runner.mjs';
import { probeChecks, prepareCheckImage } from '../scripts/ai-graph/lib/docker-checks.mjs';
import { startViewer } from '../tools/ai-graph-viewer/server.mjs';
import { discoverWorkspaceManifests } from './workspaces.mjs';

const OWNER_FILE = '.ai-orchestrator/flowcairn-install.json';
const PROFILE = '.flowcairn.json';
const IGNORE_BLOCK = '# Flowcairn: локальное состояние, не исходники\n.ai-orchestrator/\n';
const CHECKS = ['typecheck', 'lint', 'tests', 'build'];
const VALUE_OPTIONS = new Set([
  'root',
  'provider',
  'model',
  'review-model',
  'branch',
  'port',
  'package-manager',
  'manifests',
  'context',
  'checks',
  'outputs',
  'codex-path',
  'file',
  'id',
  'goal',
  'instructions',
  'scope',
  'accept',
  'run',
  'spec',
  'node',
  'plan-hash',
  'operation',
  'permissions',
  'draft',
  'reason',
  'hash',
  'after',
  'revision',
]);
const BOOLEAN_OPTIONS = new Set(['json', 'dry-run', 'help']);

function fail(code, message) {
  throw new GraphError(code, message);
}
function git(root, args) {
  return execFileSync('/usr/bin/git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function csv(value) {
  return typeof value === 'string'
    ? value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
    : [];
}
function requireNode() {
  if (Number(process.versions.node.split('.')[0]) !== 22)
    fail('NODE_VERSION', 'Нужен Node.js 22. Переключите версию в текущем терминале.');
  if (!['darwin', 'linux'].includes(process.platform))
    fail(
      'PLATFORM',
      'Поддерживаются macOS и Linux. На Windows используйте Linux в WSL2; native Windows не поддерживается.',
    );
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

export function parseOptions(tokens) {
  const options = {};
  for (let i = 0; i < tokens.length; i++) {
    const key = tokens[i].startsWith('--') ? tokens[i].slice(2) : '';
    if (!key || Object.hasOwn(options, key))
      fail('ARGUMENT', 'Неизвестный или повторный аргумент. Используйте flowcairn --help.');
    if (BOOLEAN_OPTIONS.has(key)) options[key] = true;
    else if (
      VALUE_OPTIONS.has(key) &&
      tokens[i + 1] !== undefined &&
      !tokens[i + 1].startsWith('--')
    )
      options[key] = tokens[++i];
    else fail('ARGUMENT', `Для --${key || '?'} требуется допустимое значение.`);
  }
  return options;
}

function discoverManifests(root, pkg, manager, explicit) {
  if (explicit) return csv(explicit);
  const files = ['package.json'];
  const lock = manager === 'npm' ? 'package-lock.json' : 'pnpm-lock.yaml';
  if (existsSync(path.join(root, lock))) files.push(lock);
  if (manager === 'pnpm' && existsSync(path.join(root, 'pnpm-workspace.yaml')))
    files.push('pnpm-workspace.yaml');
  files.push(...discoverWorkspaceManifests(root, pkg, manager));
  return [...new Set(files)];
}

/** Explicit, repeatable setup. It never replaces AGENTS, hooks or an existing profile. */
export function initializeProject(input, options = {}) {
  const root = projectRoot(input);
  const existingProfile = existsNoFollow(path.join(root, PROFILE))
    ? loadProjectProfile(root)
    : null;
  if (existingProfile && existsNoFollow(path.join(root, OWNER_FILE))) {
    readProjectFile(root, OWNER_FILE, 1024 * 1024);
    owner(root);
    return {
      created: false,
      root,
      profile: existingProfile,
      message: 'Проект уже настроен; файлы не изменены.',
    };
  }
  if (!existingProfile && !options.model)
    fail('MODEL_REQUIRED', 'Укажите --model с точным ID модели, доступной вашему аккаунту.');
  const stateDirectory = path.join(root, '.ai-orchestrator');
  if (existsNoFollow(stateDirectory))
    fail(
      'INSTALL_CONFLICT',
      'В проекте уже есть .ai-orchestrator. Сначала проверьте существующую систему; ее состояние не перезаписывается.',
    );
  const pkg = JSON.parse(readRegular(path.join(root, 'package.json'), 256 * 1024).toString('utf8'));
  const manager =
    options['package-manager'] ??
    (existsNoFollow(path.join(root, 'pnpm-lock.yaml')) ||
    existsNoFollow(path.join(root, 'pnpm-workspace.yaml')) ||
    pkg.packageManager?.startsWith('pnpm@')
      ? 'pnpm'
      : 'npm');
  const integrationBranch =
    existingProfile?.integrationBranch ??
    options.branch ??
    git(root, ['symbolic-ref', '--short', 'HEAD']);
  const checks =
    options.checks === undefined
      ? CHECKS.filter(
          (check) => typeof pkg.scripts?.[check === 'tests' ? 'test' : check] === 'string',
        )
      : csv(options.checks);
  const profile =
    existingProfile ??
    ProjectProfileSchema.parse({
      version: 1,
      integrationBranch,
      packageManager: manager,
      contextPaths: csv(options.context),
      checks,
      outputPaths: csv(options.outputs),
      manifests: discoverManifests(root, pkg, manager, options.manifests),
      ai: {
        provider: options.provider ?? 'codex',
        model: options.model,
        ...(options['review-model'] ? { reviewModel: options['review-model'] } : {}),
        ...(options['codex-path'] ? { codexPath: path.resolve(options['codex-path']) } : {}),
      },
    });
  for (const file of profile.manifests) readProjectFile(root, file, 16 * 1024 * 1024);
  const ignoreFile = path.join(root, '.gitignore');
  const oldIgnore = existsNoFollow(ignoreFile) ? readRegular(ignoreFile).toString('utf8') : null;
  // A tracked profile survives clone; its local owner state intentionally does not.
  const alreadyIgnored =
    oldIgnore !== null &&
    spawnSync(
      '/usr/bin/git',
      ['-C', root, 'check-ignore', '-q', '--', '.ai-orchestrator/flowcairn-install.json'],
      { stdio: 'ignore' },
    ).status === 0;
  const ignore = alreadyIgnored
    ? oldIgnore
    : (oldIgnore ?? '') + (oldIgnore && !oldIgnore.endsWith('\n') ? '\n' : '') + IGNORE_BLOCK;
  const profileText = existingProfile
    ? readRegular(path.join(root, PROFILE)).toString('utf8')
    : JSON.stringify(profile, null, 2) + '\n';
  if (options['dry-run'])
    return {
      created: false,
      dryRun: true,
      root,
      profile,
      changes: [
        ...(existingProfile ? [] : [PROFILE]),
        ...(ignore === oldIgnore ? [] : ['.gitignore']),
        OWNER_FILE,
        '.ai-orchestrator/task.example.json',
      ],
    };
  const tmp = path.join(root, `.flowcairn-ignore-${randomUUID()}.tmp`);
  const ownedFiles = [];
  let createdDirectory = false,
    ignoreWritten = false;
  const createOwned = (file, text, mode = 0o600) => {
    writeNew(file, text, mode);
    const stat = lstatSync(file);
    ownedFiles.push({ file, text, dev: stat.dev, ino: stat.ino });
  };
  try {
    mkdirSync(stateDirectory, { mode: 0o700 });
    createdDirectory = true;
    if (!existingProfile) createOwned(path.join(root, PROFILE), profileText, 0o644);
    createOwned(
      path.join(root, OWNER_FILE),
      JSON.stringify(
        {
          version: 1,
          tool: 'flowcairn',
          owner: `flowcairn-${randomUUID()}`,
          profileHash: sha256(profileText),
          ignoreBefore: oldIgnore,
          ignoreAfterHash: sha256(ignore),
        },
        null,
        2,
      ) + '\n',
    );
    createOwned(
      path.join(stateDirectory, 'task.example.json'),
      JSON.stringify(
        {
          id: 'ORCH-001',
          goal: 'Один проверяемый результат',
          instructions: 'Опишите нужное поведение и ограничения',
          scope: ['src'],
          acceptance: ['Как проверить результат'],
          checks: [],
        },
        null,
        2,
      ) + '\n',
    );
    if (ignore !== oldIgnore) {
      const ignoreMode = oldIgnore === null ? 0o644 : lstatSync(ignoreFile).mode & 0o777;
      createOwned(tmp, ignore, ignoreMode);
      const current = existsNoFollow(ignoreFile) ? readRegular(ignoreFile).toString('utf8') : null;
      if (current !== oldIgnore)
        fail(
          'INSTALL_CONFLICT',
          '.gitignore изменился во время установки. Он сохранен; повторите проверку.',
        );
      renameSync(tmp, ignoreFile);
      ignoreWritten = true;
    }
  } catch (error) {
    // Do not remove a concurrent replacement or a file the owner has already edited.
    if (!ignoreWritten)
      for (const item of ownedFiles.reverse()) {
        try {
          const stat = lstatSync(item.file);
          if (
            stat.isFile() &&
            stat.dev === item.dev &&
            stat.ino === item.ino &&
            readRegular(item.file).toString('utf8') === item.text
          )
            unlinkSync(item.file);
        } catch {
          /* A concurrent edit remains untouched. */
        }
      }
    if (createdDirectory)
      try {
        rmdirSync(stateDirectory);
      } catch {
        /* Keep nonempty state. */
      }
    throw error;
  }
  return {
    created: true,
    adopted: Boolean(existingProfile),
    root,
    profile,
    message:
      existingProfile && ignore === oldIgnore
        ? 'Локальное состояние создано по существующему профилю. Исходники не изменены; можно создать задачу.'
        : 'Проверьте git diff и закоммитьте .flowcairn.json и .gitignore перед созданием задачи. AGENTS и hooks не изменены.',
  };
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
    value = JSON.parse(result.stdout);
  } catch {
    fail('ORCHESTRATOR_ERROR', 'Orchestrator не вернул корректный ответ.');
  }
  if (result.status !== 0 || value.ok !== true)
    fail(
      value.error?.code ?? 'ORCHESTRATOR_ERROR',
      sanitizeText(value.error?.message ?? 'Операция Orchestrator не выполнена.'),
    );
  return value;
}

export async function createTask(input, taskInput, options = {}) {
  const root = projectRoot(input),
    profile = loadProjectProfile(root),
    ownerId = owner(root);
  const task = TaskInputSchema.parse(taskInput);
  if (
    task.checks.some(
      (check) => !CHECKS.includes(check) || !profile.checks.some((allowed) => allowed === check),
    )
  )
    fail(
      'CHECK_UNSUPPORTED',
      'Доступны только tests, typecheck, lint и build, включенные в профиль проекта.',
    );
  if (git(root, ['status', '--porcelain', '--untracked-files=all']))
    fail(
      'DIRTY_ROOT',
      'В проекте есть незакоммиченные файлы. Сохраните изменения в Git; Flowcairn не коммитит и не прячет их автоматически. TaskSpec удобно хранить в .ai-orchestrator/.',
    );
  const stateFile = path.join(root, '.ai-orchestrator/state.json');
  if (!existsSync(stateFile))
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
    ]);
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
  const service = await WorkflowService.open({ root });
  return service.create(task, {
    runId: options.run ?? `run-${randomUUID()}`,
    ...(options.operation ? { operationId: options.operation } : {}),
  });
}

export async function doctorProject(input) {
  const root = projectRoot(input);
  let profile;
  try {
    profile = loadProjectProfile(root);
  } catch (error) {
    return {
      ok: false,
      root,
      node: process.versions.node,
      issues: [
        { code: error.code, message: 'Сначала выполните flowcairn init --provider … --model …' },
      ],
    };
  }
  const ai = await probeRunner({ root });
  const checks = probeChecks({ root });
  return {
    ok: ai.ai.available && checks.available,
    root,
    node: process.versions.node,
    branch: git(root, ['branch', '--show-current']),
    configuredBranch: profile.integrationBranch,
    packageManager: profile.packageManager,
    configuredChecks: profile.checks,
    ai: ai.ai,
    checks,
    note: 'Это проверка окружения, не AI-вызов и не доказательство качества модели.',
  };
}

export async function handoff(input, runId) {
  const root = projectRoot(input),
    service = await WorkflowService.open({ root });
  const snapshot = service.snapshot(runId);
  if (snapshot.finalDisposition !== 'accepted' || snapshot.status !== 'passed')
    fail('ACCEPT_REQUIRED', 'Сначала проверьте и примите результат Graph.');
  const state = service.store.readRun(runId);
  return {
    runId,
    status: snapshot.status,
    worktree: state.binding?.worktree,
    branch: state.binding?.worktree
      ? git(state.binding.worktree, ['branch', '--show-current'])
      : null,
    changedFiles: [...new Set(snapshot.nodes.flatMap((node) => node.changedFiles))],
    message:
      'Передайте результат вашему coding agent: проверьте exact diff и правила проекта, сделайте commit, независимое review кандидата и интеграцию через Orchestrator. Push/deploy требуют отдельного решения. Эта команда ничего не коммитит.',
  };
}

const HELP = `Flowcairn — контролируемый AI Workflow + ReactFlow\n\n  init --provider codex|openai --model MODEL [--root PROJECT] [--dry-run]\n  doctor [--root PROJECT]\n  checks prepare [--root PROJECT]\n  task --file TASK.json [--run ID] [--root PROJECT]\n  task --id ORCH-001 --goal TEXT --scope src --accept TEXT\n  ui [--root PROJECT] [--port 4329]\n  status|plan|events --run ID\n  approve --run ID --plan-hash HASH --permissions ai.read,workspace.source.write,workspace.output.write\n  run|retry|recover|replan|stop|accept|reject --run ID --plan-hash HASH\n  receipt|artifact --run ID --hash HASH\n  handoff --run ID\n  orchestrator COMMAND ...   расширенное управление очередью и Git-интеграцией\n\nЗапуск AI требует approval конкретного плана. Task/create/ui не запускают AI.\nДокументация: https://github.com/IgorBabikov/flowcairn\n`;

export async function main(tokens = process.argv.slice(2)) {
  const command = tokens.shift() ?? 'help';
  if (['help', '--help', '-h'].includes(command)) {
    process.stdout.write(HELP);
    return;
  }
  if (['--version', '-v'].includes(command)) {
    process.stdout.write(
      JSON.parse(readRegular(path.join(RUNTIME_ROOT, 'package.json')).toString('utf8')).version +
        '\n',
    );
    return;
  }
  requireNode();
  if (command === 'orchestrator') {
    const result = spawnSync(
      process.execPath,
      [path.join(RUNTIME_ROOT, 'scripts/ai-orchestrator.mjs'), ...tokens],
      { stdio: 'inherit' },
    );
    process.exitCode = result.status ?? 2;
    return;
  }
  if (command === 'checks' && tokens.shift() !== 'prepare')
    fail('ARGUMENT', 'Используйте flowcairn checks prepare.');
  const options = parseOptions(tokens),
    root = options.root ?? process.cwd();
  let result;
  if (command === 'init') result = initializeProject(root, options);
  else if (command === 'doctor') result = await doctorProject(root);
  else if (command === 'task') {
    const input = options.file
      ? JSON.parse(readRegular(path.resolve(options.file), 256 * 1024).toString('utf8'))
      : {
          id: options.id,
          goal: options.goal,
          instructions: options.instructions ?? options.goal,
          scope: csv(options.scope),
          acceptance: options.accept ? [options.accept] : [],
          checks: csv(options.checks),
          contextPaths: csv(options.context),
        };
    result = await createTask(root, input, options);
  } else if (command === 'checks') result = await prepareCheckImage({ root: projectRoot(root) });
  else if (command === 'handoff') result = await handoff(root, options.run);
  else if (command === 'ui') {
    const port = Number(options.port ?? 4329);
    if (!Number.isInteger(port) || port < 1024 || port > 65535)
      fail('PORT', 'Порт должен быть от 1024 до 65535.');
    const service = await WorkflowService.open({ root: projectRoot(root) }),
      token = randomBytes(32).toString('base64url');
    const server = startViewer({
      service,
      token,
      port,
      dist: path.join(RUNTIME_ROOT, 'tools/ai-graph-viewer/dist'),
    });
    server.on('listening', () =>
      process.stdout.write(
        `Flowcairn: http://127.0.0.1:${port}/#session=${token}\nНе публикуйте временный URL с токеном. Ctrl+C завершает сервер.\n`,
      ),
    );
    server.on('error', (error) => {
      process.stderr.write(
        `Не удалось открыть Flowcairn: ${'code' in error ? String(error.code) : 'ERROR'}\n`,
      );
      process.exitCode = 2;
    });
    const stop = () => {
      server.close();
      server.closeAllConnections();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return;
  } else {
    if (
      ![
        'status',
        'plan',
        'events',
        'approve',
        'accept',
        'reject',
        'run',
        'retry',
        'rerun-check',
        'recover',
        'stop',
        'replan',
        'receipt',
        'artifact',
      ].includes(command)
    )
      fail('COMMAND', 'Неизвестная команда. Используйте flowcairn --help.');
    result = await runCli(
      command,
      options,
      await WorkflowService.open({ root: projectRoot(root) }),
    );
  }
  process.stdout.write(JSON.stringify({ ok: true, command, result }, null, 2) + '\n');
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      JSON.stringify(
        {
          ok: false,
          error: { code: error.code ?? 'INVALID_INPUT', message: sanitizeText(error.message) },
        },
        null,
        2,
      ) + '\n',
    );
    process.exitCode = 2;
  }
}
