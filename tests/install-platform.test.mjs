import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { assertProjectPlatform, assertRuntimePlatform, defaultProvider } from '../scripts/ai-graph/lib/platform.mjs';
import { openBrowser } from '../bin/browser.mjs';
import { checkUpdate } from '../bin/update.mjs';
import { instructionsCommand } from '../bin/instructions.mjs';

test('native macOS and Windows support Node22 and local Windows drives', () => {
  assertRuntimePlatform({ platform: 'win32', node: '22.13.1' });
  assertProjectPlatform('C:\\Projects\\fixture', { platform: 'win32' });
  assert.throws(() => assertProjectPlatform('\\\\server\\share', { platform: 'win32' }), { code: 'WINDOWS_FILESYSTEM' });
  for (const platform of ['darwin', 'win32']) assertRuntimePlatform({ platform, node: '22.13.1' });
  assert.equal(defaultProvider('darwin'), 'codex');
  assert.equal(defaultProvider('win32'), 'codex');
});

test('browser launch uses fixed executables and a loopback URL, failure is a fallback', async () => {
  const calls = [];
  const launcher = (...args) => {
    calls.push(args);
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('close', 0));
    return child;
  };
  const url = 'http://127.0.0.1:4329/#session=abc_123';
  assert.equal(await openBrowser(url, { platform: 'darwin', launcher }), true);
  assert.equal(calls[0][0], '/usr/bin/open');
  assert.deepEqual(calls[0][1], [url]);
  assert.equal(calls[0][2].shell, false);
  assert.equal(await openBrowser('https://example.invalid', { launcher }), false);
  assert.equal(calls.length, 1);
  assert.equal(await openBrowser(url, { platform: 'freebsd', launcher: () => { throw Error('unsupported'); } }), false);
});

test('update is bounded metadata-only with fixed registry, no redirects and repository validation', async () => {
  const metadata = { name: 'flowcairn', version: '0.1.2', repository: { url: 'git+https://github.com/IgorBabikov/flowcairn.git' } };
  let request;
  const fetcher = async (...args) => { request = args; return Response.json(metadata); };
  const result = await checkUpdate('0.1.2-dev', { fetcher });
  assert.equal(result.updateAvailable, true);
  assert.equal(request[0], 'https://registry.npmjs.org/flowcairn/latest');
  assert.equal(request[1].redirect, 'error');
  assert.deepEqual(Object.keys(request[1].headers), ['Accept']);
  assert.equal((await checkUpdate('1.0.0', { fetcher })).updateAvailable, false);
  assert.equal((await checkUpdate('0.1.2', { fetcher })).updateAvailable, false);
  assert.equal((await checkUpdate('0.1.0', { fetcher: async () => new Response('', { status: 404 }) })).published, false);
  metadata.repository.url = 'https://example.invalid/flowcairn';
  await assert.rejects(checkUpdate('0.1.0', { fetcher }), { code: 'UPDATE_SOURCE' });
  await assert.rejects(checkUpdate('0.1.0', { fetcher: async () => new Response('x'.repeat(256 * 1024 + 1)) }), { code: 'UPDATE_METADATA' });
});

test('instructions adapter requires exact fingerprint consent', async () => {
  const writes = [];
  const loader = async () => ({
    inspectInstructions: () => ({ fingerprint: 'a'.repeat(64) }),
    inspectIntegration: () => ({ status: 'absent' }),
    activateIntegration: (input) => { writes.push(input); return { changed: true }; },
  });
  assert.equal((await instructionsCommand('/fixture', 'inspect', {}, loader)).changed, false);
  await assert.rejects(instructionsCommand('/fixture', 'activate', { fingerprint: 'a'.repeat(64) }, loader), { code: 'INTEGRATION_CONSENT' });
  await instructionsCommand('/fixture', 'activate', { consent: true, fingerprint: 'a'.repeat(64) }, loader);
  assert.deepEqual(writes, [{ projectRoot: '/fixture', consent: true, expectedFingerprint: 'a'.repeat(64) }]);
});
