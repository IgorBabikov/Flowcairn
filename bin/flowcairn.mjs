#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { GraphError } from '../scripts/ai-graph/lib/io.mjs';
import { loadProjectProfile, RUNTIME_ROOT, packageManagerLock, validatePackageManagerProject } from '../scripts/ai-graph/lib/project.mjs';
import { TaskInputSchema } from '../scripts/ai-graph/lib/schemas.mjs';
import { WorkflowService, sanitizeText } from '../scripts/ai-graph/lib/service.mjs';
import { runCli } from '../scripts/ai-graph/cli.mjs';
import { probeRunner, probeLocalChecks } from '../scripts/ai-graph/lib/runner.mjs';
import { probeChecks, prepareCheckImage } from '../scripts/ai-graph/lib/docker-checks.mjs';
import { startViewer } from '../tools/ai-graph-viewer/server.mjs';
import { assertRuntimePlatform } from '../scripts/ai-graph/lib/platform.mjs';
import { openBrowser } from './browser.mjs';
import { checkUpdate } from './update.mjs';
import { instructionsCommand } from './instructions.mjs';
import { uninstallCommand } from './uninstall.mjs';
import { selectProjectSkills } from './skills-selection.mjs';
import { createTask } from '../scripts/ai-graph/lib/task-registration.mjs';
import { inspectHarnesses } from '../scripts/ai-graph/lib/harnesses.mjs';
import { collectOnboarding, inspectOnboarding, onboardingInput, saveOnboarding } from './onboarding.mjs';
import { initializeProject, assertProviderPlatform } from './installation.mjs';
import { PROFILE, csv, existsNoFollow, git, projectRoot, readRegular } from './project-files.mjs';
export { createTask, initializeProject };

const VALUE_OPTIONS = new Set([
  'root',
  'provider',
  'provider-path',
  'provider-version',
  'model-mode',
  'workspace-mode',
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
function requireNode() {
  assertRuntimePlatform();
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
    'workspace-mode':current.values.workspaceMode,
    ...(current.values.providerPath ? {'provider-path':current.values.providerPath} : {}),
    ...(current.values.providerVersion ? {'provider-version':current.values.providerVersion} : {}),
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

const HELP = `Flowcairn — от задачи до проверенного результата\n\nБыстрый старт\n  npx flowcairn          начать настройку и открыть интерфейс\n  npx flowcairn setup    изменить модель и правила после закрытия интерфейса\n  npx flowcairn doctor   проверить подготовку проекта\n\nДополнительно\n  npx flowcairn checks prepare   подготовить изолированные проверки\n  npx flowcairn uninstall        снять интеграцию, не удаляя исходники\n\nДля интеграции\n  init | ui | status | plan | events | receipt | artifact | handoff | orchestrator\n\nКод проекта не изменится, пока вы не согласуете план.\nДокументация: https://github.com/IgorBabikov/flowcairn\n`;

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
