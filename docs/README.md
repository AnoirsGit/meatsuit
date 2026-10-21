# Documentation

Start with the [project README](../README.md). meatsuit is just this: launch a browser, remember, and then eyes and hands; every credential comes from the caller. It is a library (`connect` / `task` / `see` / `act`) and a browser mirror; these documents describe them:

| Document | Read it to learn |
|---|---|
| [contract.md](contract.md) ([Russian](04-contract.md)) | the library's API, the contract callers rely on: `connect`, `task`, `see`, `act`, `sites.json`, errors, journal |
| [architecture.md](architecture.md) | how the library, the mirror and the deploy file fit together, and why |
| [../docker/README.md](../docker/README.md) | running the mirror: the deploy file, choosing Chrome or Brave, attaching another stack, the optional Tailscale exit |
| [acceptance.md](acceptance.md) (Russian) | the live check on a real mirror: sign in once, restart, the session survives, a `dryRun` task from another machine |
| [egress.md](egress.md) | why and how to send the browser's traffic out through your own home connection (the mirror's optional `egress` profile) |
| [ru/08-pi-zero.md](ru/08-pi-zero.md) (Russian) | the home device meant to become the 24/7 exit node: what is prepared, what went wrong, the steps left |
| [ru/09-phone-exit-node.md](ru/09-phone-exit-node.md) (Russian) | the home Android phone as the exit node, `anoir-pc` as the fallback: first setup and the check |
| [ROADMAP.md](ROADMAP.md) (Russian) | the one list of open items: priority, who does it, when it counts as done |

[../CONTRIBUTING.md](../CONTRIBUTING.md) explains how to run the tests and what changes are in scope.

## `extras/`: services around the core

The HTTP service, warm-up, egress check, queue, notifications, owner presence, browser lock and self-check live in [`../extras/`](../extras/). They are maintained: the owner develops them, and they are tested (`npm --prefix extras ci`, then `npm run test:extras`). The core library loads nothing from them (`test/api.test.js` enforces it). Their documents:

| Document | About |
|---|---|
| [http-api.md](http-api.md) | the HTTP service: `GET /view`, `POST /act`, tasks, limits, errors |
| [warmup.md](warmup.md) | the warm-up scheduler: what it does and does not do, configuration |
| [egress.md](egress.md#the-egress-check) | the egress check part of that page |
| [stealth.md](stealth.md) ([Russian](ru/09-stealth.md)) | the stealth review of 20.10.2026: what a site can see in this browser, what is done about each tell, and how to measure it with `extras/selfcheck.js` |
| [ru/](ru/) | the author's Russian working notes of that line: goal and analysis, design, API, warm-up, running on a desktop |
