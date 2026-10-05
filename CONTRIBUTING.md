# Contributing

Thanks for looking at meatsuit. It is a small project with a narrow purpose, so a few ground rules keep it honest and safe.

## Scope

meatsuit helps one person automate **their own** accounts at low volume with a real browser and human-like input. Changes that push it toward account farms, captcha solving, fingerprint spoofing or "undetectable" claims are out of scope and will not be merged. Making it stop earlier and more reliably (detecting a captcha, a block, an unexpected page) is always in scope.

## Never commit

- Passwords, tokens, API keys, Tailscale auth keys, Telegram tokens.
- Real IP addresses, hostnames of your machines, or personal details. This repository is public. Use documentation addresses (`203.0.113.7`, `198.51.100.9`) and example hosts in docs and tests.
- `docker/.env`, `profiles/clients.json` and `data/` (they are already in `.gitignore`).

Before pushing, search your diff: `git diff --cached | grep -E '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+'`.

## Running the tests

```sh
npm install
npm test        # node --test, one file at a time
```

Tests that need a real browser skip themselves unless Patchright (installed by `npm install`) and a Chromium are available. Patchright does not download a browser: install Chromium with your system's package manager (the tests look for `/usr/bin/chromium`, `chromium-browser`, `google-chrome`, or the path in `MEATSUIT_CHROMIUM`). Then:

```sh
npm test
npm run test:e2e        # slower end-to-end tests against a local page, needs Chromium
```

If Patchright is installed somewhere else, point `NODE_PATH` at that `node_modules`.

Browser tests are heavy. They run one file at a time on purpose (several Chromium processes at once can overload a small machine). On Linux with systemd, `scripts/capped <command>` runs a command under a hard memory and CPU cap, so a runaway process is killed instead of freezing the machine:

```sh
scripts/capped npm test
```

## How we work

- **Test first.** Write the failing test, watch it fail for the right reason, then make it pass. Many of the real bugs here were found only by running a real browser, so prefer a browser test over a fake when the behaviour depends on how a browser lays out or hides something.
- **Check that your test can fail.** Break the code on purpose (a "mutation") and make sure a test notices.
- **Say what is verified and what is not.** Put "not verified" next to the claim it belongs to, in code comments and docs. Do not write that something works because it should; write what you ran and what you saw. Numbers for limits and warm-up are the author's guesses, and changes to them should say what evidence they rest on.
- **Keep the safety rails.** The browser must stop on a captcha, a block or a login page. It must not click ads, anything inside an iframe, "subscribe", "install", "sign in" and the like. Egress mismatch means the task does not run.

## Pull requests

Keep them small and focused, explain the problem and how you checked the fix, and run `npm test` first. Documentation fixes are very welcome; the docs are written for someone who has never heard of the project.
