import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, lstatSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { RPG_ASSET_FILES } from './server.mjs';

const viewerDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = process.env.FLOWCAIRN_VIEWER_DIST ? path.resolve(process.env.FLOWCAIRN_VIEWER_DIST) : path.join(viewerDir, 'dist');

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

// Only these authored assets are shipped; never copy arbitrary project paths.
const rpgDir = path.join(viewerDir, 'assets/rpg');
const rpgFiles = RPG_ASSET_FILES.filter(file => file !== 'world.json');
const manifestPath = path.join(rpgDir, 'world.json');
if (!lstatSync(manifestPath).isFile() || lstatSync(manifestPath).isSymbolicLink()) throw new Error('Invalid RPG manifest');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const entries = manifest.bundledFiles;
if (manifest.schemaVersion !== 1 || !entries || Object.keys(entries).sort().join('\n') !== [...rpgFiles].sort().join('\n')) throw new Error('Invalid RPG asset list');
const targetDir = path.join(distDir, 'assets/rpg');
mkdirSync(targetDir, { recursive: true });
// Retire only these previously generated D1 plates. Unknown files fail package verification.
for (const legacy of ['world.png', 'hero-idle.png', 'mentor-idle.png', 'workshop-room.png', 'archive-room.png']) {
  const file = path.join(targetDir, legacy);
  if (existsSync(file)) rmSync(file);
}
for (const file of rpgFiles) {
  const entry = entries[file];
  const source = path.join(rpgDir, file);
  const stat = lstatSync(source);
  if (!entry || !stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.bytes) throw new Error(`Invalid RPG asset: ${file}`);
  const hash = createHash('sha256').update(readFileSync(source)).digest('hex');
  if (hash !== entry.sha256) throw new Error(`RPG asset hash mismatch: ${file}`);
  cpSync(source, path.join(targetDir, file));
}
cpSync(manifestPath, path.join(targetDir, 'world.json'));
