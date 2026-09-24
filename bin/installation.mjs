import { gitExecutable } from '../scripts/ai-graph/lib/host-executables.mjs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { GraphError, sha256 } from '../scripts/ai-graph/lib/io.mjs';
import {
  ProjectProfileSchema, onboardingConsentHash, hasOnboardingConsent, loadProjectProfile,
  PACKAGE_MANAGER_LOCKS, packageManagerLock, discoverProjectChecks, trustedLocalChecksHash,
  PROJECT_CHECK_IDS, validatePackageManagerProject,
} from '../scripts/ai-graph/lib/project.mjs';
import { inspectCodexInstallation } from '../scripts/ai-graph/lib/runner.mjs';
import { codexModelSettings } from '../scripts/ai-graph/lib/codex-settings.mjs';
import { defaultProvider } from '../scripts/ai-graph/lib/platform.mjs';
import { probeExternalProvider } from '../scripts/ai-graph/lib/providers.mjs';
import { discoverWorkspaceManifests } from './workspaces.mjs';
import { PROFILE, csv, existsNoFollow, git, projectRoot, readRegular } from './project-files.mjs';

const OWNER_FILE = '.ai-orchestrator/flowcairn-install.json';
const IGNORE_BLOCK = '# Flowcairn: локальное состояние, не исходники\n.ai-orchestrator/\n';
const LOCAL_EXCLUDE = '.git/info/exclude';

function fail(code, message) {
  throw new GraphError(code, message);
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

export function assertProviderPlatform(options) {
  if (options.provider && !['codex', 'claude', 'cursor'].includes(options.provider))
    fail('PROVIDER_UNSUPPORTED', 'Выберите Codex, Claude Code или Cursor. OpenAI API больше не поддерживается.');

}

/** Explicit, repeatable setup. It never replaces AGENTS, hooks or an existing profile. */
export function initializeProject(input, options = {}) {
  const root = projectRoot(input);
  const profilePath = path.join(root, PROFILE);
  const profileExists = existsNoFollow(profilePath);
  if (profileExists && existsNoFollow(path.join(root, OWNER_FILE))) {
    let raw;
    try { raw = JSON.parse(readRegular(profilePath, 32768).toString('utf8')); }
    catch { fail('PROJECT_PROFILE_INVALID', '.flowcairn.json не соответствует строгому профилю проекта.'); }
    if (!Object.hasOwn(raw, 'checkMode'))
      fail('PROFILE_MIGRATION_REQUIRED', 'Legacy-профиль требует безопасной миграции через npx flowcairn.');
  }
  const existingProfile = profileExists ? loadProjectProfile(root) : null;
  const selectedProvider = options.provider ?? defaultProvider();
  if (!existingProfile && ['claude', 'cursor'].includes(selectedProvider)) {
    const probe = probeExternalProvider(selectedProvider, { executable: options['provider-path'] });
    if (!probe.available) fail('PROVIDER_TOOLCHAIN_INVALID', 'Claude Code/Cursor не найден или не прошел безопасную проверку версии.');
    options = { ...options, model: 'provider-default', 'model-mode': 'provider', 'provider-path': probe.executable, 'provider-version': probe.version };
  }
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
  if (!existingProfile && selectedProvider === 'codex') {
    if (!options.model)
      options = { ...options, model: 'provider-default', 'model-mode': 'provider' };
    if (options['model-mode'] === 'provider' || options.model === 'provider-default') codexModelSettings();
    const cli = inspectCodexInstallation({ codexPath: options['codex-path'] });
    if (!cli.available) {
      const message = cli.reason === 'RUNNER_TOOLCHAIN_CAPABILITY'
        ? 'Codex CLI не поддерживает обязательные параметры безопасного запуска. Обновите Codex CLI или Flowcairn. Настройка не сохранена.'
        : 'Codex CLI не прошел проверку или не авторизован. Укажите безопасную npm-установку @openai/codex или выполните codex login. Настройка не сохранена.';
      fail('RUNNER_TOOLCHAIN_INVALID', message);
    }
  }
  if (!existingProfile && !options.model)
    fail(
      'MODEL_REQUIRED',
      'Нужен проверенный AI CLI. Выполните npx flowcairn init и выберите Codex, Claude Code или Cursor. Файлы не изменены.',
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
  const gitCheckout = existsNoFollow(path.join(root, '.git'));
  const integrationBranch =
    existingProfile?.integrationBranch ?? options.branch ?? (gitCheckout ? git(root, ['branch', '--show-current']) : 'direct');
  if (!integrationBranch)
    fail(
      'BRANCH_REQUIRED',
      'Git находится в detached HEAD. Переключитесь на рабочую ветку или укажите --branch.',
    );
  validatePackageManagerProject(root, manager, pkg);
  const discoveredChecks = discoverProjectChecks(pkg);
  const checkMode = options['check-mode'] ?? 'trusted-local';
  if (!['none', 'trusted-local', 'hardened'].includes(checkMode))
    fail('CHECK_MODE', 'Доступны check-mode: none, trusted-local или hardened.');
  const checks = options.checks === undefined
    ? (checkMode !== 'none' ? discoveredChecks.checks : [])
    : csv(options.checks);
  if (checkMode === 'none' && checks.length)
    fail('CHECK_MODE', 'Для проверок проекта выберите trusted-local или hardened.');
  for (const check of checks) {
    if (!PROJECT_CHECK_IDS.includes(check) || !discoveredChecks.checkScripts[check])
      fail('CHECK_SCRIPT_MISSING', `Для проверки ${check} нужен существующий script package.json.`);
  }
  const checkScripts = Object.fromEntries(checks.map((check) => [check, discoveredChecks.checkScripts[check]]));
  const workspaceMode = options['workspace-mode'] ?? 'direct';
  if (!['direct', 'worktree'].includes(workspaceMode))
    fail('WORKSPACE_MODE', 'Доступны режимы работы: direct или worktree.');
  const profile =
    existingProfile ??
    ProjectProfileSchema.parse({
      version: 1,
      integrationBranch,
      workspaceMode,
      packageManager: manager,
      contextPaths: csv(options.context),
      checks,
      checkMode,
      ...(checks.length ? { checkScripts } : {}),
      outputPaths: csv(options.outputs),
      manifests: discoverManifests(root, pkg, manager, options.manifests),
      ...(options._skillManifest?.length ? { skillManifest: options._skillManifest } : {}),
      ...(['read-consent', 'test-policy', 'coverage'].some((key) => options[key] !== undefined) ? { onboarding: {
        version: 1, readConsent: options['read-consent'] === true,
        readScope: workspaceMode === 'direct' ? 'project-files' : 'tracked-project',
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
  const excludeFile = gitCheckout ? localExcludeFile(root) : null;
  const oldExclude = excludeFile && existsNoFollow(excludeFile) ? readRegular(excludeFile).toString('utf8') : '';
  const alreadyIgnored = !gitCheckout || spawnSync(
    gitExecutable(),
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
      ],
    };
  const tmp = excludeFile ? path.join(path.dirname(excludeFile), `.flowcairn-exclude-${randomUUID()}.tmp`) : null;
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
          ...(profile.checkMode !== 'none' && profile.checks.length
            ? { trustedLocalChecksHash: trustedLocalChecksHash(root, profile) }
            : {}),
          profileOwned: !existingProfile,
          localExcludeBefore: oldExclude,
          localExcludeAfterHash: sha256(exclude),
          localExcludeBlockOwned: exclude !== oldExclude,
        },
        null,
        2,
      ) + '\n',
    );
    if (excludeFile && tmp && exclude !== oldExclude) {
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
