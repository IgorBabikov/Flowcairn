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
  PROJECT_PROFILE_INVALID: 'Настройки проекта не прошли проверку',
  LOCAL_OPENAI_WORKER_READY_REAL_AI_UNVERIFIED:
    'Исполнитель настроен; реальный запуск AI еще не проверен',
  checks: 'Проверка',
  implementation: 'Внесение изменений',
  ai: 'AI-этап',
  gate: 'Решение человека',
};
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
