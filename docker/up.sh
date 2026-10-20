#!/bin/sh
# Зеркало meatsuit через docker compose с файлом деплоя (--env-file).
#
#   docker/up.sh                        поднять зеркало: up -d
#   docker/up.sh <команда compose …>    то же окружение для любой команды: ps, logs -f neko, stop, down, config
#   docker/up.sh --profile warmup up -d замороженные extras/ (warmup, api) — профилями compose, как обычно
#
# Файл деплоя: MEATSUIT_CONFIG (можно ~/…) или docker/.env рядом с этим скриптом; создаёт его npm run init.
# Браузер выбирает MEATSUIT_BROWSER из файла (chrome по умолчанию, brave) — это читает сам compose.
# MEATSUIT_EGRESS=tailscale в файле (или в окружении) добавляет docker-compose.egress.yml и профиль egress;
# пусто или off — без Tailscale. Файл скрипт не исполняет: значение берётся строкой.
set -eu

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
file=${MEATSUIT_CONFIG:-$here/.env}
case $file in "~/"*) file=$HOME/${file#"~/"} ;; esac
if [ ! -f "$file" ]; then
  echo "up.sh: нет файла деплоя $file — создайте его: npm run init (в корне репозитория)" >&2
  exit 2
fi

# Последнее «KEY=значение» из файла: без export, кавычек и комментария « #…», как читает compose.
value() {
  sed -n "s/^[[:space:]]*\(export[[:space:]][[:space:]]*\)\{0,1\}$1[[:space:]]*=//p" "$file" | tail -n 1 \
    | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]#.*$//' -e 's/[[:space:]]*$//' -e "s/^[\"']\(.*\)[\"']\$/\1/"
}

egress=${MEATSUIT_EGRESS-$(value MEATSUIT_EGRESS)}
[ $# -gt 0 ] || set -- up -d
case $egress in
  ''|off) ;;
  tailscale) set -- -f "$here/docker-compose.egress.yml" --profile egress "$@" ;;
  *) echo "up.sh: MEATSUIT_EGRESS=$egress не понятен: пусто, off или tailscale" >&2; exit 2 ;;
esac

exec docker compose --env-file "$file" -f "$here/docker-compose.yml" "$@"
