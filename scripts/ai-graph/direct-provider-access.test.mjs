import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RUNNER_TESTING } from './lib/runner.mjs';
import { makeExternalConsent, consentHash } from './lib/providers.mjs';
import { hashObject } from './lib/io.mjs';

function fixture(t, layout) {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'direct-provider-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = layout === 'worktree' ? path.join(base, '.ai-orchestrator/worktrees/task') : path.join(base, 'project');
  mkdirSync(path.join(root, 'src'), { recursive: true });
  mkdirSync(path.join(root, 'lib'));
  writeFileSync(path.join(root, 'src/main.js'), 'export const answer = 42;');
  writeFileSync(path.join(root, 'lib/helper.js'), 'export const helper = true;');
  writeFileSync(path.join(root, '.ENV.local'), 'local private configuration');
  writeFileSync(path.join(root, 'src/.env.secret'), 'nested private configuration');
  writeFileSync(path.join(root, 'ordinary.json'), JSON.stringify({ value: 'ghp_' + 'A'.repeat(36) }));
  return root;
}

for (const provider of ['codex', 'claude', 'cursor']) for (const layout of ['direct', 'worktree']) {
  test(`${provider} ${layout} prepares native access to original files for plan/implementation/review`, (t) => {
    const root = fixture(t, layout);
    for (const stage of ['plan', 'implement', 'review']) {
      const node = { id: stage, action: { id: `ai-${stage}` }, skills: [], resources: { reads: ['src'], writes: stage === 'implement' ? ['src'] : [] } };
      const task = { goal: 'Verify source access', instructions: 'Inspect the project', scope: ['src'], contextPaths: [], forbiddenPaths: [], acceptance: ['Works'], checks: [] };
      const plan = { nodes: [node] };
      const profile = { outputPaths: [], ai: { provider, model: 'fixture-model' } };
      const toolchain = { node: process.execPath, codexEntry: '/trusted/codex.js', digest: 'a'.repeat(64),
        provider: { provider, executable: `/trusted/${provider}`, version: '1.0.0', digest: 'b'.repeat(64) } };
      const input = { worktree: root, node, task, plan, profile, skills: [], priorEvidence: null, reviewBundle: null,
        outputPath: os.tmpdir(), toolchain, dependencyToolchain: { dependencyPaths: [], hash: 'c'.repeat(64) } };
      writeFileSync(path.join(root, `fresh-${stage}.txt`), 'created immediately before launch');
      const before = readdirSync(root);
      let prepared;
      if (provider === 'codex') prepared = RUNNER_TESTING.makeAiCommand(input);
      else {
        const consent = makeExternalConsent({ provider, planHash: hashObject(plan), scopeHash: hashObject(task.scope),
          instructionsHash: hashObject([]), skillsHash: hashObject([]), artifactsHash: hashObject([]), toolchain: toolchain.provider });
        prepared = RUNNER_TESTING.makeExternalCommand({ ...input, providerConsent: { consent, hash: consentHash(consent), toolchain: toolchain.provider } });
      }
      try {
        assert.equal(prepared.sourceIndex.root, root);
        assert.equal('safeSnapshot' in prepared, false);
        assert.deepEqual(readdirSync(root), before);
        const files = prepared.sourceIndex.files.map((file) => file.path);
        assert.ok(files.includes(`fresh-${stage}.txt`));
        assert.ok(files.includes('lib/helper.js'));
        assert.ok(files.includes('src/main.js'));
        assert.ok(!files.includes('ordinary.json'));
        if (provider === 'codex') {
          assert.equal(prepared.command.cwd, root);
          const permissions = prepared.command.args.find((value) => value.startsWith(`permissions.graph-ai-${stage}.filesystem=`));
          assert.ok(permissions.includes(`${JSON.stringify(root)}="read"`));
          for (const denied of ['.ENV.local', 'src/.env.secret', 'ordinary.json']) assert.ok(permissions.includes(path.join(root, denied)));
          assert.equal(prepared.input.includes('ghp_' + 'A'.repeat(36)), false);
        } else {
          const transport = JSON.parse(readFileSync(prepared.inputFile, 'utf8'));
          assert.equal(transport.version, 2);
          assert.equal(transport.projectRoot, root);
          assert.equal('source' in transport, false);
          assert.equal('snapshot' in transport, false);
          for (const denied of ['.ENV.local', 'src/.env.secret', 'ordinary.json']) assert.ok(transport.deniedPaths.includes(denied));
          assert.equal(transport.prompt.includes('ghp_' + 'A'.repeat(36)), false);
        }
      } finally { RUNNER_TESTING.cleanupPrepared(prepared); }
    }
  });
}
