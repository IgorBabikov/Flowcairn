import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { URL, fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { fixture, hash, allowed } from './learning-fixtures.test-support.mjs';
const require = createRequire(import.meta.url);
const { AbortController } = globalThis;
const bundle = await build({stdin:{contents:`
import { createElement } from 'react'; import { renderToStaticMarkup } from 'react-dom/server';
export const render = (c,p) => renderToStaticMarkup(createElement(c,p));
export * from './use-bound-read'; export * from './job-decoder'; export * from './content-command'; export * from './poll-job';
export * from './LessonQuestion'; export * from './LearningActions'; export * from './SavedSourcePanel';
export { api } from '../api';
`,resolveDir:fileURLToPath(new URL('.',import.meta.url)),loader:'tsx'},bundle:true,write:false,platform:'node',format:'esm',jsx:'automatic',
plugins:[{name:'react-instance',setup(b){b.onResolve({filter:/^react(?:-dom)?(?:\/.*)?$/},args=>({path:pathToFileURL(require.resolve(args.path)).href,external:true}));}}]});
const m=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text+'\n//# sourceURL=learning-jobs-ui-test.mjs').toString('base64')}`);
const invalid=e=>e.code==='INVALID_LEARNING_DATA';
const job=(f,status='running')=>({id:'job-one',kind:'question',materialHash:f.materialHash,status,result:status==='ready'?{answerHash:'a'.repeat(64)}:null,error:null});
const answer=f=>({version:1,materialHash:f.materialHash,lessonHash:f.lessonHash,anchor:f.anchor,question:'Почему?',text:'<script>Answer</script>',anchors:[f.anchor],limitations:['Ручной пример']});
const c=f=>({snapshot:f.snapshot,busy:false,pending:null,snapshotUnavailable:false,executeLearningContent:()=>{throw Error('No commands during render');}});

test('mutation envelopes reject unknown shapes as uncertain, retain same command on retry',async()=>{
 const f=fixture(),request=m.contentOperation(f.snapshot,f.response,{action:'generate-lesson'},'generate-once');
 const oldFetch=globalThis.fetch,oldWindow=globalThis.window,calls=[];
 globalThis.window={location:{hash:''},sessionStorage:{getItem:()=>null}};
 globalThis.fetch=async(url,init)=>{calls.push({url,body:init.body});return {ok:true,json:async()=>calls.length===1?{jobId:'wrong-envelope'}:{ok:true,result:{jobId:'job-one',snapshot:f.snapshot}}};};
 try {
  await assert.rejects(m.api.generateLesson(f.snapshot.runId,request.request),e=>e.code==='LEARNING_RESPONSE_UNCERTAIN'&&e.retryable);
  f.snapshot.revision=50;
  assert.equal((await m.api.generateLesson(f.snapshot.runId,request.request)).jobId,'job-one');
  assert.deepEqual(calls[0],calls[1]);assert.equal(JSON.parse(calls[1].body).expectedRevision,4);
 }finally{globalThis.fetch=oldFetch;globalThis.window=oldWindow;}
 assert.throws(()=>m.decodeLearningCommand({ok:true,result:{jobId:'job-one',snapshot:{...f.snapshot,runId:'wrong-run'}}},'run-fixture'),e=>e.retryable===true);
});
test('job identity/kind/material and terminal result are checked',()=>{
 const f=fixture(),j=job(f);assert.deepEqual(m.decodeLearningJob(j,j.id,f.materialHash,'question'),j);
 for(const bad of [{...j,id:'job-other'},{...j,kind:'lesson'},{...j,materialHash:'b'.repeat(64)},{...j,status:'ready'}])assert.throws(()=>m.decodeLearningJob(bad,j.id,f.materialHash,'question'),invalid);
});
test('answer hash and exact lesson/question/anchor binding reject late mismatches',async()=>{
 const f=fixture(),a=answer(f),expected={lessonHash:f.lessonHash,anchor:f.anchor,question:a.question};
 assert.deepEqual(await m.decodeLearningAnswer(a,hash(a),f.response,expected),a);
 await assert.rejects(m.decodeLearningAnswer({...a,text:'changed'},hash(a),f.response,expected),invalid);
 for(const bad of [{...expected,question:'Другой вопрос'},{...expected,anchor:{...f.anchor,quote:'other'}}])await assert.rejects(m.decodeLearningAnswer(a,hash(a),f.response,bad),invalid);
 const wrong={...a,lessonHash:'d'.repeat(64)};await assert.rejects(m.decodeLearningAnswer(wrong,hash(wrong),f.response),invalid);
});
test('polling is bounded, terminates after ready and suppresses an aborted late result',async()=>{
 const f=fixture();let reads=0,received=[];
 assert.equal(await m.pollJob({read:async()=>{reads++;return job(f);},signal:new AbortController().signal,receive:j=>received.push(j),pause:async()=>{},maxReads:3}),'paused');
 assert.equal(reads,3);assert.equal(received.length,3);
 reads=0;received=[];
 assert.equal(await m.pollJob({read:async()=>{reads++;return job(f,reads===2?'ready':'running');},signal:new AbortController().signal,receive:j=>received.push(j),pause:async()=>{}}),'settled');
 assert.equal(reads,2);
 const controller=new AbortController();let release;const delayed=new Promise(resolve=>{release=resolve;});
 const late=m.pollJob({read:()=>delayed,signal:controller.signal,receive:()=>assert.fail('Late result reached a new context')});
 controller.abort();release(job(f,'ready'));assert.equal(await late,'aborted');
});
test('poll budget and error count bound observation without command retry',async()=>{
 let reads=0,time=0;
 assert.equal(await m.pollJob({read:async()=>{reads++;return job(fixture());},signal:new AbortController().signal,receive:()=>{},now:()=>time,pause:async()=>{time+=2000;},budgetMs:4000}),'paused');
 assert.equal(reads,2);reads=0;
 await assert.rejects(m.pollJob({read:async()=>{reads++;throw Error('offline');},signal:new AbortController().signal,receive:()=>{},pause:async()=>{}}));assert.equal(reads,3);
});
test('Ask captures copied anchor; active job blocks AI but not explicit reading marks',()=>{
 const f=fixture();f.response.capabilities.askLesson=allowed;f.response.capabilities.generateLesson=allowed;
 const intent={action:'ask-lesson',lessonHash:f.lessonHash,anchor:f.anchor,question:'Что получится?'};
 assert.equal(m.contentCapability(f.snapshot,'run-fixture',f.response,intent).allowed,true);
 const operation=m.contentOperation(f.snapshot,f.response,intent,'ask-once');f.anchor.startLine=3;
 assert.equal(operation.request.anchor.startLine,1);
 f.snapshot.learning.activeJob={id:'job-one',kind:'lesson',materialHash:f.materialHash};
 assert.equal(m.contentCapability(f.snapshot,'run-fixture',f.response,{action:'generate-lesson'}).allowed,false);
 assert.equal(m.contentCapability(f.snapshot,'run-fixture',f.response,{action:'set-progress',progress:'read'}).allowed,true);
 assert.equal(m.contentCapability(f.snapshot,'other-run',f.response,{action:'set-progress',progress:'read'}).allowed,false);
});
test('question UI renders answer only beside matching context; other file exposes explicit return',()=>{
 const f=fixture(),a=answer(f),props={controller:c(f),runId:'run-fixture',material:f.response,answer:a,answerError:null,readAnswer:()=>{},onAnchor:()=>{}};
 const exact=m.render(m.LessonQuestion,{...props,anchor:f.anchor});assert.match(exact,/&lt;script&gt;Answer/);assert.doesNotMatch(exact,/<script>/);
 const other=m.render(m.LessonQuestion,{...props,anchor:{...f.anchor,sourceId:'source-before'}});assert.match(other,/ответ к другому фрагменту/);assert.doesNotMatch(other,/&lt;script&gt;Answer/);
});
test('exact source quote selection never silently trims 8 KiB or creates empty anchors',()=>{
 const f=fixture();assert.deepEqual(m.questionAnchor(f.page,f.anchor),f.anchor);
 assert.equal(m.questionAnchor({...f.page,text:'я'.repeat(4097)},null),null);
 assert.equal(m.questionAnchor({...f.page,text:''},null),null);
 const small=m.questionAnchor(f.page,null);assert.equal(small.quote,f.page.text);assert.equal(small.endLine,2);
});
test('failure/uncertainty reasons leave independent continuation copy and GET refresh',()=>{
 const html=m.render(m.LearningJobNotice,{kind:'question',canRead:true,observation:{job:{...job(fixture(),'uncertain'),error:{code:'CLI_DENIED',message:'CLI недоступен'}},paused:true,error:null,refresh:()=>{}}});
 assert.match(html,/CLI_DENIED/);assert.match(html,/CLI недоступен/);assert.match(html,/Состояние выполнения задачи не изменено/);assert.match(html,/Обновить статус запроса/);
});

test('progress projection is mandatory and never changes immutable material identity',async()=>{
 const f=fixture(),oldFetch=globalThis.fetch,oldWindow=globalThis.window;
 globalThis.window={location:{hash:''},sessionStorage:{getItem:()=>null}};
 try {
  for(const progress of [undefined,'understood',null]) {
   globalThis.fetch=async()=>({ok:true,json:async()=>({...f.response,progress})});
   await assert.rejects(m.api.learningMaterial('run-fixture',f.materialHash),invalid);
  }
  for(const progress of ['unread','read','deferred']) {
   globalThis.fetch=async()=>({ok:true,json:async()=>({...f.response,progress})});
   const read=await m.api.learningMaterial('run-fixture',f.materialHash);assert.equal(read.progress,progress);assert.equal(hash(read.material),f.materialHash);
  }
 }finally{globalThis.fetch=oldFetch;globalThis.window=oldWindow;}
});

test('fresh denied read capability overrides cached material command permissions',()=>{
 const f=fixture();f.response.capabilities={generateLesson:allowed,askLesson:allowed,setLearningProgress:allowed};
 f.snapshot.capabilities.openLearning={allowed:false,reason:'CURRENT_POLICY_DENIED'};
 for(const intent of [{action:'generate-lesson'},{action:'ask-lesson',lessonHash:f.lessonHash,anchor:f.anchor,question:'Почему?'},{action:'set-progress',progress:'read'}]) {
  assert.deepEqual(m.contentCapability(f.snapshot,'run-fixture',f.response,intent),{allowed:false,reason:'CURRENT_POLICY_DENIED'});
 }
 delete f.snapshot.capabilities.openLearning;
 assert.equal(m.contentCapability(f.snapshot,'run-fixture',f.response,{action:'set-progress',progress:'read'}).allowed,false);
});

test('revoked or unavailable reads hide cached material, lesson, source and answer at the same key/revision',()=>{
 const f=fixture();
 for(const data of [f.response,{id:f.lessonHash,lesson:f.lesson},f.page,answer(f)]) {
  const settled={key:'same-run-material-revision',attempt:0,result:{state:'ready',data,error:null}};
  assert.equal(m.boundReadResult(settled.key,0,true,settled).data,data);
  assert.deepEqual(m.boundReadResult(settled.key,0,false,settled),{state:'idle',data:null,error:null});
  assert.deepEqual(m.boundReadResult('other-material',0,true,settled),{state:'loading',data:null,error:null});
 }
});
