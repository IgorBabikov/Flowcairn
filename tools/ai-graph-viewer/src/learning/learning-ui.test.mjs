import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { URL, fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { fixture, H } from './learning-fixtures.test-support.mjs';

const require = createRequire(import.meta.url);
const bundle = await build({stdin:{contents:`
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
export const render = (component, props) => renderToStaticMarkup(createElement(component, props));
export * from './LearningControls'; export * from './LearningStageMap'; export * from './SavedSourcePanel';
export * from './LessonExplanation'; export * from './MaterialOverview'; export * from './learning-commands'; export * from './learning-projection';
`,resolveDir:fileURLToPath(new URL('.',import.meta.url)),loader:'tsx'},bundle:true,write:false,platform:'node',format:'esm',jsx:'automatic',
plugins:[{name:'test-react-instance',setup(build){build.onResolve({filter:/^react(?:-dom)?(?:\/.*)?$/},args=>({path:pathToFileURL(require.resolve(args.path)).href,external:true}));}}]});
const m=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text + '\n//# sourceURL=learning-test-bundle.mjs').toString('base64')}`);
const clone=value=>JSON.parse(JSON.stringify(value));
const controller = snapshot => ({snapshot,snapshotUnavailable:false,busy:false,pending:null,executeLearning:()=>{throw Error('Render must not issue a command');},stopError:null,displayedError:null,notice:''});

test('continue is exact hold-bound envelope; mode change cannot include or clear a hold',()=>{
 const f=fixture(),hold=clone(f.snapshot.continuation);
 const operation=m.learningOperation(f.snapshot,{action:'continue-learning',holdId:H,disposition:'defer'},'ui-defer');
 assert.deepEqual(operation.request,{operationId:'ui-defer',expectedRevision:4,planHash:H,holdId:H,disposition:'defer'});
 const serialized=JSON.stringify(operation.request);
 f.snapshot.revision=5;f.snapshot.continuation={kind:'open'};
 assert.equal(JSON.stringify(operation.request),serialized,'A pending operation must not rebind to new snapshot data');
 const mode=m.learningOperation(f.snapshot,{action:'set-learning-mode',mode:'after-task'},'ui-mode');
 assert.deepEqual(mode.request,{operationId:'ui-mode',expectedRevision:5,planHash:H,mode:'after-task'});
 const original=fixture().snapshot;m.learningOperation(original,{action:'set-learning-mode',mode:'after-task'},'ui-mode');
 assert.deepEqual(original.continuation,hold);
});
test('command eligibility rejects missing capabilities, wrong hold, expiry, uncertainty and running mode changes',()=>{
 const f=fixture(),intent={action:'continue-learning',holdId:H,disposition:'continue'};
 assert.equal(m.learningCommandCapability(f.snapshot,intent,false,Date.now()).allowed,true);
 for(const snapshot of [
  {...f.snapshot,capabilities:{}}, {...f.snapshot,continuation:{...f.snapshot.continuation,holdId:'b'.repeat(64)}},
  {...f.snapshot,approvalExpiresAt:1}, {...f.snapshot,status:'uncertain'}, {...f.snapshot,integrity:{valid:false,reason:'drift'}},
 ])assert.equal(m.learningCommandCapability(snapshot,intent,false,Date.now()).allowed,false);
 assert.equal(m.learningCommandCapability(f.snapshot,intent,true).allowed,false);
 assert.equal(m.learningCommandCapability({...f.snapshot,execution:{state:'running',stopRequested:false}}, {action:'set-learning-mode',mode:'after-task'}).allowed,false);
});
test('missing capabilities disable learning controls with an explicit reason; rendering never sends commands',()=>{
 const f=fixture(); f.snapshot.capabilities={};
 const html=m.render(m.LearningControls,{controller:controller(f.snapshot)});
 assert.match(html,/disabled=""[^>]*aria-describedby="learning-continue-reason"/);
 assert.match(html,/Сервис не сообщил о доступности этого действия/);
 assert.match(html,/select[^>]*disabled=""/);
});
test('stage map distinguishes verified execution, stale material and deferred reading; final after-task remains its own target',()=>{
 const f=fixture(); f.snapshot.proof={resultHash:'e'.repeat(64)}; f.snapshot.learning.mode='after-task';f.snapshot.learning.finalMaterialHash='d'.repeat(64);
 const html=m.render(m.LearningStageMap,{controller:controller(f.snapshot),onOpen:()=>{throw Error('No GET on render');},onClose:()=>{}});
 assert.match(html,/Этап проверен/);assert.match(html,/Устарело относительно проекта/);assert.match(html,/Отложено/);assert.match(html,/Контекст неполный/);
 assert.match(html,/Открыть итоговый материал/);assert.doesNotMatch(html,/contenteditable|<script/);
});
test('source UI offers before/after/context and renders exact escaped code with no editor',()=>{
 const f=fixture();
 const panel=m.render(m.SavedSourcePanel,{runId:'run-fixture',material:f.response,selection:null,onSelect:()=>{},canRead:true,deniedReason:null});
 assert.match(panel,/До изменений/);assert.match(panel,/После изменений/);assert.match(panel,/Неизмененный контекст/);assert.match(panel,/unknown.langx/);
 const code=m.render(m.SavedCode,{page:f.page,fontSize:15,anchor:f.anchor});
 assert.match(code,/font-size:15px/);assert.match(code,/data-line="1"/);assert.match(code,/data-line="2"/);
 assert.match(code,/&lt;script&gt;x&lt;\/script&gt;/);assert.doesNotMatch(code,/<script>|contenteditable|textarea/);
});
test('lesson exposes real flow fields, declared provenance and limitations without auto-continue',()=>{
 const f=fixture(); const html=m.render(m.LessonExplanation,{lesson:f.lesson,stepIndex:0,onStep:()=>{},onAnchor:()=>{}});
 for(const text of ['caller()','Ручная трассировка','transform','Результат изменится','failure','Synthetic fixture','Целый поток выполнения','необязательно'])assert.ok(html.includes(text),text);
 assert.doesNotMatch(html,/Продолжить работу|Подтверждаю выполнение/);
 const partial=m.render(m.MaterialOverview,{material:f.response,freshness:'unknown'});
 assert.match(partial,/Актуальность неизвестна/);assert.match(partial,/Контекст неполный/);assert.match(partial,/превышен лимит/);
});

test('final material freshness uses live result hash even when revision does not change',()=>{
 const f=fixture(); const snapshot=clone(f.snapshot);snapshot.status='passed';snapshot.continuation={kind:'open'};
 snapshot.learning.finalMaterialHash=f.materialHash;snapshot.learning.stages=[];snapshot.proof={resultHash:f.response.material.resultHash};
 assert.equal(m.materialFreshness(snapshot,f.response.material,'run-fixture'),'current');
 const revision=snapshot.revision;snapshot.proof.resultHash='b'.repeat(64);
 assert.equal(snapshot.revision,revision);assert.equal(m.materialFreshness(snapshot,f.response.material,'run-fixture'),'stale');
 snapshot.integrity.valid=false;assert.equal(m.materialFreshness(snapshot,f.response.material,'run-fixture'),'unknown');
 snapshot.integrity.valid=true;snapshot.proof.resultHash=f.response.material.resultHash;
 assert.equal(m.materialFreshness(snapshot,f.response.material,'run-fixture',true),'unknown');
 delete snapshot.proof;assert.equal(m.materialFreshness(snapshot,f.response.material,'run-fixture'),'unknown');
});
test('UI historical targets require the explicit predecessor chain; drift reading does not enable controls',()=>{
 const f=fixture(),next=clone(f.snapshot);next.runId='run-next';next.supersedesRunId=f.snapshot.runId;next.learning.stages=[];
 assert.equal(m.knownLearningMaterial(next,f.materialHash,[]),false);
 assert.equal(m.knownLearningMaterial(next,f.materialHash,[f.snapshot]),true);
 assert.equal(m.knownLearningMaterial(next,f.materialHash,[{...f.snapshot,runId:'foreign-run'}]),false);
 assert.equal(m.knownLearningMaterial(next,'d'.repeat(64),[f.snapshot]),false);
 const drift=clone(f.snapshot);drift.integrity={valid:false,reason:'RUNTIME_DRIFT'};
 const html=m.render(m.LearningStageMap,{controller:controller(drift),onOpen:()=>{},onClose:()=>{}});
 assert.match(html,/>Открыть сохраненный материал<\/button>/);
 assert.equal(m.learningCommandCapability(drift,{action:'continue-learning',holdId:H,disposition:'continue'}).allowed,false);
});
