# Медиа страницы репозитория

## Текущая демонстрация

`flowcairn-walkthrough.gif` заменяет прежнюю объясняющую схему: это монтаж шести кадров текущего UI из одного записанного сценария. Размер 960×660, по 3 секунды на кадр. Подписи добавлены над кадрами, интерфейс не перерисован. Для reduced motion README использует статический кадр.

Исходники записи находятся в `docs/demo/media`:

- `request.jpg`, `analysis.jpg`, `plan.jpg`, `work.jpg`, `repair.jpg`, `result.jpg`, `code.jpg`, `stale.jpg` — настоящие кадры renderer.
- `session.mp4` — запись взаимодействия с интерфейсом, без звука.
- `recording.json` — разрешенный для публикации набор полей фактических snapshots: nodes, needs, status, receiptIds, checks, coverage. Там же указаны исходный commit и время записи.
- `mark.svg` — существующий знак Flowcairn; оригинал здесь в `flowcairn-mark.svg`.

Сценарий использует `createGuildFixture`: подставные ответы анализа, планирования, реализации и review; настоящие WorkflowService, store, patch, Node-проверки и receipts. Это не live inference. Учебный AI не подключен, что видно в reader. Изменение файла на 3 после завершения снимает подтверждение; фактический агрегированный proof в этой записи — FAILED, а не выдуманный STALE.

Снимки и JSON создаются `tools/readme-demo/capture.mjs`, GIF и MP4 — `tools/readme-demo/render-media.mjs`. Сырая запись хранится только в игнорируемом output. В опубликованных материалах нет локального session token, адреса временного проекта и приватной истории пользователя.

UI-ассеты: [ASSETS](../../tools/ai-graph-viewer/assets/rpg/ASSETS.md), [сторонние лицензии](../../THIRD_PARTY_NOTICES.md). Новые AI-изображения не генерировались.

## Исторические кадры

Файлы `flowcairn-0.5.1-*.jpg` сняты с версии 0.5.1 на демонстрационном проекте поиска товаров с подставным провайдером. Текущий README их не использует. Совместимые адреса `flowcairn-frontend-world.jpg` и `flowcairn-frontend-codebook.jpg` сохранены для ранее опубликованных страниц.
