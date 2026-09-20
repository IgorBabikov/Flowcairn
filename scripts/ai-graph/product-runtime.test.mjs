import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskSpecSchema } from './lib/schemas.mjs';
import { compilePlanningPlan, compileTaskProposal } from './lib/planning.mjs';
import { validatePlan } from './lib/validator.mjs';
import { validateReviewEvidence } from './lib/review-evidence.mjs';
import { SKILL_ROUTES } from './lib/config.mjs';
import { GraphError, hashObject } from './lib/io.mjs';
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
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const request=(s,extra={})=>({operationId:`op-${randomUUID()}`,expectedRevision:s.revision,planHash:s.planHash,...extra});
const analysis={requirements:['Валидация email'],constraints:['Сохранить интерфейс'],projectFacts:[{path:'src/form.mjs',fact:'Форма уже существует'}],acceptance:['Неверный email отклонен'],risks:[]};
async function fixture(t,{consent=true,reviewFails=0,implementationFails=0,checkFails=0,uncertain=false,plannerUncertain=0,plannerFailures=0,steps=output.steps,maxReplans=2,scopeCandidates=['src']}={}) {
 const root=mkdtempSync(path.join(os.tmpdir(),'flowcairn-product-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const worktree=path.join(root,'.ai-orchestrator','worktrees','fixture-1');
 mkdirSync(worktree,{recursive:true,mode:0o700});
 const calls=[]; let reviews=0,implementations=0,checks=0,remainingPlannerUncertainty=plannerUncertain,remainingPlannerFailures=plannerFailures;
 let runtimeHash=hash;
 const fingerprint=()=>({hash,files:[],git:{head:'a'.repeat(40),indexHash:hash}});
 const adapters={identity:()=>runtimeHash,skills:()=>skills,hasReadConsent:()=>consent,
 capture:()=>({manifest:{sourceHash:hash},bundlePath:'fixture-source'}),
 allocate:({task,runId})=>({worktree,taskId:task.id,attemptId:1,leaseId:'fixture',sourceHash:hash,runId}),
 verifyBinding:()=>true,replaceBinding:({binding,newRunId})=>({...binding,runId:newRunId}),fingerprint,
 inspectChanges:()=>({allowed:true,changedFiles:[]}),applyEdits:()=>{},diff:()=>({content:'',complete:true}),
 runner:{ai:{available:true},checks:{available:true}},loadSkills:ids=>ids.map(name=>({name,text:'fixture',hash,path:`skills/${name}/SKILL.md`})),
 projectSummary:()=>({schemaVersion:2,name:'fixture',contextHash:hash,contextPaths:[],scopeCandidates,checks:['tests'],ai:{provider:'codex',model:'fixture'},capabilities:{intake:{allowed:true}}}),
 registerTask:async(_root,input,options)=>options.service.create({...input,limits:{...input.limits,maxReplans}},{runId:options.run,operationId:options.operation,stage:options.stage,workflow:options.workflow,naturalIntakeHash:options.naturalIntakeHash}),
 execute:async({node,onStart,priorEvidence,reviewEvidence,task,plan})=>{
  calls.push({nodeId:node.id,action:node.action.id,priorEvidence,reviewEvidence,task,planVersion:plan.version});await onStart({ticket:'fixture',pid:process.pid});
  if(node.action.id==='ai-plan'&&remainingPlannerFailures-- > 0)return {exitCode:1,stopped:true,uncertain:false,failureReason:'AI_INVALID_SCHEMA'};
  if(node.action.id==='check-tests')return {exitCode:checks++<checkFails?1:0,stopped:true,uncertain:false};
  const fail=(node.action.id==='ai-review' && reviews++<reviewFails) ||
    (node.action.id==='ai-implement' && implementations++<implementationFails);
  const plannerIsUncertain=node.action.id==='ai-plan'&&remainingPlannerUncertainty>0;
  if(plannerIsUncertain)remainingPlannerUncertainty-=1;
  return {exitCode:0,stopped:true,uncertain:false,output:{...output,steps:undefined,verdict:uncertain&&node.action.id==='ai-analyze'?'uncertain':plannerIsUncertain?'uncertain':fail?'fail':'pass',skillsUsed:node.skills,findings:fail?[{severity:'blocking',message:'Неверный email принят',path:'src/form.mjs'}]:[],...(node.action.id==='ai-plan'?{steps}:{}),...(node.action.id==='ai-analyze'?{analysis}:{}),...(reviewEvidence?{reviewEvidenceHash:hashObject(reviewEvidence)}:{})}};
 }
 };
 // optional fields не включаются в strict JSON fixture.
 const execute=adapters.execute;adapters.execute=async(args)=>{const r=await execute(args);if(r.output && r.output.steps===undefined)delete r.output.steps;return r;};
 const service=await WorkflowService.open({root,adapters});
 const intake=()=>service.intake({title:'Форма регистрации',description:'Добавить проверку email',taskNumber:'ФОРМА-12',operationId:'intake-product',contextHash:hash});
 const settle=async(s)=>{for(let i=0;i<8;i++){await Promise.all([...service.drives.values()]);s=service.snapshot(s.runId);if(s.successorRunId){s=service.snapshot(s.successorRunId);continue;}return s;}throw Error('too many transitions');};
 const approve=s=>service.command(s.runId,'gate',request(s,{nodeId:'approve-plan',decision:'approve',permissions:s.gates[0].requiredPermissions,challenge:s.gates[0].challenge}));
 return {service,root,intake,settle,approve,calls,setRuntimeHash:(value)=>{runtimeHash=value;}};
}
test('product intake требует локальное согласие и не принимает browser scope',async(t)=>{
 const f=await fixture(t,{consent:false});await assert.rejects(f.intake(),e=>e.code==='ONBOARDING_REQUIRED');assert.equal(f.calls.length,0);
 await assert.rejects(f.service.intake({title:'Форма',description:'Добавить email',taskNumber:'1',operationId:'intake-bad',contextHash:hash,scope:['private']}));
});

test('product intake accepts up to 64 safe project roots before planning', async(t)=>{
 const scopeCandidates=Array.from({length:33},(_,index)=>`area-${index}`);
 const f=await fixture(t,{scopeCandidates});
 const result=await f.service.intake({title:'Миграция проекта',description:'Разделить большую миграцию на проверяемые этапы',taskNumber:'BIG-1',operationId:'intake-many-roots',contextHash:hash});
 assert.deepEqual(result.task.scope,scopeCandidates);
 assert.equal(result.status,'ready');
 await f.settle(result);
 assert.equal(f.service.close(),true);
});

test('product intake requires an explicit scope when a project exposes more than 64 roots', async(t)=>{
 const f=await fixture(t,{scopeCandidates:Array.from({length:65},(_,index)=>`area-${index}`)});
 await assert.rejects(
  f.service.intake({title:'Большая миграция',description:'Проверить большую миграцию по частям',taskNumber:'BIG-2',operationId:'intake-too-many-roots',contextHash:hash}),
  error=>error.code==='INTAKE_SCOPE_LIMIT',
 );
});

test('implementation receipt accepts a hash-bound large-file move as two declared changes', async(t)=>{
 const steps=[{id:'move-dictionary',title:'Перенести словарь',outcome:'Словарь находится в новом каталоге',needs:[],paths:['src/localization']}];
 const f=await fixture(t,{steps});
 const files=new Map([['src/dictionaries/tmg.ru.json','x'.repeat(256*1024)]]);
 const fingerprint=()=>{
  const entries=[...files].sort(([left],[right])=>left.localeCompare(right)).map(([path,content])=>({path,hash:hashObject(content),mode:'100644',size:content.length}));
  return {hash:hashObject(entries),files:entries,git:{head:'a'.repeat(40),indexHash:hash}};
 };
 const adapters=f.service.adapters;
 adapters.fingerprint=fingerprint;
 adapters.capture=()=>({manifest:{sourceHash:fingerprint().hash},bundlePath:'fixture-source'});
 adapters.inspectChanges=(before,after)=>({allowed:true,changedFiles:[...new Set([...before.files,...after.files].map(file=>file.path))].filter(path=>before.files.find(file=>file.path===path)?.hash!==after.files.find(file=>file.path===path)?.hash)});
 adapters.applyEdits=(_root,_before,_node,_task,_edits,moves)=>{
  for(const move of moves){const content=files.get(move.from);files.delete(move.from);files.set(move.to,content);}
 };
 adapters.diff=(_root,before,after)=>({complete:true,content:before.hash===after.hash?'':'rename dictionary'});
 const execute=adapters.execute;
 adapters.execute=async(args)=>{
  const result=await execute(args);
  if(args.node.action.id==='ai-implement'){
   const source=fingerprint().files[0];
   result.output.changedFiles=['src/dictionaries/tmg.ru.json','src/localization/tmg.ru.json'];
   result.output.edits=[];
   result.output.moves=[{from:'src/dictionaries/tmg.ru.json',to:'src/localization/tmg.ru.json',previousHash:source.hash}];
  }
  return result;
 };
 let snapshot=await f.settle(await f.intake());
 snapshot=await f.settle(await f.approve(snapshot));
 assert.equal(snapshot.status,'passed');
 const implementation=snapshot.nodes.find(node=>node.action.id==='ai-implement');
 assert.deepEqual(implementation.changedFiles,['src/dictionaries/tmg.ru.json','src/localization/tmg.ru.json']);
 assert.equal(files.has('src/dictionaries/tmg.ru.json'),false);
 assert.equal(files.get('src/localization/tmg.ru.json').length,256*1024);
});
test('анализ передается полностью, план уточняется без повторного анализа, одного согласования достаточно',async(t)=>{
 const f=await fixture(t);const initial=await f.intake();let s=await f.settle(initial);
 assert.equal(f.service.listRuns().find(run=>run.runId===s.runId).task.taskNumber,'ФОРМА-12');
 assert.equal(s.status,'waiting-for-human');assert.equal(s.phase,'execution');
 assert.deepEqual(s.gates[0].scope, [...new Set(s.nodes.flatMap(node=>node.resources.writes))].sort());
 assert.match(s.gates[0].consequences.approve,/автоматически/);
 assert.deepEqual(f.calls.map(c=>c.action),['ai-analyze','ai-plan']);
 assert.deepEqual(f.calls[1].priorEvidence.analysis.result.analysis,analysis);
 const oldHash=s.planHash;
 s=await f.service.command(s.runId,'revise-plan',request(s,{feedback:'Добавить кнопку показать пароль'}));s=await f.settle(s);
 assert.notEqual(s.planHash,oldHash);assert.deepEqual(s.task.planningFeedback,['Добавить кнопку показать пароль']);
 assert.deepEqual(f.calls.map(c=>c.action),['ai-analyze','ai-plan','ai-plan']);
 assert.equal(s.capabilities.revisePlan.allowed,true);
 s=await f.approve(s);s=await f.settle(s);
 assert.equal(s.status,'passed');assert.equal(s.completion,'ready-for-review');assert.equal(s.finalDisposition,null);assert.equal(s.gates.length,0);
 assert.deepEqual(s.delivery,{workspacePath:'.ai-orchestrator/worktrees/fixture-1'});
 assert.deepEqual(f.calls.map(c=>c.action),['ai-analyze','ai-plan','ai-plan','ai-implement','check-tests','ai-review']);
 assert.equal(f.service.snapshot(initial.runId).planHash,initial.planHash);
});

test('внешний binding не получает delivery и ready-for-review',async(t)=>{
 const f=await fixture(t);let s=await f.settle(await f.intake());
 s=await f.approve(s);s=await f.settle(s);
 const state=f.service.store.readRun(s.runId);
 f.service.store.updateRun(s.runId,state.revision,current=>({
   ...current,binding:{...current.binding,worktree:f.root},
 }));
 s=f.service.snapshot(s.runId);
 assert.equal(s.delivery,null);assert.equal(s.completion,null);
});
for(const failure of ['review','check'])test(`${failure}: bounded policy исправляет без нового human approval`,async(t)=>{
 const f=await fixture(t,{reviewFails:failure==='review'?1:0,checkFails:failure==='check'?1:0});let s=await f.settle(await f.intake());const approvedId=s.runId;
 s=await f.approve(s);s=await f.settle(s);
 assert.equal(s.status,'passed',JSON.stringify({failure:s.failureReason,nodes:s.nodes.map(n=>({id:n.id,status:n.status,reason:n.reason}))}));assert.notEqual(s.runId,approvedId);
 const state=f.service.store.readRun(s.runId);assert.equal(state.policyGrant.runId,approvedId);assert.equal(state.policyGrant.cycle,1);
 const receipt=f.service.store.readObject('receipts',state.nodes['approve-plan'].receipts[0]);assert.equal(receipt.phase,'policy');assert.equal(receipt.actor,'approved-repair-policy');
 const finalReview=f.calls.filter(c=>c.action==='ai-review').at(-1).reviewEvidence;
 assert.equal(finalReview.previousExecutions.length,1);assert.equal(finalReview.previousExecutions[0].evidence.runId,approvedId);
 assert.ok(finalReview.previousExecutions[0].evidence.completedImplementations.length>0);
});
test('повторный review failure останавливается после двух исправлений',async(t)=>{
 const f=await fixture(t,{reviewFails:9});let s=await f.settle(await f.intake());s=await f.approve(s);s=await f.settle(s);
 assert.equal(s.status,'failed');assert.equal(f.service.store.readRun(s.runId).policyGrant.cycle,2);assert.equal(f.calls.filter(c=>c.action==='ai-review').length,3);
 const state=f.service.store.readRun(s.runId);
 f.service.store.updateRun(s.runId,state.revision,current=>({...current,policyGrant:{...current.policyGrant,cycle:1}}));
 assert.equal(f.service.snapshot(s.runId).integrity.valid,false,'понижение счетчика должно нарушать integrity');
});
test('unchanged failed implementation is repaired under the approved plan',async(t)=>{
 const f=await fixture(t,{implementationFails:1});let s=await f.settle(await f.intake());const approvedId=s.runId;
 s=await f.approve(s);s=await f.settle(s);
 assert.equal(s.status,'passed',JSON.stringify({status:s.status,nodes:s.nodes.map(n=>({id:n.id,status:n.status,reason:n.reason}))}));
 assert.notEqual(s.runId,approvedId);
 assert.equal(f.service.store.readRun(s.runId).policyGrant.cycle,1);
 assert.equal(f.calls.filter(c=>c.action==='ai-implement').length,2);
});
test('warnings-only uncertain analysis continues to planning instead of stopping a local task',async(t)=>{
 const f=await fixture(t,{uncertain:true});const s=await f.settle(await f.intake());
 assert.equal(s.status,'waiting-for-human');assert.equal(s.phase,'execution');
 assert.deepEqual(f.calls.map(c=>c.action),['ai-analyze','ai-plan']);
});

test('semantic planner uncertainty retries planning from saved analysis without restarting intake',async(t)=>{
 const f=await fixture(t,{plannerUncertain:1});let s=await f.settle(await f.intake());
 assert.equal(s.status,'uncertain');assert.deepEqual(f.calls.map(c=>c.action),['ai-analyze','ai-plan']);
 assert.equal(s.capabilities.recover.allowed,false);assert.equal(s.capabilities.requestReplan.allowed,true);
 s=await f.settle(await f.service.command(s.runId,'replan',request(s)));
 assert.equal(s.status,'waiting-for-human');assert.equal(s.phase,'execution');
 assert.deepEqual(f.calls.map(c=>c.action),['ai-analyze','ai-plan','ai-plan']);
});

test('technical planner failure preserves the verified analysis after a runtime fix',async(t)=>{
 const f=await fixture(t,{plannerFailures:1});let s=await f.settle(await f.intake());
 assert.equal(s.status,'failed');assert.equal(s.nodes.find(n=>n.id==='plan-task').reason,'AI_INVALID_SCHEMA');
 f.setRuntimeHash(hashObject('fixed provider output schema'));
 s=await f.settle(await f.service.command(s.runId,'replan',request(s)));
 assert.equal(s.status,'waiting-for-human');
 assert.deepEqual(f.calls.map(c=>c.action),['ai-analyze','ai-plan','ai-plan']);
 assert.deepEqual(f.calls.at(-1).priorEvidence.analysis.result.analysis,analysis);
});

test('out-of-scope planning read is rejected and automatically replanned without broadening access',async(t)=>{
 const f=await fixture(t);
 const execute=f.service.adapters.execute;let firstPlan=true;
 f.service.adapters.execute=async(args)=>{
  const result=await execute(args);
  if(args.node.action.id==='ai-plan' && firstPlan){
   firstPlan=false;
   result.output.steps=[{...output.steps[0],readPaths:['private/secret.ts']}];
  }
  return result;
 };
 const s=await f.settle(await f.intake());
 assert.equal(s.status,'waiting-for-human');
 assert.deepEqual(f.calls.map(call=>call.action),['ai-analyze','ai-plan','ai-plan']);
 assert.match(f.calls.at(-1).priorEvidence.feedback[0],/readPaths только внутри/);
 assert.equal(f.calls.some(call=>call.action==='ai-implement'),false);
});

test('natural task planning repairs missing per-criterion coverage before human approval',async(t)=>{
 const steps=[{...output.steps[0],requirementIds:['req-001','req-002']}];
 const f=await fixture(t,{steps});
 const original={id:'req-001',title:'Добавить проверку email',mandatory:true,
  verification:{method:'check',checkIds:['check-tests'],criterion:'Добавить проверку email',paths:['src/form.mjs']}};
 const specific={id:'req-002',title:'Валидация email',mandatory:true,
  verification:{method:'check',checkIds:['check-tests'],criterion:'Валидация email',paths:['src/form.mjs']}};
 const proposal={requirements:[original,specific],optionalImprovements:[],constraints:[],assumptions:[],unknowns:[]};
 const execute=f.service.adapters.execute;let firstPlan=true;
 f.service.adapters.execute=async(args)=>{
  const result=await execute(args);
  if(args.node.action.id==='ai-plan'){
   result.output.contractProposal={...proposal,requirements:firstPlan?[original]:[original,specific]};
   firstPlan=false;
  }
  return result;
 };
 const s=await f.settle(await f.intake());
 assert.equal(s.status,'waiting-for-human');
 assert.deepEqual(f.calls.map(call=>call.action),['ai-analyze','ai-plan','ai-plan']);
 assert.equal(s.proof.contract.requirements.length,1);
 assert.equal(s.proof.contract.requirements[0].title,'Валидация email');
 assert.ok(s.proof.contract.requirements.every(item=>item.workIds.length>0));
 assert.equal(f.calls.some(call=>call.action==='ai-implement'),false);
});

test('unapproved plan can be revised after runtime changes without transferring write permission',async(t)=>{
 const f=await fixture(t);let s=await f.settle(await f.intake());
 assert.equal(s.phase,'execution');assert.equal(s.status,'waiting-for-human');
 f.setRuntimeHash(hashObject('corrected contract compiler'));
 s=await f.settle(await f.service.command(s.runId,'revise-plan',request(s,{feedback:'Уточнить будущую проверку требования'})));
 assert.equal(s.phase,'execution');assert.equal(s.status,'waiting-for-human');
 assert.deepEqual(f.service.store.readRun(s.runId).permissions,[]);
 assert.equal(f.calls.filter(c=>c.action==='ai-analyze').length,1);
 assert.equal(f.calls.filter(c=>c.action==='ai-implement').length,0);
});

test('a prompt limit before process start is a known failure and requires no fictitious recovery',async(t)=>{
 const f=await fixture(t), execute=f.service.adapters.execute;
 f.service.adapters.execute=async args=>{
  if(args.node.action.id==='ai-plan')throw new GraphError('RUNNER_PROMPT_LIMIT','Контекст слишком большой');
  return execute(args);
 };
 const s=await f.settle(await f.intake());
 assert.equal(s.status,'failed');
 const receipt=f.service.store.readObject('receipts',s.nodes.find(n=>n.id==='plan-task').receiptIds.at(-1));
 assert.equal(receipt.termination.stopped,true);
 assert.equal(receipt.termination.execution.processStarted,false);
 assert.equal(s.capabilities.recover.allowed,false);
});

test('an error after process start cannot fabricate proof that no process ran',async(t)=>{
 const f=await fixture(t), execute=f.service.adapters.execute;
 f.service.adapters.execute=async args=>{
  if(args.node.action.id==='ai-plan'){
   await args.onStart({ticket:'fixture',pid:process.pid});
   throw new GraphError('RUNNER_PROMPT_LIMIT','Сбой после начала');
  }
  return execute(args);
 };
 const s=await f.settle(await f.intake());
 assert.equal(s.status,'uncertain');
 const receipt=f.service.store.readObject('receipts',s.nodes.find(n=>n.id==='plan-task').receiptIds.at(-1));
 assert.equal(receipt.termination,null);
});

test('planner retry analyzes again when the previously observed workspace changed',async(t)=>{
 const f=await fixture(t,{plannerFailures:1});let s=await f.settle(await f.intake());
 const before=f.service.adapters.fingerprint();
 f.service.adapters.fingerprint=()=>({...before,hash:hashObject('changed source after analysis')});
 s=await f.settle(await f.service.command(s.runId,'replan',request(s)));
 assert.equal(s.status,'waiting-for-human');
 assert.deepEqual(f.calls.map(c=>c.action),['ai-analyze','ai-plan','ai-analyze','ai-plan']);
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

test('финальный review после no-op исправления получает полный исходный diff с прежним runId',async(t)=>{
 const f=await fixture(t,{reviewFails:1});
 let content='export const valid = false;';let implementations=0;
 const a=f.service.adapters;
 const fingerprint=()=>({hash:hashObject(content),files:[{path:'src/form.mjs',hash:hashObject(content),mode:'100644',size:content.length}],git:{head:'a'.repeat(40),indexHash:hash}});
 a.fingerprint=fingerprint;
 a.capture=()=>({manifest:{sourceHash:fingerprint().hash},bundlePath:'fixture-source'});
 a.inspectChanges=(before,after)=>({allowed:true,changedFiles:before.hash===after.hash?[]:['src/form.mjs']});
 a.applyEdits=(_root,_before,_node,_task,edits)=>{if(edits.length)content=edits[0].content;};
 a.diff=(_root,before,after)=>({complete:true,content:before.hash===after.hash?'':'--- a/src/form.mjs\n+++ b/src/form.mjs\n-export const valid = false;\n+export const valid = true;\n'});
 a.replaceBinding=({binding,newRunId,sourceHash})=>({...binding,runId:newRunId,sourceHash});
 const execute=a.execute;
 a.execute=async(args)=>{
   const result=await execute(args);
   if(args.node.action.id==='ai-implement' && implementations++===0){
     result.output.changedFiles=['src/form.mjs'];result.output.edits=[{path:'src/form.mjs',previousHash:hashObject(content),content:'export const valid = true;',executable:false}];
   }
   return result;
 };
 let s=await f.settle(await f.intake());const original=s.runId;
 s=await f.approve(s);s=await f.settle(s);
 assert.equal(s.status,'passed',s.failureReason??s.nodes.find(n=>n.reason)?.reason);
 const evidence=f.calls.filter(c=>c.action==='ai-review').at(-1).reviewEvidence;
 assert.equal(evidence.previousExecutions[0].evidence.runId,original);
 assert.match(evidence.previousExecutions[0].evidence.completedImplementations[0].diff.artifact.content,/valid = false/);
 assert.equal(evidence.implementations[0].diff.artifact.content,'');
 assert.equal(evidence.implementations[0].receipt.beforeFingerprint,evidence.previousExecutions[0].evidence.completedImplementations[0].receipt.afterFingerprint);
});

test('ручной replan сохраняет полный diff исходной execution-версии для final review',async(t)=>{
 const f=await fixture(t);
 let content='export const valid = false;';let implementations=0;
 const adapters=f.service.adapters;
 const fingerprint=()=>({hash:hashObject(content),files:[{path:'src/form.mjs',hash:hashObject(content),mode:'100644',size:content.length}],git:{head:'a'.repeat(40),indexHash:hash}});
 adapters.fingerprint=fingerprint;
 adapters.capture=()=>({manifest:{sourceHash:fingerprint().hash},bundlePath:'fixture-source'});
 adapters.inspectChanges=(before,after)=>({allowed:true,changedFiles:before.hash===after.hash?[]:['src/form.mjs']});
 adapters.applyEdits=(_root,_before,_node,_task,edits)=>{if(edits.length)content=edits[0].content;};
 adapters.diff=(_root,before,after)=>({complete:true,content:before.hash===after.hash?'':'--- a/src/form.mjs\n+++ b/src/form.mjs\n-export const valid = false;\n+export const valid = true;\n'});
 adapters.replaceBinding=({binding,newRunId,sourceHash})=>({...binding,runId:newRunId,sourceHash});
 const execute=adapters.execute;
 adapters.execute=async(args)=>{
   const result=await execute(args);
   if(args.node.action.id==='ai-implement' && implementations++===0){
     result.output.changedFiles=['src/form.mjs'];
     result.output.edits=[{path:'src/form.mjs',previousHash:hashObject(content),content:'export const valid = true;',executable:false}];
   }
   return result;
 };
 let snapshot=await f.settle(await f.intake());
 snapshot=await f.approve(snapshot);snapshot=await f.settle(snapshot);
 const originalRunId=snapshot.runId;
 assert.equal(snapshot.status,'passed');
 snapshot=await f.service.command(snapshot.runId,'replan',request(snapshot));
 await f.settle(await f.approve(snapshot));
 const evidence=f.calls.filter(call=>call.action==='ai-review').at(-1).reviewEvidence;
 assert.equal(evidence.previousExecutions.length,1);
 assert.equal(evidence.previousExecutions[0].evidence.runId,originalRunId);
 assert.match(evidence.previousExecutions[0].evidence.completedImplementations[0].diff.artifact.content,/valid = false/);
 assert.equal(evidence.implementations[0].diff.artifact.content,'');
});

test('manual replan сохраняет historical evidence после обновления runtime',async(t)=>{
 const f=await fixture(t);
 let content='export const valid = false;';let implementations=0;
 const adapters=f.service.adapters;
 const fingerprint=()=>({hash:hashObject(content),files:[{path:'src/form.mjs',hash:hashObject(content),mode:'100644',size:content.length}],git:{head:'a'.repeat(40),indexHash:hash}});
 adapters.fingerprint=fingerprint;
 adapters.capture=()=>({manifest:{sourceHash:fingerprint().hash},bundlePath:'fixture-source'});
 adapters.inspectChanges=(before,after)=>({allowed:true,changedFiles:before.hash===after.hash?[]:['src/form.mjs']});
 adapters.applyEdits=(_root,_before,_node,_task,edits)=>{if(edits.length)content=edits[0].content;};
 adapters.diff=(_root,before,after)=>({complete:true,content:before.hash===after.hash?'':'--- a/src/form.mjs\n+++ b/src/form.mjs\n-export const valid = false;\n+export const valid = true;\n'});
 adapters.replaceBinding=({binding,newRunId,sourceHash})=>({...binding,runId:newRunId,sourceHash});
 const execute=adapters.execute;
 adapters.execute=async(args)=>{
   const result=await execute(args);
   if(args.node.action.id==='ai-implement' && implementations++===0){
     result.output.changedFiles=['src/form.mjs'];
     result.output.edits=[{path:'src/form.mjs',previousHash:hashObject(content),content:'export const valid = true;',executable:false}];
   }
   return result;
 };
 let snapshot=await f.settle(await f.intake());
 snapshot=await f.settle(await f.approve(snapshot));
 const oldPlan=f.service.store.readObject('plans',f.service.store.readRun(snapshot.runId).planHash);
 f.setRuntimeHash(hashObject('updated runtime'));
 snapshot=await f.service.command(snapshot.runId,'replan',request(snapshot));
 snapshot=await f.settle(await f.approve(snapshot));
 assert.equal(snapshot.status,'passed');
 const evidence=f.calls.filter(call=>call.action==='ai-review').at(-1).reviewEvidence;
 const currentPlan=f.service.store.readObject('plans',f.service.store.readRun(snapshot.runId).planHash);
 assert.notEqual(evidence.previousExecutions[0].plan.runtimeHash,currentPlan.runtimeHash);
 assert.equal(evidence.previousExecutions[0].evidence.completedImplementations[0].receipt.runtimeHash,oldPlan.runtimeHash);
});

test('final review сохраняет подтвержденные partial changes прошлых execution-версий',async(t)=>{
 const steps=[
   {id:'validation',title:'Валидация',outcome:'Проверка готова',needs:[],paths:['src/validation.mjs']},
   {id:'markup',title:'Разметка',outcome:'Разметка готова',needs:['validation'],paths:['src/markup.mjs']},
   {id:'css',title:'Стили',outcome:'Стили готовы',needs:['markup'],paths:['src/styles.css']},
   {id:'js',title:'Поведение',outcome:'Поведение готово',needs:['css'],paths:['src/form.mjs']},
 ];
 const f=await fixture(t,{steps,maxReplans:3});
 const files=new Map();
 const fingerprint=()=>{
   const entries=[...files].sort(([left],[right])=>left.localeCompare(right)).map(([path,content])=>({path,hash:hashObject(content),mode:'100644',size:content.length}));
   return {hash:hashObject(entries),files:entries,git:{head:'a'.repeat(40),indexHash:hash}};
 };
 const adapters=f.service.adapters;
 adapters.fingerprint=fingerprint;
 adapters.capture=()=>({manifest:{sourceHash:fingerprint().hash},bundlePath:'fixture-source'});
 adapters.inspectChanges=(before,after)=>({allowed:true,changedFiles:[...new Set([...before.files,...after.files].map(file=>file.path))].filter(path=>before.files.find(file=>file.path===path)?.hash!==after.files.find(file=>file.path===path)?.hash)});
 adapters.applyEdits=(_root,_before,_node,_task,edits)=>{for(const edit of edits)files.set(edit.path,edit.content);};
 adapters.diff=(_root,before,after)=>({complete:true,content:before.hash===after.hash?'':'--- a/src/form\n+++ b/src/form\n+confirmed change\n'});
 adapters.inspectProcess=()=>({stopped:true,uncertain:false});
 const execute=adapters.execute;
 adapters.execute=async(args)=>{
   const result=await execute(args);
   if(args.node.action.id!=='ai-implement')return result;
   if(args.plan.version===2&&['step-validation','step-markup'].includes(args.node.id)){
     const path=args.node.id==='step-validation'?'src/validation.mjs':'src/markup.mjs';
     result.output.changedFiles=[path];result.output.edits=[{path,previousHash:null,content:`${args.node.id}\n`,executable:false}];
   } else if(args.plan.version===2&&args.node.id==='step-css'){
     result.output.verdict='uncertain';result.output.findings=[{severity:'warning',message:'CSS timeout без изменений',path:'src/styles.css'}];
   } else if(args.plan.version===3&&args.node.id==='step-fix-2'){
     result.output.verdict='fail';result.output.findings=[{severity:'blocking',message:'Skill разметки не выполнил узел',path:'src/markup.mjs'}];
   }
   return result;
 };
 let snapshot=await f.settle(await f.intake());
 snapshot=await f.approve(snapshot);snapshot=await f.settle(snapshot);
 assert.equal(snapshot.status,'uncertain');
 assert.equal(snapshot.capabilities.recover.allowed,false);
 assert.equal(snapshot.capabilities.requestReplan.allowed,true);
 snapshot=await f.service.command(snapshot.runId,'replan',request(snapshot));
 snapshot=await f.settle(await f.approve(snapshot));
 assert.equal(snapshot.status,'passed');
 assert.equal(f.service.store.readRun(snapshot.runId).policyGrant.cycle,1,
   'Неизмененная failed-реализация должна исправляться автоматически');
 snapshot=await f.service.command(snapshot.runId,'replan',request(snapshot));
 snapshot=await f.settle(await f.approve(snapshot));
 assert.equal(snapshot.status,'passed');
 const evidence=f.calls.filter(call=>call.action==='ai-review').at(-1).reviewEvidence;
 assert.equal(evidence.previousExecutions.length,3);
 assert.equal(evidence.previousExecutions[0].evidence.completedImplementations.length,2);
 assert.deepEqual(evidence.previousExecutions[0].evidence.incompleteImplementations.map(item=>[item.nodeId,item.status]),[['step-css','uncertain'],['step-js','pending']]);
 assert.equal(evidence.previousExecutions[1].evidence.completedImplementations.length,1);
 assert.deepEqual(evidence.previousExecutions[1].evidence.incompleteImplementations.map(item=>[item.nodeId,item.status]),[['step-fix-2','failed'],['step-fix-3','pending'],['step-fix-4','pending']]);
 assert.equal(evidence.previousExecutions[2].evidence.completedImplementations.length,4);
 const state=f.service.store.readRun(snapshot.runId);
 const plan=f.service.store.readObject('plans',state.planHash);
 const currentTask=f.service.store.readObject('tasks',state.taskHash);
 const overflow={...evidence,previousExecutions:Array.from({length:21},()=>evidence.previousExecutions[0])};
 assert.throws(()=>validateReviewEvidence(overflow,{node:plan.nodes.find(item=>item.action.id==='ai-review'),task:currentTask,plan}),{code:'REVIEW_EVIDENCE_INVALID'});
});

test('ручное повторное планирование продолжает автономный read-only цикл до согласования', async(t)=>{
 const f=await fixture(t,{maxReplans:3});
 const execute=f.service.adapters.execute;let firstPlan=true;
 f.service.adapters.execute=async(args)=>{
  const result=await execute(args);
  if(args.node.action.id==='ai-plan' && firstPlan){firstPlan=false;result.output.verdict='fail';}
  return result;
 };
 let s=await f.settle(await f.intake());assert.equal(s.status,'failed');
 const previousHash=s.planHash;
 s=await f.service.command(s.runId,'replan',request(s));s=await f.settle(s);
 assert.equal(s.status,'waiting-for-human');assert.notEqual(s.planHash,previousHash);
 assert.equal(f.calls.filter(call=>call.action==='ai-plan').length,2);
 assert.equal(f.calls.some(call=>call.action==='ai-implement'),false);
 s=await f.approve(s);s=await f.settle(s);assert.equal(s.completion,'ready-for-review');
});

test('готовое read-only планирование восстанавливается новой версией после runtime drift',async(t)=>{
 const f=await fixture(t,{maxReplans:3});
 const created=await f.service.create({id:'TASK-DRIFT-READY',goal:'Проверка формы',instructions:'Проверить email',scope:['src'],acceptance:['Email отклонен'],checks:['tests'],limits:{maxReplans:3}},{runId:'drift-ready',workflow:'autonomous',stage:'planning'});
 const nextRuntime=hashObject('updated-runtime');f.setRuntimeHash(nextRuntime);
 let s=f.service.snapshot(created.runId);assert.equal(s.integrity.valid,false);assert.equal(s.capabilities.run.allowed,false);
 assert.equal(s.capabilities.requestReplan.allowed,true);
 s=await f.service.command(s.runId,'replan',request(s));s=await f.settle(s);
 assert.equal(s.status,'waiting-for-human');assert.equal(f.service.plan(s.runId).runtimeHash,nextRuntime);
 assert.equal(f.service.plan(created.runId).runtimeHash,hash);assert.equal(f.calls.some(call=>call.action==='ai-implement'),false);
});


test('recovered preflight uncertainty retains unchanged saved analysis without a second analyzer',async(t)=>{
 const f=await fixture(t);let s=await f.settle(await f.intake());
 assert.equal(s.phase,'execution');assert.equal(s.status,'waiting-for-human');
 const execute=f.service.adapters.execute;let failed=false;
 f.service.adapters.execute=async args=>{
  if(args.node.action.id==='ai-plan'&&!failed){failed=true;throw new GraphError('LEGACY_PREFLIGHT_UNCERTAIN','Synthetic preflight without a process result');}
  return execute(args);
 };
 s=await f.settle(await f.service.command(s.runId,'revise-plan',request(s,{feedback:'Clarify the planned verification'})));
 assert.equal(s.phase,'planning');assert.equal(s.status,'uncertain');
 const retained=f.service.plan(s.runId).analysisArtifact;
 assert.ok(retained);assert.equal(f.calls.filter(c=>c.action==='ai-analyze').length,1);
 assert.equal(s.capabilities.recover.allowed,true);
 await assert.rejects(f.service.command(s.runId,'replan',request(s)),{code:'RECOVERY_REQUIRED'});
 s=await f.service.command(s.runId,'recover',request(s));
 assert.equal(f.service.store.readRun(s.runId).recovered,true);
 const planner=s.nodes.find(n=>n.id==='plan-task');
 assert.equal(f.service.receipt(s.runId,planner.receiptIds.at(-1)).phase,'recovery');
 s=await f.settle(await f.service.command(s.runId,'replan',request(s)));
 assert.equal(s.phase,'execution');assert.equal(s.status,'waiting-for-human');
 assert.equal(f.calls.filter(c=>c.action==='ai-analyze').length,1);
 assert.deepEqual(f.calls.at(-1).priorEvidence.analysis.result.analysis,analysis);
 assert.equal(f.calls.filter(c=>c.action==='ai-implement').length,0);
});

test('recovered preflight uncertainty reanalyzes when the saved analysis source changed',async(t)=>{
 const f=await fixture(t);let s=await f.settle(await f.intake());
 assert.equal(s.phase,'execution');assert.equal(s.status,'waiting-for-human');
 const execute=f.service.adapters.execute;let failed=false;
 f.service.adapters.execute=async args=>{
  if(args.node.action.id==='ai-plan'&&!failed){failed=true;throw new GraphError('LEGACY_PREFLIGHT_UNCERTAIN','Synthetic preflight without a process result');}
  return execute(args);
 };
 s=await f.settle(await f.service.command(s.runId,'revise-plan',request(s,{feedback:'Clarify the planned verification'})));
 assert.equal(s.phase,'planning');assert.equal(s.status,'uncertain');
 const retained=f.service.plan(s.runId).analysisArtifact;
 assert.ok(retained);assert.equal(f.calls.filter(c=>c.action==='ai-analyze').length,1);
 assert.equal(s.capabilities.recover.allowed,true);
 await assert.rejects(f.service.command(s.runId,'replan',request(s)),{code:'RECOVERY_REQUIRED'});
 s=await f.service.command(s.runId,'recover',request(s));
 assert.equal(f.service.store.readRun(s.runId).recovered,true);
 const planner=s.nodes.find(n=>n.id==='plan-task');
 assert.equal(f.service.receipt(s.runId,planner.receiptIds.at(-1)).phase,'recovery');
 const before=f.service.adapters.fingerprint();
 f.service.adapters.fingerprint=()=>({...before,hash:hashObject('changed source after recovered preflight')});
 s=await f.settle(await f.service.command(s.runId,'replan',request(s)));
 assert.equal(s.phase,'execution');assert.equal(s.status,'waiting-for-human');
 assert.equal(f.calls.filter(c=>c.action==='ai-analyze').length,2);
 assert.deepEqual(f.calls.at(-1).priorEvidence.analysis.result.analysis,analysis);
 assert.equal(f.calls.filter(c=>c.action==='ai-implement').length,0);
});


test('new source analysis reaches planner and final contract ahead of retained older facts',async(t)=>{
 const f=await fixture(t,{plannerFailures:1}),execute=f.service.adapters.execute;
 let generation=0;
 f.service.adapters.execute=async args=>{
  const result=await execute(args);
  if(args.node.action.id==='ai-analyze'){
   generation++;
   result.output.analysis={...analysis,constraints:[generation===1?'Old enduring constraint':'Fresh enduring constraint'],
    projectFacts:[{path:'src/form.mjs',fact:generation===1?'Old source fact':'Fresh source fact'}]};
  }
  return result;
 };
 let s=await f.settle(await f.intake());
 assert.equal(s.status,'failed');
 const before=f.service.adapters.fingerprint();
 f.service.adapters.fingerprint=()=>({...before,hash:hashObject('source changed before fresh analysis')});
 s=await f.settle(await f.service.command(s.runId,'replan',request(s)));
 assert.equal(s.phase,'execution');assert.equal(s.status,'waiting-for-human');
 assert.equal(f.calls.filter(c=>c.action==='ai-analyze').length,2);
 assert.equal(f.calls.at(-1).priorEvidence.analysis.result.analysis.projectFacts[0].fact,'Fresh source fact');
 assert.deepEqual(f.service.plan(s.runId).taskContract.constraints,['Fresh enduring constraint']);
});
