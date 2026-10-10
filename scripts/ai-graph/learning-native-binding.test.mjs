import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { hashObject, sha256 } from './lib/io.mjs';
import { LearningJobRecordSchema } from './lib/learning-job-state.mjs';
import { createLearningJobAdapter } from './lib/learning-job-adapter.mjs';
import { cursorAcpLearningMetadata, inspectCursorLearningAcp } from './lib/learning-native-cursor-acp.mjs';
import { cursorLearningProfile } from './lib/learning-native-cursor-profile.mjs';

const h = hashObject('fixture'), stamp = '2026-10-09T10:00:00.000Z';
function oldJob() {
  return { id: 'job-one', kind: 'lesson', materialHash: h, status: 'running', result: null, error: null,
    version: 1, runId: 'run-one', planHash: h, taskHash: h, operationId: 'op-one', digest: h,
    materialBinding: { runId: 'run-one', planHash: h, taskHash: h },
    providerBinding: { provider: 'codex', model: 'fixture', toolchainHash: h, preflightHash: h, policyHash: h },
    methodHash: h, inputHash: h, schemaHash: h, sourcePolicyHash: h, preparationHash: h, inputObjectHash: h, commandHash: h, consentHash: h,
    ownerPid: 1, ownerStart: null, process: null, sequence: 0, question: null, createdAt: stamp, updatedAt: stamp, finishedAt: null, previousJobHash: null, termination: null };
}
test('old learning jobs keep exact hashes; native optional bindings are validated without materializing defaults', () => {
  const old = oldJob(), parsed = LearningJobRecordSchema.parse(old);
  assert.deepEqual(parsed, old); assert.equal(hashObject(parsed), hashObject(old));
  assert.equal(Object.keys(parsed.providerBinding).length, 5);
  const external = structuredClone(old); external.providerBinding = { ...external.providerBinding, provider: 'claude', model: 'provider-default',
    configurationHash: h, effectiveModel: 'claude-sonnet-4-6', effectiveReasoningEffort: 'high' };
  assert.deepEqual(LearningJobRecordSchema.parse(external), external);
  const unknown = structuredClone(external); delete unknown.providerBinding.effectiveReasoningEffort;
  assert.equal('effectiveReasoningEffort' in LearningJobRecordSchema.parse(unknown).providerBinding, false);
  external.providerBinding.configurationHash = 'unknown'; assert.equal(LearningJobRecordSchema.safeParse(external).success, false);
});
test('Claude adapter preserves default intent and native-only bindings, passes manual effort, and refuses settings drift', async () => {
  for (const mode of ['provider', 'manual']) {
    let settings = { provider: 'claude', providerVersion: '2.1.198 (Claude Code)', modelMode: mode,
      model: mode === 'provider' ? 'provider-default' : 'fixture-model', reasoningEffort: 'xhigh' };
    let preparedOptions;
    const input = { materialHash: h, methodHash: h }, command = { executable: process.execPath, args: [], env: {}, cwd: os.tmpdir() };
    const receipt = { allowed: true, policyHash: h, configurationHash: h, effectiveModel: 'fixture-model', effectiveReasoningEffort: mode === 'provider' ? 'high' : 'xhigh' };
    const prepared = { capability: receipt, inputHash: sha256('saved'), schemaHash: h, methodHash: h, materialHash: h, preparationHash: h,
      kind: 'lesson', timeoutMs: 120000, maxOutputBytes: 2 * 1024 * 1024 };
    const adapter = createLearningJobAdapter({ root: os.tmpdir(), settings: () => settings, toolchain: () => ({ digest: h }),
      modelSettings: () => assert.fail('Claude must not resolve Codex config'), transport: () => assert.fail('No inference'),
      providerApi: { capability: () => ({ allowed: false }), prepare: value => { preparedOptions = value; return prepared; }, preflight: async () => receipt,
        command: () => command, readInput: () => 'saved', readResult: () => '', parse: () => ({}), dispose: () => {} } });
    const handle = await adapter.prepare(input);
    assert.equal(handle.providerBinding.model, settings.model); assert.equal(handle.providerBinding.effectiveModel, 'fixture-model');
    assert.equal(handle.providerBinding.configurationHash, h);
    assert.equal(preparedOptions.reasoningEffort, mode === 'provider' ? undefined : 'xhigh');
    settings = { ...settings, modelMode: 'manual', model: 'different' };
    assert.throws(() => adapter.beforeGo(handle), { code: 'LEARNING_PROVIDER_DRIFT' });
  }
});
test('configured Claude CLI path/version/managed drift is rejected during preparation and before GO without another metadata call', async () => {
  for (const [field, replacement] of [['providerPath', '/fixture/other-cli'], ['providerVersion', '2.1.199 (Claude Code)'], ['providerManaged', true]]) {
    for (const phase of ['preflight', 'prepared', 'onStart']) {
      const settings = { provider: 'claude', providerPath: '/fixture/selected-cli', providerVersion: '2.1.198 (Claude Code)', providerManaged: false,
        modelMode: 'provider', model: 'provider-default' };
      const command = { executable: process.execPath, args: ['fixture'], env: {}, cwd: os.tmpdir() };
      const receipt = { allowed: true, policyHash: h, configurationHash: h, effectiveModel: 'fixture-model' };
      const prepared = { capability: receipt, inputHash: sha256('saved'), schemaHash: h, methodHash: h, materialHash: h, preparationHash: h,
        kind: 'lesson', timeoutMs: 120000, maxOutputBytes: 2 * 1024 * 1024 };
      let metadataCalls = 0, dispatched = 0;
      const change = () => { settings[field] = replacement; };
      const adapter = createLearningJobAdapter({ root: os.tmpdir(), settings: () => settings, toolchain: () => { metadataCalls++; return { digest: h }; },
        modelSettings: () => assert.fail('No Codex fallback'),
        transport: async options => { options.onStart({}); options.beforeGo({ commandHash: hashObject(command), inputHash: sha256('saved') }); dispatched++; return {}; },
        providerApi: { capability: () => ({ allowed: false }), prepare: () => prepared,
          preflight: async () => { if (phase === 'preflight') change(); return receipt; }, command: () => command,
          readInput: () => 'saved', readResult: () => '', parse: () => ({}), dispose: () => {} } });
      if (phase === 'preflight') await assert.rejects(adapter.prepare({ materialHash: h, methodHash: h }), { code: 'LEARNING_PROVIDER_DRIFT' }, `${field}:${phase}`);
      else {
        const handle = await adapter.prepare({ materialHash: h, methodHash: h });
        if (phase === 'prepared') {
          change(); assert.throws(() => adapter.beforeGo(handle), { code: 'LEARNING_PROVIDER_DRIFT' }, `${field}:${phase}`);
        }
        await assert.rejects(adapter.execute(handle, { onStart: () => { if (phase === 'onStart') change(); }, beforeGo: () => {} }),
          { code: 'LEARNING_PROVIDER_DRIFT' }, `${field}:${phase}`);
      }
      assert.equal(dispatched, 0); assert.equal(metadataCalls, 1);
    }
  }
});
test('ACP capability/permission handshake is never upgraded to a material-only permission', () => {
  const result = { jsonrpc: '2.0', id: 1, result: { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } }, authMethods: [{ id: 'cursor_login' }] } };
  assert.equal(cursorAcpLearningMetadata(result).allowed, false);
  for (const message of [{ ...result, id: 2 }, { jsonrpc: '2.0', id: 1, method: 'session/request_permission', params: {} },
    { ...result, result: { ...result.result, protocolVersion: 2 } }, { ...result, result: { ...result.result, authMethods: [] } }])
    assert.throws(() => cursorAcpLearningMetadata(message), { code: 'LEARNING_CURSOR_ACP_UNVERIFIED' });
});
const cursor = path.join(os.homedir(), '.local/bin/agent');
test('isolated Cursor profile proposal preserves HOME and accounts for inherited hooks/MCP/rules without enabling launch', () => {
  for (const platform of ['darwin', 'win32']) {
    const paths = platform === 'win32' ? path.win32 : path.posix, root = platform === 'win32' ? 'C:\\fixture' : '/fixture';
    const input = { platform, profileRoot: paths.join(root, 'profile'), workspaceRoot: paths.join(root, 'work'), home: paths.join(root, 'home') };
    const profile = cursorLearningProfile(input);
    assert.equal(profile.allowed, false); assert.equal('HOME' in profile.environment, false); assert.equal('USERPROFILE' in profile.environment, false);
    assert.equal(profile.files.length, 2); assert.equal(cursorLearningProfile(input).profileHash, profile.profileHash);
    assert.equal(profile.inherited.find(source => source.id === 'home-cursor-mcp').path, paths.join(input.home, '.cursor', 'mcp.json'));
    assert.equal(profile.inherited.find(source => source.id === 'home-claude-hooks').path, paths.join(input.home, '.claude', 'settings.json'));
    assert.ok(profile.inherited.some(source => source.path === paths.join(paths.parse(root).root, 'AGENTS.md')));
    assert.ok(profile.blockers.personal.length); assert.ok(profile.blockers.managed.length);
    assert.ok(JSON.parse(profile.files[0].content).permissions.deny.includes('Mcp(*:*)'));
  }
});
test('Cursor profile rejects unsupported OS instead of falling back to a POSIX profile', () => {
  assert.throws(() => cursorLearningProfile({ platform: 'freebsd', profileRoot: '/profile', workspaceRoot: '/work', home: '/home' }),
    { code: 'LEARNING_PLATFORM_UNSUPPORTED' });
});
test('native-no-inference: installed Cursor supports ACP initialize with unchanged auth/config and no session',
  { skip: process.env.FLOWCAIRN_NATIVE_NO_INFERENCE !== '1' || !existsSync(cursor) }, async t => {
    const cwd = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'fc-native-acp-test-')));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    const metadata = await inspectCursorLearningAcp({ executable: cursor, args: ['acp'], cwd,
      env: { HOME: os.homedir(), PATH: '/usr/bin:/bin', NO_COLOR: '1', DISABLE_AUTOUPDATER: '1', CURSOR_DATA_DIR: cwd } });
    assert.equal(metadata.noInference, true); assert.equal(metadata.allowed, false); assert.equal(metadata.authentication, 'not-requested');
  });
