#!/bin/sh
# Выбор exit node по списку с запасным: телефон дома → anoir-pc. Работает в контейнере tailscale рядом с containerboot
# (docker-compose.yml: command = exit-picker.sh launch containerboot). Без MEATSUIT_EXIT_NODES ничего не делает:
# launch просто запускает команду, выход задаёт TS_EXTRA_ARGS, как раньше.
#
#   exit-picker.sh launch <команда…>  закрыть ворота (если задана проверка), фоном цикл, exec команды
#   exit-picker.sh loop               цикл: шаг раз в MEATSUIT_EXIT_INTERVAL секунд
#   exit-picker.sh once               один шаг (тесты, ручной прогон)
#   exit-picker.sh status             таблица узлов из списка: адрес, в сети ли, выбран ли, ворота
#
# Настройки (файл деплоя → compose → окружение контейнера):
#   MEATSUIT_EXIT_NODES    имена по порядку предпочтения через запятую, без пробелов: home-phone,anoir-pc.
#                          Имя — первая часть имени MagicDNS, полное имя, HostName или 100.x-адрес узла.
#   MEATSUIT_EXIT_COUNTRY  ожидаемая страна выхода (KZ); MEATSUIT_EXIT_ASN — номера провайдера через запятую (64500).
#                          Хотя бы одно задано — после каждой смены и раз в MEATSUIT_EXIT_PROBE_EVERY шагов выход
#                          проверяется через ipinfo.io (запасной ipwho.is). Не совпало или не определилось — узел
#                          бракуется на PROBE_EVERY шагов и берётся следующий; годных нет — ворота закрыты.
#   MEATSUIT_EXIT_INTERVAL (30 с), MEATSUIT_EXIT_DOWN_AFTER (2 шага офлайн — уйти с узла),
#   MEATSUIT_EXIT_RETURN_AFTER (4 шага онлайн — вернуться на узел выше по списку), MEATSUIT_EXIT_PROBE_EVERY (10).
#
# Ворота. Выключатель (killswitch.sh) пускает всё в tailscale0, а значит и в любой exit node. Пока выход не проверен,
# первым правилом OUTPUT стоит REJECT новых соединений не от root в туннель мимо tailnet (100.64.0.0/10): зеркало и
# ответы ходят, сайты — нет. Сама проверка идёт от root (wget), ей ворота не мешают. Без проверки ворот нет вовсе.
# Сбой: годного узла нет — exit node не снимается (без него браузер и так без сети), ворота закрыты, healthcheck
# контейнера красный (файл $STATE/gate = closed). Fail closed сохраняется в любом случае.
set -u

NODES=${MEATSUIT_EXIT_NODES:-}
COUNTRY=$(printf '%s' "${MEATSUIT_EXIT_COUNTRY:-}" | tr 'a-z' 'A-Z')
ASNS=${MEATSUIT_EXIT_ASN:-}
INTERVAL=${MEATSUIT_EXIT_INTERVAL:-30}
DOWN_AFTER=${MEATSUIT_EXIT_DOWN_AFTER:-2}
RETURN_AFTER=${MEATSUIT_EXIT_RETURN_AFTER:-4}
PROBE_EVERY=${MEATSUIT_EXIT_PROBE_EVERY:-10}
SETTLE=${EXIT_PICKER_SETTLE:-3}          # секунд после смены узла до проверки
TICKS=${EXIT_PICKER_TICKS:-0}            # 0 — цикл бесконечный (для тестов: сколько шагов сделать)
STATE=${EXIT_PICKER_STATE:-/tmp/exit-picker}

log() { echo "exit-picker: $*" >&2; }
probing() { [ -n "$COUNTRY$ASNS" ]; }
get() { cat "$STATE/$1" 2>/dev/null || echo "${2:-}"; }
put() { printf '%s\n' "$2" > "$STATE/$1"; }
lower() { printf '%s' "$1" | tr 'A-Z' 'a-z'; }

# Правило ворот для IPv4 и, если есть ip6tables, для IPv6 (адреса tailnet в IPv6 — fd7a:115c:a1e0::/48).
gate_rule() { # $1 = iptables|ip6tables, $2 = -C|-D|-I
  net=100.64.0.0/10; [ "$1" = ip6tables ] && net=fd7a:115c:a1e0::/48
  pos=; [ "$2" = -I ] && pos=1
  "$1" "$2" OUTPUT $pos -o tailscale0 ! -d "$net" -m owner ! --uid-owner 0 -m conntrack --ctstate NEW -j REJECT
}
gate_tools() { echo iptables; command -v ip6tables >/dev/null 2>&1 && echo ip6tables; }
gate_close() {
  for tool in $(gate_tools); do
    gate_rule "$tool" -C 2>/dev/null || gate_rule "$tool" -I || { log "не удалось закрыть ворота ($tool)"; return 1; }
  done
  [ "$(get gate)" = closed ] || log "ворота закрыты: браузер без выхода в сеть, пока выход не проверен"
  put gate closed
}
gate_open() {
  for tool in $(gate_tools); do
    k=0 # не n: n — число узлов в tick
    while gate_rule "$tool" -C 2>/dev/null && [ $k -lt 5 ]; do gate_rule "$tool" -D; k=$((k + 1)); done
  done
  [ "$(get gate)" = open ] || log "ворота открыты"
  put gate open
}

# tailscale status --json → строка на узел: ip, имя DNS, HostName, online, exit-node-option, selected (через табуляцию).
# Разбор по глубине скобок, а не по отступам: по ключу на строку, как печатает tailscale (json.MarshalIndent).
PARSE='
function unq(v) { sub(/^[ \t]*"/, "", v); sub(/"[ \t,]*$/, "", v); return v }
function flush() {
  if (inpeer && ip != "") print ip "\t" tolower(dns) "\t" tolower(host) "\t" online "\t" opt "\t" sel
  ip = ""; dns = ""; host = ""; online = "false"; opt = "false"; sel = "false"; wantip = 0
}
BEGIN { depth = 0; inpeer = 0; flush() }
{
  line = $0; key = ""
  if (match(line, /^[ \t]*"[^"]*"[ \t]*:/)) { key = substr(line, RSTART, RLENGTH); sub(/^[ \t]*"/, "", key); sub(/"[ \t]*:$/, "", key) }
  val = line; sub(/^[ \t]*"[^"]*"[ \t]*:[ \t]*/, "", val); sub(/[ \t,]*$/, "", val)
  if (depth == 1 && key != "") { flush(); inpeer = 0; section = key }
  else if (section == "Peer" && depth == 2 && key != "") { flush(); inpeer = 1 }
  else if (inpeer && depth == 3) {
    wantip = 0
    if (key == "HostName") host = unq(val)
    else if (key == "DNSName") { dns = unq(val); sub(/\.$/, "", dns) }
    else if (key == "Online") online = val
    else if (key == "ExitNodeOption") opt = val
    else if (key == "ExitNode") sel = val
    else if (key == "TailscaleIPs") {
      wantip = 1
      if (match(val, /"[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+"/)) { ip = substr(val, RSTART + 1, RLENGTH - 2); wantip = 0 }
    }
  } else if (inpeer && depth == 4 && wantip && ip == "" && match(line, /"[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+"/)) {
    ip = substr(line, RSTART + 1, RLENGTH - 2)
  }
  s = line; gsub(/\\./, "", s); gsub(/"[^"]*"/, "", s)
  o = s; c = s
  depth += gsub(/\{/, "", o) + gsub(/\[/, "", o) - gsub(/\}/, "", c) - gsub(/\]/, "", c)
}
END { flush() }'

# Узел из списка по имени: строка разбора или пусто.
find_peer() {
  printf '%s\n' "$peers" | awk -F '\t' -v w="$(lower "$1")" '
    { split($2, label, ".") } $1 == w || $2 == w || $3 == w || label[1] == w { print; exit }'
}

# Проверка выхода: «ok|wrong|unknown страна номер источник». От root, значит через выбранный exit node.
probe() {
  for svc in ipinfo ipwho; do
    case $svc in
      ipinfo) body=$(wget -q -T 5 -O - https://ipinfo.io/json 2>/dev/null) || continue
        c=$(printf '%s\n' "$body" | sed -n 's/.*"country"[[:space:]]*:[[:space:]]*"\([A-Za-z][A-Za-z]\)".*/\1/p' | head -n 1)
        a=$(printf '%s\n' "$body" | sed -n 's/.*"org"[[:space:]]*:[[:space:]]*"AS\([0-9][0-9]*\).*/\1/p' | head -n 1) ;;
      ipwho) body=$(wget -q -T 5 -O - https://ipwho.is/ 2>/dev/null) || continue
        c=$(printf '%s\n' "$body" | sed -n 's/.*"country_code"[[:space:]]*:[[:space:]]*"\([A-Za-z][A-Za-z]\)".*/\1/p' | head -n 1)
        a=$(printf '%s\n' "$body" | sed -n 's/.*"asn"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' | head -n 1) ;;
    esac
    [ -n "$c" ] || continue
    c=$(printf '%s' "$c" | tr 'a-z' 'A-Z')
    if [ -n "$COUNTRY" ] && [ "$c" != "$COUNTRY" ]; then echo "wrong $c ${a:--} $svc"; return; fi
    if [ -n "$ASNS" ]; then
      [ -n "$a" ] || continue
      case ",$ASNS," in *",$a,"*) ;; *) echo "wrong $c $a $svc"; return ;; esac
    fi
    echo "ok $c ${a:--} $svc"; return
  done
  echo "unknown - - -"
}

# Перейти на узел номер $1 (и проверить, если проверка задана). 0 — годен.
try_node() {
  j=$1; ip=$(get "ip.$j"); name=$(get "name.$j")
  probing && gate_close
  if [ "$(get current)" != "$ip" ]; then
    tailscale set --exit-node="$ip" --exit-node-allow-lan-access=true || { log "tailscale set на $name не удался"; return 1; }
    put current "$ip"
    log "exit node: $name ($ip)"
    [ "$SETTLE" = 0 ] || sleep "$SETTLE"
  fi
  probing || return 0
  check_current "$j"
}

# Проверить выход через текущий узел $1: годен — ворота открыть, нет — забраковать узел.
check_current() {
  j=$1; set -- $(probe); verdict=$1
  put "probe.$j" "$verdict $2 $3 $4"
  if [ "$verdict" = ok ]; then gate_open; return 0; fi
  gate_close
  put "bad.$j" $(($(get tick 0) + PROBE_EVERY))
  log "выход через $(get "name.$j"): $verdict (страна $2, AS $3, $4), ждём $COUNTRY ${ASNS:+AS $ASNS}; узел пропускается $PROBE_EVERY шагов"
  return 1
}

tick() {
  mkdir -p "$STATE"
  status=$(tailscale status --json 2>/dev/null) || { log "tailscale status не отвечает"; return 0; }
  case $status in *'"BackendState": "Running"'*) ;; *) return 0 ;; esac
  peers=$(printf '%s\n' "$status" | awk "$PARSE")
  t=$(($(get tick 0) + 1)); put tick "$t"
  sel=$(printf '%s\n' "$peers" | awk -F '\t' '$6 == "true" { print $1; exit }')
  put current "$sel"

  n=0; cur=0
  for name in $(printf '%s' "$NODES" | tr ',' ' '); do
    n=$((n + 1)); put "name.$n" "$name"
    row=$(find_peer "$name")
    ip=$(printf '%s' "$row" | cut -f 1); online=$(printf '%s' "$row" | cut -f 4); opt=$(printf '%s' "$row" | cut -f 5)
    if [ -z "$row" ] || [ "$opt" != true ]; then
      [ "$(get "miss.$n")" = 1 ] || log "$name: ${row:+не предлагает себя как exit node (одобрить в админке)}${row:-нет такого узла в tailnet}"
      put "miss.$n" 1; online=false
    else put "miss.$n" 0
    fi
    put "ip.$n" "$ip"
    if [ "$online" = true ]; then put "on.$n" $(($(get "on.$n" 0) + 1)); put "off.$n" 0
    else put "off.$n" $(($(get "off.$n" 0) + 1)); put "on.$n" 0
    fi
    [ -n "$ip" ] && [ "$ip" = "$sel" ] && cur=$n
  done
  echo "$n" > "$STATE/count"
  usable() { [ "$(get "on.$1" 0)" -gt 0 ] && [ "$(get "bad.$1" 0)" -le "$t" ]; }

  if [ "$cur" -gt 0 ] && [ "$(get "off.$cur" 0)" -lt "$DOWN_AFTER" ]; then
    # Текущий узел годится. Вернуться выше по списку, если тот стабильно в сети.
    j=1
    while [ "$j" -lt "$cur" ]; do
      if usable "$j" && [ "$(get "on.$j" 0)" -ge "$RETURN_AFTER" ]; then
        try_node "$j" && return 0
      fi
      j=$((j + 1))
    done
    if [ "$(get current)" = "$(get "ip.$cur")" ]; then
      probing || return 0
      if [ "$(get gate)" != closed ] && [ $((t % PROBE_EVERY)) -ne 0 ]; then return 0; fi
      check_current "$cur" && return 0
    fi
  fi

  j=1
  while [ "$j" -le "$n" ]; do
    if usable "$j"; then try_node "$j" && return 0; fi
    j=$((j + 1))
  done
  probing && gate_close
  [ "$(get none)" = "$t" ] || log "годного exit node нет (${NODES}): exit node не меняется, браузер без сети"
  put none "$((t + 1))"
  return 0
}

case ${1:-} in
  launch)
    shift
    if [ -n "$NODES" ]; then
      mkdir -p "$STATE"
      rm -f "$STATE"/*
      probing && { gate_close || exit 1; }
      log "порядок: $NODES; проверка: ${COUNTRY:-любая страна} ${ASNS:+AS $ASNS}"
      ( i=0; while :; do tick; i=$((i + 1)); [ "$TICKS" != 0 ] && [ "$i" -ge "$TICKS" ] && break; sleep "$INTERVAL"; done ) &
    fi
    exec "$@" ;;
  loop) i=0; while :; do tick; i=$((i + 1)); [ "$TICKS" != 0 ] && [ "$i" -ge "$TICKS" ] && break; sleep "$INTERVAL"; done ;;
  once) [ -n "$NODES" ] || { log "MEATSUIT_EXIT_NODES не задан"; exit 2; }; tick ;;
  status)
    [ -n "$NODES" ] || { echo "MEATSUIT_EXIT_NODES не задан: exit node задаёт TS_EXTRA_ARGS"; exit 0; }
    n=$(get count 0); j=1
    printf '%-3s %-16s %-16s %-7s %-8s %s\n' '#' name ip online chosen probe
    while [ "$j" -le "$n" ]; do
      ip=$(get "ip.$j"); ch=-; [ -n "$ip" ] && [ "$ip" = "$(get current)" ] && ch=yes
      on=no; [ "$(get "on.$j" 0)" -gt 0 ] && on=yes
      printf '%-3s %-16s %-16s %-7s %-8s %s\n' "$j" "$(get "name.$j")" "${ip:--}" "$on" "$ch" "$(get "probe.$j" -)"
      j=$((j + 1))
    done
    echo "gate: $(get gate "$(probing && echo '?' || echo 'off (проверка не задана)')")" ;;
  *) echo "usage: exit-picker.sh launch <cmd…> | loop | once | status" >&2; exit 2 ;;
esac
