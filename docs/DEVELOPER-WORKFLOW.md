# Выполнение developer-задачи

Flowcairn выбирает инструкции и проверки для конкретной задачи внутри существующего Executor. Новый локальный профиль использует `developmentWorkflow.version: 2`. `developmentWorkflow.version: 1` сохраняет прежний developer-маршрут с обязательными scenario reports; профиль без developmentWorkflow использует legacy policy. Это отдельная версия от `ProjectProfile.version`: его version 2 обозначает generic check registration. Сохраненные планы и receipts не переписываются.

## Порядок работы

1. Исследовать разрешенные исходники, владельцев поведения, зависимости и доступные проверки.
2. Сохранить исходные критерии в контракте; связать требования с работой и подходящим verifier.
3. Разделить работу на наблюдаемые outcomes, указать `needs` и согласованные `produces`/`consumes` interfaces.
4. Проверить структуру плана. В version 2 задачи с поведением или существенным риском проходят отдельное read-only review до согласования source write.
5. После согласования выполнить работу и обязательные проверки. Связать свежие reports и receipts с итоговым исходником.
6. Разобрать findings, выполнить ограниченное исправление и перепроверку; рассчитать покрытие требований и актуальность evidence.

Plan review оценивает каждый исходный criterion, source/creation references, verifiers, interfaces, capabilities и существенные неизвестные. Его `pass` разрешает следующий этап согласования, но не подтверждает еще не выполненную реализацию. Для простой статической правки без существенного риска дополнительный semantic review может не назначаться.

`BLOCKED` или `UNCERTAIN` plan review останавливает source write, включая ранее разрешенный repair. Следующий путь — диагностика и replan в исходных scope/criteria/permissions. Автоматическая correction ограничена известными случаями и бюджетом; общего обещания исправить любой план нет.

После failure runtime различает ошибку реализации, проверки, плана, среды и неизвестный исход процесса. Ненулевой exit или слово `assertion` в выводе не устанавливают причину. Подтвержденный scenario failure допускает bounded diagnosis; неопределенное завершение требует recovery. Исходные criteria, scope и права сохраняются.

## Какие готовые решения используются

| Область | Подключенный путь | Предпосылки и границы |
| --- | --- | --- |
| Node.js | Официальный `node:test` + встроенный JSON reporter | Node 22, существующие tests и зарегистрированный report profile |
| Frontend | Playwright JSON; Jest component assertions | Установленный runner/browser проекта и сценарии с ожидаемым результатом; Jest должен сохранять `invocations` и `failing`, иначе положительный сценарий unverified; mock имеет собственный уровень evidence |
| Backend | Node/Jest reports для existing HTTP/storage проверок | Реальные эффекты dependency проверяет выбранный verifier; HTTP 200 сам не подтверждает запись или права |
| Native iOS | XCTest result bundle: summary + Test Case tree | macOS/Xcode, согласованная сборка и Simulator сценарий, exact cases; owner регистрирует текущие .app и .xcresult, host повторно сверяет их при proof/restart; физическое устройство проверяется отдельно |
| Android device driver | `flowcairn-android-node/v1`: official Node events + native envelope | Existing protected device driver, exact compiled source/SDK/installed APK/session identities; actual APK и его дальнейший drift проверяет host |
| Vitest | Чтение JSON counters/scenarios | Mandatory proof остается unverified: JSON не сохраняет необходимые retry/test.fails сведения |
| RN/Expo, Flutter, native Android/iOS | Раздельные scoped recipes и static preflight | Сохраняется installed runner/build system. Known host/report/tool mismatch блокируется до source effect; SDK/version/device unknown требует реальной проверки и остается unverified |

Flowcairn не устанавливает SDK и библиотеки по названию в Skill. Orval, Testing Library, MSW/axe, Testcontainers, Schemathesis, Semgrep, k6, agent-device, Maestro и framework specialists выбираются при конкретном пробеле, после проверки версии, происхождения, лицензии и доступной среды. Регистрация capability означает разрешенный путь к check, а не успешную приемку.

## Проверки и завершенность

В developer workflow обязательный check-критерий требует зарегистрированный scenario report. Exit 0 подтверждает завершение команды; report должен подтвердить выполненные cases и согласованные counts. Missing, zero, skipped, TODO, unknown, duplicate и stale данные не становятся PASS. Обычный lint/build без scenario report может оставаться обязательной командой проекта, но не заменяет проверку поведения.

Executor сохраняет hashes report/spec/input/check registry/definition/adapter/runtime/toolchain. Для новой developer-v2 native iOS проверки также нужны environment identity и owner-pinned paths/hashes текущих .app и .xcresult. Замена любого из этих деревьев делает прежний proof stale при следующей сверке, даже при неизменном source fingerprint. Исторические hash-only registrations/receipts сохраняют прежний смысл; новая защита требует новой регистрации и свежей проверки. Проверка смысла assertions относительно исходного критерия остается отдельной обязанностью review. `PROVEN` требует полного актуального evidence по всем обязательным требованиям и отсутствия blockers.

Для распознанного Node22 проекта init может зарегистрировать reporter без ручного полного JSON. Playwright/Jest требуют owner selectors; opaque scripts остаются explicit setup. Чтение имен tests не является приемкой поведения. [Регистрация и report contracts](CHECK-PROFILES.md).

Поддержка конкретного runner/report формата не означает приемку любого проекта, AI-клиента или ОС. Native iOS требует свой macOS/Xcode контур; native Windows проверяется отдельно. [Границы исполнения](LIMITATIONS.md), [профили и точные IDs](CHECK-PROFILES.md), [Skills и версии](SKILLS.md), [контракт результата](HOW-FLOWCAIRN-WORKS.md).
