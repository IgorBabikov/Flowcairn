# План доведения Flowcairn до пользовательского продукта

Дата согласования: 2026-10-09. Базовая версия: 0.5.2, commit f46f71b.

Это согласованный план разработки, а не описание уже готового поведения. Текущая реализация проверяется по коду, reports и реальным сценариям. Частичное выполнение не является завершением продукта.

## Результат и сохраненные решения

Пользователь устанавливает и запускает Flowcairn одной командой, проходит терминальный onboarding, вводит номер и описание IT-задачи. Система исследует проект, формирует требования и план, получает подтверждение точной версии, выполняет работу с AI, проверяет и исправляет результат, показывает доказательства и обучает чтению собственного кода по реальному потоку исполнения.

- Обязательны Codex, Claude Code и Cursor: полный цикл через каждый выбранный клиент, без обязательного второго AI для обучения.
- Обязательны macOS и native Windows. Linux и WSL удалены из текущего выпуска; проверка одной среды не подтверждает вторую.
- Frontend — опорный пример; generic check profiles и обучение другим языкам сохраняются.
- Визуальный выбор: непиксельная объемная «Мастерская гильдии», компактный зал с видимой командой. Окружение и персонажи готовятся из Quaternius-моделей в Blender; браузер использует PixiJS 2D и DOM-книгу.
- Источники графики: Medieval Village MegaKit, Universal Base Characters, Modular Character Outfits Fantasy, Universal Animation Library. Начинаем с Standard; точный состав, CC0 и hashes проверяются по скачанным архивам. Не предполагаем, что полный платный состав бесплатен.
- Герои показывают реальные состояния и передачи артефактов; анимация не создает исполнение или вымышленные сообщения.
- Режимы обучения: after-stage и after-task. Default нового пользователя — after-task; существующую настройку сохраняем.
- Исходники, цитаты, объяснение, наблюденные значения и учебные попытки связаны с версией результата. Чтение не равно пониманию; PROVEN не равно освоенному навыку.
- Автовыбор моделей/reasoning включается только явным consent в onboarding. Ручные настройки сохраняются; неизвестные capabilities не выдумываются.
- Commit, push, merge, публикация, оплата и новые внешние получатели закрытых данных требуют отдельного соответствующего разрешения. Локальная реализация и проверки уже разрешены.

## Основа, которую сохраняем

Executor владеет состоянием, правами и записью. Сохраняются runtimeRoot/projectRoot, immutable plans/hashes, trusted registry, CAS/locks, source-bound receipts, evidence freshness, failed/uncertain, idempotency, bounded repair и проверяемая остановка. Локальное файловое хранилище остается единственным источником состояния. Skills являются методами, а не вторым оркестратором.

Рабочие V2/V3 исторические объекты читаются без переписывания. Legacy Docker/recovery код удаляется только после доказательства отсутствия потребителей и определения совместимости. Переписывание ядра целиком не требуется.

## Аудит на baseline

- Воспроизведены req-001 coverage rejection и provider-consent RECEIPT_INTEGRITY в autonomous planning. Сначала добавить регрессии и устранить причины, не ослабляя проверки.
- Scheduler исполняет один ready node; текущая activeOperation модель не допускает безопасный Promise.all поверх driver.
- WorldCanvas не получает рабочие состояния нескольких исполнителей; existing sprites статичны.
- Урок ограничен одним небольшим ответом; coverage map, observations extractor и сохраненная оценка ответов отсутствуют.
- Учебный провайдер Codex ограничен macOS; Claude/Cursor learning запрещены до доказанного capability profile.
- Автоматические рекомендации project skills основаны на именах; цепочка ссылок AGENTS → workflow → reference не равна полному закрепленному контексту.
- Verifier цитат имеет скрытый предел 2 MiB на исходный файл.
- Проверки baseline: 1215 уникальных исполняемых unit/integration/install tests после адресного повтора 28 sandbox failures; 6 platform skips. UI 149 pass / 1 skip. Types/lint/public/package PASS. Build в tmp идентичен tracked dist. Это не live AI matrix и не доказательство эффективности обучения.

## Обязательный отбор skills.sh

Отдельно проверяются навыки нашей команды и методы готового продукта. Источники: skills.sh, upstream repositories, официальный vendor material и уже установленные specialist skills. Популярность не является доказательством качества.

Начальный набор: github/awesome-copilot context-map; mattpocock/skills improve-codebase-architecture и teach; anthropics/skills frontend-design и webapp-testing; vercel-labs react-best-practices, composition-patterns и web-interface-guidelines; obra systematic-debugging и requesting-code-review; wshobson typescript-advanced-types. Backend, security и другие стеки подключаются по реальному контракту.

Для выбранной адаптации сохраняются upstream URL, exact commit, source/reference hashes, LICENSE/NOTICE, различия, actions/scope и результат контрольных заданий. Применимость проверяется positive/negative cases; назначенный skill должен присутствовать в проверенном входе/receipt. Нет floating latest fetch во время действия, auto scripts, implicit permissions, второго lifecycle или обязательных неизвестных native agents. Изменение правил требует новой проверенной версии контекста.

Методы расширяют существующие core-debugging/testing/code-review/domain skills. Полные wrappers со своим Git/publish/issue/auto-memory поведением не импортируются. Для Vercel React upstream лицензия exact distributable требует дополнительной проверки; web-interface-guidelines имеет отдельный MIT первоисточник. Teach адаптируется к существующему хранилищу материала и попыток.

## Контракты и конвейер

Номер/описание → исследование → требования и неизвестные → план работ и verifiers → подтверждение версии → исполнение → проверки → findings/ограниченный repair → повтор проверки → evidence по всем требованиям → обучение.

Нужные контрактные добавления: provider capabilities/model catalog; scoped worker assignment/attempt; source-bound process events/handoff; lesson coverage/flow/observations; comprehension attempts. Общие schemas и migration policy принадлежат главному интегратору, пока не назначен другой владелец.

Небольшая задача использует минимальный маршрут. Researcher появляется для конкретного неизвестного; TypeScript/security/browser/performance компетенции — по затронутой границе. Независимое review получает исходные требования, настоящий artifact/diff и raw evidence.

Параллельность: максимум два независимых read/proposal workers по одному проверенному source snapshot; отдельные attempt owners; сериализованное применение через Executor. До внедрения модели owners/receipts параллельные writes не включаются. Изменение входов инвалидирует затронутый результат. После restart сверяются files, toolchain, permissions, active processes и сохраненное состояние.

## Учебный результат

Учитываются все измененные участки и необходимые связи с существующим кодом. Каждый раздел имеет source anchors, порядок вызовов, конкретный input/intermediate/output, state/type/error behavior и последствия изменения. Неразобранные/недоступные связи явно показаны. Большой материал разбивается на главы с общей картой покрытия.

Происхождение данных различается: зарегистрированное runtime observation; test fixture; manual trace; teaching example. Успех теста сам по себе не доказывает значение переменной. Runtime observations поступают только из проверяемого extractor конкретного запуска; секреты и лишние пользовательские данные исключаются.

Практика: предсказать новый вход, объяснить error branch, последствия изменения. Сохраняются ответ, подсказки, связь с материалом и оценка с ограничениями. Read/deferred/attempted/assessed не смешиваются. Прочтение и оценка AI не доказывают долговременное владение навыком.

## Этапы и зависимости

| ID | Цель | Зависит от | Критерий готовности |
| --- | --- | --- | --- |
| S0 | Зафиксировать план, требования, owners и baseline | Аудит | Состояние позволяет продолжить из нового чата |
| S1 | Отобрать/адаптировать/подключить skills | S0 | Проверенные sources/licenses/hashes и routing/effect cases |
| S2 | Исправить два blocking дефекта и verifier limits | S0 | Регрессии проходят; integrity не ослаблена |
| S3 | Полный путь провайдеров, onboarding, одна команда | S1/S2 | Отдельное evidence для каждого клиента/ОС; нет скрытого fallback |
| S4 | Декомпозиция service, scoped workers, события | S2/S3 | Dependencies/conflicts/late results/stop/restart доказаны |
| S5 | Полное обучение, observations и практика | Контракты S4 | Coverage, реальный поток, оба режима, freshness и ответы |
| S6 | Живая непиксельная гильдия | Контракты S4; art spike может начаться после S0 | Герои соответствуют runtime; визуальная/browser/performance приемка |
| S7 | Общая приемка и подготовка релиза | S3–S6 | Закрыты все обязательные требования; release claims соответствуют evidence |

## Приемка

Матрица 3 AI × 2 OS обязательна: macOS и native Windows. Проверяются fresh-cache one-command setup; повтор/конфликт; реальная авторизация и отдельный live pipeline; plan changes; bounded repair; lost response/idempotency; cancellation/uncertain/restart; stale code/instructions/skills; browser UI; RPG handoff; after-stage/after-task lesson; понимание своего кода. Дополнительно frontend async race и задача другого стека.

UI: 1440×900, 1280×800, узкий экран, 200% zoom, keyboard/focus, reduced motion, renderer failure. Performance target: шесть героев, p95 frame time ≤33 ms на записанной эталонной машине; hidden tab без активного rendering; bounded event backlog и загрузка текущих ассетов.

Личный пилот: объяснить реальный поток без подсказки, новый вход, ошибку и изменение; повторное задание через неделю. Не создавать напоминание без отдельного запроса. Доказательства технической готовности и обучения различаются.

Непроверенная или недоступная ячейка не дает поддержке статус verified. Известный blocking defect не объявляется готовым. Публикация является отдельным внешним действием после проверяемого релизного результата.

## Исследованные первоисточники

- https://developers.openai.com/codex/app-server — capabilities/model discovery и поддерживаемые interfaces.
- https://code.claude.com/docs/en/cli-reference — safe-mode, tools restrictions, structured output; текущий CLI help проверен отдельно.
- https://cursor.com/docs/cli/reference/permissions — permissions, но ask сам по себе не material-only boundary.
- https://www.anthropic.com/engineering/building-effective-agents — небольшие composable workflows.
- https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents — сохраненное состояние и incremental verification.
- https://learn.javascript.ru/ — ясность и последовательность объяснений; содержание не копируется.
- https://skills.sh/ — discovery с последующей проверкой upstream.
- https://quaternius.com/packs/medievalvillagemegakit.html
- https://quaternius.com/packs/universalbasecharacters.html
- https://quaternius.com/packs/modularcharacteroutfitsfantasy.html
- https://quaternius.com/packs/universalanimationlibrary.html

Рабочие назначения, chat IDs и текущие отчеты хранятся в output/product-completion, вне npm-пакета. Значимые продуктовые изменения отражаются в основных docs только после реализации и проверки.

## Уточнение приемки 2026-10-09

Пользователь сообщил, что подписок Claude Code и Cursor нет, и разрешил имитацию для проверки интеграций. Полное одинаковое пользовательское поведение трех клиентов остается обязательным. Для Claude/Cursor готовятся native CLI capability/preflight проверки без inference, contract simulators, fault/recovery scenarios и recorded-format fixtures. Их результаты обозначаются как simulated/native-no-inference; они не превращаются в live account/provider evidence. Создание платных аккаунтов и покупка подписок не входят в текущую работу.

## Уточнение визуальной приемки: только RPG-герои

Пользователь отверг бытовой персонаж в коричневой одежде, светлых штанах и плоской шапке из промежуточного atlas. Обязательный итоговый cast содержит только выразительных fantasy RPG героев: маг, следопыт, страж, мудрец-наставник, рунописец/картограф. Обычный peasant/NPC силуэт, бытовой берет и смена одного цвета не удовлетворяют требованию. Основа rig может переиспользоваться, но итоговые силуэт, костюм и снаряжение должны соответствовать выбранному жанру. Отвергнутые и аналогичные образы исключаются из активных production refs/пакета. Новый cast сначала проверяется на крупных previews, затем интегрируется. Непиксельный объемный стиль и текущая техническая архитектура сохраняются.
