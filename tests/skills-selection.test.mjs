import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recommendProjectSkills, selectProjectSkills } from '../bin/skills-selection.mjs';
import { initializeCommand } from '../bin/flowcairn.mjs';
import { sha256 } from '../scripts/ai-graph/lib/io.mjs';

function api(candidates, selected = []) {
  return async () => ({
    inspectInstructions: () => ({ fingerprint: 'instructions' }),
    discoverProjectSkillCandidates: () => ({ candidates, fingerprint: 'candidate-set' }),
    createProjectSkillManifest: (_root, input) => { selected.push(input); return input.selections; },
  });
}
const candidates = [
  { name: 'testing', path: '.agents/skills/testing/SKILL.md', scope: '.', eligible: true },
  { name: 'review', path: '.agents/skills/review/SKILL.md', scope: 'src', eligible: true },
  { name: 'invalid', path: '.agents/skills/invalid/SKILL.md', eligible: false },
];

test('headless init recommends only conventional local Skill roles; explicit names still bind displayed candidate fingerprint', async () => {
  const selected = [];
  assert.deepEqual(await selectProjectSkills('/fixture', {}, {}, api(candidates, selected)), [
    { path: candidates[0].path, actions: ['ai-implement', 'ai-review'], scope: ['.'] },
    { path: candidates[1].path, actions: ['ai-review'], scope: ['src'] },
  ]);
  assert.equal(selected[0].expectedFingerprint, 'candidate-set');
  assert.deepEqual(await selectProjectSkills('/fixture', { skills: 'review,testing', 'skill-actions': 'review', 'skill-scope': 'src' }, {}, api(candidates, selected)), [
    { path: candidates[1].path, actions: ['ai-review'], scope: ['src'] },
    { path: candidates[0].path, actions: ['ai-review'], scope: ['src'] },
  ]);
  await assert.rejects(selectProjectSkills('/fixture', { skills: 'testing' }, {}, api(candidates)), { code: 'SKILL_APPLICABILITY' });
  await assert.rejects(selectProjectSkills('/fixture', { skills: 'invalid' }, {}, api(candidates)), { code: 'SKILL_SELECTION' });
  await assert.rejects(selectProjectSkills('/fixture', { skills: 'testing' }, {}, api([...candidates, { ...candidates[0], path: '.agents/skills/other/SKILL.md' }])), { code: 'SKILL_SELECTION' });
  await assert.rejects(selectProjectSkills('/fixture', { skills: 'testing,testing' }, {}, api(candidates)), { code: 'SKILL_SELECTION' });
});

test('recommendation recognizes context, delivery, testing and review but leaves unknown rules inert', () => {
  assert.deepEqual(recommendProjectSkills([
    { name: 'tmg-context', description: 'Контекст проекта', path: '.agents/skills/context/SKILL.md', scope: '.', eligible: true },
    { name: 'task-delivery-pipeline', description: 'План и реализация', path: '.agents/skills/delivery/SKILL.md', scope: '.', eligible: true },
    { name: 'testing-frontend', description: 'Проверки frontend', path: '.agents/skills/testing/SKILL.md', scope: 'src', eligible: true },
    { name: 'pr-review', description: 'Ревью изменений', path: '.agents/skills/review/SKILL.md', scope: '.', eligible: true },
    { name: 'product-pressure-test', description: 'Текст не участвует в подборе', path: '.agents/skills/product-pressure-test/SKILL.md', scope: '.', eligible: true },
    { name: 'custom-product-voice', description: 'Неизвестное правило', path: '.agents/skills/custom/SKILL.md', scope: '.', eligible: true },
  ]), [
    { path: '.agents/skills/context/SKILL.md', actions: ['ai-plan', 'ai-analyze', 'ai-implement', 'ai-review'], scope: ['.'] },
    { path: '.agents/skills/delivery/SKILL.md', actions: ['ai-plan', 'ai-analyze', 'ai-implement'], scope: ['.'] },
    { path: '.agents/skills/testing/SKILL.md', actions: ['ai-implement', 'ai-review'], scope: ['src'] },
    { path: '.agents/skills/review/SKILL.md', actions: ['ai-review'], scope: ['.'] },
  ]);
});

test('TTY init reports automatic recommendation and --skills none disables it', async () => {
  const input = new PassThrough(), output = new PassThrough(); input.isTTY = true; output.isTTY = true;
  let display = '';
  output.on('data', (chunk) => { display += chunk; });
  const terminal = { input, output };
  await selectProjectSkills('/fixture', {}, terminal, api(candidates));
  assert.match(display, /Подключены подходящие правила проекта/);
  assert.deepEqual(await selectProjectSkills('/fixture', { skills: 'none' }, terminal, api(candidates)), []);
  input.destroy(); output.destroy();
});

test('init selects a real local Skill by name, pins its existing bytes and preserves the repeated profile', async (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-select-init-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('/usr/bin/git', ['init', '--initial-branch=main'], { cwd: root, stdio: 'ignore' });
  writeFileSync(path.join(root, 'package.json'), '{"name":"fixture","version":"1.0.0"}');
  mkdirSync(path.join(root, '.agents/skills/testing'), { recursive: true });
  const text = '---\nname: testing\ndescription: Local fixture testing rules\n---\nCheck the changed behavior.\n';
  writeFileSync(path.join(root, '.agents/skills/testing/SKILL.md'), text);
  const options = { provider: 'openai', model: 'fixture-model', skills: 'testing', 'skill-actions': 'analyze,review', 'skill-scope': 'src', json: true };
  const result = await initializeCommand(root, options);
  assert.deepEqual(result.profile.skillManifest, [{
    id: 'project-testing', path: '.agents/skills/testing/SKILL.md', hash: sha256(text),
    scope: ['src'], actions: ['ai-analyze', 'ai-review'],
  }]);
  const profile = readFileSync(path.join(root, '.flowcairn.json'));
  assert.equal((await initializeCommand(root, options)).created, false);
  assert.deepEqual(readFileSync(path.join(root, '.flowcairn.json')), profile);
  await assert.rejects(initializeCommand(root, { ...options, skills: 'different' }), { code: 'SKILL_PROFILE_EXISTS' });
  await assert.rejects(initializeCommand(root, { ...options, 'skill-actions': 'implement' }), { code: 'SKILL_PROFILE_EXISTS' });
  assert.deepEqual(readFileSync(path.join(root, '.flowcairn.json')), profile);
});
