import { spawnSync } from 'node:child_process';
import { realpathSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GraphError, hashObject } from './io.mjs';
import { learningNativeFile } from './learning-native-files.mjs';
import { learningNativeEnvironment } from './learning-native-platform.mjs';
import { claudePolicySnapshot } from './learning-native-claude-policy.mjs';
import { claudeLearningArgs, runClaudeLearningProtocol } from './learning-native-claude-protocol.mjs';

const WORKER = fileURLToPath(new URL('./learning-external-worker.mjs', import.meta.url));
const implementationDigest = () => hashObject(Object.fromEntries(['learning-external-worker.mjs', 'learning-external-runner.mjs',
  'learning-native-claude-protocol.mjs', 'learning-native-claude-policy.mjs', 'learning-native-files.mjs', 'learning-native-platform.mjs']
  .map(name => [name, learningNativeFile(fileURLToPath(new URL(name, import.meta.url))).hash])));
const receipts = new WeakMap();
const fail = (code, message) => { throw new GraphError(code, message); };

/** Existing runner owns discovery/auth. Learning adds byte identities; caller
 * paths from HTTP, stored jobs or model output never reach this bridge. */
export function externalLearningToolchain(toolchain) {
  if (toolchain?.provider?.provider !== 'claude') fail('LEARNING_CURSOR_BOUNDARY_UNVERIFIED', 'Для Cursor не подтверждена изоляция rules/hooks/MCP.');
  const executable = realpathSync(toolchain.provider.executable), node = realpathSync(toolchain.node);
  const identity = { nodeVersion: process.version, nodeDigest: learningNativeFile(node).hash, provider: 'claude',
    executable, version: toolchain.provider.version, executableDigest: learningNativeFile(executable).hash,
    workerDigest: learningNativeFile(WORKER).hash, implementationDigest: implementationDigest() };
  return Object.freeze({ node, executable, identity: Object.freeze(identity), digest: hashObject(identity) });
}

export function verifyExternalLearningToolchain(toolchain) {
  if (!toolchain?.identity || toolchain.identity.provider !== 'claude' || toolchain.identity.version !== '2.1.198 (Claude Code)'
    || !/^v22\./.test(toolchain.identity.nodeVersion) || hashObject(toolchain.identity) !== toolchain.digest)
    fail('LEARNING_CLAUDE_VERSION_UNSUPPORTED', 'Нужен проверенный Claude Code 2.1.198 и Node 22.');
  if (toolchain.identity.implementationDigest !== implementationDigest()) fail('LEARNING_NATIVE_TOOLCHAIN_DRIFT', 'Код учебного adapter изменился.');
  for (const [file, hash] of [[toolchain.node, toolchain.identity.nodeDigest], [toolchain.executable, toolchain.identity.executableDigest], [WORKER, toolchain.identity.workerDigest]]) {
    if (!path.isAbsolute(file) || realpathSync(file) !== file || learningNativeFile(file).hash !== hash)
      fail('LEARNING_NATIVE_TOOLCHAIN_DRIFT', 'Учебный toolchain изменился.');
  }
}

function userSettingsSnapshot(env) {
  const file = path.join(env.CLAUDE_CONFIG_DIR ?? path.join(env.HOME ?? env.USERPROFILE, '.claude'), 'settings.json');
  try {
    const { bytes, hash } = learningNativeFile(file, { maximum: 256 * 1024, content: true });
    const settings = JSON.parse(bytes.toString('utf8'));
    if (['env', 'apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'gcpAuthRefresh', 'proxyAuthHelper', 'policyHelper'].some(key => key in settings))
      fail('LEARNING_CLAUDE_CONFIG_UNSUPPORTED', 'Настройки CLI меняют способ доступа или запускают helper.');
    return hash;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export function externalLearningConfigurationSnapshot(env) {
  return hashObject({ managed: claudePolicySnapshot(env), user: userSettingsSnapshot(env) });
}
/** Guard before the existing runner invokes version/auth metadata commands. */
export function externalLearningLocalPolicyPreflight() {
  return externalLearningConfigurationSnapshot(learningNativeEnvironment('claude'));
}

export function assertClaudeLearningAuthentication(executable, env, cwd) {
  const run = spawnSync(executable, ['--safe-mode', 'auth', 'status'], { env, cwd, shell: false, encoding: 'utf8', timeout: 10000, maxBuffer: 32 * 1024 });
  let auth;
  try { auth = JSON.parse(run.stdout); } catch { /* Error below contains no raw auth data. */ }
  if (run.error || run.status !== 0 || auth?.loggedIn !== true)
    fail('LEARNING_PROVIDER_AUTH_REQUIRED', 'Войдите в выбранный CLI перед учебным вызовом.');
  // Native auth can report personal OAuth and an additional stored key at the
  // same time. That key can enable remote-managed settings before a prompt.
  if (Object.hasOwn(auth, 'apiKeySource') || auth.authMethod !== 'claude.ai' || auth.apiProvider !== 'firstParty' || !['pro', 'max'].includes(auth.subscriptionType))
    fail('LEARNING_MANAGED_POLICY_UNVERIFIED', 'Этот тип аккаунта требует отдельной проверки remote-managed policy до запуска.');
}

export async function preflightExternalLearning({ toolchain, scratch, model, reasoningEffort }) {
  verifyExternalLearningToolchain(toolchain);
  const env = learningNativeEnvironment('claude'), snapshot = externalLearningConfigurationSnapshot(env);
  assertClaudeLearningAuthentication(toolchain.executable, env, scratch);
  const command = { executable: toolchain.executable, args: claudeLearningArgs({ model, reasoningEffort }), cwd: scratch, env };
  const { facts } = await runClaudeLearningProtocol({ command, selection: { model, reasoningEffort } });
  if (snapshot !== externalLearningConfigurationSnapshot(env)) fail('LEARNING_PROVIDER_DRIFT', 'Настройки изменились во время preflight.');
  const receipt = Object.freeze({ allowed: true, provider: 'claude', cliVersion: toolchain.identity.version, code: null, reason: null,
    ...facts, policyHash: hashObject({ facts, snapshot, command, toolchain: toolchain.digest }), verifiedAt: new Date().toISOString() });
  receipts.set(receipt, { toolchain: structuredClone(toolchain), env, snapshot, scratch, model, reasoningEffort, expiresAt: Date.now() + 60000,
    scratchIdentity: `${lstatSync(scratch).dev}:${lstatSync(scratch).ino}` });
  return receipt;
}

export function externalLearningCommand({ receipt, scratch, schemaFile, resultFile, model, reasoningEffort }) {
  const state = receipts.get(receipt);
  if (!state || state.expiresAt < Date.now() || state.scratch !== scratch || state.model !== model || state.reasoningEffort !== reasoningEffort
    || `${lstatSync(scratch).dev}:${lstatSync(scratch).ino}` !== state.scratchIdentity)
    fail('LEARNING_CLAUDE_PREFLIGHT_REQUIRED', 'Нужен свежий preflight этого учебного вызова.');
  verifyExternalLearningToolchain(state.toolchain);
  if (state.snapshot !== externalLearningConfigurationSnapshot(state.env)) fail('LEARNING_PROVIDER_DRIFT', 'Настройки изменились после preflight.');
  if (schemaFile !== path.join(scratch, 'schema.json') || resultFile !== path.join(scratch, 'result.json'))
    fail('LEARNING_PREPARATION_INVALID', 'Некорректные файлы учебного запуска.');
  const binding = { toolchain: state.toolchain, snapshot: state.snapshot, configurationHash: receipt.configurationHash,
    inputHash: learningNativeFile(path.join(scratch, 'input.txt')).hash, schemaHash: learningNativeFile(schemaFile).hash,
    model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) };
  return Object.freeze({ executable: state.toolchain.node, args: Object.freeze([WORKER, JSON.stringify(binding)]), cwd: scratch, env: Object.freeze({ ...state.env }) });
}
