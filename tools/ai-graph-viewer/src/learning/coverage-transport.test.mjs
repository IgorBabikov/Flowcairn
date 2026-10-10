import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { coverageFixture } from './coverage-fixtures.test-support.mjs';
import { fixture, hash } from './learning-fixtures.test-support.mjs';
const bundled = await build({stdin:{contents:"export * from './material-decoder'; export * from './lesson-decoder';",resolveDir:fileURLToPath(new URL('.',import.meta.url)),loader:'ts'},bundle:true,write:false,platform:'node',format:'esm'});
const m=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const clone = value => structuredClone(value), invalid=error=>error.code==='INVALID_LEARNING_DATA';

test('V2 preserves immutable binding/page chain and validates partial links against the separately bound lesson',async()=>{
  const f=coverageFixture();
  assert.deepEqual(await m.decodeLearningMaterial(f.response,'run-fixture',f.materialHash),f.response);
  assert.deepEqual(await m.decodeLearningLesson({id:f.lessonHash,lesson:f.lesson},f.lessonHash,f.response),{id:f.lessonHash,lesson:f.lesson});
  const legacy=fixture(); assert.equal((await m.decodeLearningMaterial(legacy.response,'run-fixture',legacy.materialHash)).coverage,undefined);
});
test('missing pages, foreign inventory/hash, range tampering and incomplete V2 response fail closed',async()=>{
  const f=coverageFixture();
  for(const modify of [
    value=>{delete value.coverage;}, value=>{value.coverage.pages=[];}, value=>{value.coverage.pages[0].entries=[];},
    value=>{value.coverage.inventory.binding.runId='foreign-run';}, value=>{value.coverage.inventory.firstPageHash='c'.repeat(64);},
    value=>{value.coverage.pages[0].entries[0].after.range.endLine=999;}, value=>{value.coverage.pages.push(value.coverage.pages[0]);},
    value=>{value.coverage.links=[];},value=>{value.coverage.linking='absent';},value=>{value.coverage.lessonHash=null;},
  ]){const value=clone(f.response);modify(value);await assert.rejects(m.decodeLearningMaterial(value,'run-fixture',f.materialHash),invalid);}
  const old=fixture();old.response.coverage=f.response.coverage;
  await assert.rejects(m.decodeLearningMaterial(old.response,'run-fixture',old.materialHash),invalid);
});
test('fake full links and nonexistent steps are rejected even when inventory and lesson hashes are valid',async()=>{
  const f=coverageFixture();
  for(const link of [{status:'linked',stepIds:['step-one']},{status:'partial',stepIds:['made-up-step']},{status:'unlinked',stepIds:[]}]){
    const response=clone(f.response);Object.assign(response.coverage.links[0],link);
    await assert.rejects(m.decodeLearningLesson({id:f.lessonHash,lesson:f.lesson},f.lessonHash,response),invalid);
  }
  const lesson=clone(f.lesson);lesson.steps[0].anchors[0].endLine=3;lesson.steps[0].anchors[0].quote+='\nlast';
  const lessonHash=hash(lesson),response=clone(f.response);response.lessonHash=lessonHash;response.coverage.lessonHash=lessonHash;response.coverage.links[0].status='linked';
  assert.equal((await m.decodeLearningLesson({id:lessonHash,lesson},lessonHash,response)).id,lessonHash);
});
