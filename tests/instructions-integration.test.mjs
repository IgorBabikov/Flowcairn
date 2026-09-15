import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectInstructions, readInstructionBundle, readInstructionFile, assessProjectInstructions } from '../scripts/ai-graph/lib/instructions.mjs';
import { activateIntegration, inspectIntegration, INTEGRATION_JOURNAL, INTEGRATION_LOCK, replaceIntegrationFile } from '../scripts/ai-graph/lib/integration.mjs';
import { uninstallIntegration, assertUninstallSafe } from '../scripts/ai-graph/lib/uninstall.mjs';
function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'flowcairn-instructions-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (relative, content) => { mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); writeFileSync(path.join(root, relative), content); };
  const read = (relative) => readFileSync(path.join(root, relative));
  const inspect = () => inspectInstructions({ projectRoot: root });
  const activate = () => activateIntegration({ projectRoot: root, consent: true, expectedFingerprint: inspect().fingerprint });
  const safety = { projectRoot: root, processProbe: () => ({ state: 'stopped', verified: true, evidence: 'test-owned no-process fixture' }), worktreePaths: [] };
  const uninstall = () => uninstallIntegration(safety);
  return { root, write, read, inspect, activate, uninstall, safety };
}
test('AGENT.md is detected as owner context without claiming native client activation', (t) => {
  const f = fixture(t); f.write('AGENT.md', 'Правила владельца'); f.write('src/AGENT.md', 'Локальные правила');
  const manifest = f.inspect();
  assert.equal(manifest.files.length, 2);
  assert.equal(manifest.files[0].kind, 'agent-custom');
  assert.equal(manifest.files[1].scope, 'src');
  assert.equal(manifest.files[0].applicability, 'explicit-context-only; native activation not verified');
  f.activate(); f.uninstall();
  assert.equal(f.read('AGENT.md').toString(), 'Правила владельца');
});
test('instruction assessment returns advisory metadata and never certifies or replaces owner rules', (t) => {
  const f = fixture(t); f.write('AGENT.md', '');
  f.write('skills/custom/SKILL.md', '---\nname: custom\ndescription: Local rules\n---\n');
  const manifest = f.inspect(), before = f.read('AGENT.md');
  const report = assessProjectInstructions(f.root, { instructionManifest: manifest });
  assert.equal(report.quality, 'not-certified');
  assert.equal(report.recommendation, 'preserve-and-supplement');
  assert.ok(report.findings.some((finding) => finding.code === 'EMPTY_INSTRUCTION'));
  assert.ok(report.findings.some((finding) => finding.code === 'SKILL_BODY_MISSING'));
  assert.equal(report.bundledSkills.source, 'flowcairn-package');
  assert.equal(report.bundledSkills.requiresActivation, true);
  assert.equal(report.bundledSkills.copiesProjectFiles, false);
  assert.deepEqual(f.read('AGENT.md'), before);
  assert.ok(!JSON.stringify(report).includes('Local rules'));
  f.write('AGENT.md', 'changed');
  assert.throws(() => assessProjectInstructions(f.root, { instructionManifest: manifest }), { code: 'INSTRUCTION_CHANGED' });
});
test('empty project offers package skills without inventing missing role or quality evidence', (t) => {
  const f = fixture(t);
  const report = assessProjectInstructions(f.root, { instructionManifest: f.inspect() });
  assert.equal(report.recommendation, 'activate-bundled');
  assert.equal(report.semanticConflicts, 'not-assessed');
  assert.equal(existsSync(path.join(f.root, 'skills')), false);
});
test('discovery covers mixed root/scoped clients and project Skills, never reads secret/config/script files', (t) => {
  const f = fixture(t);
  for (const name of ['AGENTS.md', 'CLAUDE.md', '.cursorrules', 'src/AGENTS.md', '.cursor/rules/typescript.mdc', '.github/copilot-instructions.md', '.github/instructions/code.instructions.md', '.agents/skills/review/SKILL.md', '.claude/rules/code.md']) f.write(name, '# Local project instructions\n');
  for (const name of ['.env', '.npmrc', '.claude/settings.json', '.agents/skills/review/run.sh', 'node_modules/pkg/AGENTS.md', 'secrets/AGENTS.md']) f.write(name, 'must never be returned');
  const result = f.inspect();
  assert.equal(result.complete, true);
  assert.equal(result.files.length, 9);
  assert.equal(result.files.find((file) => file.kind === 'cursor-scoped').scope, '.');
  assert.equal(result.files.find((file) => file.path === 'src/AGENTS.md').scope, 'src');
  assert.throws(() => readInstructionFile(f.root, '.env'), { code: 'INSTRUCTION_SENSITIVE_PATH' });
  assert.ok(result.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256) && !('content' in file)));
  assert.equal(result.audit.semanticConflicts, 'not-assessed');
  assert.equal(result.audit.aiAssistance.performed, false);
  assert.ok(!JSON.stringify(result).includes('must never'));
  const bundle = readInstructionBundle({ projectRoot: f.root, expectedFingerprint: result.fingerprint, paths: ['AGENTS.md'] });
  assert.equal(bundle.files[0].content, '# Local project instructions\n');
  assert.throws(() => readInstructionBundle({ projectRoot: f.root, expectedFingerprint: result.fingerprint, paths: ['.env'] }), { code: 'INSTRUCTION_PATHS' });
});
test('root AGENTS override shadowing is structural evidence and selects one effective target', (t) => {
  const f = fixture(t);
  f.write('AGENTS.md', 'base'); f.write('AGENTS.override.md', 'override'); f.write('CLAUDE.md', 'claude');
  assert.ok(f.inspect().audit.issues.some((issue) => issue.code === 'AGENTS_SHADOWED_BY_OVERRIDE'));
  assert.equal(f.activate().target, 'AGENTS.override.md');
  assert.equal(f.read('AGENTS.md').toString(), 'base');
  assert.equal(f.read('CLAUDE.md').toString(), 'claude');
  f.uninstall();
  assert.equal(f.read('AGENTS.override.md').toString(), 'override');
});
for (const content of [null, '', 'user without newline', '# Проект\r\nПравила\r\n', Buffer.from([0xef, 0xbb, 0xbf, 0x23, 0x20, 0x58, 10])]) {
  test(`activation roundtrip preserves original bytes ${JSON.stringify(content)}`, (t) => {
    const f = fixture(t); if (content !== null) f.write('AGENTS.md', content);
    const before = f.inspect().fingerprint;
    assert.equal(f.activate().status, 'active');
    const activated = f.read('AGENTS.md'), journal = f.read(INTEGRATION_JOURNAL);
    assert.equal(f.activate().changed, false);
    assert.deepEqual(f.read('AGENTS.md'), activated); assert.deepEqual(f.read(INTEGRATION_JOURNAL), journal);
    assert.equal(f.uninstall().status, 'inactive');
    if (content === null) assert.equal(existsSync(path.join(f.root, 'AGENTS.md')), false);
    else assert.deepEqual(f.read('AGENTS.md'), Buffer.from(content));
    assert.equal(f.inspect().fingerprint, before);
    assert.equal(f.uninstall().changed, false);
  });
}
test('uninstall preserves user additions before and after managed block and foreign state', (t) => {
  const f = fixture(t); f.write('AGENTS.md', 'owner\n'); f.write('.ai-orchestrator/foreign.txt', 'keep'); f.activate();
  f.write('AGENTS.md', Buffer.concat([Buffer.from('prefix\n'), f.read('AGENTS.md'), Buffer.from('suffix\n')]));
  f.uninstall();
  assert.equal(f.read('AGENTS.md').toString(), 'prefix\nowner\nsuffix\n');
  assert.equal(f.read('.ai-orchestrator/foreign.txt').toString(), 'keep');
});
test('new owned file with later user text survives uninstall', (t) => {
  const f = fixture(t); f.activate(); f.write('AGENTS.md', Buffer.concat([f.read('AGENTS.md'), Buffer.from('owner\n')])); f.uninstall();
  assert.equal(f.read('AGENTS.md').toString(), 'owner\n');
});
test('activation requires consent and fresh fingerprint; instruction changes invalidate bundle', (t) => {
  const f = fixture(t); f.write('AGENTS.md', 'old'); const fingerprint = f.inspect().fingerprint;
  assert.throws(() => activateIntegration({ projectRoot: f.root, expectedFingerprint: fingerprint }), { code: 'INTEGRATION_CONSENT' });
  f.write('AGENTS.md', 'new');
  assert.throws(() => activateIntegration({ projectRoot: f.root, consent: true, expectedFingerprint: fingerprint }), { code: 'INTEGRATION_CONCURRENT_EDIT' });
  assert.throws(() => readInstructionBundle({ projectRoot: f.root, expectedFingerprint: fingerprint, paths: ['AGENTS.md'] }), { code: 'INSTRUCTION_CHANGED' });
  assert.equal(existsSync(path.join(f.root, INTEGRATION_JOURNAL)), false);
});
test('managed edits, duplicate markers and orphan blocks refuse without deletion', (t) => {
  const f = fixture(t); f.activate(); const original = f.read('AGENTS.md');
  f.write('AGENTS.md', original.toString().replace('Flowcairn активирован', 'User edited'));
  assert.equal(inspectIntegration({ projectRoot: f.root }).status, 'modified');
  assert.throws(f.uninstall, { code: 'INTEGRATION_MODIFIED' });
  assert.throws(f.activate, { code: 'INTEGRATION_CONFLICT' });
  f.write('AGENTS.md', Buffer.concat([original, original]));
  assert.throws(f.uninstall, { code: 'INTEGRATION_CONFLICT' });
  f.write('AGENTS.md', original); rmSync(path.join(f.root, INTEGRATION_JOURNAL));
  assert.throws(f.activate, { code: 'INTEGRATION_CONFLICT' });
  assert.throws(f.uninstall, { code: 'INTEGRATION_CONFLICT' });
});
test('symlink files, parents and hardlinks are not read or overwritten', (t) => {
  const f = fixture(t), outside = fixture(t); outside.write('AGENTS.md', 'outside');
  symlinkSync(path.join(outside.root, 'AGENTS.md'), path.join(f.root, 'AGENTS.md'));
  assert.equal(f.inspect().complete, false); assert.throws(f.activate, { code: 'INTEGRATION_INCOMPLETE_DISCOVERY' });
  rmSync(path.join(f.root, 'AGENTS.md')); linkSync(path.join(outside.root, 'AGENTS.md'), path.join(f.root, 'AGENTS.md'));
  assert.equal(f.inspect().complete, false); assert.throws(f.activate, { code: 'INTEGRATION_INCOMPLETE_DISCOVERY' });
  rmSync(path.join(f.root, 'AGENTS.md')); symlinkSync(outside.root, path.join(f.root, '.cursor'));
  assert.equal(f.inspect().complete, false);
  assert.equal(outside.read('AGENTS.md').toString(), 'outside');
});
test('linked integration storage refuses and keeps owner instructions', (t) => {
  const f = fixture(t), outside = fixture(t); f.write('AGENTS.md', 'owner'); symlinkSync(outside.root, path.join(f.root, '.ai-orchestrator'));
  assert.throws(f.activate, { code: 'INSTRUCTION_UNSAFE_PATH' });
  assert.equal(f.read('AGENTS.md').toString(), 'owner');
  assert.equal(existsSync(path.join(outside.root, 'flowcairn-integration.json')), false);
});
test('bounded discovery fails closed on oversize, entries and depth without exposing contents', (t) => {
  const f = fixture(t); f.write('AGENTS.md', 'x'.repeat(65537));
  assert.equal(f.inspect().complete, false); assert.throws(f.activate, { code: 'INTEGRATION_INCOMPLETE_DISCOVERY' });
  f.write('AGENTS.md', 'ok'); f.write('a/b/c/AGENTS.md', 'deep');
  assert.equal(inspectInstructions({ projectRoot: f.root, limits: { maxDepth: 1 } }).complete, false);
  assert.equal(inspectInstructions({ projectRoot: f.root, limits: { maxEntries: 1 } }).complete, false);
});
test('default discovery supports deep but bounded enterprise source trees', (t) => {
  const f = fixture(t);
  const nested = Array.from({ length: 16 }, (_, index) => `layer-${index}`).join('/');
  f.write(`${nested}/AGENTS.md`, 'scoped rule');
  const discovered = f.inspect();
  assert.equal(discovered.complete, true);
  assert.ok(discovered.files.some((file) => file.path === `${nested}/AGENTS.md`));
});
test('concurrent edits and live locks refuse; original user bytes survive', (t) => {
  const f = fixture(t); f.write('AGENTS.md', 'old'); const prior = readInstructionFile(f.root, 'AGENTS.md'); f.write('AGENTS.md', 'new');
  assert.throws(() => replaceIntegrationFile(f.root, 'AGENTS.md', Buffer.from('overwrite'), prior), { code: 'INTEGRATION_CONCURRENT_EDIT' });
  assert.equal(f.read('AGENTS.md').toString(), 'new');
  f.write(INTEGRATION_LOCK, 'occupied'); assert.throws(f.activate, { code: 'INTEGRATION_LOCKED' });
  assert.equal(f.read(INTEGRATION_LOCK).toString(), 'occupied');
});
test('uninstall refuses active/unknown processes and unknown worktree inventory', (t) => {
  const f = fixture(t); f.activate(); const original = f.read('AGENTS.md');
  assert.throws(() => uninstallIntegration({ projectRoot: f.root }), { code: 'UNINSTALL_PROCESS_UNKNOWN' });
  assert.throws(() => uninstallIntegration({ ...f.safety, processProbe: () => ({ state: 'active', verified: true, evidence: 'running' }) }), { code: 'UNINSTALL_PROCESS_UNKNOWN' });
  assert.throws(() => uninstallIntegration({ ...f.safety, worktreePaths: undefined }), { code: 'UNINSTALL_WORKTREE_UNKNOWN' });
  assert.deepEqual(f.read('AGENTS.md'), original);
});
test('dirty and clean-but-unintegrated worktrees refuse without deletion', (t) => {
  const f = fixture(t); const git = (...args) => execFileSync('/usr/bin/git', ['-C', f.root, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();
  git('init', '--initial-branch=main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  f.write('README.md', 'base'); git('add', '.'); git('commit', '-m', 'base');
  const wt = path.join(f.root, 'owned-worktree'); git('worktree', 'add', '-b', 'work', wt);
  f.write('owned-worktree/change.txt', 'pending');
  assert.throws(() => assertUninstallSafe({ ...f.safety, worktreePaths: [wt] }), { code: 'UNINSTALL_DIRTY_WORKTREE' });
  git('-C', wt, 'add', '.'); git('-C', wt, 'commit', '-m', 'work');
  assert.throws(() => assertUninstallSafe({ ...f.safety, worktreePaths: [wt] }), { code: 'UNINSTALL_UNINTEGRATED_WORKTREE' });
  assert.equal(existsSync(path.join(wt, 'change.txt')), true);
});

test('CLAUDE-only project preserves original client file and incomplete journal refuses', (t) => {
  const f = fixture(t); f.write('CLAUDE.md', 'architecture remains'); f.activate();
  assert.equal(f.read('CLAUDE.md').toString(), 'architecture remains');
  const journal = JSON.parse(f.read(INTEGRATION_JOURNAL));
  f.write(INTEGRATION_JOURNAL, JSON.stringify({ ...journal, phase: 'prepared' }));
  assert.equal(inspectIntegration({ projectRoot: f.root }).status, 'incomplete');
  assert.throws(f.activate, { code: 'INTEGRATION_CONFLICT' });
  assert.throws(f.uninstall, { code: 'INTEGRATION_CONFLICT' });
  assert.equal(f.read('CLAUDE.md').toString(), 'architecture remains');
});

test('uninstall refuses linked target or journal introduced after activation', (t) => {
  const f = fixture(t); f.activate(); const original = f.read('AGENTS.md');
  linkSync(path.join(f.root, 'AGENTS.md'), path.join(f.root, 'linked.md'));
  assert.throws(f.uninstall, { code: 'INSTRUCTION_UNSAFE_FILE' });
  assert.deepEqual(f.read('AGENTS.md'), original);
  rmSync(path.join(f.root, 'linked.md'));
  const journal = f.read(INTEGRATION_JOURNAL);
  f.write('journal-copy.json', journal); rmSync(path.join(f.root, INTEGRATION_JOURNAL));
  symlinkSync(path.join(f.root, 'journal-copy.json'), path.join(f.root, INTEGRATION_JOURNAL));
  assert.throws(f.uninstall, { code: 'INSTRUCTION_UNSAFE_FILE' });
  assert.deepEqual(f.read('AGENTS.md'), original);
});
