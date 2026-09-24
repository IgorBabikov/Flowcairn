import { gitExecutable, hostNullDevice, hostSystemEnvironment } from './host-executables.mjs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { GraphError, hashObject, sha256 } from './io.mjs';
import { RelativePath } from './schemas.mjs';
import { isSensitivePath, isInstructionPath, overlaps } from './registry.mjs';
import { loadProjectProfile, projectContextPaths } from './project.mjs';
import { ownedBootstrapFiles } from './bootstrap.mjs';
import { isSensitiveSourcePath } from './source.mjs';
import { fingerprintProjectSource } from './project-source-access.mjs';

function git(root, args) {
  const result = spawnSync(gitExecutable(), ['-c', 'core.fsmonitor=false', ...args], {
    cwd: root, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
    env: { ...hostSystemEnvironment(), PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: hostNullDevice, GIT_OPTIONAL_LOCKS: '0' },
  });
  if (result.error || result.status !== 0) throw new GraphError('PROJECT_CONTEXT_UNAVAILABLE', 'Не удалось прочитать Git inventory проекта');
  return result.stdout;
}
const safe = (file) => RelativePath.safeParse(file).success && !isSensitivePath(file);
export function taskContextInventory(root, profile = loadProjectProfile(root)) {
  const snapshot = fingerprintProjectSource(root, { outputPaths: profile.outputPaths, denyGlobs: profile.aiDenyGlobs ?? [] });
  return { files: snapshot.files.map((file) => file.path).filter(safe), sourceHash: snapshot.hash };
}
function sourceIdentity(root, file) {
  const target = path.join(root, file);
  for (let cursor = path.dirname(target); cursor !== root; cursor = path.dirname(cursor)) {
    if (!cursor.startsWith(root + path.sep) || lstatSync(cursor).isSymbolicLink()) throw new GraphError('SNAPSHOT_UNSAFE', 'Snapshot path содержит ссылку');
  }
  if (!existsSync(target)) return { path: file, hash: null, size: 0 };
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8 * 1024 * 1024) throw new GraphError('SNAPSHOT_LIMIT', 'Snapshot candidate должен быть обычным файлом до 8 MiB');
    const bytes = readFileSync(fd);
    if (bytes.length !== stat.size) throw new GraphError('STALE_CONTEXT', 'Snapshot candidate изменился');
    return { path: file, hash: sha256(bytes), size: bytes.length };
  } finally { closeSync(fd); }
}

/** Bounded metadata/hash preview. Source bytes stay local until a separate planning gate. */
export function projectSummary(service) {
  const profile = service.adapters.project;
  if (!profile) throw new GraphError('PROJECT_PROFILE_MISSING', 'Нужен профиль проекта');
  const inventory = taskContextInventory(service.root, profile);
  const files = inventory.files;
  const available = new Set(files);
  const changed = git(service.root, ['diff', 'HEAD', '--name-only', '-z']).split('\0').filter(Boolean);
  const untracked = git(service.root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  if (changed.length + untracked.length > 128) throw new GraphError('SNAPSHOT_LIMIT', 'Слишком много измененных файлов для первого snapshot');
  const firstTask = !existsSync(path.join(service.root, '.ai-orchestrator/state.json'));
  const requiredUntracked = firstTask ? ownedBootstrapFiles(service.root).filter((file) => untracked.includes(file.path)) : [];
  const requiredPaths = new Set(requiredUntracked.map((file) => file.path));
  const changedPaths = changed.filter((file) => safe(file) && available.has(file)).sort(), untrackedCandidates = untracked.filter((file) => safe(file) && available.has(file)).filter((file) => !requiredPaths.has(file)).sort();
  const identities = [...new Set([...changedPaths, ...untrackedCandidates, ...requiredPaths])].map((file) => sourceIdentity(service.root, file));
  if (identities.reduce((sum, file) => sum + file.size, 0) > 32 * 1024 * 1024) throw new GraphError('SNAPSHOT_LIMIT', 'Snapshot preview превышает 32 MiB');
  const bootstrap = { firstTask, required: firstTask && identities.length > 0, changedPaths, untrackedCandidates, requiredUntracked,
    snapshotHash: hashObject({ firstTask, identities, requiredUntracked, head: git(service.root, ['rev-parse', 'HEAD']).trim() }) };
  const excluded = ['.flowcairn.json', '.agents', '.codex', '.cursor', '.claude', ...profile.outputPaths];
  const scopeCandidates = [...new Set(files.filter((file) => !isInstructionPath(file) && !excluded.some((entry) => overlaps(file, entry)))
    .map((file) => file.includes('/') ? file.split('/')[0] : file))].sort();
  if (scopeCandidates.length > 256) throw new GraphError('INTAKE_SCOPE_LIMIT', 'Inventory превышает 256 корневых областей; требуется более узкий проект');
  const contextPaths = [...new Set([...projectContextPaths(service.root, profile), ...(service.adapters.instructionPaths?.() ?? [])])].filter((file) => available.has(file)).sort();
  const contextHash = hashObject({ runtimeHash: service.adapters.identity(), files, contextPaths, scopeCandidates, profile, snapshotHash: bootstrap.snapshotHash, safeSourceHash: inventory.sourceHash });
  // The source snapshot withholds these files entirely; their local edits are not AI inputs.
  // Other unsafe names remain a blocker. Never read private configuration to build the preview.
  const unsafeChanges = changed.some((file) => !safe(file) &&
    !(RelativePath.safeParse(file).success && isSensitiveSourcePath(file)));
  return { schemaVersion: 2, name: path.basename(service.root), contextHash, contextPaths, scopeCandidates, bootstrap,
    checks: profile.checks, ai: { provider: profile.ai.provider, model: profile.ai.model },
    capabilities: { intake: { allowed: scopeCandidates.length > 0 && !unsafeChanges,
      reason: unsafeChanges ? 'Измененные или новые файлы содержат закрытые/небезопасные пути; исключите их из рабочего дерева перед snapshot' : scopeCandidates.length ? null : 'Не найден доступный scope исходников' } } };
}
