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
# Не проверено (только на сервере): что правило не мешает WebRTC и что без туннеля браузер молчит.
set -eu

iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -o tailscale0 -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m owner --uid-owner 0 -j ACCEPT
iptables -A OUTPUT -j REJECT

# То же для IPv6: иначе браузер вышел бы мимо туннеля по IPv6.
if command -v ip6tables >/dev/null 2>&1; then
  ip6tables -A OUTPUT -o lo -j ACCEPT
  ip6tables -A OUTPUT -o tailscale0 -j ACCEPT
  ip6tables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  ip6tables -A OUTPUT -m owner --uid-owner 0 -j ACCEPT
  ip6tables -A OUTPUT -j REJECT
fi

exec "$@"
