import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareToolchain } from './lib/toolchain.mjs';
import { probeLocalChecks, runRegisteredAction } from './lib/runner.mjs';

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

test('local checks execute only a profile-bound script in the allocated worktree', async (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-local-check-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('/usr/bin/git', args, { cwd: root, stdio: 'ignore' });
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'local-check-fixture', version: '1.0.0',
    scripts: { test: "node -e \"process.stdout.write('local check ok')\"" },
  }) + '\n');
  writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  writeFileSync(path.join(root, '.flowcairn.json'), JSON.stringify({
    version: 1, integrationBranch: 'main', packageManager: 'npm', contextPaths: [],
    checks: ['tests'], checkMode: 'local', checkScripts: { tests: 'test' }, outputPaths: [],
    manifests: ['package.json', 'package-lock.json'], ai: { provider: 'openai', model: 'fixture-model' },
  }) + '\n');
  git('add', '.'); git('commit', '-m', 'fixture');
  const graph = path.join(root, '.ai-orchestrator', 'graph');
  const worktrees = path.join(root, '.ai-orchestrator', 'worktrees');
  mkdirSync(path.join(graph, 'runner-tickets'), { recursive: true, mode: 0o700 });
  mkdirSync(worktrees, { recursive: true, mode: 0o700 });
  chmodSync(path.join(root, '.ai-orchestrator'), 0o700); chmodSync(graph, 0o700); chmodSync(worktrees, 0o700);
  const worktree = path.join(worktrees, 'task-1');
  git('worktree', 'add', '--detach', worktree, 'HEAD');
  assert.equal(lstatSync(path.join(root, 'package.json')).nlink, 1);
  const toolchain = prepareToolchain({ root, worktree });
  const outputDirectory = path.join(graph, 'output-check');
  mkdirSync(outputDirectory, { mode: 0o700 });
  const task = {
    schemaVersion: 2, id: 'LOCAL-CHECK', goal: 'Проверить script', instructions: 'Выполнить test.',
    scope: ['package.json'], contextPaths: [], forbiddenPaths: [], includeUntracked: [],
    acceptance: ['Script завершился успешно.'], checks: ['tests'], resources: [],
    limits: { maxAttempts: 1, maxReplans: 0, timeoutMs: 5_000 }, sourceHash: 'a'.repeat(64),
  };
  const node = {
    id: 'tests', title: 'Проверить tests', outcome: 'Tests пройдены.', needs: [],
    action: { id: 'check-tests', version: 1, inputs: {} },
    success: { kind: 'checks', requiredArtifacts: ['test-report'] }, permissions: ['workspace.output.write'],
    skills: [], resources: { reads: ['package.json'], writes: [], exclusive: [] }, retry: { maxAttempts: 1, backoffMs: 0 },
  };
  const plan = {
    schemaVersion: 2, taskHash: sha256(canonicalJson(task)), version: 1, parentPlanHash: null,
    sourceHash: task.sourceHash, runtimeHash: 'b'.repeat(64), registryHash: 'c'.repeat(64), policyHash: 'd'.repeat(64),
    skills: [], nodes: [node, {
      ...node, id: 'accept-result', title: 'Принять результат', outcome: 'Результат принят.', needs: ['tests'],
      action: { id: 'human-accept', version: 1, inputs: {} }, success: { kind: 'gate', requiredArtifacts: [] },
      permissions: [], resources: { reads: [], writes: [], exclusive: [] },
    }],
  };
  const availability = probeLocalChecks({ root });
  if (process.env.GITHUB_ACTIONS === 'true' && availability.reason === 'LOCAL_CHECK_NODE_MODE') {
    t.skip('GitHub-hosted Node не проходит fail-closed проверку прав; local runner не запускается.');
    return;
  }
  assert.deepEqual(availability, { available: true, reason: null, mode: 'local' });
  let started = false;
  const result = await runRegisteredAction({
    root, worktree, node, task, plan, skills: [], priorEvidence: null, reviewEvidence: null,
    toolchain, outputDirectory, onStart: () => { started = true; },
  });
  assert.equal(started, true);
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.equal(result.stopped, true);
  assert.equal(result.uncertain, false);
  assert.equal(result.execution.kind, 'local-check');
  assert.equal(result.execution.script, 'test');
  assert.equal(result.execution.isolation, 'worktree-only');
});
