# Проверки проекта на любом языке

Сам Flowcairn устанавливается через npm и работает на Node.js 22. Это не определяет
язык вашего проекта. Проверку Python, C или другого кода запускает выбранный вами
инструмент, уже установленный на компьютере. Flowcairn не устанавливает SDK автоматически.

Для существующих npm scripts сохраняется прежняя настройка. Для других команд
используется явный профиль: исполняемый файл, отдельные аргументы, рабочий каталог,
входы конфигурации и допустимые результаты. AI не может зарегистрировать себе новую команду.

В [developer workflow](DEVELOPER-WORKFLOW.md) обязательный check-критерий требует свежий scenario report с выполненными нужными cases. Регистрация команды и exit 0 сами по себе не подтверждают поведение.

## Автоматическая регистрация при init

Новый trusted-local/direct проект с точным `node --test` либо literal test-file argv получает встроенный Node22 reporter. Узкое чтение исходников выбирает существующие уникальные literal top-level names; оно не запускает проект и не доказывает смысл assertions. Изменяемые tests остаются частью source fingerprint, существующие mandatory selectors сохраняются. Config, manifest, lock и reporter закрепляют команду.

Для установленного `playwright test` или Jest29/30 нужны точные selectors владельца в `flowcairn-check-cases.json`:

```json
{"version":1,"runner":"playwright","requiredScenarios":["[chromium] search.spec.ts > Search > submits query"]}
```

Имя выше — пример: используйте реальные documented IDs/titles своего report. Optional `sourcePaths` дает исходники для анализа и не фиксирует их как неизменные scripts. Для Node используйте `runner: "node:test"`, для Jest — `"jest"`. Init не вызывает `--list`, не исполняет config/test modules и не устанавливает runner/browser. Dynamic/nested names, shell/env wrappers, globs и lifecycle требуют явной настройки; существующие checks сохраняются, missing report остается unverified. Существующие profiles и явно выбранный legacy adapter не мигрируют автоматически.

## Пример для Python

Допустим, в проекте уже есть тестовый модуль `tests.test_orders`, который проверяет
нужное поведение. Сохраните в корне проекта `checks.json`:

```json
{
  "version": 1,
  "requiredCheckIds": ["python-tests"],
  "definitions": [
    {
      "id": "python-tests",
      "title": "Тесты заказов",
      "purpose": "Проверить поведение модуля заказов существующими тестами",
      "command": {
        "executable": "python3",
        "argv": ["-B", "-m", "unittest", "tests.test_orders"],
        "cwd": "."
      },
      "inputPaths": [],
      "outputPaths": [],
      "timeoutMs": 60000,
      "maxOutputBytes": 65536
    }
  ],
  "environment": []
}
```

Это пример настройки, а не обнаруженная команда вашего проекта. Замените имя модуля
и команду своими. `-B` отключает запись Python bytecode. Если проект использует
виртуальное окружение, укажите его реальный интерпретатор; его зависимости должны
быть подготовлены обычным способом проекта.

Этот пример регистрирует команду. Built-in Python unittest JSON adapter не поставляется; для обязательного check-критерия нужен поддержанный scenario report. Source review подтверждает наблюдаемое свойство исходника, а human приемка применяется только к предусмотренному контрактом ручному требованию.

Остановите работающий интерфейс и зарегистрируйте профиль:

```bash
npx flowcairn setup --check-profile checks.json
npx flowcairn doctor
npx flowcairn
```

Путь `checks.json` должен быть относительным и находиться внутри проекта. Команда
`setup` сохраняет подтвержденную настройку; она не запускает тесты. Для нового проекта
тот же файл можно явно передать первоначальной настройке через `--check-profile`.
Обычные команды установки и запуска остаются прежними.

## Как выбирать поля

| Поле | Что указать |
| --- | --- |
| `id` | Короткое имя проверки без префикса `check-`; оно не обязано быть названием языка |
| `command.executable` | Установленный инструмент или явно выбранный исполняемый файл проекта |
| `command.argv` | Каждый аргумент отдельной строкой; это не shell-строка с `&&` или подстановками |
| `command.cwd` | `.` либо существующая папка внутри проекта |
| `inputPaths` | Неизменяемые для согласованного плана scripts/config/lockfiles проверки; не весь изменяемый исходный код |
| `identityFiles` | Выбранные владельцем файлы идентичности tool/dependencies, в том числе внешний reporter module; hash не является полным снимком SDK |
| `outputPaths` | Только реально создаваемые результаты инструментов; не каталог исходников или служебное состояние Flowcairn |
| `report` | Version 1 spec: поддержанный format, relative path внутри outputPaths и непустой unique requiredScenarios |
| `timeoutMs` | Допустимое время одной проверки в миллисекундах |
| `maxOutputBytes` | Лимит суммарного stdout и stderr. Превышение останавливает процесс с `OUTPUT_LIMIT`; evidence хранит размеры и хеши вывода, не полный текст |
| `environment` | Необходимые несекретные настройки; управляющие и опасные переменные запрещены |

Можно зарегистрировать до шести проверок, включая команды разных стеков одного проекта.
Файл настроек не должен содержать ключи или пароли. Поля проверяются строгой
[схемой](../scripts/ai-graph/lib/check-schemas.mjs).

## Node 22: отчет существующих тестов

Заготовка для существующих `node:test` tests. Замените абсолютный путь пакета и имя suite; `node` должен разрешаться в Node 22. Reporter остается в runtimeRoot, приложение — в projectRoot. [Официальный custom reporter API](https://nodejs.org/download/release/v22.19.0/docs/api/test.html#custom-reporters).

```json
{
  "version": 1,
  "requiredCheckIds": ["behavior"],
  "definitions": [{
    "id": "behavior",
    "title": "Тест поведения",
    "purpose": "Проверить ожидаемый результат",
    "command": {
      "executable": "node",
      "argv": [
        "--test",
        "--test-reporter=/absolute/flowcairn/scripts/ai-graph/lib/node-test-reporter.mjs",
        "--test-reporter-destination=artifacts/checks/report.json",
        "tests/behavior.test.mjs"
      ],
      "cwd": "."
    },
    "inputPaths": [],
    "identityFiles": ["/absolute/flowcairn/scripts/ai-graph/lib/node-test-reporter.mjs"],
    "outputPaths": ["artifacts/checks"],
    "timeoutMs": 60000,
    "maxOutputBytes": 65536,
    "report": {
      "version": 1,
      "format": "flowcairn-node-test/v1",
      "path": "artifacts/checks/report.json",
      "requiredScenarios": ["expected behavior"]
    }
  }],
  "environment": []
}
```

Перед запуском примера создайте каталог `artifacts/checks`. `expected behavior` — уникальное имя вашего case, проверяющего criterion; заполните immutable launcher/config/lock inputs проекта. Tests могут меняться только в согласованном scope. Для вложенного `node --test` запуска launcher очищает inherited `NODE_TEST_CONTEXT`. Пустой test file, успешно завершивший только file wrapper, не подтверждает исполненные tests.

## Форматы и точные ID сценариев

| Format | requiredScenarios | Ограничение |
| --- | --- | --- |
| `flowcairn-node-test/v1` | Exact case id либо уникальный nameHash/title | Reconciled cumulative/file/case counts; cancelled/skipped/TODO не PASS |
| `playwright-json` | `JSON.stringify(["playwright", projectId, spec.id])` либо однозначный full title | Failed attempts, flaky, interruption и expected failure не PASS |
| `jest-json` | `JSON.stringify(["jest-json", suite.name, fullName])` либо однозначный full title | Нужен завершенный первый invocation без retry/failed evidence |
| `vitest-json` | Exact file/fullName ID либо однозначный full title | Mandatory proof остается unverified: JSON не содержит нужную retry/test.fails provenance |
| `flowcairn-xctest/v1` | Только exact Test Case `nodeIdentifier` | Summary + tests tree, artifact/environment identities; Suite/Aggregate не testcase |
| `xcresult-summary-json` | Passed case IDs отсутствуют | Summary-only не подтверждает обязательный scenario |

Node case ID — SHA-256 записи `{fileHash,nameHash,line,column,nesting,testNumber,type,occurrence}`; fileHash использует relative к cwd путь, nameHash — title. Occurrence различает одинаковые helper cases. Receipts сохраняют immutable bindings и hashed IDs; выбор требования должен соответствовать настоящим assertions этого verifier.

Для Playwright используйте runner/browser проекта, assertions ожидаемого результата и JSON reporter с `outputFile`, совпадающим с `report.path`. [Официальная настройка](https://playwright.dev/docs/test-reporters#json-reporter). Наличие файла отчета не является установкой браузера или проверкой качества теста.

Native iOS: фрагмент report spec зарегистрированной проверки:

```json
{
  "version": 1,
  "format": "flowcairn-xctest/v1",
  "path": "artifacts/ios/report.json",
  "xctest": {
    "artifactRoot": "artifacts/ios/runs",
    "resultName": "tests.xcresult",
    "applicationRelativePath": "DerivedData/Build/Products/Debug-iphonesimulator/NativeControl.app",
    "algorithm": "sha256-tree-v1"
  },
  "requiredScenarios": ["AppUITests/testEmptyInput()"]
}
```

Зарегистрируйте `artifactRoot` в `outputPaths`. Producer пишет оба дерева в одном run: `artifact:{kind:'xcresult-bundle', path:'artifacts/ios/runs/<run>/tests.xcresult', hash:<tree hash>, algorithm:'sha256-tree-v1'}` и `applicationArtifact:{kind:'ios-app-bundle', path:'artifacts/ios/runs/<run>/DerivedData/Build/Products/Debug-iphonesimulator/NativeControl.app', hash:<tree hash>, algorithm:'sha256-tree-v1'}`. Tree hash — SHA-256 canonical JSON карты `relative-file → SHA-256 bytes`; пустые, связанные, чрезмерные и изменившиеся при чтении деревья отвергаются. Host сверяет оба локальных дерева после проверки и при последующем proof/restart. Для новой проверки developer-v2 mobile work отсутствие регистрации или любого дерева оставляет результат `unverified`; уже сохраненные исторические hash-only планы и receipts не переписываются и не получают эту защиту задним числом. Новая регистрация требует свежего check. Это локальная проверка текущих файлов, не непрерывная аттестация устройства или SDK. ID теста копируется из `nodeIdentifier`, включая `()`, а не из CLI `-only-testing` или title. `xcresulttool` читает [Apple result bundle](https://developer.apple.com/documentation/xcode/xcode-command-line-tool-reference).

Native runner, SDK и его outputs регистрирует владелец. Для executor PASS нужны reported artifact/environment identities; отсутствующие данные остаются unknown. Optional `schemaHashes` привязывают текущие snapshots, source schema version не выдумывается. Это native iOS путь с macOS/Xcode и конкретным Simulator/device; Android, RN/Expo, Flutter, физическое устройство и другие ОС требуют собственной приемки.

В developer-v2 mobile work actual environment этого формата должен содержать только iOS/iOS Simulator. macOS, tvOS, mixed или unknown device environment не подтверждает iOS criterion; общий Apple report для nonmobile и исторические policies сохраняются.

## Android: existing Node device driver

`flowcairn-android-node/v1` — ограниченный report bridge. Он сохраняет официальный Node22 Test report от existing driver, который действительно обращается к выбранному native device и проверяет результат. Это не новый универсальный runner и не переименование component tests в native.

```json
{
  "version": 1,
  "format": "flowcairn-android-node/v1",
  "path": "artifacts/android/report.json",
  "requiredScenarios": ["empty name shows required error"],
  "android": {"sourcePaths": ["app/Main.java", "AndroidManifest.xml"]}
}
```

Owner `sourcePaths` закрепляет полный compilation/provenance set. Producer возвращает genuine `nodeReport`, completed build/exit0 и exact source/toolchain hashes, APK path/hash/observed installedHash, Android API/ABI/device/session identity и известное завершение своей сессии. Shape определен в [schema](../scripts/ai-graph/lib/android-node-verification-report.mjs). Host перепроверяет current source и SDK/oracle inputs, реальные APK bytes в зарегистрированных outputPaths и совпадение installedHash. Immutable driver/oracle находится вне AI write scope. При изменении source set нужен актуальный recipe binding.

Raw JUnit/XML, child exit0, screenshot или обычный Node/Jest component report не дают native PASS. Missing/zero/skip/todo/ambiguous/unknown cases, скрытый retry, SDK/device/session mismatch и неизвестный driver exception остаются unverified. После проверки optional receipt `artifactPath` позволяет отдельно обнаружить изменение или удаление APK, даже если source fingerprint прежний. Поддержка format не означает live-приемку каждого Android/RN/Expo/Flutter стека; их existing suites и build pipelines сохраняются.

## Что означает результат

План связан с конкретными командами, инструментами и выбранными входами. Их изменение
может потребовать нового плана и согласования. Успешный exit code подтверждает запуск
команды; связь с требованием оценивается отдельно по исходникам и evidence. Registered report
должен обновиться текущим запуском, пройти exact scenario/count checks и совпасть с bound
spec/input/registry/definition/adapter/runtime/toolchain hashes. Stale или missing report
оставляет результат unverified. Неопределенность и неуспешный scenario нельзя скрыть общим AI pass.

Если инструмент или обязательная проверка отсутствуют, система сообщает причину
и не объявляет результат проверенным. Пустой npm-файл, созданный установкой Flowcairn,
не добавляет JavaScript-проверки в другой проект.

Зарегистрированные команды работают с правами пользователя. Проверка имени и хеша
исполняемого файла не является полной изоляцией процесса или снимком всех зависимостей SDK.
Для универсального профиля текущий путь исполнения — `direct`; отдельный Git worktree
пока относится к существующему адаптеру npm scripts.

[Настройки](CONFIGURATION.md) · [Установка](INSTALLATION.md) · [Безопасность](../SECURITY.md)
