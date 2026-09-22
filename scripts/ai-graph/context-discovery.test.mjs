import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveContextRequests } from './lib/context-discovery.mjs';

const file = (path, size = 100) => ({ path, hash: 'a'.repeat(64), size, mode: '100644' });
const task = { scope: ['src/a.ts'], contextPaths: ['package.json'], forbiddenPaths: [], contextDiscovery: true };
const files = [file('src/a.ts'), file('src/b.ts'), file('package.json'), file('docs/guide.md')];
const request = (path, purpose = 'read', reason = 'Нужно проверить зависимость требования.') => ({ path, purpose, reason });
const resolve = (requests, overrides = {}) => resolveContextRequests({ task, files, requests, ...overrides });

test('read requests add only exact context and preserve all prior paths without mutation', () => {
  const originalTask = structuredClone(task);
  const originalFiles = structuredClone(files);
  const result = resolve([request('src/b.ts')]);
  assert.deepEqual(result.scope, ['src/a.ts']);
  assert.deepEqual(result.contextPaths, ['package.json', 'src/b.ts']);
  assert.match(result.notes[0], /src\/b\.ts.*Нужно проверить зависимость требования/);
  assert.deepEqual(task, originalTask);
  assert.deepEqual(files, originalFiles);
});

test('write requests propose contained existing and new paths without changing read declarations', () => {
  const result = resolve([request('src/b.ts', 'write'), request('scripts/release.mjs', 'write')]);
  assert.deepEqual(result.scope, ['scripts/release.mjs', 'src/a.ts', 'src/b.ts']);
  assert.deepEqual(result.contextPaths, ['package.json']);
  assert.equal(result.notes.length, 2);
});

test('explicit directory requests preserve existing narrower paths', () => {
  const result = resolve([request('src', 'read'), request('src', 'write')]);
  assert.deepEqual(result.scope, ['src', 'src/a.ts']);
  assert.deepEqual(result.contextPaths, ['package.json', 'src']);
});

test('read requires an existing safe path, while write can propose a new destination', () => {
  assert.throws(() => resolve([request('new/file.ts')]), { code: 'CONTEXT_REQUEST_INVALID' });
  assert.ok(resolve([request('new/file.ts', 'write')]).scope.includes('new/file.ts'));
});

test('discovery requires immutable task opt-in', () => {
  for (const contextDiscovery of [undefined, false, 'true'])
    assert.throws(() => resolve([request('src/b.ts')], { task: { ...task, contextDiscovery } }), { code: 'CONTEXT_REQUEST_INVALID' });
});

test('private, sensitive, auxiliary, absolute and traversing paths remain unavailable', () => {
  for (const path of ['.git/config', '.ai/state.json', '.ai-orchestrator/state.json', '.codex/config.toml',
    '.claude/settings.json', '.cursor/settings.json', 'node_modules/pkg/index.js', '.env', '.ENV.local',
    'credentials.json', 'private.key', '.flowcairn.json', 'package-lock.json', 'logo.png',
    '../src/b.ts', 'src/../../b.ts', '/src/b.ts', 'C:/src/b.ts', 'src\\b.ts', '.', 'src\n/b.ts']) {
    for (const purpose of ['read', 'write'])
      assert.throws(() => resolve([request(path, purpose)]), { code: 'CONTEXT_REQUEST_INVALID' }, `${purpose}: ${path}`);
  }
});

test('excluded output and forbidden source paths cannot be discovered or generated', () => {
  const options = { outputPaths: ['generated'], task: { ...task, forbiddenPaths: ['internal'] },
    files: [...files, file('generated/current.json'), file('internal/info.ts')] };
  for (const path of ['generated', 'generated/current.json', 'generated/new.json', 'GENERATED/new.json', 'internal/info.ts'])
    for (const purpose of ['read', 'write'])
      assert.throws(() => resolve([request(path, purpose)], options), { code: 'CONTEXT_REQUEST_INVALID' });
});

test('new destinations cannot traverse an existing file or a filesystem-name alias', () => {
  for (const path of ['src/a.ts/new.ts', 'SRC/b.ts', 'SRC/new.ts', 'src/A.ts/new.ts'])
    assert.throws(() => resolve([request(path, 'write')]), { code: 'CONTEXT_REQUEST_INVALID' }, path);
});

test('exact instruction file reads are allowed without opening private skill storage', () => {
  const result = resolve([request('AGENTS.md')], { files: [...files, file('AGENTS.md')] });
  assert.ok(result.contextPaths.includes('AGENTS.md'));
  assert.throws(() => resolve([request('.agents/skills/example/SKILL.md')], {
    files: [...files, file('.agents/skills/example/SKILL.md')],
  }), { code: 'CONTEXT_REQUEST_INVALID' });
});

test('malformed, duplicated, oversized and unrecognized requests are rejected', () => {
  for (const requests of [null, [{}], [{ ...request('src/b.ts'), command: 'run' }],
    [{ ...request('src/b.ts'), purpose: 'execute' }], [request('src/b.ts', 'read', '')],
    [request('src/b.ts'), request('src/b.ts')]])
    assert.throws(() => resolve(requests), { code: 'CONTEXT_REQUEST_INVALID' });
  assert.throws(() => resolve(Array.from({ length: 17 }, (_, index) => request(`new/${index}.ts`, 'write'))),
    { code: 'CONTEXT_REQUEST_LIMIT' });
});

test('old scope and context cannot silently shrink to accommodate limits', () => {
  const originalScope = Array.from({ length: 64 }, (_, index) => `scope-${index}`);
  assert.throws(() => resolve([request('new.ts', 'write')], { task: { ...task, scope: originalScope } }),
    { code: 'CONTEXT_REQUEST_LIMIT' });
  const originalContext = Array.from({ length: 32 }, (_, index) => `context-${index}`);
  assert.throws(() => resolve([request('src/b.ts')], { task: { ...task, contextPaths: originalContext } }),
    { code: 'CONTEXT_REQUEST_LIMIT' });
});

test('external providers apply file-count and byte caps to the entire resulting readable context', () => {
  for (const provider of ['claude', 'cursor']) {
    const manyFiles = Array.from({ length: 257 }, (_, index) => file(`bulk/${index}.ts`));
    assert.throws(() => resolve([request('bulk')], { files: [...files, ...manyFiles], provider }), { code: 'CONTEXT_REQUEST_LIMIT' });
    assert.throws(() => resolve([request('large.ts')], { files: [...files, file('large.ts', 512 * 1024)], provider }),
      { code: 'CONTEXT_REQUEST_LIMIT' });
  }
  assert.ok(resolve([request('large.ts')], { files: [...files, file('large.ts', 512 * 1024)], provider: 'codex' }).contextPaths.includes('large.ts'));
});

test('external byte accounting deduplicates overlapping paths and excludes blocked descendants', () => {
  const minimalTask = { ...task, scope: ['src'], contextPaths: ['src/a.ts'] };
  const result = resolve([request('src')], { task: minimalTask, provider: 'claude', files: [
    file('src/a.ts', 512 * 1024), file('src/.env', 512 * 1024), file('src/AGENTS.md', 512 * 1024),
  ] });
  assert.deepEqual(result.contextPaths, ['src', 'src/a.ts']);
});

test('trusted descriptor contract rejects unknown inventory, duplicate entries and link modes', () => {
  for (const inventory of [null, ['src/a.ts'], [file('src/a.ts'), file('src/a.ts')],
    [{ ...file('src/a.ts'), mode: '120000' }]])
    assert.throws(() => resolve([], { files: inventory }), { code: 'CONTEXT_REQUEST_INVALID' });
});
