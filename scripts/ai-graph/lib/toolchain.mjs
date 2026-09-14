import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { GraphError, hashObject, sha256 } from './io.mjs';
import { loadProjectProfile, packageManagerLock, validatePackageManagerProject } from './project.mjs';

const VERSION = 1;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

function fail(code, message, details) {
  throw new GraphError(code, message, details);
}

function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function existsNoFollow(candidate) {
  try {
    lstatSync(candidate);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function physicalDirectory(directory, code, label) {
  let stat;
  try {
    stat = lstatSync(directory);
  } catch {
    fail(code, `${label} не найден: ${directory}`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(code, `${label} должен быть физической директорией: ${directory}`);
  }
  return realpathSync(directory);
}

function context(root, worktree) {
  const canonicalRoot = physicalDirectory(root, 'INVALID_TOOLCHAIN_ROOT', 'root');
  const canonicalWorktree = physicalDirectory(worktree, 'INVALID_TOOLCHAIN_WORKTREE', 'worktree');
  const worktreesRoot = path.join(canonicalRoot, '.ai-orchestrator', 'worktrees');
  if (canonicalWorktree === canonicalRoot || !inside(worktreesRoot, canonicalWorktree)) {
    fail(
      'INVALID_TOOLCHAIN_WORKTREE',
      'worktree должен находиться в canonical .ai-orchestrator/worktrees',
    );
  }
  const candidate = path.join(canonicalRoot, 'node_modules');
  if (existsNoFollow(candidate))
    physicalDirectory(candidate, 'TOOLCHAIN_UNAVAILABLE', 'canonical node_modules');
  const ctx = {
    root: canonicalRoot,
    worktree: canonicalWorktree,
    profile: loadProjectProfile(canonicalRoot),
  };
  const dependencyPaths = workspaceDependencyPaths(ctx);
  const readRoots = dependencyPaths.map((relative) => realpathSync(path.join(ctx.root, relative)));
  return { ...ctx, dependencyPaths, readRoots };
}

function safeRelative(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    path.isAbsolute(value) ||
    value.includes('\\') ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    fail('INVALID_TOOLCHAIN_MANIFEST', `Недопустимый dependency path: ${String(value)}`);
  }
  return value;
}

function workspaceDependencyPaths({ root, profile }) {
  const paths = [];
  for (const manifest of profile.manifests.filter(
    (value) => path.basename(value) === 'package.json',
  )) {
    const relative = path.posix.join(path.posix.dirname(manifest), 'node_modules');
    const source = path.join(root, relative);
    if (!existsNoFollow(source)) continue;
    assertPhysicalAncestors(root, path.dirname(source));
    physicalDirectory(source, 'UNSAFE_TOOLCHAIN_SOURCE', 'dependency directory');
    paths.push(relative);
  }
  return [...new Set(paths)].sort();
}

function assertPhysicalAncestors(root, directory) {
  if (!inside(root, directory)) fail('UNSAFE_TOOLCHAIN_TARGET', 'Target выходит из worktree');
  const relative = path.relative(root, directory);
  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if (!existsNoFollow(current)) continue;
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail('UNSAFE_TOOLCHAIN_TARGET', `Target ancestor должен быть директорией: ${current}`);
    }
  }
}

function ensureDirectory(root, directory) {
  assertPhysicalAncestors(root, path.dirname(directory));
  const created = !existsNoFollow(directory);
  if (created) mkdirSync(directory, { mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail('UNSAFE_TOOLCHAIN_TARGET', `Projection directory недопустима: ${directory}`);
  }
  if (created) chmodSync(directory, 0o700);
  else if ((stat.mode & 0o777) !== 0o700) {
    fail('TOOLCHAIN_DRIFT', `Projection directory mode изменен: ${directory}`);
  }
}

function mappedTarget(source, ctx) {
  let resolved;
  try {
    resolved = realpathSync(source);
  } catch {
    fail('UNSAFE_TOOLCHAIN_SOURCE', `Dependency link поврежден: ${source}`);
  }
  if (ctx.readRoots.some((root) => inside(root, resolved))) return resolved;
  if (!inside(ctx.root, resolved)) {
    fail('UNSAFE_TOOLCHAIN_SOURCE', `Dependency выходит из canonical root: ${source}`);
  }
  const relative = path.relative(ctx.root, resolved);
  if (
    relative.split(path.sep).some((part) => ['.git', '.ai-orchestrator', 'node_modules'].includes(part)) ||
    !existsSync(path.join(ctx.worktree, relative))
  ) {
    fail('UNSAFE_TOOLCHAIN_SOURCE', `Workspace dependency нельзя remap: ${source}`);
  }
  const projected = path.join(ctx.worktree, relative);
  const projectedStat = lstatSync(projected);
  if (projectedStat.isSymbolicLink() || realpathSync(projected) !== projected) {
    fail('UNSAFE_TOOLCHAIN_TARGET', `Workspace dependency target недопустим: ${projected}`);
  }
  return projected;
}

function desiredForDirectory(relativeNodeModules, ctx) {
  const sourceDirectory = path.join(ctx.root, relativeNodeModules);
  const targetDirectory = path.join(ctx.worktree, relativeNodeModules);
  const entries = [];

  function addDirectory(relative) {
    entries.push({ kind: 'directory', path: relative, mode: 0o700 });
  }

  function addLink(source, relative) {
    const target = mappedTarget(source, ctx);
    entries.push({
      kind: 'symlink',
      path: relative,
      target,
      identity: inside(ctx.worktree, target)
        ? `$WORKTREE/${path.relative(ctx.worktree, target).split(path.sep).join('/')}`
        : target,
    });
  }

  function addBin(source, relative) {
    const stat = lstatSync(source);
    if (stat.isSymbolicLink()) return addLink(source, relative);
    if (!stat.isFile()) fail('UNSAFE_TOOLCHAIN_SOURCE', `.bin entry недопустим: ${source}`);
    const body = readFileSync(source);
    entries.push({ kind: 'file', path: relative, mode: 0o500, hash: sha256(body), body });
  }

  addDirectory(relativeNodeModules);
  for (const name of readdirSync(sourceDirectory).sort()) {
    if (name.startsWith('.') && name !== '.bin' && name !== '.pnpm') continue;
    const source = path.join(sourceDirectory, name);
    const relative = `${relativeNodeModules}/${name}`;
    const stat = lstatSync(source);
    if (name === '.bin') {
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        fail('UNSAFE_TOOLCHAIN_SOURCE', '.bin должен быть физической директорией');
      }
      addDirectory(relative);
      for (const executable of readdirSync(source).sort()) {
        addBin(path.join(source, executable), `${relative}/${executable}`);
      }
    } else if (name === '.pnpm') {
      if (relativeNodeModules !== 'node_modules' || !stat.isDirectory() || stat.isSymbolicLink()) {
        fail('UNSAFE_TOOLCHAIN_SOURCE', '.pnpm допустим только в root node_modules');
      }
      addLink(source, relative);
    } else if (name.startsWith('@') && stat.isDirectory() && !stat.isSymbolicLink()) {
      addDirectory(relative);
      for (const packageName of readdirSync(source).sort()) {
        addLink(path.join(source, packageName), `${relative}/${packageName}`);
      }
    } else if (stat.isDirectory() || stat.isSymbolicLink()) {
      addLink(source, relative);
    } else if (!stat.isFile()) {
      fail('UNSAFE_TOOLCHAIN_SOURCE', `Dependency entry недопустим: ${source}`);
    }
  }
  return { sourceDirectory, targetDirectory, entries };
}

function description(ctx) {
  validatePackageManagerProject(ctx.root, ctx.profile.packageManager);
  const dependencyPaths = ctx.dependencyPaths;
  const groups = dependencyPaths.map((relative) => desiredForDirectory(relative, ctx));
  const lockfile = path.join(
    ctx.root,
    packageManagerLock(ctx.profile.packageManager),
  );
  if (!existsSync(lockfile)) fail('TOOLCHAIN_UNAVAILABLE', 'Lockfile не найден');
  const lockStat = lstatSync(lockfile);
  if (
    !lockStat.isFile() ||
    lockStat.isSymbolicLink() ||
    lockStat.nlink !== 1 ||
    lockStat.size > 16 * 1024 * 1024
  )
    fail('UNSAFE_TOOLCHAIN_SOURCE', 'Lockfile небезопасен');
  const records = groups.flatMap((group) =>
    group.entries.map((entry) => {
      if (entry.kind === 'file') {
        return { kind: entry.kind, path: entry.path, mode: entry.mode, hash: entry.hash };
      }
      if (entry.kind === 'symlink') {
        return { kind: entry.kind, path: entry.path, target: entry.identity };
      }
      return entry;
    }),
  );
  const readRoots = ctx.readRoots;
  const identity = {
    version: VERSION,
    profileHash: hashObject(ctx.profile),
    lockfileHash: sha256(readFileSync(lockfile)),
    dependencyPaths,
    readRoots,
    records,
  };
  return { dependencyPaths, readRoots, hash: hashObject(identity), groups };
}

function materializeEntry(entry, ctx) {
  const target = path.join(ctx.worktree, entry.path);
  assertPhysicalAncestors(ctx.worktree, path.dirname(target));
  if (entry.kind === 'directory') {
    ensureDirectory(ctx.worktree, target);
    return;
  }
  ensureDirectory(ctx.worktree, path.dirname(target));
  if (!existsNoFollow(target)) {
    if (entry.kind === 'symlink') symlinkSync(entry.target, target);
    else {
      writeFileSync(target, entry.body, { flag: 'wx', mode: entry.mode });
      chmodSync(target, entry.mode);
    }
  }
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail('INVALID_TOOLCHAIN_MANIFEST', 'Toolchain manifest должен быть объектом');
  }
  const keys = Object.keys(manifest).sort();
  if (keys.join(',') !== 'dependencyPaths,hash,readRoots') {
    fail('INVALID_TOOLCHAIN_MANIFEST', 'Toolchain manifest содержит недопустимые поля');
  }
  if (
    !Array.isArray(manifest.dependencyPaths) ||
    !Array.isArray(manifest.readRoots) ||
    !HASH_PATTERN.test(manifest.hash)
  ) {
    fail('INVALID_TOOLCHAIN_MANIFEST', 'Toolchain manifest недопустим');
  }
  manifest.dependencyPaths.forEach(safeRelative);
  if (manifest.readRoots.some((value) => typeof value !== 'string' || !path.isAbsolute(value))) {
    fail('INVALID_TOOLCHAIN_MANIFEST', 'readRoots должны быть absolute paths');
  }
}

function verifyProjection(descriptionValue, ctx) {
  const allowed = new Map();
  for (const group of descriptionValue.groups) {
    for (const entry of group.entries) allowed.set(entry.path, entry);
  }
  for (const group of descriptionValue.groups) {
    for (const entry of group.entries) {
      const target = path.join(ctx.worktree, entry.path);
      if (!existsNoFollow(target))
        fail('TOOLCHAIN_DRIFT', `Projection entry отсутствует: ${entry.path}`);
      const stat = lstatSync(target);
      if (entry.kind === 'directory') {
        if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== entry.mode) {
          fail('TOOLCHAIN_DRIFT', `Projection directory изменилась: ${entry.path}`);
        }
        for (const name of readdirSync(target)) {
          const child = `${entry.path}/${name}`;
          if (!allowed.has(child)) fail('TOOLCHAIN_DRIFT', `Лишний projection entry: ${child}`);
        }
      } else if (entry.kind === 'symlink') {
        if (!stat.isSymbolicLink() || readlinkSync(target) !== entry.target) {
          fail('TOOLCHAIN_DRIFT', `Dependency link изменен: ${entry.path}`);
        }
        let resolved;
        try {
          resolved = realpathSync(target);
        } catch {
          fail('TOOLCHAIN_DRIFT', `Dependency link поврежден: ${entry.path}`);
        }
        if (resolved !== realpathSync(entry.target)) {
          fail('TOOLCHAIN_DRIFT', `Dependency link сменил target: ${entry.path}`);
        }
      } else if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        (stat.mode & 0o777) !== entry.mode ||
        sha256(readFileSync(target)) !== entry.hash
      ) {
        fail('TOOLCHAIN_DRIFT', `.bin wrapper изменен: ${entry.path}`);
      }
    }
  }
}

export function prepareToolchain({ root, worktree }) {
  const ctx = context(root, worktree);
  const desired = description(ctx);
  for (const group of desired.groups) {
    for (const entry of group.entries) materializeEntry(entry, ctx);
  }
  const manifest = {
    dependencyPaths: desired.dependencyPaths,
    readRoots: desired.readRoots,
    hash: desired.hash,
  };
  return verifyToolchain({ root, worktree, manifest });
}

export function verifyToolchain({ root, worktree, manifest }) {
  validateManifest(manifest);
  const ctx = context(root, worktree);
  const desired = description(ctx);
  const expected = {
    dependencyPaths: desired.dependencyPaths,
    readRoots: desired.readRoots,
    hash: desired.hash,
  };
  if (hashObject(manifest) !== hashObject(expected)) {
    fail('TOOLCHAIN_DRIFT', 'Toolchain manifest не соответствует canonical dependencies');
  }
  verifyProjection(desired, ctx);
  return Object.freeze({
    dependencyPaths: Object.freeze([...expected.dependencyPaths]),
    readRoots: Object.freeze([...expected.readRoots]),
    hash: expected.hash,
  });
}
