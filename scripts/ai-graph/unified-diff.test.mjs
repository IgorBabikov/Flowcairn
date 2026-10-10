import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports, createRequire } from 'node:module';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unifiedDiff, MAX_DIFF_BYTES, DIFF_TIMEOUT_MS } from './lib/unified-diff.mjs';
import { captureBeforeContents, buildAttemptDiff } from './lib/artifacts.mjs';
import { fingerprintDirectWorkspace } from './lib/direct-workspace.mjs';
import { sha256, hashObject } from './lib/io.mjs';
import { WorkflowService } from './lib/service.mjs';
import { SKILL_ROUTES } from './lib/config.mjs';

const entry = (bytes, mode = '100644') => ({ hash: sha256(bytes), size: bytes.length, mode });
const header = 'diff --git "a/value.txt" "b/value.txt"\n--- "a/value.txt"\n+++ "b/value.txt"\n';
const cases = [
  ['change', 'one\ntwo\nthree\n', 'one\nTWO\nthree\n', '@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n'],
  ['insert', 'one\nthree\n', 'one\ntwo\nthree\n', '@@ -1,2 +1,3 @@\n one\n+two\n three\n'],
  ['delete', 'one\ntwo\nthree\n', 'one\nthree\n', '@@ -1,3 +1,2 @@\n one\n-two\n three\n'],
  ['both EOF missing', 'old', 'new', '@@ -1,1 +1,1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n'],
  ['remove EOF newline', 'same\n', 'same', '@@ -1,1 +1,1 @@\n-same\n+same\n\\ No newline at end of file\n'],
  ['UTF-8 BOM CRLF', '\uFEFFfirst\r\nвторой🙂\r\n', '\uFEFFfirst\r\nновый🙂\r\n', '@@ -1,2 +1,2 @@\n \uFEFFfirst\r\n-второй🙂\r\n+новый🙂\r\n'],
];
for (const [name, before, after, hunks] of cases) test(`exact independent hunks: ${name}`, async () => {
  const old = Buffer.from(before), next = Buffer.from(after);
  assert.equal(await unifiedDiff('value.txt', entry(old), entry(next), old, next), header + hunks);
});

test('add, delete, empty creation and mode-only headers retain applicable Git patch syntax', async () => {
  const empty = Buffer.alloc(0), value = Buffer.from('value\n');
  assert.equal(await unifiedDiff('value.txt', null, entry(value), empty, value),
    'diff --git "a/value.txt" "b/value.txt"\nnew file mode 100644\n--- /dev/null\n+++ "b/value.txt"\n@@ -0,0 +1,1 @@\n+value\n');
  assert.equal(await unifiedDiff('value.txt', entry(value), null, value, empty),
    'diff --git "a/value.txt" "b/value.txt"\ndeleted file mode 100644\n--- "a/value.txt"\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-value\n');
  assert.equal(await unifiedDiff('value.txt', null, entry(empty), empty, empty),
    'diff --git "a/value.txt" "b/value.txt"\nnew file mode 100644\n');
  assert.equal(await unifiedDiff('value.txt', entry(value), entry(value, '100755'), value, value),
    'diff --git "a/value.txt" "b/value.txt"\nold mode 100644\nnew mode 100755\n');
});

test('separated edits retain exactly three context lines and separate hunks', async () => {
  const lines = Array.from({ length: 25 }, (_, i) => String(i + 1));
  const old = Buffer.from(lines.join('\n') + '\n'); lines[1] = 'X'; lines[23] = 'Y';
  const next = Buffer.from(lines.join('\n') + '\n');
  assert.equal(await unifiedDiff('value.txt', entry(old), entry(next), old, next), header +
    '@@ -1,5 +1,5 @@\n 1\n-2\n+X\n 3\n 4\n 5\n@@ -21,5 +21,5 @@\n 21\n 22\n 23\n-24\n+Y\n 25\n');
});

test('Git is an optional independent roundtrip oracle for original bytes', { skip: !existsSync(process.platform === 'win32' ? 'C:\\Program Files\\Git\\cmd\\git.exe' : '/usr/bin/git') }, async t => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'diff-oracle-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = process.platform === 'win32' ? 'C:\\Program Files\\Git\\cmd\\git.exe' : '/usr/bin/git';
  for (const [, before, after] of cases) {
    const old = Buffer.from(before), next = Buffer.from(after);
    writeFileSync(path.join(root, 'value.txt'), old);
    const patch = await unifiedDiff('value.txt', entry(old), entry(next), old, next);
    const applied = childProcess.spawnSync(git, ['-c', 'core.autocrlf=false', 'apply', '-'], { cwd: root, input: patch, encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
    assert.equal(applied.status, 0, applied.stderr);
    assert.deepEqual(readFileSync(path.join(root, 'value.txt')), next);
  }
});

function interceptSpawn(t, callback, action) {
  const original = childProcess.spawn, sync = childProcess.spawnSync;
  const observer = t.mock.method(childProcess, 'spawn', (...args) => callback(original, args));
  const forbidGit = t.mock.method(childProcess, 'spawnSync', (...args) => {
    assert.ok(!/(?:^|[/\\])git(?:\.exe)?$/.test(args[0]), 'Production text diff must not spawn Git');
    return sync(...args);
  });
  syncBuiltinESMExports();
  return Promise.resolve().then(action).finally(() => { observer.mock.restore(); forbidGit.mock.restore(); syncBuiltinESMExports(); });
}

test('a real direct artifact without Git repository or Git process completes and cleanup removes private inputs', async t => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'diff-no-git-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, 'value.py'), 'value = 1\n');
  const before = fingerprintDirectWorkspace(root), saved = captureBeforeContents(root, before,
    { permissions: ['workspace.source.write'], resources: { writes: ['value.py'] } });
  writeFileSync(path.join(root, 'value.py'), 'value = 2\n');
  let child, directory;
  await interceptSpawn(t, (spawn, args) => {
    assert.equal(args[0], process.execPath); directory = args[1][2]; child = spawn(...args); return child;
  }, async () => {
    const result = await buildAttemptDiff(root, before, fingerprintDirectWorkspace(root), saved);
    assert.equal(result.complete, true);
    assert.match(result.content, /-value = 1\n\+value = 2\n/);
    assert.equal(existsSync(path.join(root, '.git')), false);
  });
  assert.equal(child.exitCode, 0); assert.equal(existsSync(directory), false);
});

test('NODE_OPTIONS and NODE_PATH cannot inject code into the fixed worker', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'diff-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const marker = path.join(root, 'injected'), script = path.join(root, 'preload.cjs');
  writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed')`);
  const oldOptions = process.env.NODE_OPTIONS, oldPath = process.env.NODE_PATH;
  process.env.NODE_OPTIONS = `--require ${JSON.stringify(script)}`; process.env.NODE_PATH = root;
  try {
    await interceptSpawn(t, (spawn, args) => {
      assert.equal(args[2].env.NODE_OPTIONS, undefined); assert.equal(args[2].env.NODE_PATH, undefined);
      assert.equal(args[2].shell, false); return spawn(...args);
    }, async () => { assert.match(await unifiedDiff('value.txt', {}, {}, Buffer.from('a\n'), Buffer.from('b\n')), /-a\n\+b/); });
    assert.equal(existsSync(marker), false);
  } finally {
    if (oldOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = oldOptions;
    if (oldPath === undefined) delete process.env.NODE_PATH; else process.env.NODE_PATH = oldPath;
  }
});

test('abort waits for a real spawned worker to close and removes its inputs', async t => {
  const controller = new AbortController(); let child, directory;
  await interceptSpawn(t, (spawn, args) => {
    directory = args[1][2]; child = spawn(...args); child.once('spawn', () => controller.abort()); return child;
  }, async () => assert.rejects(unifiedDiff('value.txt', {}, {}, Buffer.from('old\n'), Buffer.from('new\n'), { signal: controller.signal }), { code: 'DIFF_UNAVAILABLE' }));
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  assert.equal(existsSync(directory), false);
});

test('output overflow rejects partial bytes, kills the child and cleans its directory', async t => {
  let child, directory;
  await interceptSpawn(t, (spawn, args) => {
    directory = args[1][2];
    // Deliberately misbehaving test child exercises the host's independent cap.
    child = spawn(args[0], ['-e', `process.stdout.write(Buffer.alloc(${MAX_DIFF_BYTES + 32},120));setInterval(()=>{},1000)`], args[2]); return child;
  }, async () => assert.rejects(unifiedDiff('value.txt', {}, {}, Buffer.from('old\n'), Buffer.from('new\n')), { code: 'DIFF_UNAVAILABLE' }));
  assert.ok(child.exitCode !== null || child.signalCode !== null); assert.equal(existsSync(directory), false);
});

test('a worker startup error closes and cleans the private attempt directory', async t => {
  let child, directory;
  await interceptSpawn(t, (spawn, args) => {
    directory = args[1][2]; child = spawn(path.join(directory, 'missing-node'), args[1], args[2]); return child;
  }, async () => assert.rejects(unifiedDiff('value.txt', {}, {}, Buffer.from('old\n'), Buffer.from('new\n')), { code: 'DIFF_UNAVAILABLE' }));
  assert.equal(child.pid, undefined); assert.equal(existsSync(directory), false);
});

test('changed private input fails its complete hash check without partial evidence', async t => {
  let directory;
  await interceptSpawn(t, (spawn, args) => {
    directory = args[1][2]; writeFileSync(path.join(directory, 'before'), 'bad\n'); return spawn(...args);
  }, async () => assert.rejects(unifiedDiff('value.txt', {}, {}, Buffer.from('old\n'), Buffer.from('new\n')), { code: 'DIFF_UNAVAILABLE' }));
  assert.equal(existsSync(directory), false);
});

test('hard deadline terminates a silent child without blocking host timers', { timeout: DIFF_TIMEOUT_MS + 5000 }, async t => {
  let child, directory, ticks = 0;
  const interval = setInterval(() => ticks++, 25);
  try {
    await interceptSpawn(t, (spawn, args) => {
      directory = args[1][2]; child = spawn(args[0], ['-e', 'setInterval(()=>{},1000)'], args[2]); return child;
    }, async () => assert.rejects(unifiedDiff('value.txt', {}, {}, Buffer.from('old\n'), Buffer.from('new\n')), { code: 'DIFF_UNAVAILABLE' }));
    assert.ok(ticks > 2, 'The host event loop must remain responsive');
    assert.ok(child.exitCode !== null || child.signalCode !== null); assert.equal(existsSync(directory), false);
  } finally { clearInterval(interval); }
});

test('invalid UTF-8, NUL and an oversized patch cannot leak bytes in an error', async () => {
  for (const [old, next] of [[Buffer.from('old\n'), Buffer.from([255])], [Buffer.from('old\n'), Buffer.from('private-value\0')],
    [Buffer.alloc(2 * 1024 * 1024, 120), Buffer.alloc(2 * 1024 * 1024, 121)]]) {
    await assert.rejects(unifiedDiff('value.txt', {}, {}, old, next), error => error.code === 'DIFF_UNAVAILABLE' && !error.message.includes('private-value'));
  }
});

test('a modified dependency is rejected before its code is imported', t => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'diff-dependency-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const library = path.join(root, 'lib'); mkdirSync(library);
  for (const name of ['diff-worker.mjs', 'source-file-scan.mjs', 'host-filesystem.mjs', 'stream-secret-policy.mjs', 'source-policy.mjs', 'io.mjs'])
    cpSync(path.join(import.meta.dirname, 'lib', name), path.join(library, name));
  const require = createRequire(import.meta.url);
  const dependency = path.join(root, 'node_modules/diff');
  cpSync(path.dirname(require.resolve('diff/package.json')), dependency, { recursive: true });
  cpSync(path.dirname(require.resolve('picomatch/package.json')), path.join(root, 'node_modules/picomatch'), { recursive: true });
  const marker = path.join(root, 'executed');
  const altered = path.join(dependency, 'libesm/diff/base.js');
  writeFileSync(altered, readFileSync(altered, 'utf8') + `\nimport {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'executed');\n`);
  const old = Buffer.from('a\n'), next = Buffer.from('b\n');
  writeFileSync(path.join(root, 'before'), old); writeFileSync(path.join(root, 'after'), next);
  const input = JSON.stringify({ version: 1, before: entry(old), after: entry(next), budget: MAX_DIFF_BYTES });
  writeFileSync(path.join(root, 'input.json'), input);
  const result = childProcess.spawnSync(process.execPath, [path.join(library, 'diff-worker.mjs'), root, sha256(input)], { encoding: 'utf8', timeout: 5000,
    env: { ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}) } });
  assert.equal(result.status, 2); assert.equal(result.stdout, ''); assert.equal(result.stderr, ''); assert.equal(existsSync(marker), false);
});

async function executionFixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'diff-execution-'))), hash = hashObject('fixture');
  let value = 'before', enter, release, receivedSignal;
  const started = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { release = resolve; });
  const fingerprint = () => {
    const files = [{ path: 'src/value.txt', hash: hashObject(value), mode: '100644', size: value.length }];
    const git = { head: hash, indexHash: hash }; return { files, git, hash: hashObject({ files, git }) };
  };
  const service = await WorkflowService.open({ root, adapters: {
    identity: () => hash, skills: () => [...new Set(Object.values(SKILL_ROUTES).flat())].map(id => ({ id, path: `skills/${id}/SKILL.md`, hash })),
    capture: () => ({ manifest: { sourceHash: hash }, bundlePath: 'synthetic' }),
    allocate: () => ({ worktree: root, taskId: 'DIFF-FENCE', attemptId: 1, leaseId: 'fixture', sourceHash: hash }),
    verifyBinding: () => true, fingerprint, captureBefore: () => new Map(),
    inspectChanges: (before, after) => ({ allowed: true, changedFiles: before.hash === after.hash ? [] : ['src/value.txt'], violations: [] }),
    applyEdits: (_worktree, _before, _node, _task, edits) => { if (edits.length) value = edits[0].content; },
    diff: async (_worktree, _before, _after, _contents, options) => { receivedSignal = options.signal; enter(); await held; return { content: 'synthetic complete diff', complete: true }; },
    runner: { ai: { available: true }, checks: { available: true } }, inspectProcess: () => ({ stopped: true }),
    loadSkills: ids => ids.map(name => ({ name, text: 'fixture', hash, path: `skills/${name}/SKILL.md` })),
    execute: async ({ node, onStart }) => {
      await onStart({ pid: process.pid, ticket: 'fixture' });
      const implementation = node.action.id === 'ai-implement';
      return { exitCode: 0, stopped: true, uncertain: false, output: { summary: 'fixture', verdict: 'pass', skillsUsed: node.skills, findings: [], plan: [],
        changedFiles: implementation ? ['src/value.txt'] : [],
        edits: implementation ? [{ path: 'src/value.txt', previousHash: hashObject(value), content: 'after', executable: false }] : [] } };
    },
  } });
  t.after(() => { release(); service.close(); rmSync(root, { recursive: true, force: true }); });
  let s = await service.create({ id: 'DIFF-FENCE', goal: 'Change value', instructions: 'Change value', scope: ['src'], acceptance: ['Value is changed'], checks: [] }, { runId: 'diff-fence' });
  const request = (snapshot, extra = {}) => ({ operationId: `op-${Math.random().toString(36).slice(2)}`, expectedRevision: snapshot.revision, planHash: snapshot.planHash, ...extra });
  s = await service.command(s.runId, 'gate', request(s, { nodeId: 'approve-plan', decision: 'approve', permissions: s.gates[0].requiredPermissions, challenge: s.gates[0].challenge }));
  s = await service.command(s.runId, 'run', request(s, { nodeId: 'analyze' }));
  const running = service.command(s.runId, 'run', request(s, { nodeId: 'implement' }));
  await started;
  return { service, snapshot: s, request, running, release, signal: () => receivedSignal, drift: () => { value = 'external change'; } };
}

for (const event of ['stop', 'workspace-drift', 'ownership-lost']) test(`late async diff cannot pass after ${event}`, async t => {
  const f = await executionFixture(t);
  const current = f.service.snapshot(f.snapshot.runId);
  if (event === 'stop') {
    await f.service.command(current.runId, 'stop', f.request(current)); assert.equal(f.signal().aborted, true);
  } else if (event === 'workspace-drift') f.drift();
  else {
    const state = f.service.store.readRun(current.runId);
    f.service.store.updateRun(state.runId, state.revision, stored => ({ ...stored,
      activeOperation: { ...stored.activeOperation, id: 'replacement-owner' } }));
  }
  f.release(); await Promise.allSettled([f.running]);
  const state = f.service.store.readRun(current.runId), node = state.nodes.implement;
  assert.notEqual(node.status, 'passed');
  assert.equal(node.receipts.some(id => {
    const receipt = f.service.store.readObject('receipts', id); return receipt.phase === 'finished' && receipt.verdict === 'pass';
  }), false);
  assert.equal(node.artifacts.length, 0, 'A late result must not commit diff artifacts');
});

test('Executor awaits diff before storing actual artifact content and a pass receipt', async t => {
  const f = await executionFixture(t);
  const before = f.service.store.readRun(f.snapshot.runId);
  assert.equal(before.nodes.implement.status, 'running'); assert.equal(before.nodes.implement.artifacts.length, 0);
  f.release(); await f.running;
  const after = f.service.store.readRun(f.snapshot.runId), node = after.nodes.implement;
  assert.equal(node.status, 'passed');
  const diff = node.artifacts.map(id => f.service.artifact(after.runId, id)).find(artifact => artifact.kind === 'diff');
  assert.equal(diff.content, 'synthetic complete diff');
  const receipt = f.service.store.readObject('receipts', node.receipts.at(-1));
  assert.equal(receipt.verdict, 'pass'); assert.ok(receipt.afterFingerprint);
});
