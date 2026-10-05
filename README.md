# meatsuit

Один прогретый браузер на сервере: я в нём живу (зеркало через Neko), мои боты из других проектов в нём работают человеческими руками.

- [Цель](docs/02-goal.md)
- [Что уже есть у нас и у других](docs/01-analysis.md)
- [Как устроено и как пользоваться](docs/03-design.md)
- [HTTP-интерфейс и технический дизайн](docs/04-http-api.md)
- [Выход в сеть: Алматы, замеры и выбор](docs/05-egress.md)
- [Прогрев: что автоматизировано, что нет](docs/06-warmup.md)
- [Зеркало браузера в Docker: запуск, проверки, деплой](docker/README.md)

Что есть: руки (`human.js`, `human/`: мышь, прокрутка, печать), `guard.js` (распознавание капчи и блока), автопрогрев (`life.js`, `life/`), HTTP-сервис (`server.js` с `view.js`, `driver.js`, `queue.js`, `limits.js`, `egress.js`, `notify.js`: `GET /view` и `POST /act`), зеркало браузера в Docker (`docker/`), `testkit/` (фальшивая страница для тестов). Состояние каждой части и что не проверено — в [docs/04-http-api.md](docs/04-http-api.md) и [docs/06-warmup.md](docs/06-warmup.md).

## Запуск

Нужен Node 20+. `node --test` и команды `plan`, `now --dry` браузера не требуют; сквозные тесты и `now`, `run` требуют.

```sh
node --test                  # тесты (без браузера)
npm run test:e2e             # сквозные тесты на настоящем Chromium: нужны Chromium и patchright, около 1,5 мин
node life.js plan            # расписание на сегодня и пример сессии
node life.js now --dry       # шаги одной сессии, на сайты не заходит
node life.js now             # одна сессия сейчас
node life.js run             # по расписанию, остановить Ctrl+C
```

`now` и `run` подключаются по CDP к уже запущенному браузеру (`--remote-debugging-port`, адрес `--cdp` или `MEATSUIT_CDP`, по умолчанию `http://127.0.0.1:9222`), для них нужен `npm install`. Настройка в `profiles/life.json`, журнал в `data/life.jsonl`: всё это, разгон по неделям и риски — в [docs/06-warmup.md](docs/06-warmup.md). Прогрев пока не проверен на Brave и на реальных сайтах.
