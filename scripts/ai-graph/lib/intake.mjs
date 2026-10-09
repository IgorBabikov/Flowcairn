import { readGitPathInventory } from './git-path-inventory.mjs';
import { scanSourceFile } from './source-file-scan.mjs';
import { gitExecutable, gitNullDevice, hostSystemEnvironment } from './host-executables.mjs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { GraphError, hashObject } from './io.mjs';
import { RelativePath } from './schemas.mjs';
import { isSensitivePath, isInstructionPath, overlaps } from './registry.mjs';
import { loadProjectProfile, projectContextPaths } from './project.mjs';
import { ownedBootstrapFiles } from './bootstrap.mjs';
import { isSensitiveSourcePath } from './source.mjs';
import { fingerprintProjectSource } from './project-source-access.mjs';
import { checkProfileSummary } from './check-profile.mjs';

function git(root, args) {
  const result = spawnSync(gitExecutable(), ['-c', 'core.fsmonitor=false', ...args], {
    cwd: root, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
    env: { ...hostSystemEnvironment(), PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitNullDevice, GIT_OPTIONAL_LOCKS: '0' },
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
  const data = scanSourceFile(target, { classify: false });
  return { path: file, hash: data.hash, size: data.size };
}

/** Bounded metadata/hash preview. Source bytes stay local until a separate planning gate. */
export function projectSummary(service) {
  const profile = service.adapters.project;
  if (!profile) throw new GraphError('PROJECT_PROFILE_MISSING', 'Нужен профиль проекта');
  const inventory = taskContextInventory(service.root, profile);
  const files = inventory.files;
  const available = new Set(files);
  const changed = readGitPathInventory(service.root, ['diff', 'HEAD', '--name-only', '-z']);
  const untracked = readGitPathInventory(service.root, ['ls-files', '--others', '--exclude-standard', '-z']);
  const firstTask = !existsSync(path.join(service.root, '.ai-orchestrator/state.json'));
  const requiredUntracked = firstTask ? ownedBootstrapFiles(service.root).filter((file) => untracked.includes(file.path)) : [];
  const requiredPaths = new Set(requiredUntracked.map((file) => file.path));
  const changedPaths = changed.filter((file) => safe(file) && available.has(file)).sort(), untrackedCandidates = untracked.filter((file) => safe(file) && available.has(file)).filter((file) => !requiredPaths.has(file)).sort();
  const identities = [...new Set([...changedPaths, ...untrackedCandidates, ...requiredPaths])].map((file) => sourceIdentity(service.root, file));
  const bootstrap = { firstTask, required: firstTask && identities.length > 0, changedPaths, untrackedCandidates, requiredUntracked,
    snapshotHash: hashObject({ firstTask, identities, requiredUntracked, head: git(service.root, ['rev-parse', 'HEAD']).trim() }) };
  const excluded = ['.flowcairn.json', '.agents', '.codex', '.cursor', '.claude', ...profile.outputPaths];
  const scopeCandidates = [...new Set(files.filter((file) => !isInstructionPath(file) && !excluded.some((entry) => overlaps(file, entry)))
    .map((file) => file.includes('/') ? file.split('/')[0] : file))].sort();
  const contextPaths = [...new Set([...projectContextPaths(service.root, profile), ...(service.adapters.instructionPaths?.() ?? [])])].filter((file) => available.has(file)).sort();
  const contextHash = hashObject({ runtimeHash: service.adapters.identity(), files, contextPaths, scopeCandidates, profile, snapshotHash: bootstrap.snapshotHash, safeSourceHash: inventory.sourceHash });
  // The source snapshot withholds these files entirely; their local edits are not AI inputs.
  // Other unsafe names remain a blocker. Never read private configuration to build the preview.
  const unsafeChanges = changed.some((file) => !safe(file) &&
    !(RelativePath.safeParse(file).success && isSensitiveSourcePath(file)));
  return { schemaVersion: 3, name: path.basename(service.root), contextHash, contextPaths, scopeCandidates, bootstrap,
    checkIds: profile.checks, ...checkProfileSummary(service.root, profile), ai: { provider: profile.ai.provider, model: profile.ai.model },
    capabilities: { intake: { allowed: scopeCandidates.length > 0 && !unsafeChanges,
      reason: unsafeChanges ? 'Измененные или новые файлы содержат закрытые/небезопасные пути; исключите их из рабочего дерева перед snapshot' : scopeCandidates.length ? null : 'Не найден доступный scope исходников' } } };
}
