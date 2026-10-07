# Egress: making the browser come from a home IP

> Two parts. Routing the browser through a home exit node is the mirror's optional `egress` profile (`MEATSUIT_EGRESS=tailscale`, [docker/README.md](../docker/README.md#exit-through-home-tailscale-optional)). [The egress check](#the-egress-check) (`egress.js`, used by warm-up and the HTTP service) is **frozen** in `extras/`: it works and is tested, but is not developed, and the library does not use it.

The browser in this project runs on a server, but its traffic should leave from your home internet connection, the same one your phone and laptop use. This page explains why, compares the ways to do it, describes the setup the repository ships, and says what is checked and what is not. Context: [project README](../README.md), [architecture](architecture.md), [http-api.md](http-api.md), [warmup.md](warmup.md). The Docker side is in [docker/README.md](../docker/README.md).

Terms: **egress** is the address websites see when your traffic leaves your network. A **tailnet** is your private Tailscale network. An **exit node** is a device in the tailnet that other devices can use as their way out to the internet. **ASN** is the number of the network operator that owns an address (for example the number of your ISP); lookup services report it.

## Why

- A website sees the address of the real connection. An IP cannot be faked, only routed through.
- A server in a datacenter has an address from a hosting range, which is the most visible sign that traffic does not come from a person at home. This is plausible but **not verified**: the source the project originally relied on ("IP, protocol and behaviour are the main bot signals") is not in the repository.
- Your own residential address is the one most consistent with the rest of your life, since it is the address your other devices already use. That is reasoning, not a measurement. Keep the rest consistent too: the containers' time zone (`TZ`) comes from `MEATSUIT_TZ` in the deploy file (default `UTC`); with Brave, `docker/neko/brave-start.sh` also sets the browser languages to `en-US,ru`. Change them to match where your exit is and how you browse.

## The options

| Option | Address sites see | Upside | Downsides and unknowns |
|---|---|---|---|
| **Home device as Tailscale exit node** (what this repo ships) | Your own home address | Free. Your own residential address. No third party carries the traffic | Needs a device at home that stays on. When home power or internet is down the browser has no network (by design). Your home upload speed caps how fast the browser downloads. If a site flags the address, your own browsing from home suffers too. The address may change, depending on your ISP |
| VPS in your own country | A hosting-range address in that country | Always on, stable, cheap, nothing at home | A datacenter range, which is what you are trying to get away from. How a given site treats it: not verified. Not researched by the author |
| Residential or mobile proxy (paid) | Someone else's residential or mobile address | No hardware at home | Not your address, so not the one your phone uses. Mobile addresses may rotate (not verified). The provider sees all your traffic. Cost. Worth asking where the addresses come from. Not researched by the author |
| Run the whole browser at home | Your own home address | The simplest network path, nothing to tunnel. The same Docker stack runs on any Linux machine with Docker, just without the egress profile | A machine at home has to run the browser all the time. You give up the server |
| Nothing: exit from the server's own address | A datacenter address, probably in another country | Nothing to set up | All your accounts, including your everyday use in the mirror (mail, job sites), appear from a datacenter in another country. How sites react is not verified. Plausible but unconfirmed: a country change plus a datacenter address trigger more sign-in checks. Not recommended |

## Recommended setup

An always-on home device is the exit node. On the server, a Tailscale container uses it as its exit, and the browser stack runs inside that container's network namespace (it shares the container's network instead of having its own).

```
 you ── tailnet ──► server (Docker)
                    ┌─ tailscale container (exit node client) ──► tunnel ──► home device ──► internet
                    ├─ neko: browser, mirror, CDP (shares its network)
                    ├─ life: warm-up              (shares it too)
                    └─ server: HTTP service       (shares it too)
```

Everything the browser sends, including UDP and WebRTC, goes through the tunnel. Mirror traffic to you travels over the tailnet directly rather than through your home (per the design; not verified).

**1. The home device** (Linux, always on, no sleep: a sleeping machine drops the tunnel):

```sh
sudo sysctl -w net.ipv4.ip_forward=1 net.ipv6.conf.all.forwarding=1
# persist across reboots (standard lines, not checked against the docs):
printf 'net.ipv4.ip_forward=1\nnet.ipv6.conf.all.forwarding=1\n' | sudo tee /etc/sysctl.d/99-tailscale.conf
sudo tailscale set --advertise-exit-node
```

Then approve it in the admin console (login.tailscale.com/admin/machines, the node, "Edit route settings", "Use as exit node"). These commands match Tailscale's exit-node documentation. Also consider disabling key expiry for that node in the console (the exact menu name was not checked), or it drops off the tailnet when its key expires.

**2. The server.** In the deploy file set `MEATSUIT_EGRESS=tailscale`, `TS_AUTHKEY` (a one-time key) and `TS_EXTRA_ARGS=--exit-node=<home-node-name> --exit-node-allow-lan-access=false`, then start through `docker/up.sh`, which adds the egress override and profile:

```sh
docker/up.sh     # = docker compose --env-file <deploy file> -f docker-compose.yml -f docker-compose.egress.yml --profile egress up -d
```

The full deploy sequence, including binding the mirror to a private address, is in [docker/README.md](../docker/README.md#deploying-on-a-server). The override needs a Compose version that understands the `!reset` tag (2.24 or newer).

**3. Only for the frozen warm-up and HTTP service: `profiles/egress.json`**, so their check knows what "right" is (see below).

## Fail closed

The rule: **no tunnel means no network.** If the tunnel or the exit node is down, the browser must not quietly leave from the server's own address.

`docker/egress/killswitch.sh` enforces it. It runs in the Tailscale container before Tailscale starts and installs `iptables` rules on outgoing traffic, for IPv4 and IPv6 (the Tailscale container also switches IPv6 off with `sysctl`, and the script refuses to start if `ip6tables` is missing and IPv6 is not switched off; the rule order and this refusal are tested on stand-in commands, the real rules are not): loopback and the tunnel interface are allowed, replies on established connections are allowed, anything run by root (that is `tailscaled`, which must reach the internet to build the tunnel) is allowed, and everything else is rejected. Neko, warm-up and the HTTP service run as non-root users in the same namespace, so they have no route out except the tunnel. The catch: any process running as root in that namespace would bypass it.

Not verified, because the egress profile has never been run: that this rule does not break WebRTC, that the browser really stays silent when the tunnel is down, and that DNS goes through the tunnel (the aim: otherwise CDNs pick servers by the datacenter's resolver).

## The egress check

`egress.json` says what the right exit looks like. These values are placeholders (AS64496 is reserved for documentation); use the country and ASN you see when you open `https://ipinfo.io/json` from home:

```json
{ "country": "DE", "asn": [64496] }
```

How it works (`egress.js`):

- It asks an echo service which address it sees (`ipinfo.io`, with `ipwho.is` as a fallback, 5 s timeout) **from the same network as the browser**, and compares the country and the ASN. It compares the ASN number, not the provider's name, because names differ between databases while the number matches. `asn` may be left out to check the country only.
- Three outcomes: ok, `egress_wrong` (a different country or ASN) and `egress_unknown` (no service answered, or an ASN is required and the service did not give one). Unknown counts as a failure, never as "probably fine".
- It does not notice an address change inside the same ASN (not needed), and it does not test for DNS leaks.
- Where it runs matters. A check run on a different network measures a different address, so run the checking process inside the browser's network. The compose file does that for both checkers: warm-up (`life`) and the HTTP service (`server`, profile `api`) share Neko's network, and with the egress override Neko, warm-up and the HTTP service all share the Tailscale container's.

What happens on a failure:

| Component | Behaviour |
|---|---|
| Warm-up (`life.js`) | Checks before every session, bypassing the cache. On failure the session is skipped, an `egress-wrong` event is journaled, no pause is set. **No `egress.json`: `now` and `run` refuse to start**; `--no-egress-check` is the explicit opt-out (a warning is journaled) |
| HTTP service (`server.js`) | Refuses to start without `egress.json`. Checks at startup, on every `begin` (the call that opens a task, see [http-api.md](http-api.md); cached for 60 s) and every 5 minutes. `begin` answers `503` with `egress_wrong` or `egress_unknown`. A failing periodic check closes the running task and sends a Telegram message if configured |

Callers should treat `503` as "postpone and retry later"; meatsuit does not retry or queue for them. A short outage at home looks like `egress_unknown` and is handled like a mismatch.

## Verify

1. In the mirror open `https://ipinfo.io`. It should show your home country and ISP. Only then start warm-up or bots.
2. Look at the Tailscale container: its healthcheck passes only when it is logged in and the chosen exit node is online.
3. Stop the exit node (or disable it in the console) and confirm that the browser has no network and does not fall back to the server. This is the test nobody has run yet.
4. Measure the path. In the Tailscale container run `tailscale ping -c 10 --until-direct <home-node>`: you want a direct path, not "via DERP" (Tailscale's relay). Then measure speed from inside the browser's network, where traffic really goes through the tunnel, for example `docker/up.sh exec neko curl -s -o /dev/null -w 'down %{speed_download} B/s\n' 'https://speed.cloudflare.com/__down?bytes=50000000'` (the image has curl). Pages and video travel home to server, so your home upload speed is the cap. About 5 to 8 Mbit/s for watching video in the browser is the author's estimate, not a measurement. None of this was run in the egress setup.

## SSH safety warning

**Do not set the exit node on the remote server itself while you are connected over its public address.** All of the host's traffic, including the replies to your own SSH session, would go into the tunnel. The session hangs, and only the hosting provider's console can undo it. The recommended setup avoids this, since the exit node applies only inside the container's network. If you want to test directly on the host, log in over the tailnet address (a more specific route, so it should not be affected; not verified) and arm an automatic rollback first, detached from your session:

```sh
sudo setsid nohup sh -c 'sleep 120; tailscale set --exit-node=' >/dev/null 2>&1 &   # 1. rollback first
sudo tailscale set --exit-node=<home-node-name-or-100.x-address>                      # 2. test within 120 s
curl -s https://ipinfo.io/json
sudo tailscale set --exit-node=                                                       # 3. do not wait for the timer
```

The rollback was not tested on a real server. Check that `tailscale` is in root's `PATH`, and keep the provider's console at hand the first time.

## Risks

- **You and the bot share an address.** Good for consistency. The flip side: if a platform challenges or blocks the address, it hits your normal life from that address too.
- **Everything depends on home.** No power, no internet or a dead device means the bots stop. That is the chosen behaviour ("no network instead of a fallback"), not a bug.
- **Docker on the exit-node device.** Hypothesis, not verified: Docker's default `FORWARD DROP` firewall policy can block forwarding through the node. If `tailscale ping` works but the internet through the node does not, look at `sudo iptables -S FORWARD` first.
- **Short outages.** Home connections drop for seconds now and then. Expect occasional `egress_unknown` and skipped sessions.
- **Your address may change.** Tailscale is meant to survive that (not tested on a real home connection). The check compares the ASN, so it will not complain, but sites will see a new address, as they would at any home.

## What is verified and what is not

- **Verified:** `egress.js` and its use in `life.js` and `server.js`, by unit tests on a fake network (country and ASN match, fallback service, timeouts, caching, fail closed). The exit-node commands against Tailscale's documentation. The egress override as a configuration only (`docker compose config` accepts it). The kill switch relies on the browser not running as root: the Neko image sets `USER=neko` (read from the image metadata) and our supervisord configs start Chrome and Brave with `user=%(ENV_USER)s`, so the owner rule should apply to it; a process listing in a running container has not been checked. On the rented server where the mirror was tried, a throwaway container accepted `/dev/net/tun`, `iptables -m owner`, `-m conntrack` and `ip6tables`, so the kill switch rules can be installed there; Tailscale itself was not started ([docker/README.md](../docker/README.md#what-was-verified-and-what-was-not)).
- **Not verified:** the egress profile has not been run at all: Tailscale inside the container, Neko, warm-up, the HTTP service and Tailscale in one network namespace, the kill switch, WebRTC and DNS through the tunnel. Also not run: `begin` returning `503` with a real exit node, and the SSH rollback script on a server.

