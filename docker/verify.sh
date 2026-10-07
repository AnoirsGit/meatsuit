#!/bin/sh
# Проверка зеркала по-настоящему: управление Brave через протокол Neko и независимая проверка по CDP.
#   ./verify.sh              открыть статью, прокрутить, убедиться, что Brave это сделал
#   ./verify.sh persistence  дополнительно: cookie переживает немедленную остановку и запуск
# Нужны: запущенный `docker compose up -d` (зеркало) и docker/.env. Образ life собирается при первом запуске.
set -eu
cd "$(dirname "$0")"
[ -f .env ] || { echo "нет docker/.env: npm run init в корне репозитория"; exit 2; }
set -a; . ./.env; set +a
RUN="docker compose --profile warmup run --rm --no-deps -T -e NEKO_PASSWORD -e URL -e SCROLL -e LOAD_MS --entrypoint node life"
ok() { printf '  \033[32mOK\033[0m   %s\n' "$1"; }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILED=1; }
FAILED=0

wait_healthy() {
  i=0; while [ $i -lt 30 ]; do
    [ "$(docker compose ps -q neko | xargs -r docker inspect -f '{{.State.Health.Status}}' 2>/dev/null)" = healthy ] && return 0
    i=$((i+1)); sleep 4
  done; return 1
}

echo "1. зеркало поднято"
wait_healthy && ok "Neko и порт CDP отвечают (healthcheck)" || { bad "контейнер не стал здоровым за 2 минуты: docker compose logs neko"; exit 1; }

echo "2. открыть статью и прокрутить через зеркало"
URL="en.wikipedia.org/wiki/web_browser" SCROLL=8 $RUN /app/docker/verify/mirror.mjs >/dev/null 2>&1 && ok "команды отправлены (вход, управление, адрес, Enter, колесо)" || bad "не удалось войти или отправить команды: проверьте NEKO_PASSWORD"
STATE=$($RUN /app/docker/verify/cdp-read.js 2>&1 | tail -1)
echo "   Brave сейчас: $STATE"
echo "$STATE" | grep -q 'wikipedia.org/wiki/Web_browser' && ok "адрес набран из зеркала и страница загружена (интернет есть)" || bad "Brave не открыл статью"
Y=$(echo "$STATE" | sed -n 's/.*"scrollY":\([0-9]*\).*/\1/p' | head -1)
[ "${Y:-0}" -gt 500 ] && ok "страница прокручена колесом из зеркала (scrollY=$Y)" || bad "страница не прокрутилась (scrollY=${Y:-нет})"

if [ "${1:-}" = persistence ]; then
  echo "3. профиль: свежая cookie переживает немедленную остановку"
  $RUN /app/docker/verify/cdp-read.js set-cookie >/dev/null 2>&1
  BEFORE=$($RUN /app/docker/verify/cdp-read.js 2>&1 | tail -1 | sed -n 's/.*"cookie":"\([0-9]*\)".*/\1/p')
  docker compose stop neko >/dev/null 2>&1; docker compose start neko >/dev/null 2>&1
  wait_healthy || bad "после перезапуска контейнер не здоров"
  AFTER=$($RUN /app/docker/verify/cdp-read.js 2>&1 | tail -1 | sed -n 's/.*"cookie":"\([0-9]*\)".*/\1/p')
  [ -n "$BEFORE" ] && [ "$BEFORE" = "$AFTER" ] && ok "cookie на месте после stop/start" || bad "cookie пропала (было '$BEFORE', стало '$AFTER'): профиль не сохраняется"
fi

[ "$FAILED" = 0 ] && echo "ВСЁ В ПОРЯДКЕ" || { echo "ЕСТЬ ПРОБЛЕМЫ"; exit 1; }
