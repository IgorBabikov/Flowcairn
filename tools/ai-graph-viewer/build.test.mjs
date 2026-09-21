import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const source = path.dirname(fileURLToPath(import.meta.url));

test('real viewer build is independent of cwd and preserves the running viewer assets', (t) => {
  const root = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'graph-build-cwd-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const viewer = path.join(root, 'viewer');
  const other = path.join(root, 'other');
  mkdirSync(viewer);
  mkdirSync(other);
  for (const file of ['build.mjs', 'index.html', 'package.json', 'src'])
    cpSync(path.join(source, file), path.join(viewer, file), { recursive: true });
  symlinkSync(path.resolve(source, '../../node_modules'), path.join(viewer, 'node_modules'), 'dir');
  const dist = path.join(viewer, 'dist');
  for (const cwd of [viewer, other]) {
    rmSync(dist, { recursive: true, force: true });
    const result = spawnSync(process.execPath, [path.join(viewer, 'build.mjs')], {
      cwd,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr ?? 'build failed');
    for (const name of ['app.js', 'app.css', 'index.html'])
      assert.ok(statSync(path.join(dist, name)).size > 0, `${name} must be built`);
    for (const name of [
      'Manrope-Cyrillic-Variable.woff2',
      'Manrope-Latin-Variable.woff2',
      'OFL-Manrope.txt',
    ])
      assert.ok(statSync(path.join(dist, 'fonts', name)).size > 0, `${name} must be built`);
    const css = readFileSync(path.join(dist, 'app.css'), 'utf8');
    assert.match(css, /Manrope-Cyrillic-Variable\.woff2/);
    assert.match(css, /Manrope-Latin-Variable\.woff2/);
  }
  assert.equal(existsSync(path.join(other, 'dist')), false);
});
