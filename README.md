<div align="center">

<img src="https://raw.githubusercontent.com/IgorBabikov/Flowcairn/main/.github/media/flowcairn-mark.svg" width="56" height="56" alt="Знак Flowcairn" />

# Flowcairn еще в разработке !

### AI выполняет задачу. Вы видите план, проверки и свой код.

Локальный инструмент для разработки с AI: превращает поручение в согласованный план,
выполняет работу с учетом зависимостей и показывает, чем подтвержден результат.

[Пакет в npm](https://www.npmjs.com/package/flowcairn)
[![Проверки](https://github.com/IgorBabikov/Flowcairn/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/IgorBabikov/Flowcairn/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-b69557)](LICENSE)

**[Смотреть запись работы](https://github.com/IgorBabikov/Flowcairn/blob/main/.github/media/demo/session.mp4)** · [Быстрый старт](#быстрый-старт) · [Документация](docs/README.md)

<a href="https://github.com/IgorBabikov/Flowcairn/blob/main/.github/media/demo/session.mp4">
<picture>
  <source media="(prefers-reduced-motion: reduce)" srcset="https://raw.githubusercontent.com/IgorBabikov/Flowcairn/main/.github/media/demo/work.jpg" />
  <img src="https://raw.githubusercontent.com/IgorBabikov/Flowcairn/main/.github/media/flowcairn-walkthrough.gif" width="960" alt="Текущий интерфейс Flowcairn: поручение, план, работа героев, исправление ошибки, подтвержденный результат и сохраненный код. Посмотреть запись работы." />
</picture>
</a>

</div>

**Это запись работающего интерфейса.** Ответы AI подставные; Executor, изменение файла, процессы проверок и отчеты настоящие. GIF показывает шесть кадров, [полное видео](.github/media/demo/session.mp4) и [данные запуска](.github/media/demo/recording.json) хранятся в репозитории. Это не демонстрация live inference.

## От поручения до проверенного результата

AI написал код — но что он изменил, почему считает работу законченной и сможете ли вы разобраться в решении завтра? Flowcairn связывает эти вопросы в один процесс:

1. **Опишите результат.** Система исследует проект, выделяет требования и неизвестные.
2. **Проверьте план.** Видны работы, зависимости, область записи и способы проверки. Изменения начинаются после согласования.
3. **Следите за выполнением.** Герои Мастерской отражают реальные состояния узлов. Ошибка проверки вызывает ограниченное исправление или останавливает работу.
4. **Посмотрите доказательства.** Для каждого обязательного требования нужны допустимая проверка и актуальные данные. Зеленый узел или общий ответ AI сами по себе недостаточны.
5. **Разберите свой код.** В книге сохранены исходники, версии и контекст. Объяснение доступно по возможностям выбранного AI-клиента.

## Один сценарий целиком

В записи система получает задачу: сохранить число `2` в `counter.json` и проверить его существующим `verify.mjs`.

| Момент | Что действительно произошло |
| --- | --- |
| [План](.github/media/demo/plan.jpg) | До согласования файл содержит `0` |
| [Ошибка](.github/media/demo/repair.jpg) | Первая правка записала `1`; проверка ожидала `2` и завершилась с exit 1 |
| [Результат](.github/media/demo/result.jpg) | Исправление записало `2`; проверка прошла, Executor рассчитал `PROVEN` после подставного review |
| [Изменение исходника](.github/media/demo/stale.jpg) | Внешнее изменение на `3` сняло подтверждение текущего результата |

### Где здесь граф

План — направленный граф: узел знает свои зависимости (`needs`), разрешенную работу и проверки. Executor управляет переходами и не пропускает обязательные проверки. Главный интерфейс — 2D-мир; технические подробности доступны в книге диагностики. Это не редактор ReactFlow.

![Схема: поручение, план, согласование, изменения, проверки, ограниченное исправление и доказательства](https://raw.githubusercontent.com/IgorBabikov/Flowcairn/main/.github/media/task-path.svg)

Схема упрощает внутренний граф. Учебная пауза зависит от режима; отсутствие проверки, неопределенность и устаревшие данные не становятся PASS. [Подробный контракт](docs/HOW-FLOWCAIRN-WORKS.md).

## Учитесь на коде своей frontend-задачи

**Пример: исправить поиск товаров, чтобы старый ответ сервера не заменял новую выдачу.** После изменения кода вы открываете его сохраненную версию и разбираете именно это решение.

1. **Проследите данные.** Ввод → `search(query)` → запрос → `await` → проверка актуальности → обновление списка.
2. **Свяжите объяснение со строками.** Почему после «рюкзак» → «термос» на экране остается последняя выдача? Книга показывает значения `request` и `latest` и подсвечивает защиту от старого ответа.
3. **Объясните последствие правки.** Что сломается, если убрать эту же защиту из `catch`? Сформулируйте ответ своими словами, сверяясь со своим кодом.

<a href=".github/media/learning/search-flow.jpg"><img src="https://raw.githubusercontent.com/IgorBabikov/Flowcairn/main/.github/media/learning/search-flow.jpg" width="960" alt="Frontend-разбор поиска: слева вход, преобразования и результат, справа src/search.js с подсвеченными строками проверки актуальности запроса" /></a>

**Затем — ваша попытка объяснить решение:** вопрос привязан к тому же фрагменту, код остается перед глазами.

<a href=".github/media/learning/search-question.jpg"><img src="https://raw.githubusercontent.com/IgorBabikov/Flowcairn/main/.github/media/learning/search-question.jpg" width="960" alt="Панель Попробуй сам: вопрос об удалении проверки из catch, черновик ответа разработчика и соответствующие строки его кода" /></a>

<details>
<summary>Посмотреть следующий шаг разбора и мобильную книгу</summary>

[Обработка ошибки старого запроса](.github/media/learning/search-error.jpg) · [Чтение кода на телефоне](.github/media/learning/search-mobile.jpg)

</details>

Кадры сняты с текущего интерфейса книги на подготовленном frontend-уроке. Учебные данные и черновик ответа заданы для съемки; внешний AI не вызывался, ответ не отправлялся. Это отдельный пример обучения, а не продолжение задачи со счетчиком из видео выше.

Разбор доступен после этапа или после всей задачи. Чтение и ответы не меняют `PROVEN`; продолжение после учебной паузы — отдельная команда. Эффективность обучения проверяется отдельно.

## Быстрый старт

В корне своего проекта, с **Node.js 22**:

```sh
npx flowcairn
```

Пройдите короткую настройку, авторизуйте выбранный AI-клиент и откройте Гильдию. Опишите задачу, проверьте план и разрешения, затем начните выполнение. Git и `package.json` не обязательны для direct-запуска.

Новые проекты используют [developer workflow](docs/DEVELOPER-WORKFLOW.md): задачи с поведением или риском проходят отдельное read-only review плана до разрешения правок. Для обязательной проверки поведения нужен свежий scenario report; настройка existing runners описана в [профилях проверок](docs/CHECK-PROFILES.md).

Если браузер нужно открыть вручную:

```sh
npx flowcairn --no-open
```

[Установка](docs/INSTALLATION.md) · [Первая задача](docs/FIRST-TASK.md) · [Проверки других языков](docs/CHECK-PROFILES.md) · [Решение проблем](docs/TROUBLESHOOTING.md)

## Клиенты и текущие ограничения

- **Codex, Claude Code, Cursor** подключаются через официальные CLI и их авторизацию. Codex и Claude Code поставляются с проверенными базовыми версиями; Cursor Agent CLI устанавливается отдельно.
- Целевые ОС — **macOS и native Windows**; Linux/WSL исключены. Локальная проверка macOS не подтверждает Windows. Актуальные прогоны и границы — в [VERIFICATION](docs/VERIFICATION.md).
- Claude Code и Cursor проверялись через native-no-inference и симуляторы без авторизованных аккаунтов. Это не live inference. Учебная генерация имеет отдельные ограничения по клиентам, версиям и ОС.
- Проверки запускаются локально с правами пользователя. Flowcairn не добавляет универсальную файловую песочницу и не заменяет permission controls AI-клиента.
- Эффективность обучения и производительность на целевом оборудовании требуют отдельной приемки. [Все ограничения](docs/LIMITATIONS.md).

## Документация и участие

[Как работает](docs/HOW-FLOWCAIRN-WORKS.md) · [Developer workflow](docs/DEVELOPER-WORKFLOW.md) · [Архитектура](docs/ARCHITECTURE.md) · [AI-клиенты](docs/AI-HARNESS-INTEGRATION.md) · [Skills](docs/SKILLS.md) · [Участие](CONTRIBUTING.md) · [Безопасность](SECURITY.md)

Для разработки:

```sh
npm ci --ignore-scripts
npm test
npm run build
npm run test:ui
```

[Происхождение медиа](.github/media/README.md) · [Исследование оформления](docs/README-VISUAL-RESEARCH.md) · [Воспроизведение записи](.github/media/README.md).
Лицензия [MIT](LICENSE). [Сторонние материалы и лицензии](THIRD_PARTY_NOTICES.md).
