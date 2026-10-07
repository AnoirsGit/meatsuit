# Handoff: доработки по docs/07-apply-needs.md (2026-10-07)

Папка временная и рабочая: в git не коммитить, удалить после переноса правок в дерево.

## Расклад сессий в этом дереве

- Пункты `docs/06-tinder-fixes.md` (singleTab, settle, dryRunNavigation, readOnly, shadow DOM, гонка lock) ведёт другая сессия (meatsuit-94). Её правки лежат в рабочем дереве незакоммиченными, сейчас идёт третья волна по итогам ревью.
- Договорились: пока она не пришлёт «дерево свободно», в `eyes.js`, `hands.js`, `human.js`, `index.js`, `guard.js`, `limits.js`, `sites.json`, `docs/04-contract.md` и тесты не писать.
- Пока её агенты работают, `npm test` не гонять. Тесты task, single-tab, review, save-tab и telegram-e2e занимают фиксированные порты CDP 9333–9337, параллельные прогоны дают ложные TargetClosed.
- Упоминания Тиндера в контракте (абзацы singleTab и dryRun) и в комментарии `hands.js` у dryRunNavigation она обещала обобщить сама.
- `sites.json`: `tinder.com` 400/30 вместо 80/15 — не из задания. Пользователь ещё не решил, оставлять ли.
- Никто не коммитит без просьбы пользователя.
- Требование пользователя: упоминания других проектов не должны расползаться. В коде, комментариях, тестах и контракте meatsuit не упоминать Tinder, cvs, hh, Greenhouse, Lever, Ashby, Workable, LinkedIn, а писать обобщённо. Исключение — записи в `sites.json`.

## Что лежит здесь

- `base-snapshot.tgz` — снимок рабочего дерева (без `.git` и `node_modules`), с которого начинали агенты. Это общая база для 3-way merge.
- `07-star.patch` — п. 2, правило `"*"`. **Готово**, `guard.test` зелёный.
- `07-captcha.patch` — п. 3, невидимая reCAPTCHA. **Готово**, guard, eyes, hands, capture и human зелёные.
- `07-upload.patch` — п. 1 и 4, команда `upload`. **Не доделано**: агент остановлен на середине, `test/upload.test.js` падает (assert на строке 67, deepStrictEqual), контракт не написан.

Патчи сняты `git diff` относительно базы, пути вида `a/<файл>`.

## Что сделано по пунктам

**П. 2, `"*"` (07-star).**
- В `limits.js` новая `ruleFor(sites, site)`: точный ключ, иначе отказ, если `site` — поддомен явной записи (чтобы закрытую площадку не обошли через `www.`), иначе `sites['*']`.
- `site: '*'` → обычный `Error`.
- `index.js` берёт правило через `ruleFor`.
- В `sites.json` в конец добавлены `"*"`, `hh.kz`, `hh.ru` со значениями из 07 (пользователь сказал «делай что говорят», но значения стоит показать ему ещё раз).
- В контракте новый абзац «Правило по умолчанию».

**П. 3, reCAPTCHA (07-captcha).**
- `eyes.observe` отдаёт новое поле `hiddenFrames`: те из `frames`, чей `<iframe>` скрыт (`frameElement().isVisible()`). Его же несёт `diff`.
- `guard`: адрес reCAPTCHA разбирается через `URL` (хост google.com или recaptcha.net, путь `/recaptcha/(api2|enterprise)/(anchor|bframe)`). Якорь с `size=invisible` — не капча. `bframe` — капча, если он не в `hiddenFrames`.
- hCaptcha, Turnstile, Arkose и GeeTest — стоп, как раньше.
- Риски:
  - `isVisible` не учитывает `opacity: 0`; ошибка будет в безопасную сторону — лишний стоп;
  - +2–3 CDP-вызова на каждый iframe в каждом снимке;
  - невидимые hCaptcha и Turnstile по-прежнему останавливают.

**П. 1 и 4, upload (07-upload, частично).**
- Есть:
  - `validate` с `uploadDirs` (без них `BadCommand`);
  - `readUpload` с realpath, границей по каталогу, расширением и размером;
  - `<input type=file>` → `setInputFiles` буфером;
  - кнопка → `waitForEvent('filechooser')` вместе с `human.click`;
  - `eyes` ставит `inputType: 'file'`;
  - `supervise.isWrite` считает upload записью;
  - `task` и `hands` принимают `uploadDirs`;
  - в `package.json` добавлен `test/upload.test.js`.
- Проверить и доделать:
  - почему падает тест;
  - виден ли скрытый input с видимой меткой;
  - dryRun не выполняет upload;
  - п. 4 (имя файла в снимке);
  - контракт (команда, `uploadDirs`, `inputType`, dryRun).
- Проще всего: развернуть базу, применить патч, дать агенту доделать в копии и только потом переносить.

## Как продолжить

1. Соседняя сессия закрылась: волна 06 закончена, `npm test` 11/11, но ревью третьей волны не сделано. Её состояние — в `docs/05-handoff.md`. «Дерево свободно» она формально не объявила, решает пользователь. Сначала прогнать `npm test` на дереве как базовую линию.
2. Доделать upload в копии:
   ```sh
   W=$(mktemp -d); tar -xzf .handoff-07/base-snapshot.tgz -C $W; ln -s $PWD/node_modules $W/node_modules
   cd $W && git init -q && git add -A && git -c user.name=s -c user.email=s@x commit -qm base && git apply /path/to/.handoff-07/07-upload.patch
   ```
   В копии гонять только тесты без портов: eyes, hands, guard, capture, human, upload.
3. Перенести в дерево 3-way merge по файлам, в порядке star → captcha → upload. Для каждого изменённого файла F, где `B` — развёрнутая база, а `A` — копия с применённым патчем:
   `git merge-file F B/F A/F`. Новые файлы (`test/upload.test.js`) просто скопировать.
   Ожидаемые конфликты:
   - `index.js` (star и upload);
   - `eyes.js` (captcha и upload);
   - `test/guard.test.js` (star и captcha);
   - `docs/04-contract.md` (все три);
   - `package.json` (если соседняя сессия меняла скрипт `test`).
4. Проверки:
   - `npm test` в meatsuit;
   - `npm test` в `../tinder-matcher` (около 132 тестов, есть e2e на Chromium): тесты потребителя должны остаться зелёными;
   - grep по дереву на упоминания проектов (список выше) в новых строках.
5. Ревью диффа свежим агентом без контекста сессии; чинить только то, что реально ломает.
6. Отчёт пользователю: что изменено, почему безопасно, что будет при ошибке.
7. Удалить `.handoff-07/`. Коммит — только по просьбе.

## Не сделано и вне задачи

- Бэклог 07: страница «спасибо» на другом хосте после отправки формы. Сейчас это `NeedsHuman`, потребитель принимает как `manual`.
- Живые проверки (Telegram, Chrome в Neko) из п. 6 файла 06 — дело соседней сессии или пользователя.

## Если продолжать на другой машине

Всё рабочее дерево не закоммичено: и работа 06, и эта папка. Чтобы продолжить дома, нужен коммит и push в ветку `feat/eyes-hands-guard` (только с явного разрешения пользователя и после того, как соседняя сессия закончит) или копия всей папки проекта.
