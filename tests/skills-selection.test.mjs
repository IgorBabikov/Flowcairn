import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { selectProjectSkills } from '../bin/skills-selection.mjs';
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

test('headless init never imports Skills automatically; explicit unique names bind displayed candidate fingerprint', async () => {
  let called = false;
  assert.equal(await selectProjectSkills('/fixture', {}, {}, async () => { called = true; throw Error(); }), undefined);
  assert.equal(called, false);
  const selected = [];
  assert.deepEqual(await selectProjectSkills('/fixture', { skills: 'review,testing', 'skill-actions': 'review', 'skill-scope': 'src' }, {}, api(candidates, selected)), [
    { path: candidates[1].path, actions: ['ai-review'], scope: ['src'] },
    { path: candidates[0].path, actions: ['ai-review'], scope: ['src'] },
  ]);
  await assert.rejects(selectProjectSkills('/fixture', { skills: 'testing' }, {}, api(candidates)), { code: 'SKILL_APPLICABILITY' });
  assert.equal(selected[0].expectedFingerprint, 'candidate-set');
  await assert.rejects(selectProjectSkills('/fixture', { skills: 'invalid' }, {}, api(candidates)), { code: 'SKILL_SELECTION' });
  await assert.rejects(selectProjectSkills('/fixture', { skills: 'testing' }, {}, api([...candidates, { ...candidates[0], path: '.agents/skills/other/SKILL.md' }])), { code: 'SKILL_SELECTION' });
  await assert.rejects(selectProjectSkills('/fixture', { skills: 'testing,testing' }, {}, api(candidates)), { code: 'SKILL_SELECTION' });
});

test('TTY selection uses numbered choices and empty input keeps project skills disabled', async () => {
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = true; output.isTTY = true;
  let display = '';
  output.on('data', (chunk) => { display += chunk; });
  const answers = ['2', '4', ''];
  const terminal = { input, output, prompt: { question: async () => answers.shift() } };
  assert.deepEqual(await selectProjectSkills('/fixture', {}, terminal, api(candidates)), [{ path: candidates[1].path, actions: ['ai-review'], scope: ['src'] }]);
  assert.match(display, /1\. testing/);
  assert.equal(display.includes('invalid'), false);
  terminal.prompt.question = async () => '';
  assert.equal(await selectProjectSkills('/fixture', {}, terminal, api(candidates)), undefined);
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
