import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { INSTRUCTION_LIMITS, inspectInstructions, assessProjectInstructions, readInstructionBundle } from '../scripts/ai-graph/lib/instructions.mjs';
import { buildProjectInstructionContext, projectInstructionMetadata } from '../scripts/ai-graph/lib/project-instruction-context.mjs';
import { initializeCommand } from '../bin/flowcairn.mjs';
import { explainError } from '../scripts/ai-graph/lib/io.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'flowcairn-large-rules-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  write('package.json', '{"name":"fixture","version":"1.0.0"}');
  write('AGENTS.md', 'Owner project rules.\n');
  write('src/index.js', 'export const value = 1;\n');
  return { root, write, inspect: () => inspectInstructions({ projectRoot: root }) };
}

test('онбординг сохраняет большой справочник Skill и подключает только выбранные правила', async (t) => {
  const f = fixture(t);
  const guidePath = '.agents/skills/frontend/AGENTS.md';
  const guide = '# Reference\n' + 'Reference material.\n'.repeat(6000);
  assert.ok(Buffer.byteLength(guide) > 64 * 1024);
  f.write(guidePath, guide);
  f.write('.agents/skills/frontend/SKILL.md', '---\nname: frontend-guide\ndescription: Frontend reference\n---\nRead the relevant reference when needed.\n');
  f.write('.agents/skills/context/SKILL.md', '---\nname: project-context\ndescription: Project context\n---\nPreserve project contracts.\n');
  const manifest = f.inspect();
  assert.equal(manifest.complete, true);
  assert.equal(f.inspect().fingerprint, manifest.fingerprint);
  const report = assessProjectInstructions(f.root, { instructionManifest: manifest });
  assert.ok(report.findings.some((item) => item.path === guidePath && item.code === 'INSTRUCTION_CONTEXT_COST'));
  const result = await initializeCommand(f.root, {
    provider: 'claude',
    'provider-path': path.resolve('tests/fixtures/verified-claude/node_modules/@anthropic-ai/claude-code/bin/claude.exe'),
    json: true,
    consent: true,
  });
  assert.equal(result.created, true);
  assert.deepEqual(result.profile.skillManifest.map((item) => item.path), ['.agents/skills/context/SKILL.md']);
  assert.equal(readFileSync(path.join(f.root, guidePath), 'utf8'), guide);
});

test('большая обнаруженная инструкция не расширяет 64 KiB контекста AI-действия', (t) => {
  const f = fixture(t);
  f.write('large/AGENTS.md', 'Reference.\n'.repeat(9000));
  const profile = { ai: { provider: 'codex' }, contextPaths: [] };
  const node = { resources: { reads: ['AGENTS.md', 'large/AGENTS.md', 'src/index.js'], writes: ['src/index.js'] } };
  const task = { scope: ['src'], contextPaths: ['AGENTS.md', 'large/AGENTS.md'], forbiddenPaths: [] };
  const selected = projectInstructionMetadata(f.root, node, task, profile);
  assert.deepEqual(selected.map((item) => item.path), ['AGENTS.md']);
  assert.equal(buildProjectInstructionContext({ projectRoot: f.root, node, task, profile, expectedMetadata: selected }).files.length, 1);
  node.resources.writes = ['large/AGENTS.md'];
  task.scope = ['large'];
  const large = projectInstructionMetadata(f.root, node, task, profile);
  assert.throws(() => buildProjectInstructionContext({ projectRoot: f.root, node, task, profile, expectedMetadata: large }), { code: 'INSTRUCTION_CONTEXT_LIMIT' });
});

test('превышение лимита сообщает неполную проверку и путь вместо ложного изменения правил', (t) => {
  const f = fixture(t);
  f.write('nested/AGENTS.md', 'x'.repeat(INSTRUCTION_LIMITS.maxFileBytes + 1));
  const manifest = f.inspect();
  assert.equal(manifest.complete, false);
  assert.ok(manifest.audit.issues.some((item) => item.path === 'nested/AGENTS.md' && item.code === 'INSTRUCTION_LIMIT'));
  const check = (error) => {
    assert.equal(error.code, 'INSTRUCTION_INCOMPLETE');
    const explanation = explainError(error);
    assert.match(explanation.technical, /nested\/AGENTS\.md/);
    assert.match(explanation.technical, /INSTRUCTION_LIMIT/);
    assert.doesNotMatch(explanation.message, /Правила проекта изменились/);
    return true;
  };
  assert.throws(() => assessProjectInstructions(f.root, { instructionManifest: manifest }), check);
  assert.throws(() => readInstructionBundle({ projectRoot: f.root, expectedFingerprint: manifest.fingerprint, paths: ['AGENTS.md'] }), check);
});

test('суммарный лимит 1 MiB и уменьшенные границы discovery продолжают запрещать неполный набор', (t) => {
  const f = fixture(t);
  for (let index = 0; index < 5; index++) f.write(`rules-${index}/AGENTS.md`, 'x'.repeat(220 * 1024));
  assert.equal(INSTRUCTION_LIMITS.maxTotalBytes, 1024 * 1024);
  assert.equal(f.inspect().complete, false);
  assert.equal(inspectInstructions({ projectRoot: f.root, limits: { maxFileBytes: 64 * 1024 } }).complete, false);
  assert.throws(() => inspectInstructions({ projectRoot: f.root, limits: { maxFileBytes: INSTRUCTION_LIMITS.maxFileBytes + 1 } }), { code: 'INSTRUCTION_LIMIT' });
});
