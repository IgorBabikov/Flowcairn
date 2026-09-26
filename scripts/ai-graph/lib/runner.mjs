import { inspectHostProcess, stopHostGroup } from './host-process.mjs';
import { isPrivateMode, isTrustedMode, isPathWithin } from './host-filesystem.mjs';
import { assertSafeText } from './source-policy.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { GraphError, canonicalJson, sha256 } from './io.mjs';
import { MAX_CONTROL_BYTES, MAX_CONTROL_INPUT_BYTES, validCommand } from './supervisor-control.mjs';
import {
  resolveAction,
} from './registry.mjs';
import {
  AIReviewResultSchema,
  GraphPlanSchema,
  NodeDefinitionSchema,
  RelativePath,
  TaskSpecSchema,
  assertJsonBounds,
} from './schemas.mjs';
import {
  validateReviewEvidence,
  verifyReviewEvidenceFile,
} from './review-evidence.mjs';
import { verifyToolchain } from './toolchain.mjs';
import { hasTrustedLocalChecksBinding, loadProjectProfile, resolveProjectCheckScript, RUNTIME_ROOT } from './project.mjs';
import { providerToolchain } from './providers.mjs';
import { codexModelSettings } from './codex-settings.mjs';
import { managedProviderExecutable } from './managed-runtime.mjs';
import { buildProjectInstructionContext } from './project-instruction-context.mjs';
import { EXTERNAL_WORKER_FILE, MAX_AI_PROCESS_OUTPUT, assertNoSymlinkAncestors, safeEnvironment, aiEnvironment, createExclusiveFile, makeAiCommand, makeExternalCommand, instructionDenials, selectedSourceContext, cleanupPrepared, aiResponseSchema } from './runner-ai-command.mjs';

const NODE_BINARY = realpathSync(process.execPath);
const NODE_BIN = path.dirname(NODE_BINARY);
const PNPM_VERSION = '11.8.0';
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const SUPERVISOR_FILE = fileURLToPath(new URL('./supervisor.mjs', import.meta.url));
const MAX_AI_RESULT_BYTES = 2 * 1024 * 1024;
const MAX_TICKET_BYTES = 64 * 1024;
const MAX_TOOLCHAIN_FILE_BYTES = 512 * 1024 * 1024;
// Запуск AI может занимать заметное время; пять секунд превращали медленный
// старт supervisor в ложный неопределенный результат.
const SUPERVISOR_READY_TIMEOUT_MS = 30_000;
const STOP_GRACE_MS = process.platform === 'win32' ? 20_000 : 3_000;
const windowsSupervisors = new Map();
const require = createRequire(import.meta.url);

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
  return isPathWithin(root, candidate);
}

function isSystemTemporary(candidate) {
  const resolved = realpathSync(candidate);
  const roots = new Set(['/private/tmp', '/tmp', realpathSync(os.tmpdir())]);
  return [...roots].some((root) => isWithin(resolved, root));
}

function assertPrivateDirectory(candidate, code) {
  const resolved = realDirectory(candidate, code);
  const stat = statSync(resolved);
  if (!isPrivateMode(stat)) fail(code, `Каталог должен быть private (0700): ${candidate}`);
  return resolved;
}

function validateAllocation(root, worktree, outputDirectory, provider, direct = false) {
  const rootPath = realDirectory(root, 'RUNNER_ROOT_INVALID');
  if (provider === 'codex' && process.platform === 'darwin' && isSystemTemporary(rootPath)) {
    fail('RUNNER_TEMP_UNSAFE', 'Runtime root внутри системного temp не поддерживается на macOS');
  }
  const graphRoot = assertPrivateDirectory(
    path.join(rootPath, '.ai-orchestrator', 'graph'),
    'RUNNER_STORAGE_INVALID',
  );
  assertNoSymlinkAncestors(rootPath, graphRoot, 'RUNNER_STORAGE_INVALID');
  const workspaces = direct ? null : assertPrivateDirectory(
    path.join(rootPath, '.ai-orchestrator', 'worktrees'),
    'RUNNER_WORKSPACE_INVALID',
  );
  const worktreePath = realDirectory(worktree, 'RUNNER_WORKTREE_INVALID');
  if (
    (direct ? worktreePath !== rootPath : !isWithin(worktreePath, workspaces)) ||
    (provider === 'codex' && process.platform === 'darwin' && isSystemTemporary(worktreePath))
  ) {
    fail('RUNNER_WORKTREE_INVALID', 'Рабочий каталог не принадлежит текущему проекту');
  }
  if (!direct) assertNoSymlinkAncestors(workspaces, worktreePath, 'RUNNER_WORKTREE_INVALID');
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
      (process.platform === 'win32' || (stat.mode & 0o111) !== 0) &&
      isTrustedMode(stat) &&
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
      isTrustedMode(stat) &&
      (expectedOwner === undefined || stat.uid === 0 || stat.uid === expectedOwner)
    );
  } catch {
    return false;
  }
}

/** Runtime files may be hard-linked by a package manager or CI checkout. */
function trustedRuntimeReadable(candidate) {
  try {
    const resolved = realpathSync(candidate);
    const stat = statSync(resolved);
    const expectedOwner = process.getuid?.();
    return (
      resolved.startsWith(`${RUNTIME_ROOT}${path.sep}`) &&
      stat.isFile() &&
      isTrustedMode(stat) &&
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

function packageIdentity(packageRoot, expectedName) {
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
  if (
    parsed?.name !== expectedName ||
    typeof parsed.version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(parsed.version)
  ) {
    fail('RUNNER_TOOLCHAIN_INVALID', `Package manifest недопустим: ${expectedName}`);
  }
  return { manifest, version: parsed.version };
}

function codexCandidates(ai) {
  if (ai.codexPath) return [ai.codexPath];
  const managed = managedProviderExecutable('codex');
  let bundled;
  try {
    // Flowcairn ships the official CLI as a dependency. Resolve it through
    // Node's package graph so npm, pnpm and nested installs use the same
    // verified launcher without relying on PATH or a desktop app binary.
    bundled = require.resolve('@openai/codex/bin/codex.js');
  } catch {
    bundled = null;
  }
  const pathEntries = (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter((entry) => path.isAbsolute(entry) && entry.length > 1)
    .map((entry) => path.join(entry, process.platform === 'win32' ? 'codex.cmd' : 'codex'));
  return [...new Set([
    ...(managed ? [managed] : []),
    ...(bundled ? [bundled] : []),
    path.join(NODE_BIN, process.platform === 'win32' ? 'codex.cmd' : 'codex'),
    ...pathEntries,
    '/usr/local/bin/codex',
    '/opt/homebrew/bin/codex',
    '/usr/bin/codex',
  ])];
}

function discoverCodex(ai) {
  for (const candidate of codexCandidates(ai)) {
    try {
      if (!regularReadable(candidate)) continue;
      const entry = process.platform === 'win32' && /\.(cmd|ps1)$/i.test(candidate)
        ? realpathSync(path.join(path.dirname(candidate), 'node_modules', '@openai', 'codex', 'bin', 'codex.js'))
        : realpathSync(candidate);
      if (path.basename(entry) !== 'codex.js') continue;
      const root = path.resolve(path.dirname(entry), '..');
      return { root, entry, manifest: packageIdentity(root, '@openai/codex') };
    } catch {
      /* Try the next safe official-package candidate. */
    }
  }
  fail(
    'RUNNER_TOOLCHAIN_INVALID',
    'Не найдена безопасная npm-установка @openai/codex. Укажите ai.codexPath или установите официальный Codex CLI.',
  );
}

function codexHelp(entry, args, requiredFlags) {
  const result = spawnSync(NODE_BINARY, [entry, ...args], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 512 * 1024, env: aiEnvironment(), shell: false,
  });
  const output = typeof result.stdout === 'string' ? result.stdout : '';
  return result.error === undefined && result.status === 0 && requiredFlags.every((flag) => output.includes(flag));
}

function verifyCodexCapabilities(entry) {
  const execFlags = [
    '--ignore-rules',
    '--strict-config',
    '--ephemeral',
    '--skip-git-repo-check',
    '--json',
    '--output-schema',
    '--output-last-message',
    '--cd',
    '--config',
    '--model',
  ];
  if (!codexHelp(entry, ['exec', '--help'], execFlags) || !codexHelp(entry, ['sandbox', '--help'], ['--permission-profile'])) {
    fail('RUNNER_TOOLCHAIN_CAPABILITY', 'Codex CLI не поддерживает обязательные параметры изолированного запуска. Обновите Codex CLI или Flowcairn.');
  }
}

function runnerToolchain(profile) {
  if (!/^v22\./.test(process.version) || !regularExecutable(NODE_BINARY))
    fail('RUNNER_TOOLCHAIN_VERSION', 'Runner должен исполняться доверенным Node 22');
  if (profile.ai.provider === 'openai')
    fail('PROVIDER_RETIRED', 'OpenAI API больше не поддерживается. Выполните flowcairn setup и выберите Codex, Claude Code или Cursor.');
  if (['claude', 'cursor'].includes(profile.ai.provider)) {
    if (!['darwin', 'linux', 'win32'].includes(process.platform) || !trustedRuntimeReadable(EXTERNAL_WORKER_FILE))
      fail('RUNNER_PLATFORM_UNSUPPORTED', 'External CLI adapter требует macOS/Linux и trusted worker.');
    const provider = providerToolchain(profile.ai);
    const identity = { nodeVersion: process.version, nodeDigest: fileDigest(NODE_BINARY), provider: provider.provider, providerPath: provider.executable, providerVersion: provider.version, providerDigest: provider.digest, workerDigest: fileDigest(EXTERNAL_WORKER_FILE) };
    return Object.freeze({ node: NODE_BINARY, codexEntry: null, provider, digest: sha256(canonicalJson(identity)), identity: Object.freeze(identity) });
  }
  if (!['darwin', 'linux', 'win32'].includes(process.platform) || !['arm64', 'x64'].includes(process.arch))
    fail('RUNNER_PLATFORM_UNSUPPORTED', 'Нужен официальный Codex CLI для текущей ОС и архитектуры.');
  const codex = discoverCodex(profile.ai);
  const platformName = `${process.platform}-${process.arch}`;
  const cpu = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const triple = `${cpu}-${process.platform === 'darwin' ? 'apple-darwin' : process.platform === 'win32' ? 'pc-windows-msvc' : 'unknown-linux-musl'}`;
  let nativeRoot;
  try {
    nativeRoot = path.dirname(createRequire(codex.entry).resolve(`@openai/codex-${platformName}/package.json`));
  } catch {
    fail('RUNNER_TOOLCHAIN_INVALID', 'Нативный пакет Codex не установлен. Повторите установку Flowcairn с optional dependencies.');
  }
  const nativeManifest = packageIdentity(nativeRoot, '@openai/codex');
  if (nativeManifest.version !== `${codex.manifest.version}-${platformName}`)
    fail('RUNNER_TOOLCHAIN_INVALID', 'Нативный пакет Codex не соответствует версии CLI');
  const native = path.join(nativeRoot, 'vendor', triple, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
  if (!regularExecutable(native))
    fail('RUNNER_TOOLCHAIN_INVALID', 'Codex native binary небезопасен');
  verifyCodexCapabilities(codex.entry);
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

function codexLoginAvailable(entry) {
  const run = spawnSync(NODE_BINARY, [entry, 'login', 'status'], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024, env: aiEnvironment(), shell: false,
  });
  if (run.error || run.status !== 0)
    fail('CODEX_AUTH_REQUIRED', 'Codex не авторизован. Выполните codex login и повторите.');
}

/** Explicit interactive login only; credentials remain owned by the official CLI. */
export async function loginCodex(ai = {}) {
  const toolchain = runnerToolchain({ ai: { ...ai, provider: 'codex' } });
  await new Promise((resolve, reject) => {
    const child = spawn(toolchain.node, [toolchain.codexEntry, 'login'], {
      stdio: 'inherit', env: aiEnvironment(), shell: false,
    });
    const timeout = setTimeout(() => child.kill('SIGTERM'), 5 * 60_000);
    child.once('error', () => {
      clearTimeout(timeout);
      reject(new GraphError('CODEX_AUTH_REQUIRED', 'Не удалось открыть вход в Codex. Повторите npx flowcairn.'));
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(undefined);
      else reject(new GraphError('CODEX_AUTH_REQUIRED', 'Вход в Codex не завершен. Повторите npx flowcairn.'));
    });
  });
  codexLoginAvailable(toolchain.codexEntry);
}

function localCheckToolchain(profile) {
  let runningNode;
  try { runningNode = statSync(NODE_BINARY); } catch { runningNode = null; }
  // Node is the already-running flowcairn process. Managed distributions may
  // hard-link it, so nlink is not a security signal here. Ownership, mode and
  // the immutable digest recorded below remain required.
  if (!/^v22\./.test(process.version))
    fail('LOCAL_CHECK_NODE_VERSION', 'Локальные проверки требуют Node 22');
  if (!runningNode?.isFile())
    fail('LOCAL_CHECK_NODE_FILE', 'Node для локальных проверок не является обычным файлом');
  if (process.platform !== 'win32' && ((runningNode.mode & 0o111) === 0 || (runningNode.mode & 0o002) !== 0))
    fail('LOCAL_CHECK_NODE_MODE', 'Node для локальных проверок имеет небезопасные права');
  if (process.getuid?.() !== undefined && runningNode.uid !== 0 && runningNode.uid !== process.getuid?.())
    fail('LOCAL_CHECK_NODE_OWNER', 'Node для локальных проверок принадлежит неизвестному владельцу');
  const candidate = process.platform === 'win32'
    ? path.join(NODE_BIN, 'node_modules', profile.packageManager, 'bin', `${profile.packageManager === 'npm' ? 'npm-cli.js' : profile.packageManager + '.cjs'}`)
    : path.join(NODE_BIN, profile.packageManager);
  let entry;
  try { entry = realpathSync(candidate); } catch { fail('LOCAL_CHECK_TOOLCHAIN', `Не найден ${profile.packageManager} из Node 22`); }
  const nodeRoot = path.resolve(NODE_BIN, '..');
  let stat;
  try { stat = statSync(entry); } catch { fail('LOCAL_CHECK_TOOLCHAIN', `Недоступен безопасный ${profile.packageManager} из Node 22`); }
  if (!isWithin(entry, nodeRoot) || !stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o002) !== 0))
    fail('LOCAL_CHECK_MANAGER_UNSAFE', `Недоступен безопасный ${profile.packageManager} из Node 22`);
  const identity = {
    kind: 'local-worktree',
    nodeVersion: process.version,
    nodeDigest: fileDigest(NODE_BINARY),
    packageManager: profile.packageManager,
    packageManagerDigest: fileDigest(entry),
  };
  return Object.freeze({ node: NODE_BINARY, entry, digest: sha256(canonicalJson(identity)), identity });
}

function makeLocalCheckCommand({ root, worktree, node, profile, toolchain, dependencyToolchain, outputPath }) {
  const script = resolveProjectCheckScript(root, node.action.id, profile);
  return {
    command: {
      executable: toolchain.node,
      args: [toolchain.entry, 'run', script],
      cwd: worktree,
      env: safeEnvironment({
        HOME: outputPath,
        NPM_CONFIG_CACHE: path.join(outputPath, 'npm-cache'),
        NPM_CONFIG_USERCONFIG: os.devNull,
        NPM_CONFIG_UPDATE_NOTIFIER: 'false',
        NPM_CONFIG_FUND: 'false',
        NPM_CONFIG_AUDIT: 'false',
      }),
    },
    input: '',
    maxOutputBytes: MAX_AI_PROCESS_OUTPUT,
    execution: Object.freeze({
      kind: 'local-check',
      isolation: 'trusted-project-process',
      actionId: node.action.id,
      packageManager: profile.packageManager,
      script,
      toolchainDigest: toolchain.digest,
      dependencyToolchain: dependencyToolchain.hash,
    }),
  };
}

/** Checks never receive a task command: only profile-bound package scripts can run. */
export function probeLocalChecks({ root }) {
  try {
    const profile = loadProjectProfile(root);
    if (!['trusted-local', 'hardened'].includes(profile.checkMode))
      return { available: false, reason: profile.checkMode === 'local' ? 'LOCAL_CHECK_RECONFIGURATION_REQUIRED' : 'CHECKS_NOT_ENABLED', mode: 'trusted-local' };
    if (!hasTrustedLocalChecksBinding(root, profile))
      return { available: false, reason: 'CHECK_LOCAL_BINDING_REQUIRED', mode: 'trusted-local' };
    localCheckToolchain(profile);
    for (const id of profile.checks) resolveProjectCheckScript(root, `check-${id}`, profile);
    return { available: true, reason: null, mode: 'local' };
  } catch (error) {
    return { available: false, reason: errorReason(error, 'LOCAL_CHECK_UNAVAILABLE'), mode: 'local' };
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
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !isPrivateMode(stat)) {
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

function waitForControl(stream, expectedType, timeoutMs, {
  child = null,
  timeoutCode = 'RUNNER_CONTROL_TIMEOUT',
  timeoutMessage = 'Supervisor не ответил',
} = {}) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const timer = setTimeout(() => finish(reject, new GraphError(timeoutCode, timeoutMessage)), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      stream.off('data', onData);
      stream.off('error', onError);
      stream.off('end', onEnd);
      stream.off('close', onEnd);
      child?.off('error', onChildError);
      child?.off('close', onChildClose);
    };
    const onError = (error) => finish(reject, error);
    const onEnd = () => finish(reject, new GraphError(
      'RUNNER_CONTROL_CLOSED',
      `Supervisor закрыл control channel до ${expectedType}`,
    ));
    const onChildError = (error) => finish(reject, new GraphError(
      'RUNNER_SUPERVISOR_ERROR',
      errorReason(error, 'Supervisor не запустился'),
    ));
    const onChildClose = (code, signal) => finish(reject, new GraphError(
      'RUNNER_SUPERVISOR_EXIT',
      `Supervisor завершился до ${expectedType}: code=${String(code)} signal=${String(signal)}`,
    ));
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer) > MAX_TICKET_BYTES) {
        finish(reject, new GraphError('RUNNER_CONTROL_LIMIT', 'Supervisor control output слишком велик'));
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
          finish(
            reject,
            new GraphError('RUNNER_CONTROL_INVALID', 'Supervisor вернул invalid control JSON'),
          );
          return;
        }
        if (value.type === expectedType) {
          finish(resolve, value);
          return;
        }
        if (value.type === 'supervisor-error') {
          const inspectionFailures = new Set(['WINDOWS_SYSTEM_ROOT', 'WINDOWS_SYSTEM_TOOL', 'PROCESS_IDENTITY_UNKNOWN', 'PROCESS_INSPECTION_FAILED', 'PROCESS_INSPECTION_TIMEOUT', 'PROCESS_INSPECTION_SPAWN_FAILED', 'PROCESS_INSPECTION_EXIT_FAILED', 'PROCESS_INSPECTION_OUTPUT_INVALID']);
          const reason = inspectionFailures.has(value.reason) ? value.reason : 'RUNNER_SUPERVISOR_ERROR';
          finish(reject, new GraphError(reason, 'Supervisor не прошел проверку запуска.'));
          return;
        }
      }
    };
    stream.on('data', onData);
    stream.once('error', onError);
    stream.once('end', onEnd);
    stream.once('close', onEnd);
    child?.once('error', onChildError);
    child?.once('close', onChildClose);
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
  if (process.platform === 'win32') {
    const registered = windowsSupervisors.get(pgid);
    if (!registered) {
      try {
        const identity = inspectHostProcess(pgid);
        if (!identity) return true; // Before GO there is no action or child job.
        return identity.parentPid === process.pid && stopHostGroup(pgid, { identity });
      } catch { return false; }
    }
    try {
      const ticket = readTicket(registered.ticketFile);
      if (ticket.nonceHash !== registered.nonceHash || ticket.commandHash !== registered.commandHash) return false;
      if (ticket.state === 'finished' && ticket.windowsJobBound === true && ticket.windowsJobReaped === true) {
        if (!inspectHostProcess(pgid)) return true;
      }
      return stopHostGroup(pgid, { identity: registered.identity });
    } catch { return false; }
  }
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

function executionMetadata(prepared, output, usage = null) {
  return Object.freeze({
    ...prepared.execution,
    usage,
    outputDigest: sha256(canonicalJson(output)),
  });
}

async function stoppedPreflightResult({ supervisor, ticketFile, prepared, error, processMetadata = null }) {
  // До отправки GO результат можно безопасно классифицировать как известный
  // preflight failure, если группа supervisor действительно остановлена.
  supervisor?.stdin.destroy();
  const stopped = !supervisor?.pid || await stopGroup(supervisor.pid);
  let ticket = null;
  try { ticket = readTicket(ticketFile); } catch { /* The parent still knows GO was never sent. */ }
  return {
    exitCode: stopped ? 1 : null,
    output: null,
    stopped,
    uncertain: !stopped,
    failureReason: typeof ticket?.failureReason === 'string'
      ? ticket.failureReason
      : errorReason(error, 'START_NOT_ACKNOWLEDGED'),
    durationMs: 0,
    ...(processMetadata ? { process: processMetadata } : {}),
    execution: {
      ...executionMetadata(prepared, null),
      kind: 'preflight',
      processStarted: false,
      stage: 'supervisor-start',
    },
  };
}

function parseAiOutput(file) {
  const stat = lstatSync(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    !isPrivateMode(stat) ||
    stat.size > MAX_AI_RESULT_BYTES
  ) {
    fail('AI_OUTPUT_INVALID', 'AI output отсутствует или превышает лимит');
  }
  const text = readFileSync(file, 'utf8');
  assertSafeText(text);
  const output = JSON.parse(text);
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
  providerConsent = null,
}) {
  const action = resolveAction(node?.action?.id, node?.action?.version, node?.action?.inputs);
  if (!action.id.startsWith('ai-') && !action.id.startsWith('check-')) {
    fail('RUNNER_ACTION_UNSUPPORTED', `Runner не исполняет action ${action.id}`);
  }
  if (typeof onStart !== 'function') fail('RUNNER_START_CALLBACK_REQUIRED', 'onStart обязателен');
  const input = parseInputs({ node, task, plan, skills, priorEvidence, reviewEvidence });
  const profile = loadProjectProfile(root);
  const localCheck = ['check-typecheck', 'check-lint', 'check-tests', 'check-build'].includes(action.id);
  if (localCheck && !hasTrustedLocalChecksBinding(root, profile))
    fail('CHECK_LOCAL_BINDING_REQUIRED', 'trusted-local требует актуальную привязку exact scripts текущего профиля.');
  const allocation = validateAllocation(root, worktree, outputDirectory, localCheck ? 'local' : profile.ai.provider,
    profile.workspaceMode === 'direct');
  if (action.id.startsWith('check-') && !localCheck)
    fail('RUNNER_CHECK_CONTAINMENT_UNAVAILABLE', 'Незарегистрированная project-проверка не исполняется локально.');
  const toolchain = localCheck ? localCheckToolchain(profile) : runnerToolchain(profile);
  const dependencyToolchain = verifyToolchain({
    root: allocation.rootPath,
    worktree: allocation.worktreePath,
    manifest: toolchainManifest,
  });
  const prepare = localCheck
    ? makeLocalCheckCommand
    : ['claude', 'cursor'].includes(profile.ai.provider) ? makeExternalCommand : makeAiCommand;
  const prepared = prepare({
    ...input,
    root: allocation.rootPath,
    profile,
    worktree: allocation.worktreePath,
    outputPath: allocation.outputPath,
    toolchain,
    dependencyToolchain,
    providerConsent,
    projectInstructions: localCheck ? null : buildProjectInstructionContext({
      projectRoot: allocation.rootPath, node: input.node, task: input.task, profile,
      expectedMetadata: input.priorEvidence?.instructionMetadata ?? [],
    }),
  });
  let supervisor;
  try {
    if (!validCommand(prepared.command) || typeof prepared.input !== 'string' ||
        Buffer.byteLength(prepared.input) > MAX_CONTROL_INPUT_BYTES)
      fail('RUNNER_CONTROL_INVALID', 'AI-команда не помещается в ограниченный протокол запуска');
    const controlBytes = Buffer.byteLength(JSON.stringify({
      type: 'go', nonce: '0'.repeat(64), command: prepared.command, input: prepared.input,
    })) + 1;
    if (controlBytes > MAX_CONTROL_BYTES)
      fail('RUNNER_CONTROL_LIMIT', 'AI-команда и контекст превышают лимит протокола запуска');
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
      ready = await waitForControl(supervisor.stdio[3], 'ready', SUPERVISOR_READY_TIMEOUT_MS, {
        child: supervisor,
        timeoutCode: 'RUNNER_READY_TIMEOUT',
        timeoutMessage: 'Supervisor не подтвердил готовность к запуску',
      });
    } catch (error) {
      return await stoppedPreflightResult({ supervisor, ticketFile, prepared, error });
    }
    if (
      ready.pid !== supervisor.pid ||
      ready.pgid !== supervisor.pid ||
      ready.nonceHash !== ticket.nonceHash ||
      ready.commandHash !== commandHash
    ) {
      return await stoppedPreflightResult({
        supervisor,
        ticketFile,
        prepared,
        error: new GraphError('RUNNER_SUPERVISOR_IDENTITY', 'Supervisor identity не совпала'),
      });
    }
    if (process.platform === 'win32') {
      if (!ready.processIdentity || ready.processIdentity.pid !== supervisor.pid)
        fail('RUNNER_SUPERVISOR_IDENTITY', 'Windows process identity отсутствует.');
      windowsSupervisors.set(supervisor.pid, { identity: ready.processIdentity, ticketFile, nonceHash: ticket.nonceHash, commandHash });
    }
    const ticketRelative = path.relative(allocation.rootPath, ticketFile).split(path.sep).join('/');
    const processMetadata = Object.freeze({
      version: 1,
      ticket: ticketRelative,
      supervisorPid: supervisor.pid,
      pgid: supervisor.pid,
      startedAt: ready.startedAt,
      ...(ready.processIdentity ? { processIdentity: ready.processIdentity } : {}),
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
      const callbackResult = onStart(processMetadata);
      if (callbackResult && typeof callbackResult.then === 'function')
        fail('RUNNER_START_CALLBACK_ASYNC', 'onStart должен синхронно сохранить durable state');
    } catch (error) {
      return await stoppedPreflightResult({ supervisor, ticketFile, prepared, error, processMetadata });
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
      {
        child: supervisor,
        timeoutCode: 'RUNNER_RESULT_TIMEOUT',
        timeoutMessage: 'Supervisor не сохранил конечный результат вовремя',
      },
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
    // The control pipe can close before its last frame is observed. A finished,
    // identity-checked durable ticket is authoritative after the process group stops.
    if (!final && stopped) {
      try {
        const replay = inspectProcess({ root: allocation.rootPath, process: processMetadata });
        if (replay.stopped && replay.result) {
          final = replay.result;
          controlFailure = null;
        }
      } catch { /* Keep the original control failure when durable proof is unavailable. */ }
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
    const uncertain = !stopped;
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
      execution: executionMetadata(prepared, output, final?.usage ?? null),
    };
  } finally {
    // The parent FD is always released; files remain while descendant termination is unknown.
    let stopped = !supervisor?.pid;
    try {
      if (supervisor) supervisor.stdin.destroy();
      if (!stopped) stopped = await stopGroup(supervisor.pid);
    } finally {
      cleanupPrepared(prepared, stopped);
      if (stopped && supervisor?.pid) windowsSupervisors.delete(supervisor.pid);
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
  if (process.platform === 'darwin' && loadProjectProfile(rootPath).ai.provider === 'codex' && isSystemTemporary(rootPath))
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
  let stopped;
  if (process.platform === 'win32') {
    if (canonicalJson(ticket.processIdentity) !== canonicalJson(processMetadata.processIdentity))
      fail('RUNNER_PROCESS_MISMATCH', 'Windows identity не совпала с ticket.');
    try { stopped = ticket.state === 'finished' && ticket.windowsJobBound === true && ticket.windowsJobReaped === true && !inspectHostProcess(processMetadata.pgid); }
    catch { stopped = false; }
  } else stopped = !groupAlive(processMetadata.pgid);
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
      requirement: 'изолированный запуск с необходимыми параметрами',
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
      'Project checks run as trusted local processes; this is not an isolation boundary.',
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
      checks: { available: false, reason: 'USE_NATIVE_CHECK_PROBE' },
      details,
    };
  }
  if (profile.ai.provider === 'openai')
    return {
      ai: { available: false, reason: 'PROVIDER_RETIRED' },
      checks: { available: false, reason: 'USE_NATIVE_CHECK_PROBE' },
      details,
    };
  if (['claude', 'cursor'].includes(profile.ai.provider)) {
    try {
      const toolchain = runnerToolchain(profile);
      const external = 'provider' in toolchain ? toolchain.provider : null;
      if (!external) fail('RUNNER_TOOLCHAIN_INVALID', 'External CLI toolchain отсутствует.');
      return {
        ai: {
          available: true,
          reason: 'LOCAL_EXTERNAL_CLI_READY_AUTH_AND_REAL_AI_UNVERIFIED',
        },
        checks: { available: false, reason: 'USE_NATIVE_CHECK_PROBE' },
        details: {
          provider: external.provider,
          platform: details.platform,
          toolchainDigest: toolchain.digest,
          limitations: [
            'Точная версия и безопасные non-interactive параметры CLI проверены локально.',
            'Аутентификация и реальный AI-вызов проверяются только при явном запуске после consent.',
            'Локальные проверки диагностируются отдельно; Docker не используется.',
          ],
        },
      };
    } catch (error) {
      return {
        ai: { available: false, reason: errorReason(error, 'RUNNER_TOOLCHAIN_INVALID') },
        checks: { available: false, reason: 'USE_NATIVE_CHECK_PROBE' },
        details,
      };
    }
  }
  if (!['darwin', 'linux', 'win32'].includes(process.platform)) {
    return {
      ai: { available: false, reason: 'UNSUPPORTED_PLATFORM' },
      checks: { available: false, reason: 'UNSUPPORTED_PLATFORM' },
      details,
    };
  }
  try {
    const rootPath = realDirectory(root, 'RUNNER_ROOT_INVALID');
    if (process.platform === 'darwin' && isSystemTemporary(rootPath)) throw new Error('SYSTEM_TEMP_UNSAFE');
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
    if (profile.ai.modelMode === 'provider' || profile.ai.model === 'provider-default') codexModelSettings();
    codexLoginAvailable(toolchain.codexEntry);
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
  const binariesReady =
    nodeVersion.error === undefined &&
    codexVersion.error === undefined &&
    (process.platform !== 'darwin' || regularExecutable(SANDBOX_EXEC)) &&
    details.node.actual === process.version &&
    details.codex.actual === `codex-cli ${Reflect.get(toolchain.identity, 'codexVersion')}`;
  details.sandbox.permissionProfiles = binariesReady;
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
  aiResponseSchema,
  makeAiCommand,
  makeLocalCheckCommand,
  makeExternalCommand,
  selectedSourceContext,
  instructionDenials,
  discoverCodex,
  cleanupPrepared,
  waitForControl,
});

export function inspectCodexInstallation(ai = {}) {
  try {
    const toolchain = runnerToolchain({ ai: { ...ai, provider: 'codex' } });
    codexLoginAvailable(toolchain.codexEntry);
    return { available: true, reason: null, version: Reflect.get(toolchain.identity, 'codexVersion') };
  } catch (error) {
    return { available: false, reason: errorReason(error, 'RUNNER_TOOLCHAIN_INVALID'), version: null };
  }
}
