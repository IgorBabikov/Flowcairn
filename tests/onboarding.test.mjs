import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initializeProject, printInitialization } from '../bin/flowcairn.mjs';
import { inspectCodexInstallation } from '../scripts/ai-graph/lib/runner.mjs';
import { codexModelSettings } from '../scripts/ai-graph/lib/codex-settings.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-onboarding-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('/usr/bin/git', ['init', '--initial-branch=main', root], { stdio: 'ignore' });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({name:'fixture',scripts:{test:'node --test',build:'node build.mjs'}}));
  writeFileSync(path.join(root, 'AGENTS.md'), 'Правила владельца');
  return root;
}

function requireVerifiedCodex(t) {
  if (process.platform !== 'darwin') {
    t.skip('Исполнение Codex ограничено macOS.');
    return false;
  }
  if (!inspectCodexInstallation().available) {
    t.skip('Codex CLI не установлен или не прошел проверку в этой test-среде.');
    return false;
  }
  return true;
}

function simulatedCursor(root) {
  const executable = path.join(root, 'cursor-agent');
  writeFileSync(executable, '#!/bin/sh\nfor argument in "$@"; do\n  [ "$argument" = "--version" ] && { printf "fixture-cursor 1.0\\n"; exit 0; }\n  [ "$argument" = "--help" ] && { printf "%s\\n" "--print --output-format --sandbox --mode"; exit 0; }\ndone\n[ "$1" = "status" ] && { printf "{\\"authenticated\\":true}\\n"; exit 0; }\nprintf \'{"result":"{\\"summary\\":\\"ok\\"}"}\\n\'\n');
  chmodSync(executable, 0o700);
  return executable;
}
const testClaude = path.resolve('tests/fixtures/verified-claude/node_modules/@anthropic-ai/claude-code/bin/claude.exe');
const options = {provider:'claude', 'provider-path':testClaude, 'workspace-mode':'worktree', 'model-mode':'provider', 'reasoning-effort':'high', 'test-policy':'keep', 'read-consent':true};

test('явный onboarding сохраняет проверенный CLI и политику без навязанного coverage', t => {
  const root = fixture(t);
  const result = initializeProject(root, options);
  assert.deepEqual(result.profile.onboarding, {version:1,readConsent:true,readScope:'tracked-project',testPolicy:'keep',coverage:false,instructions:'preserve'});
  assert.equal(result.profile.ai.modelMode, 'provider');
  assert.equal(result.profile.ai.reasoningEffort, 'high');
  assert.deepEqual(result.profile.checks, []);
  assert.equal(result.profile.checkMode, 'none');
  assert.equal(readFileSync(path.join(root,'AGENTS.md'),'utf8'),'Правила владельца');
});

test('старый init не предоставляет разрешение на чтение автоматически', t => {
  const result = initializeProject(fixture(t), {...options, 'read-consent':false});
  assert.notEqual(result.profile.onboarding?.readConsent, true);
});

test('Codex init без ID модели сохраняет выбор из самого Codex', t => {
  if (!requireVerifiedCodex(t)) return;
  try { codexModelSettings(); }
  catch {
    t.skip('В CLI Codex не заданы одновременно модель и уровень усилия.');
    return;
  }
  const result = initializeProject(fixture(t), {provider:'codex'});
  assert.equal(result.profile.ai.model, 'provider-default');
  assert.equal(result.profile.ai.modelMode, 'provider');
});

test('неинтерактивный Codex init проверяет модель и отдельную авторизацию до записи профиля', async t => {
  if (!requireVerifiedCodex(t)) return;
  const configHome = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-codex-config-')));
  const previousConfigHome = process.env.CODEX_HOME;
  t.after(() => {
    if (previousConfigHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousConfigHome;
    rmSync(configHome, { recursive: true, force: true });
  });
  process.env.CODEX_HOME = configHome;
  writeFileSync(path.join(configHome, 'config.toml'), 'model = "gpt-5.6-sol"\nmodel_reasoning_effort = "high"\n');
  const unauthenticatedHome = fixture(t);
  assert.throws(() => initializeProject(unauthenticatedHome, {provider:'codex'}), {code:'RUNNER_TOOLCHAIN_INVALID'});
  assert.equal(existsSync(path.join(unauthenticatedHome,'.flowcairn.json')), false);

  writeFileSync(path.join(configHome, 'config.toml'), 'model = "gpt-5.6-sol"\n');
  const blocked = fixture(t);
  assert.throws(() => initializeProject(blocked, {provider:'codex'}), {code:'CODEX_MODEL_SETTINGS_REQUIRED'});
  assert.equal(existsSync(path.join(blocked,'.flowcairn.json')), false);
  assert.equal(existsSync(path.join(blocked,'.ai-orchestrator')), false);

  writeFileSync(path.join(configHome, 'config.toml'), 'model = "gpt-5.6-sol"\nmodel_reasoning_effort = "high"\n');
  const unavailable = fixture(t);
  assert.throws(() => initializeProject(unavailable, {provider:'codex','codex-path':path.join(unavailable,'missing-codex')}), {code:'RUNNER_TOOLCHAIN_INVALID'});
  assert.equal(existsSync(path.join(unavailable,'.flowcairn.json')), false);
});

test('итог первого запуска говорит о следующем шаге без технической сводки', () => {
  let text = '';
  const original = process.stdout.write;
  process.stdout.write = (value) => { text += value; return true; };
  try {
    printInitialization({
      dryRun: false,
      profile: { checks: ['lint', 'tests'] },
      checkPreparation: { prepared: false, reason: 'DECLINED' },
    });
  } finally {
    process.stdout.write = original;
  }
  assert.match(text, /Готово\. Flowcairn подготовлен/);
  assert.match(text, /Опишите задачу обычным языком/);
  assert.doesNotMatch(text, /Ветка:|Менеджер:|Docker/);
});

test('непроверенный CLI и удаленный API provider не создают профиль', t => {
  const root = fixture(t);
  for (const provider of ['claude','cursor']) assert.throws(() => initializeProject(root,{...options,provider,'provider-path':path.join(root,'missing-cli')}), {code:'PROVIDER_TOOLCHAIN_INVALID'});
  assert.throws(() => initializeProject(root,{provider:'openai',model:'test-model'}), {code:'PROVIDER_UNSUPPORTED'});
  assert.equal(existsSync(path.join(root,'.flowcairn.json')),false);
});

test('Cursor проходит выбор и preflight в чистом проекте с проверенным CLI', async t => {
  const root = fixture(t);
  const executable = simulatedCursor(root);
  const result = initializeProject(root, {provider:'cursor', 'provider-path':executable});
  assert.equal(result.profile.ai.provider, 'cursor');
  assert.equal(result.profile.ai.model, 'provider-default');
  assert.equal(result.profile.ai.providerPath, executable);
  assert.equal(result.profile.ai.providerVersion, 'fixture-cursor 1.0');
  const { probeRunner } = await import('../scripts/ai-graph/lib/runner.mjs');
  const preflight = await probeRunner({root});
  if (process.env.GITHUB_ACTIONS === 'true' && preflight.ai.reason === 'RUNNER_TOOLCHAIN_VERSION') {
    t.skip('GitHub-hosted Node не проходит fail-closed проверку происхождения; выбор и version pin Cursor уже проверены выше.');
    return;
  }
  assert.equal(preflight.ai.available, true, preflight.ai.reason);
});

test('Claude и Cursor доступны только после local capability probe', async t => {
  const { inspectOnboarding } = await import('../bin/onboarding.mjs');
  const previousPath = process.env.PATH;
  process.env.PATH = '';
  let status;
  try { status = inspectOnboarding(fixture(t)); }
  finally { process.env.PATH = previousPath; }
  assert.deepEqual(status.providers.map((item) => item.id), ['codex', 'claude', 'cursor']);
  for (const id of ['claude', 'cursor']) {
    const provider = status.providers.find((item) => item.id === id);
    assert.equal(provider.supported, false);
    assert.notEqual(provider.state, 'available');
    assert.match(provider.reason, /не найден|безопасную проверку/i);
  }
});

test('устаревший OpenAI API-профиль не запускается и требует смены CLI', async t => {
  const root = fixture(t);
  initializeProject(root, options);
  const { loadProjectProfile } = await import('../scripts/ai-graph/lib/project.mjs');
  const legacy = loadProjectProfile(root);
  legacy.ai = { provider: 'openai', model: 'legacy-model' };
  writeFileSync(path.join(root, '.flowcairn.json'), JSON.stringify(legacy));
  const { probeRunner } = await import('../scripts/ai-graph/lib/runner.mjs');
  assert.deepEqual((await probeRunner({root})).ai, { available: false, reason: 'PROVIDER_RETIRED' });
});

test('согласие привязано к локальной установке и AI-конфигурации', async t => {
  const root = fixture(t);
  const {hasOnboardingConsent,loadProjectProfile} = await import('../scripts/ai-graph/lib/project.mjs');
  assert.equal(typeof hasOnboardingConsent,'function');
  initializeProject(root,options);
  assert.equal(hasOnboardingConsent(root),true);
  const profile = loadProjectProfile(root);
  profile.ai.model='changed-model';
  writeFileSync(path.join(root,'.flowcairn.json'),JSON.stringify(profile));
  assert.equal(hasOnboardingConsent(root),false);
  const clone = fixture(t);
  writeFileSync(path.join(clone,'.flowcairn.json'),JSON.stringify(profile));
  initializeProject(clone);
  assert.equal(hasOnboardingConsent(clone),false);
});

test('опрос Claude фиксирует только явное согласие и использует проверенный CLI', async t => {
  const root = fixture(t);
  const api = await import('../bin/onboarding.mjs').catch(() => ({}));
  assert.equal(typeof api.collectOnboarding,'function');
  const replies = ['keep','нет','none','нет','нет'];
  let text='';
  const result=await api.collectOnboarding(root, {provider:'claude','provider-path':testClaude,advanced:true}, {input:{isTTY:true},output:{isTTY:true,write:value=>{text+=value;}},prompt:{question:async()=>replies.shift()}});
  assert.equal(result['read-consent'],false);
  assert.equal(result.model,'provider-default');
  assert.equal(result['reasoning-effort'],undefined);
  assert.equal(result.coverage,false);
  assert.match(text,/Claude Code — использовать выбранный CLI/);
  assert.doesNotMatch(text,/Режим: provider/);
  assert.match(text,/Шаг 1 из 5/);
  assert.match(text,/Шаг 5 из 5/);
  assert.match(text,/\x1b\[/);
  assert.doesNotMatch(text,/Codex — macOS/);
  assert.equal(existsSync(path.join(root,'.flowcairn.json')),false);
});

test('setup переводит устаревший API-профиль на Claude без ручного выбора модели', async t => {
  const root = fixture(t);
  initializeProject(root, options);
  const { loadProjectProfile } = await import('../scripts/ai-graph/lib/project.mjs');
  const legacy = loadProjectProfile(root);
  legacy.ai = { provider: 'openai', model: 'legacy-model' };
  const legacyBytes = `${JSON.stringify(legacy, null, 2)}\n`;
  writeFileSync(path.join(root, '.flowcairn.json'), legacyBytes);
  const ownerPath = path.join(root, '.ai-orchestrator/flowcairn-install.json');
  const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
  const { sha256 } = await import('../scripts/ai-graph/lib/io.mjs');
  owner.profileHash = sha256(legacyBytes);
  writeFileSync(ownerPath, `${JSON.stringify(owner, null, 2)}\n`);
  const { setupCommand } = await import('../bin/flowcairn.mjs');
  const replies = ['keep', 'нет', 'none', 'нет', 'нет'];
  let text = '';
  const result = await setupCommand(root, { provider: 'claude', 'provider-path':testClaude }, {
    input: { isTTY: true }, output: { isTTY: true, write: (value) => { text += value; } }, prompt: { question: async () => replies.shift() },
  });
  assert.equal(result.profile.ai.provider, 'claude');
  assert.equal(result.profile.ai.modelMode, 'provider');
  assert.equal(result.profile.ai.model, 'provider-default');
  assert.doesNotMatch(text, /Режим: provider|ID модели/);
});

test('повторная настройка требует свежий fingerprint и остановленный runtime', async t => {
  const root=fixture(t);
  const api=await import('../bin/onboarding.mjs').catch(()=>({}));
  assert.equal(typeof api.saveOnboarding,'function');
  initializeProject(root,options);
  const current=api.inspectOnboarding(root);
  const config={profileHash:current.profileHash,provider:'claude',providerPath:testClaude,providerVersion:'2.1.198 (Claude Code)',model:'provider-default',modelMode:'provider',reasoningEffort:'medium',testPolicy:'keep',coverage:false,readConsent:true};
  await assert.rejects(api.saveOnboarding(root,{...config,profileHash:'0'.repeat(64)}),{code:'ONBOARDING_STALE'});
  const {acquireRuntimeLease}=await import('../scripts/ai-graph/lib/lifecycle.mjs');
  const release=acquireRuntimeLease({root,kind:'viewer'});
  try {await assert.rejects(api.saveOnboarding(root,config),{code:'UNINSTALL_PROCESS_ACTIVE'});} finally {release();}
  await api.saveOnboarding(root,config);
  assert.equal(api.inspectOnboarding(root).configured,true);
});

test('setup сохраняет выбранные проверки и требует отдельное согласие trusted-local', async t => {
  const root = fixture(t);
  const { onboardingInput, inspectOnboarding, saveOnboarding } = await import('../bin/onboarding.mjs');
  initializeProject(root, options);
  const choice = { ...options, model: 'provider-default', 'provider-version': '2.1.198 (Claude Code)',
    'check-mode': 'trusted-local', checks: 'tests,build' };
  const input = onboardingInput(choice, inspectOnboarding(root).profileHash);
  assert.equal(input.checkMode, 'trusted-local');
  await assert.rejects(saveOnboarding(root, input), { code: 'CHECK_LOCAL_CONSENT' });
  const enabled = await saveOnboarding(root, { ...input, trustedLocalConsent: true });
  assert.equal(enabled.profile.checkMode, 'trusted-local');
  assert.deepEqual(enabled.profile.checks, ['tests', 'build']);
  assert.deepEqual(enabled.profile.checkScripts, { tests: 'test', build: 'build' });
  const disabled = await saveOnboarding(root, { ...input, profileHash: inspectOnboarding(root).profileHash, checkMode: 'none', checks: [] });
  assert.equal(disabled.profile.checkMode, 'none');
  assert.deepEqual(disabled.profile.checks, []);
  assert.deepEqual(disabled.profile.checkScripts, {});
  await assert.rejects(saveOnboarding(root, { ...input, profileHash: inspectOnboarding(root).profileHash, checkMode: 'hardened', checks: ['lint'] }), { code: 'CHECK_SCRIPT_MISSING' });
});

test('явная активация добавляет Graph-блок и сохраняет пользовательские инструкции', async t => {
  const root=fixture(t);
  const {initializeCommand}=await import('../bin/flowcairn.mjs');
  await initializeCommand(root,{...options,consent:true,json:true});
  const text=readFileSync(path.join(root,'AGENTS.md'),'utf8');
  assert.ok(text.startsWith('Правила владельца'));
  assert.match(text,/FLOWCAIRN:WORKFLOW-START/);
});

test('setup dry-run показывает изменение без записи профиля и локального согласия', async t => {
  const root=fixture(t);
  const {setupCommand}=await import('../bin/flowcairn.mjs');
  initializeProject(root,options);
  const before=readFileSync(path.join(root,'.flowcairn.json'));
  const owner=readFileSync(path.join(root,'.ai-orchestrator/flowcairn-install.json'));
  const preview=await setupCommand(root,{...options,'dry-run':true});
  assert.equal(preview.profile.ai.model,'provider-default');
  assert.equal(preview.dryRun,true);
  assert.deepEqual(readFileSync(path.join(root,'.flowcairn.json')),before);
  assert.deepEqual(readFileSync(path.join(root,'.ai-orchestrator/flowcairn-install.json')),owner);
  assert.equal(existsSync(path.join(root,'.ai-orchestrator/lifecycle-uninstall.lock')),false);
});

test('обычная настройка не запускает scripts проекта и не готовит Docker', async t => {
  const root = fixture(t);
  const { maybePrepareChecks } = await import('../bin/flowcairn.mjs');
  const profile = initializeProject(root, options).profile;
  let prepared = 0;
  const checks = {
    probe: () => ({ available: false, reason: 'CHECK_IMAGE_MISSING' }),
    prepare: () => { prepared += 1; return { imageId: 'sha256:abc', hash: 'a'.repeat(64) }; },
  };
  const result = await maybePrepareChecks(root, profile, {}, {
    input: { isTTY: true }, output: { isTTY: true, write() {} }, prompt: { question: async () => 'да' },
  }, checks);
  assert.deepEqual(result, { prepared: false, reason: 'NOT_NEEDED' });
  assert.equal(prepared, 0);
});

test('handoff открывает проверенный результат для личного ревью без автоматического принятия', async () => {
  const { canHandoff } = await import('../bin/flowcairn.mjs');
  const snapshot = { status: 'passed', integrity: { valid: true }, finalDisposition: null };
  assert.equal(canHandoff(snapshot, { completion: 'ready-for-review' }), true);
  assert.equal(canHandoff({ ...snapshot, integrity: { valid: false } }, { completion: 'ready-for-review' }), false);
  assert.equal(canHandoff({ ...snapshot, status: 'failed' }, { completion: 'ready-for-review' }), false);
  assert.equal(canHandoff(snapshot, { completion: null }), false);
});
