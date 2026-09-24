import test from 'node:test';
import assert from 'node:assert/strict';
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

test('Windows process query uses constant encoded script without command lines', () => {
  const rows = listHostProcesses({ tool: (name) => name, run: (file, args, config) => {
    assert.equal(file, 'WindowsPowerShell/v1.0/powershell.exe');
    assert.ok(args.includes('-NoProfile'));
    assert.equal(config.shell, false);
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    assert.match(script, /Get-CimInstance Win32_Process/);
    assert.doesNotMatch(script, /CommandLine/);
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
  assert.equal(hostGroupAlive(100, { ...options([]), list: () => { throw Error('CIM unavailable'); } }), null);
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
