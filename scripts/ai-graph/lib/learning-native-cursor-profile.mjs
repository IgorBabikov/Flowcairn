import path from 'node:path';
import { GraphError, hashObject } from './io.mjs';
import { cursorLearningCandidate } from './learning-native-cursor.mjs';

/** Pure, reviewable proposal. Does not write a profile, copy credentials, start
 * login, suppress policy, or issue a launch capability. HOME is never changed. */
export function cursorLearningProfile({ profileRoot, workspaceRoot, home, platform = process.platform, model = 'provider-default', reasoningEffort = undefined }) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (!['darwin', 'win32'].includes(platform))
    throw new GraphError('LEARNING_PLATFORM_UNSUPPORTED', 'Учебный профиль поддерживает только macOS и native Windows.');
  if (![profileRoot, workspaceRoot, home].every(value => typeof value === 'string' && paths.isAbsolute(value)))
    throw new GraphError('LEARNING_CURSOR_PROFILE_INVALID', 'Профиль требует абсолютные пути выбранной ОС.');
  const candidate = cursorLearningCandidate({ model, reasoningEffort });
  const configDir = paths.join(profileRoot, 'config'), dataDir = paths.join(profileRoot, 'data');
  const enterprise = platform === 'darwin' ? '/Library/Application Support/Cursor/hooks.json'
    : 'C:\\ProgramData\\Cursor\\hooks.json';
  const inherited = [
    { id: 'home-cursor-hooks', path: paths.join(home, '.cursor', 'hooks.json'), kind: 'hooks' },
    { id: 'home-cursor-mcp', path: paths.join(home, '.cursor', 'mcp.json'), kind: 'mcp' },
    { id: 'home-claude-hooks', path: paths.join(home, '.claude', 'settings.json'), kind: 'third-party-hooks' },
    { id: 'enterprise-hooks', path: enterprise, kind: 'managed-hooks' },
    { id: 'workspace-cursor-hooks', path: paths.join(workspaceRoot, '.cursor', 'hooks.json'), kind: 'hooks' },
    { id: 'workspace-cursor-mcp', path: paths.join(workspaceRoot, '.cursor', 'mcp.json'), kind: 'mcp' },
    { id: 'workspace-claude-hooks', path: paths.join(workspaceRoot, '.claude', 'settings.json'), kind: 'third-party-hooks' },
    { id: 'workspace-claude-local-hooks', path: paths.join(workspaceRoot, '.claude', 'settings.local.json'), kind: 'third-party-hooks' },
  ];
  let parent = paths.resolve(workspaceRoot), depth = 0;
  for (;;) {
    for (const name of ['AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md', '.cursor/rules'])
      inherited.push({ id: `ancestor-${depth}-${name.replaceAll(/[^a-zA-Z0-9]/g, '-')}`, path: paths.join(parent, name), kind: 'rules' });
    const next = paths.dirname(parent); if (next === parent) break; parent = next; depth++;
  }
  const files = [
    { path: paths.join(configDir, 'cli-config.json'), content: JSON.stringify(candidate.config, null, 2) + '\n' },
    { path: paths.join(workspaceRoot, '.cursor', 'cli.json'), content: JSON.stringify({ permissions: candidate.config.permissions }, null, 2) + '\n' },
  ];
  return { version: 1, allowed: false, code: 'LEARNING_CURSOR_PROFILE_UNVERIFIED',
    environment: { CURSOR_CONFIG_DIR: configDir, CURSOR_DATA_DIR: dataDir }, files,
    profileHash: hashObject({ platform, model, reasoningEffort: reasoningEffort ?? null, files }), inherited,
    requiredGates: ['native-login-in-profile', 'all-local-source-hashes', 'account-team-policy', 'effective-model-effort', 'tool-read-write-sentinels', 'no-auto-context-or-hooks'],
    blockers: { personal: ['Home hooks/MCP/third-party hooks remain outside the profile.', 'Ancestor rules and plugin/skill discovery need complete inspection.',
      'ACP does not make native tools client-owned; effective settings export is unavailable.'],
    managed: ['Team rules/hooks and policy can refresh at runtime; no material-only receipt is exposed.', 'Managed policy must not be bypassed by profile relocation.'] },
    provenance: { cliVersion: '2026.10.01-e373342',
      documentation: ['https://cursor.com/docs/cli/reference/configuration', 'https://cursor.com/docs/cli/reference/permissions', 'https://cursor.com/docs/cli/acp', 'https://cursor.com/docs/hooks', 'https://cursor.com/docs/rules'],
      nativeInspection: ['index.js: cursor-config/paths and MCP homedir lookup', '190.index.js: hooks-exec default paths', '3351.index.js: ACP local executor and asynchronous team hooks'],
      dataDirectory: 'CURSOR_DATA_DIR for ACP project data observed in pinned CLI; not a policy or credential isolation guarantee' } };
}
