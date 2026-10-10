# Offline ассеты «Мастерской гильдии»

Первый арт-срез: Quaternius Standard → собственная сцена Blender → PNG/атласы
для существующего PixiJS 2D. Это инструменты подготовки графики, не новый runtime.
Результаты имеют `kind: art-preview`, `executorConnected: false`.

## Воспроизведение

Из корня репозитория, Python 3 с Pillow и Blender 5.1.2:

```sh
python3 tools/rpg-assets/download_standard.py
python3 tools/rpg-assets/inventory.py
blender -b --factory-startup --python tools/rpg-assets/render_guild.py
blender -b --factory-startup --python tools/rpg-assets/render_hero.py
blender -b --factory-startup --python tools/rpg-assets/render_portrait.py
python3 tools/rpg-assets/pack_atlas.py
python3 tools/rpg-assets/create_preview.py
python3 tools/rpg-assets/write_report.py
python3 -m http.server 57863 --bind 127.0.0.1 --directory output/product-completion/rpg
```

Просмотр: `http://127.0.0.1:57863/preview.html`. Уже скачанные архивы можно
переиспользовать: первый шаг проверяет cache без сети. Точные upload ID и hashes
закреплены в `standard-sources.lock.json`; downloader отказывает, если upstream
или существующий архив отличается. Новый snapshot требует отдельного review.
Архивы не включаются в npm package. Они остаются в игнорируемом `output/`.

Проверка provenance выполняется при распаковке и для каждого выбранного
glTF/GLB и его buffer/texture при рендере. Standard загружается только через
публичный zero-price flow. Вход, оплата и обход quarantine не поддерживаются.

## Обязанности файлов

- `download_standard.py` — бесплатные Standard-архивы, upload ID и SHA256.
- `inventory.py` — безопасная распаковка и hashes каждого файла.
- `blender_common.py` — проверка входов, камеры, свет и primitive authoring.
- `hero.py` — Standard-костюм/голова, собственная шляпа, retarget с bind-pose correction.
- `render_guild.py` — один зал, арт-кадр и чистая room plate без героя.
- `render_hero.py` — одна direction, idle/walk в 12 fps, общий foot pivot.
- `render_portrait.py` — крупный кадр для визуального QA материалов/позы.
- `pack_atlas.py` — PixiJS JSON/PNG, clipping/root/idle-foot и gait checks.
- `create_preview.py` — отдельный art viewer без executor и synthetic handoff.
- `write_report.py` — фактические выходы, источники и интеграционный контракт.

## Ограничения

Только один герой и один угол idle/walk. Не доказаны другие костюмы,
все направления, working/handoff clips, runtime navigation, masks/occlusion
и продуктовая производительность. Модель автора рекламируется как совместимая,
но фактически bind pose отличается: прямое присваивание action недостаточно.
Два неверных normal-map URI базового glTF явно отмечены как отсутствующие;
в итоговом герое используются собственные материалы головы/глаз.
