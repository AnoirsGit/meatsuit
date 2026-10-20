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

**2. The server.** In the deploy file set `MEATSUIT_EGRESS=tailscale` and `TS_EXTRA_ARGS="--exit-node=<home node> --exit-node-allow-lan-access=true"` (in double quotes; without LAN access the mirror does not open); `TS_AUTHKEY` (a one-time key) is optional, without it the sign-in link is in `docker/up.sh logs tailscale`, then start through `docker/up.sh`, which adds the egress override and profile:

```sh
docker/up.sh     # = docker compose --env-file <deploy file> -f docker-compose.yml -f docker-compose.egress.yml --profile egress up -d
```

The full deploy sequence, including binding the mirror to a private address, is in [docker/README.md](../docker/README.md#deploying-on-a-server). The override needs a Compose version that understands the `!reset` tag (2.24 or newer).

**3. Only for the frozen warm-up and HTTP service: `profiles/egress.json`**, so their check knows what "right" is (see below). With a phone in the list, put only the home ISP's ASN there, not the mobile operator's: an exit over the SIM must count as wrong.

## Fallback order

One exit node is a single point of failure. With `MEATSUIT_EXIT_NODES` in the deploy file the Tailscale container picks the exit node itself, from an ordered list of names:

```sh
MEATSUIT_EXIT_NODES=home-phone,anoir-pc     # first = preferred; names as in the admin console, no spaces
MEATSUIT_EXIT_COUNTRY=KZ                    # optional: the right exit, from https://ipinfo.io/json at home
MEATSUIT_EXIT_ASN=64500                     # optional: your home ISP's number(s), comma separated, without "AS"
TS_EXTRA_ARGS="--exit-node=<100.x of anoir-pc> --exit-node-allow-lan-access=true"   # still needed at boot, see below
```

`docker/egress/exit-picker.sh` runs next to `containerboot` and every 30 seconds reads `tailscale status --json`:

- A name matches a peer by the first label of its MagicDNS name, the full name, its `HostName` or its `100.x` address, case-insensitively. A peer that does not offer itself as an exit node (not approved in the console) is skipped with one log line.
- It uses the first listed node that is online. It leaves the current node after 2 checks offline (`MEATSUIT_EXIT_DOWN_AFTER`) and goes back up the list once the preferred node has been online for 4 checks (`MEATSUIT_EXIT_RETURN_AFTER`), so a phone that flickers in and out of sleep does not make the browser switch every half minute. It sets the node by its `100.x` address with `--exit-node-allow-lan-access=true`.
- **It never unsets the exit node.** If nothing on the list is online it leaves the setting alone; the browser then has no network, as before.
- `TS_EXTRA_ARGS` stays: `containerboot` applies it at start, and `tailscale up` refuses `--exit-node-allow-lan-access` without `--exit-node`. Tailscale 1.102 also refuses a name there while it is starting up ("cannot resolve exit node by hostname while Tailscale is starting up"), which is why the deploy file has the address. The picker overrides it within a minute.
- Without `MEATSUIT_EXIT_NODES` the script only starts `containerboot`: the setup is exactly the single-node one above.

**The exit check in the container.** With `MEATSUIT_EXIT_COUNTRY` and/or `MEATSUIT_EXIT_ASN` set, the picker also checks where traffic really leaves: after every switch and every 10th check (about every 5 minutes, `MEATSUIT_EXIT_PROBE_EVERY`) it asks `ipinfo.io` (fallback `ipwho.is`) through the tunnel, as root, with the image's `wget`. Same rules as [the egress check](#the-egress-check): a different country or ASN is wrong, no answer (or no ASN when one is required) is unknown, and both fail. A failed node is skipped for the next 10 checks and the next one on the list is tried. This is what catches the phone falling back to its SIM: the home Wi-Fi drops, Android carries on over mobile data, and the exit is suddenly the mobile operator's ASN in the same country.

**The gate.** The kill switch lets anything into `tailscale0`, whatever exit node is behind it. So while the exit is not verified, the picker inserts one rule in front of the kill switch: new non-root connections into the tunnel to anything outside the tailnet (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`) are rejected. The mirror and replies still work, sites do not. The gate is closed before `containerboot` starts and opens after the first good check, so the browser (which waits for the Tailscale container to be healthy) never starts on an unverified exit. If no node passes, the gate stays closed and the container's healthcheck fails (`/tmp/exit-picker/gate` says `closed`). Without the check settings there is no gate at all.

What it does not do: catch a change of address inside the right ASN, or check DNS (DNS bypasses the tunnel anyway, see below). The echo services are reached with busybox `wget`; whether it verifies TLS certificates in this image was not checked, so treat the check as a guard against mistakes, not against an attacker.

Status and logs:

```sh
docker/up.sh exec tailscale sh /exit-picker.sh status   # the list: address, online, chosen, last check; and the gate
docker/up.sh logs --tail 50 tailscale | grep exit-picker
```

## A phone as the exit node

The always-on home device can be a cheap Android phone on its charger and the home Wi-Fi: the Tailscale app has "Run as exit node". The setup steps for the owner are in Russian in [ru/09-phone-exit-node.md](ru/09-phone-exit-node.md). What is different from a Linux box (from Android and vendor documentation and common reports, **not measured on the phone**):

- **Background killers.** Android and especially vendor skins (OPPO ColorOS, Samsung One UI) stop background apps to save battery. A stopped Tailscale is a dead exit. Battery usage "Unrestricted", auto-launch allowed, the app locked in recents, and Tailscale as the **Always-on VPN** (Android restarts it after a reboot or a kill) are all needed; the runbook lists where each switch is.
- **Wi-Fi in sleep and the SIM.** With the screen off Android may drop or throttle Wi-Fi, and "switch to mobile data when Wi-Fi is poor" features move traffic to the SIM. Turn mobile data off on that phone (SMS still work), and set the expected ASN so the check above catches it if it happens anyway.
- **Speed.** An Android exit node forwards traffic in the app's userspace network stack on a slow CPU (Helio G35 class). Expect less than a PC gives; measure with step 4 of [Verify](#verify) before relying on it for video.
- **IPv6.** Not used: the container switches IPv6 off, so the browser leaves over IPv4 whatever the home network offers.
- **MTU.** Tailscale's interface MTU is 1280, over Wi-Fi to the router. Nothing to set; if large pages stall while small ones load, suspect path MTU first (not observed, a known class of problem with tunnels).
- **Key expiry.** Disable it for the phone in the admin console, or the exit disappears after the key's lifetime.

## Fail closed

The rule: **no tunnel means no network.** If the tunnel or the exit node is down, the browser must not quietly leave from the server's own address.

`docker/egress/killswitch.sh` enforces it. It runs in the Tailscale container before Tailscale starts and installs `iptables` rules on outgoing traffic, for IPv4 and IPv6 (the Tailscale container also switches IPv6 off with `sysctl`, and the script refuses to start if `ip6tables` is missing and IPv6 is not switched off; the rule order and this refusal are tested on stand-in commands; the real rules ran on the owner's server, see [What is verified](#what-is-verified-and-what-is-not)): loopback and the tunnel interface are allowed, replies on established connections are allowed, anything run by root (that is `tailscaled`, which must reach the internet to build the tunnel) is allowed, and everything else is rejected. Neko, warm-up and the HTTP service run as non-root users in the same namespace, so they have no route out except the tunnel. The catch: any process running as root in that namespace would bypass it.

On the owner's server (8 October 2026) the browser stayed silent with the exit node unset, and the mirror (its own WebRTC to you over the tailnet) works in this namespace. Not verified: that WebRTC from pages to sites goes through the tunnel.

**DNS does not go through the tunnel.** Docker resolves names for the container and sends the queries to the servers in compose `dns:` (`1.1.1.1`, `9.9.9.9` by default, `KILLSWITCH_DNS_BYPASS` in `killswitch.sh`); with the exit node set these queries went into a tunnel that needs DNS to come up, and after a restart Tailscale never signed in. So port 53 to those servers is routed through the server's own interface. Sites see only the home address, but resolvers see the server's, and a CDN may pick its servers for the server's region. Page traffic itself still has no route out except the tunnel.

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
3. Stop the exit node (or disable it in the console) and confirm that the browser has no network and does not fall back to the server. Run once on the owner's server on 8 October 2026 (see [What is verified](#what-is-verified-and-what-is-not)).
4. With the fallback list: `docker/up.sh exec tailscale sh /exit-picker.sh status` shows the chosen node and `gate: open`. Then the failover drill: switch the phone's Wi-Fi off; within a few minutes (Tailscale has to mark the phone offline, then two checks) the logs show `exit node: anoir-pc`, and `https://ipinfo.io` in the mirror still shows home. Switch Wi-Fi back on; about two minutes after the phone shows online it is back on the phone. Not run yet: the phone has not arrived.
5. Measure the path. In the Tailscale container run `tailscale ping -c 10 --until-direct <home-node>`: you want a direct path, not "via DERP" (Tailscale's relay). Then measure speed from inside the browser's network, where traffic really goes through the tunnel, for example `docker/up.sh exec neko curl -s -o /dev/null -w 'down %{speed_download} B/s\n' 'https://speed.cloudflare.com/__down?bytes=50000000'` (the image has curl). Pages and video travel home to server, so your home upload speed is the cap. About 5 to 8 Mbit/s for watching video in the browser is the author's estimate, not a measurement. None of this was run in the egress setup.

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
- **Running on a server since 8 October 2026:** the egress profile with the mirror (Chrome): Tailscale in the container, the browser in its network namespace, traffic through the home exit node, the container's DNS bypassing the exit node so Tailscale can sign in after a restart.
- **Verified on the owner's server, 8 October 2026:** step 3 of [Verify](#verify). With the exit node unset (`tailscale set --exit-node=`) the browser's user (uid 1000) could not connect anywhere (`curl: (7) Could not connect`); with the exit node set back, traffic left from the home address again.
- **Fallback order:** `exit-picker.sh` is tested on stand-in `tailscale`, `wget` and `iptables` (`test/exit-picker.test.js`), ran once under the image's busybox `sh` and `awk` with stand-ins, and the gate rule was accepted by the image's real `iptables` and `ip6tables` in a throwaway container without network. Not run against a real tailnet: the status format of real peers comes from Tailscale's documented JSON, not from a capture, and nothing ran with a phone.
- **Not verified:** WebRTC through the tunnel measured; warm-up and the HTTP service in that namespace; `begin` returning `503` with a real exit node; the SSH rollback script on a server.

