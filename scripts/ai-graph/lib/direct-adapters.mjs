import path from 'node:path';
import { sameHostPath } from './host-filesystem.mjs';
import { existsSync, realpathSync } from 'node:fs';
import { GraphError, hashObject } from './io.mjs';
import { isInstructionPath, isSensitivePath, overlaps } from './registry.mjs';
import { projectContextPaths } from './project.mjs';
import { fingerprintDirectWorkspace } from './direct-workspace.mjs';
import { fingerprintProjectSource } from './project-source-access.mjs';
import { selectDirectTaskScope } from './direct-scope.mjs';
import { inspectDirectChanges } from './direct-fingerprint.mjs';
import { captureDirectSource, verifyDirectSource } from './direct-source.mjs';
import { allocateDirectBinding, replaceDirectBinding, verifyDirectBinding, withDirectBindingFence } from './direct-binding.mjs';
import { prepareToolchain, verifyToolchain } from './toolchain.mjs';

/** The same WorkflowService controls direct projects; only its workspace boundary changes. */
export function directAdapters(root, profile, base) {
  const projectRoot = realpathSync(root);
  let previewSnapshot = null;
  const fingerprint = (worktree) => {
    if (!sameHostPath(realpathSync(worktree), projectRoot)) throw new GraphError('DIRECT_ROOT', 'Работа вышла за текущий проект');
    // Dependency directories are already excluded by the direct scanner and
    // bound separately by verifyToolchain; they are not user output paths.
    return fingerprintDirectWorkspace(projectRoot, { outputPaths: profile.outputPaths });
  };
  const safeInventory = () => {
    const snapshot = fingerprintProjectSource(projectRoot, { outputPaths: profile.outputPaths, denyGlobs: profile.aiDenyGlobs ?? [] });
    return { ...snapshot, files: snapshot.files.filter((file) => !file.path.split('/').includes('.DS_Store')) };
  };
  const projectSummary = () => {
    const snapshot = fingerprint(projectRoot);
    const safeSource = safeInventory();
    previewSnapshot = { files: safeSource.files, hash: snapshot.hash };
    const files = safeSource.files.map((file) => file.path);
    const excluded = ['.flowcairn.json', ...profile.outputPaths];
    const scopeCandidates = [...new Set(files.filter((file) => !isInstructionPath(file) &&
      !excluded.some((entry) => overlaps(file, entry))).map((file) => file.includes('/') ? file.split('/')[0] : file))].sort();
    if (scopeCandidates.length > 256) throw new GraphError('INTAKE_SCOPE_LIMIT', 'Уточните область задачи');
    const contextPaths = [...new Set([...projectContextPaths(projectRoot, profile), ...base.instructionPaths()])].filter((file) => files.includes(file)).sort();
    const firstTask = !existsSync(path.join(projectRoot, '.ai-orchestrator', 'graph', 'state.json'));
    const bootstrap = { firstTask, required: false, changedPaths: [], untrackedCandidates: [], requiredUntracked: [],
      snapshotHash: hashObject({ source: snapshot.hash }) };
    return { schemaVersion: 2, name: path.basename(projectRoot), sourceHash: snapshot.hash,
      contextHash: hashObject({ runtimeHash: base.identity(), sourceHash: snapshot.hash, contextPaths, scopeCandidates, profile, safeSourceHash: safeSource.hash }),
      contextPaths, scopeCandidates, bootstrap, checks: profile.checks,
      ai: { provider: profile.ai.provider, model: profile.ai.model },
      capabilities: { intake: { allowed: scopeCandidates.length > 0, reason: scopeCandidates.length ? null : 'Не найдены файлы проекта для задачи' } } };
  };
  return {
    ...base,
    projectSummary,
    taskContextInventory: () => {
      // Match the project summary's exact snapshot. Intake/capture rechecks
      // freshness before mutation; a preview does not need a second full scan.
      const snapshot = previewSnapshot ?? { files: safeInventory().files, hash: fingerprint(projectRoot).hash };
      return { files: snapshot.files.map((file) => file.path), sourceHash: snapshot.hash };
    },
    selectTaskScope: (description, candidates) =>
      selectDirectTaskScope(description, safeInventory().files.map((file) => file.path), candidates),
    registerTask: async (selectedRoot, task, options) => {
      if (!sameHostPath(realpathSync(selectedRoot), projectRoot)) throw new GraphError('DIRECT_ROOT', 'Задача относится к другому проекту');
      if (options.contextHash && options.contextHash !== projectSummary().contextHash)
        throw new GraphError('STALE_CONTEXT', 'Файлы изменились после проверки области задачи. Проверьте ее заново.');
      const selected = task.includeUntracked ?? [];
      if (selected.length) {
        const available = new Set(safeInventory().files.map((file) => file.path));
        if (selected.some((file) => file === '.flowcairn.json' || isSensitivePath(file) || !available.has(file)))
          throw new GraphError('DIRECT_SCOPE', 'Явно выбранный файл недоступен для задачи');
      }
      return options.service.create(task, { runId: options.run, operationId: options.operation,
        stage: options.stage, workflow: options.workflow, naturalIntakeHash: options.naturalIntakeHash,
        expectedSourceHash: options.expectedSourceHash,
        actor: options.actor });
    },
    capture: async (_task, context = {}) => captureDirectSource(projectRoot, profile, context.worktree ?? projectRoot),
    verifySource: verifyDirectSource,
    readiness: () => ({ available: true, owner: 'local-operator' }),
    allocate: (options) => allocateDirectBinding({ root: projectRoot, ...options,
      owner: options.owner, outputPaths: profile.outputPaths }),
    verifyBinding: (binding) => verifyDirectBinding(projectRoot, binding),
    withBindingFence: (binding, callback) => withDirectBindingFence(projectRoot, binding, callback),
    replaceBinding: (options) => replaceDirectBinding({ root: projectRoot, ...options }),
    prepareToolchain: (worktree) => prepareToolchain({ root: projectRoot, worktree }),
    verifyToolchain: (worktree, manifest) => verifyToolchain({ root: projectRoot, worktree, manifest }),
    fingerprint,
    inspectChanges: inspectDirectChanges,
  };
}
