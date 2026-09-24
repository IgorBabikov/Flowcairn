import { hasSecretContent, isSensitivePath } from './source-policy.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { GraphError, canonicalJson, hashObject, sha256 } from './io.mjs';
import { physicalDirectory, readStopProof, stopProofPath, terminalEvidence, writeStopProof } from './docker-stop-proof.mjs';

function dockerExecutable() {
  const explicit = process.env.FLOWCAIRN_DOCKER_PATH;
  const candidates = explicit
    ? [explicit]
    : [
        '/usr/local/bin/docker',
        '/usr/bin/docker',
        '/opt/homebrew/bin/docker',
        '/Applications/Docker.app/Contents/Resources/bin/docker',
      ];
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    try {
      const resolved = realpathSync(candidate);
      const stat = lstatSync(resolved);
      if (
        stat.isFile() &&
        stat.nlink === 1 &&
        stat.mode & 0o111 &&
        !(stat.mode & 0o022) &&
        (stat.uid === 0 || stat.uid === process.getuid?.())
      )
        return resolved;
    } catch {
      /* Try only trusted fixed installations. */
    }
  }
  fail('DOCKER_UNAVAILABLE', 'Доверенный Docker executable не найден');
}
const CONTAINER_LABEL = 'com.flowcairn.check-container';
const MAX_DOCKER_OUTPUT = 16 * 1024 * 1024;
const MAX_LOG_OUTPUT = 8 * 1024 * 1024;
const RESULT_PREFIX = 'FLOWCAIRN_CHECK_RESULT ';
const STOP_TIMEOUT_MS = 15_000;
const CREATE_PREPARATION_TIMEOUT_MS = 120_000;
const CREATE_RECONCILIATION_TIMEOUT_MS = 30_000;
const CREATE_RECONCILIATION_INTERVAL_MS = 250;
const CREATE_INSPECT_TIMEOUT_MS = 2_000;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const IMAGE_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const CONTAINER_ID_PATTERN = /^[a-f0-9]{64}$/;
const ATTEMPT_ID_PATTERN = /^[a-z][a-z0-9-]{1,79}$/;
const CHECK_ACTIONS = new Set(['check-typecheck', 'check-lint', 'check-tests', 'check-build']);

function fail(code, message, details) {
  throw new GraphError(code, message, details);
}

function repositoryRoot(root) {
  return physicalDirectory(root, 'INVALID_CHECK_ROOT');
}

function dockerEnvironment(socket) {
  return Object.freeze({
    DOCKER_HOST: `unix://${socket}`,
    HOME: '/var/empty',
    PATH: '/usr/local/bin:/usr/bin:/bin',
  });
}

function localDockerEnvironment() {
  const candidates = [
    '/var/run/docker.sock',
    path.join(homedir(), '.docker', 'run', 'docker.sock'),
  ];
  for (const candidate of candidates) {
    try {
      const socket = realpathSync(candidate);
      if (!lstatSync(socket).isSocket()) continue;
      return dockerEnvironment(socket);
    } catch {
      // Only fixed local Unix sockets are eligible; inherited Docker routing is never used.
    }
  }
  fail('DOCKER_UNAVAILABLE', 'Локальный Docker Unix socket недоступен');
}

function docker(
  args,
  { allowFailure = false, timeout = 30_000, maxBuffer = MAX_DOCKER_OUTPUT } = {},
) {
  const result = spawnSync(dockerExecutable(), args, {
    encoding: 'utf8',
    env: localDockerEnvironment(),
    shell: false,
    timeout,
    maxBuffer,
  });
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  if (
    result.error ||
    result.signal ||
    (!allowFailure && result.status !== 0) ||
    stdout.length > maxBuffer ||
    stderr.length > maxBuffer
  ) {
    fail('DOCKER_COMMAND_FAILED', `Docker command failed: ${args[0]}`, {
      status: result.status,
      signal: result.signal,
    });
  }
  return { ...result, stdout, stderr };
}

function dockerServerAvailable() {
  try {
    const result = docker(['version', '--format', '{{.Server.Version}}'], {
      allowFailure: true,
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    return (
      !result.error &&
      !result.signal &&
      result.status === 0 &&
      /^\d+\.\d+\.\d+/.test(result.stdout.trim())
    );
  } catch {
    return false;
  }
}

function boundedDockerDiagnostic(result, fallback, redactions = []) {
  let value = [result?.stderr, result?.stdout]
    .filter((part) => typeof part === 'string' && part.trim())
    .join('\n')
    // eslint-disable-next-line no-control-regex -- Docker diagnostics must remove ANSI escape bytes.
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  if (hasSecretContent(value)) return fallback;
  for (const secret of [...redactions].filter(Boolean).sort((a, b) => b.length - a.length)) {
    value = value.replaceAll(secret, '<host-path>');
  }
  value = value
    .replace(
      /\b(authorization|bearer|token|secret|password|api[-_]?key)\b\s*[:=]\s*\S+/gi,
      '$1=<redacted>',
    )
    .replace(/https?:\/\/\S+/gi, '<url>')
    .replace(/\b[A-Za-z0-9+/_=-]{40,}\b/g, '<redacted>');
  const diagnostic = value
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(-4)
    .join('\n')
    .slice(0, 1_000);
  return diagnostic ? `${fallback}: ${diagnostic}` : fallback;
}

/** Retired backend: new attempts never inspect a project or contact Docker. */
export function probeChecks(_input = {}) {
  return { available: false, reason: 'CHECK_BACKEND_RETIRED' };
}

export function prepareCheckImage(_input = {}) {
  fail('CHECK_BACKEND_RETIRED', 'Новые Docker-проверки отключены. Используйте локальные проверки проекта.');
}

function validateFingerprint(before) {
  if (
    !before ||
    !HASH_PATTERN.test(before.hash) ||
    !Array.isArray(before.files) ||
    before.files.length > 20_000
  ) {
    fail('INVALID_CHECK_FINGERPRINT', 'Before fingerprint недопустим');
  }
  const seen = new Set();
  let total = 0;
  const files = before.files.map((file) => {
    if (
      !file ||
      typeof file.path !== 'string' ||
      !file.path ||
      Object.keys(file).sort().join(',') !== 'hash,mode,path,size' ||
      file.path.length > 512 ||
      Buffer.byteLength(file.path) > 4096 ||
      file.path.includes('\0') ||
      file.path.includes('\\') ||
      file.path.startsWith('/') ||
      file.path
        .split('/')
        .some(
          (part) =>
            !part ||
            part === '.' ||
            part === '..' ||
            ['.git', '.ai-orchestrator', 'node_modules'].includes(part.toLowerCase()),
        ) ||
      isSensitivePath(file.path) ||
      !HASH_PATTERN.test(file.hash) ||
      !['100644', '100755'].includes(file.mode) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > 64 * 1024 * 1024 ||
      seen.has(file.path)
    ) {
      fail('INVALID_CHECK_FINGERPRINT', 'Before fingerprint file недопустим');
    }
    seen.add(file.path);
    total += file.size;
    if (total > 512 * 1024 * 1024) {
      fail('INVALID_CHECK_FINGERPRINT', 'Before fingerprint превышает лимит');
    }
    return { path: file.path, hash: file.hash, mode: file.mode, size: file.size };
  });
  return files;
}

function actualSecurity(container) {
  const host = container?.HostConfig ?? {};
  return {
    networkMode: host.NetworkMode,
    capDrop: [...(host.CapDrop ?? [])].sort(),
    securityOpt: [...(host.SecurityOpt ?? [])].sort(),
    pidMode: host.PidMode,
    pidsLimit: host.PidsLimit,
    memory: host.Memory,
    memorySwap: host.MemorySwap,
    readOnly: host.ReadonlyRootfs,
    privileged: host.Privileged,
    user: container?.Config?.User,
    command: container?.Config?.Cmd,
    logDriver: host.LogConfig?.Type,
    logOptions: host.LogConfig?.Config,
    tmpfs: host.Tmpfs,
    mounts: (container?.Mounts ?? [])
      .map((mount) => ({
        destination: mount.Destination,
        rw: mount.RW,
        source: mount.Type === 'bind' ? mount.Source : null,
        type: mount.Type,
      }))
      .sort((left, right) => left.destination.localeCompare(right.destination)),
  };
}

function readContainer(reference, timeout = 15_000) {
  let result;
  try {
    result = docker(['container', 'inspect', reference], {
      allowFailure: true,
      timeout,
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch {
    return null;
  }
  if (result.status !== 0 || result.error || result.signal) return null;
  let values;
  try {
    values = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(values) || values.length !== 1) return null;
  return values[0];
}

function classifyCreatedContainer(value, expected) {
  if (!value) return { status: 'absent', value: null };
  const labels = value?.Config?.Labels ?? {};
  const neverStarted =
    value.State?.Running === false &&
    value.State?.Status === 'created' &&
    value.State?.Pid === 0 &&
    /^0001-01-01T00:00:00(?:\.0+)?Z$/.test(value.State?.StartedAt ?? '');
  if (
    !CONTAINER_ID_PATTERN.test(value.Id) ||
    value.Image !== expected.imageId ||
    value.Name !== `/${expected.name}` ||
    !neverStarted ||
    Object.entries(expected.labels).some(([key, wanted]) => labels[key] !== wanted) ||
    hashObject(actualSecurity(value)) !== expected.securityHash
  ) {
    return { status: 'foreign', value };
  }
  return { status: 'match', value };
}

function inspectCreatedContainer(reference, expected, timeout = 15_000) {
  return classifyCreatedContainer(readContainer(reference, timeout), expected);
}

function confirmCreatedBeforeStart(reference, expected, read = readContainer) {
  const result = classifyCreatedContainer(read(reference), expected);
  if (result.status === 'match' && result.value.Id !== reference) {
    return { status: 'foreign', value: result.value };
  }
  return result;
}

function waitForReconciliation(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function reconcileCreatedContainer(
  reference,
  expected,
  {
    budgetMs = CREATE_RECONCILIATION_TIMEOUT_MS,
    inspect = inspectCreatedContainer,
    now = Date.now,
    wait = waitForReconciliation,
  } = {},
) {
  const deadline = now() + budgetMs;
  while (true) {
    const remaining = deadline - now();
    if (remaining <= 0) return { status: 'timeout', value: null };
    const result = inspect(reference, expected, Math.min(CREATE_INSPECT_TIMEOUT_MS, remaining));
    if (result.status !== 'absent') return result;
    const afterInspect = deadline - now();
    if (afterInspect <= 0) return { status: 'timeout', value: null };
    await wait(Math.min(CREATE_RECONCILIATION_INTERVAL_MS, afterInspect));
  }
}

function inspectContainer(containerId, metadata) {
  const value = readContainer(containerId);
  if (!value) return null;
  const labels = value?.Config?.Labels ?? {};
  if (
    value.Id !== containerId ||
    value.Image !== metadata.imageId ||
    value.Name !== `/${metadata.name}` ||
    Object.entries(metadata.labels).some(([key, expected]) => labels[key] !== expected)
  ) {
    return null;
  }
  if (hashObject(actualSecurity(value)) !== metadata.securityHash) return null;
  return value;
}

function removeContainer(containerId, { force = false } = {}) {
  const args = ['container', 'rm', '--volumes'];
  if (force) args.push('--force');
  args.push(containerId);
  try {
    const result = docker(args, { allowFailure: true, timeout: STOP_TIMEOUT_MS });
    return !result.error && !result.signal && result.status === 0;
  } catch {
    return false;
  }
}

function stopContainer(containerId) {
  try {
    docker(['container', 'kill', containerId], {
      allowFailure: true,
      timeout: STOP_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
    });
  } catch {
    // Recovery below relies on inspect/wait evidence, so kill transport errors stay non-terminal.
  }
}

function waitContainer(containerId, timeoutMs = STOP_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn(dockerExecutable(), ['container', 'wait', containerId], {
      env: localDockerEnvironment(),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderrBytes = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 64 * 1024) child.kill('SIGKILL');
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 64 * 1024) child.kill('SIGKILL');
    });
    child.on('error', () => finish(null));
    child.on('close', (code, signal) => {
      const value = stdout.trim();
      finish(
        code === 0 && !signal && /^\d{1,3}$/.test(value)
          ? { exitCode: Number.parseInt(value, 10) }
          : null,
      );
    });
  });
}

function parseCheckResult(stdout, expectedExitCode) {
  const lines = stdout.trim().split(/\r?\n/);
  if (lines.length !== 1 || !lines[0].startsWith(RESULT_PREFIX)) return null;
  let value;
  try {
    value = JSON.parse(lines[0].slice(RESULT_PREFIX.length));
  } catch {
    return null;
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'exitCode,summary,version' ||
    value.version !== 1 ||
    value.exitCode !== expectedExitCode ||
    !Number.isInteger(value.exitCode) ||
    value.exitCode < 0 ||
    value.exitCode > 255 ||
    !(
      value.summary === null ||
      (typeof value.summary === 'string' &&
        value.summary.length > 0 &&
        value.summary.length <= 1_600 &&
        // eslint-disable-next-line no-control-regex -- Trusted envelope rejects unsafe control bytes.
        !/[\0\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.summary))
    ) ||
    (value.exitCode === 0) !== (value.summary === null)
  ) {
    return null;
  }
  if (value.summary && hasSecretContent(value.summary)) return null;
  return value;
}

function completionLogs(containerId, expectedExitCode) {
  let result;
  try {
    result = docker(['container', 'logs', containerId], {
      allowFailure: true,
      timeout: 30_000,
      maxBuffer: MAX_LOG_OUTPUT,
    });
  } catch {
    return null;
  }
  if (result.error || result.signal || result.status !== 0 || result.stderr.length > 0) return null;
  const report = parseCheckResult(result.stdout, expectedExitCode);
  if (!report) return null;
  return {
    stdoutDigest: sha256(result.stdout),
    stderrDigest: sha256(result.stderr),
    stdoutBytes: Buffer.byteLength(result.stdout),
    stderrBytes: Buffer.byteLength(result.stderr),
    summary: report.summary,
  };
}

function execution(metadata, logs, removed, stopProof = null) {
  return Object.freeze({
    kind: 'docker-check',
    actionId: metadata.actionId,
    imageId: metadata.imageId,
    containerId: metadata.containerId,
    network: 'none',
    sourceMount: 'read-only',
    stdoutDigest: logs?.stdoutDigest ?? null,
    stderrDigest: logs?.stderrDigest ?? null,
    stdoutBytes: logs?.stdoutBytes ?? 0,
    stderrBytes: logs?.stderrBytes ?? 0,
    removed,
    stopProofHash: stopProof?.proofHash ?? null,
    stopProofPath: stopProof?.path ?? null,
  });
}

function defaultContainerRuntime(root, metadata) {
  return Object.freeze({
    available: dockerServerAvailable,
    inspect: () => inspectContainer(metadata.containerId, metadata),
    logs: (exitCode) => completionLogs(metadata.containerId, exitCode),
    remove: () => removeContainer(metadata.containerId),
    start: (timeout) =>
      docker(['container', 'start', metadata.containerId], {
        allowFailure: true,
        timeout,
        maxBuffer: 128 * 1024,
      }),
    stop: () => stopContainer(metadata.containerId),
    wait: (timeout) => waitContainer(metadata.containerId, timeout),
    writeProof: (inspected, waited) => writeStopProof(root, metadata, inspected, waited),
  });
}

async function finalizeContainer({ runtime, waited = null, requestStop = false }) {
  if (requestStop) {
    try {
      runtime.stop();
    } catch {
      // Stop transport failure still proceeds to bounded wait and inspect evidence.
    }
  }
  if (!waited && requestStop) {
    try {
      waited = await runtime.wait(STOP_TIMEOUT_MS);
    } catch {
      waited = null;
    }
  }
  let inspected = null;
  try {
    inspected = runtime.inspect();
  } catch {
    // Missing inspect evidence is handled as an uncertain terminal result.
  }
  const terminal = terminalEvidence(inspected, waited);
  if (!terminal) {
    return { inspected, logs: null, removed: false, stopProof: null, waited };
  }
  let stopProof;
  try {
    stopProof = runtime.writeProof(inspected, waited);
  } catch {
    return { inspected, logs: null, removed: false, stopProof: null, waited };
  }
  let logs;
  try {
    logs = waited ? runtime.logs(waited.exitCode) : null;
  } catch {
    logs = null;
  }
  let removed;
  try {
    removed = runtime.remove();
  } catch {
    removed = false;
  }
  return { inspected, logs, removed, stopProof, waited };
}

async function superviseContainer({ runtime, timeoutMs, signal = null, redactions = [] }) {
  const started = Date.now();
  const deadline = started + timeoutMs;
  let failureReason = null;
  let timedOut = false;
  let aborted = false;
  const stop = (reason) => {
    if (reason === 'ABORTED') aborted = true;
    else timedOut = true;
    try {
      runtime.stop();
    } catch {
      // Finalization still performs bounded wait and inspect after stop transport failure.
    }
  };
  const abort = () => stop('ABORTED');
  if (signal) signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => stop('TIMEOUT'), timeoutMs);
  let start = null;
  let startUnknown = false;
  let waited = null;
  try {
    try {
      start = runtime.start(Math.min(30_000, timeoutMs));
    } catch {
      startUnknown = true;
      failureReason = 'START_UNKNOWN';
    }
    if (signal?.aborted) {
      aborted = true;
      stop('ABORTED');
    } else if (Date.now() >= deadline) {
      timedOut = true;
      stop('TIMEOUT');
    } else if (start && (start.status !== 0 || start.error || start.signal)) {
      failureReason = boundedDockerDiagnostic(start, 'START_FAILED', redactions);
      try {
        runtime.stop();
      } catch {
        // Finalization performs the second bounded stop attempt.
      }
    }
    if (!failureReason && !aborted && !timedOut) {
      try {
        waited = await runtime.wait(
          Math.max(1_000, deadline - Date.now() + STOP_TIMEOUT_MS + 5_000),
        );
      } catch {
        failureReason = 'WAIT_UNKNOWN';
      }
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
  if (!waited && !failureReason && !aborted && Date.now() >= deadline) timedOut = true;
  const finished = await finalizeContainer({
    runtime,
    waited,
    requestStop: startUnknown || Boolean(failureReason) || aborted || timedOut || !waited,
  });
  if (aborted) failureReason = 'ABORTED';
  else if (timedOut) failureReason = 'TIMEOUT';
  else if (!finished.stopProof) failureReason = failureReason ?? 'STOP_PROOF_MISSING';
  if (finished.stopProof && !finished.logs) {
    failureReason = failureReason ?? 'OUTPUT_UNAVAILABLE';
  }
  if (finished.stopProof && finished.logs && finished.waited?.exitCode !== 0) {
    failureReason =
      failureReason ??
      finished.logs.summary ??
      `CHECK_EXIT_${finished.waited?.exitCode ?? 'UNKNOWN'}`;
  }
  if (finished.stopProof && !finished.removed) {
    failureReason = failureReason ?? 'CONTAINER_CLEANUP_FAILED';
  }
  return {
    ...finished,
    aborted,
    durationMs: Date.now() - started,
    failureReason,
    timedOut,
  };
}

export async function runCheck(_input = {}) {
  fail('CHECK_BACKEND_RETIRED', 'Новые Docker-проверки отключены. Используйте локальные проверки проекта.');
}

function validateProcess(process) {
  const expectedLabels = {
    [CONTAINER_LABEL]: 'true',
    'com.flowcairn.task-id': process?.taskId,
    'com.flowcairn.node-id': process?.nodeId,
    'com.flowcairn.plan-hash': process?.planHash,
    'com.flowcairn.attempt-id': process?.attemptId,
    'com.flowcairn.contract-hash': process?.contractHash,
    'com.flowcairn.image-id': process?.imageId,
    'com.flowcairn.security-hash': process?.securityHash,
  };
  if (
    !process ||
    process.version !== 1 ||
    process.kind !== 'docker-check' ||
    !CONTAINER_ID_PATTERN.test(process.containerId) ||
    !IMAGE_ID_PATTERN.test(process.imageId) ||
    !HASH_PATTERN.test(process.imageHash) ||
    !HASH_PATTERN.test(process.planHash) ||
    !HASH_PATTERN.test(process.contractHash) ||
    !HASH_PATTERN.test(process.securityHash) ||
    !CHECK_ACTIONS.has(process.actionId) ||
    !ATTEMPT_ID_PATTERN.test(process.attemptId) ||
    typeof process.name !== 'string' ||
    !process.name.startsWith('flowcairn-graph-') ||
    !process.labels ||
    canonicalJson(process.labels) !== canonicalJson(expectedLabels)
  ) {
    fail('INVALID_CHECK_PROCESS', 'Docker process metadata недопустим');
  }
  return process;
}

export async function inspectCheckProcess({ root, process }) {
  const canonicalRoot = repositoryRoot(root);
  const metadata = validateProcess(process);
  const runtime = defaultContainerRuntime(canonicalRoot, metadata);
  return recoverCheckProcess(canonicalRoot, metadata, runtime);
}

async function recoverCheckProcess(root, metadata, runtime) {
  let durableProof;
  try {
    durableProof = readStopProof(root, metadata);
  } catch {
    return { stopped: false, uncertain: true, failureReason: 'STOP_PROOF_INVALID' };
  }
  if (durableProof) {
    const inspected = runtime.available?.() === false ? null : runtime.inspect();
    if (inspected?.State?.Running === true) {
      return { stopped: false, uncertain: true, failureReason: 'CONTAINER_RESTARTED' };
    }
    const removed = inspected ? runtime.remove() : false;
    return {
      stopped: true,
      uncertain: false,
      failureReason: null,
      exitCode: durableProof.terminal.exitCode,
      execution: execution(metadata, null, removed, {
        ...durableProof,
        path: stopProofPath(root, metadata).relative,
      }),
    };
  }
  if (runtime.available?.() === false) {
    return { stopped: false, uncertain: true, failureReason: 'DOCKER_UNAVAILABLE' };
  }
  const inspected = runtime.inspect();
  if (!inspected) {
    return { stopped: false, uncertain: true, failureReason: 'CONTAINER_NOT_FOUND' };
  }
  if (inspected.State?.Running !== false) {
    return { stopped: false, uncertain: true, failureReason: 'CONTAINER_RUNNING' };
  }
  const waited = inspected.State?.Status === 'created' ? null : await runtime.wait(STOP_TIMEOUT_MS);
  const finished = await finalizeContainer({ runtime, waited, requestStop: false });
  if (!finished.stopProof) {
    return { stopped: false, uncertain: true, failureReason: 'WAIT_PROOF_MISSING' };
  }
  return {
    stopped: true,
    uncertain: !finished.removed,
    failureReason: finished.removed ? null : 'CONTAINER_CLEANUP_FAILED',
    exitCode: finished.waited?.exitCode ?? null,
    execution: execution(metadata, null, finished.removed, finished.stopProof),
  };
}

export const DOCKER_CHECKS_TESTING = Object.freeze({
  actualSecurity,
  boundedDockerDiagnostic,
  classifyCreatedContainer,
  confirmCreatedBeforeStart,
  createPreparationTimeoutMs: CREATE_PREPARATION_TIMEOUT_MS,
  createReconciliationTimeoutMs: CREATE_RECONCILIATION_TIMEOUT_MS,
  dockerEnvironment,
  dockerExecutable,
  localDockerEnvironment,
  parseCheckResult,
  readStopProof,
  reconcileCreatedContainer,
  recoverCheckProcess,
  stopProofPath,
  superviseContainer,
  validateFingerprint,
  writeStopProof,
});
