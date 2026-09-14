import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverProjectSkillCandidates, createProjectSkillManifest, loadSkill, resolveNodeSkills, renderSkillInstructions } from '../scripts/ai-graph/lib/skills.mjs';
import { hashObject, sha256 } from '../scripts/ai-graph/lib/io.mjs';
function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-candidates-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = [];
  const add = (file, name, body = 'PRIVATE_BODY_NOT_IN_PREVIEW', scope = '.') => {
    const text = `---\nname: ${name}\ndescription: Scoped project guidance.\n---\n${body}\n`;
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), text);
    files.push({ path: file, kind: 'project-skill', scope, sha256: sha256(text), bytes: Buffer.byteLength(text) });
    return text;
  };
  const inventory = () => ({ version: 1, complete: true, fingerprint: hashObject(files), files: [...files] });
  return { root, add, inventory };
}

test('metadata preview discovers in-place candidates without returning body or registering them', (t) => {
  const f = fixture(t); f.add('.agents/skills/local/SKILL.md', 'local');
  const preview = discoverProjectSkillCandidates(f.root, { instructionManifest: f.inventory() });
  assert.equal(preview.candidates[0].id, 'project-local');
  assert.equal(preview.candidates[0].eligible, true);
  assert.equal(JSON.stringify(preview).includes('PRIVATE_BODY_NOT_IN_PREVIEW'), false);
  assert.throws(() => loadSkill(f.root, 'project-local'), { code: 'SKILL_UNKNOWN' });
  const selected = createProjectSkillManifest(f.root, { instructionManifest: f.inventory(), expectedFingerprint: preview.fingerprint, selections: [{ path: '.agents/skills/local/SKILL.md', actions: ['ai-review'], scope: ['.'] }] });
  assert.equal(selected[0].hash, preview.candidates[0].hash);
  const effective = loadSkill(f.root, 'project-local', { projectSkills: selected });
  assert.equal(effective.hash, sha256(effective.text));
  assert.ok(effective.text.includes(preview.candidates[0].hash));
  assert.deepEqual(createProjectSkillManifest(f.root, { instructionManifest: f.inventory(), expectedFingerprint: preview.fingerprint, selectedPaths: [] }), []);
});

test('selection rejects stale bytes, fingerprints, unknown paths and incomplete inventory', (t) => {
  const f = fixture(t); f.add('.agents/skills/local/SKILL.md', 'local');
  const inventory = f.inventory(), preview = discoverProjectSkillCandidates(f.root, { instructionManifest: inventory });
  const options = { instructionManifest: inventory, expectedFingerprint: preview.fingerprint, selections: [{ path: '.agents/skills/local/SKILL.md', actions: ['ai-review'], scope: ['.'] }] };
  assert.throws(() => createProjectSkillManifest(f.root, { ...options, selections: [{ path: 'invented/SKILL.md', actions: ['ai-review'], scope: ['.'] }] }), { code: 'PROJECT_SKILLS_SELECTION' });
  assert.throws(() => createProjectSkillManifest(f.root, { ...options, expectedFingerprint: '0'.repeat(64) }), { code: 'SKILL_DISCOVERY_DRIFT' });
  assert.throws(() => discoverProjectSkillCandidates(f.root, { instructionManifest: { ...inventory, complete: false } }), { code: 'SKILL_DISCOVERY_INCOMPLETE' });
  writeFileSync(path.join(f.root, '.agents/skills/local/SKILL.md'), 'changed');
  assert.throws(() => createProjectSkillManifest(f.root, options), { code: 'SKILL_DISCOVERY_DRIFT' });
});

test('colliding, invalid, reserved or oversized candidates cannot be selected silently', (t) => {
  const f = fixture(t);
  f.add('.agents/skills/one/SKILL.md', 'same'); f.add('.agents/skills/two/SKILL.md', 'same');
  f.add('skills/reserved/SKILL.md', 'context'); f.add('skills/invalid/SKILL.md', 'Invalid Name');
  f.add('skills/large/SKILL.md', 'large', 'a'.repeat(13000));
  const preview = discoverProjectSkillCandidates(f.root, { instructionManifest: f.inventory() });
  assert.ok(preview.candidates.every((item) => !item.eligible));
  assert.ok(preview.candidates.some((item) => item.reason === 'SKILL_ID_COLLISION'));
  assert.ok(preview.candidates.some((item) => item.reason === 'SKILL_TOO_LARGE'));
});


test('new selections require explicit actions and scope; legacy paths cannot activate defaults', (t) => {
  const f = fixture(t); f.add('.agents/skills/local/SKILL.md', 'local');
  const inventory = f.inventory(), preview = discoverProjectSkillCandidates(f.root, { instructionManifest: inventory });
  const options = { instructionManifest: inventory, expectedFingerprint: preview.fingerprint };
  for (const missing of [
    { selectedPaths: ['.agents/skills/local/SKILL.md'] },
    { selections: [{ path: '.agents/skills/local/SKILL.md', scope: ['.'] }] },
    { selections: [{ path: '.agents/skills/local/SKILL.md', actions: ['ai-review'] }] },
    { selections: [{ path: '.agents/skills/local/SKILL.md', actions: [], scope: ['.'] }] },
  ]) assert.throws(() => createProjectSkillManifest(f.root, { ...options, ...missing }), { code: 'PROJECT_SKILLS_APPLICABILITY_REQUIRED' });
  assert.deepEqual(createProjectSkillManifest(f.root, { ...options, selectedPaths: [] }), []);
  assert.deepEqual(createProjectSkillManifest(f.root, { ...options, selections: [] }), []);
  const selected = createProjectSkillManifest(f.root, { ...options, selections: [{ path: '.agents/skills/local/SKILL.md', actions: ['ai-review'], scope: ['apps/web/'] }] });
  assert.deepEqual(selected[0].scope, ['apps/web']);
  assert.deepEqual(selected[0].actions, ['ai-review']);
});

test('explicit review-only and frontend applicability isolate project Skills; mixed nodes preserve framing', (t) => {
  const f = fixture(t);
  f.add('.agents/skills/web-policy/SKILL.md', 'web-policy', 'Use the web component contract.');
  f.add('.agents/skills/api-policy/SKILL.md', 'api-policy', 'Use the server transaction contract.');
  f.add('.agents/skills/review-only/SKILL.md', 'review-only', 'Only read-only code review.');
  for (const [directory, dependencies] of [['apps/web', { 'react-dom': '*' }], ['apps/api', { fastify: '*' }]]) {
    mkdirSync(path.join(f.root, directory), { recursive: true });
    writeFileSync(path.join(f.root, directory, 'package.json'), JSON.stringify({ dependencies }));
  }
  const inventory = f.inventory(), preview = discoverProjectSkillCandidates(f.root, { instructionManifest: inventory });
  const projectSkills = createProjectSkillManifest(f.root, {
    instructionManifest: inventory, expectedFingerprint: preview.fingerprint,
    selections: [
      { path: '.agents/skills/web-policy/SKILL.md', actions: ['ai-implement'], scope: ['apps/web'] },
      { path: '.agents/skills/api-policy/SKILL.md', actions: ['ai-implement'], scope: ['apps/api'] },
      { path: '.agents/skills/review-only/SKILL.md', actions: ['ai-review'], scope: ['.'] },
    ],
  });
  const resolve = (action, scope) => resolveNodeSkills(f.root, { action, scope, projectSkills });
  const web = resolve('ai-implement', ['apps/web']), api = resolve('ai-implement', ['apps/api']);
  assert.ok(web.ids.includes('project-web-policy'));
  assert.ok(!web.ids.includes('project-api-policy'));
  assert.ok(!web.ids.includes('project-review-only'));
  assert.ok(api.ids.includes('project-api-policy'));
  assert.ok(!api.ids.includes('project-web-policy'));
  assert.ok(!api.ids.includes('project-review-only'));
  assert.ok(resolve('ai-review', ['apps/api']).ids.includes('project-review-only'));
  const mixed = resolve('ai-implement', ['apps/web', 'apps/api']);
  for (const [id, scope] of [['project-web-policy', 'apps/web'], ['project-api-policy', 'apps/api']]) {
    const skill = mixed.skills.find((item) => item.name === id);
    assert.ok(skill.text.includes(`Область применения project Skill: ["${scope}"]`));
    assert.equal(skill.hash, sha256(skill.text));
    assert.ok(renderSkillInstructions([skill]).includes(scope));
  }
});
