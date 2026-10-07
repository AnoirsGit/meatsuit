/**
 * Оркестрация прогрева (life/runner.js): одна сессия, цикл по расписанию, остановка, пауза,
 * проверка выхода в сеть. Браузер, часы, журнал, файлы и сеть подставные; время виртуальное.
 *
 *   node --test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { seeded } = require('../human/random.js');
const { normalizeConfig } = require('../life/config.js');
const { startOfLocalDay } = require('../life/plan.js');
const { Blocked } = require('../life/session.js');
const { createEgress } = require('../egress.js');
const { createRunner, createStore, createJournal, loadEgress, cleanState } = require('../life/runner.js');

const H = 3600e3, MIN = 60e3;
const TZ = 'Asia/Almaty';
const CFG = normalizeConfig({
  tz: TZ, hours: [9, 23], sessionsPerDay: [2, 2], minGapMinutes: 60, lateMinutes: 90, cooldownHours: 24,
  session: { minutes: [5, 8], sites: [2, 2] },
  sites: [{ url: 'https://a.test/' }, { url: 'https://b.test/' }],
});
const DAY = startOfLocalDay(Date.UTC(2026, 9, 5, 7), TZ); // полночь 5 октября по Алматы
const NOON = DAY + 12 * H;

/** Виртуальные часы: sleep двигает время; hook может остановить цикл, когда время вышло. */
function clockAt(t0) {
  const c = { t: t0, sleeps: 0, hook: null };
  c.now = () => c.t;
  c.sleep = async (ms) => { c.sleeps++; assert.ok(c.sleeps < 20000, 'виртуальное время зациклилось'); c.t += ms; if (c.hook) c.hook(); };
  return c;
}

const memStore = (initial = null) => {
  const s = { data: initial, writes: 0, failWrites: false };
  s.read = () => (s.data === null ? null : structuredClone(s.data));
  s.write = (v) => { if (s.failWrites) throw new Error('ENOSPC: нет места'); s.data = structuredClone(v); s.writes++; };
  return s;
};

/** Браузер: connect/openPage/close считают вызовы; сбои заказываются. */
function fakeBrowser({ failConnect, failOpen } = {}) {
  const b = { connects: 0, pages: 0, closedPages: 0, closedLinks: 0 };
  b.connect = async () => {
    b.connects++;
    if (failConnect) throw new Error(failConnect);
    let closed = false;
    return {
      openPage: async () => {
        if (failOpen) throw new Error(failOpen);
        b.pages++;
        let wake;
        const closedP = new Promise((r) => { wake = r; });
        const page = { closed: false, waitClosed: () => closedP, close: async () => { if (!page.closed) { page.closed = true; b.closedPages++; wake(); } } };
        return page;
      },
      close: async () => { if (!closed) { closed = true; b.closedLinks++; } }, // как у настоящего: второе закрытие безвредно
    };
  };
  return b;
}

/** Сессия-заглушка: запоминает, когда её позвали, и ведёт себя как заказано. */
function fakeSession(clock, behave = async () => ({ cut: false })) {
  const calls = [];
  const fn = async (page, steps, opts) => { calls.push({ at: clock.now(), steps, page, opts }); return behave(page, steps, opts); };
  fn.calls = calls;
  return fn;
}

function make(over = {}) {
  const clock = over.clock || clockAt(NOON);
  const journal = [];
  const store = over.store || memStore();
  const browser = over.browser || fakeBrowser();
  const session = over.session || fakeSession(clock);
  const runner = createRunner({
    cfg: over.cfg || CFG, connect: browser.connect, store, journal: (e) => journal.push(e), egress: over.egress ?? null,
    now: clock.now, sleep: clock.sleep, rnd: over.rnd || seeded(11), session,
  });
  return { runner, clock, journal, store, browser, session };
}
const events = (journal) => journal.map((e) => e.event);

// ---------- одна сессия ----------

test('сессия: план в журнал, страница и соединение закрыты, итог ok', async () => {
  const { runner, journal, browser, session } = make();
  const out = await runner.runNow();
  assert.equal(out.result, 'ok');
  assert.deepEqual(events(journal), ['warning', 'session-start', 'session-end']);
  assert.equal(session.calls.length, 1);
  assert.equal(session.calls[0].steps.length, 2);
  assert.deepEqual([browser.pages, browser.closedPages, browser.closedLinks], [1, 1, 1]);
});

test('сессию оборвал срок: session-end помечен cut', async () => {
  const clock = clockAt(NOON);
  const { runner, journal } = make({ clock, session: fakeSession(clock, async () => ({ cut: true })) });
  await runner.runNow();
  assert.equal(journal.find((e) => e.event === 'session-end').cut, true);
});

test('сбой connect не роняет процесс: событие error, состояние не портится, лишнего не закрывается', async () => {
  const { runner, journal, browser, session } = make({ browser: fakeBrowser({ failConnect: 'connect ECONNREFUSED 127.0.0.1:1' }) });
  const out = await runner.runNow(); // не бросает
  assert.equal(out.result, 'error');
  const err = journal.find((e) => e.event === 'error');
  assert.match(err.reason, /ECONNREFUSED/);
  assert.match(err.reason, /браузер/);
  assert.equal(session.calls.length, 0);
  assert.deepEqual([browser.pages, browser.closedLinks], [0, 0]);
});

test('сбой openPage: соединение с браузером всё равно закрывается', async () => {
  const { runner, journal, browser } = make({ browser: fakeBrowser({ failOpen: 'Target closed' }) });
  const out = await runner.runNow();
  assert.equal(out.result, 'error');
  assert.match(journal.find((e) => e.event === 'error').reason, /Target closed/);
  assert.equal(browser.closedLinks, 1, 'соединение осталось открытым');
});

test('капча: cooldown на сутки, пауза записана в состояние, страница закрыта', async () => {
  const clock = clockAt(NOON);
  const session = fakeSession(clock, async () => { throw new Blocked('captcha', 'https://a.test/'); });
  const { runner, journal, store, browser } = make({ clock, session, store: memStore({ day: '2026-10-05', starts: [NOON], done: [] }) });
  const out = await runner.runNow();
  assert.equal(out.result, 'blocked');
  const cool = journal.find((e) => e.event === 'cooldown');
  assert.deepEqual([cool.reason, cool.url, cool.until], ['captcha', 'https://a.test/', new Date(NOON + 24 * H).toISOString()]);
  assert.equal(store.data.pausedUntil, NOON + 24 * H);
  assert.deepEqual(store.data.starts, [NOON], 'пауза затёрла остальное состояние');
  assert.deepEqual([browser.closedPages, browser.closedLinks], [1, 1]);
});

test('ошибка в коде сессии: событие error, а не падение; страница закрыта', async () => {
  const clock = clockAt(NOON);
  const { runner, journal, browser } = make({ clock, session: fakeSession(clock, async () => { throw new TypeError('x is not a function'); }) });
  assert.equal((await runner.runNow()).result, 'error');
  assert.match(journal.find((e) => e.event === 'error').reason, /x is not a function/);
  assert.deepEqual([browser.closedPages, browser.closedLinks], [1, 1]);
});

// ---------- node life.js now: пауза ----------

test('now в паузе: отказ без браузера и без сессии; с --force запускается и пишет об этом', async () => {
  const until = NOON + 5 * H;
  const { runner, journal, browser, session } = make({ store: memStore({ day: '2026-10-05', starts: [], done: [], pausedUntil: until }) });
  assert.deepEqual(await runner.runNow(), { result: 'paused', until });
  assert.deepEqual([browser.connects, session.calls.length, journal.length], [0, 0, 0]);

  const forced = await runner.runNow({ force: true });
  assert.equal(forced.result, 'ok');
  assert.equal(session.calls.length, 1);
  assert.ok(journal.some((e) => e.event === 'warning' && /пауза/.test(e.reason) && /force/.test(e.reason)), 'про --force в журнале ничего нет');
});

test('now: пауза уже кончилась — запускается как обычно', async () => {
  const { runner, session } = make({ store: memStore({ day: '2026-10-04', starts: [], done: [], pausedUntil: NOON - H }) });
  assert.equal((await runner.runNow()).result, 'ok');
  assert.equal(session.calls.length, 1);
});

// ---------- выход в сеть ----------

const echo = (country, asn) => async () => ({ ok: true, json: async () => ({ country, org: `AS${asn} Some ISP` }) });
const egressOf = (fetch, expected = { country: 'KZ', asn: [64500] }) => createEgress({ expected, fetch });

test('нет проверки выхода: одно предупреждение в журнале на сессию, сессия идёт', async () => {
  const { runner, journal, session } = make({ egress: null });
  await runner.runNow();
  const warns = journal.filter((e) => e.event === 'warning');
  assert.equal(warns.length, 1);
  assert.match(warns[0].reason, /выход в сеть не проверяется/);
  assert.equal(session.calls.length, 1);
});

test('выход тот, что нужно: предупреждений нет, сессия идёт', async () => {
  const { runner, journal, session } = make({ egress: egressOf(echo('KZ', 64500)) });
  await runner.runNow();
  assert.equal(session.calls.length, 1);
  assert.deepEqual(events(journal), ['session-start', 'session-end']);
});

test('выход не тот: egress-wrong, сессия пропущена, суточной паузы нет, браузер не трогали', async () => {
  const { runner, journal, store, browser, session } = make({ egress: egressOf(echo('NL', 14061)) });
  const out = await runner.runNow();
  assert.equal(out.result, 'egress-wrong');
  const e = journal.find((x) => x.event === 'egress-wrong');
  assert.deepEqual([e.reason, e.country, e.asn], ['egress_wrong', 'NL', 14061]);
  assert.deepEqual([session.calls.length, browser.connects], [0, 0]);
  assert.equal(events(journal).includes('session-start'), false);
  assert.equal(events(journal).includes('cooldown'), false);
  assert.equal(store.data, null, 'пауза или состояние записаны');
});

test('выход не определился (сервисы молчат): тоже egress-wrong, а не «пустим на авось»', async () => {
  const dead = async () => { throw new Error('сеть недоступна'); };
  const { runner, journal, session } = make({ egress: egressOf(dead) });
  assert.equal((await runner.runNow()).result, 'egress-wrong');
  assert.equal(journal.find((x) => x.event === 'egress-wrong').reason, 'egress_unknown');
  assert.equal(session.calls.length, 0);
});

test('перед каждой сессией выход проверяется заново, а не берётся из кэша', async () => {
  let asked = 0;
  const fetch = async () => { asked++; return { ok: true, json: async () => ({ country: 'KZ', org: 'AS64500 X' }) }; };
  const { runner } = make({ egress: egressOf(fetch) });
  await runner.runNow();
  await runner.runNow();
  assert.equal(asked, 2);
});

test('loadEgress: нет файла — ошибка (без проверки выхода не идём), skip — null; хороший — проверка; битый или неверный — ошибка сразу', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meatsuit-egress-'));
  try {
    const file = path.join(dir, 'egress.json');
    assert.throws(() => loadEgress({ file }), /egress\.json.*--no-egress-check|--no-egress-check.*egress\.json/s);
    assert.equal(loadEgress({ file, skip: true }), null);
    fs.writeFileSync(file, '{"country":"KZ","asn":[64500]}');
    assert.equal(typeof loadEgress({ file, fetch: async () => {} }).check, 'function');
    fs.writeFileSync(file, '{"country": ');
    assert.throws(() => loadEgress({ file }), /JSON/);
    fs.writeFileSync(file, '{"country":"Kazakhstan"}');
    assert.throws(() => loadEgress({ file }), /country/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- цикл по расписанию ----------

/** Прогнать цикл до часа until (мс), потом остановить. */
async function runUntil(h, until) {
  h.clock.hook = () => { if (h.clock.t >= until) h.runner.stop(); };
  await h.runner.loop();
}

test('replan посреди дня: берутся только будущие старты (с допуском lateMinutes), все выполняются, план в журнале', async () => {
  for (let seed = 1; seed <= 15; seed++) {
    const h = make({ rnd: seeded(seed) });
    await runUntil(h, DAY + 24 * H - 5 * MIN); // до конца суток: следующий день не трогаем
    const plan = h.journal.filter((e) => e.event === 'plan');
    assert.equal(plan.length, 1, `seed ${seed}`);
    const { starts } = plan[0];
    assert.ok(starts.every((s) => s > NOON - CFG.lateMinutes * MIN), `seed ${seed}: в плане прошедший старт`);
    assert.equal(h.session.calls.length, starts.length, `seed ${seed}: выполнено не всё`);
    h.session.calls.forEach((c, i) => assert.ok(c.at >= starts[i] && c.at < Math.max(starts[i], NOON) + 2 * MIN, `seed ${seed}: сессия ${i} не в своё время`)); // прошедший старт (в пределах lateMinutes) идёт сразу
    assert.deepEqual(h.store.data.done, starts);
    assert.equal(h.store.data.day, '2026-10-05');
  }
});

test('перезапуск в тот же день продолжает с того же места и не планирует заново', async () => {
  const starts = [NOON - 3 * H, NOON + H, NOON + 4 * H];
  const h = make({ store: memStore({ day: '2026-10-05', starts, done: [starts[0]], pausedUntil: 0 }) });
  await runUntil(h, DAY + 24 * H - 5 * MIN);
  assert.equal(h.journal.some((e) => e.event === 'plan'), false);
  assert.equal(h.session.calls.length, 2);
  assert.deepEqual(h.store.data.done, starts);
});

test('новые сутки: новый план; пауза переживает смену суток и до её конца сессий нет', async () => {
  const pausedUntil = DAY + 24 * H + 10 * H; // завтра 10:00
  const h = make({ store: memStore({ day: '2026-10-05', starts: [NOON + H], done: [], pausedUntil }) });
  await runUntil(h, DAY + 48 * H - 5 * MIN);
  assert.equal(h.journal.filter((e) => e.event === 'plan').length, 1, 'на новые сутки не спланировано');
  assert.equal(h.store.data.day, '2026-10-06');
  assert.equal(h.store.data.pausedUntil, pausedUntil);
  assert.ok(h.session.calls.length >= 1, 'после паузы сессий нет');
  for (const c of h.session.calls) assert.ok(c.at >= pausedUntil, `сессия в паузу: ${new Date(c.at).toISOString()}`);
});

test('проспанный старт пропускается молча: сессии нет, в журнале тихо, старт считается сделанным', async () => {
  const starts = [NOON - 5 * H, NOON + H];
  const h = make({ store: memStore({ day: '2026-10-05', starts, done: [] }) });
  await runUntil(h, DAY + 24 * H - 5 * MIN);
  assert.equal(h.session.calls.length, 1);
  assert.deepEqual(h.store.data.done, starts);
  assert.deepEqual(events(h.journal).filter((e) => e !== 'warning' && e !== 'session-start' && e !== 'session-end'), []);
});

test('капча в цикле: пауза записана, старт сделанным, остальные старты ждут, процесс жив', async () => {
  const clock = clockAt(NOON);
  const session = fakeSession(clock, async () => { throw new Blocked('blocked', 'https://a.test/'); });
  const starts = [NOON + H, NOON + 3 * H, NOON + 5 * H];
  const h = make({ clock, session, store: memStore({ day: '2026-10-05', starts, done: [] }) });
  await runUntil(h, DAY + 24 * H - 5 * MIN);
  assert.equal(session.calls.length, 1, 'после блока сессии продолжились');
  assert.equal(h.store.data.pausedUntil, starts[0] + 24 * H);
  assert.deepEqual(h.store.data.done, [starts[0]]);
});

test('сбой connect в цикле: старт сделанным, следующий старт идёт, процесс не падает', async () => {
  const starts = [NOON + H, NOON + 4 * H];
  const clock = clockAt(NOON);
  let n = 0;
  const browser = fakeBrowser();
  const flaky = async () => { if (++n === 1) throw new Error('Neko перезапускается'); return browser.connect(); };
  const journal = [], store = memStore({ day: '2026-10-05', starts, done: [] });
  const session = fakeSession(clock);
  const runner = createRunner({ cfg: CFG, connect: flaky, store, journal: (e) => journal.push(e), now: clock.now, sleep: clock.sleep, rnd: seeded(2), session });
  clock.hook = () => { if (clock.t >= DAY + 24 * H - 5 * MIN) runner.stop(); };
  await runner.loop();
  assert.equal(journal.filter((e) => e.event === 'error').length, 1);
  assert.deepEqual(store.data.done, starts);
  assert.equal(session.calls.length, 1, 'второй старт не выполнен');
});

test('выход не тот в цикле: старты сделаны, паузы нет, сессий нет', async () => {
  const starts = [NOON + H, NOON + 4 * H];
  const h = make({ egress: egressOf(echo('NL', 1)), store: memStore({ day: '2026-10-05', starts, done: [] }) });
  await runUntil(h, DAY + 24 * H - 5 * MIN);
  assert.equal(h.journal.filter((e) => e.event === 'egress-wrong').length, 2);
  assert.equal(h.session.calls.length, 0);
  assert.deepEqual(h.store.data.done, starts);
  assert.ok(!h.store.data.pausedUntil);
});

test('диск не пишет (ENOSPC): цикл не падает и не крутится вхолостую — ошибка в журнале, пауза до следующей попытки', async () => {
  const store = memStore();
  store.failWrites = true;
  const h = make({ store });
  await runUntil(h, NOON + 20 * MIN);
  const errors = h.journal.filter((e) => e.event === 'error');
  assert.ok(errors.length >= 1 && errors.length <= 25, `ошибок в журнале ${errors.length}`);
  assert.match(errors[0].reason, /ENOSPC/);
  assert.ok(h.clock.sleeps < 100, `вхолостую: ${h.clock.sleeps} пауз`);
});

// ---------- оборванное и испорченное состояние ----------

test('cleanState: годное остаётся, дыры и мусор не роняют планировщик, пауза не теряется', () => {
  const good = { day: '2026-10-05', starts: [1, 2], done: [1], pausedUntil: 5 };
  assert.deepEqual(cleanState(good), good);
  assert.equal(cleanState(null), null);
  assert.equal(cleanState('text'), null);
  assert.equal(cleanState([]), null);
  assert.deepEqual(cleanState({ day: '2026-10-05' }), { pausedUntil: 0 });
  assert.deepEqual(cleanState({ day: '2026-10-05', starts: [1, 'x'], done: [] }), { pausedUntil: 0 });
  assert.deepEqual(cleanState({ day: '2026-10-05', starts: [1], done: 'x', pausedUntil: 77 }), { pausedUntil: 77 });
  assert.deepEqual(cleanState({ day: 5, starts: [], done: [] }), { pausedUntil: 0 });
  assert.deepEqual(cleanState({ ...good, pausedUntil: 'завтра' }), { ...good, pausedUntil: 0 });
});

test('оборванный life.json (файл и недописанные поля): цикл планирует заново, не падает, пауза сохраняется', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meatsuit-life-'));
  try {
    const file = path.join(dir, 'life.json');
    const pausedUntil = NOON + 3 * H;
    const broken = [
      '{"day":"2026-10-05","starts":[1,2',                                          // оборвано на середине
      '',                                                                          // пустой файл
      `{"day":"2026-10-05","pausedUntil":${pausedUntil}}`,                         // нет starts и done
      `{"day":"2026-10-05","starts":[${NOON + H}],"pausedUntil":${pausedUntil}}`,  // нет done
      `{"day":"2026-10-05","starts":"x","done":[],"pausedUntil":${pausedUntil}}`,  // starts не список
    ];
    for (const text of broken) {
      fs.writeFileSync(file, text);
      const h = make({ store: createStore({ file }) });
      await runUntil(h, NOON + 2 * MIN);
      assert.ok(h.journal.some((e) => e.event === 'plan'), `не спланировано заново: ${JSON.stringify(text)}`);
      assert.equal(h.journal.some((e) => e.event === 'error'), false, `ошибка на ${JSON.stringify(text)}: ${JSON.stringify(h.journal.find((e) => e.event === 'error'))}`);
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(saved.day, '2026-10-05');
      if (/pausedUntil/.test(text)) assert.equal(saved.pausedUntil, pausedUntil, `пауза потеряна: ${JSON.stringify(text)}`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('now с оборванным life.json: не падает', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meatsuit-life-'));
  try {
    const file = path.join(dir, 'life.json');
    fs.writeFileSync(file, '{"day":"2026-10-05","starts":[1,2');
    const { runner } = make({ store: createStore({ file }) });
    assert.equal((await runner.runNow()).result, 'ok');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('createStore: запись целиком или никак (через временный файл), чтение мусора даёт null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meatsuit-store-'));
  try {
    const store = createStore({ file: path.join(dir, 'sub', 'life.json') });
    assert.equal(store.read(), null);
    store.write({ a: 1 });
    assert.deepEqual(store.read(), { a: 1 });
    assert.deepEqual(fs.readdirSync(path.join(dir, 'sub')), ['life.json']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- остановка по сигналу ----------

test('stop посреди сессии: страница и соединение закрыты, в журнале stopped, а не error; старт не сделан', async () => {
  const clock = clockAt(NOON);
  let release;
  const started = new Promise((r) => { release = r; });
  const session = fakeSession(clock, async (page) => { release(); await page.waitClosed(); throw new Error('Target page, context or browser has been closed'); });
  const h = make({ clock, session, store: memStore({ day: '2026-10-05', starts: [NOON], done: [] }) });
  const looping = h.runner.loop();
  await started;
  await h.runner.stop();
  await looping;
  assert.deepEqual([h.browser.closedPages, h.browser.closedLinks], [1, 1]);
  assert.equal(h.journal.filter((e) => e.event === 'stopped').length, 1);
  assert.equal(h.journal.some((e) => e.event === 'error'), false);
  assert.deepEqual(h.store.data.done, [], 'прерванный старт записан как сделанный');
});

test('stop, пока идёт подключение: соединение закрывается, как только появилось, сессия не начинается', async () => {
  let finishConnect;
  const link = { openPage: async () => assert.fail('вкладка открыта после stop'), closed: 0, close: async () => { link.closed++; } };
  const connect = () => new Promise((resolve) => { finishConnect = () => resolve(link); });
  const clock = clockAt(NOON);
  const session = fakeSession(clock);
  const journal = [];
  const runner = createRunner({ cfg: CFG, connect, store: memStore(), journal: (e) => journal.push(e), now: clock.now, sleep: clock.sleep, rnd: seeded(1), session });
  const running = runner.runNow();
  await new Promise((r) => setImmediate(r));
  const stopping = runner.stop();
  finishConnect();
  await stopping;
  assert.equal((await running).result, 'stopped');
  assert.equal(link.closed, 1);
  assert.equal(session.calls.length, 0);
});

test('stop, пока открывается вкладка: вкладка закрывается до отключения, а не остаётся в браузере', async () => {
  // Как у настоящего: вкладка в браузере уже есть, а newPage ещё не вернулся. Отключение роняет его,
  // и вкладку потом закрыть некому.
  const order = [];
  let finishOpen, failOpen;
  const page = { close: async () => { order.push('page'); } };
  const link = {
    openPage: () => new Promise((resolve, reject) => { finishOpen = () => resolve(page); failOpen = reject; }),
    close: async () => { order.push('link'); failOpen(new Error('Target page, context or browser has been closed')); },
  };
  const clock = clockAt(NOON);
  const session = fakeSession(clock);
  const runner = createRunner({ cfg: CFG, connect: async () => link, store: memStore(), journal: () => {}, now: clock.now, sleep: clock.sleep, rnd: seeded(1), session });
  const running = runner.runNow();
  while (!finishOpen) await new Promise((r) => setImmediate(r));
  const stopping = runner.stop();
  finishOpen();
  await stopping;
  assert.equal((await running).result, 'stopped');
  assert.ok(order.includes('page') && order.indexOf('page') < order.indexOf('link'), `порядок закрытия: ${order.join(', ')}`);
  assert.equal(session.calls.length, 0);
});

test('stop без сессии: сразу готово, цикл выходит', async () => {
  const h = make({ store: memStore({ day: '2026-10-05', starts: [], done: [] }) });
  h.clock.hook = () => { h.runner.stop(); };
  await h.runner.loop();
  await h.runner.stop();
});

// ---------- журнал ----------

test('журнал: строка JSON с временем в life.jsonl и вывод на экран; сбой диска не роняет', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meatsuit-journal-'));
  try {
    const printed = [];
    const journal = createJournal({ dir: path.join(dir, 'data'), now: () => Date.UTC(2026, 9, 5, 14, 2, 11), print: (s) => printed.push(s) });
    journal({ event: 'step', url: 'https://a.test/', result: 'ok' });
    const line = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'life.jsonl'), 'utf8').trim());
    assert.deepEqual(line, { ts: '2026-10-05T14:02:11.000Z', event: 'step', url: 'https://a.test/', result: 'ok' });
    assert.equal(printed[0], '14:02:11 step https://a.test/ → ok');

    fs.writeFileSync(path.join(dir, 'blocker'), 'файл вместо каталога');
    const blocked = createJournal({ dir: path.join(dir, 'blocker', 'sub'), print: (s) => printed.push(s) }); // каталог внутри файла: писать некуда
    assert.doesNotThrow(() => blocked({ event: 'error', reason: 'x' }));
    assert.ok(printed.some((s) => /не записан/.test(s)), 'про сбой записи не сказано');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('политика cookies из конфига доходит до сессии', async () => {
  for (const consent of ['reject', 'accept']) {
    const clock = clockAt(NOON);
    const session = fakeSession(clock);
    const { runner } = make({ clock, session, cfg: normalizeConfig({ ...CFG, consent }) });
    await runner.oneSession({});
    assert.equal(session.calls[0].opts.consent, consent);
  }
});

test('недельный план: в выходной день сессий нет, в рабочий есть; в неделе одни и те же дни, новая неделя — новый выбор', async () => {
  const cfg = normalizeConfig({ ...CFG, daysPerWeek: [2, 2], sessionsPerDay: [1, 1] });
  for (let seed = 1; seed <= 10; seed++) {
    const h = make({ cfg, rnd: seeded(seed) });
    await runUntil(h, DAY + 3 * 24 * H - 5 * MIN); // понедельник, вторник, среда
    const week = h.store.data.week;
    assert.equal(week.id, '2026-W41');
    assert.equal(week.days.length, 2);
    const plans = h.journal.filter((e) => e.event === 'plan');
    assert.deepEqual(plans.map((p) => p.day), ['2026-10-05', '2026-10-06', '2026-10-07']);
    plans.forEach((p) => assert.equal(p.reason.includes('выходной'), !week.days.includes(p.day), `seed ${seed}, ${p.day}: ${p.reason}`));
    const idle = plans.filter((p) => !week.days.includes(p.day));
    idle.forEach((p) => assert.deepEqual(p.starts, [], 'в выходной день есть старты'));
  }
  const h = make({ cfg, rnd: seeded(4) });
  await runUntil(h, DAY + 8 * 24 * H); // до вторника следующей недели
  assert.equal(h.store.data.week.id, '2026-W42', 'неделя не сменилась');
});

test('в состоянии сохраняется только целая неделя; испорченная заменяется, остальное состояние цело', () => {
  const whole = { day: '2026-10-05', starts: [1], done: [], pausedUntil: 5, week: { id: '2026-W41', days: ['2026-10-05', '2026-10-07'] } };
  assert.deepEqual(cleanState(whole), whole);
  for (const bad of [{ id: 5, days: [] }, { id: '2026-W41', days: [1, 2] }, { id: '2026-W41' }, 'неделя', null]) {
    const { week, ...withoutWeek } = whole;
    assert.deepEqual(cleanState({ ...whole, week: bad }), withoutWeek, JSON.stringify(bad));
  }
});
