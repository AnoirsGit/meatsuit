# What a site can see, and what is done about it

A review of 20.10.2026 of the whole project from one angle: how would a site tell the bot from the owner? The
assessment is based on the code and on commonly known detector tells. **Nothing has been checked on detector sites
or real platforms.** You can now measure instead of guessing: `node selfcheck.js` (below). Russian original with
more detail: [ru/09-stealth.md](ru/09-stealth.md).

## In short

The design is the right one: one real Brave with a user interface, lived in by a person, a home exit, human-like
hands, a stop on captchas, person-like pacing. That beats any fingerprint spoofing. The weak spots before this
review were not the hands but the rhythm between actions and the container:

| Layer | Before | Now (20.10) | Still open |
|---|---|---|---|
| Network | home exit, fail closed, ASN check | unchanged | the exit node is not up yet; until it is, the server mirror must not be used for sign-ins or tasks |
| Browser fingerprint | real Brave, Patchright, task window of its own default size | task and warm-up windows **sized like the owner's window**; `selfcheck.js` measures the tells | WebGL off by flags, notifications denied by policy, container fonts |
| Behaviour | Fitts mouse, typing with typos, wheel notches of 100 px, actions back to back | **think pause** before every action, **53 px notches** like the owner's wheel under X11, **guard before an action**, `hover` | deep `goto` without referrer; owner and bot at the same time; warm-up unaware of bots |

## The three layers

### Network

A site sees the IP and its type (datacenter or residential), the country, and whether that agrees with the
browser's time zone and languages. Done: all browser traffic through a home exit node with a kill switch, country
and provider checked before every task and warm-up session ([egress.md](egress.md)). Not done: the exit node
itself is not running yet.

### Browser fingerprint

A site sees `navigator.webdriver`, traces of the DevTools protocol, headless tells, WebGL, plugins, fonts,
permissions, window and screen sizes, cores and memory.

Done and verified: a headed Brave without `--enable-automation` (`webdriver` is false). Patchright attaches over CDP,
and **no `Runtime.enable` trace was found under `connectOverCDP`**: the `Error.stack` getter probe on
`console.debug` (the technique DataDome and Cloudflare use) reports `cdpLeak=false` on a local headless Chromium.
The docs used to say "not verified"; it is now measured on Chromium, still not on the Brave in Neko. New windows
copy the owner's window bounds ([`window.js`](../window.js)). `GET /view` is built in an isolated world.

Expected yellow marks in the container (not measured yet): **no WebGL** (`--disable-gpu --disable-software-rasterizer`
in `brave-start.sh`; dropping the second flag leaves software WebGL, which is still a yellow but better than none),
**notifications denied everywhere** (`DefaultNotificationsSetting: 2` in `policies.json`), **few fonts** (install
`fonts-liberation`, `fonts-dejavu`, `fonts-noto-core`, `fonts-roboto` in the image and re-check). Linux + Brave +
2 cores + 1280×720 is rare but self-consistent, and the owner lives in the same browser.

Deliberately not done: spoofing the UA, platform, WebGL strings, canvas or audio. Spoofing creates mismatches that
are caught more reliably than an honest but rare fingerprint.

### Behaviour

A site sees rhythm (time from page load to the first action), mouse paths, typing rhythm, scrolling, where a visit
came from (referrer, URL depth), time of day, volume.

Done today:
- **Think pause** ([`human/pace.js`](../human/pace.js), applied in [`driver.js`](../driver.js)): before `goto`,
  `back`, `click`, `fill`, `hover`, `type` and `key` the service waits out a human reaction time counted from the end
  of the previous action (median about 1.8 s after a page change, 0.65 s on the same page, 0.3 s before typing). Only
  the missing part is waited, so a client that thinks for itself is not slowed. `paced` in the response shows the
  added time.
- **Wheel notches of 53 px**, what Chromium on X11 delivers for one physical notch. The owner's wheel in the mirror
  goes through the X server and gives a page `deltaY: 53`; the bot used to give 100. Taken from Chromium's source,
  not measured in the mirror. Scrolling that seeks (warm-up going back up to find a link) now flicks in longer bursts
  with short pauses instead of "reading" pauses, as a person does when looking rather than reading.
- **Guard before an action.** A challenge that appeared between actions used to be noticed only after the next
  click, so the bot clicked on a captcha page once. Now the page is checked before every action, and `GET /view`
  marks a guard verdict too; the next action is refused before it reaches the browser.
- **Sign-in by password field**: a visible password field on a short page (a sign-in dialog over an ordinary address,
  as on Tinder) now counts as `login`; `/sign_in` and `/log_in` paths too.
- **`hover`** without a click.
- **Warm-up never touches the owner's account**: links for delete, remove, report, block, follow, unfollow, like, vote,
  share (and Russian equivalents) are never followed.

Still open, by value: deep `goto` without a referrer (a bot client should enter through the site's home or search
and click its way in; the service cannot enforce that); a real `paste` for long texts (needs a real clipboard;
`insertText` over CDP produces an `input` event without `insertFromPaste`, which a page can tell); all pause and limit
numbers are guesses. Owner presence and the overlap of bot and warm-up were closed the same day (see below).

## Measured on the real Brave in the mirror (20.10.2026, author's machine)

`selfcheck.js` was run against the Neko stack from this repository (Brave 154, Neko 3.1.6), from the `server` container, twice:

| | Before | After `--enable-unsafe-swiftshader` |
|---|---|---|
| Red marks | none: `webdriver` false, **no `Runtime.enable` trace** (`cdpLeak` false), `window.chrome` present, 7 plugins, languages present | none |
| Yellow | WebGL unavailable; notifications denied by policy | notifications denied by policy |
| WebGL | `null` even without `--disable-software-rasterizer`: a headed Chromium no longer falls back to SwiftShader by itself | present; Brave reports vendor and renderer as `Brave` (its own fingerprint protection, the same for every Brave user) |

Other readings: `navigator.languages` shows only `en-US` although the profile has `en-US, ru`; that is Brave's language-fingerprint reduction and it matches the `Accept-Language` it sends, so it is consistent, not a tell. `maxTouchPoints` is 10 (Neko's touch input device), which reads as a touch laptop. Cores and memory are the host's. The task window takes the owner's window bounds exactly. The only yellow left, notifications denied for every site, is the owner's policy choice (`DefaultNotificationsSetting` in `policies.json`).

Also done the same day: the service and the warm-up step aside while the owner holds control in the mirror (`presence.js`, checked live against Neko with a real member session), and they share a browser lock so a task and a warm-up session never overlap (`lease.js`). See [http-api.md](http-api.md#owner-presence-and-the-browser-lock).

## Cases

| Case | What happens now | Gap |
|---|---|---|
| Captcha after a click | 409, window stays, Telegram, site paused for 3 days | |
| Captcha between actions | 409 before the next action, nothing is clicked | |
| Session lost, sign-in form on the same address | `login` by the visible password field (short page) | phone or one-time-code sign-ins have no password field |
| Bot sends actions back to back | the service waits out a human reaction | |
| Bot thought for 10 s (a model) | nothing added, `paced: 0` | |
| Echo service down during a task | task continues, re-check every 20 s, closed after about a minute; new tasks get 503 | |
| Exit is wrong | task closed at once | |
| Owner scrolls in the mirror, bot scrolls in a task | both give `deltaY: 53` | not measured in the mirror |
| New task window | sized like the owner's window | |
| Warm-up opens a site | in its own window, on top of the owner's; not at all while the owner holds control, and it ends early if the owner takes control | a person who only watches is not noticed |
| Owner takes control while a bot task runs | actions answer `503 owner_present`, the window stays, the task waits up to 30 minutes | |
| Bot task and warm-up session at the same time | never: one browser lock in `data/browser.lock` | warm-up skips rather than waits |
| Warm-up sees "Delete" or "Report" on a site the owner is signed in to | never followed | |
| Bot uses `goto` for deep URLs | allowed within the task's site | empty referrer, looks like a typed address |
| Menu opens on hover | `hover` | |
| Long text in a field | typed key by key, minutes | no paste |

## What to check on the server once the exit node is up

1. `docker compose --profile api run --rm server node selfcheck.js --tz Asia/Almaty`: on the author's machine this
   gave no red marks and one yellow (notifications); the server image is the same, so expect the same. Any red: stop
   and investigate before the first sign-in on a platform.
2. In the mirror's DevTools console: `addEventListener('wheel', e => console.log(e.deltaY))`, then scroll by hand.
   Expect 53 (or a multiple). Otherwise adjust `NOTCH` in `human/mouse.js`.
3. Detector sites by hand in the mirror, through the home exit: creepjs, browserleaks.com/webrtc (WebRTC leaks past
   the tunnel), bot.sannysoft.com, pixelscan.net. Record the results here.
4. A task through the service against a local page with an event log (like `testkit/e2e-site.js`): every event
   `isTrusted`, `paced` values in the journal.

## Code changes of 20.10.2026

`human/pace.js` and `window.js` (new); `selfcheck.js` (new); `driver.js` (think pause, guard before an action,
`hover`, `paced`); `human/mouse.js` (`NOTCH = 53`, seek scrolling); `guard.js` and `life/probe.js` (password field, `/sign_in`);
`life/plan.js` (account actions excluded); `life.js` (own window, presence, lock); `server.js` (`hover`, `paced`, guard
from `view`, softer handling of an undetermined exit, owner presence, browser lock); `presence.js` and `lease.js` (new);
`docker/neko/brave-start.sh` (`--enable-unsafe-swiftshader`, `--disable-software-rasterizer` dropped);
`docker/docker-compose.yml` (Neko address and admin password for the service and warm-up); `docs/05-egress.md`
(personal details moved out of the repository). Tests: `test/pace.test.js`, `test/window.test.js`,
`test/selfcheck.test.js`, `test/presence.test.js`, `test/lease.test.js` new; driver, server, runner, session, guard,
probe, plan, mouse and human tests extended.
