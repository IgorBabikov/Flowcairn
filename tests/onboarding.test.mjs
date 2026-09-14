import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initializeProject } from '../bin/flowcairn.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-onboarding-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('/usr/bin/git', ['init', '--initial-branch=main', root], { stdio: 'ignore' });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({name:'fixture',scripts:{test:'node --test',build:'node build.mjs'}}));
  writeFileSync(path.join(root, 'AGENTS.md'), 'Правила владельца');
  return root;
}
const options = {provider:'openai', model:'test-model', 'model-mode':'manual', 'reasoning-effort':'high', 'test-policy':'keep', 'read-consent':true};

test('явный onboarding сохраняет разрешение, ручную модель и политику без навязанного coverage', t => {
  const root = fixture(t);
  const result = initializeProject(root, options);
  assert.deepEqual(result.profile.onboarding, {version:1,readConsent:true,readScope:'tracked-project',testPolicy:'keep',coverage:false,instructions:'preserve'});
  assert.equal(result.profile.ai.modelMode, 'manual');
  assert.equal(result.profile.ai.reasoningEffort, 'high');
  assert.deepEqual(result.profile.checks, ['tests','build']);
  assert.equal(readFileSync(path.join(root,'AGENTS.md'),'utf8'),'Правила владельца');
});

test('старый init не предоставляет разрешение на чтение автоматически', t => {
  const result = initializeProject(fixture(t), {provider:'openai',model:'test-model'});
  assert.notEqual(result.profile.onboarding?.readConsent, true);
});

test('неподдерживаемый провайдер и противоречивый ручной режим не создают профиль', t => {
  const root = fixture(t);
  for (const provider of ['claude','cursor']) assert.throws(() => initializeProject(root,{...options,provider}), {code:'PROVIDER_UNSUPPORTED'});
  assert.throws(() => initializeProject(root,{...options,'review-model':'other-model'}), {code:'AI_CONFIG'});
  assert.equal(existsSync(path.join(root,'.flowcairn.json')),false);
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

test('опрос фиксирует только явное согласие и не наследует модель из IDE', async t => {
  const root = fixture(t);
  const api = await import('../bin/onboarding.mjs').catch(() => ({}));
  assert.equal(typeof api.collectOnboarding,'function');
  const replies = ['openai','manual','my-model','high','keep','нет','нет','нет'];
  let text='';
  const result=await api.collectOnboarding(root, {advanced:true}, {input:{isTTY:true},output:{isTTY:true,write:value=>{text+=value;}},prompt:{question:async()=>replies.shift()}});
  assert.equal(result['read-consent'],false);
  assert.equal(result.model,'my-model');
  assert.equal(result['reasoning-effort'],'high');
  assert.equal(result.coverage,false);
  assert.match(text,/Настройки.*не наследуются/);
  assert.equal(existsSync(path.join(root,'.flowcairn.json')),false);
});

test('повторная настройка требует свежий fingerprint и остановленный runtime', async t => {
  const root=fixture(t);
  const api=await import('../bin/onboarding.mjs').catch(()=>({}));
  assert.equal(typeof api.saveOnboarding,'function');
  initializeProject(root,{provider:'openai',model:'test-model'});
  const current=api.inspectOnboarding(root);
  const config={profileHash:current.profileHash,provider:'openai',model:'test-model',modelMode:'manual',reasoningEffort:'high',testPolicy:'keep',coverage:false,readConsent:true};
  await assert.rejects(api.saveOnboarding(root,{...config,profileHash:'0'.repeat(64)}),{code:'ONBOARDING_STALE'});
  const {acquireRuntimeLease}=await import('../scripts/ai-graph/lib/lifecycle.mjs');
  const release=acquireRuntimeLease({root,kind:'viewer'});
  try {await assert.rejects(api.saveOnboarding(root,config),{code:'UNINSTALL_PROCESS_ACTIVE'});} finally {release();}
  await api.saveOnboarding(root,config);
  assert.equal(api.inspectOnboarding(root).configured,true);
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
  const preview=await setupCommand(root,{...options,model:'next-model','dry-run':true});
  assert.equal(preview.profile.ai.model,'next-model');
  assert.equal(preview.dryRun,true);
  assert.deepEqual(readFileSync(path.join(root,'.flowcairn.json')),before);
  assert.deepEqual(readFileSync(path.join(root,'.ai-orchestrator/flowcairn-install.json')),owner);
  assert.equal(existsSync(path.join(root,'.ai-orchestrator/lifecycle-uninstall.lock')),false);
});

test('Docker-проверки готовятся только после явного согласия в первом запуске', async t => {
  const root = fixture(t);
  const { maybePrepareChecks } = await import('../bin/flowcairn.mjs');
  const profile = initializeProject(root, options).profile;
  let prepared = 0;
  const checks = {
    probe: () => ({ available: false, reason: 'CHECK_IMAGE_MISSING' }),
    prepare: () => { prepared += 1; return { imageId: 'sha256:abc', hash: 'a'.repeat(64) }; },
  };
  const declined = await maybePrepareChecks(root, profile, {}, {
    input: { isTTY: true }, output: { isTTY: true, write() {} }, prompt: { question: async () => 'нет' },
  }, checks);
  assert.equal(declined.prepared, false);
  assert.equal(prepared, 0);
  const accepted = await maybePrepareChecks(root, profile, {}, {
    input: { isTTY: true }, output: { isTTY: true, write() {} }, prompt: { question: async () => 'да' },
  }, checks);
  assert.equal(accepted.prepared, true);
  assert.equal(prepared, 1);
});

test('handoff открывает проверенный результат для личного ревью без автоматического принятия', async () => {
  const { canHandoff } = await import('../bin/flowcairn.mjs');
  const snapshot = { status: 'passed', integrity: { valid: true }, finalDisposition: null };
  assert.equal(canHandoff(snapshot, { completion: 'ready-for-review' }), true);
  assert.equal(canHandoff({ ...snapshot, integrity: { valid: false } }, { completion: 'ready-for-review' }), false);
  assert.equal(canHandoff({ ...snapshot, status: 'failed' }, { completion: 'ready-for-review' }), false);
  assert.equal(canHandoff(snapshot, { completion: null }), false);
});
