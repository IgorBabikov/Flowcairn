import { opendirSync } from 'node:fs';
import path from 'node:path';
import { lstatHostSync, realpathHostSync, sameHostPath } from './host-filesystem.mjs';
import { GraphError } from './io.mjs';
import { safeContextPath } from './project-context.mjs';

// Only classification manifests are inventoried. JavaScript packages retain the
// installer workspace inventory (including its explicit workspace exclusions).
const NAMES = new Set(['pyproject.toml', 'pubspec.yaml', 'build.gradle', 'build.gradle.kts',
  'Package.swift', 'requirements.txt', 'go.mod', 'pom.xml', 'composer.json']);
const EXCLUDED = new Set(['node_modules', 'vendor', 'pods', 'carthage', 'deriveddata',
  'build', 'dist', 'out', 'output', 'artifacts', 'target', 'bin', 'obj', 'coverage',
  'venv', '__pycache__', 'generated', 'third_party', 'third-party', 'tests', 'test',
  '__tests__', 'fixtures', 'examples', 'samples', 'docs', 'private']);
const LIMITS = Object.freeze({ scopes: 64, depth: 8, directories: 1024, entries: 16384, manifests: 256 });
const fail = (code, message) => { throw new GraphError(code, message); };
const sorted = (values) => [...new Set(values)].sort();
const join = (directory, name) => directory === '.' ? name : `${directory}/${name}`;
const excluded = (name) => name.startsWith('.') || EXCLUDED.has(name.toLowerCase());

function inspect(root, relative, optional = false) {
  if (relative !== '.') safeContextPath(relative);
  let current = root, result;
  const parts = relative === '.' ? [] : relative.split('/');
  for (let index = -1; index < parts.length; index++) {
    if (index >= 0) current = path.join(current, parts[index]);
    try { result = lstatHostSync(current); } catch (error) {
      if (optional && error.code === 'ENOENT') return null;
      fail('STACK_PROFILE_FILE', 'Каталог inventory недоступен');
    }
    if (result.isSymbolicLink() || (index < parts.length - 1 && !result.isDirectory()))
      fail('CONTEXT_LINK_UNSAFE', 'Inventory содержит ссылку или неоднозначный путь');
    let physical;
    try { physical = realpathHostSync(current); } catch { fail('STACK_PROFILE_FILE', 'Каталог inventory изменился'); }
    if (!sameHostPath(physical, current)) fail('CONTEXT_LINK_UNSAFE', 'Каталог inventory содержит ссылку');
  }
  return { absolute: current, stat: result };
}

/** Bounded static directory inventory, within the caller's consented task scope.
 * Files use only their names here; content reads remain in readContextFile. Never
 * evaluate Gradle/Swift/MSBuild/Python config, imports, project tests or hooks.
 * Missing scopes inspect ancestor native filenames without scanning siblings.
 * Excluded trees need explicit manifest paths; bounds fail closed rather than
 * silently presenting a truncated inventory as a complete project stack.
 */
export function discoverScopedStackManifests(root, { scope = ['.'] } = {}) {
  if (!Array.isArray(scope) || !scope.length || scope.length > LIMITS.scopes)
    fail('STACK_PROFILE_LIMIT', 'Некорректный объем scope inventory');
  const scopes = sorted(scope.map((entry) => safeContextPath(typeof entry === 'string' ? entry.replace(/\/$/, '') : entry, true)));
  if (scopes.some((entry) => entry.length > 4096 || entry.split('/').length > 64))
    fail('STACK_PROFILE_LIMIT', 'Слишком длинный путь inventory');
  const rootStat = lstatHostSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('CONTEXT_ROOT_UNSAFE', 'Нужен обычный корень inventory');
  const canonical = realpathHostSync(root);
  const manifests = new Set(), directories = new Map(), recursive = new Set();
  let entryCount = 0;
  const add = (file) => {
    safeContextPath(file);
    manifests.add(file);
    if (manifests.size > LIMITS.manifests) fail('STACK_PROFILE_LIMIT', 'Слишком много manifests inventory');
  };
  const list = (directory) => {
    if (directories.has(directory)) return directories.get(directory);
    if (directories.size >= LIMITS.directories) fail('STACK_PROFILE_LIMIT', 'Слишком много каталогов inventory');
    const before = inspect(canonical, directory, true);
    if (!before) { directories.set(directory, []); return []; }
    if (!before.stat.isDirectory()) fail('CONTEXT_SCOPE_UNKNOWN', 'Inventory scope должен быть каталогом');
    const entries = [];
    let opened;
    try {
      opened = opendirSync(before.absolute);
      for (;;) {
        const entry = opened.readSync();
        if (!entry) break;
        if (++entryCount > LIMITS.entries) fail('STACK_PROFILE_LIMIT', 'Слишком много entries inventory');
        entries.push(entry);
      }
    } catch (error) {
      if (error instanceof GraphError) throw error;
      fail('STACK_PROFILE_FILE', 'Не удалось прочитать каталог inventory');
    } finally { opened?.closeSync(); }
    const after = inspect(canonical, directory);
    if (before.stat.dev !== after.stat.dev || before.stat.ino !== after.stat.ino ||
      before.stat.mtimeMs !== after.stat.mtimeMs || before.stat.ctimeMs !== after.stat.ctimeMs)
      fail('STACK_PROFILE_DRIFT', 'Каталог inventory изменился во время discovery');
    entries.sort((a, b) => a.name.localeCompare(b.name));
    directories.set(directory, entries);
    return entries;
  };
  const native = (directory, entries) => {
    for (const entry of entries) {
      if (excluded(entry.name)) continue;
      if (/\.csproj$/i.test(entry.name)) add(join(directory, entry.name));
      if (/\.xcodeproj$/i.test(entry.name) && entry.isDirectory() && !entry.isSymbolicLink()) {
        const project = join(directory, entry.name);
        if (list(project).some((child) => child.name === 'project.pbxproj')) add(`${project}/project.pbxproj`);
      }
    }
  };
  const scan = (directory, depth) => {
    if (recursive.has(directory)) return;
    recursive.add(directory);
    const entries = list(directory);
    native(directory, entries);
    for (const entry of entries) {
      if (excluded(entry.name)) continue;
      const relative = join(directory, entry.name);
      // Path policy is authoritative; unsafe automatic names are never read.
      try { safeContextPath(relative); } catch (error) {
        if (error.code === 'CONTEXT_PATH_UNSAFE') continue;
        throw error;
      }
      if (NAMES.has(entry.name)) add(relative);
      if (!entry.isDirectory() || entry.isSymbolicLink() || /\.xcodeproj$/i.test(entry.name)) continue;
      if (depth >= LIMITS.depth) fail('STACK_PROFILE_LIMIT', 'Inventory глубже безопасного предела; нужен более узкий scope');
      scan(relative, depth + 1);
    }
  };
  for (const entry of scopes) {
    const scoped = inspect(canonical, entry, true);
    if (scoped?.stat.isDirectory() && (entry === '.' || !entry.split('/').some(excluded))) scan(entry, 0);
    let directory = scoped?.stat.isDirectory() ? entry : path.posix.dirname(entry);
    for (;;) {
      // Only direct native project filenames in ancestors, never siblings' trees.
      if (directory === '.' || !directory.split('/').some(excluded)) native(directory, list(directory));
      if (directory === '.') break;
      directory = path.posix.dirname(directory);
    }
  }
  return { manifestPaths: sorted(manifests), limitations: ['bounded-static-manifest-inventory',
    'excluded-trees-require-explicit-manifest-paths', 'javascript-packages-use-declared-workspace-inventory'] };
}
