# Skills и правила качества

Для объяснения выполненной работы используется отдельная встроенная методика [implementation-lesson](../skills/implementation-lesson/SKILL.md). Она разбирает поток выполнения и данных по сохраненному материалу любого языка, различает наблюдения и учебные примеры и требует точных ссылок на код. Методика не дает права изменять проект, не заменяет проверку требований и не наследует автоматически произвольные проектные инструкции. Project Skills исполнения описаны ниже.

Skill задает рекомендации для AI-действия. Контракт определяет, что требуется получить; Executor проверяет полномочия и evidence. Ни текст Skill, ни отметка `skillsUsed` не доказывают выполнение требования.

## Два слоя и происхождение методов

Навыки команды, которая разрабатывает Flowcairn, выбираются из доступных инструментов ее среды. Они не становятся автоматически частью продукта. Встроенные методы продукта — короткие самостоятельные инструкции для назначенного действия; они не создают агента, новый lifecycle, команду проверки или полномочия.

Первый ограниченный набор адаптирует методы из skills.sh после проверки полного upstream-текста, переносимых references, exact commit, лицензии и зависимостей. [PROVENANCE.json](../skills/PROVENANCE.json) содержит URL, SHA-256, изменения, условия применения и отклоненные кандидаты. [Лицензии](../skills/licenses/) входят в пакет; upstream scripts и новые зависимости не импортированы. Ссылки на provenance и лицензии служат атрибуцией, а не требованием загрузить их в AI prompt.

| Метод | Что добавляет | Когда применяется |
| --- | --- | --- |
| project-context | Карта caller → владелец поведения → consumers, связанные проверки и пробелы | Назначенные analyze/plan/implement/review в своей области |
| core-debugging | Трассировка причины, опровержимая гипотеза и связанный repair | При конкретном сбое/finding; в пределах runtime-бюджета |
| testing | Связь критерия с проверяемым поведением и уровнем evidence | Implement/review; browser-сценарий только при подходящем verifier |
| code-review | Независимый разбор artifact, калибровка findings, отдельная оценка требований | Read-only ai-review |
| clean-implementation | Граница ответственности и один владелец состояния | Ai-implement, без необязательной перестройки проекта |
| domain-frontend | Реальные состояния, focus/forms/motion и согласованный визуальный язык | Только frontend domain текущего действия |
| workflow-planning | Связные outcomes, explicit dependencies и interfaces | Analyze/plan подходящей задачи |
| workflow-reuse | Существующие компоненты, совместимость и конкретный capability gap | Analyze/plan, кроме routine текстовой правки |
| workflow-verification | Реальный сценарий, outcome и ограничения evidence | Implement/review поведения |
| workflow-diagnosis | Проверяемая причина и bounded correction или blocker | Bugfix и назначенный failure route |
| workflow-test-quality | Наблюдаемое поведение, независимые expected values и проверяемые пробелы в assertions | Реализация поведения; рискованный, bugfix или явно запрошенный test-gap review |
| implementation-lesson | Полнота разбора через steps/wholeFlow/limitations и самостоятельное рассуждение | По сохраненному материалу выбранной версии |

Узкий TypeScript supplement находится внутри clean-implementation и code-review: действует только при затронутых TS-типах или границах runtime-данных. Он не переводит другие языки на TypeScript, не меняет compiler settings и не заменяет runtime validation проверкой типов.

React/composition artifacts из vercel-labs/agent-skills не импортированы: metadata MIT без найденного полного LICENSE exact artifact недостаточно для подтверждения лицензии. Для web-interface-guidelines отдельная MIT-лицензия проверена.

Четыре `workflow-*` метода — оригинальные инструкции Flowcairn, с отдельной provenance. Новых Superpowers Skills, scripts, hooks и адаптаций не добавлено; история существующих методов и лицензий сохраняется. Полные внешние наборы из исследований не становятся runtime registry автоматически.

Отдельный `workflow-test-quality` адаптирует закрепленные TDD и .NET test-gap методы; [полные notices и hashes источников](../skills/workflow-test-quality/LICENSES.md) сохранены. Он уважает `keep` и разрешенный scope, различает read-only candidate gap и выполненный эксперимент. При обычном review без риска этот дополнительный метод не назначается.

Проверки загрузки, positive/negative routing, hashes и drift подтверждают структурное подключение. Они не измеряют, насколько AI стал лучше выполнять задачи или насколько разработчик усвоил код. Для этого нужны отдельные контрольные задания с подготовленными fixtures, провайдером и бюджетом. Текущий lesson сохраняет ограничения своей схемы и не создает runtime observations без зарегистрированного extractor.

## Встроенные и проектные инструкции

| Источник | Назначение |
| --- | --- |
| Core Skills пакета | Анализ, планирование, реализация, тестирование, безопасность, ревью, диагностика и документация |
| Domain Skills пакета | Рекомендации для frontend, backend, mobile и общего engineering |
| Project Skills | Правила команды из выбранных `SKILL.md` проекта |

Встроенные Skills остаются в пакете. Flowcairn не копирует их в пользовательскую `.agents/skills`, не скачивает новые инструкции и не запускает их scripts.

## Выбор project Skills

При `init` Flowcairn проверяет найденные `SKILL.md` и рекомендует небольшой набор с распознаваемыми ролями: контекст, планирование/реализация, тестирование и ревью. Выбор роли по имени и пути не является смысловым аудитом инструкции. Неизвестные роли автоматически не включаются.

Профиль сохраняет путь, hash, разрешенные этапы и область каждого выбранного Skill. В план попадают инструкции, подходящие текущему действию и его файлам. Изменение исходного Skill требует актуального плана; AI не может самостоятельно подключить другой Skill.

Для ручного выбора при первоначальной настройке используются `--skills name1,name2`, `--skill-actions plan,analyze,implement,review` и `--skill-scope src`. Укажите только нужные этапы и область. `--skills none` отключает автоматическую рекомендацию. Повторный `init` не меняет уже сохраненный набор Skills.

Обнаружение и регистрация не имеют общего предела числа/объема Skills. Короткие инструкции могут войти в prompt; большие действующие правила доступны через проверенные закрытые файловые копии с hashes. Порог inline организует передачу, а не отбрасывает большие файлы. При невозможности полного чтения назначенных правил AI должен вернуть uncertain. Ссылки на дополнительные scripts/references не означают их автоматическую загрузку или выполнение. Контекстное окно клиента и размер одного запроса остаются конечными.

## Требования и проверки

Рекомендации помогают подобрать проверку к требованию: например, тест поведения для валидации формы, source review для свойства исходника или личную приемку интерфейса. Runtime отдельно проверяет связь Requirement → Work → Evidence. Без допустимого актуального evidence обязательное требование не получает PROVEN.

Различаются три решения:

1. Выполнить уже зарегистрированные проверки профиля.
2. Добавить новые тесты, если это допускают задача и правила проекта.
3. Измерять coverage и, при явном требовании проекта, применять его порог.

Flowcairn не назначает всем проектам 80% или 100% покрытия. Просьба не добавлять тесты не выключает уже обязательный script. Если необходимую проверку выполнить нельзя, результат остается неподтвержденным или требует предусмотренной контрактом личной приемки.

## Маршрут и проектные специалисты

Новый профиль использует `developmentWorkflow.version: 2`: задачи с поведением/риском получают отдельное read-only plan review до разрешения source write. `developmentWorkflow.version: 1` и профиль без developmentWorkflow сохраняют свои маршруты. Это версии policy, отдельные от формата project profile и Graph execution. [Порядок работы](DEVELOPER-WORKFLOW.md).

Новый `init` выводит capabilities из уже зарегистрированных обязательных checks. Playwright дает browser recipe, native reports — соответствующий iOS/Android recipe; generic scenario reports требуют однозначный frontend/backend/mobile domain в рабочем каталоге проверки. Root check в смешанном monorepo не получает угаданный domain. Без согласия на чтение manifests generic capabilities не выводятся. Регистрация сохраняет acceptance `unverified`: достаточность assertions и результат устанавливаются только выполнением задачи.

Owner может связать pinned project Skill с domain, framework major, видом задачи и capability. Specialist назначается только в своем scope/actions, при известных совместимых declarations и наличии зарегистрированных checks нужного report format. Неизвестные/противоречивые версии и отсутствующие prerequisites исключают его. Имя Skill не подтверждает compatibility или лицензию; новый import требует отдельной проверки содержимого, dependencies, compatibility и полной лицензии.

Пример фрагмента project profile для уже выбранного React Skill:

```json
{
  "developmentWorkflow": {
    "version": 2,
    "capabilities": [{ "id": "browser-scenario", "checkIds": ["browser"], "scope": ["src/web"] }],
    "specialists": [{
      "skillId": "project-react-guidance",
      "domains": ["frontend"], "frameworks": ["react"], "majors": [19],
      "taskKinds": ["behavior", "bugfix", "refactor", "design"],
      "requires": ["browser-scenario"]
    }]
  },
  "skillManifest": [{
    "id": "project-react-guidance",
    "path": ".agents/skills/react-guidance/SKILL.md",
    "hash": "<точный SHA-256 выбранного SKILL.md>",
    "scope": ["src/web"], "actions": ["ai-implement", "ai-review"]
  }]
}
```

Замените hash placeholder; это фрагмент, а не полный профиль или установка Skill. Check `browser` должен быть обязательным зарегистрированным check с `playwright-json` report. Файл Skill, references, лицензия и версия проверяются владельцем; source drift требует актуального плана. Инструкция не регистрирует executable и не расширяет permissions.

## Применимость и границы

Domain routing использует поддерживаемые manifests и зависимости. Это выбор рекомендаций, а не обещание полноценного исполнителя для любого языка. Неизвестный стек получает общие инженерные правила. Текущий проверочный toolchain и его ограничения описаны [отдельно](LIMITATIONS.md).

Stack profile сохраняет source hashes и scoped declarations. React major относится к зависимости, `android-gradle-plugin` — к AGP, `ios` — к deployment target, `swift-package` — к tools requirement, `dotnet` — к TFM. Это не installed SDK/compiler proof или гарантия minor compatibility. Flutter target platforms и Swift language/isolation settings не угадываются. В разрешенном scope bounded static inventory находит native/polyglot manifests, включая `.csproj` и Xcode projects; generated/private/hidden деревья исключены и требуют явных paths. Превышенный предел требует более узкого scope. JS packages сохраняют объявленный workspace inventory с его exclusions. Config, tests, Gradle, Swift и MSBuild при discovery не исполняются. Рекомендации для Android/RN/Expo/Flutter не означают готовый native verifier; [доступные report пути](CHECK-PROFILES.md) описаны отдельно.

Проектные архитектурные правила действуют в своей области. Core/domain Skills заполняют пробелы и не требуют заменять существующий framework или компоненты. Любое указание передать секрет, запустить неизвестный executable или расширить scope остается вне разрешений.

`AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md` и IDE rules имеют собственную область применения. Обнаружение пустого файла, большого текста или перекрытых инструкций является структурной диагностикой, а не доказательством их качества.

## Как проверить подключение

До согласования плана откройте его инструкции и назначенные Skills. После выполнения receipt показывает фактически назначенные hashes. Оценку результата проводите по требованиям и evidence, а не по заявлению модели о прочтении инструкций.

[Конфигурация](CONFIGURATION.md) · [Developer workflow](DEVELOPER-WORKFLOW.md) · [Контракт выполнения](FLOWCAIRN-WORKFLOW.md)
