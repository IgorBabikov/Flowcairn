import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { buildTaskContext, initialTaskContext } from './lib/task-context.mjs';

const CONTEXT_HASH = 'a'.repeat(64);
const DEFAULT_FILES = ['package.json', 'src/a.ts', 'src/b.ts'];

test('external providers begin with a manifest instead of serializing a broad source tree', () => {
  const preview = { scope: ['src'], candidates: ['package.json', 'src'], references: [{ reference: 'src', status: 'resolved', matches: ['src'] }], feedback: [] };
  for (const provider of ['claude', 'cursor']) {
    const initial = initialTaskContext(preview, { ai: { provider } });
    assert.deepEqual(initial.scope, ['package.json']);
    assert.match(initial.notes[0], /contextRequests/);
    assert.deepEqual(initialTaskContext(preview, { ai: { provider } }, true).scope, ['src']);
  }
});

function input(description, overrides = {}) {
  const files = overrides.files === undefined ? DEFAULT_FILES : overrides.files;
  const candidates = files === null ? ['src', 'package.json'] :
    [...new Set(files.map((file) => file.split('/')[0]))].sort();
  return {
    fields: { title: 'Изменение проекта', description, taskNumber: 'TASK-1' },
    project: { contextHash: CONTEXT_HASH, scopeCandidates: candidates, contextPaths: ['package.json'] },
    files,
    ...overrides,
  };
}

function select(request, scope, resolutions = []) {
  const preview = buildTaskContext(request);
  return buildTaskContext({ ...request, selection: { previewHash: preview.previewHash, scope, resolutions } });
}

function reference(preview, name) {
  const entry = preview.references.find((item) => item.reference === name);
  assert.ok(entry, `Expected a reference for ${name}`);
  return entry;
}

test('task context reads title and selects an exact existing file without sibling write scope', () => {
  const preview = buildTaskContext(input('Исправить указанную функцию и сохранить поведение.', {
    fields: { title: 'Исправить src/a.ts', description: 'Исправить указанную функцию и сохранить поведение.', taskNumber: 'TASK-1' },
  }));
  assert.equal(preview.ready, true);
  assert.deepEqual(preview.scope, ['src/a.ts']);
  assert.equal(reference(preview, 'src/a.ts').status, 'resolved');
  assert.ok(!preview.scope.includes('src'));
});

test('an explicitly requested directory keeps siblings when a child file is also mentioned', () => {
  const preview = buildTaskContext(input('Обновить все файлы src/modules и src/modules/foo/index.ts.', {
    files: ['src/modules/foo/index.ts', 'src/modules/bar/index.ts', 'src/other/index.ts'],
  }));
  assert.equal(preview.ready, true);
  assert.ok(preview.scope.includes('src/modules'));
  assert.ok(!preview.scope.includes('src'));
  assert.ok(!preview.scope.includes('src/other'));
});

test('many project roots do not prevent selecting one exact file', () => {
  const files = Array.from({ length: 80 }, (_, i) => `area-${i}/entry.ts`);
  const preview = buildTaskContext(input('Изменить area-37/entry.ts.', { files }));
  assert.equal(preview.ready, true);
  assert.deepEqual(preview.scope, ['area-37/entry.ts']);
});

test('one resolved reference does not hide another missing source file', () => {
  const preview = buildTaskContext(input('Перенести missing.json и обновить src/a.ts.'));
  assert.equal(preview.ready, false);
  assert.equal(reference(preview, 'missing.json').status, 'missing');
  assert.equal(reference(preview, 'src/a.ts').status, 'resolved');
  assert.ok(preview.issues.length > 0);
});

test('a new destination requires explicit creation and can create a new directory', () => {
  const request = input('Добавить scripts/release.mjs.');
  const preview = buildTaskContext(request);
  assert.equal(preview.ready, false);
  assert.equal(reference(preview, 'scripts/release.mjs').status, 'missing');
  const resolved = select(request, ['scripts/release.mjs'], [
    { reference: 'scripts/release.mjs', kind: 'create', path: 'scripts/release.mjs' },
  ]);
  assert.equal(resolved.ready, true);
  assert.deepEqual(resolved.scope, ['scripts/release.mjs']);
  assert.ok(!resolved.scope.includes('src'));
  assert.ok(!resolved.scope.includes('package.json'));
});

test('an example reference can be dismissed without gaining a write path', () => {
  const request = input('Исправить src/a.ts; example.json приведен только как пример.');
  const resolved = select(request, ['src/a.ts'], [{ reference: 'example.json', kind: 'example' }]);
  assert.equal(resolved.ready, true);
  assert.deepEqual(resolved.scope, ['src/a.ts']);
  assert.ok(!resolved.scope.includes('example.json'));
});

test('ambiguous basename requires an exact existing choice', () => {
  const request = input('Обновить locale.json.', {
    files: ['src/one/locale.json', 'src/two/locale.json', 'package.json'],
  });
  const preview = buildTaskContext(request);
  assert.equal(preview.ready, false);
  assert.equal(reference(preview, 'locale.json').status, 'ambiguous');
  assert.deepEqual(reference(preview, 'locale.json').matches.sort(), ['src/one/locale.json', 'src/two/locale.json']);
  const resolved = select(request, ['src/two/locale.json'], [
    { reference: 'locale.json', kind: 'existing', path: 'src/two/locale.json' },
  ]);
  assert.equal(resolved.ready, true);
  assert.deepEqual(resolved.scope, ['src/two/locale.json']);
});

test('filename suffixes are not interpreted as separate references', () => {
  const preview = buildTaskContext(input('Изменить src/customer.ts.', {
    files: ['src/customer.ts', 'lib/tomer.ts'],
  }));
  assert.equal(preview.ready, true);
  assert.deepEqual(preview.scope, ['src/customer.ts']);
  assert.ok(!preview.references.some((item) => item.reference === 'tomer.ts'));
});

test('an explicit case-sensitive path does not resolve to another file casing', () => {
  const files = ['src/Foo.ts', 'src/foo.ts'];
  const upper = buildTaskContext(input('Изменить src/Foo.ts.', { files }));
  const lower = buildTaskContext(input('Изменить src/foo.ts.', { files }));
  assert.equal(upper.ready, true);
  assert.equal(lower.ready, true);
  assert.deepEqual(upper.scope, ['src/Foo.ts']);
  assert.deepEqual(lower.scope, ['src/foo.ts']);
});

test('excluded output paths remain unavailable even if listed as existing', () => {
  const request = input('Перенести dictionaries/locale.json и исправить src/a.ts.', {
    files: [...DEFAULT_FILES, 'dictionaries/locale.json'], outputPaths: ['dictionaries'],
  });
  const preview = buildTaskContext(request);
  assert.equal(preview.ready, false);
  assert.equal(reference(preview, 'dictionaries/locale.json').status, 'unavailable');
  assert.ok(!preview.scope.includes('dictionaries/locale.json'));
  assert.throws(() => select(request, ['dictionaries/locale.json'], [
    { reference: 'dictionaries/locale.json', kind: 'existing', path: 'dictionaries/locale.json' },
  ]), { code: 'INTAKE_SCOPE' });
});

test('excluded new destinations cannot be authorized as creation', () => {
  const request = input('Добавить dist/report.json.', { outputPaths: ['dist'] });
  assert.throws(() => select(request, ['dist/report.json'], [
    { reference: 'dist/report.json', kind: 'create', path: 'dist/report.json' },
  ]), { code: 'INTAKE_SCOPE' });
});

test('forbidden paths cannot be selected through an existing reference', () => {
  const request = input('Исправить src/a.ts.', { forbiddenPaths: ['src/a.ts'] });
  const preview = buildTaskContext(request);
  assert.equal(preview.ready, false);
  assert.equal(reference(preview, 'src/a.ts').status, 'unavailable');
  assert.throws(() => select(request, ['src/a.ts']), { code: 'INTAKE_SCOPE' });
});

test('sensitive and private paths cannot enter scope through client selection', () => {
  const request = input('Исправить src/a.ts.');
  for (const candidate of ['.ENV', '.env.local', '.npmrc', 'credentials.json', 'keys/private.pem',
    '.ai-orchestrator/state.json', '.git/config', '.codex/config.toml', 'node_modules/pkg/index.js']) {
    assert.throws(() => select(request, [candidate]), { code: 'INTAKE_SCOPE' }, candidate);
  }
});

test('scope and resolution destinations reject absolute and traversing paths', () => {
  const request = input('Добавить new.json.');
  for (const candidate of ['../new.json', 'src/../../new.json', '/tmp/new.json', 'C:/new.json', 'src\\new.json']) {
    assert.throws(() => select(request, [candidate], [
      { reference: 'new.json', kind: 'create', path: candidate },
    ]), { code: 'INTAKE_SCOPE' }, candidate);
  }
});

test('an existing resolution cannot name a nonexistent path', () => {
  const request = input('Перенести missing.json.');
  assert.throws(() => select(request, ['missing.json'], [
    { reference: 'missing.json', kind: 'existing', path: 'missing.json' },
  ]), { code: 'INTAKE_SCOPE' });
});

test('preview binding is deterministic and independent of chosen resolution', () => {
  const request = input('Обновить locale.json.', { files: ['a/locale.json', 'b/locale.json'] });
  const original = buildTaskContext(request);
  const reordered = buildTaskContext({ ...request, files: [...request.files].reverse() });
  const resolved = select(request, ['a/locale.json'], [{ reference: 'locale.json', kind: 'existing', path: 'a/locale.json' }]);
  assert.match(original.previewHash, /^[a-f0-9]{64}$/);
  assert.equal(original.contextHash, CONTEXT_HASH);
  assert.equal(reordered.previewHash, original.previewHash);
  assert.equal(resolved.previewHash, original.previewHash);
});

test('selection cannot be replayed against changed task text or inventory', () => {
  const request = input('Исправить src/a.ts.');
  const preview = buildTaskContext(request);
  const selection = { previewHash: preview.previewHash, scope: ['src/a.ts'], resolutions: [] };
  for (const changed of [
    { ...request, fields: { ...request.fields, description: 'Удалить src/a.ts.' } },
    { ...request, fields: { ...request.fields, title: 'Другая цель' } },
    { ...request, files: [...request.files, 'src/new.ts'] },
    { ...request, project: { ...request.project, contextHash: 'b'.repeat(64) } },
  ]) {
    assert.throws(() => buildTaskContext({ ...changed, selection }), { code: 'STALE_CONTEXT' });
  }
});

test('a fabricated preview hash cannot authorize a scope', () => {
  assert.throws(() => buildTaskContext({ ...input('Исправить src/a.ts.'), selection: {
    previewHash: '0'.repeat(64), scope: ['src/a.ts'], resolutions: [],
  } }), { code: 'STALE_CONTEXT' });
});

test('metadata-only adapters can choose a known candidate without claiming exact file inventory', () => {
  const request = input('Изменить src.', { files: null });
  const resolved = select(request, ['src']);
  assert.equal(resolved.ready, true);
  assert.deepEqual(resolved.scope, ['src']);
});

test('URLs, email addresses and version numbers do not invent source references', () => {
  const preview = buildTaskContext(input('Исправить src/a.ts для версии 19.2.0. ' +
    'Документация: https://example.com/docs/missing.ts и mailto:author@example.com; контакт user@example.org.'));
  assert.equal(preview.ready, true);
  assert.deepEqual(preview.scope, ['src/a.ts']);
  assert.deepEqual(preview.references.map((item) => item.reference), ['src/a.ts']);
});

test('known extensionless filenames and explicitly named extensionless paths are exact references', () => {
  for (const name of ['Dockerfile', 'Makefile', 'scripts/deploy']) {
    const preview = buildTaskContext(input(`Обновить ${name}.`, { files: [...DEFAULT_FILES, name] }));
    assert.equal(preview.ready, true, name);
    assert.deepEqual(preview.scope, [name]);
    assert.equal(reference(preview, name).status, 'resolved');
  }
});

test('missing Dockerfile and extensionless destination paths require clarification', () => {
  for (const name of ['Dockerfile', 'src/Dockerfile', 'scripts/deploy']) {
    const preview = buildTaskContext(input(`Добавить ${name}.`));
    assert.equal(preview.ready, false, name);
    assert.equal(reference(preview, name).status, 'missing');
  }
});

test('unknown and duplicate resolutions cannot overwrite the interpretation of a reference', () => {
  const request = input('Добавить missing.json и исправить src/a.ts.');
  for (const resolutions of [
    [{ reference: 'unmentioned.json', kind: 'example' }],
    [{ reference: 'missing.json', kind: 'example' }, { reference: 'missing.json', kind: 'create', path: 'missing.json' }],
    [{ reference: 'missing.json', kind: 'existing' }],
    [{ reference: 'missing.json', kind: 'create' }],
    [{ reference: 'missing.json', kind: 'execute', path: 'missing.json' }],
    [{ reference: 'missing.json', kind: 'example', permissions: ['workspace.source.write'] }],
  ]) {
    assert.throws(() => select(request, ['src/a.ts', 'missing.json'], resolutions), { code: 'INTAKE_SCOPE' });
  }
});

test('duplicate scope, empty scope and special one-character roots remain invalid', () => {
  const request = input('Исправить src/a.ts.');
  for (const scope of [[], ['src/a.ts', 'src/a.ts'], ['.'], ['/'], ['\\']]) {
    assert.throws(() => select(request, scope), { code: 'INTAKE_SCOPE' });
  }
});

test('create resolution cannot overwrite an existing file or turn a file into a directory', () => {
  const request = input('Добавить missing.json.');
  for (const candidate of ['src/a.ts', 'src/a.ts/new.json']) {
    assert.throws(() => select(request, [candidate], [
      { reference: 'missing.json', kind: 'create', path: candidate },
    ]), { code: 'INTAKE_SCOPE' });
  }
});

test('a parent scope containing both basename matches does not resolve ambiguity', () => {
  const request = input('Исправить locale.json в src.', {
    files: ['src/one/locale.json', 'src/two/locale.json'],
  });
  const preview = select(request, ['src']);
  assert.equal(preview.ready, false);
  assert.equal(reference(preview, 'locale.json').status, 'ambiguous');
  const exact = select(request, ['src/two/locale.json']);
  assert.equal(exact.ready, true);
  assert.equal(reference(exact, 'locale.json').status, 'resolved');
});

test('metadata-only adapters cannot assert existence or absence through a file resolution', () => {
  const request = input('Исправить src/a.ts.', { files: null });
  for (const kind of ['existing', 'create']) {
    assert.throws(() => select(request, ['src'], [
      { reference: 'src/a.ts', kind, path: 'src/a.ts' },
    ]), { code: 'INTAKE_SCOPE' }, kind);
  }
});

test('an excluded reference can be clarified as a constraint without permitting access', () => {
  const request = input('Исправить src/a.ts, не читать .env.');
  const preview = select(request, ['src/a.ts'], [{ reference: '.env', kind: 'example' }]);
  assert.equal(preview.ready, true);
  assert.deepEqual(preview.scope, ['src/a.ts']);
  for (const kind of ['existing', 'create']) {
    assert.throws(() => select(request, ['src/a.ts', '.env'], [
      { reference: '.env', kind, path: '.env' },
    ]), { code: 'INTAKE_SCOPE' }, kind);
  }
});

test('20,000-file preview completes within a bounded worker without granting siblings', async () => {
  const moduleUrl = new URL('./lib/task-context.mjs', import.meta.url).href;
  const script = `
    import { parentPort } from 'node:worker_threads';
    import { buildTaskContext } from ${JSON.stringify(moduleUrl)};
    const files = Array.from({ length: 20000 }, (_, index) => 'src/area-' + index + '/entry.ts');
    const result = buildTaskContext({
      fields: { title: 'Исправление', description: 'Исправить src/area-19777/entry.ts.', taskNumber: 'T-1' },
      project: { contextHash: '${CONTEXT_HASH}', scopeCandidates: ['src'], contextPaths: [] },
      files,
    });
    parentPort.postMessage({ ready: result.ready, scope: result.scope });
  `;
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(script)}`));
  let timer;
  try {
    const result = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('20,000-file context preview exceeded 5 seconds')), 5000);
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.once('exit', (code) => {
        if (code !== 0) reject(new Error(`Context preview worker exited with ${code}`));
      });
    });
    assert.equal(result.ready, true);
    assert.deepEqual(result.scope, ['src/area-19777/entry.ts']);
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
});
