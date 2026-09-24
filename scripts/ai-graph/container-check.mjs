import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  cpSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const INPUT = '/input';
const WORKSPACE = '/workspace';
const PREPARED_WORKSPACE = '/opt/flowcairn/workspace';
const CONTRACT = '/contract.json';
const NODE = '/usr/local/bin/node';
const PACKAGE_MANAGER = '/opt/flowcairn/package-manager.cjs';
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_CHECK_OUTPUT = 4 * 1024 * 1024;
const RESULT_PREFIX = 'FLOWCAIRN_CHECK_RESULT ';

function fail(message) {
  throw new Error(message);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
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

function fsyncDirectory(directory) {
  const handle = openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

function relativePath(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 512 ||
    Buffer.byteLength(value) > 4096 ||
    value.includes('\0') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[a-z]:/i.test(value)
  ) {
    fail('INVALID_SOURCE_PATH');
  }
  const parts = value.split('/');
  if (
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        ['.git', '.ai-orchestrator', 'node_modules'].includes(part.toLowerCase()),
    )
  ) {
    fail('INVALID_SOURCE_PATH');
  }
  return value;
}

function physicalRoot(root, label) {
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`INVALID_${label}_ROOT`);
  return realpathSync(root);
}

function inspectParents(root, relative, { create = false } = {}) {
  let cursor = root;
  for (const part of relative.split('/').slice(0, -1)) {
    cursor = path.join(cursor, part);
    try {
      const stat = lstatSync(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_SOURCE_ANCESTOR');
    } catch (error) {
      if (error.code !== 'ENOENT' || !create) throw error;
      mkdirSync(cursor, { mode: 0o700 });
    }
  }
}

function validateFiles(files) {
  if (!Array.isArray(files) || files.length > MAX_FILES) fail('INVALID_FINGERPRINT');
  const seen = new Set();
  let total = 0;
  return files.map((file) => {
    if (
      !file ||
      typeof file !== 'object' ||
      Array.isArray(file) ||
      Object.keys(file).sort().join(',') !== 'hash,mode,path,size'
    ) {
      fail('INVALID_FINGERPRINT');
    }
    const normalized = relativePath(file.path);
    if (
      seen.has(normalized) ||
      !HASH_PATTERN.test(file.hash) ||
      !['100644', '100755'].includes(file.mode) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > MAX_FILE_BYTES
    ) {
      fail('INVALID_FINGERPRINT');
    }
    seen.add(normalized);
    total += file.size;
    if (total > MAX_TOTAL_BYTES) fail('INVALID_FINGERPRINT');
    return { ...file, path: normalized };
  });
}

export function registeredContainerCheck(actionId, { packageManager, checkScript }) {
  const scripts = {
    'check-typecheck': 'typecheck',
    'check-lint': 'lint',
    'check-tests': 'test',
    'check-build': 'build',
  };
  if (!['npm', 'pnpm', 'yarn'].includes(packageManager)) fail('INVALID_CONTRACT');
  if (!Object.hasOwn(scripts, actionId)) fail('UNSUPPORTED_CHECK');
  if (typeof checkScript !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,119}$/.test(checkScript))
    fail('INVALID_CONTRACT');
  return Object.freeze({
    executable: NODE,
    args: Object.freeze([PACKAGE_MANAGER, 'run', checkScript]),
  });
}

export function registeredContainerCommands(actionId, flags) {
  return Object.freeze([registeredContainerCheck(actionId, flags)]);
}

/** Copy the immutable image seed into the size/inode-limited writable mount. */
export function seedPreparedWorkspace({ seed, workspace }) {
  const source = physicalRoot(seed, 'PREPARED');
  const target = physicalRoot(workspace, 'WORKSPACE');
  if (source === target || target.startsWith(`${source}${path.sep}`)) fail('INVALID_WORKSPACE');
  cpSync(source, target, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    force: false,
    errorOnExist: true,
  });
}

export function copyFingerprintSource({ input, workspace, files }) {
  const inputRoot = physicalRoot(input, 'INPUT');
  const workspaceRoot = physicalRoot(workspace, 'WORKSPACE');
  const validated = validateFiles(files);
  for (const file of validated) {
    inspectParents(inputRoot, file.path);
    const source = path.join(inputRoot, ...file.path.split('/'));
    const handle = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    let body;
    try {
      const stat = fstatSync(handle);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size !== file.size ||
        (stat.mode & 0o111 ? '100755' : '100644') !== file.mode
      ) {
        fail('SOURCE_DRIFT');
      }
      body = readFileSync(handle);
      if (sha256(body) !== file.hash) fail('SOURCE_DRIFT');
    } finally {
      closeSync(handle);
    }

    inspectParents(workspaceRoot, file.path, { create: true });
    const target = path.join(workspaceRoot, ...file.path.split('/'));
    if (existsNoFollow(target)) {
      const targetStat = lstatSync(target);
      if (!targetStat.isFile() || targetStat.isSymbolicLink() || targetStat.nlink !== 1) {
        fail('UNSAFE_WORKSPACE_TARGET');
      }
    }
    const temporary = path.join(path.dirname(target), `.graph-copy-${randomUUID()}.tmp`);
    let output;
    try {
      output = openSync(temporary, 'wx', file.mode === '100755' ? 0o755 : 0o644);
      writeFileSync(output, body);
      fsyncSync(output);
      closeSync(output);
      output = undefined;
      renameSync(temporary, target);
      fsyncDirectory(path.dirname(target));
    } catch (error) {
      if (output !== undefined) closeSync(output);
      if (existsNoFollow(temporary)) {
        unlinkSync(temporary);
        fsyncDirectory(path.dirname(temporary));
      }
      throw error;
    }
  }
}

// Raw child diagnostics can contain project secrets. Never persist them in Docker logs.
export function summarizeCheckFailure(_stdout, _stderr, { outputLimit = false } = {}) {
  return outputLimit
    ? `Check output exceeded ${MAX_CHECK_OUTPUT} byte limit`
    : 'Check failed; raw diagnostic omitted';
}

function emitResult(exitCode, summary) {
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify({ version: 1, exitCode, summary })}\n`);
}

function readContract(file) {
  const raw = readFileSync(file);
  if (raw.length > 4 * 1024 * 1024) fail('INVALID_CONTRACT');
  const contract = JSON.parse(raw.toString('utf8'));
  if (
    !contract ||
    typeof contract !== 'object' ||
    Array.isArray(contract) ||
    Object.keys(contract).sort().join(',') !== 'actionId,checkScript,files,packageManager,timeoutMs,version' ||
    contract.version !== 4 ||
    !Number.isInteger(contract.timeoutMs) ||
    contract.timeoutMs < 1_000 ||
    contract.timeoutMs > 1_800_000
  ) {
    fail('INVALID_CONTRACT');
  }
  return { ...contract, files: validateFiles(contract.files) };
}

export function runBoundedCommand(command, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(command.executable, command.args, {
      cwd,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result, { terminate = false } = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (terminate) {
        child.kill('SIGKILL');
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
      }
      resolve(result);
    };
    const append = (current, chunk) => {
      const next = current + chunk.toString('utf8');
      if (Buffer.byteLength(next) > MAX_CHECK_OUTPUT) {
        finish(
          { exitCode: 125, stdout: '', stderr: '', outputLimit: true, timedOut: false },
          { terminate: true },
        );
        return current;
      }
      return next;
    };
    child.stdout.on('data', (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.on('error', () =>
      finish({ exitCode: 125, stdout, stderr, outputLimit: false, timedOut: false }),
    );
    child.on('close', (code, signal) =>
      finish({
        exitCode: signal ? 125 : (code ?? 125),
        stdout,
        stderr,
        outputLimit: false,
        timedOut: false,
      }),
    );
    const timer = setTimeout(
      () =>
        finish(
          { exitCode: 124, stdout: '', stderr: '', outputLimit: false, timedOut: true },
          { terminate: true },
        ),
      timeoutMs,
    );
  });
}

export async function main({
  input = INPUT,
  workspace = WORKSPACE,
  contractFile = CONTRACT,
  preparedWorkspace = PREPARED_WORKSPACE,
  actionId = process.argv[2],
} = {}) {
  const contract = readContract(contractFile);
  if (actionId !== contract.actionId) fail('CONTRACT_ACTION_MISMATCH');
  const commands = registeredContainerCommands(contract.actionId, contract);
  const deadline = Date.now() + contract.timeoutMs;
  seedPreparedWorkspace({ seed: preparedWorkspace, workspace });
  copyFingerprintSource({ input, workspace, files: contract.files });
  let exitCode = 0;
  let summary = null;
  for (const command of commands) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      exitCode = 124;
      summary = 'Check exceeded its container deadline';
      break;
    }
    const result = await runBoundedCommand(command, {
      cwd: workspace,
      env: {
        CI: 'true',
        pnpm_config_verify_deps_before_run: 'false',
        npm_config_manage_package_manager_versions: 'false',
        COREPACK_ENABLE_NETWORK: '0',
        COREPACK_HOME: '/opt/corepack',
        YARN_NODE_LINKER: 'node-modules',
        YARN_ENABLE_GLOBAL_CACHE: 'false',
        YARN_ENABLE_NETWORK: 'false',
        HOME: '/tmp',
        PATH: '/workspace/node_modules/.bin:/usr/local/bin:/usr/bin:/bin',
        XDG_CACHE_HOME: '/tmp/cache',
      },
      timeoutMs: remaining,
    });
    exitCode = result.exitCode;
    summary =
      exitCode === 0
        ? null
        : result.timedOut
          ? 'Check exceeded its container deadline'
          : summarizeCheckFailure(result.stdout, result.stderr, {
              outputLimit: result.outputLimit,
            });
    if (exitCode !== 0) break;
  }
  emitResult(exitCode, summary);
  process.exitCode = exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    emitResult(
      125,
      'CHECK_FAILED',
    );
    process.exitCode = 125;
  });
}
