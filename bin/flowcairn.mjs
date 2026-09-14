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
import { GraphError, sha256 } from '../scripts/ai-graph/lib/io.mjs';
import {
  ProjectProfileSchema,
  onboardingConsentHash,
  hasOnboardingConsent,
  loadProjectProfile,
  RUNTIME_ROOT,
  PACKAGE_MANAGER_LOCKS,
  packageManagerLock,
  validatePackageManagerProject,
} from '../scripts/ai-graph/lib/project.mjs';
import { TaskInputSchema } from '../scripts/ai-graph/lib/schemas.mjs';
import { WorkflowService, sanitizeText } from '../scripts/ai-graph/lib/service.mjs';
import { runCli } from '../scripts/ai-graph/cli.mjs';
import { probeRunner } from '../scripts/ai-graph/lib/runner.mjs';
import { probeChecks, prepareCheckImage } from '../scripts/ai-graph/lib/docker-checks.mjs';
import { startViewer } from '../tools/ai-graph-viewer/server.mjs';
import { discoverWorkspaceManifests } from './workspaces.mjs';
import { assertRuntimePlatform, assertProjectPlatform, defaultProvider } from '../scripts/ai-graph/lib/platform.mjs';
import { openBrowser } from './browser.mjs';
import { checkUpdate } from './update.mjs';
import { instructionsCommand } from './instructions.mjs';
import { uninstallCommand } from './uninstall.mjs';
import { selectProjectSkills } from './skills-selection.mjs';
import { createTask } from '../scripts/ai-graph/lib/task-registration.mjs';
import { collectOnboarding, inspectOnboarding, onboardingInput, saveOnboarding } from './onboarding.mjs';
export { createTask };

const OWNER_FILE = '.ai-orchestrator/flowcairn-install.json';
const PROFILE = '.flowcairn.json';
const IGNORE_BLOCK = '# Flowcairn: локальное состояние, не исходники\n.ai-orchestrator/\n';
const CHECKS = ['typecheck', 'lint', 'tests', 'build'];
const VALUE_OPTIONS = new Set([
  'root',
  'provider',
  'model-mode',
  'reasoning-effort',
  'review-reasoning-effort',
  'test-policy',
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
  'fingerprint',
  'skills',
  'skill-actions',
  'skill-scope',
]);
const BOOLEAN_OPTIONS = new Set(['json', 'dry-run', 'help', 'snapshot', 'no-open', 'consent', 'read-consent', 'coverage']);

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
  assertRuntimePlatform();
}
function projectRoot(input = process.cwd()) {
  assertRuntimePlatform();
  const root = realpathSync(path.resolve(input));
  assertProjectPlatform(root);
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
  const lock = packageManagerLock(manager);
  if (existsSync(path.join(root, lock))) files.push(lock);
  if (manager === 'pnpm' && existsSync(path.join(root, 'pnpm-workspace.yaml')))
    files.push('pnpm-workspace.yaml');
  files.push(...discoverWorkspaceManifests(root, pkg, manager));
  return [...new Set(files)];
}

function packageManager(root, pkg, explicit) {
  if (explicit !== undefined) {
    packageManagerLock(explicit);
    return explicit;
  }
  const declared = typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : null;
  if (declared) packageManagerLock(declared);
  const detected = Object.entries(PACKAGE_MANAGER_LOCKS).filter(([manager, lock]) =>
    existsNoFollow(path.join(root, lock)) || (manager === 'pnpm' && existsNoFollow(path.join(root, 'pnpm-workspace.yaml'))),
  ).map(([manager]) => manager);
  const bun = ['bun.lock', 'bun.lockb'].some((name) => existsNoFollow(path.join(root, name)));
  if (bun || detected.length > 1 || (declared && detected.some((manager) => manager !== declared)))
    fail('PACKAGE_MANAGER', 'Менеджер пакетов неоднозначен или найден Bun lockfile. Выберите --package-manager npm|pnpm|yarn; Bun пока не поддерживается.');
  return declared ?? detected[0] ?? 'npm';
}

/** Первый запуск спрашивает настройки один раз, не читая глобальные аккаунты. */
export async function initializeCommand(input, options = {}, terminal = {}) {
  const root = projectRoot(input);
  if (existsNoFollow(path.join(root, PROFILE)) || existsNoFollow(path.join(root, '.ai-orchestrator')))
    return initializeProject(root, options);
  assertProviderPlatform(options);
  const selected = await collectOnboarding(root, options, terminal);
  const result = initializeProject(root, { ...selected, _skillManifest: await selectProjectSkills(root, selected, terminal) });
  if (selected.consent === true && !selected['dry-run']) {
    const inspected = await instructionsCommand(root, 'inspect');
    await instructionsCommand(root, 'activate', {consent:true, fingerprint:inspected.instructions.fingerprint});
  }
  return result;
}

export async function setupCommand(input, options = {}, terminal = {}) {
  const root = projectRoot(input);
  if (!existsNoFollow(path.join(root, PROFILE))) return initializeCommand(root, options, terminal);
  const current = inspectOnboarding(root);
  const selected = await collectOnboarding(root, { ...options, advanced: true }, terminal);
  const resolved = {
    provider:current.values.provider, model:current.values.model,
    'model-mode':current.values.modelMode, 'reasoning-effort':current.values.reasoningEffort,
    'test-policy':current.values.testPolicy, coverage:current.values.coverage,
    ...selected,
  };
  // В скриптах требуется новое явное разрешение; прежнее не считается ответом.
  const result = await saveOnboarding(root, onboardingInput(resolved, current.profileHash), {dryRun:options['dry-run'] === true});
  if (selected.consent === true && !options['dry-run']) {
    const inspected = await instructionsCommand(root, 'inspect');
    await instructionsCommand(root, 'activate', {consent:true, fingerprint:inspected.instructions.fingerprint});
  }
  return result;
}

function assertProviderPlatform(options) {
  if (options.provider && !['codex', 'openai'].includes(options.provider))
    fail('PROVIDER_UNSUPPORTED', 'Claude и Cursor пока не подключены к исполнителю Flowcairn. Выберите Codex на macOS или OpenAI API; автоматическое наследование настроек IDE недоступно.');
  if (process.platform !== 'darwin' && (options.provider ?? defaultProvider()) === 'codex')
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
  if (existingProfile && options.skills !== undefined &&
      JSON.stringify([...new Set(csv(options.skills))].sort()) !== JSON.stringify((existingProfile.skillManifest ?? []).map((entry) => entry.id.slice('project-'.length)).sort()))
    fail('SKILL_PROFILE_EXISTS', 'Профиль уже настроен. Позднее изменение выбранных Skills пока не поддерживается; текущий профиль сохранен.');
  if (existingProfile && options.skills !== undefined) {
    const requestedActions = options['skill-actions'] === undefined ? null : csv(options['skill-actions']).map((value) => value.startsWith('ai-') ? value : `ai-${value}`).sort();
    const requestedScope = options['skill-scope'] === undefined ? null : csv(options['skill-scope']).map((value) => value.replace(/\/$/, '')).sort();
    if ((existingProfile.skillManifest ?? []).some((entry) =>
      (requestedActions && JSON.stringify([...entry.actions].sort()) !== JSON.stringify(requestedActions)) ||
      (requestedScope && JSON.stringify([...entry.scope].sort()) !== JSON.stringify(requestedScope))))
      fail('SKILL_PROFILE_EXISTS', 'Профиль уже настроен. Позднее изменение этапов или области Skills пока не поддерживается; текущий профиль сохранен.');
  }
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
        provider: options.provider ?? defaultProvider(),
        model: options.model,
      }).success)
  )
    fail('AI_CONFIG', 'Укажите --provider codex или openai и --model с ID модели (не API-ключом).');
  if (!existingProfile && options['model-mode'] === 'manual' &&
      ((options['review-model'] && options['review-model'] !== options.model) ||
       (options['review-reasoning-effort'] && options['review-reasoning-effort'] !== options['reasoning-effort'])))
    fail('AI_CONFIG', 'В ручном режиме модель и усиление одинаковы для всех этапов. Для отдельной настройки ревью выберите auto.');
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
  validatePackageManagerProject(root, manager, pkg);
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
      ...(options._skillManifest?.length ? { skillManifest: options._skillManifest } : {}),
      ...(['read-consent', 'test-policy', 'coverage'].some((key) => options[key] !== undefined) ? { onboarding: {
        version: 1, readConsent: options['read-consent'] === true, readScope: 'tracked-project',
        testPolicy: options['test-policy'] ?? 'keep', coverage: options.coverage === true, instructions: 'preserve',
      } } : {}),
      ai: {
        ...(options['model-mode'] ? { modelMode: options['model-mode'] } : {}),
        ...(options['reasoning-effort'] ? { reasoningEffort: options['reasoning-effort'] } : {}),
        ...(options['review-reasoning-effort'] ? { reviewReasoningEffort: options['review-reasoning-effort'] } : {}),
        provider: options.provider ?? defaultProvider(),
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
  const exampleText = JSON.stringify({
    id: 'ORCH-001', goal: 'Один проверяемый результат',
    instructions: 'Опишите нужное поведение и ограничения', scope: ['README.md'],
    acceptance: ['Как проверить результат'], checks: [],
  }, null, 2) + '\n';
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
          ...(!existingProfile && options['read-consent'] === true ? { readConsentHash: onboardingConsentHash(root, profile) } : {}),
          profileOwned: !existingProfile,
          ignoreBefore: oldIgnore,
          ignoreAfterHash: sha256(ignore),
          ignoreBlockOwned: ignore !== oldIgnore,
          exampleHash: sha256(exampleText),
        },
        null,
        2,
      ) + '\n',
    );
    createOwned(
      path.join(stateDirectory, 'task.example.json'),
      exampleText,
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
  let manager;
  try {
    manager = {
      valid: true,
      version: validatePackageManagerProject(root, profile.packageManager),
      lockfile: packageManagerLock(profile.packageManager),
      boundary: profile.packageManager === 'yarn'
        ? 'Yarn 4, node_modules, только nodeLinker в .yarnrc.yml. PnP, plugins, custom/private registry пока не поддерживаются.'
        : profile.packageManager === 'pnpm'
          ? 'pnpm 9–11 с exact packageManager; без pin используется 11.8.0. Подготовка зависимостей с frozen lockfile, lifecycle scripts выключены.'
          : 'npm из Node22 check image. Если packageManager задает exact npm version, она должна совпасть с bundled версией image.',
    };
  } catch (error) {
    manager = { valid: false, code: error.code ?? 'PACKAGE_MANAGER', message: sanitizeText(error.message) };
  }
  return {
    ok: ai.ai.available && checks.available && manager.valid,
    root,
    node: process.versions.node,
    branch: git(root, ['branch', '--show-current']),
    configuredBranch: profile.integrationBranch,
    packageManager: profile.packageManager,
    manager,
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

const HELP = `Flowcairn — контролируемый AI Workflow + ReactFlow\n\n  init [--provider codex|openai] [--model MODEL] [--root PROJECT] [--dry-run] [--json]\n    Первый запуск автоматически предложит короткую настройку. В скрипте --model обязателен.\n    --model-mode manual|auto --reasoning-effort low|medium|high|xhigh\n    --test-policy keep|add --coverage (только по вашему выбору) --read-consent\n  setup    изменить настройки после закрытия UI; текущие планы не переписываются.\n    Локальные Skills: выбор файлов, этапов и области в терминале.\n    В скрипте: --skills name --skill-actions plan,review --skill-scope src.\n    По умолчанию: macOS — codex, Linux — openai; --provider задает явный выбор.\n  doctor [--root PROJECT]\n  checks prepare [--root PROJECT]\n  task --file TASK.json [--run ID] [--root PROJECT]\n  task --id ORCH-001 --goal TEXT --scope src --accept TEXT\n    --snapshot явно включает изменения tracked-файлов в снимок первого графа.\n    --include-untracked path1,path2 явно включает новые файлы в этот снимок.\n  [--root PROJECT] [--port 4329] [--no-open]\n    Без команды открывает локальный UI и браузер.\n  ui [--root PROJECT] [--port 4329] [--no-open]\n  update    проверить npm metadata, без установки и изменения планов\n  instructions inspect\n  instructions activate --fingerprint HASH --consent\n  uninstall [--dry-run]    удалить только unchanged owned integration\n  status|plan|events --run ID\n  approve --run ID --plan-hash HASH --permissions ai.read,workspace.source.write,workspace.output.write\n  run|retry|recover|replan|stop|accept|reject --run ID --plan-hash HASH\n  receipt|artifact --run ID --hash HASH\n  handoff --run ID\n  orchestrator COMMAND ...   расширенное управление очередью и Git-интеграцией\n\nЗапуск AI требует approval конкретного плана. Init/task/ui не запускают AI.\nДокументация: https://github.com/IgorBabikov/flowcairn\n`;

function printInitialization(result) {
  const profile = result.profile;
  const summary = [
    result.dryRun ? 'Предварительная проверка. Файлы не изменены.' : result.message,
    `Ветка: ${profile.integrationBranch}. Менеджер: ${profile.packageManager}. Проверки: ${profile.checks.join(', ') || 'не найдены'}.`,
    `AI: ${profile.ai.provider}, модель ${profile.ai.model}. Доступность модели не проверялась.`,
    `Разрешение на чтение и передачу AI: ${hasOnboardingConsent(result.root, profile) ? 'задано для этой установки' : 'не предоставлено; настройте через npx flowcairn setup'}.`,
    'Команды проекта выполняются в Docker. Изоляция через произвольный host shell не заменяется.',
  ];
  if (result.dryRun) summary.push(`Планируемые файлы: ${result.changes.join(', ')}.`);
  else
    summary.push(
      'Далее: npx flowcairn — открыть локальный UI и создать задачу.',
      'Разработка начнется после согласования плана.',
    );
  process.stdout.write(sanitizeText(summary.join('\n')) + '\n');
}

export async function main(tokens = process.argv.slice(2)) {
  tokens = [...tokens];
  const command = !tokens.length || (tokens[0].startsWith('--') && !['--help', '--version'].includes(tokens[0])) ? 'ui' : tokens.shift();
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
  const instructionsAction = command === 'instructions' ? tokens.shift() : undefined;
  const options = parseOptions(tokens),
    root = options.root ?? process.cwd();
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  let result;
  if (command === 'update') result = await checkUpdate(JSON.parse(readRegular(path.join(RUNTIME_ROOT, 'package.json')).toString('utf8')).version);
  else if (command === 'instructions') result = await instructionsCommand(projectRoot(root), instructionsAction, options);
  else if (command === 'uninstall') result = await uninstallCommand(projectRoot(root), options);
  else if (command === 'init') result = await initializeCommand(root, options);
  else if (command === 'setup') result = await setupCommand(root, options);
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
    const canonicalRoot = projectRoot(root);
    if (!existsNoFollow(path.join(canonicalRoot, PROFILE))) {
      const initialized = await initializeCommand(canonicalRoot, options);
      if (options['dry-run']) { printInitialization(initialized); return; }
      printInitialization(initialized);
    } else {
      initializeProject(canonicalRoot, options);
    }
    const { acquireRuntimeLease } = await import('../scripts/ai-graph/lib/lifecycle.mjs');
    const release = acquireRuntimeLease({ root: canonicalRoot, kind: 'viewer' });
    let server, service;
    const token = randomBytes(32).toString('base64url');
    const close = () => { release(); service?.close(); };
    try {
      service = await WorkflowService.open({ root: canonicalRoot });
      server = startViewer({ service, token, port, dist: path.join(RUNTIME_ROOT, 'tools/ai-graph-viewer/dist') });
    } catch (error) { close(); throw error; }
    server.once('close', close);
    server.on('listening', async () => {
      const url = `http://127.0.0.1:${port}/#session=${token}`;
      process.stdout.write(`Flowcairn: ${url}\nНе публикуйте временный URL с токеном. Ctrl+C завершает сервер.\n`);
      if (!options['no-open'] && !(await openBrowser(url)))
        process.stdout.write('Браузер не открылся автоматически. Откройте URL выше вручную.\n');
    });
    server.on('error', (error) => {
      close();
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
  if (['init', 'setup'].includes(command) && !options.json) printInitialization(result);
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
