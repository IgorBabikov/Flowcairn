import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { GraphError, hashObject } from './io.mjs';
import { EXTERNAL_PROVIDER_CONSENT } from './harnesses.mjs';

const Provider = z.enum(['claude', 'cursor']);
const Version = z.string().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._ ()-]*$/);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const ExternalConsentSchema = z.strictObject({
  version: z.literal(1), provider: Provider, planHash: Hash, scopeHash: Hash,
  instructionsHash: Hash, skillsHash: Hash, artifactsHash: Hash,
  transmitted: z.array(z.enum(['approved-scope', 'approved-instructions', 'approved-skills', 'approved-artifacts'])).min(1).max(4),
  excluded: z.array(z.enum(['secrets', 'environment-files', 'git-history', 'unapproved-files', 'project-host-shell'])).length(5),
  cliPath: z.string().min(1).max(1024), cliVersion: Version, createdAt: z.iso.datetime(),
});
const safeEnv = { PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', NO_COLOR: '1' };
const names = { claude: ['claude'], cursor: ['cursor-agent', 'agent'] };
function verifiedClaudePackage(executable) {
  const marker = `${path.sep}node_modules${path.sep}@anthropic-ai${path.sep}claude-code${path.sep}bin${path.sep}claude.exe`;
  if (!executable.endsWith(marker)) return null;
  const root = executable.slice(0, -`${path.sep}bin${path.sep}claude.exe`.length);
  try {
    const manifest = path.join(root, 'package.json');
    const stat = lstatSync(manifest);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return null;
    const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
    return parsed?.name === '@anthropic-ai/claude-code' && Version.safeParse(parsed.version).success
      ? parsed.version
      : null;
  } catch { return null; }
}

function safeProviderExecutable(candidate, provider) {
  try {
    const resolved = realpathSync(candidate), stat = statSync(resolved), uid = process.getuid?.();
    const claudePackage = provider === 'claude' ? verifiedClaudePackage(resolved) : null;
    return stat.isFile() && (provider === 'claude' ? Boolean(claudePackage) : stat.nlink === 1) && (stat.mode & 0o111) !== 0 && (stat.mode & 0o022) === 0 && (uid === undefined || stat.uid === 0 || stat.uid === uid) ? resolved : null;
  } catch { return null; }
}
function supportsClaudeSafeVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 198)));
}
function versionOf(executable) {
  const run = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024, env: safeEnv, shell: false });
  const text = `${run.stdout ?? ''}`.trim();
  if (run.error || run.status !== 0 || !Version.safeParse(text).success) throw new GraphError('PROVIDER_VERSION_UNAVAILABLE', 'CLI не вернул безопасную точную версию.');
  return text;
}
function supportsCursorSafeExecution(executable) {
  const run = spawnSync(executable, ['--help'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024, env: safeEnv, shell: false });
  const help = `${run.stdout ?? ''}`;
  if (run.error || run.status !== 0 || !['--print', '--output-format', '--sandbox', '--mode'].every((flag) => help.includes(flag)))
    throw new GraphError('PROVIDER_CAPABILITY_UNAVAILABLE', 'Cursor не поддерживает безопасный non-interactive режим Flowcairn.');
}
function hasExternalAuthentication(provider, executable) {
  const run = spawnSync(executable, provider === 'claude' ? ['auth', 'status'] : ['status'], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024,
    env: { ...safeEnv, ...(process.env.HOME ? { HOME: process.env.HOME } : {}) }, shell: false,
  });
  if (run.error || run.status !== 0) return false;
  if (provider !== 'claude') return true;
  try { return JSON.parse(`${run.stdout ?? ''}`).loggedIn === true; } catch { return false; }
}
/** @param {'claude'|'cursor'} provider @param {{executable?: string, env?: NodeJS.ProcessEnv}} [options] */
export function probeExternalProvider(provider, { executable, env = process.env } = {}) {
  const parsed = Provider.parse(provider);
  const candidates = executable ? [executable] : names[parsed].flatMap((name) => String(env.PATH ?? '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, name)));
  let reason = 'PROVIDER_CLI_UNAVAILABLE_OR_UNSAFE';
  for (const candidate of candidates) {
    const resolved = safeProviderExecutable(candidate, parsed);
    if (!resolved) continue;
    try {
      const version = versionOf(resolved), packageVersion = parsed === 'claude' ? verifiedClaudePackage(resolved) : null;
      if (parsed === 'claude' && (!packageVersion || !version.startsWith(packageVersion) || !supportsClaudeSafeVersion(packageVersion))) continue;
      if (parsed === 'cursor') supportsCursorSafeExecution(resolved);
      if (!hasExternalAuthentication(parsed, resolved)) { reason = 'PROVIDER_AUTH_REQUIRED'; continue; }
      return { available: true, executable: resolved, version };
    } catch { /* try next candidate */ }
  }
  return { available: false, reason };
}
export function providerToolchain(ai) {
  const provider = Provider.safeParse(ai.provider);
  if (!provider.success) return null;
  if (!ai.providerPath || !ai.providerVersion) throw new GraphError('PROVIDER_PIN_REQUIRED', 'Для Claude Code/Cursor нужны сохраненные путь и точная версия CLI. Повторите setup.');
  const probe = probeExternalProvider(provider.data, { executable: ai.providerPath });
  if (!probe.available) throw new GraphError('PROVIDER_TOOLCHAIN_INVALID', 'Выбранный CLI недоступен или небезопасен.');
  if (probe.version !== ai.providerVersion) throw new GraphError('PROVIDER_VERSION_DRIFT', 'Версия CLI изменилась. Подтвердите новую версию через flowcairn setup до передачи кода.');
  return Object.freeze({ provider: provider.data, executable: probe.executable, version: probe.version, digest: hashObject({ provider: provider.data, executable: probe.executable, version: probe.version }) });
}
export function makeExternalConsent({ provider, planHash, scopeHash, instructionsHash, skillsHash, artifactsHash, toolchain }) {
  return ExternalConsentSchema.parse({ version: 1, provider, planHash, scopeHash, instructionsHash, skillsHash, artifactsHash,
    transmitted: EXTERNAL_PROVIDER_CONSENT.transmitted, excluded: EXTERNAL_PROVIDER_CONSENT.excluded,
    cliPath: toolchain.executable, cliVersion: toolchain.version, createdAt: new Date().toISOString() });
}
export function consentHash(value) { return hashObject(ExternalConsentSchema.parse(value)); }
