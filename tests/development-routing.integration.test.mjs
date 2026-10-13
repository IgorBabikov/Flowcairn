import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveNodeSkills } from '../scripts/ai-graph/lib/skills.mjs';
import { defaultAdapters } from '../scripts/ai-graph/lib/service-adapters.mjs';
import { ProjectProfileSchema } from '../scripts/ai-graph/lib/project.mjs';
import { compileTaskProposal } from '../scripts/ai-graph/lib/planning.mjs';
import { TaskSpecSchema } from '../scripts/ai-graph/lib/schemas.mjs';
import { sha256, hashObject } from '../scripts/ai-graph/lib/io.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'flowcairn-development-routing-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, content) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), content); };
  execFileSync('/usr/bin/git', ['init', '--initial-branch=main'], { cwd: root, stdio: 'ignore' });
  write('package.json', JSON.stringify({ workspaces: ['web', 'server', 'mobile'] }));
  for (const [directory, dependencies] of [['web', { react: '19.2.7' }], ['server', { fastify: '^5.0.0' }], ['mobile', { react: '19.2.7', 'react-native': '0.83.0' }]]) {
    write(`${directory}/package.json`, JSON.stringify({ dependencies }));
    write(`${directory}/index.mjs`, 'export const value = 1;\n');
  }
  write('tests/check.mjs', 'process.exit(0);\n');
  const text = '---\nname: react\ndescription: Pinned local web conventions.\n---\nUse existing web conventions.\n';
  write('.agents/skills/react/SKILL.md', text);
  const projectSkills = [{ id: 'project-react', path: '.agents/skills/react/SKILL.md', hash: sha256(text), scope: ['.'], actions: ['ai-implement'] }];
  const developmentWorkflow = { version: 1, capabilities: [{ id: 'browser-scenario', checkIds: ['browser'] }], specialists: [{
    skillId: 'project-react', domains: ['frontend'], frameworks: ['react'], majors: [19], taskKinds: ['behavior'], requires: ['browser-scenario'],
  }] };
  const profile = ProjectProfileSchema.parse({ version: 2, integrationBranch: 'main', workspaceMode: 'direct', contextPaths: [], checks: ['browser'], checkMode: 'trusted-local',
    manifests: ['web/package.json', 'server/package.json', 'mobile/package.json'], outputPaths: ['reports'], skillManifest: projectSkills, developmentWorkflow,
    checkProfile: { version: 1, requiredCheckIds: ['browser'], environment: [], definitions: [{ id: 'browser', title: 'Browser fixture', purpose: 'Routing fixture only; does not claim browser acceptance',
      command: { executable: process.execPath, argv: ['tests/check.mjs'], cwd: '.' }, inputPaths: ['tests/check.mjs'], outputPaths: ['reports'], timeoutMs: 5000, maxOutputBytes: 65536,
      report: { version: 1, format: 'playwright-json', path: 'reports/browser.json', requiredScenarios: ['fixture'] } }] },
    ai: { provider: 'codex', model: 'fixture-model' } });
  write('.flowcairn.json', JSON.stringify(profile));
  execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', 'add', '.'], { cwd: root, stdio: 'ignore' });
  const task = TaskSpecSchema.parse({ schemaVersion: 3, sourceHash: hashObject('fixture-source'), id: 'TASK-DEVELOPMENT-ROUTE', goal: 'Update values', instructions: 'Update existing values safely',
    scope: ['web', 'server', 'mobile'], contextPaths: [], acceptance: ['Values are updated'], checks: ['browser'] });
  return { root, write, task, profile, projectSkills, developmentWorkflow };
}

test('production resolver selects by work scope and declared version while legacy routing stays unchanged', (t) => {
  const f = fixture(t);
  const resolve = (scope, extra = {}) => resolveNodeSkills(f.root, { action: 'ai-implement', scope, manifestPaths: f.profile.manifests,
    projectSkills: f.projectSkills, developmentWorkflow: f.developmentWorkflow, task: f.task, availableCheckIds: ['browser'], checkDefinitions: f.profile.checkProfile.definitions, ...extra });
  const web = resolve(['web']);
  assert.ok(web.ids.includes('project-react'));
  assert.match(web.skills.find(({ name }) => name === 'project-react').text, /domain\/framework\/version/);
  assert.deepEqual(web.context.domains, ['frontend']);
  for (const [scope, domain] of [['server', 'backend'], ['mobile', 'mobile']]) {
    const result = resolve([scope]);
    assert.ok(!result.ids.includes('project-react'));
    assert.deepEqual(result.context.domains, [domain]);
  }
  const old = resolve(['web'], { developmentWorkflow: null });
  assert.ok(old.ids.includes('core-debugging'));
  assert.ok(!web.ids.includes('core-debugging'));
  f.write('web/package.json', JSON.stringify({ dependencies: { react: '20.0.0' } }));
  const changed = resolve(['web']);
  assert.ok(!changed.ids.includes('project-react'));
  assert.notEqual(changed.hash, web.hash);
  assert.notEqual(changed.context.hash, web.context.hash);
});

test('production adapters compile a mixed-domain proposal with exact Skills per immutable work', async (t) => {
  const f = fixture(t), adapters = await defaultAdapters(f.root);
  const context = { runtimeHash: adapters.identity(), skills: adapters.skills(f.task), resolveSkills: adapters.resolveSkills,
    resolveReadPaths: adapters.resolveReadPaths, contextHash: adapters.contextHash(f.task), workflowPolicy: adapters.workflowPolicy, checks: adapters.checkRegistry(), provider: 'codex' };
  const steps = ['web', 'server', 'mobile'].map((id) => ({ id, title: id, outcome: 'Value updated', paths: [`${id}/index.mjs`], needs: [], requirementIds: ['req-001'] }));
  const { plan } = compileTaskProposal(f.task, { verdict: 'pass', summary: 'Fixture proposal', findings: [], skillsUsed: [], changedFiles: [], edits: [], plan: [], steps }, context);
  const work = (id) => plan.nodes.find((node) => node.id === `step-${id}`);
  assert.equal(plan.workflowPolicy, 'developer-v1');
  assert.ok(work('web').skills.includes('project-react'));
  assert.ok(!work('server').skills.includes('project-react'));
  assert.ok(!work('mobile').skills.includes('project-react'));
  assert.ok(work('server').skills.includes('domain-backend'));
  assert.ok(work('mobile').skills.includes('domain-mobile'));
  assert.ok(plan.nodes.filter((node) => node.action.id.startsWith('check-')).every((node) => node.skills.length === 0));
  assert.ok(plan.skills.some(({ id }) => id === 'workflow-planning') === false, 'execution manifest includes only selected node Skills');
  assert.equal(Object.isFrozen(work('web')), true);
  const loaded = adapters.loadSkills(work('web').skills);
  for (const selected of loaded) assert.equal(plan.skills.find(({ id }) => id === selected.name).hash, selected.hash);
});

test('broad inventory does not let an incompatible sibling poison a narrow specialist assignment', async (t) => {
  const f = fixture(t);
  f.write('mobile/package.json', JSON.stringify({ dependencies: { react: '18.3.0' } }));
  const adapters = await defaultAdapters(f.root);
  assert.ok(adapters.skills(f.task).some(({ id }) => id === 'project-react'));
  const web = { action: { id: 'ai-implement' }, resources: { writes: ['web/index.mjs'] } };
  assert.ok(adapters.resolveSkills(web, f.task).includes('project-react'));
  const other = { ...web, resources: { writes: ['mobile/index.mjs'] } };
  assert.ok(!adapters.resolveSkills(other, f.task).includes('project-react'));
});
