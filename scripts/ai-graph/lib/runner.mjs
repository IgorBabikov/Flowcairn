import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { buildPrompt } from './codex.mjs';
import { GraphError, canonicalJson, sha256 } from './io.mjs';
import {
  resolveAction,
  contextPathAllowed,
  isAuxiliaryContextPath,
  isInstructionPath,
  isWithin as isWithinDeclaredPath,
} from './registry.mjs';
import {
  AIResultSchema,
  AIPlanningResultSchema,
  AIAnalysisResultSchema,
  AIReviewResultSchema,
  GraphPlanSchema,
  NodeDefinitionSchema,
  RelativePath,
  TaskSpecSchema,
  assertJsonBounds,
} from './schemas.mjs';
import { renderSkillInstructions } from './skills.mjs';
import {
  validateReviewEvidence,
  createReviewEvidenceFile,
  verifyReviewEvidenceFile,
  disposeReviewEvidenceFile,
} from './review-evidence.mjs';
import { verifyToolchain } from './toolchain.mjs';
import { loadProjectProfile } from './project.mjs';
import { fingerprintWorkspace } from './workspace.mjs';

const NODE_BINARY = realpathSync(process.execPath);
const NODE_BIN = path.dirname(NODE_BINARY);
const CODEX_VERSION = 'codex-cli 0.145.0';
const PNPM_VERSION = '11.8.0';
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const OPENAI_WORKER_FILE = fileURLToPath(new URL('./openai-worker.mjs', import.meta.url));
const SUPERVISOR_FILE = fileURLToPath(new URL('./supervisor.mjs', import.meta.url));
const MAX_AI_RESULT_BYTES = 2 * 1024 * 1024;
const MAX_AI_PROCESS_OUTPUT = 2 * 1024 * 1024;
const MAX_TICKET_BYTES = 64 * 1024;
const MAX_TOOLCHAIN_FILE_BYTES = 512 * 1024 * 1024;
const READY_TIMEOUT_MS = 5_000;
const STOP_GRACE_MS = 3_000;
const TRUSTED_PATH = `${NODE_BIN}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;

function fail(code, message, details) {
  throw new GraphError(code, message, details);
}

function errorReason(error, fallback) {
  if (error instanceof GraphError) return error.code;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function isPlainObject(value) {
  return value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function parseInputs({ node, task, plan, skills, priorEvidence, reviewEvidence }) {
  assertJsonBounds(node);
  assertJsonBounds(task);
  assertJsonBounds(plan);
  const parsedNode = NodeDefinitionSchema.safeParse(node);
  const parsedTask = TaskSpecSchema.safeParse(task);
  const parsedPlan = GraphPlanSchema.safeParse(plan);
  if (!parsedNode.success || !parsedTask.success || !parsedPlan.success) {
    fail('INVALID_RUNNER_INPUT', 'Runner получил данные вне validated Graph contract');
  }
  const approvedNode = parsedPlan.data.nodes.find((candidate) => candidate.id === parsedNode.data.id);
  if (!approvedNode || sha256(canonicalJson(approvedNode)) !== sha256(canonicalJson(parsedNode.data))) {
    fail('RUNNER_NODE_MISMATCH', 'Node contract не совпадает с approved plan');
  }
  if (
    parsedPlan.data.sourceHash !== parsedTask.data.sourceHash ||
    parsedPlan.data.taskHash !== sha256(canonicalJson(parsedTask.data))
  ) {
    fail('RUNNER_PLAN_MISMATCH', 'Task и plan не совпадают');
  }
  if (!Array.isArray(skills) || skills.length > 20) {
    fail('INVALID_RUNNER_SKILLS', 'Некорректный список Skills');
  }
  const expected = [...approvedNode.skills].sort();
  const normalizedSkills = skills.map((skill) => {
    if (
      !isPlainObject(skill) ||
      typeof skill.name !== 'string' ||
      !/^[a-z][a-z0-9-]{1,79}$/.test(skill.name) ||
      !RelativePath.safeParse(skill.path).success ||
      !/^[a-f0-9]{64}$/.test(skill.hash) ||
      typeof skill.text !== 'string' ||
      Buffer.byteLength(skill.text) > 12 * 1024 ||
      sha256(skill.text) !== skill.hash
    ) {
      fail('INVALID_RUNNER_SKILLS', 'Skill manifest/content не прошел проверку');
    }
    return { name: skill.name, path: skill.path, hash: skill.hash, text: skill.text };
  });
  if (normalizedSkills.some((skill) => !parsedPlan.data.skills.some((approved) => approved.id === skill.name && approved.path === skill.path && approved.hash === skill.hash)))
    fail('RUNNER_SKILLS_MISMATCH', 'Skill bytes/path не совпадают с approved plan');
  if (
    JSON.stringify(normalizedSkills.map((skill) => skill.name).sort()) !== JSON.stringify(expected)
  ) {
    fail('RUNNER_SKILLS_MISMATCH', 'Переданные Skills не совпадают с node');
  }
  if (priorEvidence !== undefined && priorEvidence !== null) {
    assertJsonBounds(priorEvidence, 5_000);
    if (Buffer.byteLength(JSON.stringify(priorEvidence)) > 32 * 1024) {
      fail('RUNNER_EVIDENCE_LIMIT', 'Prior evidence превышает лимит');
    }
  }
  return {
    node: parsedNode.data,
    task: parsedTask.data,
    plan: parsedPlan.data,
    skills: normalizedSkills,
    reviewBundle:
      parsedNode.data.action.id === 'ai-review'
        ? validateReviewEvidence(reviewEvidence, {
            node: parsedNode.data,
            task: parsedTask.data,
            plan: parsedPlan.data,
          })
        : null,
    priorEvidence: priorEvidence ?? null,
  };
}

function realDirectory(candidate, code) {
  let stat;
  try {
    stat = lstatSync(candidate);
  } catch {
    fail(code, `Каталог недоступен: ${candidate}`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink())
    fail(code, `Ожидался обычный каталог: ${candidate}`);
  return realpathSync(candidate);
}

function isWithin(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function isSystemTemporary(candidate) {
  const resolved = realpathSync(candidate);
  const roots = new Set(['/private/tmp', '/tmp', realpathSync(os.tmpdir())]);
  return [...roots].some((root) => isWithin(resolved, root));
}

function assertPrivateDirectory(candidate, code) {
  const resolved = realDirectory(candidate, code);
  const stat = statSync(resolved);
  if ((stat.mode & 0o077) !== 0) fail(code, `Каталог должен быть private (0700): ${candidate}`);
  return resolved;
}

function assertNoSymlinkAncestors(base, candidate, code) {
  const relative = path.relative(base, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative))
    fail(code, 'Путь вышел за trusted root');
  let current = base;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      fail(code, `Путь недоступен: ${current}`);
    }
    if (stat.isSymbolicLink()) fail(code, `Symlink ancestor запрещен: ${current}`);
  }
}

function validateAllocation(root, worktree, outputDirectory, provider) {
  const rootPath = realDirectory(root, 'RUNNER_ROOT_INVALID');
  if (provider === 'codex' && isSystemTemporary(rootPath)) {
    fail('RUNNER_TEMP_UNSAFE', 'Runtime root внутри системного temp не поддерживается на macOS');
  }
  const graphRoot = assertPrivateDirectory(
    path.join(rootPath, '.ai-orchestrator', 'graph'),
    'RUNNER_STORAGE_INVALID',
  );
  assertNoSymlinkAncestors(rootPath, graphRoot, 'RUNNER_STORAGE_INVALID');
  const workspaces = assertPrivateDirectory(
    path.join(rootPath, '.ai-orchestrator', 'worktrees'),
    'RUNNER_WORKSPACE_INVALID',
  );
  const worktreePath = realDirectory(worktree, 'RUNNER_WORKTREE_INVALID');
  if (
    !isWithin(worktreePath, workspaces) ||
    (provider === 'codex' && isSystemTemporary(worktreePath))
  ) {
    fail('RUNNER_WORKTREE_INVALID', 'Worktree не принадлежит trusted Graph allocation');
  }
  assertNoSymlinkAncestors(workspaces, worktreePath, 'RUNNER_WORKTREE_INVALID');
  const outputPath = assertPrivateDirectory(outputDirectory, 'RUNNER_OUTPUT_INVALID');
  if (!isWithin(outputPath, graphRoot)) {
    fail('RUNNER_OUTPUT_INVALID', 'Output directory находится вне private Graph storage');
  }
  assertNoSymlinkAncestors(graphRoot, outputPath, 'RUNNER_OUTPUT_INVALID');
  const tickets = assertPrivateDirectory(
    path.join(graphRoot, 'runner-tickets'),
    'RUNNER_TICKETS_INVALID',
  );
  return { rootPath, graphRoot, workspaces, worktreePath, outputPath, tickets };
}

function regularExecutable(candidate, expectedOwner = process.getuid?.()) {
  try {
    const resolved = realpathSync(candidate);
    const stat = statSync(resolved);
    return Boolean(
      stat.isFile() &&
      stat.nlink === 1 &&
      (stat.mode & 0o111) !== 0 &&
      (stat.mode & 0o022) === 0 &&
      (expectedOwner === undefined || stat.uid === 0 || stat.uid === expectedOwner),
    );
  } catch {
    return false;
  }
}

function regularReadable(candidate) {
  try {
    const stat = statSync(realpathSync(candidate));
    const expectedOwner = process.getuid?.();
    return (
      stat.isFile() &&
      stat.nlink === 1 &&
      (stat.mode & 0o022) === 0 &&
      (expectedOwner === undefined || stat.uid === 0 || stat.uid === expectedOwner)
    );
  } catch {
    return false;
  }
}

function fileDigest(candidate) {
  const resolved = realpathSync(candidate);
  const before = statSync(resolved);
  if (!before.isFile() || before.size > MAX_TOOLCHAIN_FILE_BYTES) {
    fail('RUNNER_TOOLCHAIN_INVALID', 'Toolchain file отсутствует или превышает лимит');
  }
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const handle = openSync(resolved, 'r');
  try {
    let offset = 0;
    while (offset < before.size) {
      const bytes = readSync(
        handle,
        buffer,
        0,
        Math.min(buffer.length, before.size - offset),
        offset,
      );
      if (!bytes) fail('RUNNER_TOOLCHAIN_CHANGED', 'Toolchain file изменился при проверке');
      hash.update(buffer.subarray(0, bytes));
      offset += bytes;
    }
  } finally {
    closeSync(handle);
  }
  const after = statSync(resolved);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  ) {
    fail('RUNNER_TOOLCHAIN_CHANGED', 'Toolchain file изменился при проверке');
  }
  return hash.digest('hex');
}

function packageVersion(packageRoot, expectedName, expectedVersion) {
  const manifest = path.join(packageRoot, 'package.json');
  if (!regularReadable(manifest) || statSync(manifest).size > 64 * 1024) {
    fail('RUNNER_TOOLCHAIN_INVALID', `Package manifest недоступен: ${expectedName}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(manifest, 'utf8'));
  } catch {
    fail('RUNNER_TOOLCHAIN_INVALID', `Package manifest поврежден: ${expectedName}`);
  }
  if (parsed?.name !== expectedName || parsed?.version !== expectedVersion) {
    fail('RUNNER_TOOLCHAIN_VERSION', `Ожидался ${expectedName}@${expectedVersion}`);
  }
  return { manifest, version: parsed.version };
}

function discoverCodex(ai) {
  const candidates = ai.codexPath
    ? [ai.codexPath]
    : [
        path.join(NODE_BIN, 'codex'),
        '/usr/local/bin/codex',
        '/opt/homebrew/bin/codex',
        '/usr/bin/codex',
      ];
  for (const candidate of candidates) {
    try {
      if (!regularReadable(candidate)) continue;
      const entry = realpathSync(candidate);
      if (path.basename(entry) !== 'codex.js') continue;
      const root = path.resolve(path.dirname(entry), '..');
      const manifest = packageVersion(root, '@openai/codex', '0.145.0');
      return { root, entry, manifest };
    } catch {
      /* Only a verified pinned installation is eligible. */
    }
  }
  fail(
    'RUNNER_TOOLCHAIN_INVALID',
    'Укажите ai.codexPath для проверенной установки @openai/codex@0.145.0',
  );
}

function runnerToolchain(profile) {
  if (!/^v22\./.test(process.version) || !regularExecutable(NODE_BINARY))
    fail('RUNNER_TOOLCHAIN_VERSION', 'Runner должен исполняться доверенным Node 22');
  if (profile.ai.provider === 'openai') {
    if (!['darwin', 'linux'].includes(process.platform))
      fail('RUNNER_PLATFORM_UNSUPPORTED', 'OpenAI worker требует Linux или macOS');
    if (!regularReadable(OPENAI_WORKER_FILE))
      fail('RUNNER_TOOLCHAIN_INVALID', 'OpenAI worker небезопасен');
    const identity = {
      nodeVersion: process.version,
      nodeDigest: fileDigest(NODE_BINARY),
      workerDigest: fileDigest(OPENAI_WORKER_FILE),
    };
    return Object.freeze({
      node: NODE_BINARY,
      codexEntry: null,
      digest: sha256(canonicalJson(identity)),
      identity: Object.freeze(identity),
    });
  }
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch))
    fail('RUNNER_PLATFORM_UNSUPPORTED', 'Codex sandbox квалифицирован только для macOS');
  const codex = discoverCodex(profile.ai);
  const platformName = process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  const triple = process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  const nativeRoot = path.join(codex.root, 'node_modules', '@openai', `codex-${platformName}`);
  const nativeManifest = packageVersion(nativeRoot, '@openai/codex', `0.145.0-${platformName}`);
  const native = path.join(nativeRoot, 'vendor', triple, 'bin', 'codex');
  if (!regularExecutable(native))
    fail('RUNNER_TOOLCHAIN_INVALID', 'Codex native binary небезопасен');
  const identity = {
    nodeVersion: process.version,
    nodeDigest: fileDigest(NODE_BINARY),
    codexVersion: codex.manifest.version,
    codexEntryDigest: fileDigest(codex.entry),
    codexNativeDigest: fileDigest(native),
    codexManifestDigest: fileDigest(codex.manifest.manifest),
    codexNativeManifestDigest: fileDigest(nativeManifest.manifest),
  };
  return Object.freeze({
    node: NODE_BINARY,
    codexEntry: codex.entry,
    digest: sha256(canonicalJson(identity)),
    identity: Object.freeze(identity),
  });
}

function tomlString(value) {
  return JSON.stringify(value);
}

function permissionFilesystem(
  worktree,
  writes,
  { reads = [], denied = [], extraReads = [], extraWrites = [], denyDependencies = true } = {},
) {
  const resolveRule = (relative) => path.resolve(worktree, relative);
  const deniedPaths = [
    '.git',
    '**/.git',
    '.ai-orchestrator',
    '**/.ai-orchestrator',
    '.env',
    '**/.env',
    '**/.env.*',
    '**/*.pem',
    '**/*.key',
  ];
  if (denyDependencies) deniedPaths.push('node_modules', '**/node_modules');
  deniedPaths.push(...denied);
  const top = {
    ':root': 'deny',
    ':minimal': 'read',
    ':tmpdir': 'deny',
    ':slash_tmp': 'deny',
    [worktree]: 'deny',
  };
  for (const read of [...new Set(reads)].sort()) top[resolveRule(read)] = 'read';
  for (const write of [...new Set(writes)].sort()) top[resolveRule(write)] = 'write';
  for (const denied of deniedPaths) top[resolveRule(denied)] = 'deny';
  for (const extra of extraReads) top[extra] = 'read';
  for (const extra of extraWrites) top[extra] = 'write';
  const render = (entries) =>
    Object.entries(entries)
      .map(([key, value]) => `${tomlString(key)}=${tomlString(value)}`)
      .join(',');
  return `{${render(top)}}`;
}

function safeEnvironment(extra = {}) {
  return {
    PATH: TRUSTED_PATH,
    LANG: process.env.LANG ?? 'C.UTF-8',
    LC_ALL: process.env.LC_ALL ?? 'C.UTF-8',
    NO_COLOR: '1',
    OPENSSL_CONF: '/dev/null',
    ...extra,
  };
}

function aiEnvironment() {
  const env = safeEnvironment();
  for (const name of ['HOME', 'CODEX_HOME']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return env;
}

function createExclusiveFile(file, contents) {
  let handle;
  try {
    handle = openSync(file, 'wx', 0o600);
    writeFileSync(handle, contents);
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

function makeAiCommand({
  worktree,
  node,
  task,
  plan,
  skills,
  priorEvidence,
  reviewBundle,
  outputPath,
  toolchain,
  dependencyToolchain,
  profile,
  instructionDenials = [],
}) {
  const schemaFile = path.join(outputPath, `ai-schema-${randomUUID()}.json`);
  const resultFile = path.join(outputPath, `ai-result-${randomUUID()}.json`);
  let reviewFile = null;
  try {
    createExclusiveFile(
      schemaFile,
      `${JSON.stringify(z.toJSONSchema(node.action.id === 'ai-review' ? AIReviewResultSchema : node.action.id === 'ai-plan' ? AIPlanningResultSchema : node.action.id === 'ai-analyze' && plan?.workflow === 'autonomous' ? AIAnalysisResultSchema : AIResultSchema))}\n`,
    );
    createExclusiveFile(resultFile, '');
    reviewFile = reviewBundle ? createReviewEvidenceFile(outputPath, reviewBundle) : null;
    const profileName = `graph-${node.action.id}`;
    const filesystem = permissionFilesystem(worktree, [], {
      reads: node.resources.reads,
      extraReads: reviewFile ? [reviewFile.path] : [],
      denied: [
        ...instructionDenials,
        ...task.forbiddenPaths,
        ...profile.outputPaths,
        ...dependencyToolchain.dependencyPaths,
      ],
    });
    const args = [
      'exec',
      '--ignore-user-config',
      '--ignore-rules',
      '--strict-config',
      '--ephemeral',
      '--skip-git-repo-check',
      '--json',
      '--output-schema',
      schemaFile,
      '--output-last-message',
      resultFile,
      '--cd',
      worktree,
      '--model',
      node.action.id === 'ai-review' && Reflect.get(profile.ai, 'modelMode') !== 'manual'
        ? (profile.ai.reviewModel ?? profile.ai.model)
        : profile.ai.model,
      '--config',
      'approval_policy="never"',
      '--config',
      `model_reasoning_effort="${Reflect.get(profile.ai, 'modelMode') === 'manual' ? (Reflect.get(profile.ai, 'reasoningEffort') ?? 'medium') : node.action.id === 'ai-review' ? (Reflect.get(profile.ai, 'reviewReasoningEffort') ?? Reflect.get(profile.ai, 'reasoningEffort') ?? 'high') : (Reflect.get(profile.ai, 'reasoningEffort') ?? 'medium')}"`,
      '--config',
      `default_permissions=${tomlString(profileName)}`,
      '--config',
      `permissions.${profileName}.filesystem=${filesystem}`,
      '--config',
      `permissions.${profileName}.network={enabled=false}`,
      '--config',
      'shell_environment_policy.inherit="none"',
      '--config',
      `shell_environment_policy.set={PATH=${tomlString(TRUSTED_PATH)},NO_COLOR="1",OPENSSL_CONF="/dev/null"}`,
      '-',
    ];
    const prompt = buildPrompt({
      nodeId: node.id,
      profile,
      task,
      plan,
      skills: renderSkillInstructions(skills),
      priorEvidence,
      reviewEvidence: reviewFile
        ? { path: reviewFile.path, hash: reviewFile.hash, bytes: reviewFile.bytes }
        : null,
    });
    if (Buffer.byteLength(prompt) > 128 * 1024) {
      fail('RUNNER_PROMPT_LIMIT', 'AI prompt превышает лимит');
    }
    return {
      command: {
        executable: toolchain.node,
        args: [toolchain.codexEntry, ...args],
        cwd: worktree,
        env: aiEnvironment(),
      },
      input: prompt,
      schemaFile,
      resultFile,
      reviewFile,
      maxOutputBytes: MAX_AI_PROCESS_OUTPUT,
      execution: Object.freeze({
        provider: 'codex',
        cliVersion: CODEX_VERSION,
        model:
          node.action.id === 'ai-review' && Reflect.get(profile.ai, 'modelMode') !== 'manual'
            ? (profile.ai.reviewModel ?? profile.ai.model)
            : profile.ai.model,
        sandboxDigest: sha256(
          canonicalJson({
            profileName,
            filesystem,
            network: { enabled: false },
            runnerToolchain: toolchain.digest,
            dependencyToolchain: dependencyToolchain.hash,
          }),
        ),
      }),
    };
  } catch (error) {
    cleanupPrepared({ schemaFile, resultFile, reviewFile });
    throw error;
  }
}

function sourceFingerprint(worktree, profile, dependencyToolchain = { dependencyPaths: [] }) {
  // Callers obtain dependencyToolchain from verifyToolchain; dependency links are checked there.
  return fingerprintWorkspace(worktree, {
    outputPaths: [...new Set([...profile.outputPaths, ...dependencyToolchain.dependencyPaths])],
  });
}

function instructionDenials(worktree, node, profile, dependencyToolchain) {
  return sourceFingerprint(worktree, profile, dependencyToolchain).files
    .filter((file) => isAuxiliaryContextPath(file.path) || (isInstructionPath(file.path) && !node.resources.reads.includes(file.path)))
    .map((file) => file.path);
}

function selectedSourceContext(worktree, node, task, profile, dependencyToolchain = { dependencyPaths: [] }) {
  const snapshot = sourceFingerprint(worktree, profile, dependencyToolchain);
  const files = snapshot.files.filter(
    (file) =>
      !isAuxiliaryContextPath(file.path) && node.resources.reads.some((scope) => isWithinDeclaredPath(file.path, scope)) &&
      contextPathAllowed(file.path, task) && (!isInstructionPath(file.path) || node.resources.reads.includes(file.path)),
  );
  if (files.length > 256 || files.reduce((total, file) => total + file.size, 0) > 512 * 1024)
    fail(
      'AI_CONTEXT_LIMIT',
      'Selected source context превышает 256 файлов или 512 KiB; сузьте contextPaths',
    );
  return files.map((file) => {
    const candidate = path.join(worktree, file.path);
    assertNoSymlinkAncestors(worktree, candidate, 'AI_CONTEXT_UNSAFE');
    const handle = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(handle);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== file.size)
        fail('AI_CONTEXT_CHANGED', 'Source context изменился');
      const body = readFileSync(handle);
      if (sha256(body) !== file.hash) fail('AI_CONTEXT_CHANGED', 'Source context hash изменился');
      const content = body.toString('utf8');
      if (!Buffer.from(content).equals(body) || content.includes('\0'))
        fail('AI_CONTEXT_BINARY', 'AI context должен содержать только UTF-8 text');
      return { path: file.path, hash: file.hash, content };
    } finally {
      closeSync(handle);
    }
  });
}

function makeOpenAiCommand({
  worktree,
  node,
  task,
  plan,
  skills,
  priorEvidence,
  reviewBundle,
  outputPath,
  toolchain,
  dependencyToolchain,
  profile,
}) {
  const inputFile = path.join(outputPath, `ai-input-${randomUUID()}.json`);
  const resultFile = path.join(outputPath, `ai-result-${randomUUID()}.json`);
  let reviewFile = null;
  try {
    if (profile.ai.baseUrl && profile.ai.baseUrl.replace(/\/$/, '') !== 'https://api.openai.com/v1')
      fail('AI_ENDPOINT_UNSUPPORTED', 'v0.1 поддерживает только https://api.openai.com/v1');
    const key = process.env.FLOWCAIRN_OPENAI_API_KEY;
    if (!key || key.length > 4096 || /[\r\n]/.test(key))
      fail('AI_AUTH_REQUIRED', 'Задайте FLOWCAIRN_OPENAI_API_KEY');
    reviewFile = reviewBundle ? createReviewEvidenceFile(outputPath, reviewBundle) : null;
    if (reviewFile) verifyReviewEvidenceFile(reviewFile);
    const source = selectedSourceContext(worktree, node, task, profile, dependencyToolchain);
    const model =
      node.action.id === 'ai-review' && Reflect.get(profile.ai, 'modelMode') !== 'manual'
        ? (profile.ai.reviewModel ?? profile.ai.model)
        : profile.ai.model;
    // Передаем только явный выбор. Поддержку выбранной моделью проверяет API без подмены параметра.
    const reasoningEffort = node.action.id === 'ai-review' && Reflect.get(profile.ai, 'modelMode') !== 'manual'
      ? (Reflect.get(profile.ai, 'reviewReasoningEffort') ?? Reflect.get(profile.ai, 'reasoningEffort'))
      : Reflect.get(profile.ai, 'reasoningEffort');
    const schema = z.toJSONSchema(
      node.action.id === 'ai-review' ? AIReviewResultSchema : node.action.id === 'ai-plan' ? AIPlanningResultSchema : node.action.id === 'ai-analyze' && plan?.workflow === 'autonomous' ? AIAnalysisResultSchema : AIResultSchema,
    );
    // Responses strict mode requires every object property, including nullable/defaulted fields.
    const requireProperties = (value) => {
      if (!value || typeof value !== 'object') return;
      if (value.type === 'object' && value.properties) {
        value.required = Object.keys(value.properties);
        value.additionalProperties = false;
      }
      for (const child of Object.values(value)) {
        if (Array.isArray(child)) child.forEach(requireProperties);
        else requireProperties(child);
      }
    };
    requireProperties(schema);
    const prompt = buildPrompt({
      nodeId: node.id,
      profile,
      task,
      plan,
      skills: renderSkillInstructions(skills),
      priorEvidence,
    });
    const payload = {
      version: 1,
      model,
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      schema,
      prompt,
      source,
      reviewEvidence: reviewFile
        ? {
            hash: reviewFile.hash,
            bytes: reviewFile.bytes,
            content: readFileSync(reviewFile.path, 'utf8'),
          }
        : null,
    };
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > 2 * 1024 * 1024)
      fail('AI_CONTEXT_LIMIT', 'Полный AI payload превышает 2 MiB');
    createExclusiveFile(inputFile, body);
    createExclusiveFile(resultFile, '');
    return {
      command: {
        executable: toolchain.node,
        args: [OPENAI_WORKER_FILE, inputFile, resultFile, sha256(body)],
        cwd: outputPath,
        env: safeEnvironment({ FLOWCAIRN_OPENAI_API_KEY: key }),
      },
      input: '',
      inputFile,
      resultFile,
      reviewFile,
      maxOutputBytes: MAX_AI_PROCESS_OUTPUT,
      execution: Object.freeze({
        provider: 'openai',
        cliVersion: null,
        model,
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
        sandboxDigest: sha256(
          canonicalJson({
            kind: 'trusted-tool-free-worker',
            endpoint: 'https://api.openai.com/v1/responses',
            inputHash: sha256(body),
            runnerToolchain: toolchain.digest,
            dependencyToolchain: dependencyToolchain.hash,
          }),
        ),
      }),
    };
  } catch (error) {
    cleanupPrepared({ inputFile, resultFile, reviewFile });
    throw error;
  }
}

function writeTicket(file, value, exclusive = false) {
  if (exclusive) {
    createExclusiveFile(file, `${JSON.stringify(value)}\n`);
    return;
  }
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  createExclusiveFile(temporary, `${JSON.stringify(value)}\n`);
  renameSync(temporary, file);
}

function ticketReservationHash(ticket) {
  return sha256(
    canonicalJson({
      version: ticket.version,
      state: 'reserved',
      actionId: ticket.actionId,
      createdAt: ticket.createdAt,
      nonceHash: ticket.nonceHash,
      commandHash: ticket.commandHash,
      timeoutMs: ticket.timeoutMs,
      maxOutputBytes: ticket.maxOutputBytes,
    }),
  );
}

function readTicket(file) {
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    fail('RUNNER_TICKET_INVALID', 'Supervisor ticket отсутствует');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) {
    fail('RUNNER_TICKET_UNSAFE', 'Supervisor ticket небезопасен');
  }
  if (stat.size < 2 || stat.size > MAX_TICKET_BYTES)
    fail('RUNNER_TICKET_INVALID', 'Supervisor ticket поврежден');
  let value;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    fail('RUNNER_TICKET_INVALID', 'Supervisor ticket поврежден');
  }
  assertJsonBounds(value, 2_000);
  return value;
}

function waitForControl(stream, expectedType, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(
      () => reject(new GraphError('RUNNER_CONTROL_TIMEOUT', 'Supervisor не ответил')),
      timeoutMs,
    );
    const cleanup = () => {
      clearTimeout(timer);
      stream.off('data', onData);
      stream.off('error', onError);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer) > MAX_TICKET_BYTES) {
        cleanup();
        reject(new GraphError('RUNNER_CONTROL_LIMIT', 'Supervisor control output слишком велик'));
        return;
      }
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        let value;
        try {
          value = JSON.parse(line);
        } catch {
          cleanup();
          reject(
            new GraphError('RUNNER_CONTROL_INVALID', 'Supervisor вернул invalid control JSON'),
          );
          return;
        }
        if (value.type === expectedType) {
          cleanup();
          resolve(value);
          return;
        }
        if (value.type === 'supervisor-error') {
          cleanup();
          reject(new GraphError('RUNNER_SUPERVISOR_ERROR', value.reason));
          return;
        }
      }
    };
    stream.on('data', onData);
    stream.once('error', onError);
  });
}

function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    return true;
  }
}

async function stopGroup(pgid) {
  if (!groupAlive(pgid)) return true;
  try {
    process.kill(-pgid, 'SIGTERM');
  } catch {
    // Recheck below.
  }
  const deadline = Date.now() + STOP_GRACE_MS;
  while (Date.now() < deadline) {
    if (!groupAlive(pgid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    // Recheck below.
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  return !groupAlive(pgid);
}

function boundedCallback(callback, value, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new GraphError('RUNNER_START_TIMEOUT', 'onStart не подтвердил durable state')),
      timeoutMs,
    );
    Promise.resolve()
      .then(() => callback(value))
      .then(
        (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}

function cleanupPrepared(prepared, stopped = true) {
  if (prepared.reviewFile) disposeReviewEvidenceFile(prepared.reviewFile, { unlink: stopped });
  if (!stopped) return;
  for (const file of [prepared.schemaFile, prepared.resultFile, prepared.inputFile]) {
    if (file && existsSync(file)) rmSync(file, { force: true });
  }
  if (prepared.scratch && existsSync(prepared.scratch)) {
    rmSync(prepared.scratch, { recursive: true, force: true });
  }
}

function executionMetadata(prepared, output) {
  return Object.freeze({
    ...prepared.execution,
    outputDigest: sha256(canonicalJson(output)),
  });
}

function parseAiOutput(file) {
  const stat = lstatSync(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o077) !== 0 ||
    stat.size > MAX_AI_RESULT_BYTES
  ) {
    fail('AI_OUTPUT_INVALID', 'AI output отсутствует или превышает лимит');
  }
  const output = JSON.parse(readFileSync(file, 'utf8'));
  assertJsonBounds(output, 5_000);
  return output;
}

export async function runRegisteredAction({
  root,
  worktree,
  node,
  task,
  plan,
  skills,
  priorEvidence = null,
  reviewEvidence = null,
  toolchain: toolchainManifest,
  outputDirectory,
  signal,
  onStart,
}) {
  const action = resolveAction(node?.action?.id, node?.action?.version, node?.action?.inputs);
  if (!action.id.startsWith('ai-') && !action.id.startsWith('check-')) {
    fail('RUNNER_ACTION_UNSUPPORTED', `Runner не исполняет action ${action.id}`);
  }
  if (typeof onStart !== 'function') fail('RUNNER_START_CALLBACK_REQUIRED', 'onStart обязателен');
  const input = parseInputs({ node, task, plan, skills, priorEvidence, reviewEvidence });
  const profile = loadProjectProfile(root);
  const allocation = validateAllocation(root, worktree, outputDirectory, profile.ai.provider);
  if (action.id.startsWith('check-')) {
    fail(
      'RUNNER_CHECK_CONTAINMENT_UNAVAILABLE',
      'Registered checks отключены до подтверждения descendant containment',
    );
  }
  const toolchain = runnerToolchain(profile);
  const dependencyToolchain = verifyToolchain({
    root: allocation.rootPath,
    worktree: allocation.worktreePath,
    manifest: toolchainManifest,
  });
  const prepare = profile.ai.provider === 'openai' ? makeOpenAiCommand : makeAiCommand;
  const prepared = prepare({
    ...input,
    profile,
    instructionDenials: profile.ai.provider === 'codex'
      ? instructionDenials(allocation.worktreePath, input.node, profile, dependencyToolchain)
      : [],
    worktree: allocation.worktreePath,
    outputPath: allocation.outputPath,
    toolchain,
    dependencyToolchain,
  });
  let supervisor;
  try {
    const nonce = randomBytes(32).toString('hex');
    const commandHash = sha256(canonicalJson(prepared.command));
    const ticketFile = path.join(allocation.tickets, `${randomUUID()}.json`);
    const ticket = {
      version: 1,
      state: 'reserved',
      actionId: action.id,
      createdAt: new Date().toISOString(),
      nonceHash: sha256(nonce),
      commandHash,
      timeoutMs: input.task.limits.timeoutMs,
      maxOutputBytes: prepared.maxOutputBytes,
    };
    writeTicket(ticketFile, ticket, true);
    const ticketHash = ticketReservationHash(ticket);

    supervisor = spawn(toolchain.node, [SUPERVISOR_FILE, ticketFile], {
      cwd: allocation.rootPath,
      env: safeEnvironment(),
      detached: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    let ready;
    try {
      ready = await waitForControl(supervisor.stdio[3], 'ready', READY_TIMEOUT_MS);
    } catch (error) {
      supervisor.stdin.destroy();
      if (supervisor.pid) await stopGroup(supervisor.pid);
      throw error;
    }
    if (
      ready.pid !== supervisor.pid ||
      ready.pgid !== supervisor.pid ||
      ready.nonceHash !== ticket.nonceHash ||
      ready.commandHash !== commandHash
    ) {
      supervisor.stdin.destroy();
      await stopGroup(supervisor.pid);
      fail('RUNNER_SUPERVISOR_IDENTITY', 'Supervisor identity не совпала');
    }
    const ticketRelative = path.relative(allocation.rootPath, ticketFile);
    const processMetadata = Object.freeze({
      version: 1,
      ticket: ticketRelative,
      supervisorPid: supervisor.pid,
      pgid: supervisor.pid,
      startedAt: ready.startedAt,
      nonceHash: ticket.nonceHash,
      commandHash,
      ticketHash,
    });
    writeTicket(ticketFile, {
      ...ticket,
      state: 'supervisor-ready',
      ...processMetadata,
      ticketHash,
    });
    try {
      await boundedCallback(onStart, processMetadata, READY_TIMEOUT_MS);
    } catch (error) {
      supervisor.stdin.destroy();
      const stopped = await stopGroup(supervisor.pid);
      return {
        exitCode: null,
        output: null,
        stopped,
        uncertain: !stopped,
        failureReason: 'START_NOT_ACKNOWLEDGED',
        durationMs: 0,
        process: processMetadata,
        execution: executionMetadata(prepared, null),
      };
    }

    try {
      if (prepared.reviewFile) verifyReviewEvidenceFile(prepared.reviewFile);
    } catch (error) {
      supervisor.stdin.destroy();
      const stopped = await stopGroup(supervisor.pid);
      return {
        exitCode: 1,
        output: null,
        stopped,
        uncertain: !stopped,
        failureReason: errorReason(error, 'REVIEW_EVIDENCE_INVALID'),
      };
    }
    const started = Date.now();
    supervisor.stdout.resume();
    supervisor.stderr.resume();
    const finalPromise = waitForControl(
      supervisor.stdio[3],
      'finished',
      input.task.limits.timeoutMs + STOP_GRACE_MS + 2_000,
    );
    let aborted = false;
    const abort = () => {
      aborted = true;
      stopGroup(supervisor.pid).catch(() => {});
    };
    if (signal?.aborted) {
      abort();
      supervisor.stdin.destroy();
    } else {
      signal?.addEventListener('abort', abort, { once: true });
      supervisor.stdin.write(
        `${JSON.stringify({ type: 'go', nonce, command: prepared.command, input: prepared.input })}\n`,
      );
    }

    let final = null;
    let stopped;
    let controlFailure = null;
    try {
      final = await finalPromise;
    } catch (error) {
      controlFailure = error;
    } finally {
      signal?.removeEventListener('abort', abort);
      supervisor.stdin.destroy();
      stopped = await stopGroup(supervisor.pid);
    }
    const durationMs = Date.now() - started;
    let output = final
      ? {
          stdoutDigest: final.stdoutDigest,
          stderrDigest: final.stderrDigest,
          stdoutBytes: final.stdoutBytes,
          stderrBytes: final.stderrBytes,
        }
      : null;
    if (action.id.startsWith('ai-') && final?.exitCode === 0 && !final.failureReason) {
      try {
        if (prepared.reviewFile) verifyReviewEvidenceFile(prepared.reviewFile);
        output = parseAiOutput(prepared.resultFile);
        if (
          prepared.reviewFile &&
          AIReviewResultSchema.parse(output).reviewEvidenceHash !== prepared.reviewFile.hash
        )
          fail('REVIEW_EVIDENCE_MISMATCH', 'Review output не совпадает с evidence');
      } catch (error) {
        controlFailure = error;
        output = null;
      }
    }
    try {
      if (prepared.reviewFile) verifyReviewEvidenceFile(prepared.reviewFile);
    } catch (error) {
      controlFailure = error;
      output = null;
    }
    const failureReason = aborted
      ? 'ABORTED'
      : (final?.failureReason ?? controlFailure?.code ?? controlFailure?.message ?? null);
    const uncertain =
      !stopped ||
      ['TIMEOUT', 'OUTPUT_LIMIT', 'PARENT_DISCONNECTED', 'ABORTED'].includes(failureReason);
    return {
      exitCode: controlFailure ? 1 : (final?.exitCode ?? null),
      output,
      stopped,
      uncertain,
      failureReason,
      timedOut: failureReason === 'TIMEOUT',
      outputLimit: failureReason === 'OUTPUT_LIMIT',
      durationMs,
      process: processMetadata,
      execution: executionMetadata(prepared, output),
    };
  } finally {
    // The parent FD is always released; files remain while descendant termination is unknown.
    let stopped = !supervisor?.pid;
    try {
      if (supervisor) supervisor.stdin.destroy();
      if (!stopped) stopped = await stopGroup(supervisor.pid);
    } finally {
      cleanupPrepared(prepared, stopped);
    }
  }
}

export function inspectProcess({ root, process: processMetadata }) {
  if (
    !isPlainObject(processMetadata) ||
    processMetadata.version !== 1 ||
    !Number.isInteger(processMetadata.supervisorPid) ||
    processMetadata.supervisorPid < 2 ||
    processMetadata.pgid !== processMetadata.supervisorPid ||
    !/^[a-f0-9]{64}$/.test(processMetadata.nonceHash) ||
    !/^[a-f0-9]{64}$/.test(processMetadata.commandHash) ||
    !/^[a-f0-9]{64}$/.test(processMetadata.ticketHash) ||
    typeof processMetadata.ticket !== 'string' ||
    !/^\.ai-orchestrator\/graph\/runner-tickets\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/.test(
      processMetadata.ticket,
    )
  ) {
    fail('RUNNER_PROCESS_INVALID', 'Некорректная process identity');
  }
  const rootPath = realDirectory(root, 'RUNNER_ROOT_INVALID');
  if (loadProjectProfile(rootPath).ai.provider === 'codex' && isSystemTemporary(rootPath))
    fail('RUNNER_TEMP_UNSAFE', 'Recovery root внутри системного temp запрещен');
  const ticketFile = path.resolve(rootPath, processMetadata.ticket);
  const graphRoot = assertPrivateDirectory(
    path.join(rootPath, '.ai-orchestrator', 'graph'),
    'RUNNER_STORAGE_INVALID',
  );
  assertNoSymlinkAncestors(rootPath, graphRoot, 'RUNNER_STORAGE_INVALID');
  const ticketRoot = assertPrivateDirectory(
    path.join(graphRoot, 'runner-tickets'),
    'RUNNER_TICKETS_INVALID',
  );
  assertNoSymlinkAncestors(graphRoot, ticketRoot, 'RUNNER_TICKETS_INVALID');
  if (!isWithin(ticketFile, ticketRoot))
    fail('RUNNER_TICKET_ESCAPE', 'Ticket вышел за control storage');
  assertNoSymlinkAncestors(ticketRoot, ticketFile, 'RUNNER_TICKET_UNSAFE');
  const ticket = readTicket(ticketFile);
  if (
    ticket.supervisorPid !== processMetadata.supervisorPid ||
    ticket.pgid !== processMetadata.pgid ||
    ticket.nonceHash !== processMetadata.nonceHash ||
    ticket.commandHash !== processMetadata.commandHash ||
    ticket.ticketHash !== processMetadata.ticketHash ||
    ticketReservationHash(ticket) !== processMetadata.ticketHash ||
    ticket.startedAt !== processMetadata.startedAt
  ) {
    fail('RUNNER_PROCESS_MISMATCH', 'Process identity не совпала с ticket');
  }
  const stopped = !groupAlive(processMetadata.pgid);
  return {
    stopped,
    reason: stopped
      ? ticket.state === 'finished'
        ? 'PROCESS_FINISHED'
        : 'PROCESS_GROUP_ABSENT'
      : 'PROCESS_GROUP_ALIVE',
    ...(ticket.state === 'finished'
      ? {
          result: {
            exitCode: ticket.exitCode ?? null,
            signal: ticket.signal ?? null,
            failureReason: ticket.failureReason ?? null,
            stdoutDigest: ticket.stdoutDigest,
            stderrDigest: ticket.stderrDigest,
            stdoutBytes: ticket.stdoutBytes,
            stderrBytes: ticket.stderrBytes,
          },
        }
      : {}),
  };
}

export async function probeRunner({ root }) {
  const details = {
    platform: `${process.platform}/${process.arch}`,
    node: { expectedMajor: 22, actual: null },
    codex: {
      expected: CODEX_VERSION,
      actual: null,
      authenticated: null,
    },
    pnpm: { expected: PNPM_VERSION, executableNotInvoked: true },
    sandbox: { permissionProfiles: false, networkDefault: 'denied' },
    toolchainDigest: null,
    limitations: [
      'Permission profiles are beta.',
      'System temp paths are not accepted as runtime allocations on macOS.',
      'Stopped means the supervised process group was observed absent; it is not proof about detached descendants.',
      'AI actions have read-only source access and return structured edits for a trusted parent to apply.',
      'Check descendant containment has not been verified and check capability is disabled.',
      'Authentication status is not inspected by this probe.',
      'Real AI inference is not part of this local capability probe.',
    ],
  };
  let profile;
  try {
    profile = loadProjectProfile(root);
  } catch (error) {
    return {
      ai: { available: false, reason: errorReason(error, 'PROJECT_PROFILE_INVALID') },
      checks: { available: false, reason: 'USE_DOCKER_PROBE' },
      details,
    };
  }
  if (profile.ai.provider === 'openai') {
    try {
      if (
        profile.ai.baseUrl &&
        profile.ai.baseUrl.replace(/\/$/, '') !== 'https://api.openai.com/v1'
      )
        fail('AI_ENDPOINT_UNSUPPORTED', 'Only official endpoint supported');
      const toolchain = runnerToolchain(profile);
      const keyPresent =
        typeof process.env.FLOWCAIRN_OPENAI_API_KEY === 'string' &&
        process.env.FLOWCAIRN_OPENAI_API_KEY.length > 0;
      return {
        ai: {
          available: keyPresent,
          reason: keyPresent ? 'LOCAL_OPENAI_WORKER_READY_REAL_AI_UNVERIFIED' : 'AI_AUTH_REQUIRED',
        },
        checks: { available: false, reason: 'USE_DOCKER_PROBE' },
        details: {
          provider: 'openai',
          platform: details.platform,
          toolchainDigest: toolchain.digest,
          limitations: [
            'Tool-free API worker; only bounded selected context is sent.',
            'Real AI and endpoint authentication have not been verified.',
            'Docker checks are probed separately.',
          ],
        },
      };
    } catch (error) {
      return {
        ai: { available: false, reason: errorReason(error, 'RUNNER_TOOLCHAIN_INVALID') },
        checks: { available: false, reason: 'USE_DOCKER_PROBE' },
        details,
      };
    }
  }
  if (process.platform !== 'darwin') {
    return {
      ai: { available: false, reason: 'UNSUPPORTED_PLATFORM' },
      checks: { available: false, reason: 'UNSUPPORTED_PLATFORM' },
      details,
    };
  }
  try {
    const rootPath = realDirectory(root, 'RUNNER_ROOT_INVALID');
    if (isSystemTemporary(rootPath)) throw new Error('SYSTEM_TEMP_UNSAFE');
  } catch (error) {
    const reason = errorReason(error, 'RUNNER_ROOT_INVALID');
    return {
      ai: { available: false, reason },
      checks: { available: false, reason },
      details,
    };
  }
  let toolchain;
  try {
    toolchain = runnerToolchain(profile);
    details.toolchainDigest = toolchain.digest;
  } catch (error) {
    const reason = errorReason(error, 'RUNNER_TOOLCHAIN_INVALID');
    return {
      ai: { available: false, reason },
      checks: { available: false, reason },
      details,
    };
  }
  if (!('codexEntry' in toolchain)) fail('RUNNER_TOOLCHAIN_INVALID', 'Codex toolchain required');
  const nodeVersion = spawnSync(toolchain.node, ['--version'], {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 512 * 1024,
    env: safeEnvironment(),
  });
  details.node.actual = typeof nodeVersion.stdout === 'string' ? nodeVersion.stdout.trim() : null;
  const codexVersion = spawnSync(toolchain.node, [toolchain.codexEntry, '--version'], {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 512 * 1024,
    env: aiEnvironment(),
  });
  details.codex.actual =
    typeof codexVersion.stdout === 'string' ? codexVersion.stdout.trim() : null;
  const execHelp = spawnSync(toolchain.node, [toolchain.codexEntry, 'exec', '--help'], {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 512 * 1024,
    env: aiEnvironment(),
  });
  const sandboxHelp = spawnSync(toolchain.node, [toolchain.codexEntry, 'sandbox', '--help'], {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 512 * 1024,
    env: aiEnvironment(),
  });
  const execText = typeof execHelp.stdout === 'string' ? execHelp.stdout : '';
  const sandboxText = typeof sandboxHelp.stdout === 'string' ? sandboxHelp.stdout : '';
  const execFlagsReady = [
    '--ignore-user-config',
    '--strict-config',
    '--ephemeral',
    '--output-schema',
    '--output-last-message',
  ].every((flag) => execText.includes(flag));
  details.sandbox.permissionProfiles = sandboxText.includes('--permission-profile');
  const binariesReady =
    nodeVersion.error === undefined &&
    codexVersion.error === undefined &&
    execHelp.error === undefined &&
    sandboxHelp.error === undefined &&
    regularExecutable(SANDBOX_EXEC) &&
    details.node.actual === process.version &&
    details.codex.actual === CODEX_VERSION &&
    execFlagsReady &&
    details.sandbox.permissionProfiles;
  return {
    ai: {
      available: binariesReady,
      reason: binariesReady
        ? 'LOCAL_AI_CLI_READY_AUTH_AND_REAL_AI_UNVERIFIED'
        : 'LOCAL_AI_CAPABILITY_UNAVAILABLE',
    },
    checks: {
      available: false,
      reason: 'CHECK_DESCENDANT_CONTAINMENT_UNVERIFIED',
    },
    details,
  };
}

// Pure preparation seam: tests inspect exact permissions/prompt without spawning external AI.
export const RUNNER_TESTING = Object.freeze({
  makeAiCommand,
  makeOpenAiCommand,
  selectedSourceContext,
  instructionDenials,
  discoverCodex,
  cleanupPrepared,
});
