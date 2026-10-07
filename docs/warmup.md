# Warm-up

`life.js` is a small command that visits ordinary public websites in the long-lived browser, at random times, and behaves like a reader: it scrolls, pauses over text, sometimes follows a link, sometimes watches a video. It never signs in and never clicks anything that touches an account. The only thing it types is a search query on sites you mark as `search`.

This page covers why it exists, what it does and does not do, how to configure it, and what is still unverified. For the big picture see the [project README](../README.md) and [architecture](architecture.md). The Docker setup is in [docker/README.md](../docker/README.md). Warm-up depends on the home-IP setup in [egress.md](egress.md); the HTTP service your own scripts use is in [http-api.md](http-api.md).

## The premise, honestly

The idea: a browser with no history (no cookies, no trace of ordinary browsing) is trusted less by websites than a browser a person has lived in for a long time. **There is no primary source for this.** The research it was based on is not in this repository, so it is an assumption, not a fact. We act as if it were true because that is cheap:

- The main warm-up is the owner's real life in the browser: signing in, reading, watching, searching, as usual, through the web mirror.
- The automated warm-up is a supplement for days when the owner has not been there. It does not replace real use.

If the assumption is wrong, the cost is some time and a little traffic. The automation has a cost of its own: one more script with access to the browser, which can leave odd traces (see [Risks](#risks)).

## Scope and responsibility

meatsuit is personal automation of your own accounts at low volume. Warm-up follows the same stance: no account farms, no captcha solving (on a captcha it stops, and you solve it yourself in the mirror), no fingerprint or geolocation spoofing. The terms of the platforms you use apply to you. For Tinder and LinkedIn we checked: both prohibit automation, and neither publishes numeric limits. You are responsible for what you automate, so read the terms of every site you point this at.

## Who does what

| Task | Who |
|---|---|
| Signing in, registrations, confirmations (SMS, 2FA) | You, by hand in the mirror. The session then lives in the browser profile |
| Captchas | You. Warm-up stops on a captcha and never tries to solve it |
| Movies, social media, search, mail, anything "lived" | You. This gives variety and a real history that a script cannot |
| Reading ordinary news and reference sites on a schedule, following links, one video on a video site | `life.js` |
| Actions of your own bots (applications, likes, and so on) | The bots, through the HTTP service. That is work, not warm-up |

## What sites can and cannot see

- **Verified:** sites cannot read your browsing history. Since Chrome 136 the visited-link state is partitioned, so a page can no longer probe which other sites you have been to through `:visited` styling. Brave is built on Chromium; whether the Brave build in the Docker image already includes this was not checked.
- **What a site does see:** its own cookies and storage (so it can tell a returning visitor from a new one), your IP address, request headers, and how the page is used (mouse, scrolling, timing).
- **Not verified:** whether being signed in to a Google account raises reCAPTCHA scores. It is often repeated; we found no primary source.

Our inference, not a measurement: what warm-up can realistically build is state that sites can see (cookies, sign-ins, ordinary usage patterns), not "history" in the abstract.

## Commands

Needs Node 20+. `plan` and `now --dry` need no browser. Real sessions also need `npm install` (Patchright) and a browser started with `--remote-debugging-port`; the Docker stack does this for you ([docker/README.md](../docker/README.md)).

| Command | What it does | Browser needed |
|---|---|---|
| `node life.js plan` | Current time in your zone, the saved "hand" traits, a **random example** of this week's working days, today's start times and one session | No |
| `node life.js now --dry` | Prints the steps of one session as JSON; opens no sites | No |
| `node life.js now` | One session right now. While a pause from a captcha or block is active it refuses (exit code 1) unless you pass `--force` | Yes |
| `node life.js run` | Follows the schedule until stopped (Ctrl+C or SIGTERM: the tab is closed, exit code 0) | Yes |

Options: `--config profiles/life.json`, `--cdp http://127.0.0.1:9222` (or the `MEATSUIT_CDP` variable), `--data data`, `--egress profiles/egress.json`, `--force`, `--no-egress-check`. Via npm: `npm run life -- plan`.

The example from `plan` is not what `run` will pick: each is chosen independently. `plan` lists the whole day's starts, including ones already past. Console output and journal `reason` strings are in Russian, and `plan` prints the current time as "Сейчас (<your tz>)" ("Now"), in your configured zone.

## Schedule

1. Days and weeks are computed in the configured time zone (`tz`), not the server clock. Weeks start on Monday.
2. Once a week it picks the working days: a random number between `daysPerWeek[0]` and `[1]`, on random days. The rest are days off with no sessions. The choice is stored in `data/life.json`, so a restart does not reshuffle it. `[7, 7]` means every day.
3. For a working day it picks a random number of sessions from `sessionsPerDay` and random start times inside the `hours` window. Starts are at least `minGapMinutes` apart, and the last start leaves room for the longest possible session before the window closes. If the requested count does not fit, it takes as many as fit.
4. A start missed by more than `lateMinutes` (the process was down, the browser was unavailable) is skipped silently and counted as done; nothing is written to the journal. When `run` plans a day midway, it keeps only starts that are still ahead (within that same grace).
5. The plan and what is done live in `data/life.json`. A restart on the same day continues where it left off. A new day gets a new plan; a new week gets a new choice of days.

## A session

A session visits `session.sites` sites (default 2 to 4) chosen from `sites` by weight, never the same one twice in a row (unless you list only one). The total time (default 5 to 14 minutes) is split unevenly between them. It opens a new tab and closes it at the end; the browser stays up and `life.js` only disconnects.

The session has a hard deadline: the sum of the site budgets times 1.25, plus pauses (1 to 12 s before each site). Whatever is in progress at the deadline is finished, then the session ends (`session-end` with `cut: true`).

| Kind | What happens |
|---|---|
| `read` | Opens the page, closes popups, looks at the screen, scrolls the wheel 400 to 900 px at a time and lingers between scrolls (the hand twitches now and then). Time on a page grows with the text length, from 8 s to 4 min, never beyond the site's budget. Per visit it follows 0 to 3 links on the same site: about 45% none, 30% one, 17% two, 8% three. Links are clicked with the mouse, not opened with `goto`; a quarter go through the menu or header. On a followed page it either carries on from there or steps back (about half the time), rarely two steps |
| `video` | Opens the configured URL, looks for a link containing `/watch?v=` or `/video/`, clicks it, stays on the video page for 30 s to 10 min (the site's budget, clamped, never beyond the deadline), and sometimes scrolls slightly "toward the comments". No such link: it leaves. Whether the video starts playing by itself is not verified. Use it only for a video site where the browser is **not** signed in: watching on YouTube while signed in to Google fills the account's watch history with random videos. The shipped file has no `video` site for that reason |
| `search` | Finds a search field (`type=search`, `name` q, query, search or s, `role=searchbox`, or a placeholder containing "search" or "поиск"), clicks it, types a query from `queries` with real key events (with typos and corrections; Cyrillic through the Russian layout), presses Enter and reads the results like `read`. No visible field (for example it opens only when you click an icon): the site is skipped with the reason "нет поля поиска" ("no search field"). The query is chosen at planning time and journaled |

**Why searches go to Wikipedia, not Google.** Google's policies prohibit automated queries ([spam policies](https://developers.google.com/search/docs/essentials/spam-policies)). The egress IP is your own home IP, so a flag would land on every device you use at home (our inference, not verified). If you want Google, search yourself in the mirror.

### Popups and small things

- **Popups are closed the way a person would** (`life/overlay.js`): dialogs (`role=dialog`, `aria-modal`), cookie banners and large fixed layers. It waits 0.5 to 4 s as if reading first. For a cookie banner the `consent` setting decides: `reject` (default) clicks "Reject" or "Only necessary"; `accept` clicks "Accept". If only "Accept" exists it accepts, otherwise the banner would cover the site. An ordinary dialog is closed only with "Close", "x", "Not now", "No thanks", "Block" and the like.
- **It never clicks:** subscribe, install the app, sign in, register, buy, "allow", anything advertising; anything inside an `iframe` (ads live there, and a scripted ad click is click fraud against the advertiser); a "Close" link that would navigate away. With nothing to click it presses `Esc` once; if that fails the site is skipped ("popup did not close"). It checks after opening a site, after each followed link and on every reading pass.
- **Stray windows:** a tab that opens by itself (ads, `window.open`) is closed after about 1 to 6 s, `alert`/`confirm`/`prompt` are dismissed, and `beforeunload` is allowed to leave.
- **Random small things** (`life/wander.js`, about 20% chance per reading pass): scroll up 1 to 4 notches (35%), stand still 3 to 30 s (30%), hover over a link without clicking (25%), "step away" for 15 to 90 s with no mouse movement at all (10%). Each is capped by the time left in the session.
- **Which links may be followed:** same site (subdomains count as other sites), not in the footer, link text 12 to 140 characters, not opening a new tab, fully on screen across its width, not transparent and not covered by another element (sites plant such traps for bots, and clicking one would give the script away). Links or text with words about login, logout, sign-up, subscribe, cart, checkout, buy, download, account, settings, password, donate, ads, `mailto:`, `tel:` or `javascript:` (and Russian equivalents) are excluded. If no link is on screen it scrolls back up in steps (1000, 2500, then 6000 px) and looks again.
- **Hand traits** (speed, tremor, twitch rate, typing speed) are saved in `data/persona.json`, so after a restart it is the same "person". A damaged or incomplete file is replaced with sane traits.

## Stops

| Situation | What it does |
|---|---|
| Captcha or block (`guard` verdicts `captcha`, `blocked`) | The session stops and no more sites open. `pausedUntil` = now + `cooldownHours` is written to `data/life.json`. While paused `run` starts nothing and `now` refuses (exit 1) without `--force`. The pause survives a new day and a damaged state file |
| Wrong egress (`egress-wrong`) | Before every session the exit is checked against `profiles/egress.json` ([egress.md](egress.md)). A mismatch, or an exit that cannot be determined, skips the session. No daily pause is set, and the start counts as done. **If the file does not exist, `now` and `run` refuse to start**, so warm-up cannot browse from the wrong address by accident. `--no-egress-check` turns the check off on purpose (a `warning` is journaled before each session). A malformed file also stops the program at startup |
| Redirect to a sign-in page (`login`) | That site is skipped, the session continues |
| Site did not open (30 s timeout and the like) | Skipped, the session continues |
| Popup cannot be closed or keeps returning | Skipped, the session continues |
| No search field on a `search` site | Skipped, the session continues |
| Browser unavailable (CDP down, container restarting) | `error` event, tab and connection closed, the process lives on. In `run` the start counts as done; `now` exits 1 |
| SIGTERM or Ctrl+C | Tab and connection closed, exit 0. An interrupted start stays undone and runs after a restart unless it is too late |
| Deadline reached | The session ends with `cut: true` |
| Bug in the code | `error` event. In `run` the start counts as done |

What `guard` (`guard.js`) recognizes, judging by a snapshot of the page (URL, title, start of the text, whether a challenge frame is visible):

- Always: a **visible** captcha frame: the reCAPTCHA "I'm not a robot" checkbox or its challenge popup, hCaptcha, Cloudflare, Arkose, DataDome, Yandex SmartCaptcha, or the `#px-captcha` block. The invisible reCAPTCHA badge that many sites keep on every page does not count (it is skipped by its `size=invisible` address and its `.grecaptcha-badge` container, and visibility, opacity and position are checked). The frame names of Arkose, DataDome, SmartCaptcha and PerimeterX come from general knowledge and are not verified on live sites; the reCAPTCHA ones are tested on a real Chromium with local stand-in pages, not on Google's own. A sign-in URL by its path (`/login`, `/signin`, Google sign-in): `?next=/login` and `/login-security-tips` are not a sign-in.
- Only on short pages (under 2000 characters): titles like "Just a moment", error titles like "403", "Error 403", "429 Too Many Requests" (an article titled "403 - Wikipedia" or "429 AD" is not an error), URLs like `/captcha`, `/showcaptcha`, `/challenge`, `/sorry`, `/checkpoint`, `/blocked`, and phrases like "verify you are human", "Press & Hold", "unusual traffic" (and Russian ones). So an article about captchas does not stop warm-up, while a stub page does.

Gaps: a captcha that is not in an iframe or has a name not listed above is caught only by its text and URL. A sign-in shown as a pop-up over the same address (as some single-page apps do) is **not** a sign-in to this check. Checks run after a site opens and after each followed link, **not** while reading, so a captcha that appears mid-page is noticed at the next check.

## Configuration: `profiles/life.json`

| Field | Meaning | Default | Shipped file |
|---|---|---|---|
| `tz` | Time zone for days and weeks (IANA name). The default is the author's zone; set yours | `Asia/Almaty` | same |
| `hours` | `[from, to]`, the window in which sessions may start | `[9, 23]` | same |
| `daysPerWeek` | `[min, max]` working days per week, the rest are days off | `[7, 7]` | `[3, 4]` |
| `sessionsPerDay` | `[min, max]` sessions on a working day | `[2, 5]` | `[1, 2]` |
| `consent` | Cookie banner: `reject` (refuse optional cookies) or `accept` | `reject` | same |
| `minGapMinutes` | Minimum minutes between starts | 60 | 120 |
| `lateMinutes` | A start missed by longer than this is skipped | 90 | 90 |
| `cooldownHours` | Pause after a captcha or block | 24 | 72 |
| `session.minutes` | `[min, max]` total session time | `[5, 14]` | `[5, 12]` |
| `session.sites` | `[min, max]` sites per session | `[2, 4]` | same |
| `sites` | List of `{url, kind, weight, queries}`. `kind` is `read` (default), `video` or `search`; `weight` is above zero (default 1); `queries` is a non-empty list of strings up to 60 characters, required for `search` | at least one | six sites |

The config is loaded once at startup, so restart `run` after editing it. It is validated at startup and the program refuses to start when:

- a URL is not `http` or `https` (no `file:`, `chrome:`, `javascript:`);
- a range is reversed or out of bounds (`hours` 0 to 24, `sessionsPerDay` 1 to 20, `session.minutes` 0.1 to 120, `session.sites` 1 to 20, `daysPerWeek` whole numbers 1 to 7);
- the longest possible session (with the 1.25 overrun and pauses) does not fit in the `hours` window;
- the time zone is unknown, `consent` or `kind` is not one of the allowed values, or a weight is not above zero.

`sessionsPerDay` cannot be below 1. To not warm up, do not run `run`.

```json
{
  "tz": "Europe/Berlin",
  "hours": [9, 22],
  "daysPerWeek": [3, 4],
  "sessionsPerDay": [1, 2],
  "session": { "minutes": [5, 12], "sites": [2, 4] },
  "sites": [
    { "url": "https://news.ycombinator.com/", "kind": "read", "weight": 3 },
    { "url": "https://en.wikipedia.org/", "kind": "search", "weight": 3, "queries": ["Mountains", "Linux", "Chess"] }
  ]
}
```

What to put in `sites`:

- Ordinary sites without sign-in that you read yourself: news, reference, blogs. The shipped file is the author's own taste (Russian- and Kazakh-language news sites and Russian Wikipedia for searches). Replace it. None of those sites has been run against for real.
- Do not list sites where the browser is signed in. Reading there also leaves a trace in the account, and the code cannot tell account links from any others beyond the word list above. This is a rule of caution; the code does not enforce it.
- Run `node life.js plan` and `now --dry` first to see what you would get.

## Reading `data/`

`data/` is not in git. In Docker it is the `life_data` volume, mounted at `/data`; the journal lines are also printed to the container log.

| File | Contents |
|---|---|
| `life.jsonl` | The journal: one JSON line per event, appended |
| `life.json` | Scheduler state: `day`, `starts` (start times in ms), `done`, `pausedUntil`, `week` |
| `persona.json` | The hand traits |

Every line begins with `ts` (ISO, UTC). Events in `life.jsonl`:

| `event` | Fields | When |
|---|---|---|
| `plan` | `day`, `starts`, `reason` | `run` planned the day |
| `session-start` | `steps`: `[{url, kind, minutes, follow}]` | A session began; this is its plan |
| `follow` | `from`, `href`, `zone` (`nav` or `content`) | Followed a link |
| `step` | `url`, `kind`, `result` (`ok`, `skipped`, `blocked`), `reason`, `ms` | A site is finished |
| `overlay` | `result` (`closed`, `stuck`), `reason` | A popup was closed, or could not be |
| `dialog` | `reason` (type) | A system dialog was dismissed |
| `popup-closed` | | A stray tab was closed |
| `wander` | `reason` (`scrollUp`, `idle`, `hover`, `away`) | A random small thing |
| `search` | `reason` (the query) | A search step began |
| `session-end` | `cut` (`true` if the deadline ended it) | The session finished |
| `cooldown` | `reason`, `url`, `until` | Captcha or block; silent until `until` |
| `error` | `reason` | A failure not on a site (browser unavailable, tab did not open, code bug) |
| `egress-wrong` | `reason`, `country`, `asn`, `org`, `detail` | Wrong or unknown exit; session skipped, no pause |
| `warning` | `reason` | Started with `--no-egress-check` (exit not checked), or `now --force` during a pause |
| `stopped` | `reason` | A session was interrupted by SIGTERM or Ctrl+C |

A format example composed from the code, not the output of a real run:

```json
{"ts":"2025-01-15T10:02:11.482Z","event":"session-start","steps":[{"url":"https://news.example.com/","kind":"read","minutes":3.4,"follow":1}]}
{"ts":"2025-01-15T10:03:00.000Z","event":"follow","from":"https://news.example.com/","href":"https://news.example.com/a/1","zone":"content"}
{"ts":"2025-01-15T10:06:30.000Z","event":"step","url":"https://blog.example.com/","kind":"read","result":"blocked","reason":"captcha","ms":9000}
{"ts":"2025-01-15T10:06:30.000Z","event":"cooldown","reason":"captcha","url":"https://blog.example.com/","until":"2025-01-16T10:06:30.000Z"}
```

What to look at every day while ramping up:

```sh
jq -c 'select(.event=="cooldown" or .result=="blocked" or .result=="skipped" or .event=="error")' data/life.jsonl
jq -s -c 'map(select(.event=="step")) | group_by(.result) | map({result: .[0].result, n: length})' data/life.jsonl
jq '.pausedUntil/1000|floor|todate' data/life.json     # when the pause ends (UTC)
```

To lift a pause by hand, delete the `pausedUntil` field from `data/life.json` (or the whole file, then the day is planned afresh). First look at what the block was. If it was not a random glitch, leave the pause alone.

## Suggested ramp-up

**This is the author's untested suggestion, not the result of experience.** The numbers come from "start small, grow gradually, not every day". No source says this is what works. The code does not ramp by itself: you edit `profiles/life.json` by hand once a week.

| Week | `daysPerWeek` | `sessionsPerDay` | `session.minutes` | `session.sites` | `minGapMinutes` |
|---|---|---|---|---|---|
| 1 | `[2, 2]` | `[1, 1]` | `[4, 8]` | `[1, 2]` | 180 |
| 2 | `[2, 3]` | `[1, 1]` | `[5, 10]` | `[2, 3]` | 120 |
| 3 and on | `[3, 4]` | `[1, 2]` | `[5, 12]` | `[2, 4]` | 120 |

It stops growing there on purpose: the aim is to look like someone who reads a couple of times a week, not to add volume. Rules for moving on (also a suggestion):

- Go to the next week only if the last one had no `cooldown` or `error` and the sites ended `ok`.
- After a block, go back a week and find out which site and why before continuing.
- In the first days you live in the browser and sign in yourself; turn `run` on after that, not instead of it.
- Your own bots are not in this table. Their pace is set by the limits in `profiles/sites.json` ([http-api.md](http-api.md)). How many days after sign-in a bot may start is your call; there is no source for a number.

## What it deliberately does not do

| It does not | Why |
|---|---|
| Sign in or register | Those are account actions that belong to a human. A redirect to sign-in counts as a skipped site |
| Type anything but a search query; like, follow, comment | Any such action leaves a trace in an account. Warm-up reads and clicks links |
| Solve a captcha or get around a block | The project stops on a captcha, then stays quiet for `cooldownHours` |
| Visit sites outside `sites` or follow links to other hosts | Sites come only from the config, links only on the same host, only `http`/`https` |
| Spoof fingerprints or geolocation | The browser is real and does not lie about itself |
| Know that you are in the mirror or that your bots are working | There is no queue and no "I am in the mirror" check yet. The exit check exists and is mandatory: without `profiles/egress.json` warm-up does not start, unless you pass `--no-egress-check` |

## What is verified and what is not

**Verified:** unit tests with fake clocks and a fake page (`npm test`); end-to-end tests on real Chromium against local test sites (`npm run test:e2e`): sessions with link following, going back up to find links, a video page, a stop on a block page with the pause written to `data/life.json`; SIGTERM closes the tab; trap links and the hidden reCAPTCHA frame are ignored; closing a cookie banner and a modal by a real click (an ad overlay is not clicked); closing a tab opened by `window.open`; a search on a local Wikipedia stand-in with a Cyrillic query (typed by keys, then Enter). Patchright connecting to the Brave in the Docker stack over CDP, and reading its tabs and cookies, works (that is what `docker/verify.sh` does).

**Not verified:** a full warm-up session in Brave (opening a tab, scrolling, clicking); detector sites; real sites (none of the sites in the shipped file); warm-up on a server; an exit node; a session watched through the mirror (risk 4); `run` live over several days (its logic is tested only with fake clocks).

## Risks

| # | Risk | What to do |
|---|---|---|
| 1 | **Wrong IP.** Without an exit node, sessions on a server would leave from a datacenter address and the browser's first "history" would be from there. The check protects against this and is mandatory (no `egress.json`, no start) | Create `profiles/egress.json` and do not run until the exit is up ([egress.md](egress.md)). Check that `egress-wrong` shows in the journal when the exit is wrong |
| 2 | **Brave and Patchright.** Only Chromium was exercised end to end. Whether Patchright's patches still apply when it attaches to a running Brave is unknown | Run `node life.js now` against Brave once, watching the screen |
| 3 | **Real sites.** Everything was run on local pages. Cookie consent, popups, link markup and video behave differently on real sites | Run `now` once or twice while watching the mirror, then check `life.jsonl` for `skipped` |
| 4 | **You and warm-up in one browser.** A session opens a tab in the first browser context, not a separate window. What you see in the mirror, whether you lose focus, and how a background tab behaves (does it freeze, what `document.visibilityState` says) are not verified | Run `now` while you watch the mirror |
| 5 | **No queue.** Warm-up does not know about your bots' tasks and does not yield; it does not know you are in the mirror | Do not run `run` at the same time as bots, nor leave it on while you sit in the browser |
| 6 | **Captcha is checked only at checkpoints.** A false positive (a short page with the wrong words) costs a whole pause | Watch `cooldown` in the journal |
| 7 | **Behaviour tuned by eye.** The mouse and scroll rhythm looks human by the author's own measurements, but was never compared with real behavioural detectors | Detector sites are a separate spike, not done |
| 8 | **No notifications.** A block is visible only in the journal and on screen. `notify.js` (Telegram) is written for the HTTP service and is not connected to `life.js` | Look at `life.jsonl` by hand |

Russian original: [ru/06-warmup.md](ru/06-warmup.md).
