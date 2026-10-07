# Contributing

Thanks for looking at meatsuit. It is a small project with a narrow purpose, so a few ground rules keep it honest and safe.

## Scope

meatsuit is three things: launching one browser, remembering its session, and eyes and hands for a caller's code. Concretely, the library in the repository root (`connect` / `task` / `see` / `act`), the mirror in `docker/`, and the deploy file with `npm run init` and `npm run config`.

- Credentials belong to the caller. The library must not read the environment, must not send anything anywhere by itself, and must not keep site passwords, model keys or bot tokens (`test/api.test.js` checks the first two).
- `extras/` is **frozen**: the HTTP service, warm-up, egress check, queue and notifications from an earlier line of work. Bug fixes that keep its tests green are fine; new features are not. The core must not load anything from `extras/`.
- Changes that push meatsuit toward account farms, captcha solving, fingerprint spoofing or "undetectable" claims are out of scope. Making it stop earlier and more reliably (a captcha, a block, an unexpected page) is always in scope.

## Never commit

- Passwords, tokens, API keys, Tailscale auth keys, Telegram tokens.
- Real IP addresses, the names of your machines, your city, your network's ASN or other personal details. This repository is public. Use documentation addresses (`203.0.113.7`, `198.51.100.9`), documentation ASNs (`AS64496`–`AS64511`) and example hosts in docs and tests.
- The deploy file (`docker/.env` or wherever `MEATSUIT_CONFIG` points), `sites.json`, `profiles/*.json` other than `*.example.json`, archives and `data/`. They are already in `.gitignore`; only `*.example.*` files are tracked.

`tools/secret-scan.sh` checks for this with nothing beyond `sh`, `git` and `awk`: typical API keys, Telegram bot tokens, private keys, `NEKO_*PASSWORD=` with a value, tailnet names and `100.64.0.0/10` addresses, real ASNs (documentation and private ranges are fine), `ssh user@host` with a real host name, and files that must not be tracked. It prints `file:line: rule` and never the value.

- `npm test` runs it first (`pretest`) on tracked and new, not ignored files: a finding fails the tests.
- `npm run hooks` installs it as a `pre-commit` hook that checks the staged content. Optional; `npm test` is the gate.
- `sh tools/secret-scan.sh --history` checks every commit of every branch.
- Personal words a pattern cannot know (your city, your machines' names, your home ASN) go into `.secret-scan.local` at the repository root, one per line. That file is git-ignored, because the list itself would be a leak.

## Running the tests

```sh
npm ci
npx playwright-core install --only-shell chromium   # once: the headless Chromium the core tests launch
npm test                                            # the secret scan, then each core suite one after another
```

`npm test` is an explicit list of files in `package.json`: add a new suite there. The suites start a real headless Chromium through `playwright-core`; set `PLAYWRIGHT_BROWSERS_PATH` if your browsers live elsewhere. The Docker tests run `docker compose config` only (nothing is started) and skip themselves without Docker Compose.

The frozen `extras/` has its own dependencies (Patchright) and tests:

```sh
npm --prefix extras ci
npm run test:extras        # browser tests look for /usr/bin/chromium or the path in MEATSUIT_CHROMIUM
```

Browser tests are heavy. On Linux with systemd, `scripts/capped <command>` runs a command under a hard memory and CPU cap, so a runaway process is killed instead of freezing the machine:

```sh
scripts/capped npm test
```

The tests use fake pages and never touch real sites. The live check on a real mirror is a written procedure, [docs/acceptance.md](docs/acceptance.md); record what you ran and saw there.

## How we work

- **Test first.** Write the failing test, watch it fail for the right reason, then make it pass. Many real bugs here were found only in a real browser, so prefer a browser test over a fake when the behaviour depends on how a browser lays out or hides something.
- **Check that your test can fail.** Break the code on purpose and make sure a test notices.
- **Say what is verified and what is not.** Put "not verified" next to the claim it belongs to, in code comments and docs. Write what you ran and what you saw, not what should work.
- **Keep the safety rails.** A task must stop on a captcha, a block or a login page and leave the window to the human. The command set stays closed: no arbitrary JavaScript, no navigation off the task's site.
- **Keep the contract.** `docs/04-contract.md` and the export list (`test/api.test.js`) change only together with the callers.

## Pull requests

Keep them small and focused, explain the problem and how you checked the fix, and run `npm test` first. Documentation fixes are very welcome; the docs are written for someone who has never heard of the project.
