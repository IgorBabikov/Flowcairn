import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { hostSystemEnvironment } from './lib/host-executables.mjs';
import { safeEnvironment } from './lib/runner-ai-command.mjs';
import { hostGroupAlive, inspectHostProcess, listHostProcesses, stopHostGroup } from './lib/host-process.mjs';
import { assertRuntimePlatform, assertProjectPlatform, defaultProvider } from './lib/platform.mjs';
const root = { pid: 100, parentPid: 50, startedAt: '2026-01-01T00:00:00.000Z', executable: 'C:\\Node\\node.exe' };
const child = { ...root, pid: 101, parentPid: 100, startedAt: '2026-01-01T00:00:01.000Z' };
const options = (rows) => ({ platform: 'win32', identity: root, list: () => rows });

test('native Windows Node22 and local drive platform gate', () => {
  assertRuntimePlatform({ platform: 'win32', node: '22.13.1' });
  assert.equal(defaultProvider('win32'), 'codex');
  assert.doesNotThrow(() => assertProjectPlatform('C:\\Projects\\example', { platform: 'win32' }));
  for (const value of ['\\\\server\\share', '//server/share', 'relative/path'])
    assert.throws(() => assertProjectPlatform(value, { platform: 'win32' }), { code: 'WINDOWS_FILESYSTEM' });
});

test('Windows process query uses only the native inspector mode without shell or command lines', () => {
  const rows = listHostProcesses({ tool: () => 'verified-inspector.exe', run: (file, args, config) => {
    assert.equal(file, 'verified-inspector.exe');
    assert.deepEqual(args, ['--inspect-processes']);
    assert.equal(config.shell, false);
    assert.equal('PSModulePath' in config.env, false);
    assert.equal('NODE_OPTIONS' in config.env, false);
    return { status: 0, stdout: JSON.stringify([root, child]) };
  } });
  assert.deepEqual(rows, [root, child]);
  assert.deepEqual(inspectHostProcess(100, options(rows)), root);
});

test('missing identity, disappeared root and PID reuse remain uncertain', () => {
  assert.equal(hostGroupAlive(100, { platform: 'win32', list: () => [root] }), null);
  assert.equal(hostGroupAlive(100, options([])), null);
  assert.equal(hostGroupAlive(100, options([{ ...root, startedAt: child.startedAt }])), null);
  assert.equal(hostGroupAlive(100, options([root])), true);
  assert.equal(stopHostGroup(100, { ...options([{ ...root, startedAt: child.startedAt }]), run: () => { throw Error('Must not kill'); } }), false);
});

test('verified Windows stop targets positive PID tree and checks all observed descendants', () => {
  let reads = 0;
  assert.equal(stopHostGroup(100, { ...options([]), list: () => ++reads <= 2 ? [root, child] : [], tool: (name) => name, run: (file, args) => {
    assert.equal(file, 'taskkill.exe');
    assert.deepEqual(args, ['/PID', '100', '/T', '/F']);
    return { status: 0 };
  } }), true);
  reads = 0;
  assert.equal(stopHostGroup(100, { ...options([]), list: () => ++reads <= 2 ? [root, child] : [child], tool: (name) => name, run: () => ({ status: 0 }) }), false);
});

test('inspection failure, identity drift and newly observed descendants do not prove stop', () => {
  assert.equal(hostGroupAlive(100, { ...options([]), list: () => { throw Error('Native inspection unavailable'); } }), null);
  let reads = 0, kills = 0;
  assert.equal(stopHostGroup(100, { ...options([]), list: () => ++reads === 1 ? [root] : [{ ...root, startedAt: child.startedAt }], run: () => { kills++; return { status: 0 }; } }), false);
  assert.equal(kills, 0);
  reads = 0;
  assert.equal(stopHostGroup(100, { ...options([]), list: () => ++reads <= 2 ? [root] : [child], tool: (name) => name, run: () => ({ status: 0 }) }), false);
});

test('POSIX retains group signals and absence proof', () => {
  assert.equal(hostGroupAlive(100, { platform: 'linux', kill: (pid, signal) => { assert.equal(pid, -100); assert.equal(signal, 0); } }), true);
  assert.equal(hostGroupAlive(100, { platform: 'linux', kill: () => { throw Object.assign(Error(), { code: 'ESRCH' }); } }), false);
  assert.equal(hostGroupAlive(-1, { platform: 'win32' }), null);
});


test('Windows system environment keeps standard install paths without user module overrides or credentials', () => {
  const env = hostSystemEnvironment({ platform: 'win32', env: { SYSTEMROOT: 'C:\\Windows', PROGRAMFILES: 'C:\\Program Files', PSModulePath: 'C:\\user-module', API_KEY: 'must-not-propagate', NODE_OPTIONS: '--require unsafe', PATH: 'C:\\Windows' } });
  assert.equal(env.SystemRoot, 'C:\\Windows');
  assert.equal(env.ProgramFiles, 'C:\\Program Files');
  assert.equal('PSModulePath' in env, false);
  assert.equal('API_KEY' in env, false);
  assert.equal('NODE_OPTIONS' in env, false);
});

test('native Windows process inspection works inside the exact clean supervisor environment', { skip: process.platform !== 'win32', timeout: 30000 }, () => {
  const moduleUrl = new URL('./lib/host-process.mjs', import.meta.url).href;
  const source = `import { inspectHostProcess } from ${JSON.stringify(moduleUrl)}; try { const value = inspectHostProcess(process.pid); if (!value || value.pid !== process.pid || value.parentPid !== process.ppid) throw Error('PROCESS_IDENTITY_UNKNOWN'); process.stdout.write('identity-verified'); } catch (error) { process.stderr.write(error.message); process.exitCode = 1; }`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { env: safeEnvironment(), encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'identity-verified');
});

test('process inspection failures expose fixed stage codes and never raw output', () => {
  for (const [result, message] of [
    [{ status: 1, stderr: 'private error data' }, 'PROCESS_INSPECTION_EXIT_FAILED'],
    [{ status: 0, stdout: 'private non-JSON data' }, 'PROCESS_INSPECTION_OUTPUT_INVALID'],
    [{ error: { code: 'ETIMEDOUT', message: 'private path' } }, 'PROCESS_INSPECTION_TIMEOUT'],
  ]) assert.throws(() => listHostProcesses({ tool: (name) => name, run: () => result }), { message });
});


test('inaccessible identity remains represented but cannot authorize process termination', () => {
  const unknown = { ...child, startedAt: '', executable: '' };
  const rows = listHostProcesses({ tool: () => 'test-inspector', run: () => ({ status: 0, stdout: JSON.stringify([root, unknown]) }) });
  assert.equal(rows.length, 2);
  assert.throws(() => inspectHostProcess(child.pid, options(rows)), { message: 'PROCESS_IDENTITY_UNKNOWN' });
  let killed = false;
  assert.equal(stopHostGroup(root.pid, { ...options(rows), run: () => { killed = true; return { status: 0 }; } }), false);
  assert.equal(killed, false);
});
