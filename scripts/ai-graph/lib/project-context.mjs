import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, opendirSync } from 'node:fs';
import path from 'node:path';
import { GraphError, hashObject, sha256 } from './io.mjs';

const MAX_FILE_BYTES = 64 * 1024;
const MAX_FILES = 128;
const MAX_DISCOVERY_BYTES = 512 * 1024;
const fail = (code, message) => { throw new GraphError(code, message); };
const within = (file, directory) => directory === '.' || file === directory || file.startsWith(`${directory}/`);
const overlaps = (a, b) => within(a, b) || within(b, a);
const sorted = (values) => [...new Set(values)].sort();

/** No arbitrary paths, globals, credentials, generated trees or executable config reads. */
export function safeContextPath(value, allowRoot = false) {
  if (allowRoot && value === '.') return value;
  if (typeof value !== 'string' || value.length > 512 || !value || /[\\<>"&]/.test(value) || [...value].some((char) => char.charCodeAt(0) < 32) || path.posix.isAbsolute(value) || /^[a-z]:/i.test(value))
    fail('CONTEXT_PATH_UNSAFE', 'Ожидался безопасный относительный путь проекта');
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part !== part.trim() ||
    /^(?:\.git|\.ai-orchestrator|node_modules|\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.ssh|\.aws|\.azure|\.config|credentials(?:\.json)?|id_rsa|id_ed25519)$/i.test(part) ||
    /\.(?:pem|key|p12|pfx)$/i.test(part) || /(?:^|[._-])secrets?(?:[._-](?:json|ya?ml|toml|txt))?$/i.test(part)))
    fail('CONTEXT_PATH_UNSAFE', 'Запрещенный путь контекста');
  return value;
}

function canonicalRoot(root) {
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('CONTEXT_ROOT_UNSAFE', 'Ожидался обычный корень проекта');
  return realpathSync(root);
}

function inspectPath(root, relative, optional = false) {
  safeContextPath(relative);
  let current = root;
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = lstatSync(current); } catch (error) {
      if (optional && error.code === 'ENOENT') return null;
      fail('CONTEXT_FILE_MISSING', 'Обязательный файл контекста недоступен');
    }
    if (stat.isSymbolicLink() || (i < parts.length - 1 && !stat.isDirectory()))
      fail('CONTEXT_LINK_UNSAFE', 'Ссылки и неоднозначные пути контекста запрещены');
    if (realpathSync(current) !== path.join(root, ...parts.slice(0, i + 1)))
      fail('CONTEXT_LINK_UNSAFE', 'Путь контекста изменился');
    if (i === parts.length - 1) return { file: current, stat };
  }
}

/** Bounded descriptor read; metadata is revalidated before and after the read. */
export function readContextFile(root, relative, { maxBytes = MAX_FILE_BYTES, optional = false } = {}) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_FILE_BYTES) fail('CONTEXT_LIMIT', 'Некорректный предел чтения');
  const canonical = canonicalRoot(root);
  const inspected = inspectPath(canonical, relative, optional);
  if (!inspected) return null;
  const { file, stat } = inspected;
  if (!stat.isFile() || stat.nlink !== 1) fail('CONTEXT_FILE_UNSAFE', 'Контекст должен быть обычным файлом без hardlinks');
  if (stat.size > maxBytes) fail('CONTEXT_LIMIT', 'Файл контекста превышает лимит');
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.ino !== stat.ino || before.dev !== stat.dev || before.size > maxBytes)
      fail('CONTEXT_FILE_CHANGED', 'Файл контекста изменился до чтения');
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > maxBytes) fail('CONTEXT_LIMIT', 'Файл контекста превышает лимит');
    const after = fstatSync(fd), live = inspectPath(canonical, relative).stat;
    if ([after, live].some((s) => s.ino !== before.ino || s.dev !== before.dev || s.size !== before.size || s.mtimeMs !== before.mtimeMs || s.ctimeMs !== before.ctimeMs || s.nlink !== 1) || length !== before.size)
      fail('CONTEXT_FILE_CHANGED', 'Файл контекста изменился во время чтения');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length)); }
    catch { fail('CONTEXT_ENCODING', 'Контекст должен быть UTF-8'); }
    return { path: relative, hash: sha256(text), text };
  } finally { if (fd !== undefined) closeSync(fd); }
}

function checkedScope(root, scope) {
  if (!Array.isArray(scope) || !scope.length || scope.length > 32) fail('CONTEXT_SCOPE_INVALID', 'Нужен ограниченный scope узла');
  return sorted(scope.map((entry) => {
    const safe = safeContextPath(entry, true);
    if (safe !== '.') {
      // New files are allowed only below a real parent. Existing aliases are always rejected.
      const result = inspectPath(root, safe, true);
      if (!result) {
        const parent = path.posix.dirname(safe);
        if (parent !== '.' && !inspectPath(root, parent, true)?.stat.isDirectory())
          fail('CONTEXT_SCOPE_UNKNOWN', 'Scope не имеет существующего родительского каталога');
      }
    }
    return safe;
  }));
}

function packageDomains(data) {
  const names = new Set();
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const deps = data[field];
    if (deps !== undefined && (!deps || typeof deps !== 'object' || Array.isArray(deps)))
      fail('CONTEXT_MANIFEST_INVALID', 'Некорректная структура package.json');
    for (const name of Object.keys(deps ?? {})) names.add(name);
  }
  const mobile = names.has('react-native') || names.has('expo');
  const frontend = ['react-dom', 'next', 'vue', 'nuxt', '@angular/core', 'svelte', '@sveltejs/kit', 'solid-js', 'preact', 'astro'].some((name) => names.has(name)) || (names.has('react') && !mobile);
  const backend = ['express', 'fastify', '@nestjs/core', 'koa', 'hono', '@hapi/hapi', 'restify'].some((name) => names.has(name));
  return [frontend && 'frontend', backend && 'backend', mobile && 'mobile'].filter(Boolean);
}

function jsonManifest(text) {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { fail('CONTEXT_MANIFEST_INVALID', 'Некорректный JSON manifest'); }
}

/**
 * Inspect only known manifest names, ancestors of node scope, and declared npm workspace roots.
 * Unsupported ecosystems remain engineering; callers can supply exact additional manifest paths.
 * The result contains hashes and classifications, never raw manifest data or absolute paths.
 */
export function discoverProjectContext(root, { scope = ['.'], manifestPaths = [] } = {}) {
  const canonical = canonicalRoot(root), scopes = checkedScope(canonical, scope);
  if (!Array.isArray(manifestPaths) || manifestPaths.length > 32) fail('CONTEXT_LIMIT', 'Слишком много manifests');
  const declared = sorted(manifestPaths.map((file) => safeContextPath(file)));
  const candidates = new Set();
  const packages = [], evidence = [];
  let totalBytes = 0;
  const add = (file) => {
    if (!['package.json', 'pubspec.yaml'].includes(path.posix.basename(file))) return;
    candidates.add(file);
    if (candidates.size > MAX_FILES) fail('CONTEXT_LIMIT', 'Discovery превышает предел файлов');
  };
  for (const file of declared) {
    if (scopes.some((s) => overlaps(s, path.posix.dirname(file)))) add(file);
  }
  for (const entry of scopes) {
    let directory = entry;
    if (entry !== '.' && !inspectPath(canonical, entry, true)?.stat.isDirectory()) directory = path.posix.dirname(entry);
    for (;;) {
      for (const name of ['package.json', 'pubspec.yaml']) add(directory === '.' ? name : `${directory}/${name}`);
      if (directory === '.') break;
      directory = path.posix.dirname(directory);
    }
  }
  const process = (file) => {
    const loaded = readContextFile(canonical, file, { optional: !declared.includes(file) });
    evidence.push({ path: file, hash: loaded?.hash ?? null });
    if (!loaded) return null;
    totalBytes += Buffer.byteLength(loaded.text);
    if (totalBytes > MAX_DISCOVERY_BYTES) fail('CONTEXT_LIMIT', 'Discovery превышает предел контекста');
    const directory = path.posix.dirname(file);
    const data = file.endsWith('package.json') ? jsonManifest(loaded.text) : null;
    const domains = data ? packageDomains(data) : (/^\s*flutter:\s*(?:#.*)?\r?\n\s+sdk:\s*flutter\s*$/m.test(loaded.text) ? ['mobile'] : []);
    packages.push({ path: file, scope: directory, domains: domains.length ? domains : ['engineering'] });
    return data;
  };
  // Workspace declarations are data only. We deliberately support literal paths and one-level *.
  const processed = new Set();
  for (const file of candidates) {
    if (processed.has(file)) continue;
    processed.add(file);
    const data = process(file);
    if (!data?.workspaces) continue;
    const workspaces = Array.isArray(data.workspaces) ? data.workspaces : data.workspaces.packages;
    if (!Array.isArray(workspaces) || workspaces.length > 32) fail('CONTEXT_MANIFEST_INVALID', 'Некорректный workspace manifest');
    for (const pattern of workspaces) {
      if (typeof pattern !== 'string' || !pattern || /[!{}[\]?]/.test(pattern) || pattern.includes('**') || (pattern.match(/\*/g) ?? []).length > 1 || (pattern.includes('*') && !pattern.endsWith('/*')))
        fail('CONTEXT_WORKSPACE_UNSUPPORTED', 'Укажите точные manifestPaths для сложных workspace patterns');
      const base = path.posix.dirname(file);
      const local = pattern.endsWith('/*') ? pattern.slice(0, -2) : pattern;
      safeContextPath(local);
      const directory = base === '.' ? local : `${base}/${local}`;
      if (!scopes.some((s) => overlaps(s, directory))) continue;
      if (!pattern.includes('*')) { add(`${directory}/package.json`); continue; }
      const inspected = inspectPath(canonical, directory, true);
      if (!inspected) continue;
      if (!inspected.stat.isDirectory()) fail('CONTEXT_MANIFEST_INVALID', 'Workspace должен быть каталогом');
      // Directory enumeration is bounded too; no recursive source scan.
      const handle = opendirSync(inspected.file);
      let count = 0;
      try {
        for (let child = handle.readSync(); child; child = handle.readSync()) {
          if (++count > MAX_FILES) fail('CONTEXT_LIMIT', 'Workspace directory превышает предел discovery');
          const workspace = `${directory}/${child.name}`;
          if (!scopes.some((s) => overlaps(s, workspace))) continue;
          if (child.isSymbolicLink()) fail('CONTEXT_LINK_UNSAFE', 'Workspace symlink запрещен');
          if (child.isDirectory()) add(`${workspace}/package.json`);
        }
      } finally { handle.closeSync(); }
    }
  }
  const relevant = packages.filter((pkg) => scopes.some((s) => {
    if (within(pkg.scope, s)) return true;
    if (!within(s, pkg.scope)) return false;
    return !packages.some((other) => other.scope !== pkg.scope && within(other.scope, pkg.scope) && within(s, other.scope));
  }));
  const domains = sorted(relevant.flatMap((pkg) => pkg.domains));
  const body = {
    version: 1, scope: scopes, manifestPaths: declared,
    evidence: evidence.sort((a, b) => a.path.localeCompare(b.path)),
    packages: relevant.sort((a, b) => a.path.localeCompare(b.path)),
    domains: domains.length ? domains : ['engineering'],
  };
  return { ...body, hash: hashObject(body) };
}

/** Re-discovery catches changed, removed and newly appearing mandatory classification evidence. */
export function verifyProjectContext(root, context) {
  if (!context || context.version !== 1 || typeof context.hash !== 'string') fail('CONTEXT_INVALID', 'Неизвестный manifest контекста');
  const { hash, ...body } = context;
  if (hashObject(body) !== hash) fail('CONTEXT_DRIFT', 'Manifest контекста изменился');
  const current = discoverProjectContext(root, { scope: context.scope, manifestPaths: context.manifestPaths });
  if (current.hash !== hash) fail('CONTEXT_DRIFT', 'Файлы project context изменились; нужен новый plan');
  return current;
}
