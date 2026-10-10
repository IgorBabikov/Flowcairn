import { createRequire } from 'node:module';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { scanSourceFile } from './source-file-scan.mjs';
import { lstatHostSync, sameHostPath, isPrivateMode } from './host-filesystem.mjs';

// Exact diff@9.0.0 ESM closure. package/lock and this worker also participate in
// runtimeIdentity. Validate bytes before importing, then import a private copy
// so a dependency replacement after verification cannot change executed code.
const DEPENDENCY = Object.freeze({
  'package.json': '1c625fe9bba43722c8d8fbd8c2b70edcab5473d75f8d66a862f9800b415aa014',
  'libesm/package.json': '5e433a0d28d7f422b2c6fbc3058b931d19d29bdc49c154b312099680e992e3f5',
  'libesm/patch/create.js': 'f29a276d2b036858b2f6a509b1e6e147efa572d4820317ee7285d6fe4f2888de',
  'libesm/diff/line.js': 'e3ef2d8c8c3a56f6b9fb04609f545b2aae2f84a02c31c5de3201aef1b0545f90',
  'libesm/diff/base.js': 'faa81734df6ea7f8034efc5572ad1bbf19c50b300fdd183baf0d7813c5eec3b2',
  'libesm/util/params.js': 'bb76a1c299071b6f8314bb7195ad701af06f092c629aed8b4fef4a7474ab3759',
});
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 3 * 1024 * 1024;

function exactBytes(file, expected, maximum) {
  const stat = lstatHostSync(file, { bigint: true }), size = Number(stat.size);
  if (!Number.isSafeInteger(size) || size > maximum || expected.size !== undefined && size !== expected.size) throw Error();
  const result = scanSourceFile(file, { expected: stat, classify: false, window: { offset: 0, bytes: size } });
  if (result.hash !== expected.hash || result.window.length !== size) throw Error();
  return result.window;
}

async function run() {
  if (process.argv.length !== 4 || !/^[a-f0-9]{64}$/.test(process.argv[3])) throw Error();
  const root = process.argv[2], stat = lstatHostSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !isPrivateMode(stat) || !sameHostPath(realpathSync(root), root)) throw Error();
  const metadataPath = path.join(root, 'input.json');
  const input = JSON.parse(exactBytes(metadataPath, { hash: process.argv[3] }, 2048).toString('utf8'));
  if (input.version !== 1 || !Number.isInteger(input.budget) || input.budget < 1 || input.budget > MAX_OUTPUT_BYTES ||
      [input.before, input.after].some(value => !value || !Number.isInteger(value.size) || value.size < 0 || value.size > MAX_INPUT_BYTES || !/^[a-f0-9]{64}$/.test(value.hash))) throw Error();
  const decode = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const before = decode(exactBytes(path.join(root, 'before'), input.before, MAX_INPUT_BYTES));
  const after = decode(exactBytes(path.join(root, 'after'), input.after, MAX_INPUT_BYTES));
  if (before.includes('\0') || after.includes('\0')) throw Error();
  const require = createRequire(import.meta.url);
  const dependencyRoot = path.dirname(require.resolve('diff/package.json'));
  const privateRoot = path.join(root, 'verified-diff');
  for (const [relative, hash] of Object.entries(DEPENDENCY)) {
    const bytes = exactBytes(path.join(dependencyRoot, relative), { hash }, 256 * 1024);
    const target = path.join(privateRoot, relative);
    mkdirSync(path.dirname(target), { mode: 0o700, recursive: true });
    writeFileSync(target, bytes, { mode: 0o600, flag: 'wx' });
  }
  const { structuredPatch, formatPatch, OMIT_HEADERS } = await import(pathToFileURL(path.join(privateRoot, 'libesm/patch/create.js')).href);
  const patch = structuredPatch('before', 'after', before, after, undefined, undefined,
    { context: 3, timeout: 9000, ignoreWhitespace: false, stripTrailingCr: false });
  if (!patch || !patch.hunks.length) throw Error();
  const body = formatPatch(patch, OMIT_HEADERS);
  if (Buffer.byteLength(body) > input.budget) throw Error();
  process.stdout.write(body);
}

try { await run(); }
catch { process.exitCode = 2; } // No source bytes, paths or dependency errors on stderr.
