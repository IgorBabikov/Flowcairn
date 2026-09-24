import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspectInstructions, effectiveInstructionFiles } from '../scripts/ai-graph/lib/instructions.mjs';
import { projectContextPaths } from '../scripts/ai-graph/lib/project.mjs';
import { projectInstructionMetadata, buildProjectInstructionContext } from '../scripts/ai-graph/lib/project-instruction-context.mjs';
import { TaskSpecSchema } from '../scripts/ai-graph/lib/schemas.mjs';
import { hashObject } from '../scripts/ai-graph/lib/io.mjs';
import { compilePlan } from '../scripts/ai-graph/lib/validator.mjs';
import { SKILL_ROUTES } from '../scripts/ai-graph/lib/config.mjs';
import { RUNNER_TESTING } from '../scripts/ai-graph/lib/runner.mjs';
import { defaultAdapters } from '../scripts/ai-graph/lib/service-adapters.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'flowcairn-instruction-context-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, content) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), content); };
  const git = (...args) => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root,
    env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }, stdio: 'pipe' });
  git('init', '--initial-branch=main');
  write('AGENTS.md', 'SHADOWED BASE RULE MUST NOT ENTER CODEX INPUT');
  write('src/value.mjs', 'export const value = 1;\n');
  write('.gitignore', 'AGENTS.override.md\nlocal-rules.md\n.ai-orchestrator/\n');
  git('add', '.'); git('commit', '-m', 'fixture baseline');
  write('AGENTS.override.md', 'ACTIVE OVERRIDE RULE');
  write('local-rules.md', 'EXPLICIT LOCAL CONTEXT');
  const profile = { ai: { provider: 'codex', model: 'fixture-model', modelMode: 'manual', reasoningEffort: 'low' },
    contextPaths: ['AGENTS.md', 'AGENTS.override.md', 'local-rules.md'], manifests: [], outputPaths: [] };
  const task = TaskSpecSchema.parse({ schemaVersion: 2, sourceHash: hashObject('source'), id: 'TASK-RULES', goal: 'Change value', instructions: 'Change value safely',
    acceptance: ['Value changed'], scope: ['src'], contextPaths: projectContextPaths(root, profile), checks: [] });
  const hash = hashObject('skill');
  const skills = [...new Set(Object.values(SKILL_ROUTES).flat())].map((id) => ({ id, path: `skills/${id}/SKILL.md`, hash }));
  const plan = compilePlan(task, { runtimeHash: hash, skills }).plan;
  const node = structuredClone(plan.nodes.find((item) => item.action.id === 'ai-implement'));
  node.resources.reads = ['src', ...task.contextPaths];
  const activePlan = { ...plan, nodes: plan.nodes.map((item) => item.id === node.id ? node : item) };
  return { root, write, git, profile, task, node, plan: activePlan };
}

test('Codex shadows only sibling AGENTS; scoped and Claude chains remain separate', (t) => {
  const f = fixture(t);
  f.write('CLAUDE.md', 'CLAUDE CHAIN');
  f.write('src/AGENTS.md', 'SCOPED BASE'); f.write('src/AGENTS.override.md', 'SCOPED OVERRIDE');
  f.write('other/AGENTS.md', 'OTHER SCOPE');
  const manifest = inspectInstructions({ projectRoot: f.root });
  const codex = effectiveInstructionFiles(manifest, { provider: 'codex', scope: ['src'] }).map((file) => file.path);
  assert.ok(codex.includes('AGENTS.override.md'));
  assert.ok(codex.includes('src/AGENTS.override.md'));
  assert.ok(codex.includes('CLAUDE.md'));
  assert.ok(!codex.includes('AGENTS.md') && !codex.includes('src/AGENTS.md') && !codex.includes('other/AGENTS.md'));
  const claude = effectiveInstructionFiles(manifest, { provider: 'claude', scope: ['src'] }).map((file) => file.path);
  assert.ok(claude.includes('AGENTS.md') && claude.includes('CLAUDE.md'));
  assert.ok(projectContextPaths(f.root, { ...f.profile, ai: { provider: 'claude' } }).includes('AGENTS.md'));
  assert.ok(!projectContextPaths(f.root, f.profile).includes('AGENTS.md'));
});

test('ignored instructions reach the exact prompt without copying instruction files and uses the current project root', (t) => {
  const f = fixture(t), worktree = path.join(f.root, '.ai-orchestrator/worktrees/task');
  mkdirSync(path.dirname(worktree), { recursive: true });
  f.git('worktree', 'add', '--detach', worktree, 'HEAD');
  assert.equal(existsSync(path.join(worktree, 'AGENTS.override.md')), false);
  assert.equal(existsSync(path.join(worktree, 'local-rules.md')), false);
  const expectedMetadata = projectInstructionMetadata(f.root, f.node, f.task, f.profile);
  const bundle = buildProjectInstructionContext({ projectRoot: f.root, node: f.node, task: f.task, profile: f.profile, expectedMetadata });
  assert.deepEqual(bundle.files.map((file) => file.path), ['AGENTS.override.md', 'local-rules.md']);
  const outputPath = path.join(f.root, 'output'); mkdirSync(outputPath);
  const prepared = RUNNER_TESTING.makeAiCommand({ worktree, node: f.node, task: f.task, plan: f.plan, skills: [],
    priorEvidence: { instructionMetadata: expectedMetadata }, projectInstructions: bundle, reviewBundle: null, outputPath,
    profile: f.profile, toolchain: { node: process.execPath, codexEntry: '/trusted/codex.js', digest: hashObject('runner') },
    dependencyToolchain: { dependencyPaths: [], hash: hashObject('dependencies') },
    instructionDenials: ['AGENTS.md'] });
  try {
    assert.match(prepared.input, /ACTIVE OVERRIDE RULE/);
    assert.match(prepared.input, /EXPLICIT LOCAL CONTEXT/);
    assert.doesNotMatch(prepared.input, /SHADOWED BASE RULE/);
    assert.equal(prepared.execution.projectInstructionHash, bundle.hash);
    assert.equal(JSON.stringify(prepared.execution).includes('ACTIVE OVERRIDE RULE'), false);
    const filesystem = prepared.command.args.find((item) => item.startsWith('permissions.') && item.includes('.filesystem='));
    assert.ok(!filesystem.includes(`${f.root}/AGENTS.override.md`));
    assert.ok(filesystem.includes(`${JSON.stringify(worktree)}="read"`));
    assert.ok(prepared.sourceIndex.files.some((file) => file.path === 'AGENTS.md'));
    assert.equal(existsSync(path.join(worktree, 'AGENTS.override.md')), false);
  } finally { RUNNER_TESTING.cleanupPrepared(prepared); }
});

test('missing approval metadata or changed instruction bytes fail before prompt generation', (t) => {
  const f = fixture(t);
  const expectedMetadata = projectInstructionMetadata(f.root, f.node, f.task, f.profile);
  assert.throws(() => buildProjectInstructionContext({ projectRoot: f.root, node: f.node, task: f.task, profile: f.profile }), { code: 'INSTRUCTION_CHANGED' });
  f.write('AGENTS.override.md', 'CHANGED AFTER APPROVED SNAPSHOT');
  assert.throws(() => buildProjectInstructionContext({ projectRoot: f.root, node: f.node, task: f.task, profile: f.profile, expectedMetadata }), { code: 'INSTRUCTION_CHANGED' });
});

test('production adapters select effective rules and pin explicit ignored Markdown without source writes', async (t) => {
  const f = fixture(t);
  f.write('package.json', '{"name":"instruction-fixture","version":"1.0.0"}\n');
  f.write('.flowcairn.json', JSON.stringify({ ...f.profile, version: 1, integrationBranch: 'main', packageManager: 'npm', checks: [], checkMode: 'none', manifests: ['package.json'] }));
  const adapters = await defaultAdapters(f.root);
  const paths = adapters.resolveReadPaths(f.node, f.task);
  assert.ok(paths.includes('AGENTS.override.md') && !paths.includes('AGENTS.md'));
  assert.ok(adapters.instructionPaths(f.task).includes('AGENTS.override.md'));
  assert.ok(!adapters.instructionPaths(f.task).includes('AGENTS.md'));
  const metadata = adapters.instructionMetadata({ ...f.node, resources: { ...f.node.resources, reads: paths } }, f.task);
  assert.deepEqual(metadata.map((file) => file.path), ['AGENTS.override.md', 'local-rules.md']);
  assert.equal(existsSync(path.join(f.root, '.ai-orchestrator')), false);
});

test('task-only ignored Markdown is delivered and its bytes participate in immutable context identity', async (t) => {
  const f = fixture(t), profile = { ...f.profile, contextPaths: [] };
  f.write('package.json', '{"name":"task-context-fixture","version":"1.0.0"}\n');
  f.write('.flowcairn.json', JSON.stringify({ ...profile, version: 1, integrationBranch: 'main', packageManager: 'npm', checks: [], checkMode: 'none', manifests: ['package.json'] }));
  const adapters = await defaultAdapters(f.root);
  const expectedMetadata = adapters.instructionMetadata(f.node, f.task);
  assert.ok(expectedMetadata.some((file) => file.path === 'local-rules.md'));
  const bundle = buildProjectInstructionContext({ projectRoot: f.root, node: f.node, task: f.task, profile, expectedMetadata });
  assert.match(bundle.files.find((file) => file.path === 'local-rules.md').content, /EXPLICIT LOCAL CONTEXT/);
  const before = adapters.contextHash(f.task);
  f.write('local-rules.md', 'CHANGED TASK-ONLY CONTEXT');
  assert.notEqual(adapters.contextHash(f.task), before);
  assert.throws(() => buildProjectInstructionContext({ projectRoot: f.root, node: f.node, task: f.task, profile, expectedMetadata }), { code: 'INSTRUCTION_CHANGED' });
});

test('an expressly scoped shadowed AGENTS file stays readable as data without activating its instructions', async (t) => {
  const f = fixture(t);
  f.write('package.json', '{"name":"instruction-edit-fixture","version":"1.0.0"}\n');
  f.write('.flowcairn.json', JSON.stringify({ ...f.profile, version: 1, integrationBranch: 'main', packageManager: 'npm', checks: [], checkMode: 'none', manifests: ['package.json'] }));
  const adapters = await defaultAdapters(f.root);
  const task = TaskSpecSchema.parse({ ...f.task, scope: ['src', 'AGENTS.md'] });
  const node = { ...f.node, resources: { ...f.node.resources, reads: ['AGENTS.md', ...f.node.resources.reads], writes: ['AGENTS.md'] } };
  node.resources.reads = adapters.resolveReadPaths(node, task);
  assert.ok(node.resources.reads.includes('AGENTS.md'));
  const planner = { ...node, action: { id: 'ai-plan' }, resources: { ...node.resources, writes: [] } };
  assert.ok(adapters.resolveReadPaths(planner, task).includes('AGENTS.md'));
  const expectedMetadata = adapters.instructionMetadata(node, task);
  const bundle = buildProjectInstructionContext({ projectRoot: f.root, node, task, profile: f.profile, expectedMetadata });
  assert.ok(!bundle.files.some((file) => file.path === 'AGENTS.md'));
  assert.deepEqual(bundle.dataPaths, ['AGENTS.md']);
  assert.equal(JSON.stringify(bundle.files).includes('SHADOWED BASE RULE'), false);
  const worktree = path.join(f.root, '.ai-orchestrator/worktrees/task');
  mkdirSync(path.dirname(worktree), { recursive: true }); f.git('worktree', 'add', '--detach', worktree, 'HEAD');
  const outputPath = path.join(f.root, 'output'); mkdirSync(outputPath);
  const prepared = RUNNER_TESTING.makeAiCommand({ worktree, node, task, plan: { ...f.plan, nodes: [node] }, skills: [],
    priorEvidence: { instructionMetadata: expectedMetadata }, projectInstructions: bundle, reviewBundle: null, outputPath,
    profile: f.profile, toolchain: { node: process.execPath, codexEntry: '/trusted/codex.js', digest: hashObject('runner') },
    dependencyToolchain: { dependencyPaths: [], hash: hashObject('dependencies') } });
  try {
    assert.ok(prepared.command.args.includes('project_doc_max_bytes=0'));
    assert.match(prepared.input, /явно выбраны как объекты изменения/);
    assert.doesNotMatch(prepared.input, /SHADOWED BASE RULE/);
    assert.ok(prepared.sourceIndex.files.some((file) => file.path === 'AGENTS.md'));
    assert.ok(prepared.command.args.includes('project_doc_max_bytes=0'));
  } finally { RUNNER_TESTING.cleanupPrepared(prepared); }
  assert.ok(!adapters.resolveReadPaths(f.node, f.task).includes('AGENTS.md'), 'broad scope cannot reactivate a shadowed instruction');
});

test('instruction text stays bounded and no links or extra Markdown paths are followed', (t) => {
  const f = fixture(t);
  f.write('AGENTS.override.md', '[Reference](unapproved.md)\n' + 'x'.repeat(40000));
  f.write('local-rules.md', 'y'.repeat(30000));
  f.write('unapproved.md', 'MUST NOT BE INCLUDED');
  const expectedMetadata = projectInstructionMetadata(f.root, f.node, f.task, f.profile);
  assert.ok(!expectedMetadata.some((file) => file.path === 'unapproved.md'));
  assert.throws(() => buildProjectInstructionContext({ projectRoot: f.root, node: f.node, task: f.task, profile: f.profile, expectedMetadata }), { code: 'INSTRUCTION_CONTEXT_LIMIT' });
});
