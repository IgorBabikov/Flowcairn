import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { TextDecoder } from 'node:util';
import { GraphError, assertRunId, canonicalJson, sha256 } from './io.mjs';

const STORE_VERSION = 1;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_STRING_BYTES = 64 * 1024;
const MAX_DEPTH = 32;
const MAX_CONTAINER_ENTRIES = 10_000;
const MAX_TOTAL_VALUES = 100_000;
const MAX_REVISIONS = 10_000;
const MAX_HISTORY_LIMIT = 1_000;
const MAX_UPDATER_MS = 1_000;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const OWNER_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const PROCESS_START_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const OBJECT_KINDS = new Set([
  'tasks',
  'plans',
  'envelopes',
  'provider-consents',
  'receipts',
  'artifacts',
  'operations',
]);
const SENSITIVE_KEYS = new Set([
  'rawlog',
  'rawlogs',
  'rawoutput',
  'stdout',
  'stderr',
  'prompt',
  'systemprompt',
  'developerprompt',
  'secret',
  'secrets',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'cookie',
  'setcookie',
  'rawaudio',
  'audiobytes',
]);
const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const utf8 = new TextDecoder('utf-8', { fatal: true });
const PROCESS_START = new Date(Date.now() - Math.floor(process.uptime() * 1_000)).toISOString();

function fail(code, message, details) {
  throw new GraphError(code, message, details);
}

function exactKeys(value, expected, label, code = 'STORE_TAMPERED') {
  if (!isPlainObject(value)) fail(code, `${label} должен быть plain JSON object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(code, `${label} содержит недопустимые поля`);
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizedKey(key) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function inspectJson(value, label, { requireObject = true } = {}) {
  if (requireObject && !isPlainObject(value)) {
    fail('INVALID_STORE_DATA', `${label} должен быть plain JSON object`);
  }
  const ancestors = new WeakSet();
  let values = 0;

  const visit = (current, depth, currentLabel) => {
    values += 1;
    if (values > MAX_TOTAL_VALUES) {
      fail('STORE_LIMIT_EXCEEDED', `${label} содержит слишком много JSON values`);
    }
    if (depth > MAX_DEPTH) fail('STORE_LIMIT_EXCEEDED', `${label} превышает JSON depth limit`);
    if (current === null || typeof current === 'boolean') return;
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) fail('INVALID_STORE_DATA', `${currentLabel} не JSON number`);
      return;
    }
    if (typeof current === 'string') {
      if (Buffer.byteLength(current) > MAX_STRING_BYTES) {
        fail('STORE_LIMIT_EXCEEDED', `${currentLabel} превышает string limit`);
      }
      if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(current)) {
        fail('SENSITIVE_STORE_DATA', `${currentLabel} содержит private key material`);
      }
      return;
    }
    if (typeof current !== 'object') {
      fail('INVALID_STORE_DATA', `${currentLabel} содержит не-JSON value`);
    }
    if (ancestors.has(current)) fail('INVALID_STORE_DATA', `${currentLabel} содержит cycle`);
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        if (current.length > MAX_CONTAINER_ENTRIES) {
          fail('STORE_LIMIT_EXCEEDED', `${currentLabel} превышает array limit`);
        }
        for (let index = 0; index < current.length; index += 1) {
          if (!Object.hasOwn(current, index)) {
            fail('INVALID_STORE_DATA', `${currentLabel} содержит sparse array`);
          }
          visit(current[index], depth + 1, `${currentLabel}[${index}]`);
        }
        return;
      }
      if (!isPlainObject(current)) {
        fail('INVALID_STORE_DATA', `${currentLabel} должен быть plain JSON object`);
      }
      const keys = Object.keys(current);
      if (Reflect.ownKeys(current).length !== keys.length) {
        fail('INVALID_STORE_DATA', `${currentLabel} содержит hidden или symbol fields`);
      }
      if (keys.length > MAX_CONTAINER_ENTRIES) {
        fail('STORE_LIMIT_EXCEEDED', `${currentLabel} превышает object field limit`);
      }
      const descriptors = Object.getOwnPropertyDescriptors(current);
      for (const key of keys) {
        if (Buffer.byteLength(key) > 256 || key.includes('\0')) {
          fail('INVALID_STORE_DATA', `${currentLabel} содержит недопустимый key`);
        }
        if (FORBIDDEN_OBJECT_KEYS.has(key)) {
          fail('INVALID_STORE_DATA', `${currentLabel} содержит небезопасный key`);
        }
        if (SENSITIVE_KEYS.has(normalizedKey(key))) {
          fail('SENSITIVE_STORE_DATA', `${currentLabel}.${key} запрещен для persistent store`);
        }
        const descriptor = descriptors[key];
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
          fail('INVALID_STORE_DATA', `${currentLabel}.${key} должен быть data field`);
        }
        visit(descriptor.value, depth + 1, `${currentLabel}.${key}`);
      }
    } finally {
      ancestors.delete(current);
    }
  };

  visit(value, 0, label);
}

function validatedClone(value, label, options) {
  inspectJson(value, label, options);
  const serialized = canonicalJson(value);
  if (typeof serialized !== 'string') fail('INVALID_STORE_DATA', `${label} не сериализуется`);
  if (Buffer.byteLength(serialized) > MAX_JSON_BYTES) {
    fail('STORE_LIMIT_EXCEEDED', `${label} превышает JSON size limit`);
  }
  return JSON.parse(serialized);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/** @overload @param {string} target @param {{bigint:true}} options @returns {import('node:fs').BigIntStats|null} */
/** @overload @param {string} target @returns {import('node:fs').Stats|null} */
/** @param {string} target @param {{bigint:true}} [options] */
function lstatMaybe(target, options) {
  try {
    return lstatSync(target, options);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

function inodeIdentity(stat) {
  return `${stat.dev}:${stat.ino}`;
}

function fileIdentity(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(
    ':',
  );
}

function assertPrivateDirectory(directory, label = 'Store directory') {
  const stat = lstatMaybe(directory, { bigint: true });
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    fail('INSECURE_STORE', `${label} должен быть обычной directory`);
  }
  if ((stat.mode & 0o077n) !== 0n) {
    fail('INSECURE_STORE', `${label} должен быть private`);
  }
  return stat;
}

function ensurePrivateChild(parent, name) {
  const target = path.join(parent, name);
  let created = false;
  if (!lstatMaybe(target)) {
    try {
      mkdirSync(target, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  assertPrivateDirectory(target);
  if (created) fsyncDirectory(parent);
  return target;
}

function fsyncDirectory(directory) {
  let handle;
  try {
    handle = openSync(directory, constants.O_RDONLY);
    fsyncSync(handle);
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

function readPrivateJson(file, { code = 'STORE_TAMPERED', maxBytes = MAX_JSON_BYTES } = {}) {
  const before = lstatMaybe(file, { bigint: true });
  if (!before) fail('STORE_NOT_FOUND', 'Persistent object не найден');
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    fail(code, 'Persistent object должен быть regular file без hardlinks');
  }
  if ((before.mode & 0o077n) !== 0n)
    fail('INSECURE_STORE', 'Persistent object должен быть private');
  if (before.size > BigInt(maxBytes))
    fail('STORE_LIMIT_EXCEEDED', 'Persistent object слишком велик');
  let handle;
  try {
    handle = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(handle, { bigint: true });
    if (fileIdentity(before) !== fileIdentity(opened)) fail(code, 'Persistent object был заменен');
    const bytes = readFileSync(handle);
    const after = fstatSync(handle, { bigint: true });
    if (fileIdentity(opened) !== fileIdentity(after) || BigInt(bytes.length) !== after.size) {
      fail(code, 'Persistent object изменился во время чтения');
    }
    let text;
    try {
      text = utf8.decode(bytes);
    } catch {
      fail(code, 'Persistent object должен быть UTF-8 JSON');
    }
    try {
      return { value: JSON.parse(text), stat: after };
    } catch {
      fail(code, 'Persistent object содержит некорректный JSON');
    }
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

function assertHash(hash) {
  if (typeof hash !== 'string' || !HASH_PATTERN.test(hash)) {
    fail('INVALID_HASH', 'hash должен быть lowercase SHA-256');
  }
  return hash;
}

function assertKind(kind) {
  if (typeof kind !== 'string' || !OBJECT_KINDS.has(kind)) {
    fail('INVALID_STORE_KIND', 'Store kind не разрешен');
  }
  return kind;
}

function assertRevision(value, label = 'revision') {
  if (!Number.isSafeInteger(value) || value < 0 || value >= MAX_REVISIONS) {
    fail('INVALID_REVISION', `${label} должен быть bounded non-negative integer`);
  }
  return value;
}

function normalizeState(runId, state, revision, { previousRevision = null } = {}) {
  const clone = validatedClone(state, 'state');
  if (Object.hasOwn(clone, 'runId') && clone.runId !== runId) {
    fail('STATE_INVARIANT', 'state.runId не совпадает с runId');
  }
  if (Object.hasOwn(clone, 'revision')) {
    const accepted = previousRevision === null ? [revision] : [previousRevision, revision];
    if (!accepted.includes(clone.revision)) {
      fail('STATE_INVARIANT', 'state.revision нарушает store revision invariant');
    }
  }
  clone.runId = runId;
  clone.revision = revision;
  return validatedClone(clone, 'state');
}

function assertStoredState(runId, revision, state) {
  const clone = validatedClone(state, 'state');
  if (clone.runId !== runId || clone.revision !== revision) {
    fail('STORE_TAMPERED', 'Stored state нарушает runId/revision invariant');
  }
  return clone;
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function processStatus(pid) {
  try {
    process.kill(pid, 0);
    return 'live';
  } catch (error) {
    if (error.code === 'ESRCH') return 'dead';
    return 'unknown';
  }
}

export class GraphStore {
  constructor(root, { fault = null } = {}) {
    if (fault !== null && typeof fault !== 'function') {
      fail('INVALID_FAULT_INJECTOR', 'fault должен быть trusted synchronous function');
    }
    let resolved;
    try {
      resolved = realpathSync(root);
    } catch {
      fail('INVALID_STORE_ROOT', 'Store root не существует');
    }
    const stat = lstatSync(resolved, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail('INVALID_STORE_ROOT', 'Store root должен быть directory');
    }
    this.root = resolved;
    this.rootIdentity = inodeIdentity(stat);
    this.graphRoot = path.join(resolved, '.ai-orchestrator', 'graph');
    this.fault = fault;
  }

  createRun(runId, state) {
    assertRunId(runId);
    const initial = normalizeState(runId, state, 0);
    const runsDirectory = this.#ensureRunsDirectory();
    const runDirectory = ensurePrivateChild(runsDirectory, runId);
    return this.#withRunLock(runId, runDirectory, () => {
      const existingPointer = lstatMaybe(path.join(runDirectory, 'state.json'));
      if (existingPointer) {
        const existing = this.#readChain(runId, runDirectory);
        if (!sameJson(existing.states[0], initial)) {
          fail('RUN_EXISTS', 'Run уже создан с другим initial state');
        }
        return structuredClone(existing.states.at(-1));
      }
      const revisionsDirectory = ensurePrivateChild(runDirectory, 'revisions');
      const envelope = { revision: 0, parentHash: null, state: initial };
      const hash = this.#persistRevision(revisionsDirectory, envelope, { runId, revision: 0 });
      this.#commitPointer(runDirectory, { revision: 0, hash }, { runId, revision: 0 });
      return structuredClone(initial);
    });
  }

  readRun(runId) {
    assertRunId(runId);
    const runDirectory = this.#runDirectoryForRead(runId);
    return structuredClone(this.#readChain(runId, runDirectory).states.at(-1));
  }

  // Notification hint only: consumers must reload and validate the complete snapshot.
  revision(runId) {
    assertRunId(runId);
    const directory = this.#runDirectoryForRead(runId);
    const { value: pointer } = readPrivateJson(path.join(directory, 'state.json'));
    exactKeys(pointer, ['revision', 'hash'], 'state pointer');
    assertRevision(pointer.revision);
    assertHash(pointer.hash);
    return pointer.revision;
  }

  withRunFence(runId, expectedRevision, callbackSync) {
    assertRunId(runId);
    assertRevision(expectedRevision, 'expectedRevision');
    if (typeof callbackSync !== 'function' || callbackSync.constructor?.name === 'AsyncFunction') {
      fail('INVALID_FENCE', 'callbackSync должен быть synchronous function');
    }
    const runDirectory = this.#runDirectoryForRead(runId);
    return this.#withRunLock(runId, runDirectory, () => {
      const current = this.#readChain(runId, runDirectory);
      if (current.pointer.revision !== expectedRevision) {
        fail('CAS_CONFLICT', 'expectedRevision не совпадает с committed revision', {
          expectedRevision,
          actualRevision: current.pointer.revision,
        });
      }
      const result = callbackSync(deepFreeze(structuredClone(current.states.at(-1))));
      if (result && typeof result.then === 'function') {
        fail('INVALID_FENCE', 'callbackSync не может быть async');
      }
      return result;
    });
  }

  updateRun(runId, expectedRevision, updaterSync) {
    assertRunId(runId);
    assertRevision(expectedRevision, 'expectedRevision');
    if (typeof updaterSync !== 'function')
      fail('INVALID_UPDATER', 'updaterSync должен быть function');
    if (updaterSync.constructor?.name === 'AsyncFunction') {
      fail('INVALID_UPDATER', 'updaterSync не может быть async');
    }
    const runDirectory = this.#runDirectoryForRead(runId);
    return this.#withRunLock(runId, runDirectory, () => {
      const current = this.#readChain(runId, runDirectory);
      const currentState = current.states.at(-1);
      if (current.pointer.revision !== expectedRevision) {
        fail('CAS_CONFLICT', 'expectedRevision не совпадает с committed revision', {
          expectedRevision,
          actualRevision: current.pointer.revision,
        });
      }
      if (expectedRevision + 1 >= MAX_REVISIONS) {
        fail('REVISION_LIMIT_EXCEEDED', 'Run достиг revision limit');
      }
      const input = deepFreeze(structuredClone(currentState));
      const startedAt = performance.now();
      const updated = updaterSync(input);
      const elapsed = performance.now() - startedAt;
      if (updated && typeof updated.then === 'function') {
        fail('INVALID_UPDATER', 'updaterSync не может быть async');
      }
      if (elapsed > MAX_UPDATER_MS) {
        fail('UPDATER_TIMEOUT', 'updaterSync превысил time limit');
      }
      const revision = expectedRevision + 1;
      const nextState = normalizeState(runId, updated, revision, {
        previousRevision: expectedRevision,
      });
      const revisionsDirectory = path.join(runDirectory, 'revisions');
      assertPrivateDirectory(revisionsDirectory);
      const envelope = {
        revision,
        parentHash: current.pointer.hash,
        state: nextState,
      };
      const hash = this.#persistRevision(revisionsDirectory, envelope, { runId, revision });
      this.#commitPointer(runDirectory, { revision, hash }, { runId, revision });
      return structuredClone(nextState);
    });
  }

  listRunIds() {
    const graphDirectory = this.#graphDirectoryForRead({ allowMissing: true });
    if (!graphDirectory) return [];
    const runsDirectory = path.join(graphDirectory, 'runs');
    if (!lstatMaybe(runsDirectory)) return [];
    assertPrivateDirectory(runsDirectory);
    const ids = readdirSync(runsDirectory).sort();
    for (const runId of ids) {
      try {
        assertRunId(runId);
      } catch {
        fail('STORE_TAMPERED', 'Runs directory содержит недопустимый entry');
      }
      assertPrivateDirectory(path.join(runsDirectory, runId), 'Run directory');
    }
    return ids;
  }

  putObject(kind, data) {
    assertKind(kind);
    const clone = validatedClone(data, `${kind} object`);
    const hash = sha256(canonicalJson(clone));
    const graphDirectory = this.#ensureGraphDirectory();
    const kindDirectory = ensurePrivateChild(graphDirectory, kind);
    const file = path.join(kindDirectory, `${hash}.json`);
    const wrapper = { version: STORE_VERSION, kind, hash, data: clone };
    if (lstatMaybe(file)) {
      const existing = this.#readStoredObject(kind, hash, kindDirectory);
      if (!sameJson(existing, clone)) fail('IMMUTABLE_CONFLICT', 'Object hash collision');
      fsyncDirectory(kindDirectory);
      return hash;
    }
    this.#writeDurableFile(kindDirectory, file, wrapper, 'object', { kind, hash });
    return hash;
  }

  readObject(kind, hash) {
    assertKind(kind);
    assertHash(hash);
    const graphDirectory = this.#graphDirectoryForRead();
    const kindDirectory = path.join(graphDirectory, kind);
    assertPrivateDirectory(kindDirectory);
    return structuredClone(this.#readStoredObject(kind, hash, kindDirectory));
  }

  history(runId, { afterRevision = -1, limit = 100 } = {}) {
    assertRunId(runId);
    if (!Number.isSafeInteger(afterRevision) || afterRevision < -1) {
      fail('INVALID_HISTORY_QUERY', 'afterRevision должен быть integer >= -1');
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HISTORY_LIMIT) {
      fail('INVALID_HISTORY_QUERY', `limit должен быть в диапазоне 1..${MAX_HISTORY_LIMIT}`);
    }
    const runDirectory = this.#runDirectoryForRead(runId);
    return this.#readChain(runId, runDirectory)
      .states.filter((state) => state.revision > afterRevision)
      .slice(0, limit)
      .map((state) => structuredClone(state));
  }

  inspectLock(runId) {
    assertRunId(runId);
    const runDirectory = this.#runDirectoryForRead(runId, { allowMissing: true });
    if (!runDirectory) return null;
    const lock = this.#readLock(runDirectory, { allowMissing: true });
    if (!lock) return null;
    return { ...lock.record, status: processStatus(lock.record.pid) };
  }

  recoverLock(runId) {
    assertRunId(runId);
    const runDirectory = this.#runDirectoryForRead(runId, { allowMissing: true });
    if (!runDirectory) return { recovered: false, reason: 'not-found' };
    const lock = this.#readLock(runDirectory, { allowMissing: true });
    if (!lock) return { recovered: false, reason: 'not-locked' };
    const status = processStatus(lock.record.pid);
    if (status === 'live') fail('RUN_LOCKED', 'Lock writer еще жив');
    if (status !== 'dead') fail('LOCK_UNCERTAIN', 'Нельзя доказать остановку lock writer');
    const current = this.#readLock(runDirectory);
    if (
      fileIdentity(current.stat) !== fileIdentity(lock.stat) ||
      !sameJson(current.record, lock.record)
    ) {
      fail('LOCK_CHANGED', 'Lock изменился во время recovery');
    }
    unlinkSync(path.join(runDirectory, '.lock'));
    fsyncDirectory(runDirectory);
    return { recovered: true, owner: lock.record.owner };
  }

  #fault(stage, context) {
    if (!this.fault) return;
    const result = this.fault(stage, Object.freeze({ ...context }));
    if (result && typeof result.then === 'function') {
      fail('INVALID_FAULT_INJECTOR', 'fault должен быть synchronous');
    }
  }

  #assertRoot() {
    const stat = lstatSync(this.root, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || inodeIdentity(stat) !== this.rootIdentity) {
      fail('INSECURE_STORE', 'Store root изменился');
    }
  }

  #ensureGraphDirectory() {
    this.#assertRoot();
    const control = ensurePrivateChild(this.root, '.ai-orchestrator');
    return ensurePrivateChild(control, 'graph');
  }

  #ensureRunsDirectory() {
    return ensurePrivateChild(this.#ensureGraphDirectory(), 'runs');
  }

  #graphDirectoryForRead({ allowMissing = false } = {}) {
    this.#assertRoot();
    const control = path.join(this.root, '.ai-orchestrator');
    if (!lstatMaybe(control)) {
      if (allowMissing) return null;
      fail('STORE_NOT_FOUND', 'Graph store не создан');
    }
    assertPrivateDirectory(control, 'Control directory');
    if (!lstatMaybe(this.graphRoot)) {
      if (allowMissing) return null;
      fail('STORE_NOT_FOUND', 'Graph store не создан');
    }
    assertPrivateDirectory(this.graphRoot, 'Graph store directory');
    return this.graphRoot;
  }

  #runDirectoryForRead(runId, { allowMissing = false } = {}) {
    const graphDirectory = this.#graphDirectoryForRead({ allowMissing });
    if (!graphDirectory) return null;
    const runsDirectory = path.join(graphDirectory, 'runs');
    if (!lstatMaybe(runsDirectory)) {
      if (allowMissing) return null;
      fail('RUN_NOT_FOUND', 'Run не найден');
    }
    assertPrivateDirectory(runsDirectory, 'Runs directory');
    const runDirectory = path.join(runsDirectory, runId);
    if (!lstatMaybe(runDirectory)) {
      if (allowMissing) return null;
      fail('RUN_NOT_FOUND', 'Run не найден');
    }
    assertPrivateDirectory(runDirectory, 'Run directory');
    return runDirectory;
  }

  #readChain(runId, runDirectory) {
    const pointerFile = path.join(runDirectory, 'state.json');
    if (!lstatMaybe(pointerFile)) fail('RUN_INCOMPLETE', 'Run не имеет committed state pointer');
    const { value: pointer } = readPrivateJson(pointerFile);
    exactKeys(pointer, ['revision', 'hash'], 'state pointer');
    assertRevision(pointer.revision);
    assertHash(pointer.hash);
    const revisionsDirectory = path.join(runDirectory, 'revisions');
    assertPrivateDirectory(revisionsDirectory, 'Revisions directory');
    const descending = [];
    let expectedHash = pointer.hash;
    for (let revision = pointer.revision; revision >= 0; revision -= 1) {
      const file = path.join(revisionsDirectory, `${revision}-${expectedHash}.json`);
      const { value: envelope } = readPrivateJson(file);
      exactKeys(envelope, ['revision', 'parentHash', 'state'], 'revision envelope');
      if (envelope.revision !== revision || sha256(canonicalJson(envelope)) !== expectedHash) {
        fail('STORE_TAMPERED', 'Revision envelope hash или sequence не совпадает');
      }
      if (revision === 0) {
        if (envelope.parentHash !== null) fail('STORE_TAMPERED', 'Initial revision имеет parent');
      } else {
        assertHash(envelope.parentHash);
      }
      descending.push(assertStoredState(runId, revision, envelope.state));
      expectedHash = envelope.parentHash;
    }
    if (expectedHash !== null) fail('STORE_TAMPERED', 'Revision chain не завершен');
    return { pointer, states: descending.reverse() };
  }

  #persistRevision(revisionsDirectory, envelope, context) {
    const clone = validatedClone(envelope, 'revision envelope');
    const hash = sha256(canonicalJson(clone));
    const file = path.join(revisionsDirectory, `${clone.revision}-${hash}.json`);
    if (lstatMaybe(file)) {
      const { value: existing } = readPrivateJson(file);
      if (!sameJson(existing, clone)) fail('IMMUTABLE_CONFLICT', 'Revision hash collision');
      fsyncDirectory(revisionsDirectory);
      return hash;
    }
    this.#writeDurableFile(revisionsDirectory, file, clone, 'revision', { ...context, hash });
    return hash;
  }

  #commitPointer(runDirectory, pointer, context) {
    this.#writeDurableFile(
      runDirectory,
      path.join(runDirectory, 'state.json'),
      pointer,
      'pointer',
      context,
    );
  }

  #writeDurableFile(directory, file, value, category, context) {
    assertPrivateDirectory(directory);
    const temporary = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
    const bytes = Buffer.from(`${canonicalJson(value)}\n`, 'utf8');
    if (bytes.length > MAX_JSON_BYTES)
      fail('STORE_LIMIT_EXCEEDED', 'Persistent object слишком велик');
    let handle;
    this.#fault(`${category}.before-write`, context);
    try {
      handle = openSync(temporary, 'wx', 0o600);
      writeFileSync(handle, bytes);
      this.#fault(`${category}.after-write`, context);
      this.#fault(`${category}.before-file-fsync`, context);
      fsyncSync(handle);
      this.#fault(`${category}.after-file-fsync`, context);
    } finally {
      if (handle !== undefined) closeSync(handle);
    }
    this.#fault(`${category}.before-rename`, context);
    renameSync(temporary, file);
    this.#fault(`${category}.after-rename`, context);
    this.#fault(`${category}.before-directory-fsync`, context);
    fsyncDirectory(directory);
    this.#fault(`${category}.after-directory-fsync`, context);
  }

  #readStoredObject(kind, hash, kindDirectory) {
    const file = path.join(kindDirectory, `${assertHash(hash)}.json`);
    const { value: wrapper } = readPrivateJson(file, { code: 'OBJECT_TAMPERED' });
    exactKeys(wrapper, ['version', 'kind', 'hash', 'data'], 'stored object', 'OBJECT_TAMPERED');
    if (wrapper.version !== STORE_VERSION || wrapper.kind !== kind || wrapper.hash !== hash) {
      fail('OBJECT_TAMPERED', 'Stored object identity не совпадает');
    }
    const data = validatedClone(wrapper.data, `${kind} object`);
    if (sha256(canonicalJson(data)) !== hash)
      fail('OBJECT_TAMPERED', 'Stored object hash не совпадает');
    return data;
  }

  #withRunLock(runId, runDirectory, callback) {
    const lockFile = path.join(runDirectory, '.lock');
    const record = {
      version: STORE_VERSION,
      owner: randomUUID(),
      pid: process.pid,
      processStart: PROCESS_START,
    };
    let handle;
    let stat;
    try {
      handle = openSync(lockFile, 'wx', 0o600);
      writeFileSync(handle, `${canonicalJson(record)}\n`);
      fsyncSync(handle);
      stat = fstatSync(handle, { bigint: true });
      fsyncDirectory(runDirectory);
    } catch (error) {
      if (handle !== undefined) closeSync(handle);
      if (error.code === 'EEXIST') fail('RUN_LOCKED', 'Этот run уже изменяется другим writer');
      throw error;
    }
    try {
      this.#fault('lock.acquired', { runId, owner: record.owner });
      return callback();
    } finally {
      closeSync(handle);
      const current = this.#readLock(runDirectory);
      if (
        current.record.owner !== record.owner ||
        fileIdentity(current.stat) !== fileIdentity(stat)
      ) {
        fail('LOCK_OWNERSHIP_LOST', 'Writer больше не владеет lock');
      }
      unlinkSync(lockFile);
      fsyncDirectory(runDirectory);
    }
  }

  #readLock(runDirectory, { allowMissing = false } = {}) {
    const file = path.join(runDirectory, '.lock');
    if (!lstatMaybe(file)) {
      if (allowMissing) return null;
      fail('LOCK_OWNERSHIP_LOST', 'Run lock исчез');
    }
    const { value: record, stat } = readPrivateJson(file, {
      code: 'INVALID_LOCK',
      maxBytes: 4_096,
    });
    exactKeys(record, ['version', 'owner', 'pid', 'processStart'], 'lock', 'INVALID_LOCK');
    if (
      record.version !== STORE_VERSION ||
      typeof record.owner !== 'string' ||
      !OWNER_PATTERN.test(record.owner) ||
      !Number.isSafeInteger(record.pid) ||
      record.pid < 1 ||
      record.pid > 2_147_483_647 ||
      typeof record.processStart !== 'string' ||
      !PROCESS_START_PATTERN.test(record.processStart) ||
      !Number.isFinite(Date.parse(record.processStart))
    ) {
      fail('INVALID_LOCK', 'Run lock содержит недопустимые fields');
    }
    return { record, stat };
  }
}

export const GRAPH_STORE_LIMITS = Object.freeze({
  maxJsonBytes: MAX_JSON_BYTES,
  maxStringBytes: MAX_STRING_BYTES,
  maxDepth: MAX_DEPTH,
  maxContainerEntries: MAX_CONTAINER_ENTRIES,
  maxTotalValues: MAX_TOTAL_VALUES,
  maxRevisions: MAX_REVISIONS,
  maxHistoryLimit: MAX_HISTORY_LIMIT,
  maxUpdaterMs: MAX_UPDATER_MS,
});
