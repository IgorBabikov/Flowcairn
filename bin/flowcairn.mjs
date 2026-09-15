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
import { GraphError, sha256 } from '../scripts/ai-graph/lib/io.mjs';
import {
  ProjectProfileSchema,
  onboardingConsentHash,
  hasOnboardingConsent,
  loadProjectProfile,
  RUNTIME_ROOT,
  PACKAGE_MANAGER_LOCKS,
  packageManagerLock,
  discoverProjectChecks,
  trustedLocalChecksHash,
  PROJECT_CHECK_IDS,
  validatePackageManagerProject,
} from '../scripts/ai-graph/lib/project.mjs';
import { TaskInputSchema } from '../scripts/ai-graph/lib/schemas.mjs';
import { WorkflowService, sanitizeText } from '../scripts/ai-graph/lib/service.mjs';
import { runCli } from '../scripts/ai-graph/cli.mjs';
import { probeRunner, probeLocalChecks } from '../scripts/ai-graph/lib/runner.mjs';
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
import { inspectHarnesses } from '../scripts/ai-graph/lib/harnesses.mjs';
import { probeExternalProvider } from '../scripts/ai-graph/lib/providers.mjs';
import { collectOnboarding, inspectOnboarding, onboardingInput, saveOnboarding } from './onboarding.mjs';
export { createTask };

const OWNER_FILE = '.ai-orchestrator/flowcairn-install.json';
const PROFILE = '.flowcairn.json';
const IGNORE_BLOCK = '# Flowcairn: локальное состояние, не исходники\n.ai-orchestrator/\n';
const LOCAL_EXCLUDE = '.git/info/exclude';
const VALUE_OPTIONS = new Set([
  'root',
  'provider',
  'provider-path',
  'provider-version',
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
  'check-mode',
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
const BOOLEAN_OPTIONS = new Set(['json', 'dry-run', 'help', 'snapshot', 'no-open', 'consent', 'read-consent', 'coverage', 'trusted-local-consent']);

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
function localExcludeFile(root) {
  const gitDirectory = path.join(root, '.git');
  const gitInfo = path.join(gitDirectory, 'info');
  for (const directory of [gitDirectory, gitInfo]) {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      fail('INSTALL_CONFLICT', 'Git local exclude недоступен в этом checkout.');
  }
  return path.join(gitInfo, 'exclude');
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
  const checkPreparation = await maybePrepareChecks(root, result.profile, selected, terminal);
  if (selected.consent === true && !selected['dry-run']) {
    const inspected = await instructionsCommand(root, 'inspect');
    await instructionsCommand(root, 'activate', {consent:true, fingerprint:inspected.instructions.fingerprint});
  }
  return { ...result, checkPreparation };
}

/** Hardened Docker checks are opt-in; normal onboarding uses local worktree checks. */
export async function maybePrepareChecks(root, profile, options = {}, terminal = {}, checks = {
  probe: probeChecks,
  prepare: prepareCheckImage,
}) {
  if (options['dry-run'] || options.json || !profile.checks.length)
    return { prepared: false, reason: 'NOT_NEEDED' };
  if (profile.checkMode !== 'hardened') return { prepared: false, reason: 'LOCAL_DEFAULT' };
  const status = checks.probe({ root });
  if (status.available || status.reason !== 'CHECK_IMAGE_MISSING')
    return { prepared: false, reason: status.available ? 'READY' : status.reason };
  const input = terminal.input ?? process.stdin;
  const output = terminal.output ?? process.stderr;
  if (!input.isTTY || !output.isTTY)
    return { prepared: false, reason: 'NON_INTERACTIVE' };
  const prompt = terminal.prompt ?? createInterface({ input, output });
  try {
    output.write('Проверки проекта найдены. Docker доступен, но образ проверок еще не подготовлен.\n');
    const answer = (await prompt.question('Подготовить проверки в Docker? Это скачает образ и зависимости проекта. [да / нет; Enter — нет]: ')).trim().toLowerCase();
    if (!['да', 'yes'].includes(answer)) {
      output.write('Проверки не подготовлены. Перед выполнением проверок: npx flowcairn checks prepare.\n');
      return { prepared: false, reason: 'DECLINED' };
    }
    return { prepared: true, result: checks.prepare({ root }) };
  } finally {
    if (!terminal.prompt) prompt.close();
  }
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
  if (options.provider && !['codex', 'openai', 'claude', 'cursor'].includes(options.provider))
    fail('PROVIDER_UNSUPPORTED', 'Выберите Codex, OpenAI API, Claude Code или Cursor.');
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
  const selectedProvider = options.provider ?? defaultProvider();
  if (!existingProfile && ['claude', 'cursor'].includes(selectedProvider)) {
    const probe = probeExternalProvider(selectedProvider, { executable: options['provider-path'] });
    if (!probe.available) fail('PROVIDER_TOOLCHAIN_INVALID', 'Claude Code/Cursor не найден или не прошел безопасную проверку версии.');
    options = { ...options, model: 'provider-default', 'model-mode': 'provider', 'provider-path': probe.executable, 'provider-version': probe.version };
  }
  if (!existingProfile && !options.model && selectedProvider === 'codex')
    options = { ...options, model: 'provider-default', 'model-mode': 'provider' };
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
        provider: selectedProvider,
        model: options.model,
      }).success)
  )
    fail('AI_CONFIG', 'Укажите поддерживаемый provider и модель; Claude Code/Cursor наследуют выбранную в клиенте модель.');
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
  const discoveredChecks = discoverProjectChecks(pkg);
  const checkMode = options['check-mode'] ?? 'none';
  if (!['none', 'trusted-local', 'hardened'].includes(checkMode))
    fail('CHECK_MODE', 'Доступны check-mode: none, hardened или trusted-local.');
  const checks = options.checks === undefined ? [] : csv(options.checks);
  if (checkMode === 'none' && checks.length)
    fail('CHECK_MODE', 'Для project checks выберите hardened или trusted-local.');
  if (checkMode === 'trusted-local' && checks.length && options['trusted-local-consent'] !== true)
    fail('CHECK_LOCAL_CONSENT', 'trusted-local запускает scripts проекта с правами пользователя. Повторите с --trusted-local-consent после проверки scripts.');
  for (const check of checks) {
    if (!PROJECT_CHECK_IDS.includes(check) || !discoveredChecks.checkScripts[check])
      fail('CHECK_SCRIPT_MISSING', `Для проверки ${check} нужен существующий script package.json.`);
  }
  const checkScripts = Object.fromEntries(checks.map((check) => [check, discoveredChecks.checkScripts[check]]));
  const profile =
    existingProfile ??
    ProjectProfileSchema.parse({
      version: 1,
      integrationBranch,
      packageManager: manager,
      contextPaths: csv(options.context),
      checks,
      checkMode,
      ...(checks.length ? { checkScripts } : {}),
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
        provider: selectedProvider,
        model: options.model,
        ...(options['provider-path'] ? { providerPath: path.resolve(options['provider-path']) } : {}),
        ...(options['provider-version'] ? { providerVersion: options['provider-version'] } : {}),
        ...(options['review-model'] ? { reviewModel: options['review-model'] } : {}),
        ...(options['codex-path'] ? { codexPath: path.resolve(options['codex-path']) } : {}),
      },
    });
  for (const file of profile.manifests) readProjectFile(root, file, 16 * 1024 * 1024);
  // Project .gitignore belongs to the team. Flowcairn keeps only its own local
  // state invisible through Git's per-checkout exclude file.
  const excludeFile = localExcludeFile(root);
  const oldExclude = existsNoFollow(excludeFile) ? readRegular(excludeFile).toString('utf8') : '';
  const alreadyIgnored = spawnSync(
    '/usr/bin/git',
    ['-C', root, 'check-ignore', '-q', '--', '.ai-orchestrator/flowcairn-install.json'],
    { stdio: 'ignore' },
  ).status === 0;
  const exclude = alreadyIgnored
    ? oldExclude
    : oldExclude + (oldExclude && !oldExclude.endsWith('\n') ? '\n' : '') + IGNORE_BLOCK;
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
        ...(exclude === oldExclude ? [] : [`${LOCAL_EXCLUDE} (локально)`]),
        OWNER_FILE,
        '.ai-orchestrator/task.example.json',
      ],
    };
  const tmp = path.join(path.dirname(excludeFile), `.flowcairn-exclude-${randomUUID()}.tmp`);
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
          ...(profile.checkMode === 'trusted-local' && options['trusted-local-consent'] === true
            ? { trustedLocalChecksHash: trustedLocalChecksHash(root, profile) }
            : {}),
          profileOwned: !existingProfile,
          localExcludeBefore: oldExclude,
          localExcludeAfterHash: sha256(exclude),
          localExcludeBlockOwned: exclude !== oldExclude,
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
    if (exclude !== oldExclude) {
      const excludeMode = existsNoFollow(excludeFile) ? lstatSync(excludeFile).mode & 0o777 : 0o600;
      createOwned(tmp, exclude, excludeMode);
      const current = existsNoFollow(excludeFile) ? readRegular(excludeFile).toString('utf8') : '';
      if (current !== oldExclude)
        fail(
          'INSTALL_CONFLICT',
          'Локальный Git exclude изменился во время установки. Он сохранен; повторите проверку.',
        );
      renameSync(tmp, excludeFile);
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
      existingProfile && exclude === oldExclude
        ? 'Локальное состояние создано по существующему профилю. Исходники не изменены; можно создать задачу.'
        : hasOnboardingConsent(root, profile)
          ? 'Проект настроен. Введите задачу: Flowcairn проведет анализ и подготовит план. Разработка начнется после вашего согласования плана.'
          : 'Проект настроен. Для анализа задачи разрешите чтение и передачу AI через npx flowcairn setup.',
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
  const checks = profile.checkMode === 'hardened'
    ? probeChecks({ root })
    : probeLocalChecks({ root });
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
    assistants: inspectHarnesses(),
    ai: ai.ai,
    checks,
    note: profile.checkMode === 'local'
      ? 'Проверки выполняются локально в отдельном worktree. Docker не нужен; это не изолированная песочница.'
      : 'Проверки используют подготовленный изолированный Docker-образ.',
  };
}

export function canHandoff(snapshot, state) {
  return snapshot.status === 'passed' && snapshot.integrity?.valid === true &&
    (snapshot.finalDisposition === 'accepted' || state.completion === 'ready-for-review');
}

export async function handoff(input, runId) {
  const root = projectRoot(input),
    service = await WorkflowService.open({ root });
  const snapshot = service.snapshot(runId);
  const state = service.store.readRun(runId);
  if (!canHandoff(snapshot, state))
    fail('ACCEPT_REQUIRED', 'Нужен проверенный результат, готовый к личному ревью, или явное принятие Graph.');
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

const HELP = `Flowcairn — от задачи до проверенного результата\n\nБыстрый старт\n  npx flowcairn          начать настройку и открыть Graph\n  npx flowcairn setup    изменить модель и правила после закрытия UI\n  npx flowcairn doctor   проверить подготовку проекта\n\nДополнительно\n  npx flowcairn checks prepare   подготовить изолированные проверки\n  npx flowcairn uninstall        снять интеграцию, не удаляя исходники\n\nДля интеграции\n  init | ui | status | plan | events | receipt | artifact | handoff | orchestrator\n\nКод проекта не изменится, пока вы не согласуете план.\nДокументация: https://github.com/IgorBabikov/flowcairn\n`;

export function printInitialization(result) {
  const summary = [
    result.dryRun ? 'Предварительная проверка. Файлы не изменены.' : 'Готово. Flowcairn подготовлен для этого проекта.',
    result.dryRun
      ? 'Проверьте список ниже и повторите команду без --dry-run.'
      : 'Теперь откроется Graph. Опишите задачу обычным языком — сначала увидите план.',
    'Код проекта не изменится, пока вы не согласуете этот план.',
  ];
  if (result.dryRun) summary.push(`Будут созданы: ${result.changes.join(', ')}.`);
  if (result.checkPreparation && !result.checkPreparation.prepared &&
      ['DECLINED', 'NON_INTERACTIVE'].includes(result.checkPreparation.reason))
    summary.push('Проверки можно подготовить позже из интерфейса или командой npx flowcairn checks prepare.');
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
