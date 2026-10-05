/**
 * HTTP-сервис: настоящий http.Server на порту 0, заглушка Driver, настоящие
 * очередь, лимиты и проверка выхода (время и сеть подставлены). Проверяются коды
 * ответов, очередь и X-Task, токены клиентов, границы goto, журнал и то, что
 * введённое не попадает ни в журнал, ни на страницу статуса.
 *
 *   node --test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer, createJournal, normalizeClients, parseArgs } = require('../server.js');
const { createQueue } = require('../queue.js');
const { createLimits } = require('../limits.js');
const { createEgress } = require('../egress.js');

const MIN = 60000, H = 3600000;
/** Местное время Алматы (UTC+5) → миллисекунды UTC. */
const at = (h, m = 0, day = 5) => Date.UTC(2026, 9, day, h - 5, m);

const SITES = {
  'hh.kz': { perDay: 3, perHour: 2, hours: '10-21' },
  'greenhouse.io': { perDay: 25, perHour: 4, hours: '9-22' },
  'tinder.com': { perDay: 10 },
  'linkedin.com': { perDay: 0 },
};
const CVS = 'tok-cvs-0123456789abcdef';
const TINDER = 'tok-tinder-0123456789abcdef';
const CLIENTS = [
  { name: 'cvs', token: CVS, sites: ['hh.kz', 'greenhouse.io', 'linkedin.com'] },
  { name: 'tinder', token: TINDER, sites: ['tinder.com', 'unlisted.test'] },
];

const KZ = { ip: '203.0.113.7', country: 'KZ', org: 'AS64500 Example ISP' };
const NL = { ip: '198.51.100.9', country: 'NL', org: 'AS64502 Example Datacenter' };

const PAGE = '<html><head><title>Вакансия</title></head><body><button data-ms="7">Откликнуться</button>СЕКРЕТНОЕ-СОДЕРЖИМОЕ-СТРАНИЦЫ</body></html>';

/** Виртуальные часы: таймеры идут по порядку, пока время идёт вперёд. */
function fakeClock(start) {
  let t = start, seq = 0;
  const timers = new Set();
  return {
    now: () => t,
    setTimer: (fn, ms) => { const h = { fn, at: t + ms, id: ++seq }; timers.add(h); return h; },
    clearTimer: (h) => { timers.delete(h); },
    async tick(ms) {
      const end = t + ms;
      for (;;) {
        const next = [...timers].filter((h) => h.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!next) break;
        timers.delete(next);
        t = next.at;
        next.fn();
        await new Promise((r) => setImmediate(r));
      }
      t = end;
      await new Promise((r) => setImmediate(r));
    },
  };
}

const driverError = (status, code, extra = {}) => Object.assign(new Error(`driver: ${code}`), { status, code, ...extra });

/** Заглушка Driver с тем же контрактом, что у настоящего; ведёт журнал вызовов. */
function stubDriver() {
  let n = 0;
  const d = {
    calls: [],
    async open(arg) { d.calls.push(['open', arg]); return d.onOpen ? d.onOpen(arg) : { id: `d${++n}` }; },
    async view(id, arg) { d.calls.push(['view', id, arg]); return d.onView ? d.onView(id, arg) : { html: PAGE, url: 'https://hh.kz/vacancy/1', title: 'Вакансия', guard: null }; },
    async act(id, action) { d.calls.push(['act', id, action]); return d.onAct ? d.onAct(id, action) : { ok: true, url: 'https://hh.kz/vacancy/1', settled: true, guard: null }; },
    async resume(id) { d.calls.push(['resume', id]); return d.onResume ? d.onResume(id) : { guard: null }; },
    async close(id) { d.calls.push(['close', id]); },
  };
  d.count = (kind) => d.calls.filter((c) => c[0] === kind).length;
  return d;
}

async function boot(t, over = {}) {
  const clock = fakeClock(at(12));
  const driver = over.driver || stubDriver();
  const queue = createQueue({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, idleMs: 5 * MIN, ticketTtlMs: MIN });
  const limits = createLimits({ sites: over.sites || SITES, file: null, now: clock.now });
  const echo = { reply: KZ, calls: 0 };
  const echoFetch = async () => {
    echo.calls++;
    if (echo.reply instanceof Error) throw echo.reply;
    return { ok: true, status: 200, json: async () => echo.reply };
  };
  const timer = {};
  const egress = createEgress({
    expected: { country: 'KZ', asn: [64500] }, fetch: echoFetch, now: clock.now,
    setIntervalFn: (fn) => { timer.fn = fn; return 1; }, clearIntervalFn() {},
  });
  const notified = [];
  const journal = createJournal({ file: over.journalFile, now: clock.now });
  const server = createServer({
    driver, queue, limits, egress, clients: CLIENTS, journal, now: clock.now, maxBodyBytes: 4096,
    notify: async (text) => { notified.push(text); return { sent: true }; },
    ...over.server,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); egress.stop(); });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(urlPath, { method = 'GET', token, task, body, headers = {} } = {}) {
    const h = { ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    if (task) h['x-task'] = task;
    const res = await fetch(base + urlPath, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* HTML */ }
    return { status: res.status, headers: res.headers, text, json };
  }
  const act = (token, body, task) => call('/act', { method: 'POST', token, task, body });
  /** begin и task id одним вызовом */
  const begin = async (token, body) => {
    const r = await act(token, { do: 'begin', task: 'cvs:hh-apply', site: 'hh.kz', ...body });
    assert.equal(r.status, 200, `begin: ${r.text}`);
    return r.json.task;
  };
  return { call, act, begin, driver, queue, limits, egress, echo, timer, notified, journal, clock, server, cvs: CVS, tinder: TINDER };
}

const until = async (cond, what = 'условие') => {
  for (let i = 0; i < 200; i++) { if (cond()) return; await new Promise((r) => setImmediate(r)); }
  assert.fail(`не дождались: ${what}`);
};

// ---------------------------------------------------------------- доступ

test('401: нет токена, чужой токен, не Bearer — и на /view, и на /act', async (t) => {
  const s = await boot(t);
  for (const headers of [{}, { authorization: 'Bearer nope-nope-nope-nope-nope' }, { authorization: `Basic ${CVS}` }, { authorization: CVS }, { authorization: 'Bearer ' }]) {
    const v = await s.call('/view', { headers });
    const a = await s.call('/act', { method: 'POST', headers, body: { do: 'begin', site: 'hh.kz' } });
    assert.deepEqual([v.status, v.json.error], [401, 'unauthorized']);
    assert.deepEqual([a.status, a.json.error], [401, 'unauthorized']);
  }
  assert.equal(s.driver.calls.length, 0);
  assert.equal(s.queue.snapshot().active, null);
});

test('токен одного клиента не открывает чужую задачу: 404 no_task', async (t) => {
  const s = await boot(t);
  const task = await s.begin(CVS);
  for (const r of [
    await s.call('/view', { token: TINDER, task }),
    await s.act(TINDER, { do: 'click', target: 1 }, task),
    await s.act(TINDER, { do: 'end' }, task),
  ]) assert.deepEqual([r.status, r.json.error], [404, 'no_task']);
  assert.equal(s.driver.count('close'), 0, 'чужой end окно не закрыл');
  assert.equal((await s.act(CVS, { do: 'click', target: 1 }, task)).status, 200, 'у хозяина задача жива');
});

// ---------------------------------------------------------------- цикл задачи

test('полный цикл: begin → view → act → end; журнал знает клиента, задачу и площадку', async (t) => {
  const s = await boot(t);
  const b = await s.act(CVS, { do: 'begin', task: 'cvs:hh-apply', site: 'hh.kz', cost: 2, allow: ['accounts.hh.kz'] });
  assert.equal(b.status, 200);
  assert.match(b.json.task, /^t\d+$/);
  assert.deepEqual(s.driver.calls[0], ['open', { site: 'hh.kz', allow: ['accounts.hh.kz'] }]);

  const v = await s.call('/view', { token: CVS, task: b.json.task });
  assert.equal(v.status, 200);
  assert.match(v.headers.get('content-type'), /text\/html/);
  assert.match(v.text, /СЕКРЕТНОЕ-СОДЕРЖИМОЕ-СТРАНИЦЫ/);
  assert.match(v.text, /<meta name="egress" content="KZ AS64500">/, 'страна и провайдер выхода в <head>');
  assert.equal(v.headers.get('x-url'), 'https://hh.kz/vacancy/1');
  assert.deepEqual(s.driver.calls.at(-1), ['view', 'd1', { scope: 'document' }]);

  const c = await s.act(CVS, { do: 'click', target: 7 }, b.json.task);
  assert.deepEqual([c.status, c.json], [200, { ok: true, url: 'https://hh.kz/vacancy/1', settled: true, guard: null }]);
  assert.deepEqual(s.driver.calls.at(-1), ['act', 'd1', { do: 'click', target: 7 }]);

  const e = await s.act(CVS, { do: 'end' }, b.json.task);
  assert.deepEqual([e.status, e.json], [200, { ok: true }]);
  assert.deepEqual(s.driver.calls.at(-1), ['close', 'd1']);
  assert.equal(s.queue.snapshot().active, null);

  const log = s.journal.tail(50).map((x) => [x.client, x.task, x.site, x.event, x.result]);
  assert.deepEqual(log, [
    ['cvs', 'cvs:hh-apply', 'hh.kz', 'begin', 'ok'],
    ['cvs', 'cvs:hh-apply', 'hh.kz', 'act', 'ok'],
    ['cvs', 'cvs:hh-apply', 'hh.kz', 'end', 'ok'],
  ]);
  assert.ok(s.journal.tail(1)[0].ts.startsWith('2026-10-05T07:00'), 'время из подставленных часов');
});

test('?scope=viewport доходит до Driver; чужое значение — 400', async (t) => {
  const s = await boot(t);
  const task = await s.begin(CVS);
  await s.call('/view?scope=viewport', { token: CVS, task });
  assert.deepEqual(s.driver.calls.at(-1), ['view', 'd1', { scope: 'viewport' }]);
  const bad = await s.call('/view?scope=everything', { token: CVS, task });
  assert.deepEqual([bad.status, bad.json.error], [400, 'bad_request']);
});

test('после end и для неизвестной задачи: 404 no_task; без X-Task: 400', async (t) => {
  const s = await boot(t);
  const task = await s.begin(CVS);
  assert.deepEqual((await s.call('/view', { token: CVS })).status, 400);
  assert.deepEqual((await s.act(CVS, { do: 'click', target: 1 })).status, 400);
  const unknown = await s.act(CVS, { do: 'click', target: 1 }, 't999');
  assert.deepEqual([unknown.status, unknown.json.error, unknown.json.reason], [404, 'no_task', undefined]);
  await s.act(CVS, { do: 'end' }, task);
  const gone = await s.act(CVS, { do: 'click', target: 1 }, task);
  assert.deepEqual([gone.status, gone.json.error, gone.json.reason], [404, 'no_task', 'end']);
  assert.equal((await s.call('/view', { token: CVS, task })).status, 404);
});

test('задача, к которой не обращались дольше idle, закрывается сама: окно закрыто, очередь свободна', async (t) => {
  const s = await boot(t);
  const task = await s.begin(CVS);
  await s.clock.tick(5 * MIN - 1);
  assert.equal((await s.act(CVS, { do: 'click', target: 1 }, task)).status, 200, 'обращение отодвигает срок');
  await s.clock.tick(5 * MIN);
  assert.deepEqual(s.driver.calls.at(-1), ['close', 'd1']);
  const r = await s.act(CVS, { do: 'click', target: 1 }, task);
  assert.deepEqual([r.status, r.json.error, r.json.reason], [404, 'no_task', 'idle']);
  assert.ok(await s.begin(TINDER, { task: 'tinder:like', site: 'tinder.com' }), 'очередь не повисла');
  assert.deepEqual(s.journal.tail(50).filter((x) => x.event === 'end').map((x) => x.result), ['idle']);
});

test('долгое действие не считается простоем', async (t) => {
  const s = await boot(t);
  const task = await s.begin(CVS);
  let finish;
  s.driver.onAct = () => new Promise((r) => { finish = () => r({ ok: true, url: 'https://hh.kz/', settled: true, guard: null }); });
  const typing = s.act(CVS, { do: 'type', text: 'очень длинное письмо' }, task);
  await until(() => finish, 'действие дошло до Driver');
  await s.clock.tick(20 * MIN);
  assert.equal(s.driver.count('close'), 0);
  finish();
  assert.equal((await typing).status, 200);
  s.driver.onAct = null;
  assert.equal((await s.act(CVS, { do: 'click', target: 1 }, task)).status, 200);
});

test('действия одной задачи идут по одному, даже если пришли разом', async (t) => {
  const s = await boot(t);
  const task = await s.begin(CVS);
  let now = 0, max = 0;
  s.driver.onAct = async () => {
    max = Math.max(max, ++now);
    await new Promise((r) => setTimeout(r, 15));
    now--;
    return { ok: true, url: 'https://hh.kz/', settled: true, guard: null };
  };
  const all = await Promise.all([1, 2, 3].map((n) => s.act(CVS, { do: 'click', target: n }, task)));
  assert.deepEqual(all.map((r) => r.status), [200, 200, 200]);
  assert.equal(max, 1);
});

// ---------------------------------------------------------------- 400

test('400: непонятный запрос', async (t) => {
  const s = await boot(t);
  const cases = [
    ['не JSON', 'это не json'],
    ['пустое тело', ''],
    ['массив', '[]'],
    ['null', 'null'],
    ['нет do', { task: 'x', site: 'hh.kz' }],
    ['do не строка', { do: 5 }],
    ['неизвестное do', { do: 'format-disk' }],
    ['begin без site', { do: 'begin', task: 'x' }],
    ['site не строка', { do: 'begin', site: 5 }],
    ['task не строка', { do: 'begin', site: 'hh.kz', task: { a: 1 } }],
    ['cost строкой', { do: 'begin', site: 'hh.kz', cost: 'много' }],
    ['cost ноль', { do: 'begin', site: 'hh.kz', cost: 0 }],
    ['cost дробный', { do: 'begin', site: 'hh.kz', cost: 1.5 }],
    ['wait отрицательный', { do: 'begin', site: 'hh.kz', wait: -1 }],
    ['wait не число', { do: 'begin', site: 'hh.kz', wait: 'долго' }],
    ['allow не список', { do: 'begin', site: 'hh.kz', allow: 'a.com' }],
    ['allow из не строк', { do: 'begin', site: 'hh.kz', allow: [1] }],
    ['ticket не строка', { do: 'begin', site: 'hh.kz', ticket: 5 }],
    ['слишком большое тело', { do: 'begin', site: 'hh.kz', task: 'x'.repeat(10000) }],
  ];
  for (const [name, body] of cases) {
    const r = await s.act(CVS, body);
    assert.deepEqual([r.status, r.json && r.json.error], [400, 'bad_request'], name);
  }
  assert.equal(s.driver.calls.length, 0);
  assert.equal(s.queue.snapshot().active, null);
});

test('400: у действия не хватает параметров; Driver при этом не трогается', async (t) => {
  const s = await boot(t);
  const task = await s.begin(CVS);
  const calls = s.driver.calls.length;
  const cases = [
    { do: 'goto' }, { do: 'goto', url: 5 }, { do: 'goto', url: 'не url' },
    { do: 'click' }, { do: 'fill', target: 1 }, { do: 'fill', text: 'x' }, { do: 'type' }, { do: 'type', text: 5 },
    { do: 'key' }, { do: 'scroll' }, { do: 'scroll', px: 'много' }, { do: 'pause', from: 'a', to: 5 },
  ];
  for (const body of cases) {
    const r = await s.act(CVS, body, task);
    assert.deepEqual([r.status, r.json.error], [400, 'bad_request'], JSON.stringify(body));
  }
  assert.equal(s.driver.calls.length, calls);
});

test('чужие методы и пути: GET на /act, POST на /view, неизвестный путь', async (t) => {
  const s = await boot(t);
  assert.equal((await s.call('/act', { token: CVS })).status, 400);
  assert.equal((await s.call('/view', { method: 'POST', token: CVS, body: {} })).status, 400);
  assert.equal((await s.call('/', { method: 'POST', body: {} })).status, 400);
  assert.equal((await s.call('/etc/passwd')).status, 404);
  assert.equal((await s.call('/index.html')).status, 404);
});

test('Content-Type не проверяется: тело всегда JSON', async (t) => {
  const s = await boot(t);
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', undefined]) {
    const r = await s.call('/act', { method: 'POST', token: TINDER, headers: type ? { 'content-type': type } : {}, body: JSON.stringify({ do: 'begin', site: 'tinder.com' }) });
    assert.equal(r.status, 200, String(type));
    await s.act(TINDER, { do: 'end' }, r.json.task);
  }
});

// ---------------------------------------------------------------- 403

test('403: площадка не разрешена этому клиенту; не описана в sites.json; allow шире прав клиента', async (t) => {
  const s = await boot(t);
  const other = await s.act(TINDER, { do: 'begin', task: 'x', site: 'hh.kz' });
  assert.deepEqual([other.status, other.json.error, other.json.reason], [403, 'forbidden', 'site_not_allowed']);
  const unlisted = await s.act(TINDER, { do: 'begin', task: 'x', site: 'unlisted.test' });
  assert.deepEqual([unlisted.status, unlisted.json.error, unlisted.json.reason], [403, 'forbidden', 'site_unknown']);
  const wide = await s.act(CVS, { do: 'begin', task: 'x', site: 'hh.kz', allow: ['evil.example'] });
  assert.deepEqual([wide.status, wide.json.error, wide.json.reason], [403, 'forbidden', 'allow_not_allowed']);
  assert.equal(s.driver.calls.length, 0, 'браузер не трогался');
  assert.equal(s.limits.snapshot()['hh.kz'].usedDay, 0);
  assert.equal(s.queue.snapshot().active, null);
});

test('403 приходит сразу, а не после ожидания очереди', async (t) => {
  const s = await boot(t);
  await s.begin(CVS);
  const r = await s.act(TINDER, { do: 'begin', task: 'x', site: 'hh.kz', wait: 60 });
  assert.equal(r.status, 403);
  assert.equal(s.queue.snapshot().waiting.length, 0);
});

test('площадка называется как угодно: www, поддомен, адрес — разрешения считаются по ней', async (t) => {
  const s = await boot(t);
  const task = await s.begin(CVS, { site: 'https://www.hh.kz/search?text=node' });
  assert.deepEqual(s.driver.calls[0], ['open', { site: 'hh.kz', allow: [] }]);
  await s.act(CVS, { do: 'end' }, task);
});

test('goto за пределы сайтов задачи — 403, Driver не вызывается', async (t) => {
  const s = await boot(t);
  const task = await s.begin(CVS, { allow: ['boards.greenhouse.io'] });
  const before = s.driver.calls.length;
  const outside = [
    'https://evil.example/', 'https://hh.kz.evil.example/', 'https://evilhh.kz/', 'https://hh.kz@evil.example/',
    'https://evil.example/?next=hh.kz', 'https://tinder.com/', 'http://127.0.0.1:9222/json',
    'javascript:alert(1)', 'file:///etc/passwd', 'chrome://settings', 'ftp://hh.kz/', 'data:text/html,<b>x</b>',
  ];
  for (const url of outside) {
    const r = await s.act(CVS, { do: 'goto', url }, task);
    assert.deepEqual([r.status, r.json.error], [403, 'forbidden'], url);
  }
  assert.equal(s.driver.calls.length, before);
  for (const url of ['https://hh.kz/vacancy/1', 'HTTPS://WWW.HH.KZ/a', 'http://spb.hh.kz/', 'https://boards.greenhouse.io/x']) {
    const r = await s.act(CVS, { do: 'goto', url }, task);
    assert.equal(r.status, 200, url);
  }
  assert.equal(s.driver.calls.length, before + 4);
  const refused = s.journal.tail(100).filter((x) => x.do === 'goto' && x.result === 'forbidden');
  assert.equal(refused.length, outside.length);
});

// ---------------------------------------------------------------- очередь

test('очередь: второй begin получает 202 с ticket и position, с ticket занимает слот после первого', async (t) => {
  const s = await boot(t);
  const first = await s.begin(CVS);
  const b = await s.act(TINDER, { do: 'begin', task: 'tinder:like', site: 'tinder.com', wait: 0 });
  assert.equal(b.status, 202);
  assert.match(b.json.ticket, /^k\d+$/);
  assert.equal(b.json.position, 1);
  assert.equal(s.driver.count('open'), 1, 'пока очередь не дошла, окно не открывается');
  const again = await s.act(TINDER, { do: 'begin', task: 'tinder:like', site: 'tinder.com', wait: 0, ticket: b.json.ticket });
  assert.deepEqual([again.status, again.json.position], [202, 1], 'место сохранено');
  await s.act(CVS, { do: 'end' }, first);
  const mine = await s.act(TINDER, { do: 'begin', task: 'tinder:like', site: 'tinder.com', wait: 0, ticket: b.json.ticket });
  assert.equal(mine.status, 200);
  assert.deepEqual(s.driver.calls.at(-1), ['open', { site: 'tinder.com', allow: [] }]);
});

test('begin ждёт слот до wait и получает его, когда чужая задача кончилась', async (t) => {
  const s = await boot(t);
  const first = await s.begin(CVS);
  const pending = s.act(TINDER, { do: 'begin', task: 'tinder:like', site: 'tinder.com', wait: 30 });
  await until(() => s.queue.snapshot().waiting.length === 1, 'tinder встал в очередь');
  await s.act(CVS, { do: 'end' }, first);
  const b = await pending;
  assert.equal(b.status, 200);
  assert.match(b.json.task, /^t\d+$/);
});

test('begin не дождался за wait: 202 с ticket', async (t) => {
  const s = await boot(t);
  await s.begin(CVS);
  const pending = s.act(TINDER, { do: 'begin', task: 'tinder:like', site: 'tinder.com', wait: 30 });
  await until(() => s.queue.snapshot().waiting.length === 1, 'tinder встал в очередь');
  await s.clock.tick(30000);
  const b = await pending;
  assert.deepEqual([b.status, b.json.position], [202, 1]);
  assert.match(b.json.ticket, /^k\d+$/);
});

test('по умолчанию begin ждёт 60 секунд', async (t) => {
  const s = await boot(t);
  await s.begin(CVS);
  const pending = s.act(TINDER, { do: 'begin', task: 'tinder:like', site: 'tinder.com' });
  await until(() => s.queue.snapshot().waiting.length === 1, 'tinder встал в очередь');
  await s.clock.tick(59000);
  let early = false;
  pending.then(() => { early = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(early, false);
  await s.clock.tick(1000);
  assert.equal((await pending).status, 202);
});

// ---------------------------------------------------------------- 429 и 503

test('429: лимит площадки исчерпан, в ответе retry_at; слот остаётся свободным', async (t) => {
  const s = await boot(t);
  const task = await s.begin(CVS, { cost: 2 });
  await s.act(CVS, { do: 'end' }, task);
  const r = await s.act(CVS, { do: 'begin', task: 'cvs:hh-apply', site: 'hh.kz', cost: 1 });
  assert.equal(r.status, 429);
  assert.deepEqual([r.json.error, r.json.reason, r.json.retry_at], ['limit', 'hour', new Date(at(13, 0)).toISOString()]);
  assert.equal(r.headers.get('retry-after'), '3600');
  assert.equal(s.driver.count('open'), 1, 'окно не открывалось');
  assert.ok(await s.begin(TINDER, { task: 'tinder:like', site: 'tinder.com' }), 'очередь не повисла на отказе');
  assert.deepEqual(s.journal.tail(50).filter((x) => x.event === 'limit').map((x) => [x.client, x.site, x.result]), [['cvs', 'hh.kz', 'hour']]);
});

test('429: вне часов площадки; закрытая площадка (perDay 0) — без retry_at', async (t) => {
  const s = await boot(t);
  await s.clock.tick(10 * H); // 22:00 по Алматы
  const late = await s.act(CVS, { do: 'begin', task: 'x', site: 'hh.kz' });
  assert.deepEqual([late.status, late.json.reason, late.json.retry_at], [429, 'hours', new Date(at(10, 0, 6)).toISOString()]);
  const closed = await s.act(CVS, { do: 'begin', task: 'x', site: 'linkedin.com' });
  assert.deepEqual([closed.status, closed.json.reason, closed.json.retry_at], [429, 'closed', null]);
  assert.equal(closed.headers.get('retry-after'), null);
});

test('cost списывается целиком: сессия на 60 не влезает в perDay 25', async (t) => {
  const s = await boot(t);
  const r = await s.act(CVS, { do: 'begin', task: 'x', site: 'greenhouse.io', cost: 60 });
  assert.deepEqual([r.status, r.json.reason, r.json.retry_at], [429, 'too_big', null]);
  assert.equal(s.limits.snapshot()['greenhouse.io'].usedDay, 0);
});

test('503: выход не из Алматы или не определился; браузер не трогается, лимит не списан, слот свободен', async (t) => {
  const s = await boot(t);
  s.echo.reply = NL;
  const wrong = await s.act(CVS, { do: 'begin', task: 'x', site: 'hh.kz' });
  assert.deepEqual([wrong.status, wrong.json.error], [503, 'egress_wrong']);
  await s.clock.tick(61000); // «не оттуда» держится в кэше минуту
  s.echo.reply = new Error('сервис-эхо недоступен');
  const unknown = await s.act(CVS, { do: 'begin', task: 'x', site: 'hh.kz' });
  assert.deepEqual([unknown.status, unknown.json.error], [503, 'egress_unknown']);
  assert.equal(s.driver.count('open'), 0);
  assert.equal(s.limits.snapshot()['hh.kz'].usedDay, 0);
  assert.equal(s.queue.snapshot().active, null);
  s.echo.reply = KZ;
  assert.ok(await s.begin(CVS), 'выход вернулся — работаем');
  assert.deepEqual(s.journal.tail(50).filter((x) => x.event === 'egress').map((x) => x.result), ['egress_wrong', 'egress_unknown', 'ok'], 'смены состояния выхода: плохо, иначе плохо, снова хорошо');
  assert.deepEqual(s.journal.tail(50).filter((x) => x.event === 'begin' && x.client).map((x) => x.result), ['egress_wrong', 'egress_unknown', 'ok']);
});

test('выход проверяется на каждом begin, но не чаще раза в минуту', async (t) => {
  const s = await boot(t);
  const a = await s.begin(CVS);
  await s.act(CVS, { do: 'end' }, a);
  const b = await s.begin(TINDER, { task: 'x', site: 'tinder.com' });
  await s.act(TINDER, { do: 'end' }, b);
  assert.equal(s.echo.calls, 1);
  await s.clock.tick(61000);
  await s.begin(CVS);
  assert.equal(s.echo.calls, 2);
});

test('выход пропал, пока задача идёт: окно закрывается, мне сообщение; восстановился — сообщение', async (t) => {
  const s = await boot(t);
  await s.egress.start();
  const task = await s.begin(CVS);
  s.echo.reply = NL;
  await s.timer.fn();
  assert.deepEqual(s.driver.calls.at(-1), ['close', 'd1']);
  assert.equal(s.notified.length, 1);
  assert.match(s.notified[0], /NL/);
  const r = await s.act(CVS, { do: 'click', target: 1 }, task);
  assert.deepEqual([r.status, r.json.error, r.json.reason], [404, 'no_task', 'egress']);
  assert.equal(s.queue.snapshot().active, null);
  await s.timer.fn();
  assert.equal(s.notified.length, 1, 'пока не меняется, не повторяется');
  s.echo.reply = KZ;
  await s.timer.fn();
  assert.equal(s.notified.length, 2);
  assert.match(s.notified[1], /восстанов/);
});

test('действие, прерванное потерей выхода, получает 503, а не «внутреннюю ошибку»', async (t) => {
  const s = await boot(t);
  await s.egress.start();
  const task = await s.begin(CVS);
  let fail;
  s.driver.onAct = () => new Promise((_, reject) => { fail = () => reject(new Error('Target closed')); });
  const pending = s.act(CVS, { do: 'click', target: 1 }, task);
  await until(() => fail, 'действие дошло до Driver');
  s.echo.reply = NL;
  await s.timer.fn();
  fail();
  const r = await pending;
  assert.deepEqual([r.status, r.json.error], [503, 'egress_wrong']);
});

test('begin не удался на открытии окна: 500, лимит возвращён, слот свободен', async (t) => {
  const s = await boot(t);
  s.driver.onOpen = async () => { throw new Error('CDP недоступен'); };
  const r = await s.act(CVS, { do: 'begin', task: 'x', site: 'hh.kz', cost: 2 });
  assert.deepEqual([r.status, r.json], [500, { error: 'internal' }]);
  assert.equal(s.limits.snapshot()['hh.kz'].usedDay, 0);
  assert.equal(s.queue.snapshot().active, null);
  s.driver.onOpen = null;
  assert.ok(await s.begin(CVS, { cost: 2 }));
});

// ---------------------------------------------------------------- ошибки Driver

test('ошибки Driver переводятся в коды: 400, 403, 404, 410, 422 с кандидатами', async (t) => {
  const s = await boot(t);
  const task = await s.begin(CVS);
  const candidates = [{ ref: 3, text: 'Откликнуться' }, { ref: 9, text: 'Откликнуться снова' }];
  const cases = [
    [400, 'bad_request', {}], [403, 'forbidden', {}], [404, 'not_found', {}],
    [410, 'stale_ref', {}], [422, 'ambiguous', { candidates }],
  ];
  for (const [status, code, extra] of cases) {
    s.driver.onAct = () => { throw driverError(status, code, extra); };
    const r = await s.act(CVS, { do: 'click', target: 'Откликнуться' }, task);
    assert.deepEqual([r.status, r.json.error], [status, code]);
    if (extra.candidates) assert.deepEqual(r.json.candidates, candidates);
  }
  s.driver.onAct = null;
  assert.equal((await s.act(CVS, { do: 'click', target: 3 }, task)).status, 200, 'задача после ошибки жива');
  assert.deepEqual(s.journal.tail(50).filter((x) => x.event === 'act').map((x) => x.result), ['bad_request', 'forbidden', 'not_found', 'stale_ref', 'ambiguous', 'ok']);
});

test('сайт не открылся (502) и браузер пропал (503) доходят до клиента как есть, а не как 500', async (t) => {
  const s = await boot(t);
  const task = await s.begin(CVS);
  for (const [status, code] of [[502, 'nav_failed'], [503, 'browser_gone']]) {
    s.driver.onAct = () => { throw driverError(status, code); };
    const r = await s.act(CVS, { do: 'goto', url: 'https://hh.kz/vacancy/1' }, task);
    assert.deepEqual([r.status, r.json.error], [status, code]);
  }
  s.driver.onAct = null;
});

test('ошибки Driver на /view переводятся так же', async (t) => {
  const s = await boot(t);
  const task = await s.begin(CVS);
  s.driver.onView = () => { throw driverError(404, 'not_found'); };
  assert.deepEqual((await s.call('/view', { token: CVS, task })).status, 404);
  s.driver.onView = () => { throw new Error('Protocol error: Target closed'); };
  const r = await s.call('/view', { token: CVS, task });
  assert.deepEqual([r.status, r.json], [500, { error: 'internal' }]);
});

test('неизвестная ошибка: 500 без деталей наружу, детали в журнале без введённого текста', async (t) => {
  const s = await boot(t);
  const task = await s.begin(CVS);
  s.driver.onAct = () => { throw new Error('locator.fill: Timeout 30000ms exceeded. Call log: - fill("hunter2-пароль") at /srv/meatsuit/driver.js:88'); };
  const r = await s.act(CVS, { do: 'fill', target: 4, text: 'hunter2-пароль' }, task);
  assert.deepEqual([r.status, r.json], [500, { error: 'internal' }]);
  assert.ok(!r.text.includes('Timeout') && !r.text.includes('driver.js'), 'деталей наружу нет');
  const err = s.journal.tail(50).find((x) => x.event === 'error');
  assert.ok(err, 'ошибка записана');
  assert.match(err.detail, /Timeout 30000ms/);
  assert.ok(!JSON.stringify(s.journal.tail(50)).includes('hunter2'));
  assert.equal((await s.act(CVS, { do: 'end' }, task)).status, 200, 'задачу можно закрыть');
});

// ---------------------------------------------------------------- needs_human

test('guard: 409 needs_human, окно остаётся, мне сообщение, до resume действий нет', async (t) => {
  const s = await boot(t);
  const task = await s.begin(CVS);
  s.driver.onAct = () => ({ ok: true, url: 'https://hh.kz/checkpoint?x=secret', settled: true, guard: 'captcha' });
  const r = await s.act(CVS, { do: 'click', target: 7 }, task);
  assert.deepEqual([r.status, r.json.error, r.json.guard], [409, 'needs_human', 'captcha']);
  assert.equal(s.driver.count('close'), 0, 'окно открыто: я решу в зеркале');
  assert.equal(s.notified.length, 1);
  assert.ok(s.notified[0].includes('hh.kz') && s.notified[0].includes('cvs:hh-apply'));
  assert.ok(!s.notified[0].includes('secret'), 'адрес страницы в Telegram не уходит');

  s.driver.onAct = null;
  const acts = s.driver.count('act');
  const blocked = await s.act(CVS, { do: 'click', target: 8 }, task);
  assert.deepEqual([blocked.status, blocked.json.error, blocked.json.guard], [409, 'needs_human', 'captcha']);
  assert.equal(s.driver.count('act'), acts, 'пока не resume, на странице капчи ничего не нажимается');
  assert.equal(s.notified.length, 1, 'повторно не пишем');
  assert.equal((await s.call('/view', { token: CVS, task })).status, 200, 'смотреть можно');

  s.driver.onResume = () => ({ guard: 'captcha' });
  const still = await s.act(CVS, { do: 'resume' }, task);
  assert.deepEqual([still.status, still.json.error], [409, 'needs_human']);
  s.driver.onResume = null;
  const ok = await s.act(CVS, { do: 'resume' }, task);
  assert.deepEqual([ok.status, ok.json], [200, { ok: true, guard: null }]);
  assert.equal((await s.act(CVS, { do: 'click', target: 7 }, task)).status, 200, 'после resume работа продолжается');
  assert.deepEqual(s.journal.tail(50).filter((x) => x.event === 'guard').map((x) => x.result), ['captcha']);
});

test('guard: Driver может и бросить 409 needs_human, это то же самое', async (t) => {
  const s = await boot(t);
  const task = await s.begin(CVS);
  s.driver.onAct = () => { throw driverError(409, 'needs_human', { guard: 'login' }); };
  const r = await s.act(CVS, { do: 'goto', url: 'https://hh.kz/' }, task);
  assert.deepEqual([r.status, r.json.error, r.json.guard], [409, 'needs_human', 'login']);
  assert.equal(s.notified.length, 1);
  assert.equal(s.driver.count('close'), 0);
});

test('guard: пока человек решает капчу, окно не закрывается по простою за 5 минут, но не висит вечно', async (t) => {
  const s = await boot(t);
  const task = await s.begin(CVS);
  s.driver.onAct = () => ({ ok: true, url: 'https://hh.kz/', settled: true, guard: 'captcha' });
  await s.act(CVS, { do: 'click', target: 7 }, task);
  await s.clock.tick(29 * MIN);
  assert.equal(s.driver.count('close'), 0);
  await s.clock.tick(MIN);
  assert.deepEqual(s.driver.calls.at(-1), ['close', 'd1']);
});

test('resume без guard ничего не ломает, а после resume срок простоя снова обычный', async (t) => {
  const s = await boot(t);
  const task = await s.begin(CVS);
  s.driver.onAct = () => ({ ok: true, url: 'https://hh.kz/', settled: true, guard: 'captcha' });
  await s.act(CVS, { do: 'click', target: 7 }, task);
  s.driver.onAct = null;
  assert.equal((await s.act(CVS, { do: 'resume' }, task)).status, 200);
  await s.clock.tick(5 * MIN);
  assert.deepEqual(s.driver.calls.at(-1), ['close', 'd1']);
});

// ---------------------------------------------------------------- пауза площадки после проверки

test('guard: после needs_human площадка замирает, следующий begin — 429 challenge_pause до конца паузы', async (t) => {
  const s = await boot(t);
  const task = await s.begin(CVS);
  s.driver.onAct = () => ({ ok: true, url: 'https://hh.kz/checkpoint', settled: true, guard: 'captcha' });
  assert.equal((await s.act(CVS, { do: 'click', target: 7 }, task)).status, 409);
  assert.deepEqual(s.limits.status('hh.kz', s.clock.now()).frozenUntil, at(0, 0, 8), 'сегодня 5-е, пауза 3 суток: до начала 8-го');
  const ev = s.journal.tail(50).filter((x) => x.event === 'challenge');
  assert.deepEqual(ev.map((x) => [x.client, x.site, x.result, x.until]), [['cvs', 'hh.kz', 'pause', new Date(at(0, 0, 8)).toISOString()]]);

  assert.equal((await s.act(CVS, { do: 'end' }, task)).status, 200);
  const opens = s.driver.count('open');
  const r = await s.act(CVS, { do: 'begin', task: 'cvs:hh-apply', site: 'hh.kz', wait: 0 });
  assert.deepEqual([r.status, r.json.error, r.json.reason], [429, 'limit', 'challenge_pause']);
  assert.equal(r.json.retry_at, new Date(at(10, 0, 8)).toISOString(), 'retry_at — когда begin реально пройдёт: 8-го окно hh.kz открывается в 10:00');
  assert.ok(Number(r.headers.get('retry-after')) > 2 * 24 * 3600);
  assert.equal(s.driver.count('open'), opens, 'окно в паузу не открывается');
  assert.equal(s.limits.status('hh.kz', s.clock.now()).usedDay, 1, 'отказ ничего не списал');
  assert.ok(s.journal.tail(50).some((x) => x.event === 'limit' && x.result === 'challenge_pause' && x.site === 'hh.kz'));
  assert.equal((await s.act(CVS, { do: 'begin', task: 'cvs:gh', site: 'greenhouse.io', wait: 0 })).status, 200, 'другие площадки работают');

  await s.clock.tick(3 * 24 * H);
  const again = await s.act(CVS, { do: 'begin', task: 'cvs:hh-apply', site: 'hh.kz', wait: 0 });
  assert.equal(again.status, 200, 'через трое суток пауза кончилась');
});

test('guard: needs_human из Driver (слетел вход) и блок тоже замораживают площадку; повторы одной причины пауз не множат', async (t) => {
  const s = await boot(t);
  const task = await s.begin(CVS);
  s.driver.onAct = () => { throw driverError(409, 'needs_human', { guard: 'login' }); };
  assert.equal((await s.act(CVS, { do: 'goto', url: 'https://hh.kz/' }, task)).status, 409);
  assert.ok(s.limits.status('hh.kz', s.clock.now()).frozenUntil, 'слетел вход: пауза');
  assert.equal((await s.act(CVS, { do: 'click', target: 7 }, task)).status, 409);
  s.driver.onResume = () => ({ guard: 'login' });
  assert.equal((await s.act(CVS, { do: 'resume' }, task)).status, 409);
  assert.equal(s.journal.tail(50).filter((x) => x.event === 'challenge').length, 1, 'одна причина — одна запись');
});

test('guard: блок на площадке с challengePauseDays: пауза ровно на столько суток', async (t) => {
  const s = await boot(t, { sites: { 'hh.kz': { perDay: 3, challengePauseDays: 1 }, 'greenhouse.io': { perDay: 3 } } });
  const task = await s.begin(CVS);
  s.driver.onAct = () => ({ ok: true, url: 'https://hh.kz/', settled: true, guard: 'blocked' });
  await s.act(CVS, { do: 'click', target: 7 }, task);
  assert.equal(s.limits.status('hh.kz', s.clock.now()).frozenUntil, at(0, 0, 6), 'сутки: до начала 6-го');
  await s.act(CVS, { do: 'end' }, task);
  const r = await s.act(CVS, { do: 'begin', task: 'x', site: 'hh.kz', wait: 0 });
  assert.deepEqual([r.status, r.json.reason, r.json.retry_at], [429, 'challenge_pause', new Date(at(0, 0, 6)).toISOString()]);
});

test('GET /: эффективный лимит сегодня, выходной день и пауза видны на странице', async (t) => {
  const s = await boot(t, { sites: { 'hh.kz': { perDay: 20, ramp: { days: 10, startShare: 0.5 } }, 'rest.test': { perDay: 5, restDaysPerWeek: 6 }, 'greenhouse.io': { perDay: 4 } } });
  let page = (await s.call('/')).text;
  assert.match(page, /0 \/ 10/, 'день 0 роста: 10 из 20');
  assert.ok(page.includes('из 20'), 'видно и полный perDay');
  assert.match(page, /0 \/ 4/);
  while (!s.limits.status('rest.test', s.clock.now()).rest) await s.clock.tick(24 * H);
  page = (await s.call('/')).text;
  assert.ok(page.includes('выходной'), 'сегодня выходной');
  const task = await s.begin(CVS);
  s.driver.onAct = () => ({ ok: true, url: 'https://hh.kz/', settled: true, guard: 'captcha' });
  await s.act(CVS, { do: 'click', target: 7 }, task);
  page = (await s.call('/')).text;
  assert.match(page, /пауза до \d\d\.\d\d/, 'пауза до такого-то числа');
});

// ---------------------------------------------------------------- страница статуса и журнал

test('GET /: страница статуса без токена; очередь, лимиты, выход, журнал; без токенов, страниц и ввода', async (t) => {
  const s = await boot(t);
  const task = await s.begin(CVS);
  await s.act(TINDER, { do: 'begin', task: 'tinder:like', site: 'tinder.com', wait: 0 });
  await s.act(CVS, { do: 'fill', target: 4, text: 'S3cr3t-пароль' }, task);
  await s.call('/view', { token: CVS, task });
  const r = await s.call('/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  for (const want of ['cvs:hh-apply', 'tinder:like', 'hh.kz', 'tinder.com', 'linkedin.com', 'KZ', 'AS64500', 'begin', 'act']) assert.ok(r.text.includes(want), `на странице нет «${want}»`);
  assert.match(r.text, /1 \/ 3/, 'расход за сутки: 1 из 3');
  for (const hidden of [CVS, TINDER, 'Bearer', 'S3cr3t', 'СЕКРЕТНОЕ-СОДЕРЖИМОЕ-СТРАНИЦЫ', 'x-task']) assert.ok(!r.text.includes(hidden), `на странице не должно быть «${hidden}»`);
  assert.ok(!r.text.includes('203.0.113'), 'IP на странице нет');
});

test('GET /: названия задач из запросов экранируются', async (t) => {
  const s = await boot(t);
  await s.begin(CVS, { task: '<script>alert(1)</script>' });
  const r = await s.call('/');
  assert.ok(!r.text.includes('<script>alert(1)'));
  assert.ok(r.text.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
});

test('GET /: пока выход не проверялся и когда он не тот — так и написано', async (t) => {
  const s = await boot(t);
  assert.match((await s.call('/')).text, /не проверялся/);
  s.echo.reply = NL;
  await s.act(CVS, { do: 'begin', task: 'x', site: 'hh.kz' });
  const r = await s.call('/');
  assert.match(r.text, /NL/);
  assert.match(r.text, /egress_wrong/);
});

test('введённый текст, пароли и запросы в адресах не попадают в журнал и на страницу', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meatsuit-journal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'data', 'journal.jsonl');
  const s = await boot(t, { journalFile: file });
  const task = await s.begin(CVS);
  await s.act(CVS, { do: 'fill', target: 4, text: 'S3cr3t-пароль' }, task);
  await s.act(CVS, { do: 'fill', target: 'Пароль', text: 'S3cr3t-пароль' }, task);
  await s.act(CVS, { do: 'type', text: 'hunter2 и ещё текст' }, task);
  await s.act(CVS, { do: 'key', key: '§' }, task);
  await s.act(CVS, { do: 'key', key: 'Enter' }, task);
  await s.act(CVS, { do: 'goto', url: 'https://hh.kz/login?token=SECRETQUERY#frag-secret' }, task);
  s.driver.onAct = () => { throw new Error('fill("S3cr3t-пароль") упал'); };
  await s.act(CVS, { do: 'fill', target: 4, text: 'S3cr3t-пароль' }, task);
  await s.act(CVS, { do: 'end' }, task);

  const raw = fs.readFileSync(file, 'utf8');
  const status = (await s.call('/')).text;
  for (const secret of ['S3cr3t', 'hunter2', 'ещё текст', '§', 'SECRETQUERY', 'frag-secret', CVS]) {
    assert.ok(!raw.includes(secret), `в журнале не должно быть «${secret}»`);
    assert.ok(!status.includes(secret), `на странице не должно быть «${secret}»`);
  }
  assert.ok(raw.includes('Enter'), 'названия клавиш пишутся');
  assert.ok(raw.includes('/login'), 'путь адреса пишется, запрос — нет');
  const lines = raw.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.slice(0, 2).map((l) => [l.client, l.task, l.site, l.event]), [['cvs', 'cvs:hh-apply', 'hh.kz', 'begin'], ['cvs', 'cvs:hh-apply', 'hh.kz', 'act']]);
  assert.ok(lines.every((l) => l.ts && l.event));
});

test('журнал: хвост для страницы, файл дописывается между запусками', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meatsuit-journal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'journal.jsonl');
  const a = createJournal({ file, now: () => at(12) });
  for (let i = 0; i < 5; i++) a.write({ event: 'act', result: `r${i}` });
  const b = createJournal({ file, now: () => at(13) });
  assert.deepEqual(b.tail(3).map((x) => x.result), ['r2', 'r3', 'r4'], 'после перезапуска хвост виден');
  b.write({ event: 'end', result: 'ok' });
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 6);
  assert.equal(b.tail(1)[0].event, 'end');
});

// ---------------------------------------------------------------- клиенты

test('normalizeClients: имя, токен, площадки; примеры-заглушки и дубли отвергаются', () => {
  assert.deepEqual(normalizeClients([{ name: 'cvs', token: CVS, sites: ['HH.kz'] }]), [{ name: 'cvs', token: CVS, sites: ['hh.kz'] }]);
  const bad = (cfg, re) => assert.throws(() => normalizeClients(cfg), re, JSON.stringify(cfg));
  bad(null, /clients/);
  bad([], /клиент/);
  bad([{ token: CVS, sites: ['a.test'] }], /name/);
  bad([{ name: 'cvs', sites: ['a.test'] }], /token/);
  bad([{ name: 'cvs', token: 'short', sites: ['a.test'] }], /token/);
  bad([{ name: 'cvs', token: 'CHANGE-ME-cvs-0123456789abcdef', sites: ['a.test'] }], /CHANGE-ME|заглушк/);
  bad([{ name: 'cvs', token: CVS, sites: [] }], /sites/);
  bad([{ name: 'cvs', token: CVS, sites: ['https://a.test/x'] }], /sites/);
  bad([{ name: 'a', token: CVS, sites: ['a.test'] }, { name: 'b', token: CVS, sites: ['a.test'] }], /повтор|одинаков/);
  bad([{ name: 'a', token: CVS, sites: ['a.test'] }, { name: 'a', token: TINDER, sites: ['a.test'] }], /повтор|одинаков/);
});

test('клиент со звёздочкой в sites допускается на любую площадку из sites.json, но не вне его', async (t) => {
  const s = await boot(t, { server: { clients: [{ name: 'boss', token: 'tok-boss-0123456789abcdef', sites: ['*'] }] } });
  const ok = await s.act('tok-boss-0123456789abcdef', { do: 'begin', task: 'x', site: 'tinder.com', allow: ['anything.example'] });
  assert.equal(ok.status, 200);
  await s.act('tok-boss-0123456789abcdef', { do: 'end' }, ok.json.task);
  const no = await s.act('tok-boss-0123456789abcdef', { do: 'begin', task: 'x', site: 'unlisted.test' });
  assert.deepEqual([no.status, no.json.reason], [403, 'site_unknown']);
});

// ---------------------------------------------------------------- часовой пояс сервиса

test('parseArgs: часовой пояс — по умолчанию Алматы, из MEATSUIT_TZ или из --tz', () => {
  assert.equal(parseArgs([], {}).tz, 'Asia/Almaty');
  assert.equal(parseArgs([], { MEATSUIT_TZ: 'Europe/Berlin' }).tz, 'Europe/Berlin');
  assert.equal(parseArgs(['--tz', 'America/New_York'], { MEATSUIT_TZ: 'Europe/Berlin' }).tz, 'America/New_York');
});

test('parseArgs: несуществующий пояс отвергается сразу, а не посреди суток', () => {
  assert.throws(() => parseArgs(['--tz', 'Mars/Olympus'], {}), /Mars\/Olympus/);
  assert.throws(() => parseArgs([], { MEATSUIT_TZ: 'не пояс' }), /не пояс/);
});
