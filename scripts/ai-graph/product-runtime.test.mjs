import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskSpecSchema } from './lib/schemas.mjs';
import { compilePlanningPlan, compileTaskProposal } from './lib/planning.mjs';
import { validatePlan } from './lib/validator.mjs';
import { SKILL_ROUTES } from './lib/config.mjs';
import { hashObject } from './lib/io.mjs';
const hash = hashObject('product-runtime-fixture');
const skills = [...new Set(Object.values(SKILL_ROUTES).flat())].map(id => ({id,path:`skills/${id}/SKILL.md`,hash}));
const context = {runtimeHash:hash,skills,workflow:'autonomous'};
const task = TaskSpecSchema.parse({id:'TASK-PRODUCT',goal:'Форма регистрации',instructions:'Добавить проверку email',scope:['src'],acceptance:['Неверный email отклонен'],checks:['tests'],schemaVersion:2,sourceHash:hash});
const output = {summary:'План формы',verdict:'pass',skillsUsed:[],findings:[],changedFiles:[],edits:[],plan:[],steps:[{id:'form',title:'Проверка формы',outcome:'Неверный email отклонен',needs:[],paths:['src/form.mjs']}]};
test('product planning выполняет анализ перед планом без пользовательского gate', () => {
 const plan=compilePlanningPlan(task,context).plan;
 assert.equal(plan.workflow,'autonomous');
 assert.deepEqual(plan.nodes.map(n=>n.action.id),['ai-analyze','ai-plan','artifact-handoff']);
 assert.deepEqual(plan.nodes.find(n=>n.action.id==='ai-plan').needs,['analyze']);
 assert.ok(plan.nodes.every(n=>n.permissions.every(p=>p==='ai.read')));
});
test('product execution требует одно согласование и заканчивается проверенным handoff',()=>{
 const plan=compileTaskProposal(task,output,context).plan;
 assert.equal(plan.workflow,'autonomous');
 assert.equal(plan.nodes.filter(n=>n.success.kind==='gate').length,1);
 assert.equal(plan.nodes.at(-1).action.id,'artifact-handoff');
 assert.equal(plan.autonomy.maxRepairCycles,2);
 const tampered=structuredClone(plan); tampered.nodes=plan.nodes.filter(n=>n.action.id!=='check-tests');
 assert.throws(()=>validatePlan(tampered,task,context));
});

import { WorkflowService } from './lib/service.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const request=(s,extra={})=>({operationId:`op-${randomUUID()}`,expectedRevision:s.revision,planHash:s.planHash,...extra});
const analysis={requirements:['Валидация email'],constraints:['Сохранить интерфейс'],projectFacts:[{path:'src/form.mjs',fact:'Форма уже существует'}],acceptance:['Неверный email отклонен'],risks:[]};
async function fixture(t,{consent=true,reviewFails=0,checkFails=0,uncertain=false}={}) {
 const root=mkdtempSync(path.join(os.tmpdir(),'flowcairn-product-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const calls=[]; let reviews=0,checks=0;
 const fingerprint=()=>({hash,files:[],git:{head:'a'.repeat(40),indexHash:hash}});
 const adapters={identity:()=>hash,skills:()=>skills,hasReadConsent:()=>consent,
 capture:()=>({manifest:{sourceHash:hash},bundlePath:'fixture-source'}),
 allocate:({task,runId})=>({worktree:root,taskId:task.id,attemptId:1,leaseId:'fixture',sourceHash:hash,runId}),
 verifyBinding:()=>true,replaceBinding:({binding,newRunId})=>({...binding,runId:newRunId}),fingerprint,
 inspectChanges:()=>({allowed:true,changedFiles:[]}),applyEdits:()=>{},diff:()=>({content:'',complete:true}),
 runner:{ai:{available:true},checks:{available:true}},loadSkills:ids=>ids.map(name=>({name,text:'fixture',hash,path:`skills/${name}/SKILL.md`})),
 projectSummary:()=>({schemaVersion:2,name:'fixture',contextHash:hash,contextPaths:[],scopeCandidates:['src'],checks:['tests'],ai:{provider:'codex',model:'fixture'},capabilities:{intake:{allowed:true}}}),
 registerTask:async(_root,input,options)=>options.service.create(input,{runId:options.run,operationId:options.operation,stage:options.stage,workflow:options.workflow,naturalIntakeHash:options.naturalIntakeHash}),
 execute:async({node,onStart,priorEvidence,reviewEvidence,task})=>{
  calls.push({action:node.action.id,priorEvidence,reviewEvidence,task});await onStart({ticket:'fixture',pid:process.pid});
  if(node.action.id==='check-tests')return {exitCode:checks++<checkFails?1:0,stopped:true,uncertain:false};
  const fail=node.action.id==='ai-review' && reviews++<reviewFails;
  return {exitCode:0,stopped:true,uncertain:false,output:{...output,steps:undefined,verdict:uncertain&&node.action.id==='ai-analyze'?'uncertain':fail?'fail':'pass',skillsUsed:node.skills,findings:fail?[{severity:'blocking',message:'Неверный email принят',path:'src/form.mjs'}]:[],...(node.action.id==='ai-plan'?{steps:output.steps}:{}),...(node.action.id==='ai-analyze'?{analysis}:{}),...(reviewEvidence?{reviewEvidenceHash:hashObject(reviewEvidence)}:{})}};
 }
 };
 // optional fields не включаются в strict JSON fixture.
 const execute=adapters.execute;adapters.execute=async(args)=>{const r=await execute(args);if(r.output && r.output.steps===undefined)delete r.output.steps;return r;};
 const service=await WorkflowService.open({root,adapters});
 const intake=()=>service.intake({title:'Форма регистрации',description:'Добавить проверку email',taskNumber:'ФОРМА-12',operationId:'intake-product',contextHash:hash});
 const settle=async(s)=>{for(let i=0;i<8;i++){await Promise.all([...service.drives.values()]);s=service.snapshot(s.runId);if(s.successorRunId){s=service.snapshot(s.successorRunId);continue;}return s;}throw Error('too many transitions');};
 const approve=s=>service.command(s.runId,'gate',request(s,{nodeId:'approve-plan',decision:'approve',permissions:s.gates[0].requiredPermissions,challenge:s.gates[0].challenge}));
 return {service,intake,settle,approve,calls};
}
test('product intake требует локальное согласие и не принимает browser scope',async(t)=>{
 const f=await fixture(t,{consent:false});await assert.rejects(f.intake(),e=>e.code==='ONBOARDING_REQUIRED');assert.equal(f.calls.length,0);
 await assert.rejects(f.service.intake({title:'Форма',description:'Добавить email',taskNumber:'1',operationId:'intake-bad',contextHash:hash,scope:['private']}));
});
test('анализ передается полностью, план уточняется без повторного анализа, одного согласования достаточно',async(t)=>{
 const f=await fixture(t);const initial=await f.intake();let s=await f.settle(initial);
 assert.equal(s.status,'waiting-for-human');assert.equal(s.phase,'execution');
 assert.deepEqual(f.calls.map(c=>c.action),['ai-analyze','ai-plan']);
 assert.deepEqual(f.calls[1].priorEvidence.analysis.result.analysis,analysis);
 const oldHash=s.planHash;
 s=await f.service.command(s.runId,'revise-plan',request(s,{feedback:'Добавить кнопку показать пароль'}));s=await f.settle(s);
 assert.notEqual(s.planHash,oldHash);assert.deepEqual(s.task.planningFeedback,['Добавить кнопку показать пароль']);
 assert.deepEqual(f.calls.map(c=>c.action),['ai-analyze','ai-plan','ai-plan']);
 assert.equal(s.capabilities.revisePlan.allowed,true);
 s=await f.approve(s);s=await f.settle(s);
 assert.equal(s.status,'passed');assert.equal(s.completion,'ready-for-review');assert.equal(s.finalDisposition,null);assert.equal(s.gates.length,0);
 assert.deepEqual(f.calls.map(c=>c.action),['ai-analyze','ai-plan','ai-plan','ai-implement','check-tests','ai-review']);
 assert.equal(f.service.snapshot(initial.runId).planHash,initial.planHash);
});
for(const failure of ['review','check'])test(`${failure}: bounded policy исправляет без нового human approval`,async(t)=>{
 const f=await fixture(t,{reviewFails:failure==='review'?1:0,checkFails:failure==='check'?1:0});let s=await f.settle(await f.intake());const approvedId=s.runId;
 s=await f.approve(s);s=await f.settle(s);
 assert.equal(s.status,'passed',JSON.stringify({failure:s.failureReason,nodes:s.nodes.map(n=>({id:n.id,status:n.status,reason:n.reason}))}));assert.notEqual(s.runId,approvedId);
 const state=f.service.store.readRun(s.runId);assert.equal(state.policyGrant.runId,approvedId);assert.equal(state.policyGrant.cycle,1);
 const receipt=f.service.store.readObject('receipts',state.nodes['approve-plan'].receipts[0]);assert.equal(receipt.phase,'policy');assert.equal(receipt.actor,'approved-repair-policy');
 const finalReview=f.calls.filter(c=>c.action==='ai-review').at(-1).reviewEvidence;
 assert.equal(finalReview.previousExecutions.length,1);assert.equal(finalReview.previousExecutions[0].evidence.runId,approvedId);
 assert.ok(finalReview.previousExecutions[0].evidence.implementations.length>0);
});
test('повторный review failure останавливается после двух исправлений',async(t)=>{
 const f=await fixture(t,{reviewFails:9});let s=await f.settle(await f.intake());s=await f.approve(s);s=await f.settle(s);
 assert.equal(s.status,'failed');assert.equal(f.service.store.readRun(s.runId).policyGrant.cycle,2);assert.equal(f.calls.filter(c=>c.action==='ai-review').length,3);
 const state=f.service.store.readRun(s.runId);
 f.service.store.updateRun(s.runId,state.revision,current=>({...current,policyGrant:{...current.policyGrant,cycle:1}}));
 assert.equal(f.service.snapshot(s.runId).integrity.valid,false,'понижение счетчика должно нарушать integrity');
});
test('uncertain analysis останавливается, план и реализация не запускаются',async(t)=>{
 const f=await fixture(t,{uncertain:true});let s=await f.settle(await f.intake());assert.equal(s.status,'uncertain');assert.deepEqual(f.calls.map(c=>c.action),['ai-analyze']);
});

test('истекший общий срок не запускает implementation даже после согласования',async(t)=>{
 const f=await fixture(t);let s=await f.settle(await f.intake());
 s=await f.approve(s);
 const elapsed=Date.now()+1800001;
 t.mock.method(Date,'now',()=>elapsed);
 s=await f.settle(s);
 assert.equal(s.completion,null);assert.equal(f.calls.filter(c=>c.action==='ai-implement').length,0);
 assert.equal(s.capabilities.run.allowed,false);
});

test('после перезапуска готовый read-only анализ продолжается, implementation ждет согласия',async(t)=>{
 const f=await fixture(t);
 const created=await f.service.create({id:'TASK-RESUME',goal:'Форма',instructions:'Проверить email',scope:['src'],acceptance:['Email отклонен'],checks:['tests']},{runId:'resume-product',workflow:'autonomous',stage:'planning'});
 assert.equal(f.service.close(),true);
 const reopened=await WorkflowService.open({root:f.service.root,adapters:f.service.adapters});
 await Promise.all([...reopened.drives.values()]);
 const previous=reopened.snapshot(created.runId);assert.ok(previous.successorRunId);
 const next=reopened.snapshot(previous.successorRunId);assert.equal(next.status,'waiting-for-human');
 assert.deepEqual(f.calls.map(c=>c.action),['ai-analyze','ai-plan']);assert.equal(reopened.close(),true);
});
