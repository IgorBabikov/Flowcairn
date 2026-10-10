import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { hashObject, sha256 } from './lib/io.mjs';
import { readLearningMaterial } from './lib/learning-material.mjs';
import { createLearningCoverage, readLearningCoverage, linkLearningCoverage } from './lib/learning-coverage.mjs';
import { readLearningSourceCatalog, captureLearningSources, savedSourceAnchor } from './lib/learning-sources.mjs';
import { CoveragePageSchema } from './lib/learning-coverage-schemas.mjs';
import { learningMaterial } from './lib/learning-view.mjs';
import { fixture } from './learning-coverage.test-support.mjs';

const H = hashObject('coverage-tests');
const entries = coverage => coverage.pages.flatMap(page => page.entries);
function inventory(fx, beforeFiles, afterFiles, { persist = true, beforeGaps = [], afterGaps = [] } = {}) {
  const capture = (files, role) => {
    const descriptors = [], selected = [];
    for (const [name, input] of Object.entries(files)) {
      const value = typeof input === 'string' ? { text: input } : input;
      if (value.text === null) continue;
      const full = path.join(fx.root, name); mkdirSync(path.dirname(full), { recursive: true }); writeFileSync(full, value.text);
      chmodSync(full, value.mode === '100755' ? 0o755 : 0o644);
      const descriptor = { path: name, hash: sha256(value.text), size: Buffer.byteLength(value.text), mode: value.mode ?? '100644' };
      descriptors.push(descriptor);
      if (!value.skip) selected.push({ path: name, role: value.context ? 'context' : role, expected: { hash: descriptor.hash, size: descriptor.size, mode: descriptor.mode } });
    }
    const body = { files: descriptors.sort((a,b) => a.path.localeCompare(b.path)), git: { head: null, indexHash: H } };
    const fingerprint = { ...body, hash: hashObject(body) };
    if (persist) fx.store.putFingerprint(fingerprint);
    return captureLearningSources({ store: fx.store, projectRoot: fx.root, sourceHash: fingerprint.hash, files: selected });
  };
  const before = capture(beforeFiles, 'before'), after = capture(afterFiles, 'after');
  before.gaps.push(...beforeGaps); after.gaps.push(...afterGaps);
  const sources = [...readLearningSourceCatalog(fx.store, before.sourceCatalogHash).sources, ...readLearningSourceCatalog(fx.store, after.sourceCatalogHash).sources];
  const catalog = { version: 1, sources }, sourceCatalogHash = fx.store.putObject('learning-sources', catalog);
  const material = { ...fx.create().material, beforeHash: before.sourceHash, resultHash: after.sourceHash, sourceCatalogHash, gaps: [...beforeGaps, ...afterGaps] };
  material.coverageHash = createLearningCoverage({ store: fx.store, material, sources, before, after });
  const coverage = readLearningCoverage({ store: fx.store, material, sources });
  return { coverage, material, sources, before, after };
}

test('insert/delete/change use final coordinates; disjoint changes remain explicitly conservative', t => {
  const fx = fixture(t);
  const result = inventory(fx, { 'insert.py': 'a\nb\n', 'delete.py': 'a\nx\nb\n', 'change.py': 'a\nx\nb\ny\nc' },
    { 'insert.py': 'a\nx\nb\n', 'delete.py': 'a\nb\n', 'change.py': 'a\nu\nb\nv\nc' });
  const changes = entries(result.coverage).filter(value => value.kind === 'change');
  const item = name => changes.find(value => value.path === name);
  assert.equal(item('insert.py').before.range, null); assert.deepEqual(item('insert.py').after.range, { startLine: 2, endLine: 2 });
  assert.deepEqual(item('delete.py').before.range, { startLine: 2, endLine: 2 }); assert.equal(item('delete.py').after.range, null);
  assert.deepEqual(item('change.py').after.range, { startLine: 2, endLine: 4 }); assert.equal(item('change.py').precision, 'conservative');
});

test('known new/deleted/empty files and mode-only changes stay distinct from unknown captures', t => {
  const fx = fixture(t);
  const r = inventory(fx, { 'removed.py': 'old', 'empty-removed.py': '', 'mode.sh': 'run' },
    { 'added.py': 'new', 'empty-added.py': '', 'mode.sh': { text: 'run', mode: '100755' } });
  const items = entries(r.coverage);
  for (const [name, change] of [['removed.py','removed'],['empty-removed.py','removed'],['added.py','added'],['empty-added.py','added'],['mode.sh','metadata']])
    assert.equal(items.find(value => value.path === name).change, change);
  assert.equal(items.find(value => value.path === 'empty-added.py').after.range, null);
  assert.equal(items.find(value => value.path === 'mode.sh').after.range, null);
  const noBefore = inventory(fx, {}, { 'unknown.py': 'new' }, { persist: false });
  assert.equal(entries(noBefore.coverage).find(value => value.path === 'unknown.py').change, 'unknown');
  const missing = inventory(fx, { 'missing.py': { text: 'old', skip: true } }, { 'missing.py': 'new' });
  assert.equal(entries(missing.coverage).find(value => value.path === 'missing.py').change, 'unknown');
  const missingAfter = inventory(fx, { 'gone.py': 'old' }, { 'gone.py': { text: 'new', skip: true } });
  assert.equal(entries(missingAfter.coverage).find(value => value.path === 'gone.py').change, 'unknown');
  const excluded = inventory(fx, {}, { 'excluded.py': 'new' }, { beforeGaps: [{ code: 'excluded-source', path: null, reason: 'Исключено' }] });
  assert.equal(entries(excluded.coverage).find(value => value.path === 'excluded.py').change, 'unknown');
});

test('unchanged supplied context and missing dependency remain separate; all uncaptured changed paths are explicit', t => {
  const fx = fixture(t);
  const r = inventory(fx, { 'ctx.py': 'same', 'hidden.py': { text: 'old', skip: true } },
    { 'ctx.py': { text: 'same', context: true }, 'hidden.py': { text: 'new', skip: true } },
    { afterGaps: [{ code: 'missing-context', path: 'dependency.py', reason: 'Зависимость не сохранена' }] });
  const rows = entries(r.coverage);
  assert.equal(rows.find(value => value.path === 'ctx.py').kind, 'context');
  assert.equal(rows.find(value => value.path === 'hidden.py').change, 'unknown');
  assert.ok(rows.some(value => value.kind === 'gap' && value.path === 'dependency.py'));
  assert.ok(rows.some(value => value.kind === 'gap' && value.reason.includes('еще не прослежены')));
});

test('large UTF8/CRLF/chunk boundary/long lines retain exact final line coordinates and EOF verification', t => {
  const fx = fixture(t), prefix = `${'Ж🙂'.repeat(120000)}\r\n`;
  const r = inventory(fx, { 'large.py': `${prefix}old\r\ntail\r\n` }, { 'large.py': `${prefix}new\r\ntail\r\n` });
  assert.ok(r.sources.every(value => value.chunkIndexHash));
  const changed = entries(r.coverage).find(value => value.path === 'large.py');
  assert.deepEqual(changed.after.range, { startLine: 2, endLine: 2 });
  const crlf = inventory(fx, { 'eol.py': 'a\r\nb\r\n' }, { 'eol.py': 'a\nb\n' });
  assert.deepEqual(entries(crlf.coverage).find(value => value.path === 'eol.py').after.range, { startLine: 1, endLine: 2 });
  const last = inventory(fx, { 'end.py': 'a\nb' }, { 'end.py': 'a\nc' });
  assert.deepEqual(entries(last.coverage).find(value => value.path === 'end.py').after.range, { startLine: 2, endLine: 2 });
});

test('immutable page chain is bounded and rejects missing/tampered pages, foreign binding and revoked gap paths', t => {
  const fx = fixture(t), files = Object.fromEntries(Array.from({ length: 150 }, (_,i) => [`item-${i}.py`, 'old']));
  const r = inventory(fx, files, Object.fromEntries(Object.keys(files).map(name => [name,'new'])));
  assert.ok(r.coverage.pages.length >= 3); assert.equal(entries(r.coverage).filter(value => value.kind === 'change').length, 150);
  assert.ok(r.coverage.pages.every(page => CoveragePageSchema.safeParse(page).success));
  assert.throws(() => readLearningCoverage({ store: fx.store, material: { ...r.material, resultHash: H }, sources: r.sources }), { code: 'LEARNING_COVERAGE_INTEGRITY' });
  assert.throws(() => readLearningCoverage({ store: fx.store, material: r.material, sources: r.sources, policy: { forbiddenPaths: ['item-1.py'] } }), { code: 'LEARNING_SOURCE_DENIED' });
  const file = path.join(fx.store.graphRoot, 'learning-coverage-pages', `${r.coverage.inventory.firstPageHash}.json`);
  const original = readFileSync(file); const tampered = JSON.parse(original); tampered.data.entries[0].change = 'added'; writeFileSync(file, JSON.stringify(tampered));
  assert.throws(() => readLearningCoverage({ store: fx.store, material: r.material, sources: r.sources }), { code: 'OBJECT_TAMPERED' });
  rmSync(file); assert.throws(() => readLearningCoverage({ store: fx.store, material: r.material, sources: r.sources }));
});

test('legacy V1 reads unchanged, new material binds inventory, reads never rebuild or mutate', t => {
  const fx = fixture(t), saved = fx.create();
  assert.equal(saved.material.version, 2);
  const { coverageHash: _, ...old } = saved.material; old.version = 1;
  const id = fx.store.putObject('learning-materials', old), result = readLearningMaterial(fx.options({ id }));
  assert.equal(result.coverage, undefined); assert.deepEqual(result.material, old);
  fx.store.putObject = () => { throw new Error('Read must not write'); };
  fx.store.readFingerprint = () => { throw new Error('Read must not diff snapshots'); };
  writeFileSync(path.join(fx.root, 'main.py'), 'unrelated live bytes');
  assert.ok(readLearningMaterial(fx.options(saved)).coverage);
});

test('structural links require every span range; duplicate/overlap quotes and wrong source IDs do not fabricate coverage', t => {
  const fx = fixture(t), r = inventory(fx, { 'code.py': 'a\nx\ny\nz' }, { 'code.py': 'a\nu\nv\nz' });
  const value = entries(r.coverage).find(value => value.kind === 'change');
  const anchor = (ref, start, end, quote) => ({ sourceId: ref.sourceId, fileHash: ref.fileHash, startLine: start, endLine: end, quote });
  const a = anchor(value.after,2,2,'u'), b = anchor(value.after,3,3,'v'), c = anchor(value.before,2,3,'x\ny');
  for (const item of [a,b,c]) savedSourceAnchor(fx.store, r.sources.find(source => source.id === item.sourceId), item);
  const lesson = anchors => ({ steps: [{ id: 'step-one', anchors }] });
  const status = anchors => linkLearningCoverage(r.coverage, lesson(anchors), H).links.find(link => link.entryId === value.id).status;
  assert.equal(status([a]),'partial'); assert.equal(status([a,a]),'partial'); assert.equal(status([a,b,c]),'linked');
  assert.equal(status([{...a,sourceId:'wrong-source'}]),'unlinked');
});

test('view rejects invalid/nonexistent/foreign lessons as unavailable links; valid saved lesson links exact anchors', t => {
  const fx = fixture(t), saved = fx.create(), material = readLearningMaterial(fx.options(saved));
  const source = material.sources.find(value => value.role === 'after');
  const anchor = { sourceId: source.id, fileHash: source.fileHash, startLine: 2, endLine: 2, quote: '    return x + 2' };
  const lesson = { version:1, materialHash:saved.id, methodHash:H, title:'Разбор', scope:'main.py', steps:[{ id:'step-one',title:'Возврат',caller:'inc',anchors:[anchor],input:'1',transformations:['Сложение'],output:'3',next:null,purpose:'Результат',changeConsequence:'Изменение',alternatives:[],origin:{kind:'manual-trace',label:'Пример',receiptId:null,artifactId:null,anchor:null}}],questions:[],wholeFlow:'Вход и выход',takeaways:[],limitations:[] };
  let lessonHash = fx.store.putObject('lessons', lesson);
  const state = { schemaVersion:3, ...fx.binding, learning:{stages:{'stage-one':{materialHash:saved.id}},progress:{}},nodes:{},operations:{},workspaceFingerprint:{hash:fx.resultHash} };
  const owner = { state, task:fx.task, plan:fx.plan };
  const host = { store:fx.store, adapters:{},read:()=>owner,executionHistory:()=>[],learningProjection:()=>({lessonHash}) };
  assert.equal(learningMaterial(host,fx.binding.runId,saved.id).coverage.linking,'validated');
  for (const bad of [{...lesson,materialHash:H}, {...lesson,steps:[{...lesson.steps[0],anchors:[{...anchor,quote:'wrong'}]}]}, {...lesson,steps:[{...lesson.steps[0],anchors:[{...anchor,fileHash:H}]}]}]) {
    lessonHash = fx.store.putObject('lessons',bad);
    const result = learningMaterial(host,fx.binding.runId,saved.id); assert.equal(result.coverage.linking,'unavailable');
    assert.ok(result.coverage.links.every(link=>link.status==='unlinked'));
  }
  lessonHash=H; assert.equal(learningMaterial(host,fx.binding.runId,saved.id).coverage.linking,'unavailable');
});

test('final task coverage follows original-to-final after a sequence of effects, not intermediate hunk coordinates', t => {
  const fx=fixture(t), mid=hashObject('intermediate'), finalHash=hashObject('final-sequence');
  fx.capture([fx.save('main.py','temporary = True\ndef inc(x):\n    return x + 2\n','after')],mid);
  const after=fx.capture([fx.save('main.py','temporary = True\n\ndef inc(x):\n    return x + 3\n','after')],finalHash);
  const material=fx.create({kind:'task',stageId:null,after,
    implementationReceiptIds:[fx.receipt('implement','ai-implement',fx.before.sourceHash,mid),fx.receipt('implement','ai-implement',mid,finalHash,{attemptId:'attempt-two',attempt:2})],
    checkReceiptIds:[fx.receipt('check-code','check-verify-code',finalHash,finalHash)],reviewReceiptIds:[fx.receipt('review','ai-review',finalHash,finalHash)]});
  const item=entries(readLearningMaterial(fx.options(material)).coverage).find(row=>row.path==='main.py');
  assert.deepEqual(item.before.range,{startLine:1,endLine:2}); assert.deepEqual(item.after.range,{startLine:1,endLine:4});
  assert.equal(item.after.fileHash,sha256('temporary = True\n\ndef inc(x):\n    return x + 3\n'));
});

test('corrupt final source chunk fails EOF verification before building a new coverage object', async t => {
  const {savedSourceChunkHashes}=await import('./lib/learning-source-storage.mjs');
  const fx=fixture(t), r=inventory(fx,{'chunks.py':'Ж'.repeat(50000)+'\nold'},{'chunks.py':'Ж'.repeat(50000)+'\nnew'});
  const source=r.sources.find(item=>item.role==='after'),last=[...savedSourceChunkHashes(fx.store,source)].at(-1);
  const file=path.join(fx.store.graphRoot,'learning-source-chunks',`${last}.json`),data=JSON.parse(readFileSync(file,'utf8'));
  data.data.text+='tampered';writeFileSync(file,JSON.stringify(data));
  assert.throws(()=>createLearningCoverage({store:fx.store,material:r.material,sources:r.sources,before:r.before,after:r.after}),{code:'OBJECT_TAMPERED'});
});

test('one-sided unknown change can only be partially linked, even when its entire available source is quoted',t=>{
 const fx=fixture(t),r=inventory(fx,{'missing-before.py':{text:'old',skip:true}},{'missing-before.py':'new'});
 const item=entries(r.coverage).find(row=>row.path==='missing-before.py');assert.equal(item.change,'unknown');
 const lesson={steps:[{id:'step-one',anchors:[{sourceId:item.after.sourceId,fileHash:item.after.fileHash,startLine:1,endLine:1,quote:'new'}]}]};
 assert.equal(linkLearningCoverage(r.coverage,lesson,H).links.find(link=>link.entryId===item.id).status,'partial');
});
