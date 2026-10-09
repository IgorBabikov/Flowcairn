import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { checkFileIdentity, resolveCheckExecutable } from './lib/check-toolchain.mjs';

const MiB = 1024 * 1024;
function fixture(t, size) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flowcairn-large-executable-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'synthetic-tool'), prefix = Buffer.from('synthetic executable\0'), suffix = Buffer.from('\0end-marker');
  const fd = fs.openSync(file, 'wx', 0o755);
  try {
    fs.ftruncateSync(fd, size);
    fs.writeSync(fd, prefix, 0, prefix.length, 0);
    fs.writeSync(fd, suffix, 0, suffix.length, size - suffix.length);
  } finally { fs.closeSync(fd); }
  return { root, file, size, prefix, suffix };
}

// Independent expected digest from known fixture content, not a second product read.
function expectedHash({ size, prefix, suffix }) {
  const hash = createHash('sha256'), zeroes = Buffer.alloc(64 * 1024);
  hash.update(prefix);
  let remaining = size - prefix.length - suffix.length;
  while (remaining) {
    const count = Math.min(remaining, zeroes.length);
    hash.update(zeroes.subarray(0, count)); remaining -= count;
  }
  return hash.update(suffix).digest('hex');
}

function observeReads(t, callback, action) {
  const originalRead = fs.readSync;
  const whole = t.mock.method(fs, 'readFileSync', () => assert.fail('Executable hashing must not read a whole binary into memory.'));
  const read = t.mock.method(fs, 'readSync', (...args) => callback(originalRead, args));
  syncBuiltinESMExports();
  try { return action(); }
  finally { read.mock.restore(); whole.mock.restore(); syncBuiltinESMExports(); }
}

test('a real 290664032-byte executable hashes fully with a bounded reusable buffer', t => {
  const fx = fixture(t, 290664032); // Exact clang byte count observed in CI37898775327.
  const expected = expectedHash(fx), buffers = new Set();
  let total = 0, eof = 0, calls = 0;
  const result = observeReads(t, (read, args) => {
    assert.ok(args[1].byteLength <= 256 * 1024); assert.ok(args[3] <= 256 * 1024);
    buffers.add(args[1]); calls++;
    const count = read(...args); total += count; if (!count) eof++;
    return count;
  }, () => resolveCheckExecutable(fx.root, fx.file));
  assert.equal(result.hash, expected); assert.equal(result.bytes, fx.size);
  assert.equal(result.executable, fx.file); assert.equal(result.canonicalPath, fx.file);
  assert.equal(total, fx.size); assert.equal(eof, 1); assert.equal(buffers.size, 1);
  assert.ok(calls > 1000, 'The compiler-sized file must be read in many small chunks.');
  t.diagnostic(JSON.stringify({ bytes: result.bytes, hash: result.hash, readCalls: calls, bufferBytes: [...buffers][0].byteLength }));
});

test('executables over 512 MiB reject before reading even if a caller requests a larger bound', t => {
  const fx = fixture(t, 512 * MiB + 1);
  const reject = () => observeReads(t, () => assert.fail('Oversized executable must not be read.'), () => {
    for (const action of [() => resolveCheckExecutable(fx.root, fx.file),
      () => checkFileIdentity(fx.file, { executable: true, maxBytes: 1024 * MiB })])
      assert.throws(action, error => error.code === 'CHECK_INPUT_UNSAFE' &&
        error.message.includes('536870913 байт > 536870912 байт') && !error.message.includes(fx.file));
  });
  reject();
});

test('source input size and secret guards keep their existing bounds', t => {
  const fx = fixture(t, 16 * MiB + 1);
  assert.throws(() => checkFileIdentity(fx.file), error => error.code === 'CHECK_INPUT_UNSAFE' &&
    error.message.includes('16777217 байт > 16777216 байт'));
  fs.writeFileSync(fx.file, 'Bearer ' + 'a'.repeat(32));
  assert.throws(() => checkFileIdentity(fx.file), { code: 'CHECK_INPUT_UNSAFE' });
});

for (const mutation of ['overwrite', 'truncate', 'grow']) test(`streamed executable refuses ${mutation} during hashing`, t => {
  const fx = fixture(t, 2 * MiB); let changed = false;
  observeReads(t, (read, args) => {
    const count = read(...args);
    if (count && !changed) {
      changed = true;
      const fd = fs.openSync(fx.file, 'r+');
      try {
        if (mutation === 'overwrite') fs.writeSync(fd, Buffer.from('X'), 0, 1, 0);
        else fs.ftruncateSync(fd, mutation === 'truncate' ? 1 : fx.size + 1);
      } finally { fs.closeSync(fd); }
    }
    return count;
  }, () => assert.throws(() => resolveCheckExecutable(fx.root, fx.file), { code: 'CHECK_INPUT_DRIFT' }));
  assert.equal(changed, true, 'The mutation must occur after the first actual read.');
});

test('stream hashing handles partial reads and confirms EOF at the exact boundary', t => {
  const fx = fixture(t, 8193), expected = expectedHash(fx); let total = 0, eof = false;
  const result = observeReads(t, (read, args) => {
    args[3] = Math.min(args[3], 17);
    const count = read(...args); total += count; eof ||= count === 0;
    return count;
  }, () => resolveCheckExecutable(fx.root, fx.file));
  assert.equal(result.hash, expected); assert.equal(result.bytes, fx.size);
  assert.equal(total, fx.size); assert.equal(eof, true);
});

test('growth at the EOF probe is bounded to one excess byte and rejected', t => {
  const fx = fixture(t, 1024); let readBytes = 0, appended = false;
  observeReads(t, (read, args) => {
    if (readBytes === fx.size) {
      assert.equal(args[3], 1);
      fs.appendFileSync(fx.file, Buffer.alloc(MiB)); appended = true;
    }
    const count = read(...args); readBytes += count;
    return count;
  }, () => assert.throws(() => resolveCheckExecutable(fx.root, fx.file), { code: 'CHECK_INPUT_DRIFT' }));
  assert.equal(appended, true); assert.equal(readBytes, fx.size + 1);
});
