import { readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { GraphError, hashObject } from './io.mjs';
import { learningNativeFile } from './learning-native-files.mjs';

const fail = () => { throw new GraphError('LEARNING_MANAGED_POLICY_CONFLICT', 'Managed policy содержит автоматизацию или непроверенные настройки учебного вызова.'); };
const policyKeys = new Set(['permissions', 'disableAllHooks', 'availableModels', 'enforceAvailableModels', 'forceLoginMethod', 'forceLoginOrgUUID',
  'allowManagedPermissionRulesOnly', 'allowManagedHooksOnly', 'allowManagedMcpServersOnly', 'allowedMcpServers', 'deniedMcpServers', 'requiredMinimumVersion',
  'model', 'effortLevel', 'autoMemoryEnabled', 'cleanupPeriodDays']);
export function validateClaudePolicy(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) || Object.keys(settings).some(key => !policyKeys.has(key))) fail();
  if (settings.permissions && (typeof settings.permissions !== 'object' || Array.isArray(settings.permissions)
    || Object.keys(settings.permissions).some(key => !['allow', 'deny', 'ask', 'defaultMode', 'disableBypassPermissionsMode'].includes(key)))) fail();
  return settings;
}

/** Inspect local managed sources before starting a CLI that could run hooks.
 * Unknown managed sources are a diagnostic, never silently disabled. */
export function claudePolicySnapshot(env, platform = process.platform) {
  if (!['darwin', 'win32'].includes(platform))
    throw new GraphError('LEARNING_PLATFORM_UNSUPPORTED', 'Учебная policy проверяется только на macOS и native Windows.');
  const configDir = env.CLAUDE_CONFIG_DIR ?? path.join(env.HOME ?? env.USERPROFILE ?? os.homedir(), '.claude');
  const base = platform === 'darwin' ? '/Library/Application Support/ClaudeCode'
    : path.win32.join(env.PROGRAMFILES ?? 'C:\\Program Files', 'ClaudeCode');
  const files = [path.join(configDir, 'remote-settings.json'), path.join(base, 'managed-settings.json')], hashes = [];
  try {
    for (const name of readdirSync(path.join(base, 'managed-settings.d')).sort()) {
      if (name.endsWith('.json') && !name.startsWith('.')) files.push(path.join(base, 'managed-settings.d', name));
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const file of files) {
    try {
      const { bytes, hash } = learningNativeFile(file, { maximum: 256 * 1024, content: true });
      validateClaudePolicy(JSON.parse(bytes.toString('utf8'))); hashes.push({ file, hash });
    } catch (error) { if (error.code === 'ENOENT') hashes.push({ file, hash: null }); else throw error; }
  }
  if (platform === 'darwin') {
    for (const file of [path.join('/Library/Managed Preferences', os.userInfo().username, 'com.anthropic.claudecode.plist'),
      '/Library/Managed Preferences/com.anthropic.claudecode.plist']) {
      try { const { hash } = learningNativeFile(file); hashes.push({ file, hash });
        // No best-effort parser for MDM. It can carry executable policy helpers.
        throw new GraphError('LEARNING_MANAGED_POLICY_UNVERIFIED', 'MDM policy требует отдельного проверенного учебного профиля.');
      } catch (error) { if (error.code !== 'ENOENT') throw error; hashes.push({ file, hash: null }); }
    }
  } else if (platform === 'win32') {
    // Query presence, without reading or logging policy values. Unknown access
    // failures do not mean there is no registry policy.
    const exe = path.win32.join(env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'reg.exe');
    for (const key of ['HKLM\\SOFTWARE\\Policies\\ClaudeCode', 'HKCU\\SOFTWARE\\Policies\\ClaudeCode']) {
      const result = spawnSync(exe, ['query', key], { env, encoding: 'utf8', timeout: 5000, maxBuffer: 65536, shell: false });
      if (result.error || result.status !== 1 || !/unable to find|cannot find/i.test(result.stderr ?? ''))
        throw new GraphError('LEARNING_MANAGED_POLICY_UNVERIFIED', 'Registry policy требует отдельного проверенного учебного профиля.');
    }
  }
  return hashObject(hashes);
}

export function validateClaudeConfiguration({ settings, mcp, initialization }, { model, reasoningEffort }) {
  if (!settings?.effective || !Array.isArray(settings.sources) || !settings.applied || settings.errors?.length
    || !Array.isArray(mcp?.mcpServers) || mcp.mcpServers.length || !Array.isArray(initialization?.commands) || initialization.commands.length
    || !Array.isArray(initialization?.agents))
    throw new GraphError('LEARNING_CLAUDE_CONTROLS_UNVERIFIED', 'CLI не подтвердил effective настройки и отключение MCP/skills.');
  for (const source of settings.sources) {
    if (!['userSettings', 'flagSettings', 'policySettings'].includes(source.source)) fail();
    if (source.source === 'policySettings') validateClaudePolicy(source.settings);
  }
  const effective = settings.effective;
  if (effective.disableAllHooks !== true || effective.env || effective.apiKeyHelper || effective.policyHelper || effective.fallbackModel
    || effective.awsAuthRefresh || effective.awsCredentialExport || effective.gcpAuthRefresh || effective.proxyAuthHelper)
    throw new GraphError('LEARNING_CLAUDE_CONFIG_UNSUPPORTED', 'Настройки меняют доступ, fallback или запускают внешнюю команду.');
  const actualModel = settings.applied.model, actualEffort = settings.applied.effort;
  if (typeof actualModel !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/[\]-]{0,159}$/.test(actualModel)
    || actualEffort !== null && !['low', 'medium', 'high', 'xhigh', 'max'].includes(actualEffort)
    || settings.applied.advisor !== null || settings.applied.ultracode !== false)
    throw new GraphError('LEARNING_CLAUDE_CONTROLS_UNVERIFIED', 'Не подтверждены действующие модель и усиление.');
  if (model !== 'provider-default' && model !== actualModel || reasoningEffort !== undefined && reasoningEffort !== actualEffort)
    throw new GraphError('LEARNING_PROVIDER_DRIFT', 'CLI применил другую модель или усиление.');
  return { configurationHash: hashObject({ settings, mcp, commands: initialization.commands, agents: initialization.agents }),
    effectiveModel: actualModel, ...(actualEffort === null ? {} : { effectiveReasoningEffort: actualEffort }) };
}
