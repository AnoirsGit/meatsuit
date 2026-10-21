#!/bin/sh
# Проверка зеркала по-настоящему: управление браузером через протокол Neko и независимая проверка по CDP.
#   docker/verify.sh              открыть статью, прокрутить, убедиться, что браузер это сделал
#   docker/verify.sh persistence  дополнительно: cookie и localStorage переживают остановку и пересоздание
# Нужны: поднятое зеркало (docker/up.sh) и файл деплоя (MEATSUIT_CONFIG или docker/.env, npm run init).
# Все команды compose идут через up.sh: тот же файл, тот же браузер, при MEATSUIT_EGRESS=tailscale — с Tailscale.
# Проверки работают в контейнере замороженного прогрева (extras/, образ life): он собирается при первом запуске.
set -eu
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
file=${MEATSUIT_CONFIG:-$here/.env}
case $file in "~/"*) file=$HOME/${file#"~/"} ;; esac
[ -f "$file" ] || { echo "нет файла деплоя $file: npm run init в корне репозитория"; exit 2; }
export MEATSUIT_CONFIG="$file"
# Значения файла без пробелов, кавычек и $ (так пишет config.js), поэтому его можно читать как sh.
set -a; . "$file"; set +a
DC="$here/up.sh"
RUN="$DC --profile warmup run --rm --no-deps -T -e NEKO_PASSWORD -e URL -e SCROLL -e LOAD_MS --entrypoint node life"
ok() { printf '  \033[32mOK\033[0m   %s\n' "$1"; }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILED=1; }
FAILED=0

wait_healthy() {
  i=0; while [ $i -lt 30 ]; do
    [ "$("$DC" ps -q neko | xargs -r docker inspect -f '{{.State.Health.Status}}' 2>/dev/null)" = healthy ] && return 0
    i=$((i+1)); sleep 4
  done; return 1
}

echo "1. зеркало поднято"
wait_healthy && ok "Neko и порт CDP отвечают (healthcheck)" || { bad "контейнер не стал здоровым за 2 минуты: docker/up.sh logs neko"; exit 1; }

echo "2. открыть статью и прокрутить через зеркало"
# Метка прогона в адресе (?verify=<время>; «#» протокол зеркала не набирает): браузер восстанавливает вкладки с прокруткой, и вкладка статьи от прошлого
# прогона прошла бы обе проверки без единой команды из зеркала. Считается только вкладка с меткой этого прогона.
MARK="verify$(date +%s)"
URL="en.wikipedia.org/wiki/Web_browser?verify=$MARK" SCROLL=8 $RUN /app/docker/verify/mirror.mjs >/dev/null 2>&1 && ok "команды отправлены (вход, управление, адрес, Enter, колесо)" || bad "не удалось войти или отправить команды: проверьте NEKO_PASSWORD"
STATE=$($RUN /app/docker/verify/cdp-read.js 2>&1 | tail -1)
echo "   браузер сейчас: $STATE"
TAB=$(echo "$STATE" | grep -o "\"url\":\"[^\"]*verify=$MARK[^\"]*\",\"scrollY\":[0-9]*" | head -1)
echo "$TAB" | grep -q 'wikipedia.org/wiki/Web_browser?verify=' && ok "адрес набран из зеркала и страница загружена (интернет есть)" || bad "браузер не открыл статью (вкладки с verify=$MARK нет)"
Y=$(echo "$TAB" | sed -n 's/.*"scrollY":\([0-9]*\).*/\1/p')
[ "${Y:-0}" -gt 500 ] && ok "страница прокручена колесом из зеркала (scrollY=$Y)" || bad "страница не прокрутилась (scrollY=${Y:-нет})"

if [ "${1:-}" = persistence ]; then
  echo "3. профиль: cookie и localStorage переживают немедленную остановку и пересоздание контейнера"
  state() { $RUN /app/docker/verify/cdp-read.js storage 2>&1 | tail -1; }
  field() { echo "$1" | sed -n "s/.*\"$2\":\"\([0-9]*\)\".*/\1/p"; }
  $RUN /app/docker/verify/cdp-read.js set >/dev/null 2>&1
  S=$(state); C0=$(field "$S" cookie); L0=$(field "$S" storage)
  [ -n "$C0" ] && [ -n "$L0" ] && ok "cookie и localStorage поставлены" || bad "не удалось поставить cookie/localStorage ($S)"
  "$DC" stop neko >/dev/null 2>&1; "$DC" start neko >/dev/null 2>&1
  wait_healthy || bad "после перезапуска контейнер не здоров"
  S=$(state)
  [ "$(field "$S" cookie)" = "$C0" ] && ok "cookie на месте после stop/start" || bad "cookie пропала после stop/start: профиль не сохраняется"
  [ "$(field "$S" storage)" = "$L0" ] && ok "localStorage на месте после stop/start" || bad "localStorage пропал после stop/start (так слетает вход в Тиндер)"
  "$DC" up -d --force-recreate neko >/dev/null 2>&1
  wait_healthy || bad "после пересоздания контейнер не здоров"
  S=$(state)
  [ "$(field "$S" cookie)" = "$C0" ] && ok "cookie на месте после пересоздания контейнера" || bad "cookie пропала после пересоздания"
  [ "$(field "$S" storage)" = "$L0" ] && ok "localStorage на месте после пересоздания контейнера" || bad "localStorage пропал после пересоздания"
fi

[ "$FAILED" = 0 ] && echo "ВСЁ В ПОРЯДКЕ" || { echo "ЕСТЬ ПРОБЛЕМЫ"; exit 1; }
