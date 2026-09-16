import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { z } from 'zod';
import { GraphError, hashObject, sha256 } from '../scripts/ai-graph/lib/io.mjs';
import { ProjectProfileSchema, discoverProjectChecks, loadProjectProfile, projectProfileHash, hasOnboardingConsent, onboardingConsentHash } from '../scripts/ai-graph/lib/project.mjs';
import { defaultProvider } from '../scripts/ai-graph/lib/platform.mjs';
import { acquireUninstallGuard } from '../scripts/ai-graph/lib/lifecycle.mjs';
import { readIntegrationTarget, replaceIntegrationFile } from '../scripts/ai-graph/lib/integration.mjs';
import { migrateProjectProfile } from '../scripts/ai-orchestrator.mjs';
import { inspectHarnesses } from '../scripts/ai-graph/lib/harnesses.mjs';
import { probeExternalProvider } from '../scripts/ai-graph/lib/providers.mjs';
import { codexModelSettings } from '../scripts/ai-graph/lib/codex-settings.mjs';
import { inspectCodexInstallation } from '../scripts/ai-graph/lib/runner.mjs';

const effort = z.enum(['low', 'medium', 'high', 'xhigh']);
const SetupSchema = z.strictObject({
  profileHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  provider: z.enum(['codex', 'claude', 'cursor']), model: ProjectProfileSchema.shape.ai.shape.model,
  modelMode: z.enum(['provider', 'manual', 'auto']), reasoningEffort: effort,
  providerPath: z.string().max(1024).optional(), providerVersion: z.string().max(160).optional(),
  reviewModel: ProjectProfileSchema.shape.ai.shape.model.optional(), reviewReasoningEffort: effort.optional(),
  testPolicy: z.enum(['keep', 'add']), coverage: z.boolean(), readConsent: z.boolean(),
});
const fail = (code, message) => { throw new GraphError(code, message); };

function paint(output, code, text) {
  return output.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text;
}

function step(output, index, title) {
  output.write(`\n${paint(output, '1;38;5;99', `Шаг ${index} из 5`)} ${paint(output, '1', title)}\n`);
}

export function inspectOnboarding(root) {
  let profile;
  try { profile = loadProjectProfile(root); }
  catch (error) { if (error.code !== 'PROJECT_PROFILE_MISSING') throw error; }
  const harnesses = new Map(inspectHarnesses().map((item) => [item.id, item]));
  let inherited = null;
  if (profile?.ai.provider === 'codex' && (profile.ai.modelMode === 'provider' || profile.ai.model === 'provider-default')) {
    try { inherited = codexModelSettings(); } catch { /* Missing defaults stay explicit in UI. */ }
  }
  const externalProvider = (id) => {
    const harness = harnesses.get(id);
    const probe = probeExternalProvider(id, { executable: harness?.executable });
    return {
      id,
      label: harness?.label ?? id,
      supported: probe.available,
      state: probe.available ? 'available' : 'not-detected',
      reason: probe.available ? null : probe.reason === 'PROVIDER_AUTH_REQUIRED'
        ? `${harness?.label ?? id}: войдите в CLI и повторите проверку.`
        : `${harness?.label ?? id} не найден или не прошел безопасную проверку версии.`,
      ...(probe.available ? { executable: probe.executable, version: probe.version } : {}),
    };
  };
  return {
    configured: Boolean(profile && hasOnboardingConsent(root, profile)),
    profileHash: profile ? projectProfileHash(root) : null,
    providers: [
      (() => { const cli = inspectCodexInstallation(profile?.ai ?? {}); return { id: 'codex', label: 'Codex', supported: cli.available, state: cli.available ? 'available' : 'not-detected', reason: cli.reason }; })(),
      externalProvider('claude'),
      externalProvider('cursor'),
    ],
    values: {
      provider: profile?.ai.provider ?? defaultProvider(), model: profile?.ai.model ?? '',
      modelMode: profile?.ai.modelMode ?? 'manual', reasoningEffort: inherited?.reasoningEffort ?? profile?.ai.reasoningEffort ?? 'medium',
      ...(inherited ? { model: inherited.model } : {}),
      ...(profile?.ai.reviewModel ? { reviewModel: profile.ai.reviewModel } : {}),
      ...(profile?.ai.reviewReasoningEffort ? { reviewReasoningEffort: profile.ai.reviewReasoningEffort } : {}),
      testPolicy: profile?.onboarding?.testPolicy ?? 'keep', coverage: profile?.onboarding?.coverage ?? false,
      readConsent: Boolean(profile && hasOnboardingConsent(root, profile)),
      ...(profile?.ai.providerPath ? { providerPath: profile.ai.providerPath } : {}),
      ...(profile?.ai.providerVersion ? { providerVersion: profile.ai.providerVersion } : {}),
    },
    limitations: [
      'Codex: модель и усиление считываются из конфигурации CLI. Настройки активного чата VS Code не считываются. Можно выбрать модель вручную в Flowcairn.',
      'Обычные проверки запускаются в отдельной worktree без Docker. Это не контейнерная песочница: доверяйте коду проекта и зависимостям.',
      'Docker остается дополнительным усиленным режимом проверок и не нужен для первого запуска.',
      'Поддержка исполнения: Node.js 22, macOS и Linux; native Windows не поддерживается. WSL2 требует Linux-файловую систему.',
      'Изменение настроек: закройте UI и выполните npx flowcairn setup. Старые планы сохранят прежний профиль и потребуют перепланирования.',
    ],
  };
}

/** Короткий опрос; отсутствие ответа никогда не означает согласие на передачу кода. */
export async function collectOnboarding(root, options = {}, terminal = {}) {
  const input = terminal.input ?? process.stdin;
  const output = terminal.output ?? process.stderr;
  if (!input.isTTY || !output.isTTY || options.json || options['dry-run']) return options;
  const prompt = terminal.prompt ?? createInterface({ input, output });
  const ask = async (text, fallback) => (await prompt.question(text)).trim() || fallback;
  const choice = async (key, text, choices, fallback) => {
    const answer = options[key] ?? await ask(text, fallback);
    if (!choices.includes(answer)) fail('ONBOARDING_CHOICE', 'Выберите один из показанных вариантов. Файлы не изменены.');
    return answer;
  };
  try {
    output.write(`\n${paint(output, '1;38;5;99', 'Flowcairn')} ${paint(output, '2', '· от задачи до проверенного результата')}\n`);
    output.write(`${paint(output, '38;5;245', 'Ответьте на пять коротких вопросов. Код не изменится до согласования плана.')}\n`);
    step(output, 1, 'Как Flowcairn будет работать с AI');
    const harnesses = inspectHarnesses();
    const detected = harnesses.filter((item) => item.detected).map((item) => item.label);
    if (detected.length) output.write(`${paint(output, '38;5;245', `Обнаружены AI-клиенты: ${detected.join(', ')}.`)}\n`);
    output.write(`${paint(output, '38;5;99', '[1]')} Codex — использовать настроенный Codex\n`);
    const externalChoices = /** @type {Array<'claude'|'cursor'>} */ (['claude', 'cursor']).map((id) => ({ id, probe: probeExternalProvider(id, { executable: options.provider === id ? options['provider-path'] : harnesses.find((item) => item.id === id)?.executable }) }));
    externalChoices.forEach(({ id, probe }, index) => output.write(`${paint(output, '38;5;99', `[${index + 2}]`)} ${id === 'claude' ? 'Claude Code' : 'Cursor'} — ${probe.available ? 'использовать выбранный CLI' : probe.reason === 'PROVIDER_AUTH_REQUIRED' ? 'нужно войти в CLI' : 'нужен установленный и проверенный CLI'}\n`));
    const providerAnswer = options.provider ?? await ask(`Выбор [${defaultProvider() === 'codex' ? '1' : '2'}]: `, defaultProvider());
    const provider = ({'1':'codex', ...Object.fromEntries(externalChoices.map(({id}, index) => [String(index + 2), id]))})[providerAnswer] ?? providerAnswer;
    if (!['codex', ...externalChoices.map(({ id }) => id)].includes(provider)) fail('PROVIDER_UNSUPPORTED', 'Выберите Codex, Claude Code или Cursor из списка.');
    const external = externalChoices.find((item) => item.id === provider)?.probe;
    if (['claude', 'cursor'].includes(provider) && !external?.available)
      fail(external?.reason === 'PROVIDER_AUTH_REQUIRED' ? 'PROVIDER_AUTH_REQUIRED' : 'PROVIDER_TOOLCHAIN_INVALID', external?.reason === 'PROVIDER_AUTH_REQUIRED'
        ? `${provider === 'claude' ? 'Claude Code' : 'Cursor'} не авторизован. Войдите в CLI и повторите.`
        : `${provider === 'claude' ? 'Claude Code' : 'Cursor Agent'} не найден или не прошел проверку версии. Установите официальный CLI и повторите.`);
    if (provider === 'codex' && process.platform !== 'darwin') fail('PROVIDER_PLATFORM', 'Исполнение Codex пока доступно только на macOS.');
    if (provider === 'codex') {
      const cli = inspectCodexInstallation();
      if (!cli.available) fail('RUNNER_TOOLCHAIN_INVALID', 'Codex CLI не прошел проверку. Установите поддерживаемую версию 0.145.0 или 0.154.0. Настройка не сохранена.');
    }
    const advanced = options.advanced === true;
    step(output, 2, 'Как выбирать модель');
    const providerManaged = ['claude', 'cursor'].includes(provider) || (provider === 'codex' && !advanced && options['model-mode'] === undefined);
    if (providerManaged)
      output.write(`${paint(output, '38;5;245', provider === 'codex' ? 'Flowcairn использует настройки отдельного CLI. Выбор активного чата в VS Code не наследуется.' : 'Flowcairn использует настроенный CLI. Модель и доступ определяет выбранный клиент.') }\n`);
    else if (['codex', 'claude', 'cursor'].includes(provider))
      output.write(`${paint(output, '38;5;245', 'Укажите модель и усиление, только если хотите переопределить настройки Codex для Flowcairn.')}\n`);
    const mode = providerManaged ? 'provider' : advanced
      ? await choice('model-mode', 'Режим: provider — настройки Codex, manual — одна модель, auto — отдельные настройки ревью [Enter — manual]: ', ['provider','manual','auto'], 'manual')
      : options['model-mode'] ?? 'manual';
    if (mode === 'provider' && !['codex', 'claude', 'cursor'].includes(provider)) fail('ONBOARDING_CHOICE', 'Этот провайдер требует явный ID модели.');
    if (provider === 'codex' && mode === 'provider') {
      const settings = codexModelSettings();
      output.write(`Модель CLI: ${settings.model}; усиление: ${settings.reasoningEffort}.\n`);
    }
    const model = mode === 'provider' ? 'provider-default' : options.model ?? await ask('ID модели, например gpt-5.6-terra: ', '');
    if (!model) fail('MODEL_REQUIRED', 'Нужен ID модели. Файлы не изменены.');
    const reasoning = mode === 'provider' ? undefined : advanced ? await choice('reasoning-effort', 'Усиление: low, medium, high или xhigh [Enter — medium]: ', ['low','medium','high','xhigh'], 'medium') : options['reasoning-effort'] ?? 'medium';
    const review = mode === 'auto' ? {
      'review-model': options['review-model'] ?? await ask('Модель ревью [Enter — та же]: ', model),
      'review-reasoning-effort': await choice('review-reasoning-effort', 'Усиление ревью [low / medium / high / xhigh; Enter — high]: ', ['low','medium','high','xhigh'], 'high'),
    } : {};
    step(output, 3, 'Как поступать с тестами');
    output.write(`${paint(output, '38;5;99', '[1]')} Сохранить текущий подход проекта\n`);
    output.write(`${paint(output, '38;5;99', '[2]')} Добавлять тесты, когда это оправдано задачей\n`);
    const testsAnswer = options['test-policy'] ?? await ask('Выбор [1]: ', 'keep');
    const testPolicy = ({'1':'keep','2':'add'})[testsAnswer] ?? testsAnswer;
    if (!['keep','add'].includes(testPolicy)) fail('ONBOARDING_CHOICE', 'Выберите подход к тестам из списка.');
    const yes = async (text) => ['да', 'yes'].includes((await ask(text, 'нет')).toLowerCase());
    const coverage = options.coverage ?? (advanced ? await yes('Нужно измерять покрытие тестами? [да / нет; Enter — нет]: ') : false);
    step(output, 4, 'Как запускать проверки проекта');
    let discoveredChecks = { checks: [], checkScripts: {} };
    try { discoveredChecks = discoverProjectChecks(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))); } catch { /* Init validates package.json before writing. */ }
    const listed = discoveredChecks.checks.map((id) => `${id} → ${discoveredChecks.checkScripts[id]}`).join(', ');
    output.write(`${paint(output, '38;5;245', listed ? `Найдены: ${listed}.` : 'Подходящих scripts не найдено.')}\n`);
    output.write(`${paint(output, '38;5;99', '[1]')} Не запускать scripts автоматически — безопасный старт\n`);
    output.write(`${paint(output, '38;5;99', '[2]')} Docker — изолированные проверки\n`);
    output.write(`${paint(output, '38;5;99', '[3]')} Доверенный локальный проект — scripts получат права вашей учетной записи\n`);
    const rawCheckMode = options['check-mode'] ?? await ask('Режим проверок [1]: ', 'none');
    const checkMode = ({ '1': 'none', '2': 'hardened', '3': 'trusted-local' })[rawCheckMode] ?? rawCheckMode;
    if (!['none', 'hardened', 'trusted-local'].includes(checkMode))
      fail('ONBOARDING_CHOICE', 'Выберите способ запуска проверок из списка.');
    if (checkMode !== 'none' && !discoveredChecks.checks.length)
      fail('CHECK_SCRIPT_MISSING', 'В проекте нет conventional scripts для выбранного режима проверок.');
    const trustedLocalConsent = checkMode === 'trusted-local'
      ? await yes(`Подтверждаете локальный запуск: ${listed}? [да / нет; Enter — нет]: `)
      : false;
    if (checkMode === 'trusted-local' && !trustedLocalConsent)
      fail('CHECK_LOCAL_CONSENT', 'Без отдельного согласия trusted-local не включается.');
    step(output, 5, 'Согласуйте границы работы');
    output.write(`${paint(output, '38;5;245', 'Flowcairn прочитает только разрешенные файлы проекта. Изменения начнутся только после вашего согласования плана.')}\n`);
    const readConsent = options['read-consent'] ?? await yes('Разрешить чтение проекта для подготовки плана? [да / нет; Enter — нет]: ');
    output.write(`${paint(output, '38;5;245', 'Ваши правила проекта сохранятся. Flowcairn добавит только слой управления Graph.')}\n`);
    const instructionApi = await import('../scripts/ai-graph/lib/instructions.mjs');
    const assess = Reflect.get(instructionApi, 'assessProjectInstructions');
    if (typeof assess === 'function') {
      const report = assess(root, { instructionManifest: instructionApi.inspectInstructions({projectRoot:root}) });
      if (report.findings.length) output.write(`${paint(output, '38;5;245', 'Нашли существующие AI-правила. Они будут сохранены и учтены.')}\n`);
    }
    const consent = options.consent ?? await yes('Подключить Graph к правилам проекта? [да / нет; Enter — нет]: ');
    return { ...options, provider, model, 'model-mode':mode, ...(reasoning ? {'reasoning-effort':reasoning} : {}), ...review, ...(external ? {'provider-path': external.executable, 'provider-version': external.version} : {}), 'test-policy':testPolicy, coverage, 'check-mode': checkMode, checks: checkMode === 'none' ? '' : discoveredChecks.checks.join(','), ...(trustedLocalConsent ? {'trusted-local-consent': true} : {}), 'read-consent':readConsent, consent };
  } finally { if (!terminal.prompt) prompt.close(); }
}

export function onboardingInput(options, profileHash) {
  return SetupSchema.parse({
    profileHash, provider: options.provider, model: options.model,
    modelMode: options['model-mode'] ?? 'manual', reasoningEffort: options['reasoning-effort'] ?? 'medium',
    ...(options['provider-path'] ? { providerPath: options['provider-path'] } : {}),
    ...(options['provider-version'] ? { providerVersion: options['provider-version'] } : {}),
    ...(options['review-model'] ? { reviewModel: options['review-model'] } : {}),
    ...(options['review-reasoning-effort'] ? { reviewReasoningEffort: options['review-reasoning-effort'] } : {}),
    testPolicy: options['test-policy'] ?? 'keep', coverage: options.coverage === true, readConsent: options['read-consent'] === true,
  });
}

function configuredProfile(previous, value) {
  const { model: _model, reviewModel: _review, modelMode: _mode, reasoningEffort: _effort, reviewReasoningEffort: _reviewEffort, provider: _provider, providerPath: _providerPath, providerVersion: _providerVersion, ...extraAi } = previous.ai;
  return ProjectProfileSchema.parse({ ...previous,
      ai: { ...extraAi, provider:value.provider, model:value.model, modelMode:value.modelMode, reasoningEffort:value.reasoningEffort,
        ...(value.reviewModel ? {reviewModel:value.reviewModel} : {}), ...(value.reviewReasoningEffort ? {reviewReasoningEffort:value.reviewReasoningEffort} : {}),
        ...(value.providerPath ? {providerPath:value.providerPath} : {}), ...(value.providerVersion ? {providerVersion:value.providerVersion} : {}),
      },
      onboarding:{version:1,readConsent:value.readConsent,readScope:'tracked-project',testPolicy:value.testPolicy,coverage:value.coverage,instructions:'preserve'},
    });
}

function sameProfileStructure(previous, next) {
  const { ai: _previousAi, onboarding: _previousOnboarding, ...previousStructure } = previous;
  const { ai: _nextAi, onboarding: _nextOnboarding, ...nextStructure } = next;
  return hashObject(previousStructure) === hashObject(nextStructure);
}

/** Изменение доступно только локальному CLI после остановки исполнителей. */
export async function saveOnboarding(root, input, { dryRun = false } = {}) {
  const value = SetupSchema.parse(input);
  const externalProvider = value.provider === 'claude' || value.provider === 'cursor' ? value.provider : null;
  if (value.provider === 'codex' && process.platform !== 'darwin') fail('PROVIDER_PLATFORM', 'Codex пока поддерживается только на macOS.');
  if (externalProvider && (!value.providerPath || !value.providerVersion || value.modelMode !== 'provider' || value.model !== 'provider-default'))
    fail('PROVIDER_PIN_REQUIRED', 'Claude Code/Cursor используют только проверенный CLI с наследуемой моделью. Повторите setup.');
  if (externalProvider) {
    const probe = probeExternalProvider(externalProvider, { executable: value.providerPath });
    if (!probe.available || probe.version !== value.providerVersion)
      if (probe.reason === 'PROVIDER_AUTH_REQUIRED')
        fail('PROVIDER_AUTH_REQUIRED', `${externalProvider === 'claude' ? 'Claude Code' : 'Cursor'} не авторизован. Войдите в CLI и повторите.`);
    if (!probe.available || probe.version !== value.providerVersion)
      fail('PROVIDER_TOOLCHAIN_INVALID', 'Выбранный CLI изменился или не прошел безопасную проверку. Повторите setup.');
  }
  if (/^(?:sk-|sess-)/i.test(value.model) || /^(?:sk-|sess-)/i.test(value.reviewModel ?? '')) fail('AI_CONFIG', 'Укажите ID модели, не ключ.');
  if (value.modelMode === 'manual' && ((value.reviewModel && value.reviewModel !== value.model) || (value.reviewReasoningEffort && value.reviewReasoningEffort !== value.reasoningEffort))) fail('AI_CONFIG', 'Ручной режим закрепляет одну модель и усиление.');
  if (value.profileHash !== projectProfileHash(root)) fail('ONBOARDING_STALE', 'Профиль изменился. Повторите настройку.');
  if (dryRun) return {created:false,dryRun:true,root,profile:configuredProfile(loadProjectProfile(root),value),changes:['.flowcairn.json','.ai-orchestrator/flowcairn-install.json']};
  const guard = await acquireUninstallGuard({ root });
  try {
    const verifyStoppedGraph = () => ({ ...guard.processProbe(), bindings: guard.graphBindings });
    if (value.profileHash !== projectProfileHash(root) || verifyStoppedGraph().verified !== true) fail('ONBOARDING_STALE', 'Состояние изменилось. Повторите настройку.');
    const profileBefore = readIntegrationTarget(root, '.flowcairn.json');
    const ownerBefore = readIntegrationTarget(root, '.ai-orchestrator/flowcairn-install.json', 1024 * 1024);
    if (!ownerBefore) fail('INIT_REQUIRED', 'Сначала выполните npx flowcairn init.');
    const owner = JSON.parse(ownerBefore.bytes.toString('utf8'));
    if (owner.tool !== 'flowcairn' || !/^flowcairn-[a-f0-9-]+$/.test(owner.owner ?? '')) fail('INSTALL_CONFLICT', 'Владелец установки не подтвержден.');
    const previous = loadProjectProfile(root);
    const profile = configuredProfile(previous, value);
    if (!sameProfileStructure(previous, profile))
      fail('PROFILE_MIGRATION_SCOPE', 'Настройка может менять только AI и onboarding; структурные поля проекта сохранены.');
    const bytes = Buffer.from(JSON.stringify(profile,null,2)+'\n');
    let profileAfter, ownerAfter;
    try {
      // При частичной записи старое согласие перестает подходить новому профилю.
      profileAfter = replaceIntegrationFile(root,'.flowcairn.json',bytes,profileBefore);
      const nextOwner = {...owner,profileHash:sha256(bytes),readConsentHash:value.readConsent ? onboardingConsentHash(root,profile) : null};
      ownerAfter = replaceIntegrationFile(root,'.ai-orchestrator/flowcairn-install.json',Buffer.from(JSON.stringify(nextOwner,null,2)+'\n'),ownerBefore,1024*1024);
      const profileMigration = migrateProjectProfile(root, {
        fromProfileHash: value.profileHash,
        toProfileHash: projectProfileHash(root),
        verifyStoppedGraph,
      });
      return {created:false,root:path.resolve(root),profile,profileMigration,message:'Настройки сохранены. Запуск: npx flowcairn.'};
    } catch (error) {
      // Roll back only bytes still owned by this setup attempt; never replace a concurrent edit.
      try { if (ownerAfter) replaceIntegrationFile(root,'.ai-orchestrator/flowcairn-install.json',ownerBefore.bytes,ownerAfter,1024*1024); } catch { /* Concurrent owner edits remain untouched. */ }
      try { if (profileAfter) replaceIntegrationFile(root,'.flowcairn.json',profileBefore.bytes,profileAfter); } catch { /* Concurrent profile edits remain untouched. */ }
      throw error;
    }
  } finally { guard.release(); }
}
