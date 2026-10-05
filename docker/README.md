# Browser mirror: Neko + Brave

One long-lived Brave browser in Docker. You open it from your ordinary browser (picture and sound over WebRTC), live in it and sign in to your accounts there. Your own scripts and the warm-up service attach to the same Brave over CDP.

Terms: **Neko** is a self-hosted virtual browser that streams a desktop to a web page. **WebRTC** is the browser technology it uses for video and sound. **CDP** (Chrome DevTools Protocol) is the debugging port that automation libraries connect to. For the project as a whole see the [README](../README.md); for the warm-up service, [warmup.md](../docs/warmup.md); for sending the browser's traffic out through a home connection, [egress.md](../docs/egress.md). Everything here was checked on one Linux machine with Docker Compose; see [what was verified](#what-was-verified-and-what-was-not).

meatsuit is personal automation of your own accounts at low volume. Platforms' terms apply, and you are responsible for them. A captcha is never solved by the software: you solve it yourself in the mirror.

## Quick start

```sh
cd docker
cp .env.example .env        # set NEKO_PASSWORD and NEKO_ADMIN_PASSWORD (long, different)
docker compose up -d        # the mirror only
./verify.sh                 # opens an article through the mirror, scrolls, and confirms over CDP
```

Open `http://127.0.0.1:8080`, enter any name and `NEKO_PASSWORD`. Control is taken implicitly: hover over the video and you are in control. The admin password is only needed for taking screenshots through Neko's API.

Stop with `docker compose stop` (Brave exits cleanly in 1 to 2 s and writes its cookies to disk). `docker compose down -v` deletes everything, including the browser profile, the warm-up journal and the Tailscale identity.

## What `verify.sh` proves

It needs `docker/.env` and a running stack. It builds the small `life` image on first use, because the checks run inside it.

1. **The mirror is up.** It waits up to two minutes for the container to be healthy, meaning both Neko's web part and Brave's CDP port answer.
2. **The control channel works.** It logs in with the member password and drives the mirror over Neko's own protocol, the same events the web client sends: take control, Ctrl+L, Ctrl+A, type an article address key by key, Enter, then the mouse wheel. It then asks Brave itself over CDP: the tab's address must be the article and `scrollY` must be above 500. So the article really loaded from the internet and was scrolled, independently of any screenshot.
3. **Persistence** (`./verify.sh persistence`). It sets a cookie over CDP, immediately runs `docker compose stop neko` and `start neko`, and checks the same cookie value is still there.

What it does not prove: that a real keyboard in a real web client works (it speaks the protocol directly, not through the web client), that video and sound arrive, and anything about egress. It uses only `docker-compose.yml`; it was not tried with the egress override.

## What was verified, and what was not

| What | How | Result |
|---|---|---|
| Neko and Brave start, CDP port alive | healthcheck, `./verify.sh` | Healthy within about 15 s; about 750 MB of the 3 GB limit and about 10% CPU at idle (one machine, one run) |
| The mirror shows the live Brave | Signed in from a Chromium, screenshots | Video plays, the "You took the controls" note appears |
| Mouse from the web client | Clicked an address-bar suggestion | Worked |
| Typing from the web client | Letters and a dot | Worked |
| Enter, Ctrl+A, Ctrl+L from the web client | The author's test client sends synthetic events, and these did not arrive | **Not verified with a real keyboard** (see below) |
| Control over Neko's protocol (what the web client sends) | `./verify.sh` | Ctrl+L, Ctrl+A, typing, Enter and wheel worked: article loaded, `scrollY` 30570 in one run |
| Profile survives a stop and a re-create | Cookie over CDP, `stop`/`start`, `down`/`up` | Kept, including one set a second before the stop |
| Warm-up container reaches Brave | `docker compose run life node life.js plan`, CDP connection | Works |

**About Enter from the web client.** Neko's protocol accepts these keys and Brave handles them, but the author's test client (headless Chromium sending synthetic events) forwarded only letters, not Enter or Ctrl combinations. A real keyboard in a real browser should work, since it is Neko's standard use, but nobody has tried it. The first thing to do: in the mirror, type an address in the address bar and press Enter. If that fails, please open an issue (suspects: keyboard layout, or the client browser).

**Not verified:**

- Enter and shortcuts from a real keyboard in a web client (above).
- Video and sound over WebRTC at an address other than `127.0.0.1` (for example a tailnet address): this needs `NEKO_WEBRTC_IP` and UDP ports 59000 to 59019.
- The whole `egress` profile: Tailscale in a container; `docker-compose.egress.yml` (valid as configuration, **never run**); the chain `life` to `neko` to `tailscale` in one network; the kill switch (does it hurt WebRTC, does the browser stay silent when the tunnel is down); DNS through the tunnel.
- Speed and load on a weak server. Video is encoded on the CPU, so lower `NEKO_SCREEN` (default `1280x720@30`) and `NEKO_CPUS`.
- Signing in and registering on real sites from the mirror. Sites may ask for SMS or a captcha.
- Brave on real sites and on bot-detector sites, and a full warm-up session in this Brave.

## Six fixes that are not obvious

Without these the profile did not live. They cost hours, so they are written down.

1. **Cookies were wiped on every stop.** The image's profile said "clear cookies on exit" (`cookies: 4`). `brave-start.sh` now forces "keep" (`1`) in the profile before each start, and the `DefaultCookiesSetting` policy says the same. Checked: with `4` the cookies vanish.
2. **Brave never received the stop signal.** `/usr/bin/brave-browser` is a bash wrapper that starts the real `brave` as a child process without `exec`, so supervisord's SIGINT never reached the browser. Stopping took 18 s (wait, then kill), and everything from the last seconds was lost because Brave never flushed its cookies to disk. The script now runs the real binary with `exec` (and sets the environment variables the wrapper used to set); stopping takes about 1 s. Docker waits up to 30 s (`stop_grace_period`) and supervisord up to 15 s.
3. **The keyboard was silent in the mirror.** In Neko 3 you must ask for control with a button by default, and the focus did not reach the input field until you did. `NEKO_SESSION_IMPLICIT_HOSTING=true` makes it implicit (hover and work).
4. **A "Brave quit unexpectedly" window after every re-create.** Before starting, the script marks the profile as cleanly closed, and crash reporting is off by policy (`MetricsReportingEnabled`). It also removes the profile lock files: they remember the previous container's host name and otherwise trigger "profile in use by another computer".
5. **The browser window did not fill the screen.** The window size now comes from `NEKO_DESKTOP_SCREEN`.
6. **The first test run froze the machine.** Every container has a ceiling: `NEKO_MEM` (3 GB) and `NEKO_CPUS` (2) for Neko, 512 MB and half a CPU for warm-up, 256 MB for Tailscale, plus process limits. Swap is off (`memswap_limit` equals `mem_limit`). A runaway browser (a leak, an endless loop on a page) is then killed by the kernel instead of hanging the host. `/dev/shm` is 2 GB because Chromium crashes on heavy pages without enough, and it counts toward the container's memory.

Other deliberate differences from the stock Neko Brave image (all in `neko/brave-start.sh`): no `--bwsi` (guest mode erases the profile on exit); `--password-store=basic` (so cookies decrypt after a re-create); `--lang=en-US` with `Accept-Language` set to `en-US,ru` in the profile (the flag and the `ForcedLanguages` policy did not work in this Brave on Linux); `--force-dark-mode` and `--disable-file-system` removed (pages can see them, and they set the browser apart); `--remote-debugging-port=9222` added. `--no-sandbox` stays, as in the stock image: the container is the boundary and the user is not root. The policies in `neko/policies.json` turn off guest mode, browser sign-in and sync, the password manager and autofill, block notifications, restrict downloads and block `file://`. Signing in to websites works normally.

## What is where

| File | Purpose |
|---|---|
| `docker-compose.yml` | Neko with Brave (`neko`), warm-up (`life`, profile `warmup`), Tailscale (`tailscale`, profile `egress`) |
| `docker-compose.egress.yml` | Laid over the main file: Neko and warm-up in the Tailscale container's network |
| `.env.example` | The main settings with comments; copy to `.env` (not in git). The Tailscale ones (`TS_*`) are not listed; add them by hand |
| `neko/brave-start.sh` | Starts Brave: the real binary, the flags, profile fixes |
| `neko/brave.conf` | Replaces the image's supervisord config so Neko takes the browser flags from the script |
| `neko/policies.json` | Brave policies (see above) |
| `life/Dockerfile` | The warm-up image: Node and Patchright; the repository is mounted at `/app` |
| `egress/killswitch.sh` | Kill switch: non-root processes may leave only through the tunnel ([egress.md](../docs/egress.md#fail-closed)) |
| `verify.sh`, `verify/` | The checks described above |

Settings in `.env` (all optional except the passwords):

| Variable | Default | Meaning |
|---|---|---|
| `NEKO_PASSWORD`, `NEKO_ADMIN_PASSWORD` | required | Member and admin passwords of the mirror |
| `NEKO_BIND_IP`, `NEKO_PORT` | `127.0.0.1`, `8080` | Host address and port the mirror binds to (the WebRTC UDP ports follow the address) |
| `NEKO_WEBRTC_IP` | `127.0.0.1` | The address clients use to reach the video: the same one you open the mirror at |
| `NEKO_SCREEN` | `1280x720@30` | Resolution and frame rate; the browser window takes this size |
| `NEKO_MEM`, `NEKO_CPUS` | `3g`, `2` | Ceilings for the Neko container |
| `BRAVE_EXTRA_FLAGS` | empty | Extra Brave flags (no spaces inside values) |
| `LIFE_CONFIG` | `/app/profiles/life.json` | Warm-up config path inside its container |
| `NEKO_TAG`, `TS_TAG` | `3.1.6`, `stable` | Image tags (not in `.env.example`) |
| `TS_AUTHKEY`, `TS_EXTRA_ARGS`, `TS_HOSTNAME` | empty, empty, `meatsuit` | Tailscale container settings (not in `.env.example`) |

The CDP port (9222) listens only inside the container and is never published. The other containers of the stack share Neko's network (`network_mode: service:neko`). Whoever can reach CDP controls the browser, so do not publish it.

## Warm-up service

It does not start by default (profile `warmup`). Without the home exit it would leave from the server's own address, and the browser's first "history" would come from a datacenter.

```sh
docker compose --profile warmup up -d --build     # start
docker compose --profile warmup logs -f life      # journal
docker compose --profile warmup stop life         # stop
```

Before the first start on a server create `../profiles/egress.json` (`{"country":"DE","asn":[64496]}`: use your own country and ASN, see [egress.md](../docs/egress.md#the-egress-check)). Then every session first checks the exit and is skipped on a mismatch. Without the file `life` does not start (`--no-egress-check` is the explicit opt-out). The config is read at startup, so restart the service after editing `profiles/life.json`. Schedule and options are in [warmup.md](../docs/warmup.md). The journal and state live in the `life_data` volume.

## Deploying on a server

1. Install Docker with Compose on the server, and Tailscale on the host. Your phone and laptop are in the same tailnet.
2. Clone the repository, `cd docker`, `cp .env.example .env`, set the passwords.
3. **Addresses.** In `.env` set `NEKO_BIND_IP` and `NEKO_WEBRTC_IP` to the server's **tailnet address** (`tailscale ip -4`, like `<your-tailnet-ip>`). Never publish the ports to the public internet: binding to the tailnet address is what keeps them private. Do not rely on a host firewall alone, because Docker's published ports bypass common firewall front ends. The mirror runs over plain `http`, with the login cookie's `Secure` flag turned off (`NEKO_SESSION_COOKIE_SECURE=false`, otherwise the browser refuses it over `http`); the tailnet encrypts the link, so this is only safe there. Open `http://<your-tailnet-ip>:8080`.
4. `docker compose up -d`, then `./verify.sh persistence`.
5. **Exit through home** ([egress.md](../docs/egress.md)). Set up the exit node on the home device first. Add `TS_AUTHKEY` and `TS_EXTRA_ARGS=--exit-node=<home-node-name> --exit-node-allow-lan-access=false` to `.env` (`TS_HOSTNAME` and `TS_TAG` are optional), then run `docker compose -f docker-compose.yml -f docker-compose.egress.yml --profile egress up -d`. The override uses the `!reset` tag, which needs Compose 2.24 or newer. **Do not set the exit node on the host itself over an SSH session on its public address**: the session hangs. The rules and a rollback are in egress.md.
6. Check the exit: open `https://ipinfo.io` in the mirror; it must show your home country and ISP. Only then start warm-up and your bots.

The browser's time zone comes from `MEATSUIT_TZ` in `.env` (default `Asia/Almaty`, the author's zone): set it to the zone of your exit country, because a site can compare the browser's zone with the zone of your IP address. The warm-up zone is separate: `tz` in `profiles/life.json`. Run `./verify.sh` before step 5 (it has not been tried with the override).

## Troubleshooting

| Symptom | What to check |
|---|---|
| `docker compose up` stops with "Задайте NEKO_PASSWORD в docker/.env" | That is Russian for "set NEKO_PASSWORD in docker/.env". Fill in both passwords |
| The container never becomes healthy | `docker compose logs neko`. The healthcheck needs Neko's `/health` and Brave's CDP port to answer; it allows 30 s to start |
| `verify.sh` says the login failed | Use the member password (`NEKO_PASSWORD`), not the admin one |
| Login works over `127.0.0.1` but not over a tailnet address | `NEKO_SESSION_COOKIE_SECURE` must stay `"false"` (the compose file sets it) |
| No video or sound away from `127.0.0.1` | `NEKO_WEBRTC_IP` must be the address you type in the browser, and UDP 59000 to 59019 must reach the host. Not verified over a tailnet |
| Keys do nothing | Hover over the video first (implicit control). Then try the Enter test above |
| Signed out after a restart | Did you run `down -v`? Run `./verify.sh persistence`. Prefer `docker compose stop` to killing the container |
| "Brave quit unexpectedly" or "profile in use" appears | `brave-start.sh` clears both at every start; check that it is mounted (`docker compose config`) and read `docker compose logs neko` |
| Choppy video, high CPU | Lower `NEKO_SCREEN` and `NEKO_CPUS` |
| The container exits with code 137 | A memory ceiling was hit or something killed it. Raise `NEKO_MEM` if a heavy page needs it |
| With the egress override nothing starts | Neko waits for `tailscale` to be healthy: it needs a valid `TS_AUTHKEY` and an approved, online exit node. `docker compose logs tailscale` |

Russian original: [README.ru.md](README.ru.md).
