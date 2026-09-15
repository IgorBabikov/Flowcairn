# Интеграция с AI coding assistants

Flowcairn разделяет **интеграцию клиента** и **исполнение Graph Runtime**. Наличие Claude Code или Cursor на компьютере не означает, что они получили право менять файлы через Flowcairn.

## Что взято из зрелых проектов

| Референс | Практика | Решение Flowcairn |
| --- | --- | --- |
| [Superpowers](https://github.com/obra/superpowers) | Общие Skills, но нативная установка отдельно для каждого harness | Один каталог `skills/`, отдельные manifests Codex, Claude Code и Cursor |
| [GSD Core](https://github.com/open-gsd/gsd-core) | Typed capability/layout descriptors и преобразования только там, где они нужны | Явный registry harnesses и отдельный уровень исполнения |
| [AI Rules Sync](https://github.com/lbb00/ai-rules-sync) | Матрица поддерживаемых файлов и клиентов, preview/update/install | `doctor` показывает обнаруженные assistants и не смешивает их с runtime capability |

Не берем symlink-установку в пользовательские настройки: Flowcairn не должен ломаться после clone, зависеть от абсолютных путей или переписывать чужие правила.

## Один источник, три native manifests

Все общие Skills лежат в `skills/`. В пакет включены:

| Клиент | Manifest | Нативные поверхности |
| --- | --- | --- |
| Codex | `.codex-plugin/plugin.json` | `AGENTS.md`/`AGENTS.override.md`, `.agents/skills/` |
| Claude Code | `.claude-plugin/plugin.json` | `CLAUDE.md`, `.claude/rules/`, `.claude/skills/` |
| Cursor | `.cursor-plugin/plugin.json` | `.cursor/rules/`, `.cursor/skills/`, `.agents/skills/` |

Manifests ссылаются на один каталог Skills пакета. Они не создают копии Skills в пользовательском репозитории и не меняют существующие `AGENTS.md`, `CLAUDE.md`, `.cursor/rules` или `.cursorrules`. Marketplace-публикация этих manifests — отдельный следующий этап; `npx flowcairn` не меняет настройки Claude Code или Cursor сам.

## Уровни поддержки

| Уровень | Codex | Claude Code | Cursor |
| --- | --- | --- | --- |
| Обнаружение локального CLI | Да | Да | Да |
| Нативный manifest в пакете | Да | Да | Да |
| Правила и Skills Flowcairn | Да | Да | Да |
| Безопасное выполнение AI-node Graph Runtime | Да | Не включено | Не включено |

`npx flowcairn doctor` показывает только фактически найденные CLI. `detected` не является разрешением на запуск AI-node.

Claude Code и Cursor не подключены к executor, пока не будут выполнены все условия: явное разрешение владельца на передачу утвержденного контекста соответствующему провайдеру, tool-free или надежно изолированный adapter, проверяемый структурированный output, receipt и негативные тесты. Это ограничение намеренное.

## Модель и усиление

В обычной настройке Codex Flowcairn использует модель и reasoning effort, выбранные в самом Codex. Он не передает `--model` и не переопределяет `model_reasoning_effort`.

Автоматическое распределение между разными моделями требует отдельного согласия и проверенного списка моделей, доступных конкретному аккаунту. Flowcairn не угадывает такие модели и не включает routing молча.

## Проверка и удаление

Перед использованием выполните `npx flowcairn doctor`. Он не вызывает AI и не отправляет код.

`npx flowcairn uninstall` удаляет только неизмененные Flowcairn-owned integration blocks. Результаты, worktrees и измененные файлы остаются, если их нельзя безопасно снять. Native manifests являются частью npm-пакета и удаляются вместе с зависимостью обычной командой менеджера пакетов.
