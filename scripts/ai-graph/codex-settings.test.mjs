import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexModelSettings } from './lib/codex-settings.mjs';

test('CLI settings reader returns only safe model defaults', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flowcairn-model-settings-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'config.toml');
  writeFileSync(file, 'model="gpt-5.6-sol"\nmodel_reasoning_effort="high"\nnotify=["do-not-run"]\ntoken="do-not-return"\n[hooks]\ncommand="do-not-load"\n');
  assert.deepEqual(codexModelSettings(file), { model: 'gpt-5.6-sol', reasoningEffort: 'high', source: 'codex-cli-user-config' });
  for (const contents of ['model="x"', 'model="sk-private"\nmodel_reasoning_effort="high"', 'model="x"\nmodel_reasoning_effort="invented"', 'bad="do-not-return']) {
    writeFileSync(file, contents);
    assert.throws(() => codexModelSettings(file), error => error.code === 'CODEX_MODEL_SETTINGS_REQUIRED' && !error.message.includes('do-not-return'));
  }
});
