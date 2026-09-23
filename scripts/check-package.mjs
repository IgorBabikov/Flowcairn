import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const cache = mkdtempSync(path.join(os.tmpdir(), 'flowcairn-pack-check-'));
try {
  assert.ok(process.env.npm_execpath, 'Запускайте через npm run check:package.');
  const result = spawnSync(process.execPath, [process.env.npm_execpath, 'pack', '--dry-run', '--ignore-scripts', '--json', '--cache', cache], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  const files = JSON.parse(result.stdout)[0].files.map(item => item.path);
  assert.ok(files.includes('bin/terminal.mjs'), 'Архив не содержит оформление терминала.');
  for (const required of ['bin/flowcairn.mjs', 'bin/workspaces.mjs', 'skills/project-context/SKILL.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'tools/ai-graph-viewer/dist/index.html', 'tools/ai-graph-viewer/dist/app.js', 'tools/ai-graph-viewer/dist/app.css'])
    assert.ok(files.includes(required), `Архив не содержит ${required}. Выполните npm run build.`);
  assert.ok(!files.some(file => /(^|\/)(node_modules|\.git|\.ai-orchestrator|\.env)(\/|$)/.test(file)));
  console.log(`Устанавливаемый архив: ${files.length} файлов; runtime, skills и собранный UI на месте.`);
} finally { rmSync(cache, { recursive: true, force: true }); }
