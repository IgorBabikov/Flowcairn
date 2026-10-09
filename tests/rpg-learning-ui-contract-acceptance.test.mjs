import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { hashObject, sha256 } from '../scripts/ai-graph/lib/io.mjs';

// Pure TS modules only, bundled in memory. No browser, application build, dist or live transport.
const bundle = await build({ stdin: { contents: `export * from './content-command'; export * from './learning-api';`,
  resolveDir: fileURLToPath(new URL('../tools/ai-graph-viewer/src/learning/', import.meta.url)), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'esm' });
const ui = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const resolveDir = fileURLToPath(new URL('../tools/ai-graph-viewer/src/learning/', import.meta.url));
const require = createRequire(import.meta.url);
const hooks = await build({ stdin: { contents: "export { useBoundRead } from './use-bound-read'; export { seed } from 'qa-hook-state';", resolveDir, loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'esm', plugins: [{ name: 'seeded-hook-state', setup(build) {
    build.onResolve({ filter: /^(react|qa-hook-state)$/ }, () => ({ path: 'state', namespace: 'qa-hook-state' }));
    build.onLoad({ filter: /.*/, namespace: 'qa-hook-state' }, () => ({ contents: `let states=[],index=0;
      export const seed=value=>{states=value;index=0;}; export const useState=()=>[states[index++],()=>{}];
      export const useEffect=()=>{}; export const useCallback=callback=>callback;` }));
  } }] });
const hook = await import(`data:text/javascript;base64,${Buffer.from(hooks.outputFiles[0].text).toString('base64')}`);
const panel = await build({ stdin: { contents: `import {createElement} from 'react'; import {renderToStaticMarkup} from 'react-dom/server';
    import {SavedSourcePanel} from './SavedSourcePanel'; import {seedRead} from 'qa-cached-read';
    export const render=(props,result)=>{seedRead(result);return renderToStaticMarkup(createElement(SavedSourcePanel,props));};`, resolveDir, loader: 'tsx' },
  bundle: true, write: false, platform: 'node', format: 'esm', jsx: 'automatic', plugins: [{ name: 'cached-read-render', setup(build) {
    build.onResolve({ filter: /^(\.\/use-bound-read|qa-cached-read)$/ }, () => ({ path: 'read', namespace: 'qa-cached-read' }));
    build.onLoad({ filter: /.*/, namespace: 'qa-cached-read' }, () => ({ contents: `let result;export const seedRead=value=>{result=value;};
      export const useBoundRead=()=>result;export const learningReadMessage=error=>error.message;` }));
    build.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
  } }] });
const sourcePanel = await import(`data:text/javascript;base64,${Buffer.from(panel.outputFiles[0].text).toString('base64')}`);
const H = 'a'.repeat(64), allowed = { allowed: true, reason: null };

function fixture() {
  const text = 'x=2\n';
  const source = { id: 'source-one', path: 'saved.custom', fileHash: sha256(text), bytes: Buffer.byteLength(text), mode: '100644', role: 'after',
    chunkHashes: [hashObject({ version: 1, text })], lineCount: 2 };
  const material = { version: 1, kind: 'stage', runId: 'owner-run', planHash: H, taskHash: H, contractHash: H, stageId: 'stage-one',
    goal: 'Прочитать сохраненный код', outcome: 'Код сохранен', requirementIds: ['req-one'], beforeHash: H, resultHash: H,
    createdAt: '2026-10-09T00:00:00.000Z', sourceCatalogHash: hashObject({ version: 1, sources: [source] }),
    implementationReceiptIds: [H], checkReceiptIds: [H], reviewReceiptIds: [], diffArtifactIds: [], findingsArtifactIds: [], status: 'complete', gaps: [] };
  const materialHash = hashObject(material), anchor = { sourceId: source.id, fileHash: source.fileHash, startLine: 1, endLine: 1, quote: 'x=2' };
  const response = { id: materialHash, material, sources: [source], progress: 'read', freshness: { state: 'unknown', reason: null }, lessonHash: H,
    capabilities: { generateLesson: allowed, askLesson: allowed, setLearningProgress: allowed } };
  const snapshot = { schemaVersion: 3, runId: 'view-run', revision: 7, planHash: H, status: 'learning-hold', nodes: [], edges: [], gates: [],
    integrity: { valid: false, reason: 'RUNTIME_DRIFT' }, execution: { state: 'idle', stopRequested: false },
    capabilities: { openLearning: allowed, continueLearning: { allowed: false, reason: 'Runtime drift' }, setLearningMode: { allowed: false, reason: 'Runtime drift' } },
    approvalExpiresAt: null, continuation: { kind: 'learning-hold', holdId: H, stageId: 'stage-one', boundaryReceiptId: H, resultHash: H, createdAt: material.createdAt, materialHash },
    learning: { version: 1, mode: 'after-stage', stages: [{ id: 'stage-one', title: 'Этап', outcome: 'Результат', requirementIds: ['req-one'], status: 'verified',
      checkedResultHash: H, freshness: 'unknown', materialHash, materialStatus: 'complete', lessonHash: H, lessonStatus: 'ready', progress: 'read', reason: null }], finalMaterialHash: null, activeJob: null } };
  return { response, snapshot, anchor, materialHash };
}

test('current openLearning denial revokes cached material actions without confusing it with execution-only drift', t => {
  const f = fixture();
  const intents = [{ action: 'generate-lesson' }, { action: 'ask-lesson', lessonHash: H, anchor: f.anchor, question: 'Какое значение?' },
    { action: 'set-progress', progress: 'read' }];
  assert.deepEqual(intents.map(intent => ui.contentCapability(f.snapshot, 'view-run', f.response, intent).allowed), [true, true, true],
    'A valid read capability must survive execution-only runtime drift');
  f.snapshot.capabilities.openLearning = { allowed: false, reason: 'LEARNING_SOURCE_DENIED: policy changed' };
  const permissions = intents.map(intent => ({ action: intent.action, allowed: ui.contentCapability(f.snapshot, 'view-run', f.response, intent).allowed }));
  t.diagnostic(JSON.stringify({ scenario: 'same run/revision; cached material but fresh openLearning=false', permissions }));
  assert.deepEqual(permissions.map(item => item.allowed), [false, false, false], 'Stale material capabilities must not override current read denial');
});

test('material reload uses required progress without POST; uncertain learning response replays the exact body and rejects a late question mismatch', async () => {
  const f = fixture(), calls = [];
  let response = f.response, posts = 0;
  const api = ui.createLearningApi(async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ?? null });
    if (init?.method === 'POST') return ++posts === 1 ? { jobId: 'wrong-envelope' } : { ok: true, result: { jobId: 'job-one', snapshot: f.snapshot } };
    return response;
  });
  for (const progress of ['read', 'deferred', 'unread']) {
    response = { ...f.response, progress };
    const loaded = await api.learningMaterial('view-run', f.materialHash);
    assert.equal(loaded.progress, progress); assert.equal(loaded.material.runId, 'owner-run');
  }
  response = { ...f.response }; delete response.progress;
  await assert.rejects(api.learningMaterial('view-run', f.materialHash), error => error.code === 'INVALID_LEARNING_DATA');
  assert.equal(posts, 0); assert.ok(calls.every(call => call.method === 'GET'));
  const operation = ui.contentOperation(f.snapshot, f.response, { action: 'generate-lesson' }, 'generate-once');
  await assert.rejects(api.generateLesson('view-run', operation.request), error => error.code === 'LEARNING_RESPONSE_UNCERTAIN' && error.retryable === true);
  f.snapshot.revision = 19;
  assert.equal((await api.generateLesson('view-run', operation.request)).jobId, 'job-one');
  const sent = calls.filter(call => call.method === 'POST');
  assert.deepEqual(sent[0], sent[1]); assert.equal(JSON.parse(sent[1].body).expectedRevision, 7);
  const answer = { version: 1, materialHash: f.materialHash, lessonHash: H, anchor: f.anchor, question: 'Первый вопрос', text: 'Ответ', anchors: [f.anchor], limitations: [] };
  response = answer;
  await assert.rejects(api.learningAnswer('view-run', hashObject(answer), f.response, { lessonHash: H, anchor: f.anchor, question: 'Новый вопрос' }),
    error => error.code === 'INVALID_LEARNING_DATA');
});

test('disabled bound read hides an already cached source instead of rendering text and an enabled Copy action', t => {
  const f = fixture(), source = f.response.sources[0];
  const page = { sourceId: source.id, fileHash: source.fileHash, text: 'x=2\n', startLine: 1, endLine: 2, totalLines: 2, next: null };
  // Seed the actual hook's two state slots as after a completed read. Effects do not run during render.
  // This is deterministic hook-state + real React SSR evidence, not a mounted browser test.
  const state = { key: 'cached-page', attempt: 0, result: { state: 'ready', data: page, error: null } };
  hook.seed([0, state]);
  assert.equal(hook.useBoundRead('cached-page', () => assert.fail('No GET during render'), true).data, page);
  hook.seed([0, state]);
  const disabled = hook.useBoundRead('cached-page', () => assert.fail('Read denied'), false);
  const html = sourcePanel.render({ runId: 'view-run', material: f.response, selection: null, onSelect: () => {},
    canRead: false, deniedReason: 'LEARNING_SOURCE_DENIED', freshness: 'unknown' }, disabled);
  const copy = html.match(/<button\b[^>]*aria-label="Копировать показанные строки"[^>]*>/)?.[0];
  t.diagnostic(JSON.stringify({ retainedData: disabled.data !== null, codeRendered: html.includes('class="saved-code"'), copyEnabled: Boolean(copy && !copy.includes('disabled')) }));
  assert.equal(disabled.data, null, 'enabled=false must not expose cached saved bytes to view consumers');
  assert.ok(!html.includes('class="saved-code"'));
  assert.ok(!copy || copy.includes('disabled'));
});
