# The core contract: caller ↔ meatsuit

meatsuit is launching a browser, remembering its session, and eyes and hands. It shows the page and runs
commands; the caller (its model) decides, meatsuit decides nothing. Credentials (tokens, keys, site passwords) come
from the caller as arguments and callbacks: the core does not read the environment and sends nothing anywhere by itself.

The sections describe what the code does now. What is not verified and what is missing is under "Limitations".
Russian version: [04-contract.md](04-contract.md); the two change together.

## What the core is

| Where | What |
|---|---|
| repository root | the library: `index.js` (`connect`/`task`), `eyes.js` and `dom.js` (the snapshot), `hands.js` (commands), `human.js` and `human/` (mouse, wheel, keyboard, habits), `guard.js`, `supervise.js`, `limits.js`, `window.js`, `capture.js`, `telegram.js`; `sites.example.json`; tests in `npm test` |
| `tools/` | programs for a human: `init.js` and `config-ui.js` (the deploy file), `live-check.js` (the acceptance check), `secret-scan.sh` and `hooks/`, `save-tab.js` (save the open tabs into the archive), `telegram-chats.js` (find a group's chatId) |
| `docker/` | the mirror: a browser in Neko (Google Chrome by default, or Brave) that callers reach over CDP; the profile lives in a volume ([docker/README.md](../docker/README.md)) |
| `extras/` | maintained services around the core: the HTTP service (`GET /view`, `POST /act`), warm-up (`life*`), the egress check (`egress`), the queue, `notify`, owner presence, the browser lock and `selfcheck`. Developed and tested (`npm --prefix extras ci`, then `npm run test:extras`). The core takes nothing from `extras/` (checked by `test/api.test.js`) |

## Using it

CommonJS, Node 20+, depends on `playwright-core`. Not on npm: callers install it from a checkout (`npm install ../meatsuit`, a `file:` dependency). `package.json` has `"main": "index.js"` and no `exports` field,
so nested modules are reachable too (`require('meatsuit/hands.js')`, `require('meatsuit/telegram.js')`).
The export is a literal `module.exports = { … }`, so ESM projects can import the names from it directly.

```js
const {
  connect,                                            // entry point
  hands, replay,                                      // hands on your own page; replaying a recording
  signature, normalizeName, urlPattern,               // screen signature (archive)
  NeedsHuman, LimitReached, BudgetExceeded, BadCommand, StaleElement, FieldMismatch, // errors
  telegramNotifier, createTelegram, findChats, TelegramError,       // Telegram helper
  peek,                                               // what is left of a site's limit, without spending a slot
  holdState, releaseHold,                             // a site's hold after NeedsHuman: read it, lift it
} = require('meatsuit');
const { validate } = require('meatsuit/hands.js');   // checking a command without a browser:
// validate(command, allowedHosts = [], { uploadDirs = [] } = {}) — throws BadCommand
```

The export list is pinned by a test (`test/api.test.js`) and changes only together with the callers.

## connect and task

```js
const ms = await connect({ cdpUrl, sitesFile /* or sites */, dir?, notify?, notifyOn?, ownerPresent? });
const result = await ms.task(name, async ({ see, act }) => { ...; return value; },
  { site, extraHosts = [], uploadDirs = [], maxCommands = 60, maxMinutes = 10, dryRun = false,
    dryRunNavigation = false, readOnly = false, capture?, codeLogin = false });
await ms.close();
```

| Parameter | Meaning |
|---|---|
| `cdpUrl` | the CDP address of the shared browser; required |
| `sitesFile` or `sites` | the **caller's** site limits: the path to its `sites.json` (read for every task, so an edit applies without a restart) or an object of the same shape. Exactly one of the two; with neither, with both, or with a missing file `connect` fails before it touches the browser. Sample: `sites.example.json` |
| `dir` | the per-site queue locks `queue/<key>.lock`, the counters `limits.json`, the journal `journal.jsonl`, the human's habits `persona.json`, the tab marks `tabs.json`, the site holds `holds/`, the owner's wheel `wheel.json` and the short locks `state.lock` around the shared files and `wheel.lock` around the wheel; `~/.meatsuit` by default. **All callers of one browser must pass the same `dir`**: otherwise their locks differ, two bots enter one site at once, and the owner's wheel stops only some of them. With the mirror from `docker/` this is the `state/` folder in the `meatsuit_profile` volume (see "Attaching to the mirror") |
| `notify(text, event)` | the caller's async notification function. A failed send does not fail the task; it goes to stderr |
| `notifyOn` | which events to send: `'start'`, `'done'`, `'limit'`, `'error'`, `'needsHuman'`; by default `['needsHuman', 'limit', 'error']` |
| `ownerPresent` | optional: the caller's async function telling whether the owner holds the controls in the mirror, returning `true`, `false` or `{ present }` (the `check()` of `extras/presence.js` fits as is; the Neko admin password stays with the caller). Asked every 2 seconds while the connection lives. A "yes" puts the owner's wheel on for every caller of the same `dir`, see "The owner at the wheel". A function that throws counts as "no"; not a function is an error before the browser. With the mirror from `docker/` not needed: its `wheel` service does this for every caller |
| `site` | the site's host, its key in `sites.json`; `goto` is limited to it as well |
| `uploadDirs` | an array of absolute paths to directories `upload` may take files from (CVs, letters). Without it `upload` is a `BadCommand`. A wrong shape is an error before the queue and the browser |
| `extraHosts` | an array of hosts (`['company.com']`, no scheme, path or `*`) where the page may end up without a stop: a "thank you" page on the company's own site after an ATS form. Subdomains too. `goto` there is not allowed; limits and counters go by `site`; guard (captcha, sign-in, block) works there too. A wrong shape is an error before the queue and the browser |
| `maxCommands`, `maxMinutes` | the task's budget; the ceiling comes from the site (`sites.json`), the caller may choose less. `maxMinutes` is checked before each command; a task still running 15 minutes after it (a page that does not answer, the caller's own await that hangs) is ended by meatsuit: `BudgetExceeded`, the window is closed (after `NeedsHuman` it stays for the human), the queue is free |
| `dryRun`, `dryRunNavigation` | a rehearsal, see "Hands" |
| `readOnly` | the task only reads: it spends `perHour` but not `perDay`, and `perDay` does not stop it. The first writing command (`fill`, `type`, `select`, `upload`, `press Enter`, a `click` not on a `tab`) counts a full day slot before it runs; if the day is used up, that is `LimitReached` (`before: true`) and the command does not run. With a split budget (`readsPerHour` in `sites.json`) every task starts on a read slot, and `readOnly` changes nothing |
| `capture` | the screen archive `{ dir, htmlPerSignature = 5, maxMB = 500 }`; nothing is written without it |
| `codeLogin` | `true` means the task signs in with a one-time code (see "Code sign-in" below). The site also needs its own `sites.json` entry with `codeLogin`; without it, with a malformed rule, or with a value other than `true`/`false` it is an error before the queue and the browser |

`task` in order: a site on hold throws `NeedsHuman` with `onHold: true` right away (see "Site hold") → waits while
the owner holds the wheel → joins **its site's** queue (one bot at a time per site; the lock file works across
processes) → checks the site's limit and records the task (with `readsPerHour`, a read slot; `dryRun` spends no slots) → opens a window of its own (with
`singleTab`, takes the site's tab) → calls the function under guard and the budget → closes the window. On
`NeedsHuman` the window stays open for the human to handle in the mirror. New tabs the page opens are closed. Returns
what the function returned.

### Several bots in one browser

One warmed browser serves several bots at once (tinder-matcher, cvs, a Telegram sensor; in different processes or in
one): **the queue is per site**, shared by all callers of one `dir`.

- Tasks on **different sites run at the same time**, each in its own page: a new window of its own, opened in the
  background (`Target.createTarget` with `newWindow` and `background`, so it does not take the screen focus), or with
  `singleTab` the site's own tab, found by the task's host and its subdomains. A task never takes, snapshots or closes
  another site's page, nor a page where another task is working: a `singleTab` search skips a tab on its host that a
  running task holds (one that got there through that task's `extraHosts`). Tasks of the same process know their pages;
  a task of another process is known by the CDP target id of its window, which every task writes into its queue lock
  `queue/<key>.lock` (a lock not refreshed for 30 seconds counts as abandoned). A task's commands go over CDP to its
  own page (keys into that document's focused element, the mouse into that page), so they do not depend on which
  window has the focus on the screen. The core brings a page to the front in one case only: the window or tab left to the human after `NeedsHuman`, so it need not be searched for in
  the mirror, and only while the wheel is free.
- Tasks on **one site run one at a time**, in the order they get the lock. A site and its subdomains share one queue:
  the key is the last two labels of the host (`web.telegram.org` and `telegram.org`, `www.linkedin.com` and
  `linkedin.com`), because a `singleTab` task finds tabs by subdomain too. Sites under a shared suffix such as `co.uk`
  get one queue as well: more waiting, never two tasks in one tab. An IPv4 address or a single label (`localhost`) is
  its own key. Limits and holds still go by the exact `site`.
- A task waits for its site's queue up to 30 minutes; if the site is still busy, `task` throws `LimitReached` ("queue
  <key>: busy with task «…» (site) since HH:MM") without touching the browser or spending a slot, so the caller treats
  it like a limit and retries later, not as its own failure. While `fn` runs, the other tasks of that site wait,
  including while your own code waits for a model: put timeouts on your own awaits inside `fn` (`maxMinutes` is checked
  before each `see`/`act`, not while your code is waiting). A task still running 15 minutes after its `maxMinutes` is
  ended by meatsuit, so one hung task cannot hold its site forever.
- **The owner's wheel is one for the whole browser** (below): while the owner holds it, no task of any site starts, no
  command starts, and a `fill` or `type` that is already typing stops within about 2 seconds. Site holds and limits
  stay per site.
- The shared files of `dir` (`limits.json`, `tabs.json`) are read, changed and written under a short lock
  `state.lock`, so tasks of different sites writing at once lose nothing; `limits.json` is replaced as a whole, a
  reader never sees half of it. If `state.lock` is not free within 60 seconds (a process hung while holding it and
  still refreshes it), `task` throws `LimitReached` whose text names `state.lock`. Several tasks may share one `capture.dir`: each snapshot takes its number by creating
  the file (`html-counts.json` may then count a little less than was saved).
- Tested in headless Chromium and with two to four Node processes on one browser (`test/parallel.test.js`), and
  measured once in a throwaway local Neko mirror on 8 November 2026 (image `google-chrome:3.1.6`, Chrome 154, openbox;
  no network, no volumes; the owner's typing simulated with `xdotool`): two tasks typed at once, each text arrived
  whole in its own field whichever window had the focus. Without `background` every new task window took the screen
  focus, and the letters the owner was typing went into a bot's field; with it, opening a window changed nothing, but
  **a bot's click still activates its window** (Chrome does that on a mouse press), so the owner's letters again went
  into a bot's field. With the wheel held, all 20 of the owner's letters stayed in his field and the active window
  never changed; after he gave the wheel back both bots ran at once; a captcha stop brought its window to the front.
  So: bots do not disturb each other, but they do disturb an owner who types — tell them with the wheel. **Not
  verified:** a real keyboard through the Neko web client, the owner's server, and how several windows at once feel on
  a weak CPU.

**Updating from the version with one queue for the whole browser.** That version kept one lock `<dir>/queue.lock`. A
task of this version looks at it once, right after it has taken its site's lock: if `queue.lock` exists at that
moment (a caller not yet updated is running a task), the task waits until it can take it and gives it back at once,
then runs. That is a snapshot, not a hold: an old-version task that takes `queue.lock` a moment later runs alongside.
The old version knows nothing of the per-site locks either, so its task may start while tasks of this version run, on
the same site too. Update all callers of one `dir` together (rebuild their images). Callers change nothing in their code: the same
`connect` and `task`; tasks on different sites now simply overlap.

### The owner at the wheel

While the owner works in the mirror himself, bots wait: a bot's click activates the bot's window, and the letters the
owner is typing then land in the bot's field (measured, see above); a site would also see two hands. The wheel is the
file `<dir>/wheel.json` (`{ by, since, until }`, ms), in force while `until` is ahead; a damaged file counts as no
wheel.

```js
const { wheelState, takeWheel, releaseWheel } = require('meatsuit/wheel.js');
await takeWheel({ dir, minutes = 60 });   // the owner takes it: → { by: 'owner', since, until }; a longer wheel is not shortened
await releaseWheel({ dir });              // → { released }
wheelState({ dir });                      // → { by, since, until } or null
```

`takeWheel` and `releaseWheel` are async: they read, decide and write the wheel under a short lock `<dir>/wheel.lock`,
so a "yes" of the mirror from one process and the owner's `take` from another at the same moment do not overwrite each
other (the owner's wheel turned into a `mirror` one would be removed by the next "no"). Locks are taken in one order: a
site's queue lock first, then `wheel.lock` or `state.lock`; each of those two is held for one read and one write, with
nothing taken under it, and they are never held together.

From a shell: `node tools/wheel.js take [minutes] [--dir …]`, `give`, or without a command the state (`--dir` defaults
to `MEATSUIT_DIR`, else `~/.meatsuit`). With `connect({ ownerPresent })` the core asks the caller's function every 2
seconds for as long as the connection lives (from `connect` until `close()` or a lost connection to the browser), also
while that caller has no task of its own, and at most as often when a task waits or types; "yes" writes the wheel
`by: 'mirror'` for 30 seconds and renews it while the answer is yes, "no" withdraws only this caller's own "yes" (never
a wheel the owner took by hand). So one connected caller that knows about Neko stops every caller of the same `dir`, busy or idle;
if it stops running, its last "yes" holds the others for at most 30 seconds. The timer does not keep the caller's
process alive. A caller in the mirror's network reaches Neko at
`127.0.0.1:8080`; the admin password is its own setting:

```js
const { createPresence } = require('meatsuit/extras/presence.js'); // fetch only, no dependencies of extras/
const presence = createPresence({ url: 'http://127.0.0.1:8080', password: nekoAdminPassword });
const ms = await connect({ cdpUrl, dir, sitesFile, ownerPresent: () => presence.check() });
```

With the mirror from `docker/` a caller needs neither `ownerPresent` nor the admin password: the `wheel` service of
that stack (`extras/wheel-watch.js`) asks Neko every 2.5 seconds and keeps the wheel by the same rules — `by: 'mirror'` for 30 seconds, renewed while the owner
holds control, removed when he does not, a wheel taken by hand never shortened or removed. When Neko does not answer it
writes nothing, so its wheel lapses within 30 seconds.

The mirror wheel has several sources (the `wheel` service, the `ownerPresent` of each `connect`), and each keeps its own
"yes" with its own 30 seconds inside `wheel.json`. A "no" withdraws only the "yes" of the source that says it; the wheel
is free once no source's "yes" is still in force. So sources that disagree do not take the wheel from each other: the
service renewing it while a caller's `ownerPresent` failed (which the core counts as "no"), or the other way round,
keeps the bots waiting. `node tools/wheel.js give` (without `by`) removes the wheel whatever its sources. Callers pass
only the shared `dir`; the admin password stays in
the mirror's stack ([docker/README.md](../docker/README.md#the-owners-wheel-from-the-mirror)). `ownerPresent` remains
for a browser without that service.

- Before the queue: a task does not join its site's queue and opens no window while the wheel is held. The wheel
  taken while it waited for the lock: the lock is given back and it waits outside.
- In a running task: `act()` waits before each command; `see()` does not wait (it presses nothing). The window and
  the site's queue stay with the task. Time at the wheel does not count towards `maxMinutes`, nor towards the hang
  guard.
- In a running command: a `fill` or `type` that is already typing looks at the wheel between keys, at most every 2
  seconds, and stops when it is taken: `LimitReached` with `.wheel` and **without** `.before` (part of the text is in
  the field), `notify('limit')`. Enter into that field is then refused with `FieldMismatch` until it holds what the bot
  typed (see "The field after typing"), so half a message is not sent. Any other command already started (a click with
  its mouse path, a scroll, a `wait` up to 15 s) finishes first; it takes seconds.
- At most 30 minutes per wait, then `LimitReached` with `.wheel` (the wheel's state): before the queue the task did
  not start (no window, no slot), from `act()` with `.before = true`, the command did not run. `notify('limit')` both
  times.

### sites.json

```json
{ "example.com": { "perDay": 20, "perHour": 6, "hours": "10-23", "maxCommands": 80, "maxMinutes": 15 },
  "example.org": { "perDay": 0 },
  "*":           { "perDay": 3, "perHour": 2, "hours": "9-21", "maxCommands": 80, "maxMinutes": 12 } }
```

- The rule is looked up by the exact `site` key. The optional `"*"` is the rule for hosts not in the file; counters
  are still per host. An explicit entry replaces `"*"` entirely and is not merged with it.
- Without `"*"` an undescribed host gives `LimitReached`. A subdomain of a described site does not fall under `"*"`.
  `site: '*'` is an error.
- `perDay: 0` closes the site. `hours` are working hours in the process's time zone (`TZ`).
- `singleTab: true` means the site keeps one active tab: the task runs in the already open tab of that site and does
  not close it; guard checks the tab before a slot is spent (a captcha left to the human is not touched).
  `singleTab` is read **only from the `sites.json` rule** (the site's own entry or `"*"`); `task` has no option of
  that name, and passing `task(..., { singleTab })` changes nothing.
- `staleTabHours` (default `48`, `0` turns it off) applies with `singleTab` only. With several tabs of the site, the
  working tab is the one on screen, otherwise the one with the latest activity. Before a task, the other tabs of the
  site with no activity for longer than `staleTabHours` hours are closed. Activity is: a task ran in the tab, its
  address or title changed, it is on screen (`visibilityState`); a tab the core sees for the first time gets "now".
  Never closed: the working tab, a tab on screen, one with a captcha, sign-in or block page, one with text typed in
  a field, one still loading; with `dryRun` nothing is closed. The marks live in `<dir>/tabs.json` (CDP target id →
  a hash of address and title, and the time); nothing changes on the page. A closed tab is a journal line
  `cmd: { cmd: 'closeTab' }` with `url` without query and hash and `idleHours`. Activity is seen only at checks
  (once per task).
- `codeLogin: { "path": "^/account/login", "maxMinutes"?: 6 }` is the path where a task with
  `task(..., { codeLogin: true })` may go through a one-time-code sign-in. It is read **only from the site's own
  entry**, never from `"*"`.
- `holdHours` (default `6`, `0` means no hold) is how many hours the site stays on hold after a `NeedsHuman`; see
  "Site hold".
- `readsPerHour` (and, optionally, `readsPerDay` as a safety net) splits the site's budget into reads and writes. Without
  it everything is as above: `perHour` counts every task, `perDay` the writing ones. With it:
  - every task starts on a **read** slot: `readsPerHour` and `readsPerDay` count task starts, and `readOnly` changes
    nothing;
  - the first writing command of a task (`fill`, `type`, `select`, `upload`, `press Enter`, a `click` not on a `tab`)
    takes a **write** slot before it runs, under `state.lock`: `perHour` and `perDay` now count these only. One per
    task, however many writes follow. With the write budget used up (or outside `hours`) that command throws
    `LimitReached` with `budget: 'write'`, `before: true` and `freeAt`, nothing reaches the page, `notify('limit')`
    goes out, and the task's next writing command asks again;
  - the read slot is not given back when the task writes (the read did happen): a writing task costs one read and one
    write;
  - `hours`, `perDay: 0`, holds and `NeedsHuman` apply to both as before; `dryRun` spends neither;
  - `readsPerDay` without `readsPerHour`, or a value that is not a number ≥ 0, is an error before the queue and the
    browser.
  The owner's values for a dating chat: `{ "readsPerHour": 30, "readsPerDay": 250, "perHour": 6, "perDay": 20 }`
  (`chat.example.net` in `sites.example.json`). Tested in headless Chromium and with four processes writing one
  `limits.json` (`test/budgets.test.js`).

### Site hold after NeedsHuman

Any `NeedsHuman` of a task (the core's guard — captcha, sign-in, block, leaving the site — or one thrown by the
caller's code) puts **this site on hold** for `holdHours` hours. While it holds, `task` for the site throws
`NeedsHuman` with `onHold: true` right away: it does not wait for the queue, touches no tabs or windows, spends no
slot and **sends no `notify`** (that was sent when the hold was set). Other sites of the same browser keep working.
The hold applies to `dryRun` too. A solved captcha does not lift it: the human does, or the time runs out. After that
the next task runs as usual; if the captcha is still on the tab, guard gives `NeedsHuman` and a new hold again, so it
works as a reminder every `holdHours`.

```js
const h = holdState(site, { dir? });              // → { site, reason, url, since, until } (ms) or null
const { released } = releaseHold(site, { dir? }); // lift it early; released — whether a hold was in force
```

No browser and no queue; `dir` is the same as for `connect` (`~/.meatsuit` by default). From a shell:
`node tools/release.js <site> [--dir …]` (without a site it lists the holds; `--dir` defaults to `MEATSUIT_DIR`, else `~/.meatsuit`; `connect` does not read that variable,
so the `NeedsHuman` message of a held task prints the command with its own `--dir`).
The `NeedsHuman` that set the hold carries `.hold` as well, with the time the site is held until (`until`). The files
are `<dir>/holds/<site>.json`; their format is not part of the contract.

### Code sign-in (codeLogin)

A sign-in page is normally a stop. There is one narrow exception for signing in with an SMS code (the caller gets
the code from the human, for example through remora `/ask`, and fills it in itself). The "sign-in page" stop is
lifted only when all of these hold:

1. the task asked for it: `task(name, fn, { site, codeLogin: true })`;
2. the site has its own entry in the caller's `sites.json` with `codeLogin.path`, a path regex anchored with `^/`
   (one path, for example `"^/account/login"`; `"^/"` or an unanchored path is an error);
3. the address is `https` on the `site` host or its subdomain (not on `extraHosts`), and its `pathname` matches
   `path` (the query is not considered);
4. the page has no password field (`inputType: 'password'` or a field named "password"/«пароль»).

The guard order is unchanged: captcha → block or "suspicious activity" → sign-in. A captcha, a block, a page off the
site, a password field, another path or another site are `NeedsHuman`, as without `codeLogin`. The task's budget is
cut: at most 20 commands and no longer than `codeLogin.maxMinutes` (if set; the site's `maxMinutes` ceiling still
applies). The typed code does not get into the journal (`fill` is logged as a length, addresses without query and
hash). meatsuit never types a password: the caller passes only the identifier (a phone or an email) and the code.

### peek: what is left of a limit, without spending a slot

```js
const st = peek(site, { sitesFile /* or sites */, dir?, now?, readOnly? });
// → { site, rule, ok, reason, usedDay, usedHour, leftDay, leftHour }
// with readsPerHour, two more:
//   reads:  { ok, reason, usedHour, usedDay, leftHour, leftDay, freeAt }
//   writes: { ok, reason, usedHour, usedDay, leftHour, leftDay, freeAt }
```

For checks before a run and for reports: no browser, no queue, `limits.json` is not written. `sitesFile`/`sites`
and `dir` are the same as for `connect` (with the same limit-file errors). `rule` is the site's rule (its own or
`"*"`; `null` means no such site); `ok` means a task would start now; `reason` is the `LimitReached` text it would
not start with (outside hours, day or hour limit, `perDay: 0`, no such site), otherwise `null`. `usedDay` counts
writing tasks since local midnight, `usedHour` counts all tasks (`readOnly` too) in the last hour; `leftDay`/`leftHour`
are how many more are allowed (`null` means no limit, `0` means no such site). `readOnly: true` works as in `task`:
`perDay` does not stop it. A malformed rule (for example `hours`) throws, as in `task`. Do not import the internal
`meatsuit/limits.js`: its format is not part of the contract.

With a split budget (`readsPerHour`) the fields above stay: `ok` and `reason` say whether a task would start now (a
read slot), and `usedDay`, `usedHour`, `leftDay`, `leftHour` keep meaning what `perDay` and `perHour` count, which is
then writes only. `reads` is the read budget (`readsPerHour`, `readsPerDay`; task starts) and `writes` the write
budget (`perHour`, `perDay`): `ok` and `reason` say whether the first write of a task started now would get its slot;
`left*` is `null` without that limit. `freeAt` is when (ms) the next slot frees up, given `hours` and the day and hour
windows and no new tasks: `null` when a slot is free now (`ok: true`) or when time alone never frees one (a limit of
`0`, `perDay: 0`). Without `readsPerHour` the result is exactly as before, without `reads` and `writes`.

### Errors

| Error | When | What the caller should do |
|---|---|---|
| `LimitReached` (`.wheel`, `.before`) | the site is not in `sites.json` (and there is no `"*"`), `perDay: 0`, outside hours, day or hour limit; the site's queue stayed busy with another task for 30 minutes (the text names that task and site); the owner held the wheel for 30 minutes (`.wheel`; from `act()` with `before: true`, the command did not run); the owner took the wheel in the middle of a `fill` or `type` (`.wheel` without `.before`: part of the text was typed); the short lock `state.lock` or `wheel.lock` stayed busy (the text names it). With a split budget (`readsPerHour`) also `.budget` and `.freeAt`: `budget: 'read'` when the task did not start (no read slot), `budget: 'write'` from the first writing command (no write slot, `before: true`: the command did not run, nothing reached the page); `freeAt` is when a slot frees up (ms) or `null` | do not start the task, retry later (with `freeAt`, not before it); after a cut `fill`, fill the field again rather than pressing Enter |
| `NeedsHuman` (`.reason`, `.url`, `.before`, `.hold`, `.onHold`) | a captcha, a sign-in page (except the declared path of a `codeLogin` task), a block, leaving the site's host (and not to `extraHosts`); the site is on hold (`onHold: true`) | stop; the window is open for the human. The site goes on hold (`.hold.until`); `onHold: true` means the task never started: not a failure, and no reason to retry before `until`. The state is not cleared until the task ends. From `act()`: with `before: true` the stop came from the check before the command and **the command did not run**; without it the command ran and the stop is about the page after it (a message may be out, a form sent) |
| `BudgetExceeded` | more than `maxCommands` commands or `maxMinutes` minutes | treat the task as failed |
| `StaleElement` | `gen` is out of date, the element is gone, something other than the target is under the cursor before the press, focus moved | take a fresh snapshot |
| `FieldMismatch` (`.cmd`, `.id`, `.expectedLength`, `.actualLength`, `.diffAt`, `.before`) | after `fill` or `type` the field does not hold the text (someone typed along with the bot, or the page changed the input); `type` or `Enter` into a field that no longer holds what the bot typed (`before: true`: nothing typed or pressed). Lengths only, never the text | do not retry blindly: tell the owner, or check the field with `see()`; see "The field after typing" |
| `BadCommand` | a command outside the set or with bad fields; a wrong `within`, `tree`, `items` or `textLimit` of `see()` | a bug in the caller's code or the model |

## Attaching to the mirror

The mirror from `docker/` (see [docker/README.md](../docker/README.md)) keeps fixed names:

- the container `meatsuit-browser`: a caller attaches with `network_mode: "container:meatsuit-browser"` and
  `cdpUrl: 'http://127.0.0.1:9222'` (CDP is not published outside);
- the volume `meatsuit_profile` (a fixed `name:`; its root and its `state/` folder belong to uid 1000; created with
  either browser). Callers mount it as `external` and keep the shared `dir` in its `state/` folder:
  `connect({ dir: '<mount point>/state' })`. The bot process writes to `state/`, so it runs as uid 1000 (the `node`
  user in Node images) or as root. The Chrome profile lives in the same volume: mount it only where needed, and
  read-only where nothing has to be written.

## Eyes: `see(opts?)`

```js
const snap = await see();                                    // a full snapshot
const snap = await see({ screenshot: true });                // + a JPEG q60 in base64
const snap = await see({ settle: { minElements, quietMs, timeoutMs } }); // wait for an SPA to render (up to 15 s)
const diff = await see({ since: prevSnap });                 // changes only
const snap = await see({ within, tree, items, textLimit });  // + reading on request, see below
```

The snapshot: `{ gen, url, title, text (up to 6000), textParts?, elements[{ id, role, name, inView, value?, checked?,
disabled?, focused?, selected?, href?, inputType?, options?, optionsTotal? }], dialogs[{ name, text, elements }],
frames, hiddenFrames, screenshot? }`. `id` numbers are valid only within their `gen`; every command produces a new
`gen`. A password field's value is never returned. Open shadow roots are included; closed ones and the contents of
cross-origin iframes are not (only their addresses, in `frames`).

Fields by kind of element:

| Element | `role` | What else |
|---|---|---|
| input, `textarea`, `contenteditable` | `textbox` | `value` is the first 80 characters of the value |
| `<select>` | `select` | `value` is the **label** of the selected option (several are joined with commas); `options` are the option labels in order, up to 100; with more options, `optionsTotal` (the total) |
| password field | `textbox` | `inputType: 'password'`, no `value` |
| file field `<input type=file>` | `button` | `inputType: 'file'`; `value` is the attached file names joined with commas (`''` while nothing is attached), which shows that the CV went in. A hidden field (`display:none`, `hidden`, `opacity:0`) or one covered by its own label is in the snapshot if its label (`label for` or a wrapping label) or a button in the same parent is visible: `inView` comes from that, `name` is its own or the label's |

The result of `see()`/`act()` goes through guard: a captcha (iframes included, except an invisible reCAPTCHA), a
sign-in page (except a code sign-in, see "Code sign-in") or a block → `NeedsHuman` instead of the result. Before a
command that touches the page (`click`, `fill`, `type`, `press`, `select`, `upload`) the page is checked once more on a
fresh snapshot: a captcha, a block, a sign-in page or another host that appeared while the caller was thinking stops
the task before the command runs, not after it. That snapshot is not returned and does not change `id`/`gen`.

### Reading on request: `within`, `tree`, `items`

```js
const s = await see({
  within: { role: 'region', name: 'Message history' },  // or { css: '#column-center' }
  tree: true,                                            // a pruned tree of within (or of the page)
  textLimit: 12000,                                      // for within.text and tree: 6000 by default, at most 20000
  items: { css: '[role=article]', last: 20,              // or first: N; at most 50
           flags: { out: '.is-out' },                    // name → a CSS selector the item itself matches
           attrs: ['data-mid'],                          // data-*, datetime, alt, title, href, aria-label
           textLimit: 600 },                             // per item: 600 by default, at most 2000
});
// s.within → { text, elements: [ids] } or null; s.tree → a string or null
// s.items  → [{ text, inView, id?, flags?, attrs? }] or null; s.itemsTotal if more matched
```

These options only add fields. The rest of the snapshot (`text`, `elements`, `dialogs`, …) is the same as without
them, and guard reads the rest, so a captcha outside `within` still stops the task. The options say what to read
(selectors and attribute names); the reading runs in meatsuit's own isolated world, and no JavaScript of the caller
is run.

- `within` is the first visible element, open shadow roots included, that matches `css`, or that has this `role`
  and `name` (as in the snapshot: `elements[].name`, `dialogs[].name`, or an `aria-label`; without `name`, the first
  with the role). The role is the `role` attribute, the snapshot role of an interactive element, or by tag:
  `heading`, `list`, `listitem`, `article`, `dialog`, `time`. `within.text` is its text up to `textLimit`, in lines:
  a part at most two levels deep (a message with its time, a list row with its link, a paragraph with a link) is one
  line, a bigger part is split into its children. `within.elements` are the ids of snapshot elements inside it. Not
  found: `within`, `tree` and `items` are `null`.
- `tree: true` is the content as YAML-like lines: text (`- Привет!`) and nodes with a role
  (`- [button #7 "Send"] ➤`), where `#7` is the element's id in this snapshot and the name is given only when it
  says what the text does not (a field's label, an icon button's `aria-label`, a `time`'s `datetime`). A wrapper
  without a role disappears when empty, becomes its child when it has one, and stays a group (`- - …`) when it has
  several, so a message keeps its text and time together. Inline wrappers do not split words. Not included: hidden
  content (`display:none`, `visibility:hidden`, `content-visibility:hidden`, a closed `<details>` past its
  `<summary>`), `<script>`, `<style>`, `<svg>`, iframes, and the contents of `input`, `textarea`, `select` and
  `textbox` nodes (their values are in `elements`, a field's name is the same as there). Cut to `textLimit` with `…`.
- `items` are the visible elements matching `css` (inside `within`, if given), the `first` or `last` N in document
  order. Each has `text` (in lines as `within.text`, so a message or a row is one line) and `inView`; `id` if the
  item is itself a snapshot element (a chat row link: click it); `flags`: for each name, whether the item matches
  the selector (`{ out: '.is-out' }` for a Telegram Web K bubble, whose direction is only a class); `attrs`: those of the requested attributes the item has, values up to 200
  characters, from a fixed list: `data-*`, `datetime`, `alt`, `title`, `href`, `aria-label`. Never `value`, and no
  attributes of a password field. A selector does see attributes, so a flag can test what is written in one, a
  `value` set in the HTML included; what a person types into a field is not an attribute, and no selector sees it.
- Text in `within`, `tree` and `items` has an image's `alt` where the image is (emoji drawn as `<img alt>`). The
  snapshot's `text` and element names stay as before.
- With `since`, the diff carries `within`, `tree`, `items` and `itemsTotal` in full; `changed` does not consider
  them, compare them yourself.
- A wrong option (an unknown field in `within` or `items`, both or neither of `first` and `last`, an attribute
  outside the list, `textLimit` without `within` or `tree`, a selector that does not parse) is a `BadCommand` before
  the snapshot; the previous snapshot and its ids stay valid. Numbers above a ceiling are cut to it.

## Hands: `act(command)`

The set is closed; anything else is a `BadCommand` before it runs.

| Command | Fields | Notes |
|---|---|---|
| `click` | `id`, `gen` | scrolls, moves the mouse along a curve, clicks a random point; before the press checks that the target is at that point. On a file field it is a `BadCommand` (it would open the system file dialog; use `upload` for files) |
| `fill` | `id`, `gen`, `text` | click, check that the focus is in the field, clear, type, check that the field holds `text` (see "The field after typing"). `text` up to 1000 characters on one line; in a `<textarea>` up to 2000 with line breaks, see below. On a `<select>` or a file field it is a `BadCommand` (use `select` and `upload`) |
| `select` | `id`, `gen`, `value` or `label` | an option of a native `<select>`, see below |
| `upload` | `id`, `gen`, `file` | a file from `uploadDirs` into the form, see below |
| `type` | `text`, `id?`, `gen?` | types into the focused element, one line; with `id`/`gen` the focus is checked before the first key; afterwards the field must hold what it held plus `text` at the caret |
| `press` | `key`, `id?`, `gen?` | `Enter` `Escape` `Tab` `Backspace` `ArrowDown` `ArrowUp` `PageDown` `PageUp`. `Enter` into a field these hands typed into goes only while the field still holds what they typed |
| `scroll` | `px?`, `id?`, `gen?` | down, 0 to 5000; with `id`/`gen` the mouse first moves over the element (no click) and the wheel turns over it: this is how a nested scroll moves, such as a list in a side panel |
| `wait` | `ms` (up to 15000) or `text` | a pause, or until the text appears |
| `back` | — | back in history |
| `goto` | `url` | `https:` only, and only the site's host or its subdomain |

Returns the snapshot diff after the command. `dryRun: true`: `see` works, `act` returns `{ dryRun: true,
changed: false }` and only writes to the journal (`upload` checks the file first); the exception is `goto`, which runs.
`dryRunNavigation: true` also runs a `click` on an element with the `tab` role (switching a view) when no link,
button, field or label is above it, and `scroll` (it only moves the view; this is how a rehearsal sees a list that loads on scroll).

### The field after typing: FieldMismatch

`fill` and `type` check the field after the last key, and `press Enter` checks it once more right before the key:

- after `fill` the field's value (for a `contenteditable`, its visible text, `innerText`) must equal `text`; after
  `type`, what the field held before, with `text` inserted at the caret. Both sides are normalised first: `\r\n`
  becomes `\n`, a no-break space a space, Unicode NFC, spaces at both ends trimmed;
- `type` into a field these hands typed into that now holds something else, and `press Enter` into such a field (the
  focused one, with or without `id`), throw `FieldMismatch` with `before: true`: nothing is typed or pressed. A field
  is forgotten after an Enter that went through; a new `fill` starts it over. The bot's own other key into such a field
  (`Backspace`, an arrow) moves what is expected to what the field holds after it, but only if the field held exactly
  what the bot typed before that key; otherwise the expectation stays and Enter is still refused. What the hands typed is remembered in
  meatsuit's isolated world of that document (not on disk, invisible to the page) until the document changes, so a
  later task in the same tab sees it too;
- before `Ctrl+A` `fill` checks that the focus is in the target (or inside it): the page may have moved it after the
  click, and the clearing would wipe another field. If it is not, `StaleElement`, nothing is cleared or typed;
- if after the last key the field is gone or the document has changed (the page took the input itself: a code checked
  on its last digit, a form sent), there is nothing to compare with and the command succeeds as before.

`FieldMismatch` carries `cmd` (`'fill'`, `'type'` or `'press'`), `id` (as in the command, possibly `undefined`),
`expectedLength` and `actualLength` (after normalisation), `diffAt` (the 0-based index of the first character that
differs) and `before: true` when nothing was typed or pressed. Neither the message nor the fields contain the text: it
is a private message, and the error goes to the journal and to `notify`. Without `before` the keys were typed, and the
field holds something other than `text`.

It happens when someone types along with the bot (the owner in the mirror: a bot's click activates the bot's window,
and the letters the owner types land in the bot's field, see "Several bots in one browser"), and also when the page
itself changes the input: a phone mask, a `maxlength` cut, code boxes that move the focus on after each digit (the
first box then holds one digit). Do not retry blindly: tell the owner, or look at the field with `see()` (its `value`,
the first 80 characters) and decide. Enter into that field stays refused until it holds what the bot typed; a `click`
on a submit button is not checked. Verified in headless Chromium (`test/hands.test.js`: letters inserted in the middle
of `fill` and `type` into a `textarea` and a `contenteditable`, a change between `fill` and Enter, a page that moves
the focus after the click); not verified live in Chrome under Neko.

### fill in a textarea (a cover letter)

`validate` accepts a `fill` with up to 2000 characters and line breaks (`\n`; `\r\n` becomes `\n`). At run time, once
the target is known, such text (with a line break or longer than 1000) goes only into a `<textarea>`; into a plain
input, `contenteditable` or anything else it is a `BadCommand` before any action. `type` stays one line up to 1000.

A line break is typed as **Shift+Enter**: in a plain `textarea` that is the same new line, while in a chat a bare
Enter would send half a message. Typing follows the persona's pace (150–475 characters a minute, with typos and
corrections): 2000 characters take 4–13 minutes. The task's `maxMinutes` (and the site's ceiling in `sites.json`)
must allow for that: the deadline is checked before each command, so a long `fill` is not cut off by it, but the next
command gets `BudgetExceeded`. The owner's wheel does cut it (see "The owner at the wheel").

### upload

`{ cmd: 'upload', id, gen, file }`. `file` is an absolute path; `validate(c, hosts, { uploadDirs })` accepts only a
file inside one of `uploadDirs` (no `..`, not a sibling directory whose name merely starts the same), with a `pdf`,
`doc` or `docx` extension in any case. Without `uploadDirs` it is a `BadCommand`. At run time (and in `dryRun`) the
check repeats on the real path: a symlink does not lead out of `uploadDirs` or to another type, and the file is a
regular non-empty file of at most 10 MB; otherwise a `BadCommand` before any action. Error messages contain no path.

The file reaches the browser **as a buffer** (`{ name, mimeType, buffer }`), not as a path: the browser may live in
another container where the host's path does not exist. The name is the last part of `file`, the type comes from the
extension.

The target `id` is one of two things:

- **an `<input type=file>` field** (visible, or hidden behind a label, see "Eyes"): after a pause for "picked it in
  the dialog" the file is set on the field, like Playwright's `setInputFiles` with a buffer; the page gets `input` and
  `change` (synthetic, `isTrusted: false`, as with Playwright). A `disabled` field is a `BadCommand`; a field that
  disappeared during the pause is `StaleElement`;
- **a button or label that opens the file picker**: a human click (with the point check); the file chooser is
  intercepted (no system dialog opens) and receives the file. No file chooser within 5 s is a `BadCommand`
  "did not open the file picker" (the click has happened: take a fresh snapshot).

After the command the field's `value` in the snapshot is the file name; often the name shows up in the page `text`
too. `dryRun`: the file is checked but not uploaded, and the journal gets `{ cmd: 'upload', id, gen, fileType }`
without the path or name.

Not included: several files at once, dropping onto a zone (drag-and-drop without a field), checking the field's
`accept`. A `click` on a file-picker button (instead of `upload`) opens the system dialog in the mirror, so use only
`upload` for files. Verified in headless Chromium (`test/upload.test.js`); not verified live in Chrome under Neko or
on real ATS forms.

### select

`{ cmd: 'select', id, gen, label }` selects by the option's label as in the snapshot's `options` (case and extra
spaces ignored); `{ cmd: 'select', id, gen, value }` selects by the option's `value` attribute (exact; `''` is
allowed). Exactly one of the two, a string up to 200 characters. The target is a native `<select>` without `multiple`.

As a human with a keyboard does it: the hand reaches the list, it gets focus, and the option is chosen with the arrow
keys without opening it (the browser draws an open list as a separate window the mouse cannot reach); an option more
than 25 positions away is first reached by typing the first letters of its label (type-ahead on a closed list), then
by arrows. The `input` and `change` events are real (`isTrusted`). If the arrow keys do not move the selection
(Chromium on macOS opens the list on an arrow key instead), the shortest start of the label that no other option
begins with is typed, with real keys too. If the browser still did not move the selection, the option is set directly
with `input` and `change` events (these are synthetic, as with Playwright's `selectOption`). If the option is already
selected, nothing happens.

`BadCommand` before any action: the target is not a `<select>`, it has `multiple`, the list or the option is not
available (`disabled`, including on an `optgroup`), or there is no such option. Verified in headless Chromium
(`test/forms.test.js`): on macOS on 4 November, where the typed-label path runs, and on Linux on 5 November, where
the arrow path runs; not verified live in Chrome under Neko.

### The hands' pace

Every command goes through `human.js` (the hands of the main line): the mouse moves along a curve at a speed
following Fitts's law, with tremor and an occasional overshoot; an element below the screen is reached with the wheel,
in bursts with pauses; the click lands near the centre with a delay and a held button; typing goes key by key with a
rhythm, Shift and typos that are fixed right away (the plan always ends with exactly the requested text, and `fill` and
`type` then check the field, see "The field after typing");
Cyrillic is sent as key events over CDP. If the cursor is already over the element, the hand does not move. Before a
mouse press, hands checks that the target is still under the cursor (`StaleElement` if not).

The human's habits (hand speed, tremor, twitches, typing pace `wpm`, typo rate `typoRate`) are created once and kept in
`<dir>/persona.json`: after a restart, and for every caller sharing that `dir`, the browser has the same human. A
damaged file is replaced with valid habits. Habits are per process: with two `connect` calls with different `dir` in
one process, the last one sets the human. The file lives outside the repository (in `dir`) and never gets into git.

## Journal, recording, archive

- The journal `<dir>/journal.jsonl`, one line per command: `ts`, `dryRun`, `cmd`, `url`, `result: 'ok' | 'dry-run'`
  or `error`, `urlAfter`. The journal keeps what was done and where, but **not what was typed**: `cmd` holds only
  `cmd`, `id`, `gen`, `key`, `px`, `ms`; instead of `text`, `value` and `label` it holds their lengths (`textLength`,
  `valueLength`, `labelLength`); for `upload` only the file type (`fileType: 'pdf'`), without the path or name.
  Addresses (`cmd.url`, `url`, `urlAfter`) are stored without query and hash: those can carry sign-in tokens, codes
  and typed searches. An error is the first line of the message, with the command's text and address removed. Other
  command fields are not written. A journal line that cannot be written (no permission on the file in the shared `dir`,
  a full disk) does not fail the command: the line is lost and the reason goes to stderr, so a click that happened is
  never reported as failed.
- Recording (`recordDir`) and the archive (`capture`) are different: they hold whole snapshots and commands, field
  text included.
- `hands(page, { recordDir })` writes snapshots to `NNNN.json`; `replay(recordDir)` gives the same `{ see, act }`
  without a browser and throws "recording ended" when the snapshots run out.
- `capture`: every snapshot goes to `<dir>/<YYYY-MM-DD>/<seq>.json`, plus up to `htmlPerSignature` sanitised HTML
  files per screen signature; old days are deleted beyond `maxMB`. `signature(snapshot)` → `{ hash (10 hex), shape,
  urlPattern }`. The disk holds real pages with other people's data: keep that folder outside git.

## Telegram (a helper, not part of the core)

`telegram.js` does not read the environment: the caller passes the token and the group.
`telegramNotifier({ token, chatId, threadId?, apiBase? })` returns a function for `connect({ notify })`;
`createTelegram(...)` → `send(text, { silent?, parseMode?, threadId? })` (splits long messages, retries on 429 and
5xx, follows a group's move to a supergroup, keeps the token out of errors); `findChats({ token })` lists the groups
the bot has seen. For a human: `TELEGRAM_BOT_TOKEN=… node tools/telegram-chats.js` (groups and topics) and
`… send "text"`.

## What meatsuit does not do

- it does not decide what to click and does not write texts;
- it does not run arbitrary JS and does not go to other hosts;
- it does not get past captchas and does not sign in to accounts on its own: those are a stop and a message to the
  human. The exception is a one-time-code sign-in (`codeLogin`) with a code the caller got from the human; a password
  is always a stop;
- it does not spoof the browser's fingerprint;
- it does not keep tokens, keys or site passwords, and does not read the environment.

## The caller's duties

- Keep its own `sites.json` and pass it to `connect`; one `dir` for all callers of one browser, and all of them on a
  version with per-site queues.
- Expect tasks on other sites to run alongside its own; nothing in its own process may assume it is the only bot.
- Use only the latest `gen`; after `act`, take `gen` and `elements` from its answer.
- Check the model's answer before `act` (`validate` from `meatsuit/hands.js`).
- Keep other people's profile data out of the journal and the model beyond what is needed.
- Put into `uploadDirs` only a directory with what may be sent (CVs, letters): `upload` takes any pdf/doc/docx from
  it at the model's choice.
- The first run on a live site is `dryRun` only.

## Limitations

Not verified live: the main line's hands, `upload`, `select` and multi-line `fill` in Chrome under Neko; all the tests
run on fake pages in headless Chromium. The acceptance assumes one live `dryRun` task in the mirror
([acceptance.md](acceptance.md)). Reading on request (`within`, `tree`, `items`) is tested on constructed pages
only (`test/eyes-read.test.js`); its Telegram Web K page is built from what the integration plan read in the tweb
sources, not from a dump of the live page.

A known limitation: elements inside cross-origin iframes (an ATS form embedded on a company's site) do not get into
the snapshot; go to the form's host directly.
