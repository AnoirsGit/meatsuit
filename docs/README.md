# Documentation

Start with the [project README](../README.md), then read in this order:

| Document | Read it to learn |
|---|---|
| [architecture.md](architecture.md) | the idea, the parts, how they fit and why they are built that way |
| [http-api.md](http-api.md) | the HTTP interface your scripts use: `GET /view`, `POST /act`, tasks, limits, errors |
| [warmup.md](warmup.md) | what the warm-up does and does not do, how to configure and read it |
| [egress.md](egress.md) | why the browser should leave from your own IP and how to route it there |
| [stealth.md](stealth.md) | what a site can see in this browser, what is done about each tell, what is left, and how to measure it with `selfcheck.js` |
| [../docker/README.md](../docker/README.md) | running the browser mirror, what was verified, deploying to a server |

[../CONTRIBUTING.md](../CONTRIBUTING.md) explains how to run the tests and what changes are in scope.

## Notes in Russian

The author's working notes in Russian are in [ru/](ru/): goal and analysis, design, API, warm-up, [how everything runs on a desktop](ru/07-desktop.md) and [the stealth review of 20.10.2026](ru/09-stealth.md). The English documents above are the maintained ones; where they differ, trust the code and the English documents.
