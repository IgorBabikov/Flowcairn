import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256 } from './lib/io.mjs';
import { applyProposedEdits } from './lib/patch.mjs';
import { JSON_TRANSFER_LIMITS, parseJsonObjectEntries } from './lib/json-transfers.mjs';
import { AIResultSchema } from './lib/schemas.mjs';

function fixture(t, values = { 'src/base.json': '{"one":"First","two":{"count > 1":"Many","true":"One"},"keep":"Unchanged"}\n' }) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flowcairn-json-transfer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, content) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), content); };
  for (const [file, content] of Object.entries(values)) write(file, content);
  const before = { files: Object.keys(values).map((file) => { const bytes = readFileSync(path.join(root, file)); return { path: file, hash: sha256(bytes), size: bytes.length, mode: '100644' }; }) };
  const node = { permissions: ['workspace.source.write'], resources: { writes: ['src'] } };
  const task = { scope: ['src'], forbiddenPaths: ['src/forbidden'] };
  const hash = (file) => before.files.find((item) => item.path === file)?.hash ?? null;
  const transfer = (from = 'src/base.json', to = 'src/module/ru.json', keys = ['one']) => ({ from, to, previousHash: hash(from), targetPreviousHash: hash(to), keys });
  const apply = (transfers, edits = [], moves = []) => applyProposedEdits(root, before, node, task, edits, moves, transfers);
  const read = (file = 'src/base.json') => readFileSync(path.join(root, file), 'utf8');
  return { root, before, node, task, hash, transfer, apply, read, write };
}
const denied = (action) => assert.throws(action, (error) => error.code === 'PATCH_DENIED');

test('transfers exact values from a JSON larger than ordinary edit cap without model rewriting it', (t) => {
  const padding = 'x'.repeat(256 * 1024);
  const f = fixture(t, { 'src/base.json': `{"huge":9007199254740993,"minus":-0,"nested":{"items":[1e300,true,null]},"keep":"${padding}"}` });
  f.apply([f.transfer('src/base.json', 'src/number/ru.json', ['huge', 'minus']), f.transfer('src/base.json', 'src/nested/ru.json', ['nested'])]);
  assert.equal(JSON.parse(f.read()).keep, padding);
  assert.deepEqual([...parseJsonObjectEntries(f.read()).keys()], ['keep']);
  assert.equal(parseJsonObjectEntries(f.read('src/number/ru.json')).get('huge'), '9007199254740993');
  assert.equal(parseJsonObjectEntries(f.read('src/number/ru.json')).get('minus'), '-0');
  assert.equal(parseJsonObjectEntries(f.read('src/nested/ru.json')).get('nested'), '{"items":[1e300,true,null]}');
});

test('multiple sources append different keys to one existing target using its common BEFORE hash', (t) => {
  const f = fixture(t, { 'src/first.json': '{"a":"A"}', 'src/second.json': '{"b":"B"}', 'src/target.json': '{"keep":"K"}' });
  f.apply([f.transfer('src/first.json', 'src/target.json', ['a']), f.transfer('src/second.json', 'src/target.json', ['b'])]);
  assert.deepEqual(JSON.parse(f.read('src/target.json')), { keep: 'K', a: 'A', b: 'B' });
  assert.deepEqual(JSON.parse(f.read('src/first.json')), {}); assert.deepEqual(JSON.parse(f.read('src/second.json')), {});
});

test('late invalid transfer prevents all JSON and ordinary edits before any effect', (t) => {
  const f = fixture(t); const before = f.read();
  denied(() => f.apply([f.transfer(), f.transfer('src/base.json', 'src/later.json', ['missing'])], [{ path: 'src/new.txt', previousHash: null, content: 'must not appear', executable: false }]));
  assert.equal(f.read(), before); assert.equal(existsSync(path.join(f.root, 'src/module')), false); assert.equal(existsSync(path.join(f.root, 'src/new.txt')), false);
});

test('target key collision is denied even when the value would be identical', (t) => {
  const f = fixture(t, { 'src/base.json': '{"a":"A"}', 'src/target.json': '{"a":"A"}' });
  denied(() => f.apply([f.transfer('src/base.json', 'src/target.json', ['a'])]));
  assert.equal(f.read(), '{"a":"A"}'); assert.equal(f.read('src/target.json'), '{"a":"A"}');
});

test('duplicate moved keys and source-target cycles are rejected', (t) => {
  const f = fixture(t);
  for (const transfers of [[f.transfer(), f.transfer('src/base.json', 'src/another.json')], [f.transfer('src/base.json', 'src/base.json')],
    [f.transfer(), { ...f.transfer('src/module/ru.json', 'src/last.json'), previousHash: f.hash('src/base.json') }]]) denied(() => f.apply(transfers));
  assert.equal(existsSync(path.join(f.root, 'src/module')), false);
});

test('BEFORE source and target hashes are required and shared hashes cannot diverge', (t) => {
  const f = fixture(t);
  denied(() => f.apply([{ ...f.transfer(), previousHash: 'a'.repeat(64) }]));
  denied(() => f.apply([{ ...f.transfer(), targetPreviousHash: 'b'.repeat(64) }]));
  denied(() => f.apply([f.transfer(), { ...f.transfer('src/base.json', 'src/another.json', ['two']), previousHash: 'c'.repeat(64) }]));
  f.write('src/base.json', '{"one":"Concurrent write"}');
  denied(() => f.apply([f.transfer()]));
  assert.equal(existsSync(path.join(f.root, 'src/module')), false);
});

test('transfers cannot overlap with ordinary edits or moves', (t) => {
  const f = fixture(t);
  denied(() => f.apply([f.transfer()], [{ path: 'src/base.json', previousHash: f.hash('src/base.json'), content: '{}', executable: false }]));
  denied(() => f.apply([f.transfer()], [], [{ from: 'src/base.json', to: 'src/moved.json', previousHash: f.hash('src/base.json') }]));
  denied(() => f.apply([f.transfer()], [{ path: 'src/module', previousHash: null, content: '{}', executable: false }]));
});

test('scoped permissions and protected paths apply to both source and destination', (t) => {
  const f = fixture(t);
  for (const to of ['outside.json', 'src/forbidden/ru.json', 'src/.env', 'src/.npmrc', 'src/node_modules/ru.json', 'src/../escape.json', '/tmp/outside.json'])
    denied(() => f.apply([f.transfer('src/base.json', to)]));
  f.node.permissions = [];
  denied(() => f.apply([f.transfer()]));
});

test('symlinks, hardlinks and untracked destination collisions fail before source modification', (t) => {
  const f = fixture(t); const before = f.read();
  mkdirSync(path.join(f.root, 'outside'));
  symlinkSync(path.join(f.root, 'outside'), path.join(f.root, 'src/module'));
  denied(() => f.apply([f.transfer()])); rmSync(path.join(f.root, 'src/module'));
  linkSync(path.join(f.root, 'src/base.json'), path.join(f.root, 'shared.json'));
  denied(() => f.apply([f.transfer()])); rmSync(path.join(f.root, 'shared.json'));
  f.write('src/module/ru.json', '{}'); denied(() => f.apply([f.transfer()]));
  assert.equal(f.read(), before);
});

test('strict JSON parser rejects duplicate keys including decoded aliases and nested objects', () => {
  for (const value of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"a":{"x":1,"x":2}}', '{"a":[{"x":1,"x":2}]}']) denied(() => parseJsonObjectEntries(Buffer.from(value)));
});

test('strict JSON parser rejects malformed/non-object/binary/unbounded inputs', () => {
  for (const value of ['[]', 'null', '{"x":01}', '{"x":NaN}', '{"x":Infinity}', '{"x":1,}', '{"x":[1,]}', '{"x":1} trailing', '{"x":"\0"}', '{"x":' + '['.repeat(70) + '0' + ']'.repeat(70) + '}']) denied(() => parseJsonObjectEntries(Buffer.from(value)));
  denied(() => parseJsonObjectEntries(Buffer.from([123, 34, 255, 34, 58, 49, 125])));
  denied(() => parseJsonObjectEntries(Buffer.from('\uFEFF{"x":1}')));
});

test('special JavaScript property names transfer as ordinary JSON data without prototype pollution', (t) => {
  const f = fixture(t, { 'src/base.json': '{"__proto__":{"polluted":true},"constructor":"C","toString":"T"}' });
  f.apply([f.transfer('src/base.json', 'src/target.json', ['__proto__', 'constructor', 'toString'])]);
  assert.equal(Object.hasOwn(JSON.parse(f.read('src/target.json')), '__proto__'), true);
  assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false);
});

test('file and key limits reject transfers without increasing ordinary full-edit limits', (t) => {
  const f = fixture(t, { 'src/base.json': `{"one":"${'x'.repeat(JSON_TRANSFER_LIMITS.fileBytes)}"}` });
  denied(() => f.apply([f.transfer()]));
  denied(() => f.apply([{ ...f.transfer(), keys: Array.from({ length: 1001 }, (_, index) => `key${index}`) }]));
  const small = fixture(t);
  denied(() => small.apply([], [{ path: 'src/rewrite.json', previousHash: null, content: 'x'.repeat(128 * 1024 + 1), executable: false }]));
});

test('AI result accepts bounded transfer data and supplies an empty list for legacy outputs', () => {
  const output = { summary: 'Proposal', verdict: 'pass', skillsUsed: [], findings: [], changedFiles: [], plan: [] };
  assert.deepEqual(AIResultSchema.parse(output).jsonTransfers, []);
  const transfer = { from: 'src/base.json', to: 'src/module.json', previousHash: 'a'.repeat(64), targetPreviousHash: null, keys: ['one'] };
  assert.deepEqual(AIResultSchema.parse({ ...output, jsonTransfers: [transfer] }).jsonTransfers, [transfer]);
  assert.equal(AIResultSchema.safeParse({ ...output, jsonTransfers: [{ ...transfer, shell: 'not allowed' }] }).success, false);
});
