import { randomUUID } from 'node:crypto';
import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { GraphError, canonicalJson, hashObject } from './io.mjs';

// Durable evidence storage is independent of Docker process supervision and image preparation.
const STOP_PROOF_KIND = 'docker-check-stop-proof';
const STOP_PROOF_DIRECTORY = 'check-stop-proofs';
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const fail = (code, message) => { throw new GraphError(code, message); };

export function existsNoFollow(candidate) {
  try {
    lstatSync(candidate);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export function physicalDirectory(directory, code, { privateMode = false } = {}) {
  let stat;
  try {
    stat = lstatSync(directory);
  } catch {
    fail(code, `Directory недоступна: ${directory}`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || (privateMode && (stat.mode & 0o077) !== 0)) {
    fail(code, `Directory небезопасна: ${directory}`);
  }
  return realpathSync(directory);
}

export function privateGraphDirectory(root) {
  const control = path.join(root, '.ai-orchestrator');
  const graph = path.join(control, 'graph');
  for (const directory of [control, graph]) {
    if (!existsNoFollow(directory)) mkdirSync(directory, { mode: 0o700 });
    physicalDirectory(directory, 'INSECURE_CHECK_STORAGE', { privateMode: true });
  }
  return graph;
}

function fsyncDirectory(directory) {
  const handle = openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

export function stopProofPath(root, metadata, { create = false } = {}) {
  const graph = create
    ? privateGraphDirectory(root)
    : physicalDirectory(path.join(root, '.ai-orchestrator', 'graph'), 'INSECURE_CHECK_STORAGE', {
        privateMode: true,
      });
  const directory = path.join(graph, STOP_PROOF_DIRECTORY);
  if (typeof process.getuid === 'function' && lstatSync(graph).uid !== process.getuid()) {
    fail('INSECURE_STOP_PROOF_STORAGE', 'Graph storage принадлежит другому owner');
  }
  if (create && !existsNoFollow(directory)) {
    mkdirSync(directory, { mode: 0o700 });
    fsyncDirectory(graph);
  }
  if (!existsNoFollow(directory)) return null;
  physicalDirectory(directory, 'INSECURE_STOP_PROOF_STORAGE', { privateMode: true });
  if (typeof process.getuid === 'function' && lstatSync(directory).uid !== process.getuid()) {
    fail('INSECURE_STOP_PROOF_STORAGE', 'Docker stop proof directory принадлежит другому owner');
  }
  const metadataHash = hashObject(metadata);
  return {
    file: path.join(directory, `${metadataHash}.json`),
    metadataHash,
    relative: `.ai-orchestrator/graph/${STOP_PROOF_DIRECTORY}/${metadataHash}.json`,
  };
}

export function terminalEvidence(inspected, waited) {
  const state = inspected?.State;
  if (!state || state.Running !== false) return null;
  if (state.Status === 'created' && !waited) {
    return Object.freeze({
      status: 'created',
      exitCode: null,
      finishedAt: null,
      oomKilled: false,
    });
  }
  if (
    !waited ||
    !Number.isInteger(waited.exitCode) ||
    waited.exitCode < 0 ||
    waited.exitCode > 255 ||
    state.ExitCode !== waited.exitCode ||
    !['exited', 'dead'].includes(state.Status) ||
    typeof state.FinishedAt !== 'string' ||
    state.FinishedAt.length < 1 ||
    state.FinishedAt.length > 80
  ) {
    return null;
  }
  return Object.freeze({
    status: state.Status,
    exitCode: waited.exitCode,
    finishedAt: state.FinishedAt,
    oomKilled: state.OOMKilled === true,
  });
}

function stopProofValue(metadata, terminal) {
  const body = {
    version: 1,
    kind: STOP_PROOF_KIND,
    metadataHash: hashObject(metadata),
    containerId: metadata.containerId,
    imageId: metadata.imageId,
    attemptId: metadata.attemptId,
    taskId: metadata.taskId,
    nodeId: metadata.nodeId,
    terminal,
  };
  return Object.freeze({ ...body, proofHash: hashObject(body) });
}

function validateStopProof(value, metadata) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !==
      'attemptId,containerId,imageId,kind,metadataHash,nodeId,proofHash,taskId,terminal,version' ||
    value.version !== 1 ||
    value.kind !== STOP_PROOF_KIND ||
    value.metadataHash !== hashObject(metadata) ||
    value.containerId !== metadata.containerId ||
    value.imageId !== metadata.imageId ||
    value.attemptId !== metadata.attemptId ||
    value.taskId !== metadata.taskId ||
    value.nodeId !== metadata.nodeId ||
    !value.terminal ||
    typeof value.terminal !== 'object' ||
    Array.isArray(value.terminal) ||
    Object.keys(value.terminal).sort().join(',') !== 'exitCode,finishedAt,oomKilled,status' ||
    !['created', 'exited', 'dead'].includes(value.terminal.status) ||
    !(
      (value.terminal.status === 'created' &&
        value.terminal.exitCode === null &&
        value.terminal.finishedAt === null) ||
      (['exited', 'dead'].includes(value.terminal.status) &&
        Number.isInteger(value.terminal.exitCode) &&
        value.terminal.exitCode >= 0 &&
        value.terminal.exitCode <= 255 &&
        typeof value.terminal.finishedAt === 'string' &&
        value.terminal.finishedAt.length >= 1 &&
        value.terminal.finishedAt.length <= 80)
    ) ||
    typeof value.terminal.oomKilled !== 'boolean'
  ) {
    fail('STOP_PROOF_INVALID', 'Docker stop proof недопустим');
  }
  const { proofHash, ...body } = value;
  if (!HASH_PATTERN.test(proofHash) || proofHash !== hashObject(body)) {
    fail('STOP_PROOF_INVALID', 'Docker stop proof hash не совпадает');
  }
  return value;
}

export function readStopProof(
  root,
  metadata,
  { syncFile = fsyncSync, syncDirectory = fsyncDirectory } = {},
) {
  const location = stopProofPath(root, metadata);
  if (!location || !existsNoFollow(location.file)) return null;
  let stat = lstatSync(location.file);
  if (stat.nlink === 2) {
    const prefix = `.${location.metadataHash}.`;
    const linkedTemporary = readdirSync(path.dirname(location.file))
      .filter((name) => name.startsWith(prefix) && name.endsWith('.tmp'))
      .map((name) => path.join(path.dirname(location.file), name))
      .filter((candidate) => {
        try {
          const candidateStat = lstatSync(candidate);
          return (
            candidateStat.isFile() &&
            !candidateStat.isSymbolicLink() &&
            candidateStat.dev === stat.dev &&
            candidateStat.ino === stat.ino &&
            candidateStat.uid === stat.uid &&
            (candidateStat.mode & 0o077) === 0
          );
        } catch {
          return false;
        }
      });
    if (linkedTemporary.length === 1) {
      unlinkSync(linkedTemporary[0]);
      syncDirectory(path.dirname(location.file));
      stat = lstatSync(location.file);
    }
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
    (stat.mode & 0o077) !== 0 ||
    stat.size < 2 ||
    stat.size > 32 * 1024
  ) {
    fail('STOP_PROOF_INVALID', 'Docker stop proof file небезопасен');
  }
  const handle = openSync(location.file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let proof;
  try {
    const current = fstatSync(handle);
    if (current.dev !== stat.dev || current.ino !== stat.ino || current.size !== stat.size) {
      fail('STOP_PROOF_INVALID', 'Docker stop proof изменился во время чтения');
    }
    proof = validateStopProof(JSON.parse(readFileSync(handle, 'utf8')), metadata);
    try {
      syncFile(handle);
    } catch {
      fail('STOP_PROOF_NOT_DURABLE', 'Docker stop proof file fsync не подтвержден');
    }
  } catch (error) {
    if (error instanceof GraphError) throw error;
    fail('STOP_PROOF_INVALID', 'Docker stop proof не читается');
  } finally {
    closeSync(handle);
  }
  try {
    syncDirectory(path.dirname(location.file));
  } catch {
    fail('STOP_PROOF_NOT_DURABLE', 'Docker stop proof directory fsync не подтвержден');
  }
  return proof;
}

export function writeStopProof(
  root,
  metadata,
  inspected,
  waited,
  { syncPublishedDirectory = fsyncDirectory } = {},
) {
  const terminal = terminalEvidence(inspected, waited);
  if (!terminal) fail('STOP_PROOF_MISSING', 'Terminal Docker state не подтвержден');
  const location = stopProofPath(root, metadata, { create: true });
  const proof = stopProofValue(metadata, terminal);
  const existing = readStopProof(root, metadata);
  if (existing) {
    if (canonicalJson(existing) !== canonicalJson(proof)) {
      fail('STOP_PROOF_CONFLICT', 'Docker stop proof конфликтует с terminal state');
    }
    return { ...existing, path: location.relative };
  }
  const temporary = path.join(
    path.dirname(location.file),
    `.${location.metadataHash}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = openSync(temporary, 'wx', 0o600);
    writeFileSync(handle, `${JSON.stringify(proof)}\n`);
    fsyncSync(handle);
    closeSync(handle);
    handle = undefined;
    linkSync(temporary, location.file);
    unlinkSync(temporary);
    syncPublishedDirectory(path.dirname(location.file));
  } catch (error) {
    if (handle !== undefined) closeSync(handle);
    if (existsNoFollow(temporary)) unlinkSync(temporary);
    if (error.code === 'EEXIST') {
      const concurrent = readStopProof(root, metadata);
      if (concurrent && canonicalJson(concurrent) === canonicalJson(proof)) {
        return { ...concurrent, path: location.relative };
      }
      fail('STOP_PROOF_CONFLICT', 'Docker stop proof уже записан с другими данными');
    }
    throw error;
  }
  const durable = readStopProof(root, metadata);
  return { ...durable, path: location.relative };
}
