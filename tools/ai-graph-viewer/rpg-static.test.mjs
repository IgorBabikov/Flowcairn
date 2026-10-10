import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startViewer, RPG_ASSET_FILES } from './server.mjs';

const token = 'rpg-static-fixture-1234567890';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5X8AAAAASUVORK5CYII=', 'base64');
const world = Buffer.from(JSON.stringify({ schemaVersion: 1, assets: { untrusted: 'unlisted.png' } }));
const files = new Map(RPG_ASSET_FILES.map(file => [file, file.endsWith('.json') ? world : png]));

async function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flowcairn-rpg-static-'));
  const dist = path.join(root, 'dist'), assets = path.join(dist, 'assets/rpg');
  mkdirSync(assets, { recursive: true });
  for (const [name, bytes] of files) writeFileSync(path.join(assets, name), bytes);
  writeFileSync(path.join(assets, 'unlisted.png'), 'unlisted fixture bytes');
  writeFileSync(path.join(assets, 'assets-manifest.json'), '{"private":"fixture bytes"}');
  writeFileSync(path.join(assets, 'ASSETS.md'), 'private fixture bytes');
  writeFileSync(path.join(dist, 'package.json'), 'private fixture bytes');
  writeFileSync(path.join(root, 'package.json'), 'outside fixture bytes');
  let reads = 0;
  const service = {
    acquireViewerLease: () => () => {}, close: () => {},
    listRuns: () => { reads += 1; return []; }, capabilities: () => ({}),
  };
  const server = startViewer({ service, token, port: 0, dist });
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  return { root, dist, assets, url: `http://127.0.0.1:${server.address().port}`, reads: () => reads };
}

// Send the exact request target; fetch would normalize dot segments before the server sees them.
function read(f, target, options = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(f.url, { path: target, ...options }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('RPG GET and HEAD serve exactly the bundled JSON/PNG bytes and preserve CSP', async t => {
  const f = await fixture(t);
  for (const [name, bytes] of files) {
    for (const method of ['GET', 'HEAD']) {
      const response = await read(f, `/assets/rpg/${name}`, { method });
      assert.equal(response.status, 200, `${method} ${name}`);
      assert.equal(response.headers['content-type'], name.endsWith('.json') ? 'application/json; charset=utf-8' : 'image/png');
      assert.deepEqual(response.bytes, method === 'HEAD' ? Buffer.alloc(0) : bytes);
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.match(response.headers['content-security-policy'], /script-src 'self';/);
      assert.ok(!response.headers['content-security-policy'].includes('unsafe-eval'));
    }
  }
  assert.equal(f.reads(), 0);
});

test('missing or non-file RPG assets are not served', async t => {
  const f = await fixture(t);
  rmSync(path.join(f.assets, 'guild-mentor-portrait.png'));
  rmSync(path.join(f.assets, 'world.json'));
  mkdirSync(path.join(f.assets, 'world.json'));
  for (const name of ['guild-mentor-portrait.png', 'world.json']) {
    for (const method of ['GET', 'HEAD'])
      assert.equal((await read(f, `/assets/rpg/${name}`, { method })).status, 404);
  }
});

test('manifest strings, arbitrary project files and traversal cannot expand the static allowlist', async t => {
  const f = await fixture(t);
  for (const target of [
    '/assets/rpg/unlisted.png', '/assets/rpg/assets-manifest.json', '/assets/rpg/ASSETS.md',
    '/assets/rpg/../rpg/unlisted.png', '/assets/rpg/../../package.json',
    '/assets/rpg/../../../package.json', '/assets/rpg/%2e%2e/%2e%2e/package.json',
    '/assets/rpg/%2e%2e%2f%2e%2e%2fpackage.json', '/package.json',
    '/assets/rpg/guild-enemy-idle-se.png', '/assets/rpg/guild-mentor-idle-sw.png',
    '/assets/rpg/guild-mentor-walk-we.json', '/assets/rpg/mentor-idle.png',
  ]) {
    for (const method of ['GET', 'HEAD']) {
      const response = await read(f, target, { method });
      assert.equal(response.status, 404, `${method} ${target}`);
      assert.ok(!response.bytes.toString().includes('fixture bytes'));
    }
  }
});

test('a symlink at an allowed RPG filename is rejected even when its target is inside dist', async t => {
  const f = await fixture(t);
  const file = path.join(f.assets, 'guild-mentor-portrait.png');
  rmSync(file);
  symlinkSync(path.join(f.assets, 'guild-room.png'), file);
  for (const method of ['GET', 'HEAD'])
    assert.equal((await read(f, '/assets/rpg/guild-mentor-portrait.png', { method })).status, 404);
});

test('a parent symlink cannot expose a sibling directory sharing the dist prefix', async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'dist-outside');
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'guild-room.png'), 'outside fixture bytes');
  rmSync(f.assets, { recursive: true });
  symlinkSync(outside, f.assets, 'dir');
  for (const method of ['GET', 'HEAD']) {
    const response = await read(f, '/assets/rpg/guild-room.png', { method });
    assert.equal(response.status, 404);
    assert.ok(!response.bytes.toString().includes('outside fixture bytes'));
  }
});

test('RPG static access preserves host/site restrictions, methods and API authorization', async t => {
  const f = await fixture(t);
  const asset = '/assets/rpg/world.json';
  assert.equal((await read(f, asset, { headers: { Host: 'attacker.example' } })).status, 403);
  assert.equal((await read(f, asset, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await read(f, asset, { method: 'POST' })).status, 405);
  for (const headers of [
    {}, { Origin: f.url },
    { Origin: 'https://attacker.example', 'X-flowcairn-Control': token },
    { Origin: f.url, 'X-flowcairn-Control': 'wrong-token' },
    { Origin: f.url, 'X-flowcairn-Control': token, 'Sec-Fetch-Site': 'cross-site' },
  ]) assert.equal((await read(f, '/api/runs', { headers })).status, 403);
  assert.equal(f.reads(), 0);
  for (const headers of [
    { Origin: f.url, 'X-flowcairn-Control': token }, { 'X-flowcairn-Control': token },
  ]) {
    const authorized = await read(f, '/api/runs', { headers });
    assert.equal(authorized.status, 200);
    assert.deepEqual(JSON.parse(authorized.bytes.toString()), { runs: [], capabilities: {} });
  }
  assert.equal(f.reads(), 2);
});
