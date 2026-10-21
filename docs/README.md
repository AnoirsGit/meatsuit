# Documentation

Start with the [project README](../README.md) ([Russian](../README.ru.md)). meatsuit is just this: launch a browser, remember, and then eyes and hands; every credential comes from the caller. It is a library (`connect` / `task` / `see` / `act`), a browser mirror in Docker, and the maintained services in `extras/`.

## The core: library and mirror

| Document | Read it to learn |
|---|---|
| [contract.md](contract.md) ([Russian](04-contract.md)) | the library's API callers rely on: `connect`, `task`, `see`, `act`, `sites.json`, errors, journal |
| [architecture.md](architecture.md) | how the library, the mirror and the deploy file fit together, and why |
| [../docker/README.md](../docker/README.md) ([Russian](../docker/README.ru.md)) | running and deploying the mirror: the deploy file and every variable, Chrome or Brave, attaching another stack, troubleshooting |
| [egress.md](egress.md) | sending the browser's traffic out through a home Tailscale exit node: the kill switch, the fallback list with the exit check, a phone as the exit node |
| [ru/09-phone-exit-node.md](ru/09-phone-exit-node.md) (Russian) | the owner's runbook: the helper Android phone as the exit node, `anoir-pc` as the fallback, switching the server from `ms-trunk` to `main` |
| [acceptance.md](acceptance.md) (Russian) | the live check on a real mirror: sign in once, restart, the session survives, a `dryRun` task from a sibling container |
| [ROADMAP.md](ROADMAP.md) (Russian) | the one list of open items: priority, who does it, when it counts as done |

[../CONTRIBUTING.md](../CONTRIBUTING.md) explains how to run the tests and the secret scan, and what changes are in scope.

## `extras/`: services around the core

The HTTP service, warm-up, egress check, queue, notifications, owner presence, browser lock and self-check live in [`../extras/`](../extras/). They are maintained (`npm --prefix extras ci`, then `npm run test:extras`); the core library loads nothing from them (`test/api.test.js` enforces it).

| Document | About |
|---|---|
| [http-api.md](http-api.md) | the HTTP service: `GET /view`, `POST /act`, tasks, limits, errors, owner presence and the browser lock |
| [warmup.md](warmup.md) | the warm-up scheduler (`extras/life.js`): what it does and does not do, configuration |
| [egress.md](egress.md#the-egress-check) | the egress check (`extras/egress.js`) used by warm-up and the HTTP service |
| [stealth.md](stealth.md) ([Russian](ru/09-stealth.md)) | what a site can see in this browser, what is done about each tell, and how to measure it with `extras/selfcheck.js` |
