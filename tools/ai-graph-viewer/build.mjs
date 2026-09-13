import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const viewerDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(viewerDir, 'dist');

mkdirSync(distDir, { recursive: true });
await build({
  entryPoints: [path.join(viewerDir, 'src/main.tsx')],
  bundle: true,
  minify: true,
  sourcemap: false,
  outfile: path.join(distDir, 'app.js'),
  jsx: 'automatic',
  platform: 'browser',
  target: ['es2022'],
  define: { 'process.env.NODE_ENV': '"production"' },
});
await build({
  entryPoints: [path.join(viewerDir, 'src/app.css')],
  bundle: true,
  minify: true,
  outfile: path.join(distDir, 'app.css'),
});
cpSync(path.join(viewerDir, 'index.html'), path.join(distDir, 'index.html'));
