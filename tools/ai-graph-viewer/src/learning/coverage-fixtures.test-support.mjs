import { fixture, hash } from './learning-fixtures.test-support.mjs';
export function coverageFixture() {
  const f = fixture(), material = { ...f.response.material, version: 2 };
  const body = { kind:'change', path:f.source.path, change:'modified', precision:'conservative', before:null,
    after:{sourceId:f.source.id,fileHash:f.source.fileHash,range:{startLine:1,endLine:3}}, reason:'Консервативный диапазон' };
  const entry = {id:`coverage-${hash(body)}`,...body};
  const page = {version:1,entries:[entry],next:null};
  const binding = Object.fromEntries(['runId','planHash','taskHash','contractHash','sourceCatalogHash','beforeHash','resultHash'].map(key=>[key,material[key]]));
  const inventory = {version:1,binding,algorithm:'line-prefix-suffix-v1',entryCount:1,pageCount:1,firstPageHash:hash(page)};
  material.coverageHash=hash(inventory);
  const materialHash=hash(material), lesson={...f.lesson,materialHash}, lessonHash=hash(lesson);
  const coverage = {id:material.coverageHash,inventory,pages:[page],lessonHash,linking:'validated',links:[{entryId:entry.id,status:'partial',stepIds:['step-one']}]};
  return {...f,materialHash,lessonHash,lesson,response:{...f.response,id:materialHash,material,lessonHash,coverage}};
}
