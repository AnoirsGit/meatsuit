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
  NeedsHuman, LimitReached, BudgetExceeded, BadCommand, StaleElement, // errors
  telegramNotifier, createTelegram, findChats, TelegramError,       // Telegram helper
  peek,                                               // what is left of a site's limit, without spending a slot
} = require('meatsuit');
const { validate } = require('meatsuit/hands.js');   // checking a command without a browser:
// validate(command, allowedHosts = [], { uploadDirs = [] } = {}) — throws BadCommand
```

The export list is pinned by a test (`test/api.test.js`) and changes only together with the callers.

## connect and task

```js
const ms = await connect({ cdpUrl, sitesFile /* or sites */, dir?, notify?, notifyOn? });
const result = await ms.task(name, async ({ see, act }) => { ...; return value; },
  { site, extraHosts = [], uploadDirs = [], maxCommands = 60, maxMinutes = 10, dryRun = false,
    dryRunNavigation = false, readOnly = false, capture?, codeLogin = false });
await ms.close();
```

| Parameter | Meaning |
|---|---|
| `cdpUrl` | the CDP address of the shared browser; required |
| `sitesFile` or `sites` | the **caller's** site limits: the path to its `sites.json` (read for every task, so an edit applies without a restart) or an object of the same shape. Exactly one of the two; with neither, with both, or with a missing file `connect` fails before it touches the browser. Sample: `sites.example.json` |
| `dir` | the queue lock `queue.lock`, the counters `limits.json`, the journal `journal.jsonl` and the human's habits `persona.json`; `~/.meatsuit` by default. **All callers of one browser must pass the same `dir`**: otherwise their locks differ and two bots enter the browser at once. With the mirror from `docker/` this is the `state/` folder in the `meatsuit_profile` volume (see "Attaching to the mirror") |
| `notify(text, event)` | the caller's async notification function. A failed send does not fail the task; it goes to stderr |
| `notifyOn` | which events to send: `'start'`, `'done'`, `'limit'`, `'error'`, `'needsHuman'`; by default `['needsHuman', 'limit', 'error']` |
| `site` | the site's host, its key in `sites.json`; `goto` is limited to it as well |
| `uploadDirs` | an array of absolute paths to directories `upload` may take files from (CVs, letters). Without it `upload` is a `BadCommand`. A wrong shape is an error before the queue and the browser |
| `extraHosts` | an array of hosts (`['company.com']`, no scheme, path or `*`) where the page may end up without a stop: a "thank you" page on the company's own site after an ATS form. Subdomains too. `goto` there is not allowed; limits and counters go by `site`; guard (captcha, sign-in, block) works there too. A wrong shape is an error before the queue and the browser |
| `maxCommands`, `maxMinutes` | the task's budget; the ceiling comes from the site (`sites.json`), the caller may choose less. `maxMinutes` is checked before each command; a task still running 15 minutes after it (a page that does not answer, the caller's own await that hangs) is ended by meatsuit: `BudgetExceeded`, the window is closed (after `NeedsHuman` it stays for the human), the queue is free |
| `dryRun`, `dryRunNavigation` | a rehearsal, see "Hands" |
| `readOnly` | the task only reads: it spends `perHour` but not `perDay`, and `perDay` does not stop it. The first writing command (`fill`, `type`, `select`, `upload`, `press Enter`, a `click` not on a `tab`) counts a full day slot before it runs; if the day is used up, that is `LimitReached` and the command does not run |
| `capture` | the screen archive `{ dir, htmlPerSignature = 5, maxMB = 500 }`; nothing is written without it |
| `codeLogin` | `true` means the task signs in with a one-time code (see "Code sign-in" below). The site also needs its own `sites.json` entry with `codeLogin`; without it, with a malformed rule, or with a value other than `true`/`false` it is an error before the queue and the browser |

`task` in order: joins the queue (one bot at a time; the lock file works across processes) → checks the site's limit
and records the task (`dryRun` spends no slots) → opens a separate window → calls the function under guard and the
budget → closes the window. On `NeedsHuman` the window stays open for the human to handle in the mirror. New tabs
the page opens are closed. Returns what the function returned.

The queue is one for all callers of one `dir` (tinder-matcher and cvs in one browser wait for each other). A task
waits for it up to 30 minutes; if the browser is still busy, `task` throws `LimitReached` ("the browser is busy with
task «…» (site) since HH:MM") without touching the browser or spending a slot, so the caller treats it like a limit and
retries later, not as its own failure. While `fn` runs, every other caller waits, including while your own code waits
for a model: put timeouts on your own awaits inside `fn` (`maxMinutes` is checked before each `see`/`act`, not while
your code is waiting). A task still running 15 minutes after its `maxMinutes` is ended by meatsuit, so one hung task
cannot hold the browser forever.

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
- `codeLogin: { "path": "^/account/login", "maxMinutes"?: 6 }` is the path where a task with
  `task(..., { codeLogin: true })` may go through a one-time-code sign-in. It is read **only from the site's own
  entry**, never from `"*"`.

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
```

For checks before a run and for reports: no browser, no queue, `limits.json` is not written. `sitesFile`/`sites`
and `dir` are the same as for `connect` (with the same limit-file errors). `rule` is the site's rule (its own or
`"*"`; `null` means no such site); `ok` means a task would start now; `reason` is the `LimitReached` text it would
not start with (outside hours, day or hour limit, `perDay: 0`, no such site), otherwise `null`. `usedDay` counts
writing tasks since local midnight, `usedHour` counts all tasks (`readOnly` too) in the last hour; `leftDay`/`leftHour`
are how many more are allowed (`null` means no limit, `0` means no such site). `readOnly: true` works as in `task`:
`perDay` does not stop it. A malformed rule (for example `hours`) throws, as in `task`. Do not import the internal
`meatsuit/limits.js`: its format is not part of the contract.

### Errors

| Error | When | What the caller should do |
|---|---|---|
| `LimitReached` | the site is not in `sites.json` (and there is no `"*"`), `perDay: 0`, outside hours, day or hour limit; the browser stayed busy with another caller's task for 30 minutes (the text names that task and site) | do not start the task, retry later |
| `NeedsHuman` (`.reason`, `.url`) | a captcha, a sign-in page (except the declared path of a `codeLogin` task), a block, leaving the site's host (and not to `extraHosts`) | stop; the window is open for the human. The state is not cleared until the task ends |
| `BudgetExceeded` | more than `maxCommands` commands or `maxMinutes` minutes | treat the task as failed |
| `StaleElement` | `gen` is out of date, the element is gone, something other than the target is under the cursor before the press, focus moved | take a fresh snapshot |
| `BadCommand` | a command outside the set or with bad fields | a bug in the caller's code or the model |

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

## Hands: `act(command)`

The set is closed; anything else is a `BadCommand` before it runs.

| Command | Fields | Notes |
|---|---|---|
| `click` | `id`, `gen` | scrolls, moves the mouse along a curve, clicks a random point; before the press checks that the target is at that point. On a file field it is a `BadCommand` (it would open the system file dialog; use `upload` for files) |
| `fill` | `id`, `gen`, `text` | click, clear, type. `text` up to 1000 characters on one line; in a `<textarea>` up to 2000 with line breaks, see below. On a `<select>` or a file field it is a `BadCommand` (use `select` and `upload`) |
| `select` | `id`, `gen`, `value` or `label` | an option of a native `<select>`, see below |
| `upload` | `id`, `gen`, `file` | a file from `uploadDirs` into the form, see below |
| `type` | `text`, `id?`, `gen?` | types into the focused element, one line; with `id`/`gen` the focus is checked before the first key |
| `press` | `key`, `id?`, `gen?` | `Enter` `Escape` `Tab` `Backspace` `ArrowDown` `ArrowUp` `PageDown` `PageUp` |
| `scroll` | `px?` | down, 0 to 5000 |
| `wait` | `ms` (up to 15000) or `text` | a pause, or until the text appears |
| `back` | — | back in history |
| `goto` | `url` | `https:` only, and only the site's host or its subdomain |

Returns the snapshot diff after the command. `dryRun: true`: `see` works, `act` returns `{ dryRun: true,
changed: false }` and only writes to the journal (`upload` checks the file first); the exception is `goto`, which runs.
`dryRunNavigation: true` also runs a `click` on an element with the `tab` role (switching a view) when no link,
button, field or label is above it.

### fill in a textarea (a cover letter)

`validate` accepts a `fill` with up to 2000 characters and line breaks (`\n`; `\r\n` becomes `\n`). At run time, once
the target is known, such text (with a line break or longer than 1000) goes only into a `<textarea>`; into a plain
input, `contenteditable` or anything else it is a `BadCommand` before any action. `type` stays one line up to 1000.

A line break is typed as **Shift+Enter**: in a plain `textarea` that is the same new line, while in a chat a bare
Enter would send half a message. Typing follows the persona's pace (150–475 characters a minute, with typos and
corrections): 2000 characters take 4–13 minutes. The task's `maxMinutes` (and the site's ceiling in `sites.json`)
must allow for that: the deadline is checked before each command, so a long `fill` is not cut off, but the next
command gets `BudgetExceeded`.

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
by arrows. The `input` and `change` events are real (`isTrusted`). If the browser did not move the selection with
the keys, the option is set directly with `input` and `change` events (these are synthetic, as with Playwright's
`selectOption`). If the option is already selected, nothing happens.

`BadCommand` before any action: the target is not a `<select>`, it has `multiple`, the list or the option is not
available (`disabled`, including on an `optgroup`), or there is no such option. Verified in headless Chromium
(`test/forms.test.js`); not verified live in Chrome under Neko.

### The hands' pace

Every command goes through `human.js` (the hands of the main line): the mouse moves along a curve at a speed
following Fitts's law, with tremor and an occasional overshoot; an element below the screen is reached with the wheel,
in bursts with pauses; the click lands near the centre with a delay and a held button; typing goes key by key with a
rhythm, Shift and typos that are fixed right away (the field always ends up with exactly the requested text);
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

- Keep its own `sites.json` and pass it to `connect`; one `dir` for all callers of one browser.
- Use only the latest `gen`; after `act`, take `gen` and `elements` from its answer.
- Check the model's answer before `act` (`validate` from `meatsuit/hands.js`).
- Keep other people's profile data out of the journal and the model beyond what is needed.
- Put into `uploadDirs` only a directory with what may be sent (CVs, letters): `upload` takes any pdf/doc/docx from
  it at the model's choice.
- The first run on a live site is `dryRun` only.

## Limitations

Not verified live: the main line's hands, `upload`, `select` and multi-line `fill` in Chrome under Neko; all the tests
run on fake pages in headless Chromium. The acceptance assumes one live `dryRun` task in the mirror
([acceptance.md](acceptance.md)).

A known limitation: elements inside cross-origin iframes (an ATS form embedded on a company's site) do not get into
the snapshot; go to the form's host directly.
