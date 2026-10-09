import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { checkFileIdentity, resolveCheckExecutable } from './lib/check-toolchain.mjs';
import { inspectProjectChecks } from './lib/check-profile.mjs';
import { checkExecutionHash } from './lib/check-execution.mjs';
import { hashObject, sha256 } from './lib/io.mjs';

const fullDevice = 0xabcdeff123456789n, lowDevice = 0x23456789n;

/** Exercise production path/descriptor comparisons and the existing Windows
 * bridge with deterministic Node22 stat shapes; real bytes remain on disk.
 * This is not a native Windows execution claim. */
function windowsFixture(t, { pathDevice = fullDevice, pathChange = () => ({}), handleChange = () => ({}) } = {}, run) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flowcairn-check-stat-')));
  const file = path.join(root, 'verifier.exe'), text = 'synthetic verifier bytes\n';
  fs.writeFileSync(file, text, { mode: 0o755 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = Object.fromEntries(['lstatSync', 'fstatSync', 'openSync', 'closeSync', 'readFileSync', 'readSync'].map(key => [key, fs[key]]));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const handles = new Set();
  const calls = { path: 0, handle: 0, opened: 0, closed: 0, read: false };
  const copy = (stat, changes) => Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, changes);
  const selected = name => typeof name === 'string' && path.resolve(name) === file;
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    fs.lstatSync = (name, options) => {
      const stat = original.lstatSync(name, options);
      if (!selected(name)) return stat;
      calls.path++;
      return copy(stat, { dev: typeof stat.dev === 'bigint' ? pathDevice : Number(pathDevice), ...pathChange(calls, stat) });
    };
    fs.openSync = (...args) => {
      const fd = original.openSync(...args);
      if (selected(args[0])) { handles.add(fd); calls.opened++; }
      return fd;
    };
    fs.fstatSync = (fd, options) => {
      const stat = original.fstatSync(fd, options);
      if (!handles.has(fd)) return stat;
      calls.handle++;
      return copy(stat, { dev: typeof stat.dev === 'bigint' ? lowDevice : Number(lowDevice), ...handleChange(calls, stat) });
    };
    fs.readFileSync = (...args) => {
      const bytes = original.readFileSync(...args);
      if (handles.has(args[0])) calls.read = true;
      return bytes;
    };
    fs.readSync = (...args) => {
      const count = original.readSync(...args);
      if (handles.has(args[0]) && count) calls.read = true;
      return count;
    };
    fs.closeSync = fd => {
      if (handles.delete(fd)) calls.closed++;
      return original.closeSync(fd);
    };
    syncBuiltinESMExports();
    run({ root, file, text, calls });
    assert.equal(calls.closed, calls.opened, 'Every opened fixture descriptor must close.');
  } finally {
    for (const fd of handles) original.closeSync(fd);
    Object.assign(fs, original);
    Object.defineProperty(process, 'platform', platform);
    syncBuiltinESMExports();
  }
}

for (const pathDevice of [fullDevice, 0n]) test(`unchanged Windows file remains bound when path dev is ${pathDevice === 0n ? 'missing' : '64-bit'}`, t => {
  windowsFixture(t, { pathDevice }, ({ root, file, text, calls }) => {
    assert.equal(checkFileIdentity(file).hash, sha256(text));
    const executable = resolveCheckExecutable(root, file);
    assert.equal(executable.executable, file); assert.equal(executable.canonicalPath, file);
    assert.equal(executable.hash, sha256(text));
    assert.equal(executable.bytes, Buffer.byteLength(text));
    assert.equal(executable.invocationIdentityHash.length, 64);
    assert.ok(calls.opened >= (pathDevice === 0n ? 6 : 2), 'Missing dev must be bridged through stable handles.');
  });
});

test('missing Windows volume stays valid through registry and pre-GO execution identity', t => {
  windowsFixture(t, { pathDevice: 0n }, ({ root, file }) => {
    const check = { id: 'verify', title: 'Fixture', purpose: 'Fixture', command: { executable: file, argv: [], cwd: '.' },
      inputPaths: [], outputPaths: [], timeoutMs: 5000, maxOutputBytes: 65536 };
    const profile = { version: 2, checks: ['verify'], outputPaths: [],
      checkProfile: { version: 1, requiredCheckIds: ['verify'], definitions: [check], environment: [] } };
    const checks = inspectProjectChecks(root, profile), plan = { schemaVersion: 3, checks, checkRegistryHash: hashObject(checks) };
    const args = { root, worktree: root, profile, plan, node: { action: { id: 'check-verify' } },
      command: { executable: file, args: [], cwd: root, env: {} } };
    assert.equal(checkExecutionHash(args), checkExecutionHash(args));
  });
});

test('path-to-path stability keeps all original device bits on Windows', t => {
  windowsFixture(t, { pathChange: calls => calls.read ? { dev: fullDevice + (1n << 32n) } : {} }, ({ file }) => {
    assert.throws(() => checkFileIdentity(file, { executable: true }), { code: 'CHECK_INPUT_DRIFT' });
  });
});

test('descriptor-to-descriptor stability keeps all original device bits on Windows', t => {
  windowsFixture(t, { handleChange: calls => calls.read ? { dev: lowDevice + (1n << 32n) } : {} }, ({ file }) => {
    assert.throws(() => checkFileIdentity(file, { executable: true }), { code: 'CHECK_INPUT_DRIFT' });
  });
});

for (const field of ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'])
  test(`Windows cross-stat comparison still rejects changed ${field}`, t => {
    windowsFixture(t, { handleChange: (_calls, stat) => ({ [field]: (field === 'dev' ? lowDevice : stat[field]) + 1n }) }, ({ file }) => {
      assert.throws(() => checkFileIdentity(file, { executable: true }), { code: 'CHECK_INPUT_DRIFT' });
    });
  });

test('a missing path volume never hides a post-read volume substitution', t => {
  windowsFixture(t, { pathDevice: 0n,
    handleChange: calls => calls.read && calls.opened >= 3 ? { dev: lowDevice + 1n } : {} }, ({ file }) => {
    assert.throws(() => checkFileIdentity(file, { executable: true }), { code: 'CHECK_INPUT_DRIFT' });
  });
});

test('the missing-volume bridge rejects a changed file before byte capture', t => {
  windowsFixture(t, { pathDevice: 0n, pathChange: (calls, stat) => calls.path >= 3 ? { ino: stat.ino + 1n } : {} }, ({ file, calls }) => {
    assert.throws(() => checkFileIdentity(file, { executable: true }), { code: 'ESTALE' });
    assert.equal(calls.read, false);
  });
});

test('unsafe input diagnostics distinguish type, links and size without disclosing paths or bytes', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flowcairn-check-diagnostic-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'private-filename.txt'), content = 'PRIVATE_SOURCE_SENTINEL';
  fs.writeFileSync(file, content);
  const cases = [
    [root, {}, 'Инструмент или вход проверки должен быть обычным файлом.'],
    [file, { executable: true, maxBytes: 1 }, `Размер инструмента или входа проверки превышает лимит: ${Buffer.byteLength(content)} байт > 1 байт.`],
  ];
  const linked = path.join(root, 'hardlink');
  fs.linkSync(file, linked);
  cases.push([file, {}, 'Вход проверки должен иметь ровно одну жесткую ссылку.']);
  const symlink = path.join(root, 'symlink');
  fs.symlinkSync(root, symlink, process.platform === 'win32' ? 'junction' : 'dir');
  cases.push([symlink, {}, 'Инструмент или вход проверки не может быть символической ссылкой.']);
  for (const [target, options, message] of cases) {
    assert.throws(() => checkFileIdentity(target, options), error => {
      assert.equal(error.code, 'CHECK_INPUT_UNSAFE');
      assert.equal(error.message, message);
      assert.equal(error.message.includes(root), false);
      assert.equal(error.message.includes('private-filename'), false);
      assert.equal(error.message.includes(content), false);
      return true;
    });
  }
});
