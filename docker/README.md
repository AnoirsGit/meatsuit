# Browser mirror: Neko + Google Chrome or Brave

One long-lived browser in Docker. A person opens it from an ordinary browser (picture and sound over WebRTC), signs in to sites there once, and solves whatever a bot stops on. Callers' code attaches to the same browser over CDP with the meatsuit library.

Terms: **Neko** is a self-hosted virtual browser that streams a desktop to a web page. **WebRTC** is the browser technology it uses for video and sound. **CDP** (Chrome DevTools Protocol) is the debugging port that automation libraries connect to. For the project as a whole see the [README](../README.md); the library's API is in [04-contract.md](../docs/04-contract.md).

meatsuit is personal automation of your own accounts at low volume. Platforms' terms apply, and you are responsible for them. A captcha is never solved by the software: you solve it yourself in the mirror.

## Quick start

```sh
npm run init          # from the repository root: the deploy file docker/.env, random passwords, mode 0600
docker/up.sh          # docker compose --env-file <deploy file> up -d
docker/verify.sh      # opens an article through the mirror, scrolls, and confirms over CDP
```

Open `http://127.0.0.1:8080`, enter any name and `NEKO_PASSWORD`. Control is taken implicitly: hover over the video and you are in control. The admin password is only needed for taking screenshots through Neko's API.

`docker/up.sh` takes any Compose command with the same deploy file: `docker/up.sh ps`, `docker/up.sh logs -f neko`, `docker/up.sh stop` (the browser exits cleanly and writes its cookies to disk), `docker/up.sh down`. `docker/up.sh down -v` deletes the profile volume too: every sign-in is lost.

## The deploy file and `docker/up.sh`

The settings of the mirror live in one git-ignored file: `docker/.env`, or the file `MEATSUIT_CONFIG` points to (the owner keeps it outside the repository). `npm run init` creates it once from [`.env.example`](.env.example); `npm run config` edits it through a temporary page on `127.0.0.1` (a host process, not in a container and not in the browser's network, so the mirrored browser cannot reach it; a one-time token in a header, no cookies, an `Origin` check, passwords never sent to the page, atomic writes with mode 0600, `409` on a concurrent edit, exit after 15 idle minutes).

`docker/up.sh [compose command…]` runs `docker compose --env-file <file> -f docker-compose.yml …`, with `up -d` by default. With `MEATSUIT_EGRESS=tailscale` in the file it also adds `docker-compose.egress.yml` and the `egress` profile. Always start the stack through `up.sh`: a plain `docker compose up` would not know about the Tailscale overlay. Compose reads the file only on `up`, so run `docker/up.sh` again after a change.

| Variable | Default | Meaning |
|---|---|---|
| `NEKO_PASSWORD`, `NEKO_ADMIN_PASSWORD` | required | Member and admin passwords of the mirror (random hex from `npm run init`) |
| `NEKO_BIND_IP`, `NEKO_PORT` | `127.0.0.1`, `8080` | Host address and port the mirror binds to (the WebRTC UDP ports follow the address). Never `0.0.0.0` |
| `NEKO_WEBRTC_IP` | `127.0.0.1` | The address clients use to reach the video: the same one you open the mirror at |
| `MEATSUIT_BROWSER` | `chrome` | `chrome` (Google Chrome) or `brave`, see below |
| `NEKO_TAG` | `3.1.6` | Neko image tag, the same for both browsers (`ghcr.io/m1k1o/neko/google-chrome` or `…/brave`) |
| `MEATSUIT_PROFILE_DIR` | empty | A host folder for the profile instead of the volume. Absolute path; `profile-init` makes uid 1000 its owner. It belongs to the current browser: change it when you switch |
| `MEATSUIT_TZ` | `UTC` | Time zone (IANA name) of the browser. Set the zone of the country your traffic exits from: a site can compare the two |
| `NEKO_SCREEN` | `1280x720@30` | Resolution and frame rate. Video is encoded on the CPU: go lower on a weak server |
| `NEKO_MEM`, `NEKO_CPUS` | `3g`, `2` | Ceilings for the browser container. `NEKO_CPUS=0` removes the CPU ceiling: some hosts (an OpenVZ container, for example) refuse the CPU quota (`cpu.cfs_quota_us: invalid argument`) |
| `MEATSUIT_API_PORT` | `8787` | Host port of the frozen HTTP service (profile `api`) |
| `MEATSUIT_EGRESS` | empty | `tailscale`: route the browser through a Tailscale exit node (below). Not in `.env.example`'s fields; add it by hand |
| `TS_AUTHKEY`, `TS_EXTRA_ARGS`, `TS_HOSTNAME`, `TS_TAG` | empty, empty, `meatsuit`, `stable` | The Tailscale container (add by hand) |
| `BRAVE_EXTRA_FLAGS` | empty | Extra Brave flags (no spaces inside values) |
| `LIFE_CPUS`, `SERVER_CPUS`, `LIFE_CONFIG`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | | Settings of the frozen `extras/` services (below) |

Values contain no spaces, quotes or `$`: the file is read by Compose and by `sh` (`verify.sh` sources it).

## Choosing the browser

`MEATSUIT_BROWSER` picks one of two small files that `docker-compose.yml` extends: [`browser-chrome.yml`](browser-chrome.yml) or [`browser-brave.yml`](browser-brave.yml). Compose itself reads the variable, so the choice works with `docker/up.sh` and with a plain `docker compose --env-file`.

| | Google Chrome (default) | Brave |
|---|---|---|
| Image | `ghcr.io/m1k1o/neko/google-chrome:${NEKO_TAG}` | `ghcr.io/m1k1o/neko/brave:${NEKO_TAG}` |
| Profile volume | `meatsuit_profile`, mounted at `/home/neko/.config/chrome-meatsuit` | `meatsuit_brave_profile`, at `/home/neko/.config/brave` |
| Start and flags | [`chrome.conf`](chrome.conf) (supervisord) | [`neko/brave.conf`](neko/brave.conf) and [`neko/brave-start.sh`](neko/brave-start.sh) |
| Policies | [`chrome-policies.json`](chrome-policies.json) → `/etc/opt/chrome/policies/managed/` | [`neko/policies.json`](neko/policies.json) → `/etc/brave/policies/managed/` |

Why Chrome is the default: existing sign-ins were made in it. `chrome.conf` and `chrome-policies.json` are carried over unchanged from the setup those sign-ins live in. Chrome's profile folder is not the stock one on purpose: Chrome 136 and newer ignore the CDP port when the browser runs with its default profile folder.

A profile does not move between browsers: switching means signing in again, and the other profile stays in its volume untouched. The Brave volume keeps the name the earlier Brave-only mirror used, so an existing Brave profile is picked up.

`profile-init` is a one-shot container from the same image, without network: it makes uid 1000 (`neko`) the owner of the profile folder's root, creates `state/` in the `meatsuit_profile` volume for the callers (with Brave too) and exits; the browser starts after it. A new volume for Chrome would otherwise belong to root and Chrome could not write to it.

## Attaching another stack

The names below do not change; other projects rely on them.

- Container `meatsuit-browser`. A caller's container joins its network with `network_mode: "container:meatsuit-browser"` and reaches CDP at `http://127.0.0.1:9222`. The mirror must be up first.
- Volume `meatsuit_profile`, created by this stack with whichever browser, its root and its `state/` folder owned by uid 1000 (`profile-init` sees to it). Callers declare it `external: true` and keep their shared state in `state/`: `connect({ dir: '<mount point>/state' })`. With Chrome the same volume holds the browser profile, so mount it read-only wherever nothing needs to be written.
- The CDP port is never published on the host. Whoever reaches CDP controls the browser and every signed-in account.

```yaml
# in the caller's docker-compose.yml
services:
  bot:
    build: .
    user: "1000:1000"                             # writes to state/ (or run as root)
    network_mode: "container:meatsuit-browser"    # CDP: http://127.0.0.1:9222
    volumes:
      - meatsuit_profile:/meatsuit                # connect({ dir: '/meatsuit/state' })
volumes:
  meatsuit_profile:
    external: true
```

All callers of one browser must pass the same `dir` to `connect()`: the queue lock lives there, and with different locks two bots would enter the browser at once. `peek(site, { sitesFile, dir })` from the library reads what is left of a site's limits without spending a slot ([04-contract.md](../docs/04-contract.md)).

The container's host name is fixed too (`meatsuit-browser`): Chromium's profile lock remembers the host name, and after a re-create under a new name the browser would open a "profile in use on another computer" window. With the Tailscale overlay the browser shares the Tailscale container's network and host name instead (Docker allows no own host name there), which is just as stable.

### Moving an existing Chrome profile in

If a Chrome profile already lives in another volume (made with the same `chrome.conf`, mounted at `/home/neko/.config/chrome-meatsuit`), copy it once while both browsers are stopped:

```sh
docker run --rm -v <old volume>:/from:ro -v meatsuit_profile:/to ghcr.io/m1k1o/neko/google-chrome:3.1.6 \
  sh -c 'cp -a /from/. /to/ && chown -R 1000:1000 /to && rm -f /to/SingletonLock /to/SingletonCookie /to/SingletonSocket'
docker/up.sh
```

Then check the sign-ins in the mirror. Keep the old volume until you have. Not verified yet.

## Exit through home: Tailscale (optional)

Without it the browser's traffic leaves from the server's own address. With `MEATSUIT_EGRESS=tailscale`, `docker/up.sh` adds [`docker-compose.egress.yml`](docker-compose.egress.yml) and the `egress` profile: a Tailscale container uses an exit node at home, and the browser (and the frozen services) share its network namespace, so everything they send goes through the tunnel; [`egress/killswitch.sh`](egress/killswitch.sh) rejects any non-root connection that would leave another way.

1. Set up the exit node on the home device ([egress.md](../docs/egress.md#recommended-setup)).
2. In the deploy file add `MEATSUIT_EGRESS=tailscale`, `TS_AUTHKEY` (a one-time key) and `TS_EXTRA_ARGS=--exit-node=<home-node-name> --exit-node-allow-lan-access=false`.
3. `docker/up.sh`. The browser waits until Tailscale is logged in and the exit node is online.
4. Open `https://ipinfo.io` in the mirror: it must show your home connection.

**Do not set the exit node on the host itself over an SSH session on its public address**: the session hangs ([egress.md](../docs/egress.md#ssh-safety-warning)). **Not verified:** the whole egress setup has never been run.

## Deploying on a server

1. Docker with Compose 2.24 or newer on the server, Tailscale on the host; your phone and laptop are in the same tailnet.
2. Clone the repository, `npm ci`, `npm run init` (or `MEATSUIT_CONFIG=<file> npm run init` for a file outside the repository; then keep `MEATSUIT_CONFIG` exported for `docker/up.sh`).
3. **Addresses.** Set `NEKO_BIND_IP` and `NEKO_WEBRTC_IP` to the server's tailnet address (`tailscale ip -4`), for example with `npm run config -- --tailnet` opened from your phone. Never publish the ports to the public internet: binding to the tailnet address is what keeps them private, and Docker's published ports bypass common host firewalls. The mirror runs over plain `http` with the login cookie's `Secure` flag off (`NEKO_SESSION_COOKIE_SECURE=false`), which is only safe because the tailnet encrypts the link.
4. `docker/up.sh`, then the live check in [docs/acceptance.md](../docs/acceptance.md).
5. Optionally, the Tailscale exit (above).

## What `verify.sh` proves

It needs the deploy file and a running stack, and runs every Compose command through `up.sh`. Its checks run inside the image of the frozen warm-up service (`life`), which it builds on first use.

1. **The mirror is up.** It waits up to two minutes for the browser container to be healthy: both Neko's web part and the browser's CDP port answer.
2. **The control channel works.** It logs in with the member password and drives the mirror over Neko's own protocol, the same events the web client sends: take control, Ctrl+L, Ctrl+A, type an article address key by key with a fresh mark of this run (`#verify<time>`), Enter, then the mouse wheel. Then it asks the browser itself over CDP: the tab with this run's mark must be the article, with `scrollY` above 500. Only that tab counts: Chrome restores tabs with their scroll position, so an article tab left from an earlier run (the acceptance runs `verify.sh` twice) would otherwise pass without a single command from the mirror.
3. **Persistence** (`docker/verify.sh persistence`). It sets a cookie over CDP, immediately stops and starts the browser container, and checks the cookie is still there.

It does not prove that a real keyboard in a real web client works, that video and sound arrive, or anything about egress.

## What was verified, and what was not

The runs below were made with **Brave**, before the browser became a choice; this compose file with Chrome or Brave has not been started yet. What is tested now: `docker compose config` for both browsers, with and without the Tailscale overlay, and `docker/up.sh` (`test/docker.test.js`, `test/config.test.js`). `profile-init` was run for real with the Brave image on fresh volumes: `meatsuit_profile` and its `state/` came out owned by 1000:1000.

| What | How | Result |
|---|---|---|
| Neko and Brave start, CDP port alive | healthcheck, `verify.sh` | Healthy within about 15 s; about 750 MB of the 3 GB limit and about 10% CPU at idle (one machine, one run) |
| The mirror shows the live browser | Signed in from a Chromium, screenshots | Video plays, the "You took the controls" note appears |
| Mouse and typing from the web client | Clicked an address-bar suggestion, typed letters and a dot | Worked |
| Enter, Ctrl+A, Ctrl+L from the web client | The author's test client sends synthetic events, and these did not arrive | **Not verified with a real keyboard** |
| Control over Neko's protocol | `verify.sh` | Ctrl+L, Ctrl+A, typing, Enter and wheel worked: the article loaded and scrolled |
| Profile survives a stop and a re-create | Cookie over CDP, `stop`/`start`, `down`/`up` | Kept, including one set a second before the stop |
| The mirror on a rented server (an OpenVZ container, 4 old CPU cores, no GPU), opened from a laptop over Tailscale | Mirror only, bound to the server's loopback and reached through the host's Tailscale; a headless Chromium logged in and sampled one video pixel every second for 45 s | Healthy; the video is live over the tailnet with the default UDP ports; about 3.6% CPU and 310 MB at idle (one run) |
| A throwaway container on that server | `/dev/net/tun`, `iptables -m owner`, `-m conntrack`, `ip6tables` | Accepted, so the kill switch rules can be installed there (Tailscale itself was **not** started) |

Separately, the library ran for one caller project against a Neko mirror with Google Chrome using the same `chrome.conf` and `chrome-policies.json`, started from that project's own compose file.

**Not verified:** this compose file with either browser; `profile-init` with the Chrome image; moving a profile in; Enter and shortcuts from a real keyboard; sound, and video in a real browser or on a phone; the whole Tailscale exit (container, overlay, kill switch, WebRTC and DNS through the tunnel); load while someone uses the mirror on a weak server.

## Brave: six fixes that are not obvious

Without these the Brave profile did not live (all in `neko/brave-start.sh` and the compose file). They cost hours, so they are written down.

1. **Cookies were wiped on every stop.** The image's profile said "clear cookies on exit". `brave-start.sh` forces "keep" before each start, and the `DefaultCookiesSetting` policy says the same.
2. **Brave never received the stop signal.** `/usr/bin/brave-browser` is a wrapper that starts the real binary without `exec`, so SIGINT never reached the browser and recent cookies were lost. The script runs the real binary with `exec`; stopping takes about 1 s. Docker waits up to 30 s (`stop_grace_period`).
3. **The keyboard was silent in the mirror.** `NEKO_SESSION_IMPLICIT_HOSTING=true` makes control implicit (hover and work).
4. **"Brave quit unexpectedly" after every re-create.** The script marks the profile as cleanly closed and removes stale profile locks; crash reporting is off by policy.
5. **The window did not fill the screen.** Its size comes from `NEKO_DESKTOP_SCREEN`.
6. **The first test run froze the machine.** Every container has memory, CPU and process ceilings, and swap is off: a runaway browser is killed by the kernel instead of hanging the host.

Other deliberate differences from the stock Neko Brave: no `--bwsi` (guest mode erases the profile), `--password-store=basic` (cookies decrypt after a re-create), `--lang=en-US` with `Accept-Language` `en-US,ru`, `--force-dark-mode` and `--disable-file-system` removed (pages can see them), `--remote-debugging-port=9222` added.

## What is where

| File | Purpose |
|---|---|
| `docker-compose.yml` | The browser (`neko`, container `meatsuit-browser`), `profile-init` (owner of the profile and of `meatsuit_profile/state`), the frozen `life` (profile `warmup`) and `server` (profile `api`), Tailscale (profile `egress`) |
| `browser-chrome.yml`, `browser-brave.yml` | Per-browser image, profile volume and config files, chosen by `MEATSUIT_BROWSER` |
| `chrome.conf`, `chrome-policies.json` | Google Chrome under Neko: supervisord program and policies |
| `neko/brave.conf`, `neko/brave-start.sh`, `neko/policies.json` | Brave under Neko |
| `docker-compose.egress.yml`, `egress/killswitch.sh` | The optional Tailscale exit and its kill switch |
| `up.sh` | `docker compose` with the deploy file, and the Tailscale overlay when asked |
| `verify.sh`, `verify/` | The checks described above |
| `life/Dockerfile` | The image of the frozen `extras/` services (Node and Patchright; the repository is mounted at `/app`) |
| `.env.example` | The deploy file's template, with comments |

## Frozen services: warm-up and the HTTP service

`extras/` keeps the warm-up scheduler and the HTTP service from an earlier line of the project. They are frozen: they work and are tested, but are not developed. In Compose they are the profiles `warmup` (`life`) and `api` (`server`); both share the browser's network and reach CDP at `127.0.0.1:9222`.

```sh
cp profiles/life.example.json profiles/life.json      # warm-up: your sites and hours, git-ignored
docker/up.sh --profile warmup up -d --build
```

The HTTP service needs `profiles/clients.json`, `profiles/sites.json` and `profiles/egress.json` (all git-ignored, examples next to them). Details: [warmup.md](../docs/warmup.md), [http-api.md](../docs/http-api.md). Without the Tailscale exit, warm-up would leave from the server's address, so it does not start by default.

## Troubleshooting

| Symptom | What to check |
|---|---|
| `up.sh: нет файла деплоя …` | Run `npm run init`, or export `MEATSUIT_CONFIG` with the path of your file |
| Compose stops with "Задайте NEKO_PASSWORD (npm run init)" | Russian for "set NEKO_PASSWORD": the file has no password. `npm run init` on an existing file only lists what is wrong |
| The container never becomes healthy | `docker/up.sh logs neko`. The healthcheck needs Neko's `/health` and the browser's CDP port; it allows 30 s to start |
| `profile-init` failed | `docker/up.sh logs profile-init`. With `MEATSUIT_PROFILE_DIR`, the path must be absolute and on a filesystem that allows `chown` |
| `verify.sh` says the login failed | Use the member password (`NEKO_PASSWORD`), not the admin one |
| Login works over `127.0.0.1` but not over a tailnet address | `NEKO_SESSION_COOKIE_SECURE` must stay `"false"` (the compose file sets it) |
| No video or sound away from `127.0.0.1` | `NEKO_WEBRTC_IP` must be the address you type in the browser, and UDP 59000 to 59019 must reach the host |
| Signed out after a restart | Did you run `down -v`, or switch `MEATSUIT_BROWSER`? Run `docker/verify.sh persistence`. Prefer `docker/up.sh stop` to killing the container |
| "Profile in use on another computer" | The profile came from a container with another host name: stop the browser and remove `SingletonLock`, `SingletonCookie`, `SingletonSocket` from the profile folder |
| Choppy video, high CPU | Lower `NEKO_SCREEN` and `NEKO_CPUS` |
| The container exits with code 137 | A memory ceiling was hit. Raise `NEKO_MEM` if a heavy page needs it |
| With the Tailscale exit nothing starts | The browser waits for `tailscale` to be healthy: it needs a valid `TS_AUTHKEY` and an approved, online exit node. `docker/up.sh logs tailscale` |

Russian version: [README.ru.md](README.ru.md).
