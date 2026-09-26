import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readSync, readdirSync, copyFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.join(realpathSync(os.homedir()), '.flowcairn', 'runtime');
const selected = new Map();
const REGISTRY = 'https://registry.npmjs.org/';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SPECS = Object.freeze({
  codex: Object.freeze({ packageName: '@openai/codex', entry: 'bin/codex.js', help: ['exec', '--help'], secondary: ['sandbox', '--help'], required: ['--ignore-rules', '--skip-git-repo-check', '--json', '--strict-config', '--ephemeral', '--output-schema', '--output-last-message', '--cd', '--config', '--model'], secondaryRequired: ['--permission-profile'] }),
  claude: Object.freeze({ packageName: '@anthropic-ai/claude-code', entry: 'bin/claude.exe', help: ['--help'], required: ['--print', '--output-format', '--permission-mode', '--tools', '--strict-mcp-config', '--no-session-persistence', '--json-schema'] }),
});

function spec(provider) {
  const value = SPECS[provider];
  if (!value) throw new Error(`Unknown managed provider: ${provider}`);
  return value;
}

function versionParts(value) {
  const match = VERSION.exec(value ?? '');
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(left, right) {
  const a = versionParts(left), b = versionParts(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

function packageRoot(provider, root) { return path.join(root, 'node_modules', ...spec(provider).packageName.split('/')); }
function entryFor(provider, root) { return path.join(packageRoot(provider, root), spec(provider).entry); }
function providerRoot(provider, root = ROOT) { return path.join(root, provider); }
function statePath(provider, root = ROOT) { return path.join(providerRoot(provider, root), 'state.json'); }

function bundledEntry(provider) {
  try { return require.resolve(`${spec(provider).packageName}/${spec(provider).entry}`); }
  catch { return null; }
}

function safeDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== path.resolve(directory) ||
      (process.platform !== 'win32' && (stat.mode & 0o022)) ||
      (process.getuid && stat.uid !== process.getuid())) throw new Error('RUNTIME_UNSAFE_DIRECTORY');
}

function readState(provider, root) {
  try {
    const file = statePath(provider, root), stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 32768 ||
        (process.platform !== 'win32' && (stat.mode & 0o022))) return null;
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (value.schema !== 2 || !Number.isFinite(value.checkedAt)) return null;
    for (const key of ['active', 'previous']) if (value[key] != null &&
      (!VERSION.test(value[key].version) || !/^[a-f0-9-]{36}$/.test(value[key].id) || !/^[a-f0-9]{64}$/.test(value[key].digest))) return null;
    return value;
  } catch { return null; }
}

function writeState(provider, value, root) {
  const file = statePath(provider, root), temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify({ schema: 2, ...value }) + '\n', { flag: 'wx', mode: 0o600 });
  try { renameSync(temp, file); } finally { rmSync(temp, { force: true }); }
}

function packageDigest(directory) {
  const hash = createHash('sha256');
  function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
      if (name === '.bin') continue;
      const file = path.join(dir, name), stat = lstatSync(file);
      if (stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o022))) throw new Error('RUNTIME_UNSAFE_PACKAGE');
      hash.update(path.relative(directory, file) + '\0');
      if (stat.isDirectory()) walk(file);
      else {
        if (!stat.isFile() || stat.size > 1024 * 1024 * 1024) throw new Error('RUNTIME_UNSAFE_PACKAGE');
        const fd = openSync(file, 'r'), buffer = Buffer.alloc(1024 * 1024);
        try { let bytes; while ((bytes = readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, bytes)); }
        finally { closeSync(fd); }
      }
    }
  }
  walk(path.join(directory, 'node_modules')); return hash.digest('hex');
}

function recordEntry(provider, record, root) {
  if (!record) return null;
  const directory = path.join(providerRoot(provider, root), 'versions', record.id);
  try {
    if (realpathSync(directory) !== directory) return null;
    if (packageDigest(directory) !== record.digest) return null;
    const entry = entryFor(provider, directory);
    if (realpathSync(entry) !== entry || !statSync(entry).isFile()) return null;
    const manifest = JSON.parse(readFileSync(path.join(packageRoot(provider, directory), 'package.json'), 'utf8'));
    return manifest.name === spec(provider).packageName && manifest.version === record.version ? entry : null;
  } catch { return null; }
}

// Freeze the choice per process. Updates only change the pointer for new processes.
export function managedProviderExecutable(provider, root = ROOT) {
  if (!SPECS[provider]) return null;
  const key = `${root}:${provider}`;
  if (!selected.has(key)) {
    const state = readState(provider, root);
    selected.set(key, recordEntry(provider, state?.active, root) ?? recordEntry(provider, state?.previous, root) ?? bundledEntry(provider));
  }
  return selected.get(key);
}

function entryVersion(entry) {
  return JSON.parse(readFileSync(path.resolve(path.dirname(entry), '../package.json'), 'utf8')).version;
}

function npmScript() {
  const candidates = [
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function installExact(provider, version, target, spawnSyncImpl = spawnSync) {
  const script = npmScript();
  if (!script) throw new Error('NPM_RUNTIME_UNAVAILABLE');
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const scriptFlags = ['--ignore-scripts', '--registry', REGISTRY, '--userconfig', path.join(target, 'empty.npmrc'), '--globalconfig', path.join(target, 'global.npmrc'), '--cache', path.join(target, 'cache')];
  writeFileSync(path.join(target, 'empty.npmrc'), '', { flag: 'wx', mode: 0o600 });
  writeFileSync(path.join(target, 'global.npmrc'), '', { flag: 'wx', mode: 0o600 });
  const result = spawnSyncImpl(process.execPath, [script, 'install', '--prefix', target, ...scriptFlags, '--no-package-lock', '--no-audit', '--no-fund', '--omit=dev', `${spec(provider).packageName}@${version}`], {
    encoding: 'utf8', timeout: 120_000, maxBuffer: 512 * 1024, cwd: target, env: probeEnvironment(target), shell: false,
  });
  if (result.error || result.status !== 0) throw new Error('RUNTIME_INSTALL_FAILED');
  if (provider === 'claude') {
    const wrapper = path.join(packageRoot(provider, target), 'package.json');
    const report = process.platform === 'linux' ? process.report.getReport() : null;
    const musl = report && !Reflect.get(Reflect.get(report, 'header'), 'glibcVersionRuntime') ? '-musl' : '';
    const name = `@anthropic-ai/claude-code-${process.platform}-${process.arch}${musl}`;
    const manifest = createRequire(wrapper).resolve(`${name}/package.json`);
    const meta = JSON.parse(readFileSync(manifest, 'utf8'));
    if (meta.name !== name || meta.version !== version) throw new Error('RUNTIME_NATIVE_MISMATCH');
    copyFileSync(path.join(path.dirname(manifest), process.platform === 'win32' ? 'claude.exe' : 'claude'), entryFor(provider, target));
    chmodSync(entryFor(provider, target), 0o700);
  }
  return entryFor(provider, target);
}

function probeEnvironment(home) {
  return { PATH: path.dirname(process.execPath), HOME: home, USERPROFILE: home, CODEX_HOME: home, CLAUDE_CONFIG_DIR: home,
    DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', NO_COLOR: '1',
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, TEMP: home, TMP: home, APPDATA: home, LOCALAPPDATA: home } : {}) };
}

function verifyEntry(provider, entry, version, home, spawnSyncImpl = spawnSync) {
  const root = path.resolve(path.dirname(entry), '..');
  const manifestPath = path.join(root, 'package.json');
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); }
  catch { return false; }
  if (manifest.name !== spec(provider).packageName || manifest.version !== version || !statSync(entry).isFile()) return false;
  const args = spec(provider).help;
  const executable = provider === 'codex' ? process.execPath : entry;
  const actual = spawnSyncImpl(executable, provider === 'codex' ? [entry, '--version'] : ['--version'], { cwd: home, env: probeEnvironment(home), encoding: 'utf8', timeout: 10000, maxBuffer: 16384, shell: false });
  if (actual.error || actual.status !== 0 || `${actual.stdout ?? ''}`.trim() !== (provider === 'codex' ? `codex-cli ${version}` : `${version} (Claude Code)`)) return false;
  const commandArgs = provider === 'codex' ? [entry, ...args] : args;
  const result = spawnSyncImpl(executable, commandArgs, { encoding: 'utf8', timeout: 10_000, maxBuffer: 256 * 1024, cwd: home, env: probeEnvironment(home), shell: false });
  const output = `${result.stdout ?? ''}`;
  if (result.error !== undefined || result.status !== 0 || !spec(provider).required.every((flag) => output.includes(flag))) return false;
  if (!spec(provider).secondary) return true;
  const secondary = spawnSyncImpl(executable, provider === 'codex' ? [entry, ...spec(provider).secondary] : spec(provider).secondary, { encoding: 'utf8', timeout: 10_000, maxBuffer: 256 * 1024, cwd: home, env: probeEnvironment(home), shell: false });
  return secondary.error === undefined && secondary.status === 0 && spec(provider).secondaryRequired.every((flag) => `${secondary.stdout ?? ''}`.includes(flag));
}

async function registryLatest(provider, fetcher) {
  const response = await fetcher(`${REGISTRY}${encodeURIComponent(spec(provider).packageName)}/latest`, { redirect: 'error', signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error('RUNTIME_REGISTRY_UNAVAILABLE');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('RUNTIME_REGISTRY_INVALID');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > 256 * 1024) throw new Error('RUNTIME_METADATA_LIMIT');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (data.name !== spec(provider).packageName || !VERSION.test(data.version)) throw new Error('RUNTIME_REGISTRY_INVALID');
  return data.version;
}

/** Serialized updates with an atomic JSON pointer; installed versions are never overwritten. */
export async function ensureManagedRuntime(provider, { fetcher = fetch, spawnSyncImpl = spawnSync, now = Date.now, autoUpdate = true, runtimeRoot = ROOT } = {}) {
  const baseEntry = managedProviderExecutable(provider, runtimeRoot);
  if (!baseEntry) return { available: false, provider, reason: 'RUNTIME_BUNDLED_PACKAGE_MISSING' };
  const currentVersion = entryVersion(baseEntry);
  const fallback = { available: true, provider, executable: baseEntry, version: currentVersion, updated: false };
  if (!autoUpdate) return fallback;
  let state = readState(provider, runtimeRoot);
  if (state && now() - state.checkedAt < CHECK_INTERVAL_MS) return fallback;
  const directory = providerRoot(provider, runtimeRoot), lock = path.join(directory, 'update.lock');
  try { safeDirectory(runtimeRoot); safeDirectory(directory); mkdirSync(lock, { mode: 0o700 }); }
  catch { return { ...fallback, updateError: 'RUNTIME_BUSY_OR_STATE_UNAVAILABLE' }; }
  try {
    state = readState(provider, runtimeRoot);
    if (state && now() - state.checkedAt < CHECK_INTERVAL_MS) return fallback;
    let latest;
    try { latest = await registryLatest(provider, fetcher); }
    catch {
      writeState(provider, { ...state, checkedAt: now(), lastError: 'RUNTIME_REGISTRY_UNAVAILABLE' }, runtimeRoot);
      return { ...fallback, updateError: 'RUNTIME_REGISTRY_UNAVAILABLE' };
    }
    const activeVersion = state?.active?.version ?? currentVersion;
    if (compareVersions(latest, activeVersion) <= 0) {
      writeState(provider, { ...state, checkedAt: now() }, runtimeRoot);
      return fallback;
    }
    const id = randomUUID(), versions = path.join(directory, 'versions');
    safeDirectory(versions);
    const target = path.join(versions, id);
    try {
      const entry = installExact(provider, latest, target, spawnSyncImpl);
      if (!verifyEntry(provider, entry, latest, target, spawnSyncImpl)) throw new Error('RUNTIME_CANDIDATE_INVALID');
      writeState(provider, { checkedAt: now(), active: { id, version: latest, digest: packageDigest(target) }, previous: state?.active ?? null }, runtimeRoot);
      return { ...fallback, updated: true, nextVersion: latest };
    } catch {
      writeState(provider, { ...state, checkedAt: now(), lastError: 'RUNTIME_CANDIDATE_INVALID' }, runtimeRoot);
      return { ...fallback, updateError: 'RUNTIME_CANDIDATE_INVALID' };
    }
  } catch { return { ...fallback, updateError: 'RUNTIME_STATE_UNAVAILABLE' }; }
  finally { rmSync(lock, { recursive: true, force: true }); }
}

export function rollbackManagedRuntime(provider, runtimeRoot = ROOT) {
  const directory = providerRoot(provider, runtimeRoot), lock = path.join(directory, 'update.lock');
  safeDirectory(runtimeRoot); safeDirectory(directory); mkdirSync(lock, { mode: 0o700 });
  try {
    const state = readState(provider, runtimeRoot);
    if (!state?.active) return { rolledBack: false };
    writeState(provider, { checkedAt: Date.now(), active: state.previous ?? null, previous: null }, runtimeRoot);
    return { rolledBack: true };
  } finally { rmSync(lock, { recursive: true, force: true }); }
}
