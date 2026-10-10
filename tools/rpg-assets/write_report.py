"""Generate evidence report from current files, not claimed package features."""
import hashlib
import json
from pathlib import Path

BASE=Path('output/product-completion/rpg')
records=[json.loads(p.read_text()) for p in sorted((BASE/'sources').glob('*-provenance.json'))]
hero=json.loads((BASE/'hero-contract.json').read_text())
scene=json.loads((BASE/'scene-contract.json').read_text())
checks=json.loads((BASE/'atlas-checks.json').read_text())
inventory={r['pack']:json.loads((BASE/'sources'/(r['pack']+'-standard-inventory.json')).read_text()) for r in records}
files=['guild-art-preview.png','guild-room-plate.png','guild-art-preview.blend','hero-source.blend',
       'hero-portrait.png','atlases/idle.png','atlases/idle.json','atlases/walk.png','atlases/walk.json',
       'idle-contact-sheet.png','walk-contact-sheet.png','idle-preview.gif','walk-preview.gif',
       'hero-contract.json','scene-contract.json','guild-inputs.json','hero-inputs.json','atlas-checks.json','preview.html']
artifacts=[]
for name in files:
    path=BASE/name
    artifacts.append(dict(path=name,bytes=path.stat().st_size,sha256=hashlib.sha256(path.read_bytes()).hexdigest()))
(BASE/'artifacts.json').write_text(json.dumps(artifacts,indent=2)+'\n')
rows='\n'.join(f"| [{r['pack']}]({r['source']}) | {r['uploadId']} | {r['bytes']:,} | {len(inventory[r['pack']])} | `{r['sha256']}` |" for r in records)
outputs='\n'.join(f"| [{r['path']}]({r['path']}) | {r['bytes']:,} | `{r['sha256']}` |" for r in artifacts)
stations='\n'.join(f"| {name} | {record['pixel'][0]} | {record['pixel'][1]} |" for name,record in scene['stations'].items())
report=f'''# S6: первый реальный арт-срез гильдии

Дата: 2026-10-09. **ART PREVIEW; executorConnected=false.**
Зал и персонаж реально отрендерены в Blender. Это проверяемый графический
срез; готовность S6, живой handoff и готовность продукта не заявляются.

## Результат для просмотра

![Зал с чародеем у верстака](guild-art-preview.png)

[Standalone просмотр](preview.html), [idle](idle-preview.gif), [walk](walk-preview.gif),
[крупный герой](hero-portrait.png), [idle contact sheet](idle-contact-sheet.png),
[walk contact sheet](walk-contact-sheet.png).

Пол/стены/ящики — Quaternius Medieval Standard; герой — Male_Ranger + голова
Superhero_Male_FullBody. Шляпа, книги, столы/верстак, карта, платформы/руны,
бутылки и свет — собственное authoring Python/Blender. Полное фиолетовое
перекрашивание исправлено: кожа головы/рук, ткань, кожаные детали и металл
разделены. Герой повернут к верстаку; поза — `Spell_Simple_Idle_Loop`, frame 12.
Это художественное действие, не подтвержденное executor-событие.

## Проверенные источники

Все архивные License.txt/License_Standard.txt указывают **CC0 1.0 Universal**:
[текст лицензии](https://creativecommons.org/publicdomain/zero/1.0/).
Покупки, подписки, login/captcha не выполнялись. Авторские .blend не скачаны:
файлы сцены и героя созданы нашим pipeline из свободных glTF/GLB.
У автора нет semantic version архивов; идентичность snapshot определяется
upload ID и SHA256. Индивидуальные hashes — `sources/*-inventory.json`.

| Архив Standard / официальный источник | upload ID | bytes | файлов | SHA256 |
|---|---:|---:|---:|---|
{rows}

Фактический Standard inventory:

- Medieval: **176 моделей**, каждая в FBX/glTF/OBJ (528 exports; 936 файлов всего).
- Base Characters: **2 тела** (Superhero female/male), **6 причесок + 2 eyebrows**,
  варианты rigged/origin-at-zero; 26 FBX и 18 glTF exports, 112 файлов всего.
- Fantasy: **4 полных костюма** Peasant/Ranger male/female и **20 modular parts**;
  24 FBX + 24 glTF exports, 121 файл всего. Mage-костюма в Standard нет.
- Animation: **43 именованных клипа** в `UAL1_Standard.glb`, не 120+.
  Отдельные `_RM` файлы есть, но не используются. README автора прямо отличает
  `_RM` от варианта с root motion disabled; импорт/метрики это подтверждают.

Имена всех 43 клипов и реальные bone/action данные сохранены в `inspection.json`.
Bind pose костюма и анимационного rig отличается, несмотря на одинаковые
65 имен костей. Pipeline переносит global pose относительно bind pose, масштабирует
translation по высоте pelvis, переносит скин/голову в общий rig. Простое
присваивание action другой арматуре не выдавалось за успешный retarget.
Фактически проверены idle/walk и один Spell pose; другие клипы не приняты.

## Версии и воспроизведение

- Blender **{hero['blender']}**, build hash `ec6e62d40fa9`, Cycles CPU.
- Python **3.14.5**, Pillow **12.3.0**, уже установленные локально.
- Контракт PixiJS проверен через Context7 для установленного **8.21.0**.
- Exa прочитал четыре официальные страницы Quaternius; Context7 — Blender
  import/render API и PixiJS Assets/Spritesheet/AnimatedSprite.
- macOS sandbox падает в Blender Metal detection до Python; реальные рендеры
  выполнены локальным разрешенным запуском вне sandbox. Пользовательские
  preferences и установленный Blender не менялись (`--factory-startup`).

Команды из корня репозитория:

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

Воспроизведение проверено повторными рендерами после исправлений camera/materials.
Upload ID и SHA256 закреплены в `tools/rpg-assets/standard-sources.lock.json`.
Downloader проверяет cache без сети; обновленный upstream или конфликтующий
архив безопасно отклоняется до принятия нового snapshot.
Blender/Pillow не нужны пользователю продукта.

## Контракт для интеграции

Сцена: PNG RGBA **1440×1080**, orthographic, yaw **45°** (от -Y), elevation
около **35°**, orthoScale **17.3 м**, теплый мягкий key и холодный fill.
`guild-art-preview.png` содержит одного baked героя и служит только для review.
Для runtime использовать **`guild-room-plate.png`** без baked героя;
тень персонажа добавлять отдельным 2D слоем. Room plate не решает occlusion:
нужны masks или отдельные foreground station layers перед живой интеграцией.

Данные станций в координатах исходной 1440×1080 plate:

| station ID | foot X px | foot Y px |
|---|---:|---:|
{stations}

Каждый sprite frame: **256×320**, untrimmed, RGBA, straight alpha, фиксированная
камера/масштаб. Pivot (мировой root на полу):
**({hero['pivot'][0]:.3f}, {hero['pivot'][1]:.3f}) px**;
normalized anchor **({hero['anchor'][0]:.9f}, {hero['anchor'][1]:.9f})**.
Не центрировать каждый frame по меняющемуся alpha bbox: это вызывает дрожание.
Направление пока одно: герой forward **-Y**, камера с +X/-Y (front three-quarter).
В арт-кадре у верстака rig развернут на 180°; его working sprites в этом
направлении еще не выпущены.

- `idle.json` → animation `idle`, **30 frames / 2.5 s**, PNG **1536×1600**.
- `walk.json` → animation `walk`, **16 frames / 1.333 s**, PNG **1536×960**.
- 12 fps baseline, без повторенного endpoint. PixiJS `animationSpeed = 12/60 = .2`
  при обычном 60 Hz ticker; для точной синхронизации можно использовать durations.
- Общий anchor во всех frame entries; `updateAnchor: true` корректно переносит его
  при переключении кадров. Текстуры **linear**, не nearest/pixel-art.
- В room plate sprite scale примерно **0.83237**: 1440/17.3 против 320/3.2 px/m.
  Применять общий scale/zoom комнаты к plate и sprite; не считать sprite height
  по полной padded canvas. Depth sorting — по foot Y, с occlusion masks отдельно.
- Walk скорость опоры **{checks['walk']['calibration']['metersPerSecondAt12Fps']:.6f} м/с**
  вдоль -Y при 12 fps. Перемещение/animation pace синхронизировать; если скорость
  пути другая, менять playback proportionally, а при остановке переходить в idle.
  Другие направления, повороты и навигация еще не проверены.

Схема JSON стандартная для `Assets.load` → `Spritesheet.animations` →
`AnimatedSprite`; [официальная PixiJS документация](https://github.com/pixijs/pixijs/blob/v8.21.0/skills/pixijs-assets/references/spritesheet.md).
Текущий WorldManifest содержит статические hero/background assets; автоматического
подключения атласов к его нынешнему типу не сделано.

## Фактические проверки

- Четыре архива распакованы; SHA256 архивов и каждого файла записаны.
- Перед рендером выбранные glTF/GLB и существующие buffer/texture сравниваются
  с inventory; `guild-inputs.json` / `hero-inputs.json` сохраняют точный набор.
- 46 прозрачных frames не пусты, не clipped, одинакового размера; оба атласа ≤2048.
- Root span в обоих состояниях **0 м**.
- Idle toe drift ≤ **{checks['idle']['toeDriftMeters']:.8f} м** (gate ≤1 мм).
- Walk: **{checks['walk']['calibration']['plantedSegments']}** опорных segments,
  max остаточное скольжение при измеренной скорости
  **{checks['walk']['calibration']['maxPlantResidualMetersPerFrame']:.8f} м/frame**.
  Это offline проверка выбранного клипа; runtime sliding еще не принят.
- Просмотрены PNG зала, крупный герой и contact sheet; после review исправлены
  quaternion rotation стены/героя, framing, материалы рук и bind-pose transfer.
- Standalone HTML открыт в in-app browser: оба атласа загрузились, выбор Walk
  и Пауза → Играть реально проверены. Это canvas art viewer, не Pixi runtime test.
- `python3 -m py_compile tools/rpg-assets/*.py` проходит.

## Ограничения и следующий gate

Зал пока малонаселен намеренно: один герой, не новая сцена и не все NPC.
Лицо частично скрыто тенью шляпы с высокой камеры; дополнительные рабочие позы,
силуэты ролей и face readability следует оценивать в финальном экранном масштабе.
У базового glTF два неверных normal-map URI (`T_Hair_1_Normal_png.png`,
`T_Eye_Normal_png.png`); исходный архив не изменен. Эти missing maps логируются,
но их материалы заменены собственными; фактическое отсутствие записано в inputs.

Handoff, книга, реальные event IDs, idempotency, uncertain/reduced-motion состояния,
6 героев, браузерный PixiJS load, occlusion и p95≤33ms пока **не проверены**.
Перед интеграцией root принимает пропорцию/качество этого героя. Затем отдельное
назначение выпускает согласованные directions и рабочие/handoff действия,
либо разрешает минимальную интеграцию с подтвержденными runtime events.

Записи ограничены `tools/rpg-assets/**` и `output/product-completion/rpg/**`.
Продуктовые src, assets/rpg, dist, package/lock и THIRD_PARTY_NOTICES не менялись.
Commit/push/merge/publication не выполнялись. Чужие изменения сохранены.

## Точные выходы текущего среза

| Файл | bytes | SHA256 |
|---|---:|---|
{outputs}
'''
(BASE/'REPORT.md').write_text(report)
print(BASE/'REPORT.md')
