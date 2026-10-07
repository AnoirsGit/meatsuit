# Зеркало браузера: Neko + Google Chrome или Brave

Один постоянный браузер в Docker. Человек открывает его в обычном браузере (картинка и звук по WebRTC), один раз входит на сайты и решает то, на чём бот остановился. Код вызывающих подключается к тому же браузеру по CDP через библиотеку meatsuit. Общая картина — [README.ru.md](../README.ru.md), интерфейс библиотеки — [04-contract.md](../docs/04-contract.md). Подробная английская версия — [README.md](README.md).

meatsuit — автоматизация своих аккаунтов понемногу. Правила площадок действуют, отвечаете за них вы. Капчу программа не решает никогда: её решаете вы в зеркале.

## Быстрый старт

```sh
npm run init          # из корня репозитория: файл деплоя docker/.env, случайные пароли, права 0600
docker/up.sh          # docker compose --env-file <файл деплоя> up -d
docker/verify.sh      # открыть статью через зеркало, прокрутить, проверить по CDP
```

Откройте `http://127.0.0.1:8080`, имя любое, пароль — `NEKO_PASSWORD`. Управление берётся неявно: навели мышь на видео и работаете.

`docker/up.sh` принимает любую команду compose с тем же файлом: `docker/up.sh ps`, `docker/up.sh logs -f neko`, `docker/up.sh stop` (браузер закрывается корректно и сбрасывает cookie на диск), `docker/up.sh down`. `docker/up.sh down -v` удаляет и том профиля — все входы пропадут.

## Файл деплоя и `docker/up.sh`

Настройки зеркала — в одном файле вне git: `docker/.env` или файл из `MEATSUIT_CONFIG` (у владельца он лежит вне репозитория). `npm run init` создаёт его один раз из [`.env.example`](.env.example) (там же комментарии ко всем полям); `npm run config` правит через временную страницу на `127.0.0.1` — процесс на хосте, не в контейнере и не в сети браузера, одноразовый токен в заголовке, без cookies, проверка `Origin`, пароли на страницу не отдаются, запись атомарная с правами 0600, `409` при чужой правке, выход после 15 минут простоя.

`docker/up.sh [команда compose…]` — это `docker compose --env-file <файл> -f docker-compose.yml …`, по умолчанию `up -d`. При `MEATSUIT_EGRESS=tailscale` в файле он добавляет `docker-compose.egress.yml` и профиль `egress`. Запускайте стек всегда через `up.sh`: голый `docker compose up` про Tailscale не знает. Compose читает файл только при `up`: после правки снова `docker/up.sh`.

Главные поля: `NEKO_PASSWORD` и `NEKO_ADMIN_PASSWORD` (обязательны), `NEKO_BIND_IP` и `NEKO_PORT` (по умолчанию `127.0.0.1:8080`, никогда `0.0.0.0`), `NEKO_WEBRTC_IP` (адрес, под которым вы открываете зеркало), `MEATSUIT_BROWSER` (`chrome` или `brave`), `NEKO_TAG` (`3.1.6`), `MEATSUIT_PROFILE_DIR` (папка на хосте вместо тома), `MEATSUIT_TZ` (`UTC`; ставьте пояс страны выхода), `NEKO_SCREEN`, `NEKO_MEM`, `NEKO_CPUS` (`0` — без потолка процессора: на части хостингов квота не принимается). Необязательные, руками: `MEATSUIT_EGRESS`, `TS_AUTHKEY`, `TS_EXTRA_ARGS`, `TS_HOSTNAME`, `TS_TAG`, `BRAVE_EXTRA_FLAGS`, настройки замороженных сервисов. Значения без пробелов, кавычек и `$`.

## Выбор браузера

`MEATSUIT_BROWSER` выбирает один из двух маленьких файлов, которые расширяет `docker-compose.yml`: [`browser-chrome.yml`](browser-chrome.yml) или [`browser-brave.yml`](browser-brave.yml). Переменную читает сам compose, поэтому выбор работает и через `docker/up.sh`, и через голый `docker compose --env-file`.

| | Google Chrome (по умолчанию) | Brave |
|---|---|---|
| Образ | `ghcr.io/m1k1o/neko/google-chrome:${NEKO_TAG}` | `ghcr.io/m1k1o/neko/brave:${NEKO_TAG}` |
| Том профиля | `meatsuit_profile`, в контейнере `/home/neko/.config/chrome-meatsuit` | `meatsuit_brave_profile`, в контейнере `/home/neko/.config/brave` |
| Запуск и флаги | [`chrome.conf`](chrome.conf) | [`neko/brave.conf`](neko/brave.conf), [`neko/brave-start.sh`](neko/brave-start.sh) |
| Политики | [`chrome-policies.json`](chrome-policies.json) | [`neko/policies.json`](neko/policies.json) |

Chrome по умолчанию, потому что существующие входы сделаны в нём; `chrome.conf` и `chrome-policies.json` перенесены без изменений оттуда, где эти входы живут. Папка профиля Chrome нестандартная намеренно: Chrome 136 и новее со стандартной папкой не открывает порт CDP. Профиль между браузерами не переносится: после смены входить заново, второй профиль остаётся в своём томе. Том Brave называется так же, как у прежнего зеркала на Brave.

`profile-init` — одноразовый контейнер из того же образа, без сети: отдаёт uid 1000 (`neko`) корень папки профиля, создаёт в томе `meatsuit_profile` папку `state/` для вызывающих (и при Brave) и выходит; браузер стартует после него.

## Подключение другого стека

Эти имена не меняются, на них опираются другие проекты:

- контейнер `meatsuit-browser`: вызывающий подключается `network_mode: "container:meatsuit-browser"` и видит CDP на `http://127.0.0.1:9222`; зеркало должно быть поднято раньше;
- том `meatsuit_profile`, корень и `state/` — uid 1000: вызывающие объявляют его `external: true` и держат общий `dir` в `state/`: `connect({ dir: '<точка монтирования>/state' })`. При Chrome в том же томе лежит профиль браузера: где писать не нужно, монтируйте только для чтения;
- порт CDP на хосте не публикуется: кто дотянулся до CDP, тот управляет браузером и всеми вошедшими аккаунтами.

```yaml
# docker-compose.yml вызывающего
services:
  bot:
    build: .
    user: "1000:1000"                             # пишет в state/ (или root)
    network_mode: "container:meatsuit-browser"    # CDP: http://127.0.0.1:9222
    volumes:
      - meatsuit_profile:/meatsuit                # connect({ dir: '/meatsuit/state' })
volumes:
  meatsuit_profile:
    external: true
```

Все вызывающие одного браузера передают в `connect()` один `dir`: там замок очереди, и с разными замками два бота пошли бы в браузер одновременно. `peek(site, { sitesFile, dir })` показывает остаток лимитов площадки без траты слота.

Имя хоста у контейнера тоже постоянное (`meatsuit-browser`): замок профиля Chromium помнит имя хоста, и после пересоздания под другим именем браузер открыл бы окно «профиль используется на другом компьютере». С Tailscale браузер живёт в сети контейнера tailscale и берёт его имя хоста (своё Docker там задать не даёт) — оно тоже постоянное.

### Перенос готового профиля Chrome

Если профиль Chrome уже лежит в другом томе (с тем же `chrome.conf`, смонтирован в `/home/neko/.config/chrome-meatsuit`), скопируйте его один раз при остановленных браузерах:

```sh
docker run --rm -v <старый том>:/from:ro -v meatsuit_profile:/to ghcr.io/m1k1o/neko/google-chrome:3.1.6 \
  sh -c 'cp -a /from/. /to/ && chown -R 1000:1000 /to && rm -f /to/SingletonLock /to/SingletonCookie /to/SingletonSocket'
docker/up.sh
```

Потом проверьте входы в зеркале; старый том держите, пока не проверили. Не проверено.

## Выход через дом: Tailscale (по желанию)

Без него трафик браузера уходит с адреса сервера. С `MEATSUIT_EGRESS=tailscale` `docker/up.sh` добавляет [`docker-compose.egress.yml`](docker-compose.egress.yml) и профиль `egress`: контейнер Tailscale выходит через домашний exit node, браузер (и замороженные сервисы) живут в его сетевом пространстве, а [`egress/killswitch.sh`](egress/killswitch.sh) отклоняет любое соединение не от root мимо туннеля.

1. Поднять exit node дома ([egress.md](../docs/egress.md#recommended-setup)).
2. В файл деплоя: `MEATSUIT_EGRESS=tailscale`, `TS_AUTHKEY` (одноразовый ключ), `TS_EXTRA_ARGS=--exit-node=<имя домашнего узла> --exit-node-allow-lan-access=false`.
3. `docker/up.sh`. Браузер ждёт, пока Tailscale войдёт и exit node будет в сети.
4. В зеркале открыть `https://ipinfo.io`: должно быть ваше домашнее подключение.

**Не включайте exit node на самом хосте через SSH по его публичному адресу**: сессия повиснет ([egress.md](../docs/egress.md#ssh-safety-warning)). **Не проверено:** выход через Tailscale ни разу не запускался.

## Развёртывание на сервере

1. Docker с Compose 2.24 или новее, Tailscale на хосте; телефон и ноутбук в том же tailnet.
2. Клон репозитория, `npm ci`, `npm run init` (или `MEATSUIT_CONFIG=<файл> npm run init` для файла вне репозитория; тогда держите `MEATSUIT_CONFIG` в окружении и для `docker/up.sh`).
3. **Адреса.** `NEKO_BIND_IP` и `NEKO_WEBRTC_IP` — адрес tailnet сервера (`tailscale ip -4`), например через `npm run config -- --tailnet` с телефона. Никогда не публикуйте порты в интернет: приватность держится на привязке к адресу tailnet, а опубликованные Docker порты обходят обычные файрволы хоста. Зеркало работает по `http` с выключенным `Secure` у куки входа (`NEKO_SESSION_COOKIE_SECURE=false`) — это безопасно только потому, что канал шифрует tailnet.
4. `docker/up.sh`, затем живая проверка из [docs/acceptance.md](../docs/acceptance.md).
5. По желанию — выход через Tailscale (выше).

## Что доказывает `verify.sh`

Нужны файл деплоя и поднятый стек; все команды compose идут через `up.sh`. Проверки работают в образе замороженного прогрева (`life`), он собирается при первом запуске.

1. **Зеркало поднято**: до двух минут ждёт healthy — отвечают и веб-часть Neko, и порт CDP браузера.
2. **Управление работает**: входит паролем участника и управляет зеркалом по протоколу Neko, теми же событиями, что шлёт веб-клиент (Ctrl+L, Ctrl+A, набор адреса, Enter, колесо), затем спрашивает сам браузер по CDP: адрес вкладки — статья, `scrollY` больше 500.
3. **Профиль живёт** (`docker/verify.sh persistence`): ставит cookie по CDP, сразу останавливает и запускает контейнер браузера, cookie на месте.

Не доказывает: настоящую клавиатуру в веб-клиенте, видео и звук, выход через Tailscale.

## Что проверено, а что нет

Прогоны ниже делались с **Brave**, до выбора браузера; этот compose с Chrome или Brave ещё не запускался. Сейчас тестами проверено: `docker compose config` для обоих браузеров, с Tailscale и без, `docker/up.sh` (`test/docker.test.js`, `test/config.test.js`), `profile-init` вживую на образе Brave (том `meatsuit_profile` и `state/` — 1000:1000).

| Что | Как | Результат |
|---|---|---|
| Neko и Brave поднимаются, порт CDP жив | healthcheck, `verify.sh` | за ~15 с, ~750 МБ из 3 ГБ, ~10% процессора в покое (одна машина, один прогон) |
| Зеркало показывает живой браузер; мышь и набор из веб-клиента | вход через Chromium, клик по подсказке, буквы и точка | работает |
| Enter, Ctrl+A, Ctrl+L из веб-клиента | синтетические события тестового клиента не доходят | **с настоящей клавиатурой не проверено** |
| Управление по протоколу Neko | `verify.sh` | статья загружена и прокручена |
| Профиль переживает остановку и пересоздание | cookie по CDP, `stop`/`start`, `down`/`up` | сохраняется, в том числе поставленная за секунду до остановки |
| Зеркало на арендованном сервере (контейнер OpenVZ, 4 старых ядра, без GPU), открыто с ноутбука через Tailscale | только зеркало; headless Chromium вошёл и 45 с снимал пиксель видео | healthy, видео живое по tailnet, ~3.6% процессора и 310 МБ в покое (один прогон) |

Отдельно: библиотека работала у одного проекта-вызывающего с зеркалом Neko на Google Chrome с теми же `chrome.conf` и `chrome-policies.json`, поднятым его собственным compose.

**Не проверено:** этот compose с любым браузером; перенос профиля; Enter и сочетания с настоящей клавиатуры; звук, видео в настоящем браузере и на телефоне; весь выход через Tailscale; нагрузка, когда зеркалом пользуются на слабом сервере.

Почему у Brave свой скрипт запуска (`neko/brave-start.sh`) и что в нём неочевидного (cookie стирались при остановке, сигнал остановки не доходил через обёртку, «Brave quit unexpectedly», размер окна, потолки памяти), — в английской версии: [Brave: six fixes](README.md#brave-six-fixes-that-are-not-obvious).

## Замороженные сервисы: прогрев и HTTP-сервис

`extras/` хранит планировщик прогрева и HTTP-сервис прежней линии проекта: работают и тестируются, не развиваются. В compose это профили `warmup` (`life`) и `api` (`server`), оба в сети браузера, CDP на `127.0.0.1:9222`.

```sh
cp profiles/life.example.json profiles/life.json      # прогрев: свои сайты и часы, вне git
docker/up.sh --profile warmup up -d --build
```

HTTP-сервису нужны `profiles/clients.json`, `profiles/sites.json` и `profiles/egress.json` (все вне git, образцы рядом). Подробно: [warmup.md](../docs/warmup.md), [http-api.md](../docs/http-api.md). Без выхода через Tailscale прогрев шёл бы с адреса сервера, поэтому сам не стартует.

## Неполадки

| Признак | Что проверить |
|---|---|
| `up.sh: нет файла деплоя …` | `npm run init` или `MEATSUIT_CONFIG` с путём к вашему файлу |
| «Задайте NEKO_PASSWORD (npm run init)» | в файле нет пароля; `npm run init` на существующем файле только перечислит, что не так |
| Контейнер не становится healthy | `docker/up.sh logs neko`: нужны `/health` Neko и порт CDP браузера, на старт 30 с |
| Упал `profile-init` | `docker/up.sh logs profile-init`; при `MEATSUIT_PROFILE_DIR` путь абсолютный, на файловой системе с `chown` |
| `verify.sh`: вход не удался | нужен пароль участника (`NEKO_PASSWORD`), а не админа |
| Вход по `127.0.0.1` работает, по адресу tailnet — нет | `NEKO_SESSION_COOKIE_SECURE` должен остаться `"false"` (так в compose) |
| Нет видео или звука не с `127.0.0.1` | `NEKO_WEBRTC_IP` — тот адрес, что вы набираете в браузере; UDP 59000–59019 должны доходить до хоста |
| После перезапуска вышли из аккаунтов | не было ли `down -v` или смены `MEATSUIT_BROWSER`? `docker/verify.sh persistence`; останавливайте `docker/up.sh stop`, а не убивайте контейнер |
| «Профиль используется на другом компьютере» | профиль пришёл из контейнера с другим именем хоста: остановить браузер и удалить `SingletonLock`, `SingletonCookie`, `SingletonSocket` из папки профиля |
| Видео рывками, процессор занят | уменьшить `NEKO_SCREEN` и `NEKO_CPUS` |
| Контейнер выходит с кодом 137 | упёрся в потолок памяти: поднять `NEKO_MEM` |
| С Tailscale ничего не стартует | браузер ждёт healthy у `tailscale`: нужен рабочий `TS_AUTHKEY` и одобренный exit node в сети; `docker/up.sh logs tailscale` |
