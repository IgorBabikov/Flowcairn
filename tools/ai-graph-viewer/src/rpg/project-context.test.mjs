import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { URL, fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: [fileURLToPath(new URL('../api.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' });
const { api } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const base = { schemaVersion: 2, name: 'Fixture', contextHash: 'a'.repeat(64), contextPaths: [], scopeCandidates: [], checks: ['lint'], ai: { provider: null, model: null }, capabilities: { intake: { allowed: true, reason: null } } };
const summary = { id: 'check-cli', title: 'CLI', purpose: 'Check input', available: false, reason: 'Compiler missing', profileHash: 'b'.repeat(64) };
async function read(value) {
  const previous = globalThis.fetch;
  const previousWindow = globalThis.window;
  globalThis.window = { location: { hash: '' }, sessionStorage: { getItem: () => null } };
  globalThis.fetch = async () => ({ ok: true, json: async () => value });
  try { return await api.project(); } finally { globalThis.fetch = previous; if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; }
}
test('project read accepts legacy IDs and canonical V3 summaries without coercion', async () => {
  assert.deepEqual((await read(base)).checks, ['lint']);
  assert.deepEqual((await read({ ...base, schemaVersion: 3, checks: [summary] })).checks, [summary]);
});
test('project read rejects unknown versions and mismatched/malformed check summaries', async () => {
  for (const value of [
    { ...base, schemaVersion: 4 },
    { ...base, schemaVersion: 3, checks: ['lint'] },
    { ...base, checks: [summary] },
    { ...base, schemaVersion: 3, checks: [{ ...summary, available: 'yes' }] },
    { ...base, schemaVersion: 3, checks: [{ ...summary, reason: {} }] },
  ]) await assert.rejects(read(value), error => error.code === 'INVALID_PROJECT');
});
