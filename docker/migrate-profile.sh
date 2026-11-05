#!/bin/sh
# Перенос профиля браузера из одного тома Docker в другой: со старой раскладки зеркала на нынешнюю
# (например, том docker_neko-chrome-profile прежнего проекта docker → meatsuit_profile) или копия профиля перед
# обновлением. Порядок обновления целиком — docs/ru/10-upgrade.md.
#
#   docker/migrate-profile.sh --plan <из тома> [<в том>]   показать, что будет сделано, и ничего не менять
#   docker/migrate-profile.sh <из тома> [<в том>]          скопировать; в том по умолчанию meatsuit_profile
#   docker/migrate-profile.sh --force <из тома> [<в том>]  то же в непустой том: его содержимое будет стёрто
#
# Отказывается (код 1): нет тома-источника; тома совпадают; к любому из томов подключён работающий контейнер
# (браузер не остановлен — копия была бы рваной); в целевом томе что-то есть, а --force не задан.
# Копирует одноразовый контейнер без сети: источник подключён только для чтения; cp -a, затем удаляет замки профиля
# SingletonLock, SingletonCookie, SingletonSocket (они помнят имя хоста прежнего контейнера, и Chrome открыл бы окно
# «профиль используется на другом компьютере»), отдаёт всё пользователю neko (1000:1000) и сверяет число записей.
# Образ — тот, что у зеркала (MEATSUIT_MIGRATE_IMAGE, по умолчанию ghcr.io/m1k1o/neko/google-chrome:3.1.6).
set -eu

me=migrate-profile.sh
image=${MEATSUIT_MIGRATE_IMAGE:-ghcr.io/m1k1o/neko/google-chrome:3.1.6}

usage() {
  echo "использование: docker/$me [--plan] [--force] <из тома> [<в том, по умолчанию meatsuit_profile>]" >&2
  exit 2
}
plan=0 force=0 from='' to='' n=0
for a in "$@"; do
  case $a in
    --plan) plan=1 ;;
    --force) force=1 ;;
    -*) usage ;;
    *) n=$((n + 1)); if [ $n = 1 ]; then from=$a; else to=$a; fi ;;
  esac
done
[ $n -ge 1 ] && [ $n -le 2 ] || usage
to=${to:-meatsuit_profile}

# Одноразовый контейнер: без сети, от root (нужен chown), тома только через --mount type=volume — путь не станет папкой хоста.
run() { docker run --rm --network none --user 0:0 --entrypoint sh "$@"; }
# Работающие контейнеры, к которым подключён том, по строке на каждый.
busy() { docker ps --filter "volume=$1" --format '{{.Names}}'; }
# Записей в томе и размер в КБ: «N KB». Смотрит только для чтения.
size() { run --mount "type=volume,src=$1,dst=/v,readonly" "$image" -c 'echo "$(find /v -mindepth 1 | wc -l) $(du -sk /v | cut -f1)"'; }
mb() { echo "$(( ($1 + 1023) / 1024 )) МБ"; }

[ "$from" != "$to" ] || { echo "$me: отказ: из тома и в том — один и тот же том $from" >&2; exit 1; }
docker volume inspect "$from" >/dev/null || { echo "$me: отказ: нет тома $from (список: docker volume ls)" >&2; exit 1; }

refuse=''
b=$(busy "$from"); b=$(echo $b) # сбой docker ps останавливает скрипт (set -e); имена через пробел
if [ -n "$b" ]; then
  src_line="подключён к работающим контейнерам: $b"
  refuse="том $from подключён к работающим контейнерам: $b. Остановите их (браузер — docker stop, он успеет сохранить cookie), потом снова"
else
  s=$(size "$from"); set -- $s
  src_line="только чтение, не меняется; записей $1, $(mb "$2")"
fi

to_exists=0
docker volume inspect "$to" >/dev/null 2>&1 && to_exists=1
b=$(busy "$to"); b=$(echo $b)
if [ -n "$b" ]; then
  dst_line="подключён к работающим контейнерам: $b"
  refuse="${refuse:+$refuse
}том $to подключён к работающим контейнерам: $b. Остановите их, потом снова"
elif [ $to_exists = 0 ]; then
  dst_line="нет, будет создан (docker volume create)"
else
  s=$(size "$to"); set -- $s
  if [ "$1" = 0 ]; then
    dst_line="есть, пуст"
  elif [ $force = 1 ]; then
    dst_line="не пуст (записей $1, $(mb "$2")): с --force будет очищен"
  else
    dst_line="не пуст (записей $1, $(mb "$2"))"
    refuse="${refuse:+$refuse
}том $to не пуст (записей $1): там уже профиль или копия. Заменить его — --force (содержимое будет стёрто)"
  fi
fi

echo "$me: перенос профиля браузера между томами Docker"
echo "  из тома: $from — $src_line"
echo "  в том:   $to — $dst_line"
echo "  образ:   $image (одноразовый контейнер без сети)"
echo "  шаги:    $([ $force = 1 ] && echo "очистить $to; ")cp -a; убрать SingletonLock, SingletonCookie, SingletonSocket;"
echo "           владелец 1000:1000; сверить число записей"
if [ -n "$refuse" ]; then
  echo "$refuse" | sed "s/^/$me: отказ: /" >&2
  exit 1
fi
[ $plan = 0 ] || { echo "$me: --plan: ничего не сделано"; exit 0; }

[ $to_exists = 1 ] || docker volume create "$to" >/dev/null
run --mount "type=volume,src=$from,dst=/from,readonly" --mount "type=volume,src=$to,dst=/to" "$image" -c '
  set -eu
  [ "$1" = 0 ] || find /to -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  cp -a /from/. /to/
  rm -f /to/SingletonLock /to/SingletonCookie /to/SingletonSocket
  chown -R 1000:1000 /to
  want=$(find /from -mindepth 1 ! -path /from/SingletonLock ! -path /from/SingletonCookie ! -path /from/SingletonSocket | wc -l)
  got=$(find /to -mindepth 1 | wc -l)
  [ "$got" = "$want" ] || { echo "в источнике записей $want (без замков), в копии $got" >&2; exit 1; }
' sh "$force" || { echo "$me: копия не удалась (в $to может остаться неполная копия: повторите с --force); том $from не тронут" >&2; exit 1; }
s=$(size "$to"); set -- $s
echo "$me: готово: в $to записей $1, $(mb "$2"), владелец 1000:1000, замков профиля нет. Том $from не тронут."
