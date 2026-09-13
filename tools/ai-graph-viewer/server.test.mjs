import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startViewer } from './server.mjs';

const token = 'fixture-capability-1234567890';
async function fixture(t) {
  const dist = mkdtempSync(path.join(os.tmpdir(), 'graph-http-'));
  writeFileSync(path.join(dist, 'index.html'), '<html><head></head><body></body></html>');
  const calls = [];
  const service = {
    capabilities: () => ({ create: { allowed: true, reason: null } }),
    listRuns: () => [{ runId: 'run-test' }],
    snapshot: () => {
      calls.push('snapshot');
      return { runId: 'run-test', revision: 1, status: 'ready' };
    },
    revision: () => 1,
    plan: () => ({ nodes: [] }),
    events: () => [],
    receipt: () => ({ phase: 'finished' }),
    artifact: () => ({ content: '<script>attack()</script>', mediaType: 'text/plain' }),
    create: async (spec, options) => {
      calls.push({ spec, options });
      return { runId: 'run-new' };
    },
    command: async (...args) => {
      calls.push(args);
      return { runId: args[0], status: 'passed' };
    },
  };
  const server = startViewer({ service, token, port: 0, dist });
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dist, { recursive: true, force: true });
  });
  return {
    url,
    server,
    calls,
    headers: { 'X-Flowcairn-Control': token, Origin: url, 'Content-Type': 'application/json' },
  };
}

test('all data reads require bearer header and exact local origin; page has no inline script', async (t) => {
  const f = await fixture(t);
  assert.equal((await fetch(`${f.url}/api/runs`)).status, 403);
  assert.equal(
    (
      await fetch(`${f.url}/api/runs`, {
        headers: { ...f.headers, Origin: 'https://attacker.example' },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(`${f.url}/api/runs`, {
        headers: { ...f.headers, 'Sec-Fetch-Site': 'cross-site' },
      })
    ).status,
    403,
  );
  const runs = await fetch(`${f.url}/api/runs`, { headers: f.headers });
  assert.equal(runs.status, 200);
  assert.equal((await runs.json()).runs[0].runId, 'run-test');
  const page = await fetch(f.url);
  const html = await page.text();
  assert.ok(!html.includes(token));
  assert.ok(!html.includes('<script>'));
  assert.ok(page.headers.get('content-security-policy').includes("script-src 'self';"));
  assert.equal(page.headers.get('cache-control'), 'no-store');
});

test('unknown host, paths, methods and oversized bodies are rejected without domain effects', async (t) => {
  const f = await fixture(t);
  const status = await new Promise((resolve, reject) => {
    const req = httpRequest(f.url, { headers: { Host: 'attacker.example' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
  for (const name of ['../package.json', '%2e%2e/package.json', 'api/runs/run-test/control/shell'])
    assert.equal((await fetch(`${f.url}/${name}`, { headers: f.headers })).status, 404);
  assert.equal(
    (await fetch(`${f.url}/api/runs`, { method: 'PUT', headers: f.headers })).status,
    405,
  );
  assert.equal(
    (
      await fetch(`${f.url}/api/runs`, {
        method: 'POST',
        headers: f.headers,
        body: 'x'.repeat(270000),
      })
    ).status,
    413,
  );
  assert.equal(f.calls.length, 0);
});

test('control and artifact adapters preserve domain boundary and safe JSON content', async (t) => {
  const f = await fixture(t),
    body = { operationId: 'op-test', expectedRevision: 0, planHash: 'a'.repeat(64) };
  const res = await fetch(`${f.url}/api/runs/run-test/control/run`, {
    method: 'POST',
    headers: f.headers,
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(f.calls[0], ['run-test', 'run', body, { actor: 'local-operator' }]);
  const artifact = await fetch(`${f.url}/api/runs/run-test/artifacts/${'a'.repeat(64)}`, {
    headers: f.headers,
  });
  assert.equal(artifact.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal((await artifact.json()).content, '<script>attack()</script>');
  const unknown = await fetch(`${f.url}/api/runs/run-test/control/shell`, {
    method: 'POST',
    headers: f.headers,
    body: '{}',
  });
  assert.equal(unknown.status, 404);
});

test('SSE carries committed revision hints; reconnect recovers via snapshot', async (t) => {
  const f = await fixture(t),
    controller = new AbortController();
  const res = await fetch(`${f.url}/api/runs/run-test/stream?after=0`, {
    headers: f.headers,
    signal: controller.signal,
  });
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = res.body.getReader();
  const first = await reader.read();
  assert.ok(new TextDecoder().decode(first.value).includes('event: revision'));
  assert.equal(f.calls.filter((call) => call === 'snapshot').length, 0);
  controller.abort();
  const snapshot = await fetch(`${f.url}/api/runs/run-test/snapshot`, { headers: f.headers });
  assert.equal((await snapshot.json()).revision, 1);
});

test('Unicode auth header with equal character length is denied without crashing server', async (t) => {
  const f = await fixture(t);
  const denied = await fetch(`${f.url}/api/runs`, {
    headers: { ...f.headers, 'X-Flowcairn-Control': 'é'.repeat(token.length) },
  });
  assert.equal(denied.status, 403);
  assert.equal((await fetch(`${f.url}/api/runs`, { headers: f.headers })).status, 200);
});
