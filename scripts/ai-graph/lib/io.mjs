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

const ERROR_GUIDANCE = Object.freeze({
  INTEGRATION_CONFLICT: {
    message: 'Flowcairn не смог безопасно подключить правила проекта: найден старый, измененный или неполный блок интеграции.',
    where: 'AGENTS.md или AGENTS.override.md',
    action: 'Сначала проверьте старый блок Flowcairn в этом файле. Не удаляйте весь файл с правилами проекта; после исправления повторите flowcairn setup.',
  },
  INTEGRATION_MODIFIED: {
    message: 'Блок интеграции Flowcairn изменился после установки, поэтому он не был перезаписан.',
    where: 'AGENTS.md или AGENTS.override.md',
    action: 'Сохраните пользовательские изменения, восстановите целостный блок Flowcairn или удалите только старую интеграцию после проверки, затем повторите setup.',
  },
  INTEGRATION_INCOMPLETE_DISCOVERY: {
    message: 'Flowcairn не смог полностью прочитать правила проекта и остановился до изменений.',
    where: 'AGENTS.md, AGENTS.override.md и .agents/skills',
    action: 'Исправьте ошибки чтения, ссылки или лимиты инструкций и повторите setup.',
  },
  INSTRUCTION_CHANGED: {
    message: 'Правила проекта изменились после их проверки, поэтому старое согласие больше не подходит.',
    where: 'Файл инструкции, указанный в сообщении проверки',
    action: 'Повторите inspect/setup и подтвердите актуальный набор правил.',
  },
  PROJECT_PROFILE_INVALID: {
    message: 'Профиль Flowcairn в проекте поврежден или не соответствует текущему формату.',
    where: '.flowcairn.json',
    action: 'Сохраните файл для разбора и не удаляйте его вслепую; проверьте конфликтующую установку и повторите setup.',
  },
  PROVIDER_AUTH_REQUIRED: {
    message: 'Выбранный AI-клиент не авторизован.',
    where: 'Локальный CLI выбранного AI-клиента',
    action: 'Войдите в CLI напрямую и повторите flowcairn setup.',
  },
  PROVIDER_TOOLCHAIN_INVALID: {
    message: 'Выбранный AI-клиент не найден или не прошел проверку версии.',
    where: 'Установленный CLI и его версия',
    action: 'Проверьте официальную установку CLI и повторите setup.',
  },
  PROVIDER_PLATFORM: {
    message: 'Выбранный AI-клиент не поддерживается на этой платформе.',
    where: 'Платформа запуска и выбранный provider',
    action: 'Выберите поддерживаемый локальный CLI для этой ОС.',
  },
  CHECK_SCRIPT_MISSING: {
    message: 'В проекте не найден script, необходимый для выбранной проверки.',
    where: 'package.json → scripts',
    action: 'Добавьте или выберите существующий script, затем повторите настройку проверок.',
  },
  PACKAGE_MANAGER: {
    message: 'Flowcairn не смог однозначно определить менеджер пакетов проекта.',
    where: 'package.json и lock-файлы проекта',
    action: 'Оставьте один поддерживаемый lock-файл или укажите --package-manager npm|pnpm|yarn.',
  },
});

/** Stable machine code plus a short explanation for a person running the CLI. */
export function explainError(error) {
  const code = error?.code ?? 'INVALID_INPUT';
  const guidance = ERROR_GUIDANCE[code];
  if (!guidance) return { message: error?.message ?? 'Операция не выполнена.' };
  return { ...guidance, technical: error?.message && error.message !== guidance.message ? error.message : undefined };
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
