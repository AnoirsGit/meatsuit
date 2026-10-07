# Documentation

Start with the [project README](../README.md). meatsuit is a library (`connect` / `task` / `see` / `act`) and a browser mirror; these documents describe them:

| Document | Read it to learn |
|---|---|
| [04-contract.md](04-contract.md) (Russian) | the library's API, the contract callers rely on: `connect`, `task`, `see`, `act`, `sites.json`, errors, journal |
| [architecture.md](architecture.md) | how the library, the mirror and the deploy file fit together, and why |
| [../docker/README.md](../docker/README.md) | running the mirror: the deploy file, choosing Chrome or Brave, attaching another stack, the optional Tailscale exit |
| [acceptance.md](acceptance.md) (Russian) | the live check on a real mirror: sign in once, restart, the session survives, a `dryRun` task from another machine |
| [egress.md](egress.md) | why and how to send the browser's traffic out through your own home connection (the mirror's optional `egress` profile) |

[../CONTRIBUTING.md](../CONTRIBUTING.md) explains how to run the tests and what changes are in scope.

## Frozen: `extras/`

The HTTP service, warm-up, egress check, queue and notifications from an earlier line of work live in [`../extras/`](../extras/). They work and are tested (`npm --prefix extras ci`, then `npm run test:extras`) but are not developed, and the core does not depend on them. Their documents are kept as they were, with paths updated:

| Document | About |
|---|---|
| [http-api.md](http-api.md) | the HTTP service: `GET /view`, `POST /act`, tasks, limits, errors |
| [warmup.md](warmup.md) | the warm-up scheduler: what it does and does not do, configuration |
| [egress.md](egress.md#the-egress-check) | the egress check part of that page |
| [ru/](ru/) | the author's Russian working notes of that line: goal and analysis, design, API, warm-up, running on a desktop |
