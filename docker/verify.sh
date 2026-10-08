#!/bin/sh
# Проверка зеркала по-настоящему: управление браузером через протокол Neko и независимая проверка по CDP.
#   docker/verify.sh              открыть статью, прокрутить, убедиться, что браузер это сделал
#   docker/verify.sh persistence  дополнительно: cookie переживает немедленную остановку и запуск
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
# Метка прогона в адресе (#verify<время>): браузер восстанавливает вкладки с прокруткой, и вкладка статьи от прошлого
# прогона прошла бы обе проверки без единой команды из зеркала. Считается только вкладка с меткой этого прогона.
MARK="verify$(date +%s)"
URL="en.wikipedia.org/wiki/web_browser#$MARK" SCROLL=8 $RUN /app/docker/verify/mirror.mjs >/dev/null 2>&1 && ok "команды отправлены (вход, управление, адрес, Enter, колесо)" || bad "не удалось войти или отправить команды: проверьте NEKO_PASSWORD"
STATE=$($RUN /app/docker/verify/cdp-read.js 2>&1 | tail -1)
echo "   браузер сейчас: $STATE"
TAB=$(echo "$STATE" | grep -o "\"url\":\"[^\"]*#$MARK\",\"scrollY\":[0-9]*" | head -1)
echo "$TAB" | grep -q 'wikipedia.org/wiki/Web_browser#' && ok "адрес набран из зеркала и страница загружена (интернет есть)" || bad "браузер не открыл статью (вкладки с #$MARK нет)"
Y=$(echo "$TAB" | sed -n 's/.*"scrollY":\([0-9]*\).*/\1/p')
[ "${Y:-0}" -gt 500 ] && ok "страница прокручена колесом из зеркала (scrollY=$Y)" || bad "страница не прокрутилась (scrollY=${Y:-нет})"

if [ "${1:-}" = persistence ]; then
  echo "3. профиль: свежая cookie переживает немедленную остановку"
  $RUN /app/docker/verify/cdp-read.js set-cookie >/dev/null 2>&1
  BEFORE=$($RUN /app/docker/verify/cdp-read.js 2>&1 | tail -1 | sed -n 's/.*"cookie":"\([0-9]*\)".*/\1/p')
  "$DC" stop neko >/dev/null 2>&1; "$DC" start neko >/dev/null 2>&1
  wait_healthy || bad "после перезапуска контейнер не здоров"
  AFTER=$($RUN /app/docker/verify/cdp-read.js 2>&1 | tail -1 | sed -n 's/.*"cookie":"\([0-9]*\)".*/\1/p')
  [ -n "$BEFORE" ] && [ "$BEFORE" = "$AFTER" ] && ok "cookie на месте после stop/start" || bad "cookie пропала (было '$BEFORE', стало '$AFTER'): профиль не сохраняется"
fi

[ "$FAILED" = 0 ] && echo "ВСЁ В ПОРЯДКЕ" || { echo "ЕСТЬ ПРОБЛЕМЫ"; exit 1; }
