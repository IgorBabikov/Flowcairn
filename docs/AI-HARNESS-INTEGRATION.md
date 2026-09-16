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
| Безопасное выполнение AI-node Graph Runtime | Да | Да, после version probe и per-plan consent | Да, после version probe и per-plan consent |

`npx flowcairn doctor` показывает только фактически найденные CLI. `detected` не является разрешением на запуск AI-node.

Claude Code и Cursor не получают права из факта обнаружения CLI. Для каждого immutable плана требуется отдельное consent владельца; затем executor проверяет version pin, scope/instruction/Skills/artifacts hashes, structured output и receipt. Изменение версии, scope или plan снова блокирует egress.

## Проверенная матрица CLI (15 сентября 2026)

| Assistant | Официальный non-interactive путь | Ограничения FS/network | Structured output | Что может уйти наружу | Graph Runtime |
| --- | --- | --- | --- | --- | --- |
| Claude Code | `claude -p --setting-sources "" --tools ""` | User/project/local settings, CLAUDE.md, Skills и hooks не загружаются; MCP отключен, tools отключены, auto-memory отключена; Flowcairn запускает в private workspace, без project cwd | `--json-schema` + локальная Zod validation | Только approved scope, instructions, Skills и artifacts после отдельного consent | Работает после local version pin и проверки актуальных safe flags; tests используют synthetic CLI |
| Cursor | `cursor-agent -p --output-format json --sandbox enabled --mode ask` | Private empty workspace, sandbox и read-only Ask mode; `--force` не используется | JSON envelope + локальная строгая validation | Только approved scope, instructions, Skills и artifacts после отдельного consent | Работает после local version pin и проверки safe flags; tests используют synthetic CLI |

Официальные источники: [Claude Code CLI](https://code.claude.com/docs/en/cli-reference), [Claude structured output](https://code.claude.com/docs/en/agent-sdk/structured-outputs), [Cursor CLI parameters](https://cursor.com/docs/cli/reference/parameters), [Cursor output format](https://cursor.com/docs/cli/reference/output-format).

Consent contract привязан hash-ами к plan, scope, instructions, Skills и artifacts; раскрывает, что передается, и явно исключает secrets, `.env`, Git history, неутвержденные файлы и shell project host. Его hash сохраняется в immutable store рядом с plan и в receipt. Отмена gate не запускает provider.

Контекст для CLI ограничен 128 KiB после serialization. При превышении Flowcairn отказывает до запуска provider: сузьте approved scope, а не увеличивайте лимит.

## Модель и усиление

В обычной настройке Codex Flowcairn читает только модель и reasoning effort из конфигурации CLI и передает их явно в изолированный запуск. Выбор активного чата IDE не считывается.

Автоматическое распределение между разными моделями требует отдельного согласия и проверенного списка моделей, доступных конкретному аккаунту. Flowcairn не угадывает такие модели и не включает routing молча.

## Проверка и удаление

Перед использованием выполните `npx flowcairn doctor`. Он не вызывает AI и не отправляет код.

`npx flowcairn uninstall` удаляет только неизмененные Flowcairn-owned integration blocks. Результаты, worktrees и измененные файлы остаются, если их нельзя безопасно снять. Native manifests являются частью npm-пакета и удаляются вместе с зависимостью обычной командой менеджера пакетов.
