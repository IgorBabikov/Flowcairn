import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { startViewer } from '../../tools/ai-graph-viewer/server.mjs';
import { GraphError, hashObject } from './lib/io.mjs';
import { directAdapters } from './lib/direct-adapters.mjs';
import { projectSummary } from './lib/intake.mjs';
import { ProjectProfileSchema, trustedLocalChecksHash } from './lib/project.mjs';
import { gitExecutable, gitNullDevice, hostSystemEnvironment } from './lib/host-executables.mjs';

const token = 'g1b-http-test-token-1234567890';
const materialHash = 'a'.repeat(64);
const fileHash = 'b'.repeat(64);
const runId = 'run-http';
const materialPath = `/api/runs/${runId}/learning/materials/${materialHash}`;
const sourcePath = `${materialPath}/sources/source-one`;
const envelope = { operationId: 'operation-one', expectedRevision: 4, planHash: 'c'.repeat(64) };

async function httpFixture(t) {
  const calls = [];
  const material = { id: materialHash, sources: [{ id: 'source-one', fileHash }], freshness: { state: 'stale', reason: 'Новый этап изменил код' } };
  const source = { sourceId: 'source-one', fileHash, text: '<script>source, not HTML</script>\nconst x = 1;', startLine: 1, endLine: 2, totalLines: 3, next: { startLine: 3, lineCount: 100 } };
  const service = {
    acquireViewerLease: () => () => {},
    close: () => {},
    learningMaterial: (...args) => { calls.push(['material', ...args]); return material; },
    learningSource: (...args) => { calls.push(['source', ...args]); return source; },
    learningObject: (...args) => { calls.push(['unavailable', ...args]); throw new GraphError('NOT_FOUND', 'Учебный объект еще не создан'); },
    command: async (...args) => { calls.push(['command', ...args]); return { runId, revision: 5 }; },
  };
  const server = startViewer({ service, token, port: 0 });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const headers = { 'X-flowcairn-Control': token, Origin: url, 'Content-Type': 'application/json' };
  const get = (resource, options = {}) => fetch(`${url}${resource}`, { headers, ...options });
  const post = (resource, body) => get(resource, { method: 'POST', body: JSON.stringify(body) });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { calls, service, material, source, url, headers, get, post };
}

test('learning GET and controls retain token, exact origin and cross-site guards', async t => {
  const f = await httpFixture(t);
  for (const resource of [materialPath, sourcePath, `/api/runs/${runId}/learning/lessons/${materialHash}`, `/api/runs/${runId}/learning/jobs/job-one`]) {
    for (const headers of [{}, { ...f.headers, Origin: 'https://other.example' }, { ...f.headers, 'Sec-Fetch-Site': 'cross-site' }])
      assert.equal((await f.get(resource, { headers })).status, 403);
  }
  for (const resource of [`/api/runs/${runId}/control/continue-learning`, `/api/runs/${runId}/learning/commands/set-progress`])
    assert.equal((await f.get(resource, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.deepEqual(f.calls, []);
});

test('material and source GET forward bound IDs and return exact saved text without commands', async t => {
  const f = await httpFixture(t);
  const material = await f.get(materialPath);
  assert.equal(material.status, 200);
  assert.deepEqual(await material.json(), f.material);
  const source = await f.get(sourcePath);
  assert.equal(source.status, 200);
  assert.equal(source.headers.get('cache-control'), 'no-store');
  assert.equal(source.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.deepEqual(await source.json(), f.source);
  assert.equal((await f.get(`${sourcePath}?startLine=2&lineCount=200`)).status, 200);
  assert.deepEqual(f.calls, [
    ['material', runId, materialHash],
    ['source', runId, materialHash, 'source-one', { startLine: 1, lineCount: 100 }],
    ['source', runId, materialHash, 'source-one', { startLine: 2, lineCount: 200 }],
  ]);
});

test('pagination refuses malformed, duplicate, unknown and unbounded inputs before reading service data', async t => {
  const f = await httpFixture(t);
  for (const query of [
    'startLine=0', 'startLine=-1', 'startLine=1.5', 'startLine=1e2', 'startLine=01',
    'startLine=', 'startLine=9007199254740992', 'lineCount=0', 'lineCount=201',
    'lineCount=Infinity', 'lineCount=%2B1', 'lineCount=%201',
    'startLine=1&startLine=2', 'lineCount=1&lineCount=1', 'path=secret.txt', 'after=0',
  ]) {
    const response = await f.get(`${sourcePath}?${query}`);
    assert.equal(response.status, 400, query);
    assert.equal((await response.json()).error.code, 'INVALID_REQUEST', query);
  }
  for (const resource of [materialPath, `/api/runs/${runId}/learning/lessons/${materialHash}`, `/api/runs/${runId}/learning/answers/${materialHash}`, `/api/runs/${runId}/learning/jobs/job-one`])
    assert.equal((await f.get(`${resource}?startLine=1`)).status, 400);
  for (const resource of [materialPath.replace(materialHash, 'bad-hash'), `${materialPath}/sources/%2Fetc%2Fpasswd`, `${materialPath}/sources/source_one`, `${materialPath}/sources/source-one/extra`])
    assert.equal((await f.get(resource)).status, 404);
  assert.deepEqual(f.calls, []);
});

test('Continue, mode and progress use existing command envelope without translating user disposition', async t => {
  const f = await httpFixture(t);
  const operations = [
    ['control/continue-learning', 'continue-learning', { ...envelope, holdId: materialHash, disposition: 'continue' }],
    ['control/continue-learning', 'continue-learning', { ...envelope, holdId: materialHash, disposition: 'defer' }],
    ['control/set-learning-mode', 'set-learning-mode', { ...envelope, mode: 'after-task' }],
    ['learning/commands/set-progress', 'set-learning-progress', { ...envelope, materialHash, progress: 'read' }],
  ];
  for (const [route, command, body] of operations) {
    const response = await f.post(`/api/runs/${runId}/${route}`, body);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, result: { runId, revision: 5 } });
    assert.deepEqual(f.calls.at(-1), ['command', runId, command, body, { actor: 'local-operator' }]);
  }
  f.calls.length = 0;
  for (const [route] of operations)
    assert.equal((await f.post(`/api/runs/${runId}/${route}?unknown=true`, envelope)).status, 400);
  assert.deepEqual(f.calls, []);
  assert.equal((await f.post(`/api/runs/${runId}/learning/commands/continue-learning`, envelope)).status, 404);
  assert.equal((await f.post(`/api/runs/${runId}/control/set-learning-progress`, envelope)).status, 404);
});

test('service hold conflicts, policy and page failures preserve concrete errors, never successful empty reads', async t => {
  const f = await httpFixture(t);
  f.service.command = async () => { throw new GraphError('HOLD_CONFLICT', 'Удержание уже заменено'); };
  const conflict = await f.post(`/api/runs/${runId}/control/continue-learning`, { ...envelope, holdId: materialHash, disposition: 'continue' });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, 'HOLD_CONFLICT');
  for (const code of ['LEARNING_PAGE_LIMIT', 'LEARNING_SOURCE_DENIED', 'LEARNING_BINDING', 'STORE_NOT_FOUND']) {
    f.service.learningSource = () => { throw new GraphError(code, 'Сохраненный источник недоступен'); };
    const response = await f.get(sourcePath);
    assert.equal(response.status, code === 'STORE_NOT_FOUND' ? 404 : 400);
    assert.deepEqual(await response.json(), { ok: false, error: { code, message: 'Сохраненный источник недоступен' } });
  }
});

test('unavailable lesson, job and answer reads and denied AI commands cannot pretend to be accepted jobs', async t => {
  const f = await httpFixture(t);
  for (const [resource, kind, id] of [['lessons', 'lesson', materialHash], ['answers', 'answer', materialHash], ['jobs', 'job', 'job-one']]) {
    const response = await f.get(`/api/runs/${runId}/learning/${resource}/${id}`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, 'NOT_FOUND');
    assert.deepEqual(f.calls.at(-1), ['unavailable', runId, kind, id]);
  }
  f.service.command = async (...args) => { f.calls.push(['command', ...args]); throw new GraphError('CONTROL_DENIED', 'Генерация урока пока недоступна'); };
  for (const command of ['generate-lesson', 'ask-lesson']) {
    const body = { ...envelope, materialHash };
    const response = await f.post(`/api/runs/${runId}/learning/commands/${command}`, body);
    assert.equal(response.status, 400);
    const result = await response.json();
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'CONTROL_DENIED');
    assert.equal(result.jobId, undefined);
    assert.deepEqual(f.calls.at(-1), ['command', runId, command, body, { actor: 'local-operator' }]);
  }
});

function projectFixture(t, version, mode, missing = false) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-projection-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, 'verify.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync('probe-ran', 'unexpected');\n");
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'projection-fixture', private: true, scripts: { test: 'node verify.mjs' } }));
  const check = { id: 'verify-project', title: 'Проверить проект', purpose: 'Проверить локальный результат',
    command: { executable: missing ? 'flowcairn-nonexistent-tool' : process.execPath, argv: ['verify.mjs'], cwd: '.' },
    inputPaths: ['verify.mjs'], outputPaths: [], timeoutMs: 5000, maxOutputBytes: 65536 };
  const profile = ProjectProfileSchema.parse({ version, integrationBranch: 'main', workspaceMode: mode === 'direct' || version === 2 ? 'direct' : 'worktree', contextPaths: [], outputPaths: [], manifests: [],
    checks: version === 1 ? ['tests'] : [check.id], checkMode: 'trusted-local', ai: { provider: 'codex', model: 'fixture' },
    ...(version === 1 ? { packageManager: 'npm', ...(missing ? { checkScripts: { tests: 'absent-script' } } : {}) }
      : { checkProfile: { version: 1, requiredCheckIds: [check.id], definitions: [check], environment: [] } }),
  });
  const profileBytes = JSON.stringify(profile);
  writeFileSync(path.join(root, '.flowcairn.json'), profileBytes);
  const git = args => {
    const result = spawnSync(gitExecutable(), args, { cwd: root, encoding: 'utf8', timeout: 10000,
      env: { ...hostSystemEnvironment(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitNullDevice } });
    assert.equal(result.status, 0, result.stderr);
  };
  if (mode === 'intake') {
    git(['init', '-b', 'main']);
    git(['add', '--', '.flowcairn.json', 'package.json', 'verify.mjs']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'Fixture']);
  }
  const base = { project: profile, identity: () => hashObject('http-projection-runtime'), instructionPaths: () => [] };
  const summary = () => mode === 'direct' ? directAdapters(root, profile, base).projectSummary() : projectSummary({ root, adapters: base });
  return { root, profile, profileBytes, summary };
}

for (const version of [1, 2]) for (const mode of ['direct', 'intake']) {
  test(`current ${mode} profile V${version} projects V3 checks without changing profile or consent`, t => {
    for (const missing of [false, true]) {
      const f = projectFixture(t, version, mode, missing);
      const consentBefore = trustedLocalChecksHash(f.root, f.profile);
      const summary = f.summary();
      assert.equal(summary.schemaVersion, 3);
      assert.deepEqual(summary.checkIds, f.profile.checks);
      assert.equal(summary.checks.length, 1);
      assert.equal(summary.checks[0].id, f.profile.checks[0]);
      assert.equal(summary.checks[0].available, !missing);
      assert.ok(summary.checks[0].title && summary.checks[0].purpose);
      assert.match(summary.checks[0].profileHash, /^[a-f0-9]{64}$/);
      assert.equal(summary.toolchain.status, missing ? 'missing' : 'ready');
      assert.equal(summary.toolchain.issues.length > 0, missing);
      assert.equal(trustedLocalChecksHash(f.root, f.profile), consentBefore);
      assert.equal(JSON.stringify(f.profile), f.profileBytes);
      assert.equal(f.summary().contextHash, summary.contextHash);
      assert.equal(existsSync(path.join(f.root, 'probe-ran')), false);
    }
  });
}
