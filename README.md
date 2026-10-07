# meatsuit

**One warmed-up browser on a server. You live in it; your scripts work in it with human-like hands.**

[Русская версия](README.ru.md) · [Documentation](docs/README.md) · [Contributing](CONTRIBUTING.md)

meatsuit runs a single, persistent, real Brave browser in Docker. You open it through a web mirror (video and sound over WebRTC) and use it like any browser: sign in, browse, watch videos. Your own automation connects to the *same* browser through a small HTTP service and acts with human-like mouse, keyboard and scrolling: slowly, one task at a time, within limits you set, and it stops when a site asks for a captcha instead of trying to beat it.

```
  you (phone, laptop)            your scripts (any language)
          │ web mirror                    │ GET /view, POST /act
          ▼                               ▼
 ┌─────────────────────── server (Docker) ────────────────────────┐
 │  Neko + Brave, persistent profile ◄── CDP ── HTTP service       │
 │                                         queue · limits · guard  │
 │                                         human-like hands        │
 └──────────────────────────────┬──────────────────────────────────┘
                                │ all browser traffic leaves through your exit node
                                ▼
                  your own home connection (residential IP)
```

## Why

Disposable automated browsers, datacenter IP addresses and mechanical input look different from a person using their own browser. meatsuit's bet is not to hide automation behind spoofing but to make it look like what it is: one person's real browser, on their own network, doing a little at a time.

This is a hypothesis, not a guarantee. Nobody publishes what sites actually look at, and this project does not claim its automation is undetectable. See [Status](#status) for what has and has not been checked.

## What you get

- **A mirror of the browser** ([Neko](https://github.com/m1k1o/neko) with Brave in Docker). The profile persists, so you sign in once and stay signed in.
- **An HTTP interface** for your scripts: `GET /view` returns a plain-HTML copy of what is visible, with numbers on the interactive elements; `POST /act` performs one action (click, fill, type, scroll, go to a page) on an element chosen by number, by visible text, or by CSS.
- **Human-like hands.** Mouse paths are slightly curved with Fitts's-law timing, hand tremor, the occasional twitch and overshoot. Typing is key by key with realistic rhythm, adjacent-key typos that get corrected, and real Latin and Cyrillic layouts. Scrolling is wheel notches with reading pauses.
- **Rails.** One task at a time. Per-site limits that behave like a person (gradual ramp-up, rest days, daily jitter, a multi-day pause after a challenge). Captcha, block and login pages are detected and the task stops; the human solves it in the mirror. An egress check refuses to run unless traffic leaves from the expected country and network.
- **Optional warm-up.** A scheduler that, a few days a week, reads ordinary sites like a person would (scrolls, follows a link, closes a cookie banner, searches Wikipedia). It only reads; it never signs in or posts.

## What this is not

- Not an account farm, and not for anyone else's accounts. It is for automating **your own** accounts at low volume.
- Not a captcha solver. On a captcha it stops and asks you.
- Not fingerprint spoofing. The browser is real and does not pretend to be something else.
- Not a promise of safety. Websites have their own rules: Tinder's terms and LinkedIn's help pages (checked) prohibit automation, and neither publishes numeric limits. **You are responsible for what you automate and for the terms you agree to.**

## Status

| | |
|---|---|
| **Built and verified** (unit tests plus real Chromium; the Docker mirror on the author's machine) | the hands, page reading and actions, the HTTP service with queue, limits and tokens, captcha/block detection, the warm-up scheduler and sessions, the Docker mirror (opens, shows a live Brave, keeps the profile across restarts, scrolls from the mirror) |
| **Built, partly verified** (one run on a rented server) | the mirror on a real server: it started and its video was live over the tailnet, checked from a headless Chromium on a laptop. Only the mirror ran there: no exit node, HTTP service or warm-up ([details](docker/README.md#what-was-verified-and-what-was-not)) |
| **Built, not verified** | the Tailscale exit-node setup and the fail-closed rule (the configuration validates, it has not been run; a test container on that server accepted the TUN device and the `iptables` features it needs); the HTTP service as a Docker container (the compose file accepts it, it has not been started); sound; video in a real browser or on a phone over the tailnet; typing Enter from the web client with a real keyboard |
| **Not verified at all** | Brave on real sites; bot-detection test sites; a multi-week warm-up; how any particular site reacts |
| **Author's guesses** | every number in the limits and warm-up defaults (ramp-up length, rest days, jitter, pause after a challenge) is a starting value, not a measured one |

About 400 tests (`npm test`); the ones that need a browser skip themselves when none is available.

## Quick start

Requirements: Node 20+, Docker for the mirror.

```sh
npm install

# 1. Run the tests (browser tests skip unless Patchright and Chromium are available)
npm test

# 2. The browser mirror
npm run init                # docker/.env: random mirror passwords, mode 0600; a second run changes nothing
npm run config              # optional: a page on 127.0.0.1 to review and edit it (prints a one-time link)
cd docker
docker compose up -d
./verify.sh                 # opens a page through the mirror, scrolls it, checks the browser really did
# then open http://127.0.0.1:8080 (any name, NEKO_PASSWORD from docker/.env)

# 3. See what the warm-up would do (no browser needed)
cd ..
cp profiles/life.example.json profiles/life.json   # your own copy, git-ignored
node life.js plan
node life.js now --dry
```

The HTTP service needs a browser that exposes the Chrome DevTools Protocol (CDP). With the Docker mirror, run the service as a container too (`docker compose --profile api up -d`, see [docker/README.md](docker/README.md#http-service); not verified in a container yet). For a quick local try with any Chromium:

```sh
chromium --remote-debugging-port=9222 &

cp profiles/clients.example.json profiles/clients.json   # put your own long random token in it
cp profiles/sites.example.json profiles/sites.json       # limits per site; your copy is git-ignored
# profiles/egress.json: the country and network you expect, from `curl -s https://ipinfo.io/json`
#                       e.g. { "country": "US", "asn": [64496] }
node server.js --cdp http://127.0.0.1:9222

TOKEN=...   # the token you chose
curl -s -H "Authorization: Bearer $TOKEN" -d '{"do":"begin","task":"demo","site":"example.com"}' http://127.0.0.1:8787/act
# -> {"task":"t1"}   then use  -H "X-Task: t1"  on the next calls:
curl -s -H "Authorization: Bearer $TOKEN" -H "X-Task: t1" -d '{"do":"goto","url":"https://example.com/"}' http://127.0.0.1:8787/act
curl -s -H "Authorization: Bearer $TOKEN" -H "X-Task: t1" http://127.0.0.1:8787/view
```

Full reference: [docs/http-api.md](docs/http-api.md). Never expose the service or the mirror to the public internet: bind them to localhost or a private network such as a Tailscale address.

## How the code is laid out

| Path | What it is |
|---|---|
| `human.js`, `human/` | mouse, keyboard and scroll with human timing |
| `view.js`, `driver.js` | the visible-HTML copy and the browser driver (Patchright over CDP) |
| `server.js`, `queue.js`, `limits.js`, `egress.js`, `notify.js` | the HTTP service: tokens, one-at-a-time queue, limits, egress check, Telegram alerts |
| `guard.js` | recognises captcha, block and login pages |
| `life.js`, `life/` | the warm-up scheduler and sessions |
| `docker/` | the mirror: Neko and Brave, the optional warm-up and HTTP services, the optional exit-node setup |
| `profiles/` | example configuration |
| `test/`, `testkit/` | tests and a fake page for unit tests |
| `scripts/capped` | runs a command with a hard memory and CPU cap (handy for browser tests) |

## Documentation

- [How it works](docs/architecture.md): the idea, the parts and the design decisions
- [HTTP API](docs/http-api.md): `GET /view`, `POST /act`, tasks, limits, errors
- [Warm-up](docs/warmup.md): what it does, what it deliberately does not do, configuration
- [Egress](docs/egress.md): why your own IP matters and how to route the browser through it
- [Docker mirror](docker/README.md): running it, what was verified, deploying to a server

Russian working notes are kept in [docs/ru/](docs/ru/).

## Contributing

Bug reports, ideas and careful reviews are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Please never commit secrets, real IP addresses or personal details: this repository is public.

## License

A license has not been chosen yet, so for now all rights are reserved. The maintainer will add a `LICENSE` file.
