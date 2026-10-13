import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverCheckRecipe, recognizeTestRecipe, OWNER_CASES_FILE } from '../bin/check-recipes.mjs';
import { initializeProject } from '../bin/installation.mjs';
import { inspectProjectChecks } from '../scripts/ai-graph/lib/check-profile.mjs';
import { parseNodeVerificationReport } from '../scripts/ai-graph/lib/node-verification-report.mjs';
import { validateExecutionPlanConsistency } from '../scripts/ai-graph/lib/execution-plan-consistency.mjs';
import { buildTaskContract } from '../scripts/ai-graph/lib/task-contract.mjs';
import { TaskSpecSchema } from '../scripts/ai-graph/lib/schemas.mjs';
import { hashObject } from '../scripts/ai-graph/lib/io.mjs';
import { fingerprintDirectWorkspace } from '../scripts/ai-graph/lib/direct-workspace.mjs';

const provider = path.resolve(import.meta.dirname, 'fixtures/verified-claude/node_modules/@anthropic-ai/claude-code/bin/claude.exe');
const options = { provider: 'claude', 'provider-path': provider, 'read-consent': true, 'test-policy': 'keep' };
const source = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {value} from '../src/app.mjs';\ntest('contracted result', () => {assert.equal(value, 2);});\ntest('denial result', () => {assert.equal(value === 3, false);});\n";

function fixture(t, script = 'node --test', text = source) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-check-recipes-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = { name: 'recipe-fixture', version: '1.0.0', type: 'module', scripts: { test: script } };
  writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
  mkdirSync(path.join(root, 'src')); mkdirSync(path.join(root, 'tests'));
  writeFileSync(path.join(root, 'src/app.mjs'), 'export const value = 2;\n');
  writeFileSync(path.join(root, 'tests/app.test.mjs'), text);
  return { root, pkg };
}

function planFor(root, profile) {
  const task = TaskSpecSchema.parse({ schemaVersion: 2, sourceHash: hashObject('check-recipe'), id: 'TASK-CHECK-RECIPE',
    goal: 'Preserve the existing result', instructions: 'The result remains 2 and the denial remains false',
    acceptance: ['The result is 2'], scope: ['src/app.mjs'], checks: ['tests'], contextPaths: [] });
  const contract = buildTaskContract(task, { steps: [{ id: 'one', nodeId: 'one', paths: ['src/app.mjs'] }] });
  contract.requirements[0].verification = { method: 'check', checkIds: ['check-tests'], criterion: 'The result is 2', paths: ['src/app.mjs'] };
  return { workflowPolicy: 'developer-v2', stage: 'execution', taskContract: contract, checks: inspectProjectChecks(root, profile),
    nodes: [{ id: 'one', title: 'Preserve the result', outcome: 'The result remains 2', action: { id: 'ai-implement' },
      resources: { writes: ['src/app.mjs'] }, needs: ['approve-plan'], declaredNeeds: [] }] };
}

test('fresh init registers actual Node22 tests and the pre-write gate has a verifier without changing tests', (t) => {
  const { root } = fixture(t);
  const before = readFileSync(path.join(root, 'tests/app.test.mjs'));
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; delete env.NODE_OPTIONS; delete env.NODE_PATH;
  const init = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../bin/flowcairn.mjs'), 'init', '--root', root,
    '--provider', 'claude', '--provider-path', provider, '--read-consent', '--test-policy', 'keep', '--json'],
  { cwd: root, env, encoding: 'utf8', timeout: 10000 });
  assert.equal(init.status, 0, init.stderr);
  const installed = JSON.parse(init.stdout).result;
  assert.equal(installed.profile.version, 2);
  assert.equal(installed.profile.developmentWorkflow.version, 2);
  assert.equal(installed.checkRecipe.selectors.source, 'literal-source-candidates');
  assert.equal(installed.checkRecipe.selectors.acceptance, 'unverified');
  assert.deepEqual(installed.profile.checks, ['tests']);
  assert.deepEqual(installed.profile.manifests, ['package.json']);
  const plan = planFor(root, installed.profile);
  assert.equal(validateExecutionPlanConsistency(plan).status, 'structurally-valid');
  const definition = installed.profile.checkProfile.definitions[0];
  const actual = spawnSync(definition.command.executable, definition.command.argv, { cwd: root, env, encoding: 'utf8', timeout: 10000 });
  assert.equal(actual.status, 0, actual.stderr);
  const value = JSON.parse(readFileSync(path.join(root, definition.report.path), 'utf8'));
  const normalized = parseNodeVerificationReport(value, { requiredScenarios: definition.report.requiredScenarios });
  assert.equal(normalized.status, 'passed'); assert.equal(normalized.countsConfirmed, true);
  assert.deepEqual(normalized.counts, { total: 2, completed: 2, passed: 2, failed: 0, skipped: 0 });
  assert.equal(readFileSync(path.join(root, 'tests/app.test.mjs')).equals(before), true);
  const profileBytes = readFileSync(path.join(root, '.flowcairn.json'));
  assert.equal(initializeProject(root, options).created, false);
  assert.equal(readFileSync(path.join(root, '.flowcairn.json')).equals(profileBytes), true);
});

test('dry-run reads selectors without project execution, profile/report writes or dependency installation', (t) => {
  const text = "import test from 'node:test';\nimport {writeFileSync} from 'node:fs';\nwriteFileSync('must-not-exist', 'effect');\ntest('existing case', () => {});\n";
  const { root } = fixture(t, 'node --test', text);
  const before = readdirSync(root);
  const preview = initializeProject(root, { ...options, 'dry-run': true });
  assert.equal(preview.profile.version, 2); assert.equal(preview.checkRecipe.status, 'ready');
  assert.deepEqual(readdirSync(root), before);
  assert.throws(() => readFileSync(path.join(root, 'must-not-exist')), { code: 'ENOENT' });
});

test('comment and string decoys are excluded; only literal imported top-level cases bind', (t) => {
  const text = "import {test} from 'node:test';\n// test('comment fake', () => {});\nconst decoy = \"test('string fake', () => {})\";\n/* test('block fake', () => {}); */\ntest('actual one', () => {});\ntest('actual two', () => {});\n";
  const { root, pkg } = fixture(t, 'node --test', text);
  const recipe = discoverCheckRecipe(root, pkg);
  assert.equal(recipe.status, 'ready'); assert.equal(recipe.checkProfile.definitions[0].report.requiredScenarios.length, 2);
});

test('dynamic names, aliases, nested tests, duplicate names and ambiguous syntax require owner cases', (t) => {
  const unsupported = [
    "import {test as check} from 'node:test';\ncheck('alias',()=>{});",
    "import test from 'node:test';\nconst name='dynamic';\ntest(name,()=>{});",
    "import test from 'node:test';\ntest('outer',async t=>{await t.test('inner',()=>{});});",
    "import test from 'node:test';\ntest('same',()=>{});\ntest('same',()=>{});",
    "import test from 'node:test';\ntest(`template`,()=>{});",
    "import test from 'node:test';\ntest('regexp',()=>{/test('fake')/.test('x');});",
    "import test from 'node:test';\nif(false) test('conditional',()=>{});",
    "import test from 'node:test';\nif(false)\ntest('conditional',()=>{});",
  ];
  for (const text of unsupported) {
    const { root, pkg } = fixture(t, 'node --test', text);
    const recipe = discoverCheckRecipe(root, pkg);
    assert.equal(recipe.status, 'unavailable'); assert.equal(recipe.reason, 'OWNER_CASES_REQUIRED');
    assert.match(recipe.guidance, /flowcairn-check-cases\.json/);
  }
});

test('explicit Node paths and source-bound owner cases permit an otherwise dynamic suite', (t) => {
  const text = "import test from 'node:test';\nconst name='owner known';\ntest(name,()=>{});\n";
  const { root, pkg } = fixture(t, 'node --test tests/app.test.mjs', text);
  writeFileSync(path.join(root, OWNER_CASES_FILE), JSON.stringify({ version: 1, runner: 'node:test', requiredScenarios: ['owner known'] }));
  const recipe = discoverCheckRecipe(root, pkg);
  assert.equal(recipe.status, 'ready'); assert.equal(recipe.selectors.source, 'owner-existing-cases');
  assert.deepEqual(recipe.checkProfile.definitions[0].report.requiredScenarios, ['owner known']);
  assert.ok(recipe.checkProfile.definitions[0].inputPaths.includes(OWNER_CASES_FILE));
  assert.equal(recipe.checkProfile.definitions[0].command.argv.at(-1), 'tests/app.test.mjs');
});

test('opaque scripts and lifecycle scripts remain legacy commands with explicit verifier guidance', (t) => {
  for (const script of ['node --test && echo done', 'NODE_OPTIONS=x node --test', 'npm test', 'node --test --test-only', 'node custom-check.mjs']) {
    const { root } = fixture(t, script);
    const installed = initializeProject(root, options);
    assert.equal(installed.profile.version, 1); assert.deepEqual(installed.profile.checks, ['tests']);
    assert.equal(installed.checkRecipe.status, 'unavailable'); assert.match(installed.message, /Scenario verifier/);
    assert.throws(() => validateExecutionPlanConsistency(planFor(root, installed.profile)), { code: 'PLAN_VERIFIER_MISSING' });
  }
  const { root, pkg } = fixture(t); pkg.scripts.pretest = 'node prepare.mjs';
  assert.equal(discoverCheckRecipe(root, pkg).reason, 'TEST_LIFECYCLE_UNSUPPORTED');
});

test('whole required lint/build commands are retained without guessed scenario reports', (t) => {
  const { root, pkg } = fixture(t); pkg.scripts.lint = 'eslint src'; pkg.scripts.build = 'custom-builder';
  writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
  const installed = initializeProject(root, options);
  assert.deepEqual(installed.profile.checks, ['lint', 'tests', 'build']);
  for (const id of ['lint', 'build']) {
    const definition = installed.profile.checkProfile.definitions.find(item => item.id === id);
    assert.deepEqual(definition.command.argv.slice(1), ['run', id]);
    assert.equal(definition.report, undefined); assert.deepEqual(definition.identityFiles, [definition.command.argv[0]]);
  }
});

test('historical markerless profiles and explicitly chosen legacy/worktree adapters keep their bytes/routes', (t) => {
  const { root } = fixture(t);
  const legacy = { version: 1, integrationBranch: 'direct', workspaceMode: 'direct', packageManager: 'npm', contextPaths: [],
    checks: ['tests'], checkMode: 'trusted-local', outputPaths: [], manifests: ['package.json'], ai: { provider: 'claude', model: 'provider-default' } };
  const bytes = JSON.stringify(legacy, null, 4) + '\n'; writeFileSync(path.join(root, '.flowcairn.json'), bytes);
  const adopted = initializeProject(root, options);
  assert.equal(adopted.profile.version, 1); assert.equal(adopted.profile.developmentWorkflow, undefined);
  assert.equal(readFileSync(path.join(root, '.flowcairn.json'), 'utf8'), bytes);
  assert.equal(inspectProjectChecks(root, adopted.profile).definitions[0].report, undefined);
  const other = fixture(t);
  assert.equal(initializeProject(other.root, { ...options, 'package-manager': 'npm' }).profile.version, 1);
});

test('recipe output conflicts and unsafe test paths fail before installation writes', (t) => {
  const { root } = fixture(t); writeFileSync(path.join(root, '.flowcairn-test-report.json'), 'owner output');
  assert.throws(() => initializeProject(root, options), { code: 'CHECK_RECIPE_OUTPUT_CONFLICT' });
  assert.equal(readFileSync(path.join(root, '.flowcairn-test-report.json'), 'utf8'), 'owner output');
  assert.throws(() => readFileSync(path.join(root, '.flowcairn.json')), { code: 'ENOENT' });
  const other = fixture(t); rmSync(path.join(other.root, 'tests/app.test.mjs'));
  symlinkSync(path.join(other.root, 'src/app.mjs'), path.join(other.root, 'tests/app.test.mjs'));
  assert.throws(() => discoverCheckRecipe(other.root, other.pkg), { code: 'CHECK_RECIPE_LINK_UNSAFE' });
  assert.throws(() => recognizeTestRecipe('node --test ../outside.test.mjs'), { code: 'CONTEXT_PATH_UNSAFE' });
  assert.throws(() => recognizeTestRecipe('node --test .env.test.mjs'), { code: 'CONTEXT_PATH_UNSAFE' });
});

function installedMetadata(root, id, version) {
  const packageName = id === 'playwright' ? '@playwright/test' : 'jest';
  const base = path.join(root, 'node_modules', packageName), cli = id === 'playwright' ? 'cli.js' : 'bin/jest.js';
  mkdirSync(path.dirname(path.join(base, cli)), { recursive: true });
  writeFileSync(path.join(base, 'package.json'), JSON.stringify({ name: packageName, version, bin: { [id]: cli } }));
  writeFileSync(path.join(base, cli), "throw new Error('metadata fixture CLI must not execute at init');\n");
}

test('installed Playwright/Jest metadata is pinned but discovery is never executed or guessed', (t) => {
  for (const [id, script, version, format] of [['playwright', 'playwright test', '1.61.1', 'playwright-json'], ['jest', 'jest', '30.2.0', 'jest-json']]) {
    const { root, pkg } = fixture(t, script); installedMetadata(root, id, version);
    assert.equal(discoverCheckRecipe(root, pkg).reason, 'OWNER_CASES_REQUIRED');
    writeFileSync(path.join(root, OWNER_CASES_FILE), JSON.stringify({ version: 1, runner: id, requiredScenarios: ['exact owner selector'], sourcePaths: ['tests/app.test.mjs'] }));
    const recipe = discoverCheckRecipe(root, pkg);
    assert.equal(recipe.status, 'ready'); assert.equal(recipe.runner.version, version);
    const definition = recipe.checkProfile.definitions[0];
    assert.equal(definition.report.format, format); assert.deepEqual(definition.report.requiredScenarios, ['exact owner selector']);
    assert.ok(definition.identityFiles.some(file => file.endsWith('package.json')));
    assert.equal(definition.inputPaths.includes('tests/app.test.mjs'), false);
    assert.equal(recipe.selectors.acceptance, 'unverified');
  }
});

test('authorized test additions change current source while preserving the registry and required existing names', (t) => {
  const { root } = fixture(t);
  const installed = initializeProject(root, { ...options, 'test-policy': 'add' });
  const registry = inspectProjectChecks(root, installed.profile);
  const before = fingerprintDirectWorkspace(root, { outputPaths: installed.profile.outputPaths });
  writeFileSync(path.join(root, 'tests/new.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {value} from '../src/app.mjs';\ntest('additional type witness',()=>{assert.equal(typeof value,'number');});\n");
  const after = fingerprintDirectWorkspace(root, { outputPaths: installed.profile.outputPaths });
  assert.notEqual(after.hash, before.hash);
  assert.deepEqual(inspectProjectChecks(root, installed.profile), registry);
  const definition = installed.profile.checkProfile.definitions[0], env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; delete env.NODE_OPTIONS; delete env.NODE_PATH;
  const run = spawnSync(definition.command.executable, definition.command.argv, { cwd: root, env, encoding: 'utf8', timeout: 10000 });
  assert.equal(run.status, 0, run.stderr);
  const normalized = parseNodeVerificationReport(JSON.parse(readFileSync(path.join(root, definition.report.path), 'utf8')),
    { requiredScenarios: definition.report.requiredScenarios });
  assert.equal(normalized.status, 'passed'); assert.equal(normalized.counts.total, 3);
  assert.equal(definition.report.requiredScenarios.length, 2);
});

test('missing or unsupported runner, empty cases and owner case secrets are not recipes', (t) => {
  const missing = fixture(t, 'jest'); assert.equal(discoverCheckRecipe(missing.root, missing.pkg).reason, 'RUNNER_NOT_INSTALLED');
  installedMetadata(missing.root, 'jest', '31.0.0'); assert.equal(discoverCheckRecipe(missing.root, missing.pkg).reason, 'RUNNER_VERSION_UNSUPPORTED');
  const empty = fixture(t, 'node --test', "import test from 'node:test';\n");
  assert.equal(discoverCheckRecipe(empty.root, empty.pkg).reason, 'OWNER_CASES_REQUIRED');
  writeFileSync(path.join(empty.root, OWNER_CASES_FILE), JSON.stringify({ version: 1, runner: 'node:test', requiredScenarios: [] }));
  assert.throws(() => discoverCheckRecipe(empty.root, empty.pkg), { code: 'CHECK_RECIPE_CASES_INVALID' });
  writeFileSync(path.join(empty.root, OWNER_CASES_FILE), JSON.stringify({ version: 1, runner: 'node:test', requiredScenarios: ['password=fixture-secret-value'] }));
  assert.throws(() => discoverCheckRecipe(empty.root, empty.pkg), { code: 'CHECK_RECIPE_CASES_INVALID' });
});

test('a real exit-zero skipped mandatory case and zero-test file never become proof', (t) => {
  for (const text of ["import test from 'node:test';\ntest('required case', {skip:true},()=>{});\n", "import test from 'node:test';\n"]) {
    const { root, pkg } = fixture(t, 'node --test', text);
    writeFileSync(path.join(root, OWNER_CASES_FILE), JSON.stringify({ version: 1, runner: 'node:test', requiredScenarios: ['required case'] }));
    const recipe = discoverCheckRecipe(root, pkg); assert.equal(recipe.status, 'ready');
    const definition = recipe.checkProfile.definitions[0], env = { ...process.env };
    delete env.NODE_TEST_CONTEXT; delete env.NODE_OPTIONS; delete env.NODE_PATH;
    const run = spawnSync(definition.command.executable, definition.command.argv, { cwd: root, env, encoding: 'utf8', timeout: 10000 });
    assert.equal(run.status, 0, run.stderr);
    const normalized = parseNodeVerificationReport(JSON.parse(readFileSync(path.join(root, definition.report.path), 'utf8')),
      { requiredScenarios: definition.report.requiredScenarios });
    assert.equal(normalized.status, 'unverified'); assert.ok(normalized.reasons.length > 0);
  }
});
