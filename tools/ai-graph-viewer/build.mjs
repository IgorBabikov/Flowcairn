import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const viewerDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(viewerDir, 'dist');

mkdirSync(distDir, { recursive: true });
await build({
  entryPoints: { app: path.join(viewerDir, 'src/main.tsx') },
  bundle: true,
  minify: true,
  sourcemap: false,
  outdir: distDir,
  entryNames: '[name]',
  assetNames: 'fonts/[name]',
  loader: { '.woff2': 'file' },
  jsx: 'automatic',
  platform: 'browser',
  target: ['es2022'],
  define: { 'process.env.NODE_ENV': '"production"' },
});
cpSync(path.join(viewerDir, 'index.html'), path.join(distDir, 'index.html'));
const fontDir = path.join(distDir, 'fonts');
mkdirSync(fontDir, { recursive: true });
cpSync(path.join(viewerDir, 'src/assets/OFL-Manrope.txt'), path.join(fontDir, 'OFL-Manrope.txt'));
