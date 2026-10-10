# Контрольная точка оркестратора

Перед продолжением после нового окна или сжатия контекста:

1. Прочитать `AGENTS.md` и пользовательский `AI-WORKFLOW.md` из пути, указанного в текущих инструкциях сессии.
2. Прочитать `output/product-completion/STATE.json`, `REQUIREMENTS.json`, `NEXT.md` и текущий `audit/product-completion/PLAN.md`.
3. Проверить `git status --short`, `git diff --check`, активные reports/manifests и отсутствие конфликтующих незавершенных правок.
4. Получить свежие статусы delegated Codex chats по сохраненным `threadId`/cursors в `STATE.json`; отчет агента не считать приемкой до чтения файлов и повторения затронутых проверок.
5. Сверить платформенный scope: только macOS и native Windows. Linux/WSL не возвращать в active code; исторические snapshots не переписывать.
6. Продолжить только с `nextAction`, сохраняя evidence, hashes, failed/uncertain/stale semantics и границы владельцев.

Состояние не хранится в памяти модели: проектные файлы и immutable reports являются источником восстановления.
