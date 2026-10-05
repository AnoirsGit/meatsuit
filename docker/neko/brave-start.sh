#!/bin/sh
# Запуск Brave под supervisord внутри Neko (вызывается из brave.conf).
#
# Что отличается от родного brave.conf образа Neko 3.1.x:
#   + --remote-debugging-port=9222   порт CDP для life.js и будущего server.js. Chromium слушает
#                                    только 127.0.0.1 контейнера, поэтому остальным контейнерам стека
#                                    дана та же сеть (network_mode), а не имя "neko:9222".
#   - --bwsi                         это гостевой режим: профиль стирался бы при закрытии браузера,
#                                    куки и входы не жили бы. Без него профиль обычный и постоянный.
#   + --password-store=basic         куки шифруются ключом, не зависящим от связки ключей: после
#                                    пересоздания контейнера расшифровываются так же.
#   + --lang=en-US                   язык интерфейса. Accept-Language (en-US, ru) задаётся ниже в
#                                    настройках профиля: флаг --accept-lang и политика ForcedLanguages
#                                    в этом Brave на Linux не сработали (проверено).
#   - --force-dark-mode, --disable-file-system, --disable-dev-shm-usage
#                                    убраны: первые два видны страницам и отличают браузер от обычного;
#                                    третий не нужен при shm_size 2g.
#   Остальное как в образе: --no-sandbox (контейнер, пользователь не root), --disable-gpu и
#   --disable-software-rasterizer (в контейнере без видеокарты).
set -eu

PROFILE=/home/neko/.config/brave

# Замок профиля Chromium помнит имя хоста контейнера, который его поставил. После
# `docker compose down && up` имя другое, и Brave встречает окном «профиль занят другим
# компьютером». Браузер в профиле один, так что замок можно снять.
rm -f "$PROFILE/SingletonLock" "$PROFILE/SingletonCookie" "$PROFILE/SingletonSocket"

# Языки сайтов: en-US, затем ru (navigator.languages и заголовок Accept-Language).
# Пишем в настройки профиля до запуска браузера. Если пользователь поменял язык в настройках
# Brave, при следующем запуске вернётся этот; чтобы не возвращало, уберите этот блок.
python3 - "$PROFILE/Default/Preferences" <<'PY'
import json, os, sys
path, want = sys.argv[1], "en-US,ru"
try:
    with open(path) as f:
        prefs = json.load(f)
except (OSError, ValueError):
    prefs = {}
changed = False
intl = prefs.setdefault("intl", {})
if intl.get("accept_languages") != want:
    intl["accept_languages"] = want
    changed = True
# Прошлый запуск мог оборваться (docker stop убивает по таймауту, питание): без этого Brave показывает
# «Brave quit unexpectedly», просит отправлять отчёты и предлагает восстановить вкладки.
profile = prefs.setdefault("profile", {})
if profile.get("exit_type") != "Normal" or profile.get("exited_cleanly") is not True:
    profile["exit_type"], profile["exited_cleanly"] = "Normal", True
    changed = True
# Cookie живут между запусками. В профиле образа бывает «очищать при закрытии» (значение 4): тогда каждый
# вход, сделанный в зеркале, пропадает при остановке контейнера. Проверено: с 4 cookie стираются.
cookies = profile.setdefault("default_content_setting_values", {})
if cookies.get("cookies") != 1:
    cookies["cookies"] = 1
    changed = True
if changed:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".tmp", "w") as f:
        json.dump(prefs, f, separators=(",", ":"))
    os.replace(path + ".tmp", path)
PY

# Дополнительные флаги: BRAVE_EXTRA_FLAGS в docker/.env (без пробелов внутри значений).
# Запускаем настоящий бинарник, а не /usr/bin/brave-browser: тот bash-обёртка, она стартует Brave дочерним
# процессом без exec, и сигнал остановки (SIGINT от supervisord) до браузера не доходит. Проверено: через
# обёртку остановка занимала 18 с (ожидание и kill), а свежие cookie и входы терялись: Brave не успевал
# сбросить их на диск. Переменные ниже обёртка выставляла сама.
export CHROME_WRAPPER=/opt/brave.com/brave/brave-browser
export CHROME_VERSION_EXTRA=stable
export GNOME_DISABLE_CRASH_DIALOG=SET_BY_GOOGLE_CHROME
mkdir -p "$HOME/.local/share/applications"
[ -f "$HOME/.local/share/applications/mimeapps.list" ] || touch "$HOME/.local/share/applications/mimeapps.list"

# Окно во весь экран Neko: размер берётся из NEKO_DESKTOP_SCREEN (формат 1280x720@30).
SCREEN="${NEKO_DESKTOP_SCREEN:-1280x720@30}"; SIZE="${SCREEN%%@*}"
WINDOW_SIZE="${SIZE%x*},${SIZE#*x}"

# shellcheck disable=SC2086
exec /opt/brave.com/brave/brave \
  --no-sandbox \
  --window-position=0,0 \
  --display="$DISPLAY" \
  --user-data-dir="$PROFILE" \
  --no-first-run \
  --start-maximized \
  --window-size="$WINDOW_SIZE" \
  --remote-debugging-port=9222 \
  --password-store=basic \
  --lang=en-US \
  --disable-gpu \
  --disable-software-rasterizer \
  ${BRAVE_EXTRA_FLAGS:-}
