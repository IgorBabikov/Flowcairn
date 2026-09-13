import { createServer } from 'node:http';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authorize, control, send, sendError } from './controller.mjs';

const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

export function startViewer({ service, token, port = 4329, dist = path.join(DIRECTORY, 'dist') }) {
  if (!/^[a-zA-Z0-9_-]{24,128}$/.test(token))
    throw new Error('A strong local session token is required');
  const streams = new Set();
  const server = createServer(async (request, response) => {
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
    const address = server.address();
    if (!address || typeof address === 'string')
      return send(response, 503, { error: 'not-listening' });
    const origin = `http://127.0.0.1:${address.port}`;
    if (
      request.headers.host !== origin.slice(7) ||
      request.headers['sec-fetch-site'] === 'cross-site'
    )
      return send(response, 403, { error: 'invalid-host-or-site' });
    const url = new URL(request.url, origin);
    if (url.pathname.startsWith('/api/')) {
      if (!authorize(request, token, origin)) return send(response, 403, { error: 'unauthorized' });
      try {
        if (request.method === 'POST') return await control(service, request, response, url);
        if (request.method !== 'GET') return send(response, 405, { error: 'method-not-allowed' });
        if (url.pathname === '/api/project')
          return send(response, 200, await service.project());
        if (url.pathname === '/api/runs')
          return send(response, 200, {
            runs: service.listRuns(),
            capabilities: service.capabilities(),
          });
        const match = url.pathname.match(
          /^\/api\/runs\/([a-z][a-z0-9-]{1,79})\/(snapshot|plan|events|stream|receipts\/[a-f0-9]{64}|artifacts\/[a-f0-9]{64})$/,
        );
        if (!match) return send(response, 404, { error: 'not-found' });
        const [, runId, resource] = match;
        if (resource === 'snapshot') return send(response, 200, service.snapshot(runId));
        if (resource === 'plan') return send(response, 200, service.plan(runId));
        if (resource.startsWith('receipts/'))
          return send(response, 200, service.receipt(runId, resource.split('/')[1]));
        if (resource.startsWith('artifacts/'))
          return send(response, 200, service.artifact(runId, resource.split('/')[1]));
        const cursor = Number(url.searchParams.get('after') ?? '-1');
        if (!Number.isSafeInteger(cursor) || cursor < -1)
          return send(response, 400, { error: 'invalid-cursor' });
        if (resource === 'events')
          return send(response, 200, { events: service.events(runId, cursor) });
        if (streams.size >= 32) return send(response, 429, { error: 'stream-limit' });
        service.revision(runId);
        response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        let after = cursor;
        const emit = () => {
          try {
            const revision = service.revision(runId);
            if (revision > after) {
              after = revision;
              response.write(
                `id: ${after}\nevent: revision\ndata: ${JSON.stringify({ runId, revision: after })}\n\n`,
              );
            } else response.write(': heartbeat\n\n');
          } catch {
            response.end();
          }
        };
        const timer = setInterval(emit, 2000);
        timer.unref();
        const cleanup = () => {
          clearInterval(timer);
          streams.delete(response);
        };
        streams.add(response);
        response.on('close', cleanup);
        emit();
        return;
      } catch (error) {
        if (!response.headersSent) sendError(response, error);
        else response.end();
        return;
      }
    }
    if (!['GET', 'HEAD'].includes(request.method))
      return send(response, 405, { error: 'method-not-allowed' });
    if (url.pathname === '/favicon.ico') {
      response.statusCode = 204;
      return response.end();
    }
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!['index.html', 'app.js', 'app.css'].includes(name))
      return send(response, 404, { error: 'not-found' });
    try {
      const file = path.join(dist, name),
        stat = lstatSync(file);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        !realpathSync(file).startsWith(`${realpathSync(dist)}${path.sep}`)
      )
        return send(response, 404, { error: 'not-found' });
      const bytes = readFileSync(file);
      response.setHeader('Content-Type', TYPES[path.extname(name)]);
      response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch {
      return send(response, 404, { error: 'viewer-not-built' });
    }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 30000;
  server.maxHeadersCount = 40;
  const releaseViewer = service.acquireViewerLease();
  let released = false;
  const cleanup = () => {
    if (released) return;
    released = true;
    for (const response of streams) response.end();
    releaseViewer();
    try {
      service.close();
    } catch {
      // Never force-release the service owner: a rejected close retains its lease.
    }
  };
  server.once('close', cleanup);
  server.once('error', () => {
    server.close();
    cleanup();
  });
  try {
    server.listen(port, '127.0.0.1');
  } catch (error) {
    cleanup();
    throw error;
  }
  return server;
}
