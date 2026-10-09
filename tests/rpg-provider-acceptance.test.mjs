import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hashObject, sha256 } from '../scripts/ai-graph/lib/io.mjs';
import { GraphStore } from '../scripts/ai-graph/lib/store.mjs';
import { GraphPlanV3Schema, TaskSpecV3Schema } from '../scripts/ai-graph/lib/schemas.mjs';
import { captureLearningSources } from '../scripts/ai-graph/lib/learning-sources.mjs';
import { readLearningMethod } from '../scripts/ai-graph/lib/learning-prompt.mjs';
import { prepareLearningProvider, readPreparedLearningInput, disposeLearningProvider } from '../scripts/ai-graph/lib/learning-provider.mjs';
import { preflightCodexLearning, codexLearningCommand, LEARNING_RUNNER_TESTING as runner } from '../scripts/ai-graph/lib/learning-runner.mjs';

function temporary(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flowcairn-qa-provider-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('metadata helper disables discovered MCP before fake CLI startup and never sends a write or inference RPC', async t => {
  const root = temporary(t), config = path.join(root, 'synthetic.toml'), record = path.join(root, 'rpc.json');
  const configBytes = '[mcp_servers.fixture]\ncommand="DO_NOT_EXECUTE"\n[profiles.work.mcp_servers.profile_server]\nurl="https://invalid.example"\n';
  writeFileSync(config, configBytes, { mode: 0o600 });
  const names = runner.mcpKeysFromFiles([config]);
  assert.deepEqual(names, ['fixture', 'profile_server']);
  const entry = path.join(root, 'metadata-only.mjs');
  // This child is ordinary Node fixture code. It cannot load the installed Codex/auth/config.
  writeFileSync(entry, `import fs from 'node:fs'; import assert from 'node:assert/strict'; import readline from 'node:readline';
const argv=process.argv.slice(2), methods=[];
for(const name of ['fixture','profile_server']) assert(argv.includes('mcp_servers.'+name+'.enabled=false'));
assert(argv.includes('features.hooks=false')); assert(!argv.includes('--ignore-user-config')); assert(!argv.includes('exec'));
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);methods.push(m.method);fs.writeFileSync(${JSON.stringify(record)},JSON.stringify(methods));
if(!['initialize','initialized','configRequirements/read','config/read'].includes(m.method)) throw Error('Unexpected effect RPC');
if(m.method==='initialize')process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');
if(m.method==='configRequirements/read')process.stdout.write(JSON.stringify({id:m.id,result:{requirements:{featureRequirements:{hooks:true}}}})+'\\n');
if(m.method==='config/read')process.stdout.write(JSON.stringify({id:m.id,result:{config:{},layers:[]}})+'\\n');});
`);
  const effective = await runner.readConfiguration({ node: process.execPath, codexEntry: entry }, root, runner.controls(root, names));
  assert.deepEqual(JSON.parse(readFileSync(record)), ['initialize', 'initialized', 'configRequirements/read', 'config/read']);
  assert.throws(() => runner.validateConfiguration(effective, root, names), { code: 'LEARNING_MANAGED_POLICY_CONFLICT' });
  assert.equal(readFileSync(config, 'utf8'), configBytes);
  await assert.rejects(preflightCodexLearning({ scratch: root, toolchain: { identity: { codexVersion: 'unverified', nodeVersion: process.version } } }), {
    code: process.platform === 'darwin' ? 'LEARNING_CODEX_VERSION_UNSUPPORTED' : 'LEARNING_CODEX_PLATFORM_UNVERIFIED',
  }); // Version rejection occurs before any real config path is read.
  assert.throws(() => codexLearningCommand({ receipt: Object.freeze({ allowed: true, verifiedAt: new Date().toISOString() }),
    scratch: root, schemaFile: path.join(root, 'schema.json'), resultFile: path.join(root, 'result.json'), model: 'qa-model' }), { code: 'LEARNING_CODEX_PREFLIGHT_REQUIRED' });
});

function savedInput(root) {
  const store = new GraphStore(root), hash = hashObject('qa-provider'), savedText = 'value = "SAVED_ONLY"\n';
  writeFileSync(path.join(root, 'example.custom'), savedText);
  const capture = captureLearningSources({ store, projectRoot: root, sourceHash: hash, files: [{ path: 'example.custom', role: 'after',
    expected: { hash: sha256(savedText), size: Buffer.byteLength(savedText), mode: '100644' } }] });
  const task = TaskSpecV3Schema.parse({ schemaVersion: 3, id: 'QA-PROVIDER', goal: 'Объяснить сохраненный код', instructions: 'Прочитать материал',
    scope: ['example.custom'], acceptance: ['Объяснение'], checks: [], sourceHash: hash });
  const taskHash = store.putObject('tasks', task);
  const contract = { version: 1, goal: task.goal, instructionsHash: hash, requirements: [{ id: 'req-read', title: 'Прочитать сохраненный код', mandatory: true, origin: 'acceptance',
    verification: { method: 'source-review', checkIds: [], criterion: 'Код сохранен', paths: ['example.custom'] }, workIds: ['implement'] }], optionalImprovements: [], constraints: [], assumptions: [], unknowns: [],
    scope: task.scope, forbiddenPaths: [], rigor: { level: 'light', reasons: ['Synthetic host fixture'] } };
  const node = id => ({ id, title: id, outcome: id, needs: [], action: { id: 'ai-implement', version: 1, inputs: {} }, success: { kind: 'implementation', requiredArtifacts: [] },
    permissions: [], skills: [], resources: { reads: [], writes: [], exclusive: [] }, retry: { maxAttempts: 1, backoffMs: 0 } });
  const plan = GraphPlanV3Schema.parse({ schemaVersion: 3, stage: 'execution', taskHash, version: 1, parentPlanHash: null, sourceHash: hash, runtimeHash: hash,
    registryHash: hash, policyHash: hash, skills: [], taskContract: contract, nodes: [node('implement'), node('verify')],
    checks: { version: 1, profileHash: hash, definitions: [], bindings: [] }, checkRegistryHash: hash, learning: { version: 1, initialMode: 'after-task' },
    executionStages: { version: 1, stages: [{ id: 'stage-one', title: 'Материал', outcome: 'Код сохранен', implementationNodeIds: ['implement'], requirementIds: ['req-read'],
      scopeCheckNodeId: 'verify', checkNodeIds: ['verify'], boundaryNodeId: 'verify' }], finalCheckNodeIds: ['verify'], finalReviewNodeId: 'verify', handoffNodeId: 'verify' } });
  const planHash = store.putObject('plans', plan), binding = { runId: 'qa-provider', planHash, taskHash };
  const materialHash = store.putObject('learning-materials', { version: 1, kind: 'stage', ...binding, contractHash: hashObject(contract), stageId: 'stage-one',
    goal: task.goal, outcome: 'Код сохранен', requirementIds: ['req-read'], beforeHash: hash, resultHash: hash, createdAt: '2026-10-08T15:00:00.000Z',
    sourceCatalogHash: capture.sourceCatalogHash, implementationReceiptIds: [], checkReceiptIds: [], reviewReceiptIds: [], diffArtifactIds: [], findingsArtifactIds: [], status: 'complete', gaps: [] });
  return { store, materialHash, binding: { ...binding, materialHashes: [materialHash] }, methodHash: readLearningMethod().hash, policy: {} };
}

test('saved-only preparation rejects schema drift, forged handles and cleanup links without following live input', t => {
  const root = temporary(t), input = savedInput(root);
  writeFileSync(path.join(root, 'example.custom'), 'LIVE_REPLACEMENT_DO_NOT_INCLUDE');
  writeFileSync(path.join(root, 'AGENTS.md'), 'LIVE_RULES_DO_NOT_INCLUDE');
  const prepared = prepareLearningProvider({ ...input, provider: 'codex', model: 'qa-configured-model', cliVersion: '0.156.1' });
  t.after(() => { if (existsSync(prepared.scratch)) rmSync(prepared.scratch, { recursive: true, force: true }); });
  const prompt = readPreparedLearningInput(prepared);
  assert.ok(prompt.includes('SAVED_ONLY'));
  assert.ok(!prompt.includes('LIVE_REPLACEMENT_DO_NOT_INCLUDE') && !prompt.includes('LIVE_RULES_DO_NOT_INCLUDE') && !prompt.includes(root));
  assert.throws(() => readPreparedLearningInput({ ...prepared }), { code: 'LEARNING_PREPARATION_INVALID' });
  const schema = readFileSync(prepared.schemaFile);
  writeFileSync(prepared.schemaFile, '{}');
  assert.throws(() => readPreparedLearningInput(prepared), { code: 'LEARNING_PREPARATION_CHANGED' });
  writeFileSync(prepared.schemaFile, schema);
  const sentinel = path.join(root, 'do-not-remove.txt'); writeFileSync(sentinel, 'preserve');
  unlinkSync(prepared.resultFile); symlinkSync(sentinel, prepared.resultFile);
  assert.throws(() => disposeLearningProvider(prepared, { stopped: true }), { code: 'LEARNING_SCRATCH_CHANGED' });
  assert.equal(readFileSync(sentinel, 'utf8'), 'preserve');
  unlinkSync(prepared.resultFile); writeFileSync(prepared.resultFile, '', { mode: 0o600 });
  assert.throws(() => disposeLearningProvider(prepared, { stopped: false }), { code: 'LEARNING_PROCESS_UNCERTAIN' });
  disposeLearningProvider(prepared, { stopped: true });
  assert.equal(existsSync(prepared.scratch), false);
  assert.equal(readFileSync(sentinel, 'utf8'), 'preserve');
});
