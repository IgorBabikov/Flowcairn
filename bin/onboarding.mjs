import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { z } from 'zod';
import { GraphError, hashObject, sha256 } from '../scripts/ai-graph/lib/io.mjs';
import { ProjectProfileSchema, loadProjectProfile, projectProfileHash, hasOnboardingConsent, onboardingConsentHash } from '../scripts/ai-graph/lib/project.mjs';
import { defaultProvider } from '../scripts/ai-graph/lib/platform.mjs';
import { acquireUninstallGuard } from '../scripts/ai-graph/lib/lifecycle.mjs';
import { readIntegrationTarget, replaceIntegrationFile } from '../scripts/ai-graph/lib/integration.mjs';
import { migrateProjectProfile } from '../scripts/ai-orchestrator.mjs';

const effort = z.enum(['low', 'medium', 'high', 'xhigh']);
const SetupSchema = z.strictObject({
  profileHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  provider: z.enum(['codex', 'openai']), model: ProjectProfileSchema.shape.ai.shape.model,
  modelMode: z.enum(['manual', 'auto']), reasoningEffort: effort,
  reviewModel: ProjectProfileSchema.shape.ai.shape.model.optional(), reviewReasoningEffort: effort.optional(),
  testPolicy: z.enum(['keep', 'add']), coverage: z.boolean(), readConsent: z.boolean(),
});
const fail = (code, message) => { throw new GraphError(code, message); };

function paint(output, code, text) {
  return output.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text;
}

function step(output, index, title) {
  output.write(`\n${paint(output, '1;38;5;99', `Шаг ${index} из 4`)} ${paint(output, '1', title)}\n`);
}

export function inspectOnboarding(root) {
  let profile;
  try { profile = loadProjectProfile(root); }
  catch (error) { if (error.code !== 'PROJECT_PROFILE_MISSING') throw error; }
  return {
    configured: Boolean(profile && hasOnboardingConsent(root, profile)),
    profileHash: profile ? projectProfileHash(root) : null,
    providers: [
      { id: 'codex', label: 'Codex', supported: process.platform === 'darwin', reason: process.platform === 'darwin' ? null : 'Изолированный исполнитель Codex проверен только на macOS.' },
      { id: 'openai', label: 'OpenAI API', supported: true, reason: null },
      { id: 'claude', label: 'Claude', supported: false, reason: 'Интеграция исполнения пока не реализована.' },
      { id: 'cursor', label: 'Cursor', supported: false, reason: 'Интеграция исполнения пока не реализована.' },
    ],
    values: {
      provider: profile?.ai.provider ?? defaultProvider(), model: profile?.ai.model ?? '',
      modelMode: profile?.ai.modelMode ?? 'manual', reasoningEffort: profile?.ai.reasoningEffort ?? 'medium',
      ...(profile?.ai.reviewModel ? { reviewModel: profile.ai.reviewModel } : {}),
      ...(profile?.ai.reviewReasoningEffort ? { reviewReasoningEffort: profile.ai.reviewReasoningEffort } : {}),
      testPolicy: profile?.onboarding?.testPolicy ?? 'keep', coverage: profile?.onboarding?.coverage ?? false,
      readConsent: Boolean(profile && hasOnboardingConsent(root, profile)),
    },
    limitations: [
      'Модель и усиление задаются здесь явно; настройки AI-клиента не наследуются.',
      'Для исполнения команд проекта нужен Docker. Обход изоляции через host shell не используется.',
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
    output.write(`${paint(output, '38;5;245', 'Ответьте на четыре коротких вопроса. Код не изменится до согласования плана.')}\n`);
    step(output, 1, 'Как Flowcairn будет работать с AI');
    output.write(`${paint(output, '38;5;99', '[1]')} Codex — использовать настроенный Codex\n`);
    output.write(`${paint(output, '38;5;99', '[2]')} OpenAI API — использовать ваш ключ из окружения\n`);
    const providerAnswer = options.provider ?? await ask(`Выбор [${defaultProvider() === 'codex' ? '1' : '2'}]: `, defaultProvider());
    const provider = ({'1':'codex','2':'openai'})[providerAnswer] ?? providerAnswer;
    if (!['codex','openai'].includes(provider)) fail('PROVIDER_UNSUPPORTED', 'Выберите Codex или OpenAI API. Claude и Cursor пока не подключены.');
    if (provider === 'codex' && process.platform !== 'darwin') fail('PROVIDER_PLATFORM', 'Исполнение Codex пока доступно только на macOS.');
    step(output, 2, 'Выберите модель');
    output.write(`${paint(output, '38;5;245', 'Одна модель для всей задачи. Более тонкие настройки доступны позже через npx flowcairn setup.')}\n`);
    output.write(`${paint(output, '38;5;245', 'Укажите название модели, не API-ключ.')}\n`);
    const advanced = options.advanced === true;
    const mode = advanced ? await choice('model-mode', 'Режим: manual — одна модель, auto — модели по этапам [Enter — manual]: ', ['manual','auto'], 'manual') : options['model-mode'] ?? 'manual';
    const model = options.model ?? await ask('ID модели, например gpt-5.6-terra: ', '');
    if (!model) fail('MODEL_REQUIRED', 'Нужен ID модели. Файлы не изменены.');
    const reasoning = advanced ? await choice('reasoning-effort', 'Усиление: low, medium, high или xhigh [Enter — medium]: ', ['low','medium','high','xhigh'], 'medium') : options['reasoning-effort'] ?? 'medium';
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
    step(output, 4, 'Согласуйте границы работы');
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
    return { ...options, provider, model, 'model-mode':mode, 'reasoning-effort':reasoning, ...review, 'test-policy':testPolicy, coverage, 'read-consent':readConsent, consent };
  } finally { if (!terminal.prompt) prompt.close(); }
}

export function onboardingInput(options, profileHash) {
  return SetupSchema.parse({
    profileHash, provider: options.provider, model: options.model,
    modelMode: options['model-mode'] ?? 'manual', reasoningEffort: options['reasoning-effort'] ?? 'medium',
    ...(options['review-model'] ? { reviewModel: options['review-model'] } : {}),
    ...(options['review-reasoning-effort'] ? { reviewReasoningEffort: options['review-reasoning-effort'] } : {}),
    testPolicy: options['test-policy'] ?? 'keep', coverage: options.coverage === true, readConsent: options['read-consent'] === true,
  });
}

function configuredProfile(previous, value) {
  const { model: _model, reviewModel: _review, modelMode: _mode, reasoningEffort: _effort, reviewReasoningEffort: _reviewEffort, provider: _provider, ...extraAi } = previous.ai;
  return ProjectProfileSchema.parse({ ...previous,
      ai: { ...extraAi, provider:value.provider, model:value.model, modelMode:value.modelMode, reasoningEffort:value.reasoningEffort,
        ...(value.reviewModel ? {reviewModel:value.reviewModel} : {}), ...(value.reviewReasoningEffort ? {reviewReasoningEffort:value.reviewReasoningEffort} : {}),
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
  if (value.provider === 'codex' && process.platform !== 'darwin') fail('PROVIDER_PLATFORM', 'Codex пока поддерживается только на macOS.');
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
