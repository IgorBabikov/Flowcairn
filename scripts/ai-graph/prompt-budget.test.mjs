import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fitPromptBudget } from './lib/prompt-budget.mjs';
import { buildPrompt } from './lib/codex.mjs';
import { renderSkillInstructions } from './lib/skills.mjs';
import { RUNNER_TESTING } from './lib/runner.mjs';
import { sha256 } from './lib/io.mjs';

const node = { id: 'plan-task', action: { id: 'ai-plan' }, resources: { reads: ['src'], writes: [] }, skills: [] };
const task = { goal: 'A required outcome', instructions: 'Prepare a safe implementation', scope: ['src'], contextPaths: [], forbiddenPaths: [],
  acceptance: ['The required outcome works'], checks: ['tests'] };

test('actual Codex prompt removes exact duplicate feedback and measures only the rendered prior evidence', (t) => {
  const outputPath = mkdtempSync(path.join(tmpdir(), 'flowcairn-prompt-budget-'));
  t.after(() => rmSync(outputPath, { recursive: true, force: true }));
  const planningFeedback = Array.from({ length: 3 }, (_, index) => `${index}: ${'f'.repeat(3495)}`);
  const currentTask = { ...task, planningFeedback };
  const currentNode = { ...node, skills: ['project-context', 'core-analysis', 'core-planning'] };
  const skills = currentNode.skills.map((name) => {
    const text = `---\nname: ${name}\ndescription: Synthetic instructions\n---\n${'s'.repeat(11800)}`;
    return { name, text, hash: sha256(text), path: `skills/${name}/SKILL.md` };
  });
  const plan = { nodes: [currentNode] };
  const priorEvidence = { feedback: planningFeedback, analysis: { complete: 'a'.repeat(8000) }, verificationChecks: [], reviewFindings: [] };
  const original = structuredClone(priorEvidence);
  const projectInstructions = { files: [{ path: 'AGENTS.md', content: '' }], hash: 'a'.repeat(64) };
  const render = () => buildPrompt({ nodeId: node.id, task: currentTask, plan, skills: renderSkillInstructions(skills), priorEvidence, projectInstructions });
  projectInstructions.files[0].content = 'p'.repeat(128 * 1024 + 4000 - Buffer.byteLength(render()));
  assert.ok(projectInstructions.files[0].content.length <= 64 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(priorEvidence)) <= 32 * 1024);
  const originalPrompt = render();
  assert.ok(Buffer.byteLength(originalPrompt) > 128 * 1024);
  const prepared = RUNNER_TESTING.makeAiCommand({ node: currentNode, task: currentTask, plan, skills, priorEvidence, projectInstructions,
    worktree: '/private/tmp/isolated-worktree', outputPath, reviewBundle: null,
    profile: { ai: { model: 'fixture-model' }, outputPaths: [] },
    toolchain: { node: process.execPath, codexEntry: '/trusted/codex.js', digest: 'a'.repeat(64) },
    dependencyToolchain: { dependencyPaths: [], hash: 'b'.repeat(64) } });
  try {
    assert.ok(Buffer.byteLength(prepared.input) <= 128 * 1024);
    assert.equal(prepared.input.includes('"feedback":'), false);
    for (const feedback of planningFeedback) assert.ok(prepared.input.includes(feedback));
    const { feedback: _feedback, ...renderedEvidence } = original;
    assert.equal(prepared.execution.context.priorEvidenceBytes, Buffer.byteLength(JSON.stringify(renderedEvidence)));
    assert.equal(prepared.execution.context.promptBytes, Buffer.byteLength(prepared.input));
    assert.deepEqual(priorEvidence, original);
  } finally { RUNNER_TESTING.cleanupPrepared(prepared); }
});

test('budget removes optional excerpts before file inventory while retaining mandatory evidence', () => {
  const priorEvidence = { analysis: { full: 'Complete analysis' }, verificationChecks: [{ receiptId: 'verified-receipt' }],
    reviewFindings: [{ requirementId: 'req-001', message: 'Repair this requirement' }],
    artifacts: [{ id: 'artifact-a', excerpt: 'a'.repeat(1000) }, { id: 'artifact-b', excerpt: 'b'.repeat(1000) }],
    workspaceFiles: [{ path: 'src/a.mjs', hash: 'a'.repeat(64) }, { path: 'src/b.mjs', hash: 'b'.repeat(64) }] };
  const expected = { ...priorEvidence, artifacts: priorEvidence.artifacts.map(({ id }) => ({ id, truncated: true })), workspaceFiles: [], workspaceFilesTruncated: true };
  const render = (evidence) => `MANDATORY GOAL / RULES / SKILLS / REVIEW POINTER\n${JSON.stringify(evidence)}`;
  const sizes = [];
  const fitted = fitPromptBudget({ task, node, priorEvidence, maxBytes: Buffer.byteLength(render(expected)),
    render: (evidence) => { sizes.push({ excerpts: evidence.artifacts.filter((item) => item.excerpt).length, files: evidence.workspaceFiles.length }); return render(evidence); } });
  assert.deepEqual(fitted.priorEvidence, expected);
  assert.deepEqual(sizes.slice(0, 3), [{ excerpts: 2, files: 2 }, { excerpts: 1, files: 2 }, { excerpts: 0, files: 2 }]);
  assert.equal(priorEvidence.workspaceFiles.length, 2);
  assert.equal(priorEvidence.artifacts[0].excerpt.length, 1000);
});

test('different feedback and mandatory-only oversize fail instead of truncating requirements or evidence', () => {
  const priorEvidence = { feedback: ['A separate decision'], analysis: { full: 'a'.repeat(128 * 1024) }, reviewFindings: [{ message: 'Mandatory finding' }] };
  const original = structuredClone(priorEvidence);
  assert.throws(() => fitPromptBudget({ task: { ...task, planningFeedback: ['Current decision'] }, node, priorEvidence,
    render: (evidence) => JSON.stringify(evidence) }), { code: 'RUNNER_PROMPT_LIMIT' });
  assert.deepEqual(priorEvidence, original);
  assert.throws(() => fitPromptBudget({ task, node, priorEvidence: null, render: () => '', maxBytes: 128 * 1024 + 1 }), { code: 'RUNNER_PROMPT_LIMIT' });
});

test('write hashes stay mandatory for implementation while provider framing counts toward the limit', () => {
  const priorEvidence = { workspaceFiles: [{ path: 'src/value.mjs', hash: 'a'.repeat(64) }] };
  assert.throws(() => fitPromptBudget({ task, node: { action: { id: 'ai-implement' }, resources: { writes: ['src'] } }, priorEvidence,
    render: (evidence) => JSON.stringify(evidence), maxBytes: 50 }), { code: 'RUNNER_PROMPT_LIMIT' });
  assert.throws(() => fitPromptBudget({ task, node, priorEvidence: null, render: () => 'small base prompt',
    measure: (prompt) => Buffer.byteLength(prompt) + 100, maxBytes: 100, errorCode: 'AI_CONTEXT_LIMIT' }), { code: 'AI_CONTEXT_LIMIT' });
});
