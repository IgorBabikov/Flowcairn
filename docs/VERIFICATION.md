# Проверки текущей версии

Проверки выполнены на macOS с Node.js 22.13.1. Они относятся к текущей рабочей версии, а не подтверждают публикацию пакета или повторный платный AI-прогон.

## Результаты

| Проверка | Результат |
| --- | --- |
| `npm test` | 584 passed, 0 failed, 5 skipped; повторный запуск с доступом к локальному порту и npm-кешу |
| `npm run typecheck` | Runtime и React/TypeScript — PASS |
| `npm run lint` | PASS; вынесенные UI-модули дополнительно проверены TypeScript/React hooks ESLint |
| `npm run build` | Production UI собран |
| `npm run test:ui` | Chromium: 73 passed, 1 skipped |
| `npm run test:proof-browser` | Настоящий WorkflowService + HTTP + Chromium: PROVEN, просмотр подтверждений, STALE и ручная приемка — PASS; снимки использованы для анимации README |
| `npm run check:public` | Документы, локальные ссылки и базовая проверка приватных данных — PASS |
| `npm run check:package` | В архиве 130 файлов: runtime, Skills, CLI и собранный UI |
| Измененные интеграционные инструкции и onboarding | Входят в полный `npm test` |

Полный runtime-набор включает установку настоящего локального npm-архива, offline `npm ci` и запуск установленного bin в отдельном тестовом проекте. Для offline-проверки нужен предварительно заполненный npm-кеш. Проверка с пустым временным кешем закономерно завершилась `ENOTCACHED`; повтор с существующим кешем прошел.

Пять opt-in тестов полного набора требуют Docker/реального Linux окружения: npm, pnpm, Yarn, установка Linux-архива и отдельный сценарий npm exec/Docker. Они не запускались. Пропущенный UI smoke требует внешнего `FLOWCAIRN_TEST_URL`; вместо него отдельный `test:proof-browser` сам поднимает реальный локальный сервис и проверяет новый жизненный цикл.

## Критические сценарии

| Сценарий | Подтверждение |
| --- | --- |
| Работа → реальный check → evidence → requirement → PROVEN | `provable-work.test.mjs`: реальный файл и дочерний Node-процесс с assertion |
| Failed check → finding → repair → reverification | Первый реальный check возвращает 1, повторный после исправления — 0; новое evidence закрывает finding |
| Failed assessment при общем AI pass | Канонический failure запускает bounded repair; постоянная ошибка останавливается на лимите |
| Source change после PROVEN | Live fingerprint отзывает подтверждение и сертификат; браузер видит STALE даже без новой persisted revision |
| Неполное покрытие | 9 из 10 требований не дают PROVEN |
| Общий review pass или отсутствующий verifier | Не дают доказательство требования |
| Поддельная цитата | Отвергаются несовпадения строк, bytes/hash, scope, symlink/hardlink, invalid UTF-8 и NUL |
| Ручная приемка | Только requirement с методом human; текущие plan/revision/challenge/resultHash, idempotency и durable receipt |
| Recovery | После открытия нового WorkflowService тот же evidence дает тот же сертификат; uncertain и поврежденное состояние не повышаются до PASS |
| Optional requirement | Его отдельный неуспех не становится автоматически обязательным blocking finding |
| Контекст repair | Разрешенные read paths сохраняются, включая более 32 путей trusted compiled context |
| Неизвестный расход | Usage/cost остаются неизвестными, не заменяются нулем |
| UI и доказательства | Requirement drilldown, stale checks, отсутствие сертификата при incomplete/unknown, ошибки live refresh, desktop/mobile |

Исходники проверок: `scripts/ai-graph/task-proof.test.mjs`, `provable-work.test.mjs`, `requirement-verification.test.mjs`, `task-contract.test.mjs`, `usage.test.mjs` и `tools/ai-graph-viewer/tests/cockpit.spec.mjs`. Эти пути относятся к checkout репозитория; npm-пакет не содержит тесты.


## Что именно было реальным

В proof integration/browser проверках реальны файловая система, receipts, store, WorkflowService, HTTP, Node assertion и Chromium. AI-ответы задаются детерминированным тестовым адаптером. UI layout tests используют явно синтетические fixtures. Две анимации README показывают три проверенных требования к сроку действия ссылки для сброса пароля и то, как после изменения файла каждое подтверждение становится неактуальным. Эти уровни нельзя выдавать за завершенный платный прогон Codex, Claude Code или Cursor на пользовательской задаче.

CLI providers проверены тестами схем, контекста, safe parameters, consent и числовой usage. Реальное наличие модели у аккаунта и качество ответа провайдера требуют отдельного запуска с его авторизацией. Windows/WSL2, Docker daemon и поведение чужого production-проекта этим набором не подтверждены.

## Архитектура и документация

Перенесенные границы Orchestrator, runtime, provider commands, stop-proof storage, CLI installation и UI проверены существующей регрессией. Для Orchestrator дополнительно сравнивались тела 57 вынесенных функций: семантика сохранена, кроме явной передачи двух allocation callbacks. Новые UI-модули проверены на отсутствие циклических импортов.

Документация описывает только актуальную концепцию. Удалены прежний большой Graph-стандарт, исторический каталог архитектурных решений и старый дизайн-отчет. Обновлены 15 Skills и генерируемые проектные инструкции. Лицензионный список сверен с четырьмя runtime-пакетами и 17 компонентами production browser bundle.

[Как работает система](HOW-FLOWCAIRN-WORKS.md) · [Архитектура](ARCHITECTURE.md) · [Ограничения](LIMITATIONS.md)
