import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { lstatHostSync as lstatSync, fstatHostSync as fstatSync, crossStatIdentity, isPrivateMode, isTrustedMode, noFollowReadFlags } from './host-filesystem.mjs';
import { GraphError, hashObject } from './io.mjs';

/** @typedef {{node:string,codexEntry:string,digest:string,identity:{nodeVersion:string,nodeDigest:string,codexVersion:string,
 * codexEntryDigest:string,codexNativeDigest:string,codexManifestDigest:string,codexNativeManifestDigest:string}}} LearningToolchain */
export const CODEX_LEARNING_VERSIONS = Object.freeze(['0.156.1', '0.157.1']);
const PROFILE = 'flowcairn-learning';
const receipts = new WeakMap();
const DISABLED = Object.freeze(['hooks','apps','plugins','memories','chronicle','multi_agent','multi_agent_v2','browser_use','browser_use_external','computer_use',
  'in_app_browser','in_app_chat','in_app_dictation','in_app_local_automation','in_app_updates','daemon_auto_start','code_mode','code_mode_host','shell_tool','unified_exec','view_image','image_generation',
  'skill_search','skill_mcp_dependency_install','external_agent_memory_import','workspace_dependencies','remote_plugin','recommended_plugins','goals','shell_snapshot',
  'agent_message_board','artifact','auth_elicitation','browser_use_full_cdp_access','enable_mcp_apps','external_migration','mentions_v2','realtime_conversation',
  'request_permissions_tool','tool_call_mcp_elicitation','tool_suggest','worktrees']);
/** @returns {never} */
const fail = (code, message) => { throw new GraphError(code, message); };
const inode = (stat) => `${stat.dev}:${stat.ino}`;

function environment() {
  const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', NO_COLOR: '1', OPENSSL_CONF: os.devNull };
  for (const key of ['HOME', 'CODEX_HOME']) if (process.env[key]) env[key] = process.env[key];
  return env;
}

function fileBytes(file, maximum) {
  const before = lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || !isTrustedMode(before) || before.size > BigInt(maximum))
    fail('LEARNING_CODEX_TOOLCHAIN_INVALID', 'Файл CLI или metadata небезопасен.');
  const handle = openSync(file, noFollowReadFlags());
  try {
    if (crossStatIdentity(fstatSync(handle, { bigint: true })) !== crossStatIdentity(before))
      fail('LEARNING_CODEX_TOOLCHAIN_INVALID', 'Файл CLI или metadata заменен.');
    const buffer = Buffer.alloc(Number(before.size) + 1); let offset = 0, count;
    while (offset < buffer.length && (count = readSync(handle, buffer, offset, buffer.length - offset, null)) > 0) offset += count;
    if (offset !== Number(before.size) || crossStatIdentity(fstatSync(handle, { bigint: true })) !== crossStatIdentity(before)
      || crossStatIdentity(lstatSync(file, { bigint: true })) !== crossStatIdentity(before))
      fail('LEARNING_CODEX_TOOLCHAIN_INVALID', 'Файл CLI или metadata изменился.');
    return buffer.subarray(0, offset);
  } finally { closeSync(handle); }
}

function digestFile(file) {
  const before = lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || !isTrustedMode(before) || before.size > 512n * 1024n * 1024n)
    fail('LEARNING_CODEX_TOOLCHAIN_INVALID', 'Файл toolchain небезопасен.');
  const handle = openSync(file, noFollowReadFlags()), hash = createHash('sha256'), buffer = Buffer.alloc(256 * 1024);
  try {
    if (crossStatIdentity(fstatSync(handle, { bigint: true })) !== crossStatIdentity(before))
      fail('LEARNING_CODEX_TOOLCHAIN_INVALID', 'Toolchain заменен перед чтением.');
    let bytes = 0, count;
    while ((count = readSync(handle, buffer, 0, buffer.length, null)) > 0) {
      bytes += count;
      if (bytes > Number(before.size)) fail('LEARNING_CODEX_TOOLCHAIN_DRIFT', 'Toolchain изменился во время чтения.');
      hash.update(buffer.subarray(0, count));
    }
    if (bytes !== Number(before.size) || crossStatIdentity(fstatSync(handle, { bigint: true })) !== crossStatIdentity(before)
      || crossStatIdentity(lstatSync(file, { bigint: true })) !== crossStatIdentity(before))
      fail('LEARNING_CODEX_TOOLCHAIN_DRIFT', 'Toolchain изменился во время чтения.');
    return hash.digest('hex');
  } finally { closeSync(handle); }
}

/** The caller supplies the existing runner's verified toolchain, not HTTP paths.
 * Recheck pinned bytes before preflight/dispatch, without auth or version calls. */
function verifyToolchain(toolchain) {
  if (process.platform !== 'darwin') fail('LEARNING_CODEX_PLATFORM_UNVERIFIED', 'Учебный native profile пока проверен только на macOS.');
  if (!toolchain?.identity || !CODEX_LEARNING_VERSIONS.includes(toolchain.identity.codexVersion) || !/^v22\./.test(toolchain.identity.nodeVersion))
    fail('LEARNING_CODEX_VERSION_UNSUPPORTED', 'Версия Codex/Node не проверена для учебного adapter.');
  if (hashObject(toolchain.identity) !== toolchain.digest || !path.isAbsolute(toolchain.node) || !path.isAbsolute(toolchain.codexEntry))
    fail('LEARNING_CODEX_TOOLCHAIN_INVALID', 'Нужен проверенный toolchain текущего runner.');
  const packageFile = path.resolve(path.dirname(toolchain.codexEntry), '..', 'package.json');
  const nativePackage = createRequire(toolchain.codexEntry).resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`);
  const triple = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`;
  const native = path.join(path.dirname(nativePackage), 'vendor', triple, 'bin', 'codex');
  for (const [file, expected] of [[toolchain.node, toolchain.identity.nodeDigest], [toolchain.codexEntry, toolchain.identity.codexEntryDigest],
    [packageFile, toolchain.identity.codexManifestDigest], [nativePackage, toolchain.identity.codexNativeManifestDigest], [native, toolchain.identity.codexNativeDigest]]) {
    if (digestFile(file) !== expected) fail('LEARNING_CODEX_TOOLCHAIN_DRIFT', 'Файлы Codex изменились после проверки runner.');
  }
}

/** Metadata keys only. Never returned to a model, persisted or logged. Empty
 * table overrides merge in Codex, so every discovered MCP needs enabled=false. */
function mcpKeysFromFiles(candidates) {
  const names = new Set();
  for (const file of candidates) {
    let bytes;
    try { bytes = fileBytes(file, 256 * 1024); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    let data;
    try { data = parseToml(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { fail('LEARNING_CODEX_CONFIG_UNAVAILABLE', 'Metadata настроек CLI не удалось безопасно проверить.'); }
    for (const layer of [data, ...Object.values(data.profiles ?? {})]) {
      for (const name of Object.keys(layer.mcp_servers ?? {})) {
        if (!/^[A-Za-z0-9_-]{1,120}$/.test(name) || (!names.has(name) && names.size >= 128))
          fail('LEARNING_CODEX_CONFIG_UNSUPPORTED', 'Имя интеграции нельзя безопасно адресовать CLI override.');
        names.add(name);
      }
    }
  }
  return [...names].sort();
}
function mcpMetadataKeys() {
  return mcpKeysFromFiles([path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'config.toml'), '/etc/codex/config.toml', '/etc/codex/managed_config.toml']);
}

function filesystem(scratch) { return { ':root': 'deny', ':minimal': 'read', ':tmpdir': 'deny', ':slash_tmp': 'deny', [scratch]: 'read' }; }
function controls(scratch, names) {
  return [
    'approval_policy="never"', 'project_doc_max_bytes=0', 'project_doc_fallback_filenames=[]', 'project_root_markers=["schema.json"]', 'notify=[]', 'web_search="disabled"', 'check_for_update_on_startup=false',
    'model_provider="openai"', `default_permissions="${PROFILE}"`, 'features.skip_host_skill_discovery=true',
    `permissions.${PROFILE}.filesystem={${Object.entries(filesystem(scratch)).map(([key,value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`).join(',')}}`,
    `permissions.${PROFILE}.network={enabled=false}`, 'shell_environment_policy.inherit="none"',
    'shell_environment_policy.set={PATH="/usr/bin:/bin:/usr/sbin:/sbin",NO_COLOR="1"}',
    ...DISABLED.map(key => `features.${key}=false`), ...names.map(name => `mcp_servers.${name}.enabled=false`),
  ];
}
const configArgs = (values) => values.flatMap(value => ['--config', value]);
function diagnosticCode(text) {
  return /features|permission|approval|web_search|model_provider/i.test(text) && /requirement|managed|allowed|pinned|constraint/i.test(text)
    ? 'LEARNING_MANAGED_POLICY_CONFLICT' : 'LEARNING_CODEX_CONFIG_UNAVAILABLE';
}

/** Read-only protocol: no thread/start, turn/start, command/exec or write RPC.
 * Capture raw configuration only in this short-lived process's memory. */
function readConfiguration(toolchain, scratch, settings) {
  return new Promise((resolve, reject) => {
    const child = spawn(toolchain.node, [toolchain.codexEntry, 'app-server', '--stdio', ...configArgs(settings)],
      { cwd: scratch, env: environment(), shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    let buffer = '', bytes = 0, diagnostics = '', requirements, value, error, closed = false;
    const stop = (problem) => { error ??= problem; child.stdin.end(); child.kill('SIGTERM'); };
    const timeout = setTimeout(() => stop(new GraphError('LEARNING_CODEX_PREFLIGHT_TIMEOUT', 'Проверка конфигурации Codex не завершилась.')), 15_000);
    const kill = setTimeout(() => child.kill('SIGKILL'), 17_000);
    const send = (message) => { if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(message)}\n`); };
    child.stdin.on('error', () => stop(new GraphError('LEARNING_CODEX_CONFIG_UNAVAILABLE', 'Канал preflight закрыт.')));
    child.stderr.on('data', chunk => { diagnostics += chunk.toString('utf8'); if (Buffer.byteLength(diagnostics) > 64 * 1024) stop(new GraphError('LEARNING_CODEX_CONFIG_UNAVAILABLE', 'Диагностика preflight превысила лимит.')); });
    child.stdout.on('data', chunk => {
      bytes += Buffer.byteLength(chunk, 'utf8');
      if (bytes > 2 * 1024 * 1024) { stop(new GraphError('LEARNING_CODEX_CONFIG_UNAVAILABLE', 'Ответ config/read превысил лимит.')); return; }
      buffer += chunk.toString('utf8');
      while (buffer.includes('\n') && !error) {
        const end = buffer.indexOf('\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { stop(new GraphError('LEARNING_CODEX_CONFIG_UNAVAILABLE', 'Некорректный ответ config/read.')); break; }
        if (message.error) { stop(new GraphError(diagnosticCode(String(message.error.message ?? '')), 'CLI отклонил read-only preflight.')); break; }
        if (['thread/started','turn/started'].includes(message.method)) { stop(new GraphError('LEARNING_CODEX_CONFIG_UNAVAILABLE', 'Config reader неожиданно начал сессию.')); break; }
        if (message.id === 1) {
          send({ method: 'initialized', params: {} }); send({ id: 2, method: 'configRequirements/read', params: {} });
        } else if (message.id === 2) {
          requirements = message.result?.requirements;
          send({ id: 3, method: 'config/read', params: { includeLayers: true, cwd: scratch } });
        } else if (message.id === 3) { value = { requirements, config: message.result?.config, layers: message.result?.layers }; stop(null); }
      }
    });
    child.on('error', () => stop(new GraphError('LEARNING_CODEX_CONFIG_UNAVAILABLE', 'Не удалось запустить config reader.')));
    child.on('close', () => {
      if (closed) return; closed = true; clearTimeout(timeout); clearTimeout(kill);
      if (error) reject(error); else if (value) resolve(value);
      else reject(new GraphError(diagnosticCode(diagnostics), 'CLI не вернул проверяемую конфигурацию.'));
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'flowcairn_learning_preflight', version: '1.0.0' }, capabilities: { experimentalApi: true } } });
  });
}

function validateConfiguration({ config, requirements, layers }, scratch, names) {
  if (!config || requirements === undefined || !Array.isArray(layers)) fail('LEARNING_CODEX_CONFIG_UNAVAILABLE', 'Нет проверяемого config/requirements ответа.');
  const expectedFeatures = Object.fromEntries([...DISABLED.map(key => [key, false]), ['skip_host_skill_discovery', true]]);
  const pins = requirements?.featureRequirements ?? {};
  if (Object.entries(expectedFeatures).some(([key,value]) => key in pins && pins[key] !== value)
    || requirements?.allowedApprovalPolicies && !requirements.allowedApprovalPolicies.includes('never')
    || requirements?.allowedWebSearchModes && !requirements.allowedWebSearchModes.includes('disabled')
    || requirements?.defaultPermissions && requirements.defaultPermissions !== PROFILE
    || requirements?.modelProvider && requirements.modelProvider !== 'openai'
    || requirements?.allowedPermissionProfiles && requirements.allowedPermissionProfiles[PROFILE] !== true)
    fail('LEARNING_MANAGED_POLICY_CONFLICT', 'Managed policy несовместима с ограниченным учебным вызовом; правила не обходятся.');
  const actualFilesystem = { ...config.permissions?.[PROFILE]?.filesystem };
  if (actualFilesystem.glob_scan_max_depth === null) delete actualFilesystem.glob_scan_max_depth;
  const servers = config.mcp_servers ?? {};
  if (Object.entries(expectedFeatures).some(([key,value]) => config.features?.[key] !== value)
    || Object.entries(servers).some(([name, server]) => !names.includes(name) || server.enabled !== false)
    || config.approval_policy !== 'never' || config.web_search !== 'disabled' || config.model_provider !== 'openai'
    || config.project_doc_max_bytes !== 0 || JSON.stringify(config.notify) !== '[]'
    || config.check_for_update_on_startup !== false
    || JSON.stringify(config.project_root_markers) !== '["schema.json"]'
    || JSON.stringify(config.project_doc_fallback_filenames) !== '[]' || config.default_permissions !== PROFILE
    || hashObject(actualFilesystem) !== hashObject(filesystem(scratch)) || config.permissions?.[PROFILE]?.network?.enabled !== false
    || config.shell_environment_policy?.inherit !== 'none')
    fail('LEARNING_CODEX_CONTROLS_UNVERIFIED', 'Effective config не подтверждает учебные ограничения.');
  const retainedMcp = new Set();
  for (const layer of layers) {
    if (layer.disabledReason || ['user', 'sessionFlags'].includes(layer.name?.type)) continue;
    if (!['packagedDefaults','mdm','system','enterpriseManaged','legacyManagedConfigTomlFromFile','legacyManagedConfigTomlFromMdm','project'].includes(layer.name?.type))
      fail('LEARNING_CODEX_CONFIG_UNSUPPORTED', 'Неизвестный слой конфигурации CLI.');
    const keys = Object.keys(layer.config?.mcp_servers ?? {});
    if (layer.name.type === 'project' && keys.length) fail('LEARNING_CODEX_CONFIG_UNSUPPORTED', 'Учебный scratch не должен наследовать project MCP.');
    for (const name of keys) {
      if (!names.includes(name)) fail('LEARNING_CODEX_CONTROLS_UNVERIFIED', 'Обнаружена неотключенная managed интеграция.');
      retainedMcp.add(name);
    }
  }
  return { features: expectedFeatures, mcpDisabled: true, networkDisabled: true, readonlyFilesystem: true, managedCompatible: true, retainedMcp: [...retainedMcp].sort() };
}

/** Metadata-only preflight. Native profile enforcement is separately tested
 * without inference; exec itself re-applies managed constraints at launch.
 * @param {{toolchain:LearningToolchain,scratch:string}} options */
export async function preflightCodexLearning({ toolchain, scratch }) {
  verifyToolchain(toolchain);
  const root = realpathSync(scratch), stat = lstatSync(scratch, { bigint: true });
  if (root !== scratch || !stat.isDirectory() || stat.isSymbolicLink() || !isPrivateMode(stat))
    fail('LEARNING_SCRATCH_UNSAFE', 'Учебный preflight требует отдельный закрытый scratch.');
  const names = mcpMetadataKeys(), settings = controls(root, names);
  const effective = await readConfiguration(toolchain, root, settings);
  const facts = validateConfiguration(effective, root, names);
  const executionSettings = controls(root, facts.retainedMcp);
  const receipt = Object.freeze({ allowed: true, provider: 'codex', cliVersion: toolchain.identity.codexVersion, code: null, reason: null,
    policyHash: hashObject({ preflightSettings: settings, executionSettings, toolchain: toolchain.digest }), verifiedAt: new Date().toISOString() });
  receipts.set(receipt, { toolchain: structuredClone(toolchain), scratch: root, identity: inode(stat), settings: executionSettings, names,
    metadataHash: hashObject(names), facts, expiresAt: Date.now() + 60_000 });
  return receipt;
}

/** Create the command only from a locally issued fresh preflight receipt. */
export function codexLearningCommand({ receipt, scratch, schemaFile, resultFile, model }) {
  const verified = receipts.get(receipt);
  if (!verified || verified.expiresAt < Date.now() || scratch !== verified.scratch || inode(lstatSync(scratch, { bigint: true })) !== verified.identity)
    fail('LEARNING_CODEX_PREFLIGHT_REQUIRED', 'Нужен свежий preflight именно этого учебного scratch.');
  verifyToolchain(verified.toolchain);
  if (hashObject(mcpMetadataKeys()) !== verified.metadataHash) fail('LEARNING_CODEX_CONFIG_DRIFT', 'Набор интеграций изменился после preflight.');
  if (schemaFile !== path.join(scratch, 'schema.json') || resultFile !== path.join(scratch, 'result.json')
    || typeof model !== 'string' || model === 'provider-default' || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,159}$/.test(model))
    fail('LEARNING_CODEX_COMMAND_INVALID', 'Неверные поля учебной команды.');
  return buildCommand(verified.toolchain, verified.settings, scratch, schemaFile, resultFile, model);
}

function buildCommand({ node, codexEntry }, settings, scratch, schemaFile, resultFile, model) {
  // Exec ignores user config; app-server preflight tolerates it, explicitly
  // disabling every discovered integration. Do not transfer exec-only flags.
  return Object.freeze({ executable: node, args: Object.freeze([codexEntry, 'exec', '--ignore-user-config', '--ignore-rules', '--strict-config', '--ephemeral',
    '--skip-git-repo-check', '--json', '--output-schema', schemaFile, '--output-last-message', resultFile, '--cd', scratch,
    '--model', model, ...configArgs(settings), '-']), cwd: scratch, env: Object.freeze(environment()) });
}

export const LEARNING_RUNNER_TESTING = Object.freeze({ validateConfiguration, controls, filesystem, disabled: DISABLED, readConfiguration, mcpKeysFromFiles, buildCommand });
