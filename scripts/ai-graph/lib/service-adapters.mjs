import { lstatSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { RUNTIME_ROOT, loadProjectProfile, projectContextPaths } from './project.mjs';
import { GraphError, hashObject, sha256 } from './io.mjs';
import { loadSkill } from './skills.mjs';
import * as SkillsPolicy from './skills.mjs';
import { SKILL_ROUTES } from './config.mjs';
import { resolveAction, pathAllowed } from './registry.mjs';
import { verifySourceBundle } from './source.mjs';
import { boundedProcess } from './bounded-process.mjs';
import { captureBeforeContents, buildAttemptDiff } from './artifacts.mjs';
import { applyProposedEdits } from './patch.mjs';
import { prepareToolchain, verifyToolchain } from './toolchain.mjs';
import { effectiveInstructionFiles } from './instructions.mjs';
import { projectInstructionMetadata } from './project-instruction-context.mjs';

const fail = (code, message) => { throw new GraphError(code, message); };
const unique = (values) => [...new Set(values)];

// Trusted host adapters and runtime identity are independent of workflow state and control routing.
/** Text from actions is untrusted. Never expose host paths, credentials or raw command output. */
export function sanitizeText(value) {
  return String(value)
    .replace(
      /-----BEGIN [\s\S]*?PRIVATE KEY-----[\s\S]*?-----END [\s\S]*?PRIVATE KEY-----/g,
      '[redacted]',
    )
    .replace(/\b(?:sk-[\w-]{8,}|Bearer\s+[\w./-]+)\b/gi, '[redacted]')
    .replace(
      /((?:api[_-]?key|password|secret|access[_-]?token|authorization)\s*[=:]\s*)[^\s,;]+/gi,
      '$1[redacted]',
    )
    .replace(/\/(?:Users|home|private|tmp|var)\/[^\s"'<>]+/g, '[host-path]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '') // eslint-disable-line no-control-regex -- remove unsafe control characters
    .slice(0, 12000);
}

function readTrusted(root, relative) {
  const file = path.join(root, relative);
  for (let cursor = file; cursor !== root; cursor = path.dirname(cursor)) {
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink() || (cursor === file && (!stat.isFile() || stat.nlink !== 1)))
      fail('UNSAFE_RUNTIME', 'Runtime или инструкции содержат ссылку');
  }
  return readFileSync(file);
}

export function runtimeIdentity(root) {
  const profile = loadProjectProfile(root);
  const files = [
    'package.json',
    'scripts/ai-orchestrator.mjs',
    'scripts/ai-graph/cli.mjs',
    'scripts/ai-graph/serve.mjs',
    'tools/ai-graph-viewer/controller.mjs',
    'tools/ai-graph-viewer/server.mjs',
    'scripts/ai-graph/container-check.mjs',
    'scripts/ai-graph/Dockerfile.checks',
  ];
  const visit = (relative) => {
    for (const entry of readdirSync(path.join(RUNTIME_ROOT, relative), { withFileTypes: true })) {
      const file = `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(file);
      else if (/\.(mjs|json|md)$/.test(entry.name)) files.push(file);
    }
  };
  visit('scripts/ai-graph/lib');
  visit('skills');
  if (existsSync(path.join(RUNTIME_ROOT, 'bin'))) visit('bin');
  for (const lock of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'])
    if (existsSync(path.join(RUNTIME_ROOT, lock))) files.push(lock);
  const instructions = [];
  let instructionBytes = 0;
  const visitContext = (relative) => {
    const stat = lstatSync(path.join(root, relative));
    if (stat.isSymbolicLink()) fail('UNSAFE_RUNTIME', 'Project context must not contain links');
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path.join(root, relative)))
        visitContext(`${relative.replace(/\/$/, '')}/${entry}`);
    } else {
      if (instructions.length >= 20000 || (instructionBytes += stat.size) > 64 * 1024 * 1024)
        fail('CONTEXT_TOO_LARGE', 'Project instruction identity exceeds the bounded context size');
      instructions.push({ path: relative, hash: sha256(readTrusted(root, relative)) });
    }
  };
  for (const relative of projectContextPaths(root, profile).sort()) visitContext(relative);
  return hashObject({
    runtime: files
      .sort()
      .map((file) => ({ path: file, hash: sha256(readTrusted(RUNTIME_ROOT, file)) })),
    profile,
    instructions,
  });
}

function currentSkills(root) {
  return unique(Object.values(SKILL_ROUTES).flat())
    .sort()
    .map((id) => {
      const skill = loadSkill(root, id);
      return { id, path: skill.path, hash: skill.hash };
    });
}

export function privateDirectory(parent, name) {
  const directory = path.join(parent, name);
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    fail('INSECURE_STORE', 'Control directory должна быть private и без ссылок');
  return directory;
}

const loadedRuntimeHashes = new Map();
function pinnedRuntimeIdentity(root) {
  const current = runtimeIdentity(root);
  if (!loadedRuntimeHashes.has(root)) loadedRuntimeHashes.set(root, current);
  if (loadedRuntimeHashes.get(root) !== current)
    fail(
      'RUNTIME_DRIFT',
      'Runtime изменился: перезапустите локальный server перед новой версией плана',
    );
  return current;
}

export async function defaultAdapters(root) {
  const [runner, workspace, orchestrator, dockerChecks] = await Promise.all([
    import('./runner.mjs'),
    import('./workspace.mjs'),
    import('./orchestrator.mjs'),
    import('./docker-checks.mjs'),
  ]);
  pinnedRuntimeIdentity(root);
  const profile = loadProjectProfile(root);
  const checks = profile.checkMode === 'hardened'
    ? dockerChecks.probeChecks({ root })
    : profile.checkMode === 'trusted-local'
      ? runner.probeLocalChecks({ root })
      : { available: false, reason: profile.checkMode === 'local' ? 'LOCAL_CHECK_RECONFIGURATION_REQUIRED' : 'CHECKS_NOT_ENABLED' };
  // These modules are bundled trusted runtime code, never a user-supplied import path.
  const rulesFile = new URL('./instructions.mjs', import.meta.url);
  const rules = existsSync(rulesFile) ? await import(rulesFile.href) : null;
  const resolveContext = Reflect.get(SkillsPolicy, 'resolveNodeSkills');
  const projectSkills = Reflect.get(profile, 'skillManifest') ?? [];
  const contextual = (action, scope) => resolveContext(root, { action, scope: scope.map((entry) => entry.replace(/\/$/, '')), manifestPaths: profile.manifests, projectSkills });
  const instructionInspection = () => {
    const inspection = rules?.inspectInstructions({ projectRoot: root });
    if (inspection && !inspection.complete) fail('INSTRUCTION_INCOMPLETE', 'Discovery инструкций неполное; требуется уточнить проектный контекст');
    return inspection;
  };
  const relevantInstructions = (scope = null) => effectiveInstructionFiles(instructionInspection() ?? { files: [] }, { provider: profile.ai.provider, scope });
  const resolveReadPaths = (node, task) => {
    if (!node.action.id.startsWith('ai-')) return node.resources.reads;
    const discovered = new Set((instructionInspection()?.files ?? []).map((file) => file.path));
    const scope = node.resources.writes.length ? node.resources.writes : task.scope;
    const selected = node.action.id === 'ai-implement' ? [...node.resources.reads, ...node.resources.writes] : task.scope;
    const explicitTargets = new Set([...task.scope, ...node.resources.writes]);
    return unique([...selected.filter((file) => !discovered.has(file) || explicitTargets.has(file)), ...task.contextPaths.filter((file) => !discovered.has(file)),
      ...relevantInstructions(scope).map((file) => file.path)]);
  };
  const resolveSkills = (node, task) => node.action.id.startsWith('ai-') && resolveContext
    ? contextual(node.action.id, node.resources.writes.length ? node.resources.writes : task.scope).ids
    : [...resolveAction(node.action.id).skills];
  return {
    project: profile,
    identity: () => hashObject({ runtime: pinnedRuntimeIdentity(root), instructions: instructionInspection()?.fingerprint ?? null }),
    instructionPaths: (task = null) => relevantInstructions(task?.scope).map((file) => file.path),
    instructionMetadata: (node, task) => projectInstructionMetadata(root, node, task, profile, instructionInspection()),
    resolveReadPaths,
    skills: (task) => {
      if (!resolveContext || !task) return currentSkills(root);
      const manifests = ['ai-plan', 'ai-analyze', 'ai-implement', 'ai-review'].flatMap((action) => contextual(action, task.scope).manifest);
      return [...new Map(manifests.map((skill) => [skill.id, skill])).values()].sort((a, b) => a.id.localeCompare(b.id));
    },
    resolveSkills,
    contextHash: (task) => hashObject({
      instructions: instructionInspection()?.fingerprint ?? null,
      explicitMarkdown: projectInstructionMetadata(root, { resources: { reads: unique([...(profile.contextPaths ?? []), ...task.contextPaths]), writes: [] } }, task, profile, instructionInspection())
        .filter((file) => file.kind === 'explicit-context'),
      skills: resolveContext ? ['ai-plan', 'ai-analyze', 'ai-implement', 'ai-review'].map((action) => contextual(action, task.scope).context.hash) : null,
    }),
    skillContextPaths: (task) => resolveContext
      ? ['ai-plan', 'ai-analyze', 'ai-implement', 'ai-review'].flatMap((action) => contextual(action, task.scope).context.evidence).filter((file) => file.hash).map((file) => file.path)
      : [],
    capture: async (task, context = {}) => {
      const control = privateDirectory(root, '.ai-orchestrator');
      const graph = privateDirectory(control, 'graph');
      const sources = privateDirectory(graph, 'sources');
      const sourceRoot = context.worktree ?? root;
      let allowedUntracked = task.includeUntracked;
      if (context.worktree) {
        const result = spawnSync(
          '/usr/bin/git',
          ['-c', 'core.fsmonitor=false', 'ls-files', '--others', '--exclude-standard', '-z'],
          {
            cwd: sourceRoot,
            encoding: 'utf8',
            maxBuffer: 1024 * 1024,
            timeout: 10000,
            env: {
              PATH: '/usr/bin:/bin',
              GIT_CONFIG_NOSYSTEM: '1',
              GIT_CONFIG_GLOBAL: '/dev/null',
              GIT_OPTIONAL_LOCKS: '0',
            },
          },
        );
        if (result.error || result.status !== 0)
          fail('SOURCE_CAPTURE', 'Не удалось перечислить новые source files');
        allowedUntracked = result.stdout.split('\0').filter(Boolean);
        if (
          allowedUntracked.some(
            (file) => !pathAllowed(file, task) && !task.includeUntracked.includes(file),
          )
        )
          fail('SOURCE_SCOPE', 'Новый source содержит untracked вне scope');
      }
      const result = await boundedProcess(process.execPath, [path.join(RUNTIME_ROOT, 'scripts/ai-graph/lib/source-worker.mjs')], {
        cwd: sourceRoot, timeoutMs: 120_000, maxBytes: 9 * 1024 * 1024, timeoutCode: 'SOURCE_CAPTURE_TIMEOUT',
        input: JSON.stringify({ root: sourceRoot, storage: sources, allowedUntracked }),
      });
      const output = JSON.parse(result.stdout);
      if (result.status !== 0 || output.error) fail(output.error?.code ?? 'SOURCE_CAPTURE', 'Не удалось сохранить snapshot проекта.');
      const manifest = output.manifest;
      if (!manifest || !/^[a-f0-9]{64}$/.test(manifest.sourceHash) ||
          output.bundlePath !== path.join(sources, manifest.sourceHash) || !Array.isArray(manifest.entries))
        fail('SOURCE_CAPTURE', 'Сборщик вернул некорректный snapshot.');
      return { bundlePath: output.bundlePath, manifest };
    },
    readiness: (task) => orchestrator.graphExecutionContext({ root, task }),
    allocate: (options) => {
      const context = orchestrator.graphExecutionContext({ root, task: options.task });
      if (!context.available) fail('ORCHESTRATOR_NOT_READY', context.reason);
      return orchestrator.allocateGraphWorkspace({ root, ...options, owner: context.owner });
    },
    verifyBinding: (binding) => orchestrator.verifyGraphWorkspace({ root, binding }),
    withBindingFence: (binding, callbackSync) =>
      orchestrator.withGraphWorkspaceFence({ root, binding, callbackSync }),
    verifySource: (bundle) => verifySourceBundle(bundle).sourceHash,
    replaceBinding: (options) =>
      orchestrator.replaceGraphBinding({ root, ...options, owner: options.binding.owner }),
    prepareToolchain: (worktree) => prepareToolchain({ root, worktree }),
    verifyToolchain: (worktree, manifest) => verifyToolchain({ root, worktree, manifest }),
    fingerprint: (worktree, manifest) =>
      workspace.fingerprintWorkspace(worktree, {
        outputPaths: [...new Set([...profile.outputPaths, ...(manifest?.dependencyPaths ?? [])])],
      }),
    inspectChanges: workspace.inspectWorkspaceChanges,
    captureBefore: captureBeforeContents,
    applyEdits: applyProposedEdits,
    diff: buildAttemptDiff,
    runner: { ...(await runner.probeRunner({ root })), checks },
    execute: (options) =>
      options.node.action.id.startsWith('check-')
        ? profile.checkMode === 'hardened' ? dockerChecks.runCheck(options)
          : profile.checkMode === 'trusted-local' ? runner.runRegisteredAction(options)
            : fail('CHECKS_NOT_ENABLED', 'Проверки не включены. Выберите hardened или trusted-local в настройке проекта.')
        : runner.runRegisteredAction(options),
    inspectProcess: (process) =>
      process.kind === 'docker-check'
        ? dockerChecks.inspectCheckProcess({ root, process })
        : runner.inspectProcess({ root, process }),
    loadSkills: (ids) => ids.map((id) => Reflect.apply(loadSkill, undefined, [root, id, { projectSkills }])),
  };
}
