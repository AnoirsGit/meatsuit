# meatsuit

**meatsuit is just this: launch a browser, remember, and then eyes and hands. Every credential is handed over by whoever calls it.**

[Русская версия](README.ru.md) · [Documentation](docs/README.md) · [What's next](docs/ROADMAP.md) · [Contributing](CONTRIBUTING.md)

Nothing more. meatsuit starts one browser, keeps its profile so a session signed in once stays signed in, and lets your code look at a page (eyes) and act on it like a person (hands). It has no accounts, no tasks and no schedule of its own: the caller brings the passwords, tokens, limits and the decision what to do. In practice that is two pieces:

1. **A Node library** (`connect` / `task` / `see` / `act`). Your project connects to a running browser over CDP, takes it for one short task at a time, reads the page as a numbered list of elements and acts on it with human-paced mouse and keyboard. A captcha, a login page or a block stops the task with `NeedsHuman` and leaves the window to a person.
2. **A browser mirror** in Docker ([Neko](https://github.com/m1k1o/neko)): one persistent browser, Google Chrome by default or Brave, that a person opens from an ordinary web page. The profile lives in a volume, so you sign in once by hand and every caller uses that session.

Credentials always come from the caller. The library reads no environment variables and sends nothing anywhere by itself: site limits (`sitesFile`), the state directory (`dir`) and notifications (`notify`) are arguments of `connect()`. meatsuit never stores site passwords, model keys or bot tokens.

```
  your project (Node)                          you (laptop, phone)
  connect({ cdpUrl, sitesFile, notify })               │ web mirror (WebRTC)
  task(site, ({ see, act }) => …)                      ▼
          │ CDP                      ┌──── Docker: container meatsuit-browser ────┐
          └────────────────────────► │ Neko + Google Chrome (or Brave), CDP 9222   │
                                     │ profile in the volume meatsuit_profile      │
                                     └─────────────────────────────────────────────┘
```

## Quick start

Requirements: Node 20+; for the mirror, Docker with Compose 2.24 or newer.

**The mirror.**

```sh
npm ci
npm run init        # the deploy file docker/.env: mode 0600, random mirror passwords; a second run changes nothing
npm run config      # optional: a temporary page on 127.0.0.1 to review and edit that file (prints a one-time link)
docker/up.sh        # docker compose --env-file <deploy file> up -d
docker/verify.sh    # drives the mirror and checks over CDP that the browser really did it
```

Open `http://127.0.0.1:8080`, enter any name and the member password from the deploy file (`grep NEKO_PASSWORD docker/.env`). Sign in to your sites there, once.

**The library**, from your own project. It is not published to npm: add it from a checkout (`npm install ../meatsuit`, which writes a `file:` dependency). The CDP port is reachable only inside the mirror's network, so run your code in a container with `network_mode: "container:meatsuit-browser"` (to just try it, start a local Chromium with `--remote-debugging-port=9222`):

```js
const { connect } = require('meatsuit');   // CommonJS: run the lines below inside an async function

const ms = await connect({
  cdpUrl: 'http://127.0.0.1:9222',
  sitesFile: './sites.json',      // your own limits per site; start from sites.example.json
  dir: '/meatsuit/state',         // queue lock and counters: one dir for every caller (state/ in the meatsuit_profile volume)
  notify: async (text) => { /* your Telegram, mail…: the token stays with you */ },
});
const title = await ms.task('read-title', async ({ see, act }) => {
  await act({ cmd: 'goto', url: 'https://example.com/' });
  return (await see()).title;
}, { site: 'example.com', dryRun: true });   // the first run on a real site: dryRun
await ms.close();
```

`goto` takes `https` addresses on the task's `site` only. The limits in `sites.example.json` let `example.com` run only from 10 to 23 o'clock in the process's time zone (other sites 9 to 21): outside those hours the task throws `LimitReached` before it touches the browser. `peek(site, { sitesFile, dir })` tells how much of a site's limits is left without spending a slot. The full API — `see()` snapshots, the closed command set, `sites.json`, errors, the journal and recordings — is in [docs/contract.md](docs/contract.md).

## Configuration

meatsuit has two kinds of settings, and they never mix.

**The deploy file** holds what belongs to the mirror server and nothing else: mirror passwords, the address and ports to bind, the browser and its image tag, the profile folder, the time zone, CPU and memory ceilings, and the optional Tailscale exit. It is `docker/.env`, or the file `MEATSUIT_CONFIG` points to (it may live outside the repository). Every variable with its default is in the table in [docker/README.md](docker/README.md#the-deploy-file-and-dockerupsh); the template with comments is [`docker/.env.example`](docker/.env.example).

- `npm run init` creates it from the template with mode 0600 and random hex passwords. If the file exists, it changes nothing (it only lists what is wrong).
- `npm run config` is a temporary process on the host, not in a container and not in the browser's network: a page on `127.0.0.1` with a one-time token in the link, no cookies, an `Origin` check, passwords never sent to the page, atomic writes with mode 0600, `409` if the file changed meanwhile, exit after 15 idle minutes. `npm run config -- --tailnet` serves it on the server's tailnet address instead.
- `docker/up.sh` hands the file to `docker compose --env-file`. Compose reads it only on `up`, so run `docker/up.sh` again after a change.

**The caller's settings** are arguments, not files of meatsuit: `connect({ cdpUrl, sitesFile, dir, notify })` and `task(name, fn, { site, uploadDirs, dryRun, … })`. The library reads no environment variables. The limits file `sites.json` belongs to each caller ([contract.md](docs/contract.md#connect-and-task)).

**The browser.** `MEATSUIT_BROWSER=chrome` (the default) or `brave`. Each browser keeps its own profile volume, `meatsuit_profile` for Chrome and `meatsuit_brave_profile` for Brave, so switching means signing in again. The container is always named `meatsuit-browser`: other stacks attach to it with `network_mode: "container:meatsuit-browser"` and reach CDP at `http://127.0.0.1:9222`. CDP is never published on the host. Callers mount the volume `meatsuit_profile` (external) and keep their shared `dir` in its `state/` folder.

**The exit.** Optionally the browser's traffic leaves through a Tailscale exit node at home (`MEATSUIT_EGRESS=tailscale`), with a kill switch: no tunnel means no network. An ordered list of exit nodes with a fallback and a country and ASN check is `MEATSUIT_EXIT_NODES` ([docs/egress.md](docs/egress.md)).

## Deploy

On a server: Docker with Compose 2.24+, Tailscale on the host, the mirror bound to the server's tailnet address, never to `0.0.0.0`. The steps are in [docker/README.md](docker/README.md#deploying-on-a-server), then the live check in [docs/acceptance.md](docs/acceptance.md) and, optionally, the home exit ([docs/egress.md](docs/egress.md#recommended-setup)). Always start the stack through `docker/up.sh`: a plain `docker compose up` does not know about the Tailscale overlay.

The owner's server runs the `ms-trunk` version (see Status). Switching it to `main` and to the exit-node list is a runbook in Russian: [docs/ru/09-phone-exit-node.md](docs/ru/09-phone-exit-node.md).

## How the repository is laid out

| Path | What it is |
|---|---|
| `index.js` | `connect()` and `task()`: queue, limits, budget, a window per task, supervision, `peek()` |
| `eyes.js`, `dom.js` | `see()`: the page as text and numbered elements, diffs between snapshots |
| `hands.js`, `human.js`, `human/` | `act()`: the closed command set, human-paced mouse, wheel and keyboard |
| `guard.js`, `supervise.js` | captcha, sign-in and block pages turn into `NeedsHuman`; the optional code sign-in path |
| `limits.js`, `window.js`, `capture.js` | per-site limits from the caller's `sites.json`, task windows, an optional screen archive |
| `telegram.js` | a helper a caller may use for `notify`: the token and chat are passed in, never read from the environment |
| `sites.example.json` | an example limits file; the real one belongs to each caller |
| `config.js`, `tools/` | the deploy file (`init.js`, `config-ui.js`), `live-check.js` for the acceptance, `secret-scan.sh` and its hook, `save-tab.js`, `telegram-chats.js` |
| `docker/` | the mirror: Neko with Chrome or Brave, `up.sh`, `verify.sh`, the optional Tailscale exit (`egress/killswitch.sh`, `egress/exit-picker.sh`) |
| `extras/` | maintained services around the core library, with their own copies of hands and limits: the HTTP service, warm-up, egress check, queue, notifications, owner presence, the browser lock and `selfcheck.js` ([docs/README.md](docs/README.md#extras-services-around-the-core)). The core loads nothing from `extras/` (`test/api.test.js` enforces it) |
| `profiles/` | examples for the `extras/` services (`*.example.json`); the real files are git-ignored |
| `test/` | tests of the core, the deploy file, the secret scan, the Docker files and `exit-picker.sh` |

## Status

As of 21 October 2026.

| | |
|---|---|
| **Verified** | The library in real headless Chromium on local pages (`npm test`); the deploy file, `npm run init`, `npm run config`, the secret scan; `docker compose config` for both browsers, with and without Tailscale. On the owner's server since 8 October (the `ms-trunk` version, reported by the owner, not re-checked since): Google Chrome, the profile in `meatsuit_profile`, traffic through a home Tailscale exit node, and with the exit node unset the browser has no network; `docker/verify.sh` and `verify.sh persistence` green; callers attached with `container:meatsuit-browser`, a sign-in made by hand holds |
| **Built, not verified live** | The exit-node list with a fallback and the exit check (`docker/egress/exit-picker.sh`, tested on stand-ins only); code sign-in (`codeLogin`); the stealth changes in `extras/` with Google Chrome (measured with Brave only, [docs/stealth.md](docs/stealth.md)); this compose file with Brave; Enter and shortcuts from a real keyboard in the mirror |
| **Not done** | An always-on exit node: today it is a PC that is not always on, and the helper phone has not arrived; a recorded row of [the acceptance](docs/acceptance.md) on the server; a license |

The git history still contains personal data from earlier work and is going to be rewritten. Open items, by priority: [docs/ROADMAP.md](docs/ROADMAP.md).

meatsuit is for automating **your own** accounts at low volume. It does not solve captchas, does not spoof fingerprints and promises nothing about how sites react. Platforms' terms apply, and you are responsible for following them.

## Troubleshooting

The mirror's symptoms (no deploy file, never healthy, no video, signed out after a restart, "profile in use", nothing starts with Tailscale, the exit gate closed) are in [docker/README.md](docker/README.md#troubleshooting). For the library: `connect` fails before touching the browser when `sitesFile` is missing or both `sitesFile` and `sites` are given; a task that stops with `NeedsHuman` leaves its window open for you in the mirror; errors and their fields are in [contract.md](docs/contract.md#errors).

## Tests

```sh
npm test                                          # core: the secret scan first, then every suite
npm --prefix extras ci && npm run test:extras     # the services in extras/
```

The core tests need a Chromium for `playwright-core`; see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

A license has not been chosen yet, so for now all rights are reserved.
