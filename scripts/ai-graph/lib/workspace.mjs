import { lstatHostSync as lstatSync, fstatHostSync as fstatSync } from './host-filesystem.mjs';
import { gitExecutable, gitNullDevice } from './host-executables.mjs';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  constants,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { GraphError, canonicalJson, sha256 } from './io.mjs';
import { isSensitivePath } from './source-policy.mjs';

const GIT_EXECUTABLE = gitExecutable();
const MAX_FILES = 20_000;
const MAX_CHANGED_FILES = 200;
const MAX_INPUT_PATHS = 512;
const MAX_PATH_CHARACTERS = 512;
const MAX_PATH_BYTES = 4_096;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_INDEX_BYTES = 8 * 1024 * 1024;
const MAX_DIRECTORY_DEPTH = 128;
const MAX_DIFF_BYTES = 32 * 1024;
const MAX_GIT_DIFF_BYTES = 2 * 1024 * 1024;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const OID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const FILE_MODES = new Set(['100644', '100755']);
const GIT_HEAD_PATH = '@git/head';
const GIT_INDEX_PATH = '@git/index';
const utf8 = new TextDecoder('utf-8', { fatal: true });

function fail(code, message, details) {
  throw new GraphError(code, message, details);
}

function comparePath(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function decodeName(value) {
  try {
    return utf8.decode(value);
  } catch {
    fail('UNSAFE_WORKSPACE_PATH', 'Workspace path должен быть корректным UTF-8');
  }
}

function assertSafePath(value, { allowControl = false } = {}) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > MAX_PATH_CHARACTERS ||
    Buffer.byteLength(value) > MAX_PATH_BYTES ||
    value.includes('\0') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[a-zA-Z]:/.test(value)
  ) {
    fail('UNSAFE_WORKSPACE_PATH', 'Workspace path недопустим');
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    fail('UNSAFE_WORKSPACE_PATH', 'Workspace path содержит небезопасный сегмент');
  }
  if (parts.some((part) => part.toLowerCase() === '.git')) {
    fail('UNSAFE_WORKSPACE_PATH', 'Workspace path не может указывать на .git');
  }
  if (parts[0].toLowerCase() === '@git') {
    fail(
      'UNSAFE_WORKSPACE_PATH',
      'Workspace path использует зарезервированный Git evidence prefix',
    );
  }
  if (!allowControl && parts[0].toLowerCase() === '.ai-orchestrator') {
    fail('UNSAFE_WORKSPACE_PATH', 'Workspace path не может указывать на control storage');
  }
  return value;
}

function normalizePrefix(value, options) {
  if (typeof value !== 'string') fail('UNSAFE_WORKSPACE_PATH', 'Path prefix должен быть строкой');
  const normalized = value.endsWith('/') ? value.slice(0, -1) : value;
  return assertSafePath(normalized, options);
}

function assertNotSensitivePath(relativePath) {
  // Host-only control profile participates in executor freshness/scope checks;
  // it remains forbidden in AI snapshots by the shared source policy.
  if (relativePath !== '.flowcairn.json' && isSensitivePath(relativePath)) {
    fail('SENSITIVE_WORKSPACE_PATH', 'Workspace fingerprint отклоняет чувствительный path.');
  }
}

function boundedPaths(value, label, options) {
  if (!Array.isArray(value) || value.length > MAX_INPUT_PATHS) {
    fail('INVALID_WORKSPACE_OPTIONS', `${label} должен быть bounded массивом paths`);
  }
  const paths = value.map((entry) => normalizePrefix(entry, options));
  for (const entry of paths) {
    // Control storage is allowed only as an excluded output-policy declaration.
    if (options?.allowControl && (entry === '.ai-orchestrator' || entry.startsWith('.ai-orchestrator/'))) continue;
    assertNotSensitivePath(entry);
  }
  return [...new Set(paths)].sort(comparePath);
}

function containsPath(prefix, candidate) {
  return candidate === prefix || candidate.startsWith(`${prefix}/`);
}

function isExcluded(relativePath, outputPaths) {
  return outputPaths.some((prefix) => containsPath(prefix, relativePath));
}

function gitEnvironment() {
  const environment = {};
  for (const key of [
    'TMPDIR',
    'TMP',
    'TEMP',
    'SystemRoot',
    'WINDIR',
    'ComSpec',
    'PATHEXT',
    'LANG',
    'LC_CTYPE',
  ]) {
    if (typeof process.env[key] === 'string') environment[key] = process.env[key];
  }
  return {
    ...environment,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: gitNullDevice,
    GIT_ATTR_NOSYSTEM: '1',
    LC_ALL: 'C',
  };
}

function assertSystemGit() {
  if (!['darwin', 'linux', 'win32'].includes(process.platform)) {
    fail('UNSUPPORTED_PLATFORM', 'Workspace fingerprint поддерживает macOS/Linux system Git');
  }
  let stat;
  try {
    stat = lstatSync(GIT_EXECUTABLE);
  } catch {
    fail('GIT_FAILED', 'System Git не найден');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o111) === 0)) {
    fail('GIT_FAILED', 'System Git executable недопустим');
  }
}

function runGit(root, args, { allowFailure = false, maxBuffer = MAX_INDEX_BYTES } = {}) {
  assertSystemGit();
  const result = spawnSync(
    GIT_EXECUTABLE,
    [
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.untrackedCache=false',
      '-c',
      'core.quotePath=true',
      ...args,
    ],
    {
      cwd: root,
      encoding: 'buffer',
      shell: false,
      timeout: 120_000,
      maxBuffer,
      env: gitEnvironment(),
    },
  );
  if (result.error || result.signal || (!allowFailure && result.status !== 0)) {
    fail('GIT_FAILED', `git ${args[0]} завершился с ошибкой`, {
      status: result.status,
      reason:
        /** @type {NodeJS.ErrnoException} */ (result.error)?.code ??
        (result.signal ? 'signal' : 'non-zero'),
    });
  }
  return result;
}

function repositoryRoot(worktree) {
  const requestedPath = path.resolve(worktree);
  const requestedStat = lstatSync(requestedPath, { bigint: true });
  if (!requestedStat.isDirectory() || requestedStat.isSymbolicLink()) {
    fail('UNSAFE_WORKSPACE_ROOT', 'Worktree root должен быть обычной directory');
  }
  const requested = realpathSync(requestedPath);
  const result = runGit(requested, ['rev-parse', '--show-toplevel']);
  const top = result.stdout.toString('utf8').trim();
  if (!top || realpathSync(top) !== requested) {
    fail('NOT_REPOSITORY_ROOT', 'Worktree должен быть корнем Git repository');
  }
  return { root: requested, identity: statIdentity(requestedStat) };
}

function readHead(root) {
  const result = runGit(root, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true });
  if (result.status === 0) {
    const head = result.stdout.toString('ascii').trim();
    if (!OID_PATTERN.test(head)) fail('GIT_FAILED', 'Git вернул недопустимый HEAD');
    return head;
  }
  const symbolic = runGit(root, ['symbolic-ref', '-q', 'HEAD'], { allowFailure: true });
  if (symbolic.status !== 0) fail('GIT_FAILED', 'HEAD поврежден или не разрешается');
  const reference = symbolic.stdout.toString('utf8').trim();
  if (!/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(reference) || reference.includes('..')) {
    fail('GIT_FAILED', 'HEAD содержит недопустимую symbolic ref');
  }
  const exists = runGit(root, ['show-ref', '--verify', '--quiet', reference], {
    allowFailure: true,
  });
  if (exists.status === 1) return null;
  fail('GIT_FAILED', 'Symbolic HEAD существует, но не разрешается');
}

function readGitIdentity(root) {
  const head = readHead(root);
  const index = runGit(root, ['ls-files', '--stage', '-z']).stdout;
  return { head, indexHash: sha256(index) };
}

function validateOutputPolicy(root, outputPaths) {
  if (outputPaths.length === 0) return;
  const tracked = parseNulRecords(runGit(root, ['ls-files', '-z']).stdout).map((record) =>
    assertSafePath(decodeName(record)),
  );
  for (const outputPath of outputPaths) {
    if (tracked.some((trackedPath) => containsPath(outputPath, trackedPath))) {
      fail('INVALID_OUTPUT_PATH', `Tracked source нельзя исключить как output: ${outputPath}`);
    }
    let ignored = false;
    for (const probe of [outputPath, `${outputPath}/.graph-output-probe`]) {
      const result = runGit(root, ['check-ignore', '--no-index', '-q', '--', probe], {
        allowFailure: true,
        maxBuffer: 1024,
      });
      if (result.status === 0) {
        ignored = true;
        break;
      }
      if (result.status !== 1) fail('GIT_FAILED', 'git check-ignore завершился с ошибкой');
    }
    if (!ignored) {
      fail('INVALID_OUTPUT_PATH', `Output path должен быть Git-ignored: ${outputPath}`);
    }
  }
}

function statIdentity(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(
    ':',
  );
}

function readRegularFile(absolutePath, relativePath, before) {
  if (before.nlink !== 1n) {
    fail('UNSAFE_HARDLINK', `Hardlinked workspace file запрещен: ${relativePath}`);
  }
  if (before.size > BigInt(MAX_FILE_BYTES)) {
    fail('WORKSPACE_LIMIT_EXCEEDED', `Workspace file превышает лимит: ${relativePath}`);
  }
  let handle;
  try {
    handle = openSync(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(handle, { bigint: true });
    if (!opened.isFile() || statIdentity(opened) !== statIdentity(before)) {
      fail('WORKSPACE_CHANGED', `Workspace path изменился до чтения: ${relativePath}`);
    }
    const data = readFileSync(handle);
    const after = fstatSync(handle, { bigint: true });
    const current = lstatSync(absolutePath, { bigint: true });
    if (
      statIdentity(opened) !== statIdentity(after) ||
      statIdentity(after) !== statIdentity(current) ||
      BigInt(data.length) !== after.size
    ) {
      fail('WORKSPACE_CHANGED', `Workspace file изменился во время чтения: ${relativePath}`);
    }
    return {
      path: relativePath,
      hash: sha256(data),
      mode: (Number(after.mode) & 0o111) === 0 ? '100644' : '100755',
      size: data.length,
    };
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

function validateExcludedRoot(absolutePath, relativePath) {
  let stat;
  try {
    stat = lstatSync(absolutePath, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    fail('UNSAFE_WORKSPACE_ENTRY', `Excluded output path не может быть symlink: ${relativePath}`);
  }
  if (stat.isFile() && stat.nlink !== 1n) {
    fail('UNSAFE_HARDLINK', `Excluded output path не может быть hardlink: ${relativePath}`);
  }
  if (!stat.isFile() && !stat.isDirectory()) {
    fail('UNSAFE_WORKSPACE_ENTRY', `Excluded output path имеет недопустимый type: ${relativePath}`);
  }
}

function scanWorkspace(root, outputPaths) {
  const files = [];
  let totalBytes = 0;

  const scanDirectory = (absoluteDirectory, relativeDirectory, depth) => {
    if (depth > MAX_DIRECTORY_DEPTH) {
      fail('WORKSPACE_LIMIT_EXCEEDED', 'Workspace directory depth превышает лимит');
    }
    const before = lstatSync(absoluteDirectory, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) {
      fail('UNSAFE_WORKSPACE_ENTRY', 'Workspace directory была заменена');
    }
    const entries = readdirSync(absoluteDirectory, { withFileTypes: true, encoding: 'buffer' })
      .map((entry) => ({ entry, name: decodeName(entry.name) }))
      .sort((left, right) => comparePath(left.name, right.name));

    for (const { name } of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      if (relativeDirectory === '' && name === '.git') {
        validateGitEntry(path.join(absoluteDirectory, name));
        continue;
      }
      const outputAncestor = outputPaths.some((prefix) => containsPath(relativePath, prefix));
      assertSafePath(relativePath, { allowControl: outputAncestor });
      if (!(outputAncestor && (relativePath === '.ai-orchestrator' || relativePath.startsWith('.ai-orchestrator/')))) assertNotSensitivePath(relativePath);
      const absolutePath = path.join(absoluteDirectory, name);
      if (isExcluded(relativePath, outputPaths)) {
        validateExcludedRoot(absolutePath, relativePath);
        continue;
      }
      const stat = lstatSync(absolutePath, { bigint: true });
      if (stat.isSymbolicLink()) {
        fail('UNSAFE_WORKSPACE_ENTRY', `Workspace symlink запрещен: ${relativePath}`);
      }
      if (stat.isDirectory()) {
        scanDirectory(absolutePath, relativePath, depth + 1);
        continue;
      }
      if (!stat.isFile()) {
        fail('UNSAFE_WORKSPACE_ENTRY', `Workspace entry имеет недопустимый type: ${relativePath}`);
      }
      if (files.length >= MAX_FILES) {
        fail('WORKSPACE_LIMIT_EXCEEDED', 'Workspace содержит слишком много files');
      }
      const descriptor = readRegularFile(absolutePath, relativePath, stat);
      totalBytes += descriptor.size;
      if (totalBytes > MAX_TOTAL_BYTES) {
        fail('WORKSPACE_LIMIT_EXCEEDED', 'Workspace превышает общий лимит размера');
      }
      files.push(descriptor);
    }

    const after = lstatSync(absoluteDirectory, { bigint: true });
    if (statIdentity(before) !== statIdentity(after)) {
      fail('WORKSPACE_CHANGED', 'Workspace directory изменилась во время fingerprint');
    }
  };

  scanDirectory(root, '', 0);
  return files.sort((left, right) => comparePath(left.path, right.path));
}

function validateGitEntry(absolutePath) {
  const stat = lstatSync(absolutePath, { bigint: true });
  if (stat.isSymbolicLink()) fail('UNSAFE_GIT_METADATA', '.git не может быть symlink');
  if (stat.isFile() && stat.nlink !== 1n)
    fail('UNSAFE_GIT_METADATA', '.git file hardlink запрещен');
  if (!stat.isFile() && !stat.isDirectory()) {
    fail('UNSAFE_GIT_METADATA', '.git имеет недопустимый type');
  }
}

function sameFiles(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function validateFingerprint(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_WORKSPACE_FINGERPRINT', `${label} должен быть объектом`);
  }
  const keys = Object.keys(value).sort();
  if (canonicalJson(keys) !== canonicalJson(['files', 'git', 'hash'])) {
    fail('INVALID_WORKSPACE_FINGERPRINT', `${label} содержит недопустимые поля`);
  }
  if (!Array.isArray(value.files) || value.files.length > MAX_FILES) {
    fail('INVALID_WORKSPACE_FINGERPRINT', `${label}.files недопустим`);
  }
  let previous = null;
  let totalBytes = 0;
  for (const file of value.files) {
    if (!file || typeof file !== 'object' || Array.isArray(file)) {
      fail('INVALID_WORKSPACE_FINGERPRINT', `${label}.files содержит не-object`);
    }
    if (
      canonicalJson(Object.keys(file).sort()) !== canonicalJson(['hash', 'mode', 'path', 'size'])
    ) {
      fail('INVALID_WORKSPACE_FINGERPRINT', `${label}.files содержит недопустимые поля`);
    }
    assertSafePath(file.path);
    assertNotSensitivePath(file.path);
    if (previous !== null && comparePath(previous, file.path) >= 0) {
      fail(
        'INVALID_WORKSPACE_FINGERPRINT',
        `${label}.files не отсортирован или содержит duplicate`,
      );
    }
    if (!HASH_PATTERN.test(file.hash) || !FILE_MODES.has(file.mode)) {
      fail('INVALID_WORKSPACE_FINGERPRINT', `${label}.files содержит недопустимый hash/mode`);
    }
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_FILE_BYTES) {
      fail('INVALID_WORKSPACE_FINGERPRINT', `${label}.files содержит недопустимый size`);
    }
    totalBytes += file.size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      fail('INVALID_WORKSPACE_FINGERPRINT', `${label}.files превышает общий size`);
    }
    previous = file.path;
  }
  if (
    !value.git ||
    typeof value.git !== 'object' ||
    Array.isArray(value.git) ||
    canonicalJson(Object.keys(value.git).sort()) !== canonicalJson(['head', 'indexHash']) ||
    (value.git.head !== null && !OID_PATTERN.test(value.git.head)) ||
    !HASH_PATTERN.test(value.git.indexHash)
  ) {
    fail('INVALID_WORKSPACE_FINGERPRINT', `${label}.git недопустим`);
  }
  const expected = sha256(canonicalJson({ files: value.files, git: value.git }));
  if (!HASH_PATTERN.test(value.hash) || value.hash !== expected) {
    fail('INVALID_WORKSPACE_FINGERPRINT', `${label}.hash не совпадает`);
  }
  return value;
}

export function fingerprintWorkspace(worktree, { baselinePaths = [], outputPaths = [] } = {}) {
  const baseline = boundedPaths(baselinePaths, 'baselinePaths');
  const outputs = boundedPaths(outputPaths, 'outputPaths', { allowControl: true });
  for (const baselinePath of baseline) {
    if (isExcluded(baselinePath, outputs)) {
      fail('INVALID_WORKSPACE_OPTIONS', `Baseline path исключен outputPaths: ${baselinePath}`);
    }
  }

  const repository = repositoryRoot(worktree);
  validateOutputPolicy(repository.root, outputs);
  const initialGit = readGitIdentity(repository.root);
  const first = scanWorkspace(repository.root, outputs);
  const second = scanWorkspace(repository.root, outputs);
  const finalGit = readGitIdentity(repository.root);
  const finalRoot = lstatSync(repository.root, { bigint: true });
  if (
    repository.identity !== statIdentity(finalRoot) ||
    canonicalJson(initialGit) !== canonicalJson(finalGit) ||
    !sameFiles(first, second)
  ) {
    fail('WORKSPACE_CHANGED', 'Workspace или Git metadata изменились во время fingerprint');
  }

  const filePaths = new Set(second.map((file) => file.path));
  for (const baselinePath of baseline) {
    if (!filePaths.has(baselinePath)) {
      fail('BASELINE_PATH_MISSING', `Baseline path отсутствует: ${baselinePath}`);
    }
  }
  const body = { files: second, git: finalGit };
  return { hash: sha256(canonicalJson(body)), ...body };
}

export function compareWorkspaces(before, after) {
  validateFingerprint(before, 'before');
  validateFingerprint(after, 'after');
  const beforeFiles = new Map(before.files.map((file) => [file.path, file]));
  const afterFiles = new Map(after.files.map((file) => [file.path, file]));
  const changed = new Set();
  for (const relativePath of new Set([...beforeFiles.keys(), ...afterFiles.keys()])) {
    if (
      canonicalJson(beforeFiles.get(relativePath)) !== canonicalJson(afterFiles.get(relativePath))
    ) {
      changed.add(relativePath);
    }
  }
  if (before.git.head !== after.git.head) changed.add(GIT_HEAD_PATH);
  if (before.git.indexHash !== after.git.indexHash) changed.add(GIT_INDEX_PATH);
  if (changed.size > MAX_CHANGED_FILES) {
    fail('CHANGE_SET_LIMIT_EXCEEDED', 'Workspace change set превышает лимит 200 paths');
  }
  return [...changed].sort(comparePath);
}

function contractPaths(value, label) {
  return boundedPaths(value, label);
}

function hasPermission(node, permission) {
  if (
    !Array.isArray(node.permissions) ||
    node.permissions.some((value) => typeof value !== 'string')
  ) {
    fail('INVALID_SCOPE_CONTRACT', 'node.permissions недопустим');
  }
  const known = new Set(['ai.read', 'workspace.source.write', 'workspace.output.write']);
  if (node.permissions.some((value) => !known.has(value))) {
    fail('INVALID_SCOPE_CONTRACT', 'node.permissions содержит неизвестное право');
  }
  return node.permissions.includes(permission);
}

export function inspectWorkspaceChanges(before, after, node, task) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    fail('INVALID_SCOPE_CONTRACT', 'node должен быть объектом');
  }
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    fail('INVALID_SCOPE_CONTRACT', 'task должен быть объектом');
  }
  if (!node.resources || typeof node.resources !== 'object' || Array.isArray(node.resources)) {
    fail('INVALID_SCOPE_CONTRACT', 'node.resources недопустим');
  }
  const nodeWrites = contractPaths(node.resources.writes, 'node.resources.writes');
  const taskScope = contractPaths(task.scope, 'task.scope');
  const forbidden = contractPaths(task.forbiddenPaths ?? [], 'task.forbiddenPaths');
  const canWriteSource = hasPermission(node, 'workspace.source.write');
  const changedFiles = compareWorkspaces(before, after);
  const violations = [];

  for (const relativePath of changedFiles) {
    if (relativePath === GIT_HEAD_PATH || relativePath === GIT_INDEX_PATH) {
      violations.push({ code: 'GIT_METADATA_CHANGED', path: relativePath });
    } else if (
      relativePath === '.flowcairn.json' ||
      forbidden.some((prefix) => containsPath(prefix, relativePath))
    ) {
      violations.push({ code: 'FORBIDDEN_PATH_CHANGED', path: relativePath });
    } else if (!canWriteSource) {
      violations.push({ code: 'SOURCE_WRITE_PERMISSION_REQUIRED', path: relativePath });
    } else if (
      !nodeWrites.some((prefix) => containsPath(prefix, relativePath)) ||
      !taskScope.some((prefix) => containsPath(prefix, relativePath))
    ) {
      violations.push({ code: 'OUT_OF_SCOPE_CHANGE', path: relativePath });
    }
  }

  return { allowed: violations.length === 0, changedFiles, violations };
}

function parseNulRecords(buffer) {
  const records = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    records.push(buffer.subarray(start, index));
    start = index + 1;
  }
  if (start !== buffer.length) fail('GIT_FAILED', 'Git вернул незавершенный NUL record');
  return records.filter((record) => record.length > 0);
}

function appendBounded(parts, text, state) {
  const remaining = MAX_DIFF_BYTES - state.bytes;
  if (remaining <= 0) {
    state.truncated = true;
    return;
  }
  const bytes = Buffer.from(text);
  if (bytes.length <= remaining) {
    parts.push(text);
    state.bytes += bytes.length;
    return;
  }
  let partial = bytes.subarray(0, remaining).toString('utf8');
  while (Buffer.byteLength(partial) > remaining || partial.endsWith('\ufffd')) {
    partial = partial.slice(0, -1);
  }
  parts.push(partial);
  state.bytes = MAX_DIFF_BYTES;
  state.truncated = true;
}

function safePatchText(buffer) {
  let text;
  try {
    text = utf8.decode(buffer);
  } catch {
    return null;
  }
  const result = [];
  for (const line of text.split('\n')) {
    if (
      line.startsWith('diff --git ') ||
      line.startsWith('index ') ||
      line.startsWith('new file mode ') ||
      line.startsWith('deleted file mode ') ||
      line.startsWith('old mode ') ||
      line.startsWith('new mode ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line === '\\ No newline at end of file' ||
      line.startsWith('Binary files ')
    ) {
      result.push(line);
    } else if (line.startsWith('@@ ')) {
      result.push(/^@@[^@]*@@/.exec(line)?.[0] ?? '@@ [hunk metadata omitted] @@');
    } else if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) {
      result.push(`${line[0]}[content omitted]`);
    } else if (line) {
      result.push('[git metadata omitted]');
    }
  }
  return result.join('\n');
}

function fileChangeMetadata(beforeFiles, afterFiles, relativePath) {
  const beforeFile = beforeFiles.get(relativePath) ?? null;
  const afterFile = afterFiles.get(relativePath) ?? null;
  const status = beforeFile === null ? 'added' : afterFile === null ? 'deleted' : 'modified';
  return { path: relativePath, status, before: beforeFile, after: afterFile };
}

function currentPatch(root, paths) {
  const chunks = [];
  let reliable = true;
  for (let offset = 0; offset < paths.length; offset += 128) {
    const pathChunk = paths.slice(offset, offset + 128);
    for (const cached of [false, true]) {
      const args = [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--no-renames',
        '--unified=3',
        '--src-prefix=a/',
        '--dst-prefix=b/',
      ];
      if (cached) args.push('--cached');
      args.push('--', ...pathChunk);
      let result;
      try {
        result = runGit(root, args, { allowFailure: true, maxBuffer: MAX_GIT_DIFF_BYTES });
      } catch (error) {
        if (!(error instanceof GraphError) || error.code !== 'GIT_FAILED') throw error;
        reliable = false;
        continue;
      }
      if (result.stdout.length > 0) {
        const safeText = safePatchText(result.stdout);
        if (safeText === null) {
          reliable = false;
        } else {
          chunks.push(`[${cached ? 'index-vs-head' : 'worktree-vs-index'}]\n${safeText}`);
        }
      }
    }
  }
  return { text: chunks.join('\n'), reliable };
}

export function buildDiffArtifact(worktree, before, after) {
  validateFingerprint(before, 'before');
  validateFingerprint(after, 'after');
  const changedFiles = compareWorkspaces(before, after);
  const repository = repositoryRoot(worktree);
  const parts = [];
  const state = { bytes: 0, truncated: false };
  const beforeFiles = new Map(before.files.map((file) => [file.path, file]));
  const afterFiles = new Map(after.files.map((file) => [file.path, file]));
  appendBounded(parts, 'workspace-diff-v1\n', state);
  appendBounded(
    parts,
    `${canonicalJson({ beforeHash: before.hash, afterHash: after.hash })}\n`,
    state,
  );
  for (const relativePath of changedFiles) {
    if (relativePath === GIT_HEAD_PATH || relativePath === GIT_INDEX_PATH) {
      appendBounded(
        parts,
        `${canonicalJson({ path: relativePath, status: 'git-metadata-changed' })}\n`,
        state,
      );
    } else {
      appendBounded(
        parts,
        `${canonicalJson(fileChangeMetadata(beforeFiles, afterFiles, relativePath))}\n`,
        state,
      );
    }
  }

  let patchReliable;
  const currentGit = readGitIdentity(repository.root);
  if (canonicalJson(currentGit) === canonicalJson(after.git)) {
    const patchPaths = changedFiles.filter((relativePath) => !relativePath.startsWith('@git/'));
    const patch = currentPatch(repository.root, patchPaths);
    patchReliable = patch.reliable;
    if (patch.text) appendBounded(parts, `[current-git-view]\n${patch.text}\n`, state);
  } else {
    patchReliable = false;
    appendBounded(parts, '[current-git-view unavailable: git metadata drift]\n', state);
  }

  return {
    content: parts.join(''),
    complete: changedFiles.length === 0 && patchReliable && !state.truncated,
  };
}
