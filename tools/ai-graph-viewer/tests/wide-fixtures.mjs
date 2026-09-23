import {snapshot,plan as basePlan,graphNode,allDenied,allowed,objectHash,hash} from './fixtures.mjs';

// Synthetic presentation data. This fixture never invokes a planner or executor.
export function widePlanFixture(mode='waiting') {
  const state=snapshot();state.workflow='autonomous';state.phase='execution';
  state.task={...state.task,taskNumber:'FORM-102',title:'Добавить форму регистрации компании',goal:'Добавить форму регистрации компании',description:'Создать форму с email, паролем, названием компании и ИНН. Заблокировать повторную отправку.',scope:['src/registration'],acceptance:['Email и пароль валидируются','Для компании показаны название и ИНН','Повторная отправка заблокирована']};
  const works=[['implement','Создать форму регистрации','ai-implement','implementation','Email, пароль, название компании и ИНН с проверкой обязательных полей.'],['tests','Проверить поведение формы','check-tests','checks','Некорректные данные не отправляются; повторная отправка заблокирована.'],['review','Провести независимое ревью','ai-review','review','Каждый критерий связан с проверкой актуального результата.'],['handoff','Подготовить результат','artifact-handoff','handoff','Измененные файлы и доказательства собраны в одном отчете.']];
  state.nodes=[graphNode(),...works.map(([id,title,action,kind,outcome],index)=>graphNode({id,title,outcome,action:{id:action,kind},status:'pending',needs:[index?works[index-1][0]:'approve-plan'],capabilities:allDenied,receiptIds:[],attempt:0,resources:{reads:['src/registration'],writes:id==='implement'?['src/registration']:[]}}))];
  state.edges=state.nodes.slice(1).map((node,index)=>({id:`edge-${index}`,source:state.nodes[index].id,target:node.id}));
  const contract={version:1,goal:state.task.goal,instructionsHash:hash('d'),requirements:state.task.acceptance.map((title,index)=>({id:`R${index+1}`,title,mandatory:true,origin:'acceptance',verification:{method:'check',checkIds:['tests'],criterion:title,paths:['src/registration']},workIds:['implement','tests','review']})),optionalImprovements:[],constraints:['Изменения ограничены формой регистрации'],assumptions:[],unknowns:[],scope:['src/registration'],forbiddenPaths:[],rigor:{level:'standard',reasons:[]}};
  const plan={...structuredClone(basePlan),taskContract:contract,nodes:state.nodes.map(node=>({...basePlan.nodes[1],id:node.id,title:node.title,outcome:node.outcome,needs:node.needs,action:{id:node.action.id,version:1,inputs:{}},resources:{reads:['src/registration'],writes:node.id==='implement'?['src/registration']:[],exclusive:[]}}))};
  state.planHash=objectHash(plan);state.gates[0]={...state.gates[0],planHash:state.planHash,scope:['src/registration'],risks:['Проверить валидацию обязательных полей'],consequences:{approve:'Разрешить выполнение этого плана в указанных границах',reject:'Отклонить план'}};
  state.capabilities={...allDenied,approve:allowed,revisePlan:allowed};
  if(mode!=='waiting') {
    state.gates=[];state.capabilities={...allDenied,stop:allowed};state.status='running';state.activeNodeId='implement';
    state.nodes[0].status='passed';state.nodes[0].capabilities=allDenied;state.nodes[1].status='running';
    state.execution={state:'running',stopRequested:false};
    if(mode==='stopping'){state.execution={state:'stopping',stopRequested:true};state.capabilities=allDenied;}
    if(mode==='stopped'){state.status='cancelled';state.execution={state:'stopped',stopRequested:true};state.nodes[1].status='cancelled';state.capabilities={...allDenied,requestReplan:allowed};}
    if(mode==='uncertain'){state.status='uncertain';state.execution={state:'stop-uncertain',stopRequested:true};state.nodes[1].status='uncertain';state.capabilities={...allDenied,recover:allowed};}
    if(mode==='failed'){state.status='failed';state.execution={state:'idle',stopRequested:false};state.nodes[1].status='failed';state.nodes[1].reason='RUNNER_TOOLCHAIN_INVALID';state.failureReason='RUNNER_TOOLCHAIN_INVALID';state.capabilities={...allDenied,requestReplan:allowed};}
  }
  return {state,plan};
}

export function wideProofFixture(stale=false) {
  const {state,plan}=widePlanFixture('running');state.status='passed';state.execution={state:'idle',stopRequested:false};state.completion='ready-for-review';state.capabilities=allDenied;
  state.nodes=state.nodes.map(node=>({...node,status:'passed',capabilities:allDenied}));state.nodes[1].changedFiles=['src/registration/form.ts'];
  const requirements=plan.taskContract.requirements;
  state.proof={resultHash:hash('a'),acceptance:{allowed:false,reason:null,challenge:null},contract:plan.taskContract,
    requirements:requirements.map(item=>({...item,status:stale?'stale':'proven',reason:stale?'Исходники изменились после проверки':'Требование проверено.',workNodeIds:item.workIds,artifactIds:[hash('c')],evidenceIds:[`E-${item.id}`],findingIds:[]})),
    evidence:requirements.map(item=>({id:`E-${item.id}`,requirementIds:[item.id],nodeId:'tests',runId:state.runId,receiptId:hash('b'),artifactIds:[hash('c')],method:'check',summary:`Проверено: ${item.title}`,status:'passed',freshness:stale?'stale':'current',checkedAt:'2026-09-23T10:00:00Z',resultHash:hash('a'),staleReason:stale?'Исходники изменились после проверки':null})),
    findings:[],coverage:{required:3,proven:stale?0:3},status:stale?'STALE':'PROVEN',blockers:stale?['Исходники изменились после проверки']:[],
    certificate:stale?null:{version:1,id:'fixture-certificate',taskId:state.task.id,goal:state.task.goal,contractHash:hash('d'),resultHash:hash('a'),requirementIds:requirements.map(x=>x.id),evidenceIds:requirements.map(x=>`E-${x.id}`),receiptIds:[hash('b')],issuedAt:'2026-09-23T10:00:00Z'},
    usage:{aiCalls:3,inputTokens:null,cachedInputTokens:null,outputTokens:null,totalTokens:null,costUsd:null,tokensPerProvenRequirement:null,costPerProvenRequirement:null,reportedCalls:0,unknownCalls:3,contextBytes:2300,durationMs:3000,repairCalls:0,verificationCalls:1,byRequirement:[]}};
  return {state,plan};
}
