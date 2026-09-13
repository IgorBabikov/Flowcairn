import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export class GraphError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'GraphError';
    this.code = code;
    this.details = details;
  }
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashObject(value) {
  return sha256(canonicalJson(value));
}

export function readJson(file, code = 'READ_FAILED') {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new GraphError(code, `Не удалось прочитать ${file}: ${error.message}`);
  }
}

export function writeJsonAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

export function writeJsonOnce(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = openSync(file, 'wx', 0o600);
    writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new GraphError('IMMUTABLE_EXISTS', `Неизменяемый файл уже существует: ${file}`);
    }
    throw error;
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

export function withLock(lockFile, callback) {
  mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = openSync(lockFile, 'wx', 0o600);
    writeFileSync(handle, `${process.pid}\n`);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new GraphError('RUN_LOCKED', 'Этот run уже изменяется другим процессом');
    }
    throw error;
  }
  try {
    return callback();
  } finally {
    closeSync(handle);
    rmSync(lockFile, { force: true });
  }
}

export function assertId(value, label) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{2,39}$/.test(value)) {
    throw new GraphError(
      'INVALID_ID',
      `${label} должен содержать 3–40 строчных букв, цифр или дефисов`,
    );
  }
  return value;
}

export function assertRunId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{2,79}$/.test(value)) {
    throw new GraphError(
      'INVALID_RUN_ID',
      'runId должен содержать 3–80 строчных букв, цифр или дефисов',
    );
  }
  return value;
}

export function mustExist(file, code = 'NOT_FOUND') {
  if (!existsSync(file)) throw new GraphError(code, `Файл не найден: ${file}`);
  return file;
}

export function now() {
  return new Date().toISOString();
}
