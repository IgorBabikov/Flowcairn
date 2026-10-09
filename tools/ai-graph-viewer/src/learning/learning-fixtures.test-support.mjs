// Synthetic transport fixtures only. Never imported by the production viewer.
import { createHash } from 'node:crypto';
export const H = 'a'.repeat(64);
export const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
export const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
export const allowed = { allowed: true, reason: null };
export function fixture() {
  const source = { id: 'source-after', path: 'src/unknown.langx', fileHash: H, bytes: 18, mode: '100644', role: 'after', chunkHashes: [H], lineCount: 3 };
  const before = { ...source, id: 'source-before', role: 'before', fileHash: 'b'.repeat(64) };
  const context = { ...source, id: 'source-context', role: 'context', path: 'src/helper.py', fileHash: 'c'.repeat(64) };
  const sources = [source, before, context];
  const material = { version: 1, kind: 'stage', runId: 'run-fixture', planHash: H, taskHash: H, contractHash: H, stageId: 'stage-one',
    goal: 'Fixture goal', outcome: 'Fixture result', requirementIds: ['req-one'], beforeHash: H, resultHash: H,
    createdAt: '2026-10-08T10:00:00.000Z', sourceCatalogHash: hash({version:1,sources}), implementationReceiptIds: [H], checkReceiptIds: [H],
    reviewReceiptIds: [], diffArtifactIds: [], findingsArtifactIds: [], status: 'partial', gaps: [{ code: 'size-limit', path: 'src/large.langx', reason: 'Файл не сохранен целиком: превышен лимит.' }] };
  const materialHash = hash(material);
  const anchor = { sourceId: source.id, fileHash: source.fileHash, startLine: 1, endLine: 2, quote: 'first\n<script>x</script>' };
  const lesson = { version:1, materialHash, methodHash:H, title:'Fixture lesson', scope:'Synthetic UI test', steps: [{id:'step-one',title:'Input transformation',caller:'caller()',anchors:[anchor],input:'first',transformations:['transform'],output:'result',next:null,purpose:'Объяснение из материала',changeConsequence:'Результат изменится',alternatives:['failure'],origin:{kind:'manual-trace',label:'Ручной пример',receiptId:null,artifactId:null,anchor}}],
    questions:[{id:'question-one',text:'Что изменится?',anchors:[anchor]}],wholeFlow:'caller → result',takeaways:['Read carefully'],limitations:['Synthetic fixture, no real execution'] };
  const lessonHash = hash(lesson);
  const response = { id:materialHash, material, sources, progress:'deferred', freshness:{state:'stale',reason:'Файл проекта изменился.'}, lessonHash,
    capabilities:{generateLesson:{allowed:false,reason:'Генератор не подключен'},askLesson:{allowed:false,reason:'Не подключено'},setLearningProgress:allowed} };
  const page = { sourceId:source.id,fileHash:source.fileHash,text:'first\n<script>x</script>',startLine:1,endLine:2,totalLines:3,next:{startLine:3,lineCount:100} };
  const snapshot = { schemaVersion:3,runId:'run-fixture',revision:4,planHash:H,status:'learning-hold',nodes:[],edges:[],gates:[],
    integrity:{valid:true,reason:null},execution:{state:'idle',stopRequested:false},capabilities:{openLearning:allowed,continueLearning:allowed,setLearningMode:allowed},approvalExpiresAt:Date.now()+60000,
    continuation:{kind:'learning-hold',holdId:H,stageId:'stage-one',boundaryReceiptId:H,resultHash:H,createdAt:material.createdAt,materialHash},
    learning:{version:1,mode:'after-stage',stages:[{id:'stage-one',title:'Fixture stage',outcome:'result',requirementIds:['req-one'],status:'verified',checkedResultHash:H,freshness:'stale',materialHash,materialStatus:'partial',lessonHash,lessonStatus:'ready',progress:'deferred',reason:'Устарел относительно проекта'}],finalMaterialHash:null,activeJob:null} };
  return { source, sources, response, page, anchor, lesson, lessonHash, materialHash, snapshot };
}
