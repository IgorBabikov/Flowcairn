import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HARNESS_DESCRIPTORS, EXTERNAL_PROVIDER_CONSENT, externalProviderConsentHash, inspectHarnesses } from '../scripts/ai-graph/lib/harnesses.mjs';

test('harness registry keeps one native manifest and a distinct execution level per assistant', () => {
  assert.deepEqual(Object.keys(HARNESS_DESCRIPTORS), ['codex', 'claude', 'cursor']);
  const values = inspectHarnesses({ env: { PATH: '' } });
  assert.deepEqual(values.map((item) => [item.id, item.detected, item.runtime.execution]), [
    ['codex', false, 'runtime-adapter'],
    ['claude', false, 'restricted-cli-adapter'],
    ['cursor', false, 'isolated-cli-adapter'],
  ]);
});

test('detection returns only an executable on PATH and never marks it as permission to execute a Graph node', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flowcairn-harness-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const claude = path.join(root, 'claude');
  writeFileSync(claude, '#!/bin/sh\nexit 0\n');
  chmodSync(claude, 0o700);
  const item = inspectHarnesses({ env: { PATH: root } }).find((value) => value.id === 'claude');
  assert.equal(item.detected, true);
  assert.equal(item.runtime.execution, 'restricted-cli-adapter');
  assert.equal(item.runtime.status, 'available-after-probe');
});

test('external provider consent is a complete immutable disclosure, never a free-form approval', () => {
  const hash = 'a'.repeat(64);
  const value = {
    version: 1, provider: 'claude', planHash: hash, scopeHash: hash, instructionsHash: hash, skillsHash: hash, artifactsHash: hash,
    transmitted: [...EXTERNAL_PROVIDER_CONSENT.transmitted], excluded: [...EXTERNAL_PROVIDER_CONSENT.excluded],
  };
  assert.match(externalProviderConsentHash(value), /^[a-f0-9]{64}$/);
  assert.throws(() => externalProviderConsentHash({ ...value, transmitted: ['approved-scope', 'approved-scope'] }));
  assert.throws(() => externalProviderConsentHash({ ...value, excluded: EXTERNAL_PROVIDER_CONSENT.excluded.slice(1) }));
});

test('native manifests share the package version and the single Skills directory', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  for (const file of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json', '.cursor-plugin/plugin.json']) {
    const manifest = JSON.parse(readFileSync(path.join(root, file), 'utf8'));
    assert.equal(manifest.version, version);
  }
  assert.equal(JSON.parse(readFileSync(path.join(root, '.codex-plugin/plugin.json'), 'utf8')).skills, './skills/');
  assert.equal(JSON.parse(readFileSync(path.join(root, '.cursor-plugin/plugin.json'), 'utf8')).skills, './skills/');
});
