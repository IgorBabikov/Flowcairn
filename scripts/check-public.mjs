import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const excluded = new Set([
  '.git',
  'node_modules',
  '.ai-orchestrator',
  '.superpowers',
  'output',
  'test-results',
  'playwright-report',
  'coverage',
]);
const required = [
  'README.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'bin/flowcairn.mjs',
  'docs/INSTALLATION.md',
  'docs/FIRST-TASK.md',
  'docs/HOW-FLOWCAIRN-WORKS.md',
  'docs/ARCHITECTURE.md',
];
for (const file of required) assert.ok(existsSync(path.join(root, file)), `Отсутствует ${file}`);
const files = [];
function walk(directory) {
  for (const name of readdirSync(directory)) {
    if (excluded.has(name) || name.endsWith('.tgz')) continue;
    const absolute = path.join(directory, name),
      stat = lstatSync(absolute);
    assert.equal(
      stat.isSymbolicLink(),
      false,
      `Ссылка в public source: ${path.relative(root, absolute)}`,
    );
    if (stat.isDirectory()) walk(absolute);
    else files.push(absolute);
  }
}
walk(root);
const privateMarkers = [
  new RegExp('/Users/' + 'igorbabikov', 'i'),
  new RegExp('\\.marketing' + '-hq'),
  new RegExp('run-graph-' + 'acceptance-005'),
  new RegExp('01a0950f-' + '55f5-71e0'),
];
const credentials =
  /(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-proj-[A-Za-z0-9_-]{30,})/;
for (const absolute of files) {
  const relative = path.relative(root, absolute);
  const privateRoots = ['apps', 'packages', '.claude', '.codex', '.marketing' + '-hq'];
  assert.ok(!privateRoots.includes(relative.split(path.sep)[0]), `Лишняя область ${relative}`);
  assert.ok(!/(?:^|\/)\.env(?:\.|$)/.test(relative), `Env-файл ${relative}`);
  if (!/\.(?:mjs|cjs|js|ts|tsx|json|md|yml|yaml|html|css|svg)$/.test(relative)) continue;
  const text = readFileSync(absolute, 'utf8');
  assert.ok(!privateMarkers.some((rule) => rule.test(text)), `Приватный маркер: ${relative}`);
  assert.ok(!credentials.test(text), `Похожее на credential значение: ${relative}`);
  if (relative.endsWith('.md')) {
    for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
      const link = match[1];
      if (/^(?:https?:|mailto:|#)/.test(link)) continue;
      const file = decodeURIComponent(link.split('#')[0]);
      if (file)
        assert.ok(
          existsSync(path.resolve(path.dirname(absolute), file)),
          `Битая ссылка ${relative}: ${link}`,
        );
    }
  }
}
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.equal(pkg.name, 'flowcairn');
assert.equal(pkg.license, 'MIT');
assert.equal(pkg.bin.flowcairn, 'bin/flowcairn.mjs');
assert.ok(pkg.files.includes('tools/ai-graph-viewer/dist'));
console.log(
  `Public source: ${files.length} файлов; обязательные документы, ссылки и базовая проверка приватных данных — PASS.`,
);
console.log(
  'Эта проверка дополняет независимый просмотр списка публикации, а не заменяет secret scanning.',
);
