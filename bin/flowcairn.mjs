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
import { createInterface } from 'node:readline/promises';
import { GraphError, hashObject, sha256 } from '../scripts/ai-graph/lib/io.mjs';
import {
  ProjectProfileSchema,
  loadProjectProfile,
  RUNTIME_ROOT,
} from '../scripts/ai-graph/lib/project.mjs';
import { Id, TaskInputSchema } from '../scripts/ai-graph/lib/schemas.mjs';
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
  'include-untracked',
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
const BOOLEAN_OPTIONS = new Set(['json', 'dry-run', 'help', 'snapshot']);

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

function packageManager(root, pkg, explicit) {
  if (explicit !== undefined) {
    if (!['npm', 'pnpm'].includes(explicit))
      fail('PACKAGE_MANAGER', 'Поддерживаются npm и pnpm. Укажите --package-manager npm или pnpm.');
    return explicit;
  }
  const declared = typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : null;
  if (declared && !['npm', 'pnpm'].includes(declared))
    fail('PACKAGE_MANAGER', 'Менеджер из package.json не поддерживается: доступны npm и pnpm.');
  const npm = existsNoFollow(path.join(root, 'package-lock.json'));
  const pnpm =
    existsNoFollow(path.join(root, 'pnpm-lock.yaml')) ||
    existsNoFollow(path.join(root, 'pnpm-workspace.yaml'));
  if ((npm && pnpm) || (declared === 'npm' && pnpm) || (declared === 'pnpm' && npm))
    fail(
      'PACKAGE_MANAGER',
      'Найдены признаки npm и pnpm. Выберите --package-manager npm или pnpm.',
    );
  if (
    !declared &&
    !npm &&
    !pnpm &&
    ['yarn.lock', 'bun.lock', 'bun.lockb'].some((name) => existsNoFollow(path.join(root, name)))
  )
    fail('PACKAGE_MANAGER', 'Найден lock-файл неподдерживаемого менеджера. Доступны npm и pnpm.');
  return declared ?? (pnpm ? 'pnpm' : 'npm');
}

/** One explicit model choice; never probe accounts or read global configuration. */
export async function initializeCommand(input, options = {}, terminal = {}) {
  const root = projectRoot(input);
  if (existsNoFollow(path.join(root, PROFILE)) || options.model)
    return initializeProject(root, options);
  // Preflight errors take precedence over asking the user for a model.
  if (existsNoFollow(path.join(root, '.ai-orchestrator'))) return initializeProject(root, options);
  assertProviderPlatform(options);
  const stdin = terminal.input ?? process.stdin;
  const stdout = terminal.output ?? process.stderr;
  if (!stdin.isTTY || !stdout.isTTY || options.json || options['dry-run'])
    return initializeProject(root, options);
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    stdout.write(
      `Настройка Flowcairn. Провайдер: ${options.provider ?? 'codex'}. AI пока не запускается.\n`,
    );
    stdout.write(
      'Введите ID доступной вам модели, не API-ключ. Доступность здесь не проверяется.\n',
    );
    const model = (await prompt.question('ID модели: ')).trim();
    if (!model)
      fail(
        'MODEL_REQUIRED',
        'Модель не указана. Файлы не изменены. Повторите init --model MODEL_ID.',
      );
    return initializeProject(root, { ...options, model });
  } finally {
    prompt.close();
  }
}

function assertProviderPlatform(options) {
  if (process.platform !== 'darwin' && (options.provider ?? 'codex') === 'codex')
    fail(
      'PROVIDER_PLATFORM',
      'Исполнение через Codex сейчас поддерживается только на macOS. На Linux используйте npx flowcairn init --provider openai --model MODEL_ID.',
    );
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
  const stateDirectory = path.join(root, '.ai-orchestrator');
  if (existsNoFollow(stateDirectory))
    fail(
      'INSTALL_CONFLICT',
      'В проекте уже есть .ai-orchestrator. Сначала проверьте существующую систему; ее состояние не перезаписывается.',
    );
  if (!existingProfile) assertProviderPlatform(options);
  if (!existingProfile && !options.model)
    fail(
      'MODEL_REQUIRED',
      'Нужен точный ID доступной вам модели. В терминале выполните npx flowcairn init, в скрипте — npx flowcairn init --model MODEL_ID. Для OpenAI добавьте --provider openai. Файлы не изменены.',
    );
  if (
    !existingProfile &&
    ([options.model, options['review-model']].some((value) =>
      /^(?:sk-|sess-|Bearer\s)/i.test(value ?? ''),
    ) ||
      !ProjectProfileSchema.shape.ai.safeParse({
        provider: options.provider ?? 'codex',
        model: options.model,
      }).success)
  )
    fail('AI_CONFIG', 'Укажите --provider codex или openai и --model с ID модели (не API-ключом).');
  let pkg;
  try {
    pkg = JSON.parse(readRegular(path.join(root, 'package.json'), 256 * 1024).toString('utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    fail(
      'PACKAGE_JSON',
      'В корне Git нужен существующий корректный package.json. Укажите корень Node-проекта через --root.',
    );
  }
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg))
    fail('PACKAGE_JSON', 'В package.json нужен JSON-объект.');
  const manager =
    existingProfile?.packageManager ?? packageManager(root, pkg, options['package-manager']);
  const integrationBranch =
    existingProfile?.integrationBranch ?? options.branch ?? git(root, ['branch', '--show-current']);
  if (!integrationBranch)
    fail(
      'BRANCH_REQUIRED',
      'Git находится в detached HEAD. Переключитесь на рабочую ветку или укажите --branch.',
    );
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
          scope: ['README.md'],
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
        : 'Проект настроен. Можно создать первый граф без коммита; исходники будут сохранены в локальный проверяемый снимок. AI требует отдельного разрешения.',
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
  if (!firstTask && git(root, ['status', '--porcelain', '--untracked-files=all']))
    fail(
      'DIRTY_ROOT',
      'В проекте есть незакоммиченные файлы. Сохраните изменения в Git; Flowcairn не коммитит и не прячет их автоматически. TaskSpec удобно хранить в .ai-orchestrator/.',
    );
  const service = await WorkflowService.open({ root });
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
    if (untracked.some((file) => !task.includeUntracked.includes(file)))
      fail(
        'UNTRACKED_FILES',
        'Есть новые файлы вне явного списка снимка. Проверьте git status. Сохраните их в Git или перечислите через --include-untracked path1,path2 (includeUntracked в JSON). Не включайте секреты.',
      );
    source = await service.adapters.capture(task);
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
  return service.create(task, {
    runId: options.run ?? `run-${randomUUID()}`,
    ...(options.operation ? { operationId: options.operation } : {}),
    ...(source ? { sourceOverride: source } : {}),
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
        {
          code: error.code,
          message: 'Сначала выполните npx flowcairn init (в скрипте добавьте --model MODEL_ID).',
        },
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

const HELP = `Flowcairn — контролируемый AI Workflow + ReactFlow\n\n  init [--provider codex|openai] [--model MODEL] [--root PROJECT] [--dry-run] [--json]\n    В терминале init спросит ID модели. В скрипте --model обязателен.\n    Провайдер по умолчанию codex; для OpenAI используйте --provider openai.\n  doctor [--root PROJECT]\n  checks prepare [--root PROJECT]\n  task --file TASK.json [--run ID] [--root PROJECT]\n  task --id ORCH-001 --goal TEXT --scope src --accept TEXT\n    --snapshot явно включает изменения tracked-файлов в снимок первого графа.\n    --include-untracked path1,path2 явно включает новые файлы в этот снимок.\n  ui [--root PROJECT] [--port 4329]\n  status|plan|events --run ID\n  approve --run ID --plan-hash HASH --permissions ai.read,workspace.source.write,workspace.output.write\n  run|retry|recover|replan|stop|accept|reject --run ID --plan-hash HASH\n  receipt|artifact --run ID --hash HASH\n  handoff --run ID\n  orchestrator COMMAND ...   расширенное управление очередью и Git-интеграцией\n\nЗапуск AI требует approval конкретного плана. Init/task/ui не запускают AI.\nДокументация: https://github.com/IgorBabikov/flowcairn\n`;

function printInitialization(result) {
  const profile = result.profile;
  const summary = [
    result.dryRun ? 'Предварительная проверка. Файлы не изменены.' : result.message,
    `Ветка: ${profile.integrationBranch}. Менеджер: ${profile.packageManager}. Проверки: ${profile.checks.join(', ') || 'не найдены'}.`,
    `AI: ${profile.ai.provider}, модель ${profile.ai.model}. Доступность модели не проверялась.`,
  ];
  if (result.dryRun) summary.push(`Планируемые файлы: ${result.changes.join(', ')}.`);
  else
    summary.push(
      'Далее из корня проекта:',
      '  npx flowcairn doctor',
      '  git status --short',
      '  git diff',
      'Задайте свою цель, разрешенные пути и критерий проверки:',
      '  npx flowcairn task --id ORCH-001 --goal "Уточнить заголовок" --scope README.md --accept "Заголовок объясняет назначение"',
      'После npm install есть изменения package.json: проверьте их и добавьте к task --snapshot либо сохраните в Git.',
      'Если git status показывает новый package-lock.json, включите его явно: --include-untracked package-lock.json. Остальные новые файлы требуют такого же решения.',
      '  npx flowcairn ui',
      'Task сохраняет настоящий граф локально и ждет разрешения. AI пока не вызывается.',
    );
  process.stdout.write(sanitizeText(summary.join('\n')) + '\n');
}

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
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  let result;
  if (command === 'init') result = await initializeCommand(root, options);
  else if (command === 'doctor') result = await doctorProject(root);
  else if (command === 'task') {
    let input = options.file
      ? JSON.parse(readRegular(path.resolve(options.file), 256 * 1024).toString('utf8'))
      : {
          id: options.id,
          goal: options.goal,
          instructions: options.instructions ?? options.goal,
          scope: csv(options.scope),
          acceptance: options.accept ? [options.accept] : [],
          checks: csv(options.checks),
          contextPaths: csv(options.context),
          includeUntracked: csv(options['include-untracked']),
        };
    if (options.file && options['include-untracked']) {
      const parsed = TaskInputSchema.parse(input);
      input = {
        ...parsed,
        includeUntracked: [
          ...new Set([...parsed.includeUntracked, ...csv(options['include-untracked'])]),
        ],
      };
    }
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
  if (command === 'init' && !options.json) printInitialization(result);
  else if (command === 'task' && !options.json)
    process.stdout.write(
      `Граф ${result.runId} сохранен. AI не запускался.\nОткрыть граф: npx flowcairn ui\nВыполнение требует отдельного разрешения конкретного плана.\n`,
    );
  else process.stdout.write(JSON.stringify({ ok: true, command, result }, null, 2) + '\n');
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
          error: {
            code: error.code ?? 'INVALID_INPUT',
            message:
              error.name === 'ZodError'
                ? 'Некорректные параметры. Для task нужны --id, --goal, --scope и --accept. Проверьте поля и допустимые пути; справка: npx flowcairn --help.'
                : sanitizeText(error.message),
          },
        },
        null,
        2,
      ) + '\n',
    );
    process.exitCode = 2;
  }
}
