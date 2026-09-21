import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../dist', import.meta.url));
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ['/fonts/Manrope-Cyrillic-Variable.woff2', ['fonts/Manrope-Cyrillic-Variable.woff2', 'font/woff2']],
  ['/fonts/Manrope-Latin-Variable.woff2', ['fonts/Manrope-Latin-Variable.woff2', 'font/woff2']],
  ['/fonts/OFL-Manrope.txt', ['fonts/OFL-Manrope.txt', 'text/plain; charset=utf-8']],
]);

const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  const file = files.get(pathname);
  if (!file) {
    response.writeHead(404).end();
    return;
  }
  response.setHeader('Content-Type', file[1]);
  response.setHeader('Cache-Control', 'no-store');
  response.end(readFileSync(path.join(root, file[0])));
});

server.listen(Number(process.env.FLOWCAIRN_FIXTURE_PORT ?? 4329), '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
