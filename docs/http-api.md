# HTTP API reference

meatsuit exposes one browser to your own scripts through a small HTTP service. A script asks for a task, looks at a page with `GET /view`, does things with `POST /act`, and ends the task. The service queues tasks, paces them, checks the network exit, and moves the mouse and keyboard like a person. For the idea behind this, see [architecture](architecture.md).

Everything below follows the code in [`server.js`](../server.js), [`driver.js`](../driver.js) and [`view.js`](../view.js). Where a Russian note disagrees with the code, the code wins. The `message` field in error bodies is a human-readable hint that is currently in Russian. Match on `error` and the other fields, never on `message`.

## Running the service

Requires Node 20+ and `npm install` (Patchright). The browser must already be running with its CDP port (Chrome DevTools Protocol) reachable at `--cdp`. With Docker, `docker compose --profile api up -d` runs it inside the browser's network (see [Docker notes](../docker/README.md#http-service); the compose definition has not been started in a container yet).

```sh
node server.js [--host 127.0.0.1] [--port 8787] [--data data] [--cdp http://127.0.0.1:9222] \
               [--sites profiles/sites.json] [--clients profiles/clients.json] [--egress profiles/egress.json] \
               [--tz Asia/Almaty]
```

Environment: `MEATSUIT_HOST`, `MEATSUIT_PORT`, `MEATSUIT_CDP`, `MEATSUIT_TZ`, and optionally `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` for alerts. The service refuses to start without three files: `profiles/clients.json` (who may call; git-ignored; see [authentication](#authentication)), `profiles/sites.json` (which sites exist and their pacing; see [limits](#limits)) and `profiles/egress.json` (the expected exit; see [egress](#egress-check)).

## Routes

| Route | Auth | What it does |
|---|---|---|
| `GET /view` | bearer + `X-Task` | Returns the visible HTML copy of the task's current page. |
| `POST /act` | bearer (+ `X-Task` except for `begin`) | Runs one action or a lifecycle step. |
| `GET /` | none | Status page for the human owner. |

`POST` bodies are always JSON; `Content-Type` is not checked. Bodies over 1 MiB get 400. A wrong method on a route gets 400, and an unknown path gets 404.

## Authentication

Each client (a bot, a script) has a name, a secret token, and the sites it may touch:

```json
[
  { "name": "my-bot", "token": "<output of: openssl rand -hex 24>", "sites": ["jobs.example.com"] },
  { "name": "admin",  "token": "<another one>", "sites": ["*"] }
]
```

- Send `Authorization: Bearer <token>`. A missing or unknown token gets `401`. Tokens are compared by hash in constant time.
- A token must be at least 16 characters with no spaces. Placeholders starting with `CHANGE-ME` and duplicates are rejected at startup.
- `sites` lists host names (subdomains are included). `"*"` means any site that exists in `sites.json`. A site missing from `sites.json` is refused for everyone.
- A task belongs to the client that began it. Another client's token gets `404 no_task` for it.
- After `begin`, every request for that task carries `X-Task: <task id>`.

## Task lifecycle

A task goes `begin`, then any number of actions and `GET /view` calls, then `end`. Each task gets an id such as `t1`.

### begin

`POST /act {"do":"begin", ...}`

| Field | Meaning |
|---|---|
| `site` (required) | A host name or URL. It is matched to a `sites.json` entry (exact name, `www.`, or a subdomain). |
| `task` | Label of at most 100 characters. It appears in the journal and on the status page. |
| `cost` | Whole number from 1, default 1. How many units of the site's budget this task uses. A session of 60 likes sends `cost: 60`. |
| `allow` | Up to 20 extra hosts that `goto` may visit. Each must be covered by the client's `sites`. |
| `wait` | Seconds to wait in the queue, default 60, capped at 300. |
| `ticket` | The `ticket` from an earlier `202`, to keep your place. |

Checks run in this order, and the first failure answers: token (401), request shape (400), site rights (403), queue, exit check (503), pacing limit (429), opening the window.

- **Queue.** One task runs at a time. If the browser is busy, `begin` waits up to `wait` seconds. If the turn does not come, it answers `202 {"ticket":"k1","position":1}`. Send `begin` again with the same body plus `"ticket":"k1"` to keep your place. A ticket without a live request expires after about a minute. A waiter that disconnects is not given the slot.
- **Cost.** A task that can never fit (`cost` above the daily or hourly budget) gets `429` with `reason: "too_big"`. If the window fails to open, the cost is refunded.
- **Window.** The task gets a **new browser window**, so the owner's tabs are untouched. A link with `target=_blank` opens a tab inside the task window, and the task follows it.

### Idle timeout, end, resume

- A task nobody has touched for **5 minutes** is closed automatically, so a crashed bot cannot hold the queue. A running action does not count as idle. Later requests get `404 no_task` with `reason: "idle"`.
- After `409 needs_human` the timeout is 30 minutes, to give a person time to reach the mirror.
- `{"do":"end"}` closes the window and frees the slot.
- `{"do":"resume"}` re-checks the page after a human handled a captcha, block or login. It returns `200 {"ok":true,"guard":null}`, or `409` again if the problem is still there.
- Actions of one task run strictly one at a time, in arrival order. A closed task answers `404 no_task` with `reason` `end`, `idle` or `egress`.

## GET /view

`GET /view[?scope=document|viewport]`, with `Authorization` and `X-Task`. Returns `text/html`. `viewport` keeps only what is on screen. The default, `document`, is the whole page.

The page is a **copy** of what is visible, built in Patchright's isolated JavaScript world. The real page's DOM is never changed, so the page cannot see the numbers.

**Included:** headings, text, lists, tables, `img` with `alt`, links (`href`, plus `data-abs` when the link is relative), buttons, form fields with their labels (`data-label`), `select` with its options. Open shadow roots are read.

**Excluded:** `script`, `style`, `noscript`, `template`, `svg`, `canvas`, `video`, `audio`, anything hidden (`display:none`, `visibility:hidden`, `opacity:0`, zero size, clipped), closed shadow roots, and the content of iframes (only `<iframe src="...">` remains). Invisible Unicode characters (zero-width, bidirectional controls, tag characters) are stripped from text.

**Passwords are never returned.** Fields of type `password`, or with `autocomplete` of `current-password`, `new-password`, `cc-number` or `cc-csc`, have no `value`. File inputs have none either.

**Numbers.** Each interactive element gets `data-ms="N"`: links, buttons, enabled fields, `select`, `[role=button|link|checkbox|...]`, `[tabindex]`, contenteditable, `onclick`, and `cursor:pointer` elements. A number is given only if the element is really on top, so a button under an open modal gets none. Numbers last until the next `GET /view` or a navigation. Within a page they keep growing across views, so an old number cannot silently hit a different element. Using an outdated number answers `410 stale_ref`.

**Head and headers.** The `<head>` carries `url`, `title`, `guard` (`null` or `captcha`, `blocked`, `login`), `scope`, `scroll-y`, `page-height`, `viewport-height`, and `egress` (country and AS number of the last good exit check). The response also has `X-Url`, `X-Guard` (when set) and `X-Egress` headers, plus `Content-Security-Policy: sandbox; default-src 'none'`. `GET /view` still works after a `409`, so you can see the page.

## POST /act actions

| `do` | Parameters | What happens |
|---|---|---|
| `goto` | `url` | Absolute `http` or `https` address, inside the task's site or `allow` hosts (subdomains count). Navigation does not use human timing. A site that does not load gives `502 nav_failed`. |
| `click` | `target` | Scrolls to the element with the wheel (not a jump), moves the mouse along a slightly curved path, may overshoot and correct, clicks near the center, holds the button 45 to 200 ms. |
| `fill` | `target`, `text` | Clicks the field, clears it if it has text, then types. For a `<select>`, moves the mouse over it, focuses it and picks the option with the arrow keys (real key events, so `change` is trusted); if the arrows do not land on the option, it is set directly, which sends synthetic events. The list is not opened. Checked on headless Chromium only, not on a headed Brave. Not a field: 400. |
| `type` | `text` | Types into the focused element, key by key. |
| `key` | `key` | One key such as `Enter`, `Escape` or `Tab`. |
| `scroll` | `px` (not 0, at most 20000 in size, negative scrolls up) or `to` (`"top"` or `"bottom"`) | Wheel notches of 100 with reading pauses. |
| `back` | none | History back. Stays put if there is no history. |
| `pause` | `from`, `to` (ms, default 300 to 1200, at most 60000) | Random pause. |
| `begin`, `end`, `resume` | see above | Lifecycle. |

`text` of `fill` and `type` is at most 5000 characters (`400` above that). Typing is as slow as a person, so a long text takes hours: split it.

**Typing** uses real key events with uneven timing, alternating hands, longer pauses after punctuation, and capital letters via Shift on the opposite hand. It supports the US and Russian (ЙЦУКЕН) layouts. About 2.5 percent of letters get a typo on a neighboring key, which is noticed after 0 to 3 characters, erased with Backspace and retyped. The final field value always equals the requested text. Characters on neither layout (such as emoji) are inserted as text. Speed is a per-browser persona (about 30 to 95 words per minute), saved in `data/persona.json` and shared with warm-up, so give both the same `--data` directory and the browser keeps one "person" across restarts. Typing 1500 characters takes minutes, so use a generous client timeout. Long texts cannot be pasted yet.

**Targets** for `click` and `fill`:

- a **number** (JSON number from the latest `GET /view`);
- a **string**: matched against visible, topmost interactive elements by accessible name (`aria-label`, label text, button or link text, `alt`, placeholder, `title`). Exact match (case-insensitive) first, then substring. A string of digits is text, not a number;
- **`{"css":"..."}`**: visible elements matching the selector. A bad selector is 400.

No match is `404 not_found`. More than one match is `422 ambiguous` with up to 20 candidates (`[{"ref":3,"text":"Buy"}, ...]`), and each `ref` can be used right away as a number.

**Response:** `{"ok":true,"url":"https://...","settled":true,"guard":null}`. After an action the service waits for the page to go quiet (no navigation or requests for about 500 ms, at most 10 s). If it never goes quiet, `settled` is `false`, which is not an error.

## Status codes

| Code | `error` | Meaning |
|---|---|---|
| 200 | | Done. |
| 202 | | `begin` is still queued. Body has `ticket` and `position`. |
| 400 | `bad_request` | Unreadable request, bad parameters, missing `X-Task`, wrong method. |
| 401 | `unauthorized` | No token or an unknown one. |
| 403 | `forbidden` | `reason`: `site_not_allowed`, `site_unknown` (not in `sites.json`), `allow_not_allowed`, or for `goto` `scheme` and `outside_task`. |
| 404 | `no_task` | Task ended, expired, or is another client's (`reason`: `end`, `idle`, `egress`). |
| 404 | `not_found` | Target not found among visible elements, the window is gone, or unknown path. |
| 409 | `needs_human` | `guard`: `captcha`, `blocked` or `login`. The window stays open. All actions are refused until `resume` succeeds. |
| 410 | `stale_ref` | The number is outdated. Read `GET /view` again. |
| 422 | `ambiguous` | Several elements match. `candidates` lists them. |
| 429 | `limit` | `reason` below, plus `retry_at` (ISO time or `null`) and a `Retry-After` header when a time is known. |
| 500 | `internal` | Unexpected error. No details are returned. They are in the journal. |
| 502 | `nav_failed` | The site did not open (30 s timeout or network error). |
| 503 | `egress_wrong` or `egress_unknown` | Exit is not where it should be, or could not be determined. The response may include `country`. |
| 503 | `browser_gone` | The browser disconnected. |

## Limits

Limits live in `profiles/sites.json`, one entry per site. Each fires at `begin`, so a refused task never touches the browser. Counters are stored in `data/limits.json` and survive restarts.

```json
{
  "jobs.example.com": {
    "perDay": 15, "perHour": 3, "hours": "10-21",
    "ramp": { "days": 14, "startShare": 0.3 },
    "restDaysPerWeek": 1, "jitter": 0.2, "challengePauseDays": 3
  },
  "social.example.org": { "perDay": 0 }
}
```

| Field | Meaning |
|---|---|
| `perDay` | Units per local day. **`0` closes the site**: bots do nothing there. |
| `perHour` | Units in any rolling hour. |
| `hours` | Allowed window, `"from-to"` in 24-hour local time. |
| `ramp` | `{days, startShare}`. Day limit is `perDay * (startShare + (1 - startShare) * min(1, d / days))`, rounded up, at least 1. `d` counts days since the first successful `begin` on the site. |
| `restDaysPerWeek` | That many random rest days per week (Monday start). The choice is deterministic per site and week, so a restart does not change it. |
| `jitter` | The day limit is multiplied by a factor in `[1 - jitter, 1 + jitter]`, fixed for that day, so `perDay` becomes an average, not a maximum. |
| `challengePauseDays` | After a `409 needs_human`, the site is frozen until the start of the local day plus this many days (default 3). A repeat only extends the pause. |

A refusal is `429` with `reason`: `closed`, `too_big`, `hour`, `day`, `hours`, `rest_day` or `challenge_pause` (on `begin`), or `actions` (during a task, see below). `retry_at` is the first moment a `begin` would really pass every rule, or `null` if it never will at this cost.

**Actions per task.** The limits above count tasks, and `cost` is whatever the client declares, so a script stuck in a loop could click without end inside one task. Each task therefore has a ceiling on `goto`, `click`, `fill`, `type` and `key` actions (scrolling, `back` and `pause` are free): `100 + 30 × cost` by default. Past it the service answers `429` with `reason: "actions"`, closes the window, frees the queue and sends the Telegram alert. If a task really needs more, declare a larger `cost` in `begin`. The defaults are the author's guesses, not measured.

**The numbers are the author's untested starting values.** Platforms do not publish thresholds for account behavior. Tune them for yourself and treat them as a way to behave moderately, not as a guarantee.

**Time zone.** Day boundaries and `hours` use one zone for the whole service: `--tz` or `MEATSUIT_TZ`, an IANA name such as `Europe/Berlin`. The default is `Asia/Almaty` (the author's zone), so **set yours**. An unknown name stops the service at start. Pick the zone of the place your exit is in, since that is where the account "lives". The flag is covered by unit tests of argument parsing; it has not been run against a live service in another zone.

## Egress check

`profiles/egress.json` states where traffic should appear to come from, for example `{"country":"DE","asn":[64500]}`. `asn` is the number of the internet provider's network. It is compared by number, not by name. If `asn` is empty, only the country is checked.

The service asks an echo service (`ipinfo.io`, with `ipwho.is` as a fallback) from the same network as the browser, so run it where the browser's traffic runs. The check runs at startup, on every `begin`, and every 5 minutes. A good or wrong result is cached for a minute, and an undetermined one is not cached.

It fails closed. A wrong country or provider gives `503 egress_wrong`. A failed lookup gives `503 egress_unknown`. If the exit is lost during a task, the window is closed, the task ends, and a request in flight gets `503 egress_wrong`. Changes of state send one Telegram message. A brief outage closes the running task too, because there is no retry window yet. See [egress](egress.md) for how to set up the exit node itself.

## Status page and journal

`GET /` needs no token and refreshes every 15 seconds. It shows the queue (client, task label, site), per-site usage against the effective limit with a state of open, closed, rest day or paused, the latest exit check, and the last 30 journal lines. The text is currently in Russian. It never shows page content, typed text, tokens, page URLs or your IP address.

`data/journal.jsonl` gets one JSON line per event: `begin`, `act`, `end`, `guard`, `limit`, `challenge`, `egress`, `auth`, `notify`, `error`, each with time, client, task, site and result. A failed `GET /view` is logged as `view`. For a `goto` it records only host and path, with no query or fragment. For `click` and `fill` it records the target text (first 60 characters). For `key` it records names such as `Enter`. **Typed text is never written**, and error details are scrubbed of it.

## Security notes

- A valid token lets its holder drive a browser that is signed in to your accounts. **Listen only on localhost or a private network such as a tailnet.** The default is `127.0.0.1`. There is no TLS and no HTTP rate limit. Never expose the port to the internet.
- The CDP port must stay internal to the container network.
- `goto` is limited to `http` and `https` and to the task's site plus `allow`. Tests cover `file:`, `chrome:`, `javascript:`, `data:`, look-alike hosts and `127.0.0.1:9222`.
- Page text from `GET /view` is third-party data. If you give it to a language model, treat it as untrusted. The service strips invisible characters but cannot judge intent.
- Passwords are never returned, and typed text never reaches the journal. A target such as `{"do":"fill","target":"Password",...}` is logged by its target text, so do not use a secret as a target.

## Examples

Examples assume `MS=http://127.0.0.1:8787`, `H="Authorization: Bearer $TOKEN"`, and a `jobs.example.com` entry in `sites.json` and in the client's `sites`.

**1. A full task.**

```sh
curl -s -H "$H" -d '{"do":"begin","task":"my-bot:apply","site":"jobs.example.com","cost":1}' $MS/act
# {"task":"t1"}
curl -s -H "$H" -H "X-Task: t1" -d '{"do":"goto","url":"https://jobs.example.com/vacancy/1"}' $MS/act
# {"ok":true,"url":"https://jobs.example.com/vacancy/1","settled":true,"guard":null}
curl -s -H "$H" -H "X-Task: t1" $MS/view
curl -s -H "$H" -H "X-Task: t1" -d '{"do":"fill","target":"Cover letter","text":"Hello, ..."}' $MS/act
curl -s -H "$H" -H "X-Task: t1" -d '{"do":"click","target":3}' $MS/act
curl -s -H "$H" -H "X-Task: t1" -d '{"do":"end"}' $MS/act
# {"ok":true}
```

The `GET /view` reply looks like this (shape taken from `view.js`, abridged):

```html
<head><meta name="egress" content="DE AS64500">
<meta charset="utf-8">
<title>Frontend developer</title>
<meta name="url" content="https://jobs.example.com/vacancy/1">
<meta name="guard" content="null">
<!-- also: scope, scroll-y, page-height, viewport-height -->
</head>
<body>
<h1>Frontend developer</h1>
<label for="letter">Cover letter</label>
<textarea data-ms="2" id="letter" name="letter" data-label="Cover letter"></textarea>
<button data-ms="3" type="submit">Apply</button>
</body>
```

**2. The browser is busy.**

```sh
curl -si -H "$H" -d '{"do":"begin","task":"other:like","site":"jobs.example.com","wait":0}' $MS/act
# HTTP/1.1 202 Accepted   {"ticket":"k1","position":1}
curl -s -H "$H" -d '{"do":"begin","task":"other:like","site":"jobs.example.com","wait":30,"ticket":"k1"}' $MS/act
# once the other task ends: {"task":"t2"}
```

**3. A captcha appears during task `t1`.**

```sh
curl -si -H "$H" -H "X-Task: t1" -d '{"do":"click","target":3}' $MS/act
# HTTP/1.1 409 Conflict   {"error":"needs_human","guard":"captcha"}
# The window stays open. The owner gets a Telegram message (if configured) and solves it in the mirror.
curl -s -H "$H" -H "X-Task: t1" -d '{"do":"resume"}' $MS/act
# {"ok":true,"guard":null}      (or 409 again if it is not solved)
# The site is now paused for challengePauseDays: a new begin for it gets 429, reason "challenge_pause".
```

**4. Refusals worth handling.**

```sh
# Ambiguous text:
curl -s -H "$H" -H "X-Task: t1" -d '{"do":"click","target":"Buy"}' $MS/act
# HTTP 422  {"error":"ambiguous","message":"...","candidates":[{"ref":3,"text":"Buy"},{"ref":9,"text":"Buy"}]}
curl -s -H "$H" -H "X-Task: t1" -d '{"do":"click","target":9}' $MS/act

# Over the hourly budget (perHour is 2 and two units were used at 07:00 UTC):
# HTTP 429  Retry-After: 3600
# {"error":"limit","reason":"hour","retry_at":"2026-10-05T08:00:00.000Z"}
```

A caller should treat `429` and `503` as "defer this task and try again later". The service neither retries nor stores anything for you.
