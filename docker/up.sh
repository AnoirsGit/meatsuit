#!/bin/sh
# Зеркало meatsuit через docker compose с файлом деплоя (--env-file).
#
#   docker/up.sh                        поднять зеркало: up -d
#   docker/up.sh <команда compose …>    то же окружение для любой команды: ps, logs -f neko, stop, down, config
#   docker/up.sh --profile warmup up -d сервисы extras/ (warmup, api) — профилями compose, как обычно
#
# Файл деплоя: MEATSUIT_CONFIG (можно ~/…) или docker/.env рядом с этим скриптом; создаёт его npm run init.
# Браузер выбирает MEATSUIT_BROWSER из файла (chrome по умолчанию, brave) — это читает сам compose.
# MEATSUIT_EGRESS=tailscale в файле (или в окружении) добавляет docker-compose.egress.yml и профиль egress;
# пусто или off — без Tailscale. Файл скрипт не исполняет: значение берётся строкой.
# После up, который пересоздал браузер, называет контейнеры других проектов, оставшиеся в сети прежнего
# meatsuit-browser, и команду пересоздания для каждого (сам их не трогает).
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

is_up=0
for a in "$@"; do [ "$a" = up ] && is_up=1; done
[ "$is_up" = 1 ] || exec docker compose --env-file "$file" -f "$here/docker-compose.yml" "$@"

# После up: соседи браузера из других проектов (network_mode: "container:meatsuit-browser") держатся за id контейнера —
# compose записывает в NetworkMode «container:<id>». Если up пересоздал браузер, они остались в сети старого контейнера,
# то есть без сети, пока их не пересоздать. Здесь они только называются, с командой для каждого: чужие проекты не трогаем.
browser_id() { docker inspect -f '{{.Id}}' meatsuit-browser 2>/dev/null || true; }
old=$(browser_id)
st=0
docker compose --env-file "$file" -f "$here/docker-compose.yml" "$@" || st=$?
if [ -n "$old" ] && [ "$old" != "$(browser_id)" ]; then
  ids=$(docker ps -aq 2>/dev/null || true)
  if [ -n "$ids" ]; then
    # shellcheck disable=SC2086
    docker inspect -f '{{.Name}}|{{.HostConfig.NetworkMode}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.docker.compose.project.working_dir"}}|{{index .Config.Labels "com.docker.compose.project.config_files"}}|{{index .Config.Labels "com.docker.compose.oneoff"}}' $ids 2>/dev/null \
      | awk -F '|' -v want="container:$old" '
          $2 != want { next }
          { name = $1; sub(/^\//, "", name)
            if ($7 == "True") line = name ": разовый запуск (compose run) — этот кончится без сети, следующий сам возьмёт новую"
            else if ($3 != "" && $4 != "") {
              files = ""; n = split($6, f, ","); for (i = 1; i <= n; i++) if (f[i] != "") files = files " -f " f[i]
              line = name ": " ($5 != "" ? "cd " $5 " && " : "") "docker compose -p " $3 files " up -d --force-recreate " $4
            } else line = name ": не из compose — пересоздать тем же docker run"
            out = out "  " line "\n" }
          END { if (out != "") printf "up.sh: браузер пересоздан, а эти контейнеры живут в сети прежнего meatsuit-browser и остались без сети.\nПересоздайте их в их проектах (up.sh чужие проекты не трогает):\n%s", out }' >&2
  fi
fi
exit "$st"
