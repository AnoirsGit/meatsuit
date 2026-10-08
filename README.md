# meatsuit

**Launch a browser, remember the session, give your code eyes and hands.**

[Русская версия](README.ru.md) · [Documentation](docs/README.md) · [Contributing](CONTRIBUTING.md)

meatsuit is two things:

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

**The library**, from your own project. The CDP port is reachable only inside the mirror's network, so run your code in a container with `network_mode: "container:meatsuit-browser"` (to just try it, start a local Chromium with `--remote-debugging-port=9222`):

```js
const { connect } = require('meatsuit');

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

`peek(site, { sitesFile, dir })` tells how much of a site's limits is left without spending a slot. The full API — `see()` snapshots, the closed command set, `sites.json`, errors, the journal and recordings — is in [docs/04-contract.md](docs/04-contract.md) (Russian).

## The deploy file

One git-ignored file holds what belongs to the mirror server and nothing else: mirror passwords, the address and ports to bind, the browser and its image tag, the profile folder, the time zone, CPU and memory ceilings. It is `docker/.env`, or the file `MEATSUIT_CONFIG` points to (it may live outside the repository).

- `npm run init` creates it from [`docker/.env.example`](docker/.env.example) with mode 0600 and random hex passwords. If the file exists, it changes nothing.
- `npm run config` is a temporary process on the host, not in a container and not in the browser's network: a page on `127.0.0.1` with a one-time token in the link, no cookies, an `Origin` check, passwords never sent to the page, atomic writes with mode 0600, `409` if the file changed meanwhile, exit after 15 idle minutes.
- `docker/up.sh` hands the file to `docker compose --env-file`. Compose reads it only on `up`, so run `docker/up.sh` again after a change.

Callers' settings are not in this file: limits, upload folders and the state directory are arguments of `connect()` and `task()`.

## Choosing the browser

`MEATSUIT_BROWSER=chrome` (the default) or `brave` in the deploy file. Each browser keeps its own profile volume, `meatsuit_profile` for Chrome and `meatsuit_brave_profile` for Brave, so switching means signing in again. The container is always named `meatsuit-browser`: other stacks attach to it with `network_mode: "container:meatsuit-browser"` and reach CDP at `http://127.0.0.1:9222`. CDP is never published on the host. Callers mount the volume `meatsuit_profile` (external) and keep their shared `dir` in its `state/` folder. Details: [docker/README.md](docker/README.md).

Optional: send the browser's traffic out through a Tailscale exit node (`MEATSUIT_EGRESS=tailscale`, see [docs/egress.md](docs/egress.md)).

## How the repository is laid out

| Path | What it is |
|---|---|
| `index.js` | `connect()` and `task()`: queue, limits, budget, a window per task, supervision |
| `eyes.js`, `dom.js` | `see()`: the page as text and numbered elements, diffs between snapshots |
| `hands.js`, `human.js` | `act()`: the closed command set, human-paced mouse and keyboard |
| `guard.js`, `supervise.js` | captcha, login and block pages turn into `NeedsHuman` |
| `limits.js`, `window.js`, `capture.js` | per-site limits from the caller's `sites.json`, task windows, an optional screen archive |
| `telegram.js` | a helper a caller may use for `notify`: the token and chat are passed in, never read from the environment |
| `sites.example.json` | an example limits file; the real one belongs to each caller |
| `config.js`, `tools/` | the deploy file (`npm run init`, `npm run config`), the secret scan, small tools for people |
| `docker/` | the mirror: Neko with Chrome or Brave, `up.sh`, `verify.sh`, the optional Tailscale exit |
| `extras/` | **frozen**: the HTTP service, warm-up, egress check and their own copies of hands and limits. They work and are tested (`npm run test:extras`) but are not developed, and the core loads nothing from them |
| `test/` | tests of the core, the deploy file, the secret scan and the Docker files |

## Status

| | |
|---|---|
| **Tested** | the library in real Chromium on local pages (`npm test`); the deploy file, `npm run init`, `npm run config` and the secret scan; `docker compose config` for both browsers, with and without Tailscale |
| **Run for real, earlier versions** | the library against a Neko mirror with Chrome for one caller project; the mirror with Brave on one desktop and, mirror only, once on a rented server |
| **Run locally, this version** | this compose file with Chrome on a laptop, without an account: [the acceptance](docs/acceptance.md) except signing in (healthy, `verify.sh`, restart and re-create, persistence, the live check) and a caller's stack attached to it ([docker/README.md](docker/README.md#what-was-verified-and-what-was-not)) |
| **Not run yet** | this compose file on a server, and with Brave; a signed-in site through a restart and a re-create; the Tailscale exit |

meatsuit is for automating **your own** accounts at low volume. It does not solve captchas, does not spoof fingerprints and promises nothing about how sites react. Platforms' terms apply, and you are responsible for following them.

## Tests

```sh
npm test                                          # core: the secret scan first, then every suite
npm --prefix extras ci && npm run test:extras     # the frozen extras/
```

The core tests need a Chromium for `playwright-core`; see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

A license has not been chosen yet, so for now all rights are reserved.
