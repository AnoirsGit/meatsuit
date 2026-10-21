#!/bin/sh
# Поиск секретов и личного в файлах репозитория. Без внешних зависимостей: sh, git, awk, sort.
#
#   sh tools/secret-scan.sh             рабочее дерево: отслеживаемые и новые (не игнорируемые) файлы; так зовёт npm test
#   sh tools/secret-scan.sh --staged    то, что уйдёт в коммит (индекс); так зовёт хук pre-commit (npm run hooks)
#   sh tools/secret-scan.sh --history   все коммиты всех веток: проверка после чистки истории
#
# Находка печатается как «файл:строка: правило». Само значение не печатается никогда, чтобы скан не стал
# утечкой в журнале. Выход: 0 — чисто, 1 — есть находки, 2 — запуск не в git-репозитории.
#
# Личное, что не узнать по виду (город, имена своих машин, свой ASN, адрес дома), держите в файле
# .secret-scan.local в корне репозитория: одно слово или фраза на строку, # — комментарий. Файл в .gitignore,
# в git он не попадает (список личного сам был бы утечкой). Сравнение как есть, без учёта регистра для латиницы;
# для кириллицы регистр зависит от локали, пишите нужные формы.
set -eu

mode=tree
case "${1:-}" in
  '') ;;
  --staged) mode=staged ;;
  --history) mode=history ;;
  -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
  *) echo "secret-scan: неизвестный ключ $1 (есть --staged и --history)" >&2; exit 2 ;;
esac

top=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "secret-scan: не git-репозиторий" >&2; exit 2; }
cd "$top"
G="git -c core.quotePath=false -c grep.lineNumber=false -c color.grep=false"

# Где искать содержимое. В дереве: отслеживаемые файлы (даже если их имя попало в .gitignore) и новые,
# не игнорируемые. `git grep --untracked` сам пропускает отслеживаемые игнорируемые, поэтому два прохода.
grep_in() {
  case $mode in
    tree)
      $G grep -I -n -o "$@"
      git ls-files -z --others --exclude-standard | xargs -0 -r $G grep --no-index -I -n -o "$@" --
      ;;
    staged) $G grep --cached -I -n -o "$@" ;;
    history) git rev-list --all | xargs -r $G grep -I -n -o "$@" ;;
  esac
}
# Какие пути смотреть по имени.
list_paths() {
  case $mode in
    tree) git -c core.quotePath=false ls-files --cached --others --exclude-standard ;;
    staged) git -c core.quotePath=false ls-files --cached ;;
    history) git -c core.quotePath=false rev-list --all --objects | awk 'NF > 1 { sub(/^[^ ]+ /, ""); print }' ;;
  esac
}

# Правила по содержимому: имя, табуляция, регулярное выражение POSIX ERE (без \b, \d: их нет в POSIX).
RULES=$(cat <<'EOF'
private-key	-----BEGIN ([A-Z0-9]+ )*PRIVATE KEY( BLOCK)?-----
telegram-bot-token	(^|[^A-Za-z0-9_])[0-9]{8,10}:[A-Za-z0-9_-]{35}([^A-Za-z0-9_-]|$)
telegram-bot-token	TELEGRAM_BOT_TOKEN["']?[[:space:]]*[=:][[:space:]]*["']?[0-9]+:
aws-key	(^|[^A-Z0-9])(AKIA|ASIA)[0-9A-Z]{16}([^A-Z0-9]|$)
github-token	(gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,})
gitlab-token	glpat-[A-Za-z0-9_-]{20,}
npm-token	npm_[A-Za-z0-9]{36}
llm-api-key	(^|[^A-Za-z0-9_-])sk-(ant-|proj-)?[A-Za-z0-9_-]{20,}
slack-token	xox[abposr]-[A-Za-z0-9-]{10,}
google-api-key	AIza[0-9A-Za-z_-]{35}
stripe-key	(sk|rk)_live_[0-9A-Za-z]{16,}
tailscale-key	tskey-[a-z]+-[A-Za-z0-9]{6,}
jwt	eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}
neko-password	NEKO_[A-Z0-9_]*PASSWORD[[:space:]]*=[[:space:]]*["']?[A-Za-z0-9]
env-secret	^[[:space:]]*(export[[:space:]]+)?[A-Z0-9_]*(PASSWORD|PASSWD|SECRET|TOKEN|AUTHKEY|AUTH_KEY|API_KEY|APIKEY)[A-Z0-9_]*[[:space:]]*=[[:space:]]*["']?[A-Za-z0-9+/_.-]{8,}
tailnet-name	[A-Za-z0-9][A-Za-z0-9-]*\.ts\.net([^A-Za-z0-9-]|$)
tailnet-ip	(^|[^0-9.])100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}([^0-9]|$)
real-asn	(^|[^A-Za-z0-9_+/=-])AS[[:space:]]?[0-9]{1,10}([^A-Za-z0-9_]|$)
real-asn	[Aa][Ss][Nn]["']?[[:space:]]*[:=][[:space:]]*\[?[[:space:]]*[0-9][0-9, ]*
ssh-host	(^|[^A-Za-z0-9_-])ssh[[:space:]]+([^[:space:]]+[[:space:]]+)*[A-Za-z0-9._-]+@[A-Za-z0-9][A-Za-z0-9._-]*
EOF
)

# Отсев допустимого: учебные и частные ASN, служебные адреса tailnet, учебные хосты в ssh.
FILTER='
function real_asn(n) {
  n += 0
  if (n == 0 || n == 23456) return 0                      # зарезервированы
  if (n >= 64496 && n <= 65551) return 0                  # учебные (RFC 5398), частные (RFC 6996), 65535
  if (n >= 4200000000) return 0                           # частные 32-битные и зарезервированные
  return 1
}
function flagged(m,   s, ip, host) {
  if (rule == "real-asn") {
    s = m
    while (match(s, /[0-9]+/)) { if (real_asn(substr(s, RSTART, RLENGTH))) return 1; s = substr(s, RSTART + RLENGTH) }
    return 0
  }
  if (rule == "tailnet-ip") {
    match(m, /100\.[0-9]+\.[0-9]+\.[0-9]+/); ip = substr(m, RSTART, RLENGTH)
    return !(ip == "100.64.0.0" || ip == "100.100.100.100")   # начало диапазона и служебный DNS Tailscale
  }
  if (rule == "ssh-host") {
    host = m; sub(/.*@/, "", host); sub(/[.]+$/, "", host)
    return !(host ~ /^(example(\.(com|org|net))?|host|server|localhost|127\.0\.0\.1|192\.0\.2\.[0-9]+|198\.51\.100\.[0-9]+|203\.0\.113\.[0-9]+)$/)
  }
  return 1
}
{
  # tree/staged: путь:строка:совпадение; history: коммит:путь:строка:совпадение
  rest = $0; pre = ""
  if (hist) { i = index(rest, ":"); pre = substr(rest, 1, 12) ":"; rest = substr(rest, i + 1) }
  i = index(rest, ":"); path = substr(rest, 1, i - 1); rest = substr(rest, i + 1)
  i = index(rest, ":"); ln = substr(rest, 1, i - 1); m = substr(rest, i + 1)
  if (flagged(m)) print pre path ":" ln ": " rule
}'

hist=0; [ "$mode" = history ] && hist=1
out=$(
  printf '%s\n' "$RULES" | while IFS='	' read -r name re; do
    [ -n "$name" ] || continue
    grep_in -E -e "$re" | awk -v rule="$name" -v hist="$hist" "$FILTER" || true
  done

  # Личные слова из .secret-scan.local (файл не отслеживается и сам себя не находит).
  if [ -f .secret-scan.local ]; then
    words=$(grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' .secret-scan.local || true)
    if [ -n "$words" ]; then
      printf '%s\n' "$words" | while IFS= read -r w; do
        grep_in -i -F -e "$w" | awk -v rule="personal (.secret-scan.local)" -v hist="$hist" "$FILTER" || true
      done
    fi
  fi

  # По имени файла: окружение с паролями, личные конфиги (решение 4), записки агентов, архивы, ключи.
  list_paths | awk '
    { p = $0; low = tolower(p) }
    p ~ /(^|\/)\.env(\.[^\/]*)?$/ && p !~ /\.example$/                                   { print p ": env-file"; next }
    (p ~ /(^|\/)(sites|life|jobs|clients|egress)\.json$/ || p ~ /(^|\/)profiles\/[^\/]*\.json$/) && p !~ /\.example\.json$/ { print p ": personal-config"; next }
    p ~ /(^|\/)\.handoff[^\/]*\//                                                        { print p ": handoff-notes"; next }
    low ~ /\.(tgz|tar|gz|zip|7z|rar|bz2|xz)$/                                            { print p ": archive"; next }
    low ~ /\.(pem|key|p12|pfx|jks)$/ || p ~ /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/          { print p ": key-file"; next }
  '
)

if [ -n "$out" ]; then
  printf '%s\n' "$out" | sort -u | sed 's/^/secret-scan: /'
  n=$(printf '%s\n' "$out" | sort -u | wc -l | tr -d ' ')
  echo "secret-scan: находок $n (значения не печатаются). Уберите их из файлов; личное держите вне git." >&2
  exit 1
fi
echo "secret-scan: чисто ($mode)"
