import type { GraphNodeSnapshot, RunStatus } from './contracts';

type Locale = 'ru' | 'en';
const stages: Record<string, string> = {
  'understand task': 'Разобраться в задаче',
  analysis: 'Анализ задачи',
  analyze: 'Анализ задачи',
  'approve plan': 'Согласование плана',
  'plan approval': 'Согласование плана',
  implementation: 'Внесение изменений',
  implement: 'Внесение изменений',
  checks: 'Проверки результата',
  tests: 'Проверка тестов',
  build: 'Проверка сборки',
  typecheck: 'Проверка типов',
  lint: 'Проверка стиля кода',
  review: 'Проверка изменений',
  'независимое review': 'Проверка изменений',
  'accept result': 'Приемка результата',
  'final acceptance': 'Приемка результата',
};

export function nodeTitle(node: Pick<GraphNodeSnapshot, 'id' | 'title'>, locale: Locale): string {
  if (locale === 'en') return node.title;
  const legacyIds = [
    'approve-plan',
    'analyze',
    'implement',
    'workspace-check',
    'tests',
    'verify-tests',
    'typecheck',
    'lint',
    'build',
    'review',
    'handoff',
    'accept-result',
  ];
  if (!legacyIds.includes(node.id)) return node.title;
  const normalized = node.title
    .toLowerCase()
    .replace(/^verify[ :_-]+/, '')
    .trim();
  // Preserve author-provided labels outside the bounded legacy vocabulary.
  return stages[normalized] ?? node.title;
}

const reasons: Record<string, string> = {
  'Пройдена проверка tests': 'Тесты пройдены',
  'Пройдена проверка typecheck': 'Проверка типов пройдена',
  'Пройдена проверка lint': 'Проверка стиля кода пройдена',
  'Пройдена проверка build': 'Проект собран',
  'Изменения ограничены утвержденным scope': 'Изменения ограничены согласованными границами задачи',
  'Evidence и изменения собраны для приемки': 'Результаты проверок и изменения собраны для приемки',
  'Integrity не подтверждена': 'Целостность данных не подтверждена',
  'Run закрыт': 'Запуск закрыт',
  'Run заблокирован другим writer': 'Проект занят другим исполнителем',
  'Runner не прошел проверку изоляции': 'Исполнитель не прошел проверку изоляции',
  'Receipt еще нет': 'Отчета о выполнении пока нет',
  'Остановка подтверждена; требуется replan': 'Остановка подтверждена; нужен новый план',
  'Нужна безопасная failed-попытка; passed checks повторяются в новой версии':
    'Нужна безопасная попытка с ошибкой. Успешные проверки повторяются в новой версии плана',
  'Нет безопасной failed-проверки': 'Нет проверки, которую безопасно повторить',
  AI_AUTH_REQUIRED: 'Нужно подключить AI-исполнителя',
  CHECK_IMAGE_MISSING: 'Не настроен образ среды проверок',
  CHECK_RUNTIME_UNAVAILABLE: 'Среда проверок недоступна',
  CHECK_DESCENDANT_CONTAINMENT_UNVERIFIED: 'Изоляция процессов проверки не подтверждена',
  USE_DOCKER_PROBE: 'Требуется проверка среды Docker',
  UNSUPPORTED_PLATFORM: 'Эта платформа не поддерживается',
  RUNNER_TOOLCHAIN_INVALID: 'Инструменты исполнителя не прошли проверку',
  PROVIDER_RETIRED: 'OpenAI API больше не поддерживается. Выберите Codex, Claude Code или Cursor.',
  PROVIDER_AUTH_REQUIRED: 'AI-клиент не авторизован. Войдите в выбранный CLI и повторите запуск.',
  CODEX_MODEL_SETTINGS_REQUIRED: 'Модель и усиление CLI не определены. Задайте их в настройках flowcairn или конфигурации Codex CLI.',
  CODEX_AUTH_REQUIRED: 'Codex не авторизован. Выполните codex login и повторите запуск.',
  PROJECT_PROFILE_INVALID: 'Настройки проекта не прошли проверку',
  analysis: 'Анализ задачи',
  review: 'Ревью изменений',
  handoff: 'Подготовка результата',
  checks: 'Проверка',
  implementation: 'Внесение изменений',
  ai: 'AI-этап',
  gate: 'Решение человека',
};

export type RuntimeProblem = {
  title: string;
  summary: string;
  action: string;
};

const runtimeProblems: Record<string, RuntimeProblem> = {
  STORE_LIMIT_EXCEEDED: {
    title: 'Не удалось подготовить задачу',
    summary: 'Flowcairn остановился, пока сохранял безопасный снимок проекта. Задача не была передана AI, изменения в проект не вносились.',
    action: 'Перезапустите Flowcairn после обновления и начните анализ снова.',
  },
  DIRECT_LIMIT: {
    title: 'Не удалось подготовить задачу',
    summary: 'Для безопасного анализа проект оказался больше поддерживаемого предела. Задача не была передана AI, изменения не вносились.',
    action: 'Обновите Flowcairn и повторите запуск. Если проблема останется, приложите отчет из раздела «Доказательства».',
  },
  WORKSPACE_LIMIT_EXCEEDED: {
    title: 'Не удалось подготовить рабочее состояние',
    summary: 'Flowcairn остановился до изменений, потому что не смог безопасно проверить все нужные файлы.',
    action: 'Обновите Flowcairn и повторите запуск. Изменения в проект не вносились.',
  },
  SOURCE_CAPTURE_TIMEOUT: {
    title: 'Подготовка задачи заняла слишком много времени',
    summary: 'Flowcairn не успел безопасно собрать исходное состояние проекта. AI-анализ не запускался.',
    action: 'Повторите запуск. Если это повторится, проверьте, не занят ли диск или проект другим процессом.',
  },
  NETWORK_UNCERTAIN: {
    title: 'Не удалось связаться с локальным сервисом',
    summary: 'Результат операции неизвестен: ответ от Flowcairn не получен.',
    action: 'Обновите состояние. Не повторяйте изменение, пока не увидите актуальный результат.',
  },
  STOP_ACCEPTANCE_UNKNOWN: {
    title: 'Не удалось подтвердить остановку',
    summary: 'Не удалось подтвердить, принята ли команда остановки. Процесс мог продолжить работу.',
    action: 'Обновите состояние задачи перед следующим действием. Не отправляйте команду остановки повторно вслепую.',
  },
  SKILLS_CONTEXT_TOO_LARGE: {
    title: 'Для этой задачи подключено слишком много правил',
    summary: 'Flowcairn остановился до запуска AI, потому что выбранные правила не помещаются в безопасный контекст.',
    action: 'Сократите набор правил в настройках проекта и повторите запуск.',
  },
  RUNNER_TOOLCHAIN_INVALID: {
    title: 'Исполнитель пока не готов',
    summary: 'Flowcairn не смог безопасно проверить инструменты, которые нужны для выполнения задачи.',
    action: 'Откройте настройки проекта, исправьте установку исполнителя и перезапустите Flowcairn.',
  },
  PROVIDER_AUTH_REQUIRED: {
    title: 'Нужно войти в AI-исполнитель',
    summary: 'Flowcairn не может начать анализ, пока выбранный AI-клиент не авторизован.',
    action: 'Войдите в выбранный AI-клиент и повторите запуск.',
  },
  CODEX_AUTH_REQUIRED: {
    title: 'Нужно войти в Codex',
    summary: 'Flowcairn не может начать анализ, пока Codex не авторизован.',
    action: 'Выполните вход в Codex и повторите запуск.',
  },
  STALE_CONTEXT: {
    title: 'Данные задачи устарели',
    summary: 'Проект или настройки изменились, пока Flowcairn готовил действие.',
    action: 'Обновите состояние и создайте актуальный план.',
  },
  REVISION_CONFLICT: {
    title: 'Задача уже обновилась',
    summary: 'Другой шаг изменил состояние этой задачи раньше, чем был применен ваш запрос.',
    action: 'Обновите состояние и продолжайте по актуальному плану.',
  },
  PLAN_CONFLICT: {
    title: 'План уже изменился',
    summary: 'Ваше действие относится к предыдущей версии плана и не было выполнено.',
    action: 'Откройте актуальный план и повторите нужное действие.',
  },
  GATE_EXPIRED: {
    title: 'Подтверждение устарело',
    summary: 'План или его условия изменились до вашего подтверждения, поэтому действие не было выполнено.',
    action: 'Обновите состояние и подтвердите актуальный план заново.',
  },
};

const unknownRuntimeProblem: RuntimeProblem = {
  title: 'Не удалось продолжить работу',
  summary: 'Flowcairn остановил этот шаг до новых изменений, потому что не смог безопасно подтвердить его состояние.',
  action: 'Обновите состояние задачи. Если проблема повторится, откройте технические детали для диагностики.',
};

const isTechnicalDiagnostic = (value: string) =>
  /[A-Za-z]{3,}/.test(value) && !/[А-Яа-я]/.test(value);

export function technicalProblem(value: string | null | undefined): {
  code: string | null;
  message: string;
} | null {
  if (!value) return null;
  const match = /^([A-Z][A-Z0-9_]+)(?::|\s|$)/.exec(value);
  if (match?.[1])
    return {
      code: match[1],
      message: value.slice(match[0].length).trim() || value,
    };
  return isTechnicalDiagnostic(value) ? { code: null, message: value } : null;
}

/** Converts internal failures into an explanation and a safe next step for the operator. */
export function runtimeProblem(value: string | null | undefined, locale: Locale = 'ru'): RuntimeProblem | null {
  if (!value || locale === 'en') return null;
  const code = /^([A-Z][A-Z0-9_]+)(?::|\s|$)/.exec(value)?.[1];
  if (code) return runtimeProblems[code] ?? unknownRuntimeProblem;
  return isTechnicalDiagnostic(value) ? unknownRuntimeProblem : null;
}
const stateWords: Record<string, string> = {
  idle: 'не начат',
  pending: 'в очереди',
  ready: 'готов к запуску',
  running: 'выполняется',
  passed: 'завершен',
  failed: 'ошибка',
  waiting: 'ожидает решения',
  'waiting-for-human': 'нужно решение человека',
  uncertain: 'результат неизвестен',
  stale: 'устарел',
};
export function humanText(value: string | null | undefined, locale: Locale = 'ru'): string {
  if (!value) return '';
  if (locale === 'en') return value;
  const problem = runtimeProblem(value, locale);
  if (problem) return problem.summary;
  if (reasons[value]) return reasons[value];
  // Translate only a known runtime sentence, preserving the referenced machine ID.
  const dependency = /^Ожидается (.+): ([a-z-]+)$/.exec(value);
  if (dependency?.[2] && stateWords[dependency[2]])
    return `Ожидается этап ${dependency[1]}: ${stateWords[dependency[2]]}`;
  return value;
}

const hints: Record<RunStatus, [string, string]> = {
  idle: ['Выполнение еще не начато', 'Execution has not started'],
  pending: ['Ожидает выполнения условий', 'Waiting for prerequisites'],
  ready: ['Условия запуска выполнены', 'Prerequisites are met'],
  running: ['Сервер сообщил о выполнении', 'Service reports execution'],
  passed: ['Сервер подтвердил результат', 'Service confirmed the result'],
  failed: ['Причина ошибки — в деталях', 'See details for the failure reason'],
  waiting: ['Продолжение ждет решения', 'Continuation needs a decision'],
  'waiting-for-human': ['Нужно решение человека', 'A human decision is required'],
  uncertain: ['Перед повтором проверьте результат', 'Inspect the result before retrying'],
  stale: ['План или данные требуют проверки', 'Inspect the plan or data'],
};
export function statusHint(status: RunStatus, locale: Locale): string {
  return hints[status]?.[locale === 'ru' ? 0 : 1] ?? '';
}

const paths: Record<RunStatus, string> = {
  idle: 'M5 5h14v14H5z',
  pending: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16 M12 8v5h4',
  ready: 'M8 5l11 7-11 7z',
  running: 'M12 4a8 8 0 0 1 8 8 M20 12l-3-3 M20 12l2-4 M12 20a8 8 0 0 1-8-8 M4 12l3 3 M4 12l-2 4',
  passed: 'M5 12l5 5L20 6',
  failed: 'M6 6l12 12 M18 6L6 18',
  waiting: 'M8 5v14 M16 5v14',
  'waiting-for-human': 'M8 5v14 M16 5v14',
  uncertain: 'M9 8a3 3 0 1 1 5 2c-2 1-2 2-2 4 M12 18v1',
  stale: 'M4 4l16 16 M7 4h13v13 M4 8v12h12',
};
export function StatusIcon({ status }: { status: RunStatus }) {
  return (
    <svg
      className="status-icon"
      data-status={status}
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[status]} />
    </svg>
  );
}
