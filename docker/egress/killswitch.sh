#!/bin/sh
# Аварийный выключатель выхода в сеть. Выполняется в контейнере tailscale перед запуском Tailscale.
# Контейнеры Neko и life делят сетевое окружение с этим контейнером (docker-compose.egress.yml), и все
# они работают не от root; root только у tailscaled.
#
# Правила:
#   - loopback и tailscale0 открыты (CDP, туннель, зеркало по tailnet);
#   - ответы на входящие соединения (зеркало, WebRTC на опубликованных портах) уходят как есть;
#   - любое НОВОЕ исходящее соединение не от root через физический интерфейс отклоняется: если туннель
#     упал или exit node недоступен, браузер остаётся без сети, а не выходит с адреса сервера.
#   Исходящее от root (сам tailscaled: вход в tailnet, связь с узлами) не ограничено.
#
# Если ip6tables в образе нет, а IPv6 не отключён, скрипт не стартует (молча оставить IPv6 открытым нельзя).
# Порядок правил и это поведение проверены тестом test/killswitch.test.js на заглушках; настоящих правил там нет.
# Не проверено (только на сервере): что правило не мешает WebRTC и что без туннеля браузер молчит.
set -eu

iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -o tailscale0 -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m owner --uid-owner 0 -j ACCEPT
iptables -A OUTPUT -j REJECT

# То же для IPv6: иначе браузер вышел бы мимо туннеля по IPv6. Если ip6tables в образе нет, выключатель
# соглашается стартовать только при отключённом IPv6 (sysctl net.ipv6.conf.all.disable_ipv6=1 у сервиса tailscale):
# молча оставить IPv6 открытым нельзя.
v6off=0
read -r v6off < "${KILLSWITCH_IPV6_SYSCTL:-/proc/sys/net/ipv6/conf/all/disable_ipv6}" 2>/dev/null || v6off=0
if command -v ip6tables >/dev/null 2>&1; then
  ip6tables -A OUTPUT -o lo -j ACCEPT
  ip6tables -A OUTPUT -o tailscale0 -j ACCEPT
  ip6tables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  ip6tables -A OUTPUT -m owner --uid-owner 0 -j ACCEPT
  ip6tables -A OUTPUT -j REJECT
elif [ "$v6off" = 1 ]; then
  echo "killswitch: ip6tables нет, IPv6 закрыт sysctl: правила только для IPv4" >&2
else
  echo "killswitch: нет ip6tables, и IPv6 не отключён: закрыть выход по IPv6 нечем, отказ стартовать" >&2
  exit 1
fi

exec "$@"
