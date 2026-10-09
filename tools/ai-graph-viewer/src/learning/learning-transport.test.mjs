import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { webcrypto } from 'node:crypto';
import { URL, fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { fixture, hash } from './learning-fixtures.test-support.mjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const bundle = await build({ stdin:{contents:"export * from './material-decoder'; export * from './lesson-decoder'; export * from './learning-api'; export * from './source-page'; export { api } from '../api';",resolveDir:fileURLToPath(new URL('.',import.meta.url)),loader:'ts'},bundle:true,write:false,platform:'node',format:'esm' });
const m = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text + '\n//# sourceURL=learning-test-bundle.mjs').toString('base64')}`);
const invalid = error => error.code === 'INVALID_LEARNING_DATA';
const clone = value => JSON.parse(JSON.stringify(value));

test('material and lesson are bound to requested immutable hashes and catalog', async () => {
  const f=fixture();
  assert.equal((await m.decodeLearningMaterial(f.response,'run-fixture',f.materialHash)).freshness.state,'stale');
  assert.equal((await m.decodeLearningLesson({id:f.lessonHash,lesson:f.lesson},f.lessonHash,f.response)).lesson.steps[0].origin.kind,'manual-trace');
  assert.equal((await m.decodeLearningMaterial(f.response,'run-successor',f.materialHash)).material.runId,'run-fixture');
  await assert.rejects(m.decodeLearningMaterial(f.response,'../bad-context',f.materialHash),invalid);
  const bad=clone(f.response); bad.material.goal='tampered';
  await assert.rejects(m.decodeLearningMaterial(bad,'run-fixture',f.materialHash),invalid);
  const catalog=clone(f.response); catalog.sources[0].path='other-file';
  await assert.rejects(m.decodeLearningMaterial(catalog,'run-fixture',f.materialHash),invalid);
  const wrongLesson=clone(f.lesson);wrongLesson.materialHash='f'.repeat(64);
  await assert.rejects(m.decodeLearningLesson({id:hash(wrongLesson),lesson:wrongLesson},hash(wrongLesson),f.response),invalid);
});
test('bound lesson rejects wrong source hash/range even when its own object hash is correct', async () => {
  const f=fixture(); const wrong=clone(f.lesson);wrong.steps[0].anchors[0].fileHash='f'.repeat(64);
  await assert.rejects(m.decodeLearningLesson({id:hash(wrong),lesson:wrong},hash(wrong),f.response),invalid);
  const range=clone(f.lesson);range.steps[0].anchors[0].endLine=100;
  await assert.rejects(m.decodeLearningLesson({id:hash(range),lesson:range},hash(range),f.response),invalid);
});
test('source pages preserve full lines/empty-file semantics and reject silent truncation', () => {
  const f=fixture(); assert.deepEqual(m.decodeLearningSource(f.page,f.source,1,100),f.page);
  assert.throws(()=>m.decodeLearningSource({...f.page,next:null},f.source,1,100),invalid);
  assert.throws(()=>m.decodeLearningSource({...f.page,sourceId:'other-source'},f.source,1,100),invalid);
  assert.throws(()=>m.decodeLearningSource({...f.page,text:'first'},f.source,1,100),invalid);
  assert.throws(()=>m.decodeLearningSource({...f.page,fileHash:'f'.repeat(64)},f.source,1,100),invalid);
  assert.throws(()=>m.decodeLearningSource(f.page,f.source,2,100),invalid);
  assert.deepEqual(m.decodeLearningSource({...f.page,text:'',startLine:1,endLine:0,totalLines:0,next:null},{...f.source,lineCount:0,bytes:0,chunkHashes:[]},1,100).text,'');
  assert.equal(m.decodeLearningSource({...f.page,text:'',startLine:3,endLine:3,totalLines:3,next:null},f.source,3,100).endLine,3);
});
test('API issues only bound GET reads, never paths, generation or progress writes', async () => {
  const f=fixture(),calls=[];
  const api=m.createLearningApi(async (url,init)=>{calls.push({url,method:init?.method??'GET'});return url.includes('/sources/')?f.page:url.includes('/lessons/')?{id:f.lessonHash,lesson:f.lesson}:f.response;});
  await api.learningMaterial('run-fixture',f.materialHash);
  await api.learningSource('run-fixture',f.materialHash,f.source,1,100);
  await api.learningLesson('run-fixture',f.lessonHash,f.response);
  assert.equal(calls.length,3);assert.ok(calls.every(call=>call.method==='GET'&&!call.url.includes('unknown.langx')));
  assert.match(calls[1].url,/\/sources\/source-after\?startLine=1&lineCount=100$/);
  await assert.rejects(api.learningSource('run-fixture',f.materialHash,{...f.source,id:'../../live'},1,100),invalid);
  assert.equal(calls.length,3);
});
test('long-line error stays explicit; partial anchor pages never claim a complete quote', async () => {
  const f=fixture();
  const api=m.createLearningApi(async()=>{throw {code:'LEARNING_PAGE_LIMIT',message:'Line exceeds limit',retryable:false};});
  await assert.rejects(api.learningSource('run-fixture',f.materialHash,f.source),error=>error.code==='LEARNING_PAGE_LIMIT');
  const partial={...f.page,text:'first',endLine:1,next:{startLine:2,lineCount:100}};
  assert.deepEqual(m.anchorPageMatch(partial,f.anchor),{matches:true,complete:false,start:1,end:1});
  assert.equal(m.anchorPageMatch({...f.page,text:'wrong\n<script>x</script>'},f.anchor).matches,false);
});

test('opening an anchor includes preceding context without changing the source or exact quote', () => {
  const f=fixture();
  const anchor={...f.anchor,startLine:9,endLine:12,quote:'catch\ncheck\nshow\nend'};
  const selection=m.sourceSelectionForAnchor(anchor);
  assert.equal(selection.startLine,1);
  assert.equal(selection.lineCount,100);
  assert.equal(selection.sourceId,anchor.sourceId);
  assert.equal(selection.anchor,anchor);
  const prefix=Array.from({length:8},(_,i)=>`context ${i+1}`);
  const page={...f.page,text:[...prefix,anchor.quote,'after'].join('\n'),startLine:1,endLine:13,totalLines:13,next:null};
  assert.deepEqual(m.anchorPageMatch(page,selection.anchor),{matches:true,complete:true,start:9,end:12});
});
test('anchor context crosses page boundaries within the existing 200-line limit', () => {
  const f=fixture();
  const anchor={...f.anchor,startLine:195,endLine:310};
  const selection=m.sourceSelectionForAnchor(anchor);
  assert.ok(selection.startLine<anchor.startLine);
  assert.ok(selection.startLine+selection.lineCount-1>anchor.endLine);
  assert.ok(selection.lineCount<=200);
  const oversized=m.sourceSelectionForAnchor({...anchor,endLine:800});
  assert.equal(oversized.lineCount,200);
  assert.equal(oversized.anchor.endLine,800,'The quote is not shortened to disguise a partial page');
});

test('uncertain command retry reuses exact operationId/revision/body through the existing transport', async () => {
  const f=fixture(),previousFetch=globalThis.fetch,previousWindow=globalThis.window,calls=[];
  globalThis.window={location:{hash:''},sessionStorage:{getItem:()=>null}};
  globalThis.fetch=async (url,init)=>{
    calls.push({url,body:init.body,method:init.method});
    if(calls.length===1)throw new Error('connection lost after send');
    return {ok:true,json:async()=>({result:f.snapshot})};
  };
  const request=Object.freeze({operationId:'ui-same-command',expectedRevision:4,planHash:f.snapshot.planHash,holdId:f.snapshot.continuation.holdId,disposition:'continue'});
  try {
    await assert.rejects(m.api.control('run-fixture','continue-learning',request),error=>error.code==='NETWORK_UNCERTAIN'&&error.retryable);
    f.snapshot.revision=5;
    await m.api.control('run-fixture','continue-learning',request);
    assert.deepEqual(calls[0],calls[1]);
    assert.equal(JSON.parse(calls[1].body).expectedRevision,4);
  } finally {globalThis.fetch=previousFetch;if(previousWindow===undefined)delete globalThis.window;else globalThis.window=previousWindow;}
});

test('historical owner identity is preserved while every request stays in selected successor context', async()=>{
 const f=fixture(),urls=[];
 const api=m.createLearningApi(async url=>{urls.push(url);return url.includes('/sources/')?f.page:url.includes('/lessons/')?{id:f.lessonHash,lesson:f.lesson}:f.response;});
 const material=await api.learningMaterial('run-successor',f.materialHash);
 assert.equal(material.material.runId,'run-fixture');
 await api.learningSource('run-successor',f.materialHash,f.source);
 await api.learningLesson('run-successor',f.lessonHash,material);
 assert.ok(urls.every(url=>url.startsWith('/api/runs/run-successor/learning/')));
 assert.equal(material.material.planHash,f.response.material.planHash);
});
