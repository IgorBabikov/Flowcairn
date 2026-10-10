import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { RPG_ASSET_FILES } from '../tools/ai-graph-viewer/server.mjs';
const cache = mkdtempSync(path.join(os.tmpdir(), 'flowcairn-pack-check-'));
try {
  assert.ok(process.env.npm_execpath, 'Запускайте через npm run check:package.');
  const result = spawnSync(process.execPath, [process.env.npm_execpath, 'pack', '--dry-run', '--ignore-scripts', '--json', '--cache', cache], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  const files = JSON.parse(result.stdout)[0].files.map(item => item.path);
  assert.ok(files.includes('bin/terminal.mjs'), 'Архив не содержит оформление терминала.');
  for (const required of ['bin/flowcairn.mjs', 'bin/workspaces.mjs', 'skills/project-context/SKILL.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'tools/ai-graph-viewer/dist/index.html', 'tools/ai-graph-viewer/dist/app.js', 'tools/ai-graph-viewer/dist/app.css'])
    assert.ok(files.includes(required), `Архив не содержит ${required}. Выполните npm run build.`);
  const rpgRoot = 'tools/ai-graph-viewer/dist/assets/rpg';
  const manifestPath = `${rpgRoot}/world.json`;
  assert.ok(files.includes(manifestPath), 'Архив не содержит карту игрового мира. Выполните npm run build.');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.schemaVersion, 1, 'Неизвестная версия карты игрового мира.');
  const assets = manifest.bundledFiles;
  assert.ok(assets, 'Карта не содержит закрепленные bundled hashes.');
  assert.deepEqual(Object.keys(assets).sort(), RPG_ASSET_FILES.filter(file => file !== 'world.json').sort(), 'Неожиданный список RPG ассетов.');
  for (const name of RPG_ASSET_FILES.filter(file => file !== 'world.json')) {
    const file = `${rpgRoot}/${name}`;
    assert.ok(files.includes(file), `Архив не содержит игровой ассет ${name}.`);
    const entry = assets[name];
    assert.ok(entry, `Карта не описывает игровой ассет ${name}.`);
    const bytes = readFileSync(file);
    assert.equal(bytes.length, entry.bytes, `Размер ${name} не соответствует карте.`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, `Хеш ${name} не соответствует карте.`);
  }
  const shippedRpg = files.filter(file => file.startsWith(`${rpgRoot}/`)).map(file => file.slice(rpgRoot.length + 1));
  assert.deepEqual(shippedRpg.sort(), [...RPG_ASSET_FILES].sort(), 'В npm попали лишние RPG файлы.');
  assert.ok(!files.some(file => /(^|\/)(rpg-assets|output|extracted)(\/|$)|\.(blend|fbx|gltf|glb|zip)$/.test(file)), 'Offline исходники или preview не должны попадать в npm.');
  assert.ok(!files.some(file => /(^|\/)(node_modules|\.git|\.ai-orchestrator|\.env)(\/|$)/.test(file)));
  console.log(`Устанавливаемый архив: ${files.length} файлов; runtime, skills и собранный UI на месте.`);
} finally { rmSync(cache, { recursive: true, force: true }); }
