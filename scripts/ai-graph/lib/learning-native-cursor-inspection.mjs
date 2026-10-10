import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { hashObject } from './io.mjs';
import { learningNativeFile } from './learning-native-files.mjs';
import { providerEnvironment } from './provider-process-platform.mjs';
import { cursorLearningProfile } from './learning-native-cursor-profile.mjs';
import { cursorLearningCandidate } from './learning-native-cursor.mjs';

const fail = (code, reason) => ({ provider: 'cursor', boundaryTier: 'native-client-learning', status: 'unavailable', canOfferConsent: false, reasonCode: code, reason });
const runJson = (executable, args, cwd, env) => {
  const result = spawnSync(executable, args, { cwd, env, shell: false, encoding: 'utf8', timeout: 10_000, maxBuffer: 256 * 1024 });
  if (result.error || result.status !== 0) return { error: 'CURSOR_STATUS_UNAVAILABLE' };
  try { return JSON.parse(result.stdout); } catch { return { error: 'CURSOR_STATUS_INVALID' }; }
};

function sourceSnapshot(entries) {
  const files = [];
  for (const entry of entries) {
    if (!existsSync(entry.path)) { files.push({ id: entry.id, path: entry.path, present: false, hash: null }); continue; }
    try { files.push({ id: entry.id, path: entry.path, present: true, hash: learningNativeFile(entry.path, { maximum: 512 * 1024 }).hash }); }
    catch (error) { return { error: error.code ?? 'CURSOR_SOURCE_UNAVAILABLE' }; }
  }
  return { files, hash: hashObject(files) };
}

/** @param {{executable?:string,cwd?:string,home?:string,profileRoot?:string,workspaceRoot?:string,expectedVersion?:string|null,env?:NodeJS.ProcessEnv,platform?:NodeJS.Platform,disclosureHash?:string|null,scopeHash?:string|null}} options
 * Read-only native inspection. It never logs in, starts a session, sends a
 * prompt, or claims the Cursor agent's effective global/team policy. */
export function inspectNativeCursorLearningProfile({ executable, cwd, home, profileRoot, workspaceRoot, expectedVersion = null,
  env = process.env, platform = process.platform, disclosureHash = null, scopeHash = null } = {}) {
  if (!['darwin', 'win32'].includes(platform)) return fail('LEARNING_PLATFORM_UNSUPPORTED', 'Cursor learning inspection доступен только на macOS и native Windows.');
  if (typeof executable !== 'string' || !path.isAbsolute(executable) || typeof cwd !== 'string' || !path.isAbsolute(cwd)
    || typeof home !== 'string' || !path.isAbsolute(home) || typeof profileRoot !== 'string' || !path.isAbsolute(profileRoot)
    || typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot))
    return fail('LEARNING_CURSOR_PROFILE_INVALID', 'Нужны абсолютные пути выбранного native Cursor profile.');
  const environment = providerEnvironment(env, platform);
  const versionResult = spawnSync(executable, ['--version'], { cwd, env: environment, shell: false, encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 });
  const version = typeof versionResult.stdout === 'string' ? versionResult.stdout.trim() : '';
  if (versionResult.error || versionResult.status !== 0 || !version || expectedVersion && version !== expectedVersion)
    return fail('LEARNING_CURSOR_VERSION_UNVERIFIED', 'Версия Cursor CLI не совпадает с закрепленной native версией.');
  let executableHash;
  try { executableHash = learningNativeFile(executable, { maximum: 512 * 1024 * 1024 }).hash; }
  catch (error) { return fail(error.code ?? 'LEARNING_CURSOR_TOOLCHAIN_UNAVAILABLE', 'Байты Cursor executable недоступны для проверки.'); }
  const profile = cursorLearningProfile({ profileRoot, workspaceRoot, home, platform });
  const sources = sourceSnapshot(profile.inherited);
  if (sources.error) return fail(sources.error, 'Известный локальный источник Cursor недоступен для проверки.');
  const status = runJson(executable, ['status', '--format', 'json'], cwd, environment);
  if (status.error) return fail(status.error, 'Cursor status --format json не вернул проверяемый ответ.');
  if (status.status !== 'authenticated' || status.isAuthenticated !== true || !status.userInfo
    || (!status.userInfo.userId && !status.userInfo.email))
    return fail('LEARNING_CURSOR_AUTH_REQUIRED', 'Cursor не подтвердил авторизацию и identity пользователя.');
  // Team list is a documented native command, but successful identity alone is
  // insufficient: team policy/hooks can refresh outside CURSOR_CONFIG_DIR.
  const teams = runJson(executable, ['team', 'list', '--format', 'json'], cwd, environment);
  if (teams.error || !Array.isArray(teams.teams)) return fail('LEARNING_CURSOR_TEAM_POLICY_UNVERIFIED', 'Состав команд Cursor не удалось проверить.');
  if (teams.teams.length > 0) return fail('LEARNING_CURSOR_MANAGED_POLICY_UNVERIFIED', 'Командные правила Cursor требуют отдельной native policy проверки.');
  const accountIdentity = { userId: status.userInfo.userId ?? null, email: status.userInfo.email ?? null,
    teamId: status.userInfo.teamId ?? null, teamName: status.userInfo.teamName ?? null };
  const toolchainHash = hashObject({ executableHash, version });
  const selectedClientHash = hashObject({ profileHash: profile.profileHash, mode: 'ask', sandbox: 'enabled', toolchainHash });
  const accountIdentityHash = hashObject(accountIdentity);
  return { provider: 'cursor', boundaryTier: 'native-client-learning', status: 'blocked', canOfferConsent: false,
    reasonCode: 'LEARNING_CURSOR_MANAGED_POLICY_UNVERIFIED', reason: 'Локальные источники проверены, но Cursor native hooks/plugins/skills policy не экспортирует полный effective allowlist.',
    inspectionHash: hashObject({ version, executableHash, selectedClientHash, sources: sources.hash, accountIdentityHash, teams: [], disclosureHash, scopeHash }),
    binding: { selectedClientHash, toolchainHash, executableHash, sourceScopeHash: sources.hash, accountIdentityHash,
      disclosureHash, scopeHash, policyScope: 'known-local-and-reported-native', actions: ['generate-lesson', 'ask-lesson'] },
    candidate: cursorLearningCandidate() };
}
