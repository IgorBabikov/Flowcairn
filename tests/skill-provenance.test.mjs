import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSkill } from '../scripts/ai-graph/lib/skills.mjs';
import { readLearningMethod } from '../scripts/ai-graph/lib/learning-prompt.mjs';
import { sha256 } from '../scripts/ai-graph/lib/io.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const provenance = JSON.parse(readFileSync(path.join(root, 'skills/PROVENANCE.json'), 'utf8'));

test('распространяемые адаптации совпадают с provenance и реально загружаемыми методами', t => {
  const project = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-skill-provenance-')));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  assert.equal(provenance.schemaVersion, 1);
  assert.ok(provenance.adaptedFiles.length > 0);
  const paths = new Set();
  for (const file of provenance.adaptedFiles) {
    assert.match(file.path, /^skills\/[a-z][a-z-]+\/SKILL\.md$/);
    assert.equal(paths.has(file.path), false, file.path);
    paths.add(file.path);
    const bytes = readFileSync(path.join(root, file.path));
    assert.equal(sha256(bytes), file.sha256, file.path);
    assert.equal(bytes.length, file.bytes, file.path);
    const id = file.path.split('/')[1];
    const loaded = id === 'implementation-lesson' ? readLearningMethod() : loadSkill(project, id);
    assert.equal(loaded.hash, file.sha256, id);
  }
});

test('каждая включенная адаптация сохраняет закрепленный источник и полный проверенный текст лицензии', () => {
  const targets = new Set(provenance.adaptedFiles.map(file => file.path));
  const covered = new Set();
  for (const selected of provenance.selected) {
    assert.match(selected.repository, /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
    assert.match(selected.commit, /^[a-f0-9]{40}$/);
    assert.ok(['MIT', 'Apache-2.0'].includes(selected.license.spdx));
    assert.match(selected.license.bundledPath, /^skills\/licenses\/[a-zA-Z0-9_.-]+\.txt$/);
    assert.equal(sha256(readFileSync(path.join(root, selected.license.bundledPath))), selected.license.sha256);
    for (const source of selected.sources) {
      assert.ok(source.url.startsWith(selected.repository.replace('github.com', 'raw.githubusercontent.com') + '/' + selected.commit + '/'));
      assert.match(source.sha256, /^[a-f0-9]{64}$/);
      assert.ok(Number.isSafeInteger(source.bytes) && source.bytes > 0);
    }
    assert.deepEqual(selected.dependencies.importedExecutables, []);
    assert.deepEqual(selected.dependencies.addedPackages, []);
    assert.equal(selected.dependencies.runtimeNetworkFetch, false);
    for (const target of selected.targets) { assert.ok(targets.has(target), target); covered.add(target); }
  }
  assert.deepEqual([...covered].sort(), [...targets].sort());
});
