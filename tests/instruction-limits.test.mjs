import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { INSTRUCTION_LIMITS, inspectInstructions, assessProjectInstructions, readInstructionBundle, inspectInstructionFile } from '../scripts/ai-graph/lib/instructions.mjs';
import { buildProjectInstructionContext, projectInstructionMetadata } from '../scripts/ai-graph/lib/project-instruction-context.mjs';
import { initializeCommand } from '../bin/flowcairn.mjs';
import { createHash } from 'node:crypto';
import { INSTRUCTION_READ_CHUNK_BYTES } from '../scripts/ai-graph/lib/instruction-reader.mjs';
import { prepareInstructionReferences, verifyInstructionReference } from '../scripts/ai-graph/lib/instruction-references.mjs';
import { discoverProjectSkillCandidates, createProjectSkillManifest, loadSkill } from '../scripts/ai-graph/lib/skills.mjs';
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

test('большая применимая инструкция передается полностью через закрепленную файловую ссылку', (t) => {
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
  const context = buildProjectInstructionContext({ projectRoot: f.root, node, task, profile, expectedMetadata: large });
  const reference = context.files.find((file) => file.path === 'large/AGENTS.md');
  assert.equal(reference.source.bytes, Buffer.byteLength('Reference.\n'.repeat(9000)));
  assert.equal(reference.source.sha256, large.find((file) => file.path === reference.path).sha256);
  const scratch = f.fixtureScratch = path.join(f.root, '.ai-orchestrator', 'scratch');
  mkdirSync(scratch, { recursive: true });
  const copies = prepareInstructionReferences(f.root, scratch, [reference.source]);
  assert.equal(readFileSync(copies[0].path, 'utf8'), 'Reference.\n'.repeat(9000));
  verifyInstructionReference(copies[0]);
});

test('превышение лимита сообщает неполную проверку и путь вместо ложного изменения правил', (t) => {
  const f = fixture(t);
  f.write('nested/AGENTS.md', 'x'.repeat(256 * 1024 + 1));
  const manifest = inspectInstructions({ projectRoot: f.root, limits: { maxFileBytes: 64 * 1024 } });
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
  assert.throws(() => readInstructionBundle({ projectRoot: f.root, expectedFingerprint: manifest.fingerprint, paths: ['AGENTS.md'] }), { code: 'INSTRUCTION_CHANGED' });
  f.write('nested/AGENTS.md', Buffer.from([0xff]));
  const broken = f.inspect();
  assert.throws(() => readInstructionBundle({ projectRoot: f.root, expectedFingerprint: broken.fingerprint, paths: ['AGENTS.md'] }), { code: 'INSTRUCTION_INCOMPLETE' });
});

test('полный inventory проходит прежние границы размера, числа, глубины и объема', (t) => {
  const f = fixture(t);
  for (let index = 0; index < 270; index++) f.write(`rules-${index}/AGENTS.md`, 'правило\n'.repeat(400));
  f.write('large/AGENTS.md', 'x'.repeat(1024 * 1024 + 1));
  f.write(`${'d/'.repeat(40)}AGENTS.md`, 'deep');
  const manifest = f.inspect();
  assert.equal(manifest.complete, true);
  assert.equal(manifest.files.length, 273);
  assert.equal(f.inspect().fingerprint, manifest.fingerprint);
  for (const value of Object.values(INSTRUCTION_LIMITS)) assert.equal(value, null);
  assert.equal(inspectInstructions({ projectRoot: f.root, limits: { maxFileBytes: 64 * 1024 } }).complete, false);
  assert.throws(() => inspectInstructions({ projectRoot: f.root, limits: { maxFileBytes: Infinity } }), { code: 'INSTRUCTION_LIMIT' });
});

test('потоковый учет хеширует все байты, проверяет UTF-8 на границах и не растит порцию', (t) => {
  const f = fixture(t), body = 'a'.repeat(INSTRUCTION_READ_CHUNK_BYTES - 1) + 'Я\r\n' + 'текст\n'.repeat(200000);
  f.write('large/AGENTS.md', body);
  let largest = 0, count = 0;
  const data = inspectInstructionFile(f.root, 'large/AGENTS.md', { onChunk: (bytes) => { largest = Math.max(largest, bytes.length); count++; } });
  assert.equal(data.sha256, createHash('sha256').update(body).digest('hex'));
  assert.equal(data.size, Buffer.byteLength(body));
  assert.ok(count > 10); assert.ok(largest <= INSTRUCTION_READ_CHUNK_BYTES);
  assert.equal(data.nonempty, true);
});

test('отмена и ошибка не дают полный inventory; повторная проверка восстанавливается без записи', (t) => {
  const f = fixture(t); f.write('large/AGENTS.md', 'x'.repeat(300000));
  const abort = new AbortController();
  assert.throws(() => inspectInstructionFile(f.root, 'large/AGENTS.md', { signal: abort.signal, onChunk: () => abort.abort() }), { code: 'INSTRUCTION_CANCELLED' });
  assert.equal(inspectInstructions({ projectRoot: f.root, signal: abort.signal }).complete, false);
  assert.equal(f.inspect().complete, true);
  f.write('large/AGENTS.md', Buffer.concat([Buffer.alloc(70000, 120), Buffer.from([0xff])]));
  assert.equal(f.inspect().complete, false);
  f.write('large/AGENTS.md', 'restored');
  const original = f.inspect().fingerprint;
  assert.throws(() => inspectInstructionFile(f.root, 'large/AGENTS.md', { onChunk: () => f.write('large/AGENTS.md', 'changed!') }), { code: 'INSTRUCTION_CHANGED' });
  assert.notEqual(f.inspect().fingerprint, original);
});

test('большой Skill и больше четырех выбранных Skills регистрируются без загрузки тел в profile', (t) => {
  const f = fixture(t);
  for (let i = 0; i < 70; i++) f.write(`skills/local-${i}/SKILL.md`, `---\nname: local-${i}\ndescription: Scoped rules\n---\n` + 'rule\n'.repeat(i === 0 ? 100000 : 1));
  const manifest = f.inspect(), preview = discoverProjectSkillCandidates(f.root, { instructionManifest: manifest });
  assert.equal(preview.candidates.length, 70); assert.ok(preview.candidates.every((file) => file.eligible));
  const selected = createProjectSkillManifest(f.root, { instructionManifest: manifest, expectedFingerprint: preview.fingerprint,
    selections: preview.candidates.map((file) => ({ path: file.path, scope: ['src'], actions: ['ai-review'] })) });
  assert.equal(selected.length, 70);
  const loaded = loadSkill(f.root, 'project-local-0', { projectSkills: selected });
  assert.ok(loaded.source.bytes > 256 * 1024); assert.ok(loaded.text.length < 2000);
  assert.equal(JSON.stringify(selected).includes('rule\n'), false);
  f.write(loaded.path, 'changed');
  assert.throws(() => loadSkill(f.root, loaded.name, { projectSkills: selected }), { code: 'SKILL_DRIFT' });
});

test('полная длинная постановка хранится и передается по точной ссылке без усечения окончания', async (t) => {
  const f = fixture(t);
  const { TaskSpecSchema } = await import('../scripts/ai-graph/lib/schemas.mjs');
  const { compilePlanningPlan } = await import('../scripts/ai-graph/lib/planning.mjs');
  const { hashObject } = await import('../scripts/ai-graph/lib/io.mjs');
  const { RUNNER_TESTING } = await import('../scripts/ai-graph/lib/runner.mjs');
  const { GraphStore } = await import('../scripts/ai-graph/lib/store.mjs');
  const text = 'Исходные условия.\n'.repeat(6000) + 'FINAL_MANDATORY_REQUIREMENT';
  const task = TaskSpecSchema.parse({ schemaVersion: 3, id: 'TASK-LONG', sourceHash: hashObject('source'), goal: 'Полная постановка',
    instructions: text, intakeKind: 'natural', acceptance: [text], scope: ['src'], contextPaths: [], checks: ['tests'] });
  const store = new GraphStore(f.root), taskHash = store.putObject('tasks', task);
  assert.deepEqual(store.readObject('tasks', taskHash), task);
  const { BUILTIN_SKILL_IDS } = await import('../scripts/ai-graph/lib/config.mjs');
  const loaded = BUILTIN_SKILL_IDS.map((id) => loadSkill(f.root, id));
  const definition = { id: 'tests', title: 'Проверить', purpose: 'Synthetic verifier', command: { executable: 'verifier', argv: [], cwd: '.' },
    inputPaths: [], outputPaths: [], timeoutMs: 5000, maxOutputBytes: 65536 };
  const checks = { version: 1, profileHash: hashObject('profile'), definitions: [definition], bindings: [{ id: 'tests',
    definitionHash: hashObject(definition), executableHash: hashObject('executable'), invocationHash: hashObject('invocation'),
    inputManifestHash: hashObject('inputs'), toolchainHash: hashObject('toolchain') }] };
  const context = { runtimeHash: hashObject('runtime'), checks, workflow: 'autonomous',
    skills: loaded.map((skill) => ({ id: skill.name, path: skill.path, hash: skill.hash })), contextHash: hashObject('context') };
  const plan = compilePlanningPlan(task, context).plan;
  const planHash = store.putObject('plans', plan); assert.deepEqual(store.readObject('plans', planHash), plan);
  const node = plan.nodes.find((item) => item.action.id === 'ai-analyze');
  const prepared = RUNNER_TESTING.makeAiCommand({ root: f.root, worktree: f.root, node, task, plan, skills: loaded.filter((skill) => node.skills.includes(skill.name)),
    priorEvidence: {}, projectInstructions: null, reviewBundle: null, profile: { ai: { provider: 'codex', model: 'fixture' }, outputPaths: [] },
    toolchain: { node: process.execPath, codexEntry: '/trusted/codex.js', digest: hashObject('runner') }, dependencyToolchain: { dependencyPaths: [], hash: hashObject('dependencies') } });
  const reference = prepared.instructionReferences.find((item) => item.sourcePath === 'original-task');
  try {
    assert.ok(reference); assert.equal(reference.hash, taskHash);
    const delivered = JSON.parse(readFileSync(reference.path, 'utf8'));
    assert.equal(delivered.instructions, text); assert.equal(delivered.acceptance[0], text);
    assert.ok(delivered.instructions.endsWith('FINAL_MANDATORY_REQUIREMENT'));
    assert.ok(Buffer.byteLength(prepared.input) < 128 * 1024);
    assert.ok(prepared.input.includes(reference.hash));
  } finally { RUNNER_TESTING.cleanupPrepared(prepared); }
});
