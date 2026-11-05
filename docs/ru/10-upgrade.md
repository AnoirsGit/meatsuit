# Обновление зеркала до `main` без потери входов

Записка для владельца, сверена 05.11.2026. Сейчас одновременно живут три версии meatsuit, и новое до вызывающих
не доходит: `home-pc` — старый контейнер из ветки `feat/eyes-hands-guard` (07.10), сервер — ветка `ms-trunk` (08.10),
и сам `main`. Здесь шаги, как перевести обе машины на `main` и не потерять входы на сайтах (Тиндер и другие).

Входы живут в профиле Chrome, а профиль — в томе Docker. Пересоздание контейнера их не трогает; теряются они, если
браузер поднять на **другом** томе (он будет пустым) или удалить том. Перенос между томами делает
[`docker/migrate-profile.sh`](../../docker/migrate-profile.sh): источник подключает только для чтения, отказывается,
пока к тому подключён работающий контейнер или пока целевой том не пуст, убирает замки профиля и отдаёт файлы
пользователю браузера (1000:1000). `--plan` показывает, что будет сделано, и ничего не меняет.
С `--force` скрипт стирает **второй** том (куда копировать). Перед каждым `--force` — та же команда с `--plan`: в строке
«в том» должен стоять тот том, который не жалко.

**Что проверено** (05.11, на `home-pc`, только на своих одноразовых томах; живой контейнер и его том не трогались):
`test/migrate-profile.test.js` (отказы, `--plan`, копия, `--force`, владелец, источник не меняется); репетиция (один
прогон) с настоящим Chrome 154 из образа `3.1.6` — профиль, записанный Chrome под другим именем хоста, с cookie и `localStorage` и
с оставленными замками, перенесён скриптом, и Chrome под именем `meatsuit-browser` поднялся с той же cookie и тем же
`localStorage`; без удаления замков тот же Chrome не стартует вовсе («The profile appears to be in use … on another
computer»). На отдельном проекте compose проверено, что `create` создаёт пустой том с метками compose, ничего не запуская,
а `up` потом сохраняет то, что скрипт туда положил. **Не проверено:** перенос настоящего профиля владельца и сам переход
на `home-pc` и на сервере.

## 1. `home-pc`: старый проект `docker` → `main`

### Что сейчас и что поменяется

Сейчас (05.11) работает контейнер `meatsuit-neko-chrome` (проект compose `docker`, поднят 03.11). Файла, из которого
он поднят (`docker/docker-compose.chrome.yml` ветки `feat/eyes-hands-guard`), в клоне больше нет: этим контейнером
управляют по имени (`docker stop`, `docker start`). Образ `ghcr.io/m1k1o/neko/google-chrome:latest` 05.11 — тот же образ,
что `:3.1.6` в `main` (один digest `sha256:dce2a628…`, Chrome 154.0.8037.92): профиль не попадёт в более старый Chrome.

| | Сейчас | На `main` |
|---|---|---|
| Контейнер | `meatsuit-neko-chrome`, проект `docker` | `meatsuit-browser`, проект `meatsuit` |
| Профиль | том `docker_neko-chrome-profile` | том `meatsuit_profile` (в нём же `state/` вызывающих); папка внутри та же, `/home/neko/.config/chrome-meatsuit` |
| Сеть | сеть хоста: CDP на `127.0.0.1:9222` самого ПК | своя: CDP только внутри сети контейнера (`container:meatsuit-browser`); зеркало на `127.0.0.1:8080` |
| Имя хоста | имя ПК | `meatsuit-browser` (поэтому замки профиля надо убрать — это делает скрипт) |
| UDP для видео | 52000–52100 | 59000–59019 |
| Экран | 1920x1080@30 | `NEKO_SCREEN`, по умолчанию 1280x720@30 |
| Пароль входа в зеркало | `NEKO_USER_PASSWORD` в старом `docker/.env` | `NEKO_PASSWORD` (новый файл деплоя) |

Пояс браузера не меняется: в старом compose `TZ` не задан (в образе `Etc/UTC`), в `main` по умолчанию `MEATSUIT_TZ=UTC`. Том
`docker_neko-profile` — профиль ещё более старого зеркала на Chromium (07.10); им никто не пользуется, шаги его не трогают.

**Что сломается у вызывающих.** Программы на самом ПК, которые ходят в браузер по `http://127.0.0.1:9222` (локальный
запуск бота), после перехода его не достанут: CDP наружу не публикуется. Их запускают в контейнере с
`network_mode: "container:meatsuit-browser"` и `dir` в `state/` тома `meatsuit_profile` — как `deploy/` у tinder-matcher
([Подключение другого стека](../../docker/README.ru.md#подключение-другого-стека)). Замок очереди и счётчики лимитов,
если вызывающий вёл их в другой папке (по умолчанию `~/.meatsuit`), сами в `state/` не переедут.

### Шаги

Браузер не работает от шага 3 до шага 5 — несколько минут.

**0. Клон на `main`** (в нём должен быть `docker/migrate-profile.sh`):

```sh
cd <клон meatsuit>
git status --short                   # пусто (неотслеживаемый docker/.env не в счёт)
git switch main
ls docker/migrate-profile.sh
```

**1. Файл деплоя.** Старый `docker/.env` написан для старого compose: в нём нет `NEKO_PASSWORD`, и `npm run init`
говорит «уже есть, ничего не меняю» и `NEKO_PASSWORD: обязательно`. Тогда отложить его и создать новый:

```sh
npm run init                                  # если «NEKO_PASSWORD: обязательно» — это файл старой раскладки:
mv docker/.env docker/.env.old-layout         # .env* в .gitignore; удалить после перехода (в нём старые пароли)
npm run init                                  # новый docker/.env, права 0600, случайные пароли
sed -i 's/^NEKO_SCREEN=.*/NEKO_SCREEN=1920x1080@30/' docker/.env   # по желанию: экран как был
grep NEKO_PASSWORD docker/.env                # пароль для входа в зеркало
```

**2. Новый стек — создать, не запуская.** Скачивает образ, если его нет, создаёт пустой том `meatsuit_profile` с метками
compose и контейнеры; ничего не запускает, порты не занимает:

```sh
docker/up.sh create
```

Без этого шага скрипт создаст том сам, но тогда compose при каждом `up` будет предупреждать, что том создан не им.

**3. Остановить старый браузер.** До 30 с: Chrome получает SIGINT и дописывает cookie на диск. После `docker stop`
контейнер сам не поднимется и после перезагрузки (`restart: unless-stopped`).

```sh
docker stop meatsuit-neko-chrome
docker ps --filter name=meatsuit-neko-chrome --format '{{.Names}}'    # пусто
```

**4. План и копия:**

```sh
docker/migrate-profile.sh --plan docker_neko-chrome-profile   # в том meatsuit_profile — «есть, пуст», отказов нет
docker/migrate-profile.sh docker_neko-chrome-profile          # в конце «готово: в meatsuit_profile записей …»
```

Если скрипт отказал: «подключён к работающим контейнерам» — шаг 3 не сделан или профиль держит кто-то ещё (он назван);
«не пуст» — в `meatsuit_profile` уже что-то есть (например, стек `main` уже поднимали): посмотреть, что это, и только
потом `--force` (содержимое `meatsuit_profile` будет стёрто; сначала `--plan --force`).

**5. Запустить:**

```sh
docker/up.sh                 # profile-init (папка state/, владелец 1000), потом браузер
docker/up.sh ps              # meatsuit-browser — healthy
```

**6. Проверить входы.** Открыть `http://127.0.0.1:8080`, любое имя и `NEKO_PASSWORD` из нового файла. Тиндер и остальные
сайты открываются уже с входом. Chrome может предложить восстановить вкладки — это нормально. По желанию
`docker/verify.sh` (открывает статью Википедии через зеркало; при первом запуске собирает образ `life`).

**7. Откат**, если входов нет. Старый том копия не меняла (подключён только для чтения):

```sh
docker/up.sh stop
docker start meatsuit-neko-chrome
```

Новый том `meatsuit_profile` остаётся как есть, чтобы разобраться. Повторить перенос: снова шаг 3, затем
`docker/migrate-profile.sh --plan --force docker_neko-chrome-profile` (в строке «в том» — `meatsuit_profile`), та же
команда без `--plan`, затем шаг 5.

**8. Уборка** — через неделю спокойной работы, не раньше:

```sh
docker rm meatsuit-neko-chrome
docker volume rm docker_neko-chrome-profile
rm docker/.env.old-layout
```

`docker_neko-profile` (Chromium 07.10) — на ваше усмотрение: `docker volume rm docker_neko-profile`.

## 2. Сервер: `ms-trunk` → `main`

Здесь перенос не нужен: у `ms-trunk` и `main` один проект `meatsuit`, те же имена томов и контейнеров и тот же образ
(`docker/browser-chrome.yml` между ними не менялся), поэтому браузер после пересоздания найдёт свой профиль в
`meatsuit_profile`. Скрипт нужен для копии профиля перед обновлением: если что-то пойдёт не так, есть что вернуть.
Что меняется в работе: `exit-picker.sh` в контейнере Tailscale (без `MEATSUIT_EXIT_NODES` ведёт себя как раньше),
`chrome.conf` (программный WebGL; Chrome получает 25 с на сохранение при остановке вместо 10), `up.sh` после
пересоздания браузера называет соседей, которых надо пересоздать.

Сначала `main` должен быть запушен (порядок — пункт 1 [ROADMAP](../ROADMAP.md)).

**1. Клон на `main`** — шаг 1 из [09-phone-exit-node.md, «5. Сервер»](09-phone-exit-node.md#5-сервер). Работающие
контейнеры это не трогает.

**2. Копия профиля.** Браузер на время копии остановлен; место на диске — не меньше размера, который покажет `--plan`
(`df -h /var/lib/docker`).

```sh
cd /opt/meatsuit
docker/up.sh stop neko
docker/migrate-profile.sh --plan meatsuit_profile meatsuit_profile_ms_trunk
docker/migrate-profile.sh meatsuit_profile meatsuit_profile_ms_trunk
```

Том `meatsuit_profile` подключают и вызывающие (папка `state/`), поэтому скрипт может отказать и назвать их
(например, `pult` tinder-matcher держит его только для чтения, но и это отказ). Остановить названных
(`docker stop <имена>`) и повторить; после шага 3 их поднимает шаг 4 из 09 (`docker start <имя>` — тем, кто живёт в
своей сети). Скрипт смотрит на контейнеры только перед копией: запуск по cron (`deploy/run.sh` tinder-matcher) на время
копии отключить, иначе он подключит том посреди неё.

**3. Пересоздать стек и соседей** — шаги 3 и 4 из [09-phone-exit-node.md, «5. Сервер»](09-phone-exit-node.md#5-сервер).
Список узлов (шаг 2 там) — когда будет телефон, отдельно.

**4. Проверить:** входы в зеркале, `docker/verify.sh`; вызывающий (`doctor` tinder-matcher) зелёный.

**5. Откат**, если что-то не так: профиль вернуть из копии (только если он испорчен), затем старую ветку. Вызывающих,
которых назовёт скрипт, остановить, как в шаге 2. `--force` стирает `meatsuit_profile` целиком, вместе с тем, что
вызывающие записали в `state/` после копии (замок, счётчики, журнал).

```sh
cd /opt/meatsuit
docker/up.sh stop neko
docker/migrate-profile.sh --plan --force meatsuit_profile_ms_trunk meatsuit_profile   # «в том: meatsuit_profile … будет очищен»
docker/migrate-profile.sh --force meatsuit_profile_ms_trunk meatsuit_profile          # только если испорчен профиль
git checkout ms-trunk
docker/up.sh up -d --force-recreate
```

Потом соседей — как в шаге 4 из 09 (на `ms-trunk` `up.sh` их сам не называет: команда `docker ps … | grep 'container:'`
оттуда). Если ветки `ms-trunk` уже нет (её убрала чистка истории), откатить можно только профиль.

**6. Уборка** через неделю: `docker volume rm meatsuit_profile_ms_trunk`.
