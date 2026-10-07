/**
 * Driver: разбор целей и действий, ожидание «страница успокоилась» (без браузера,
 * на подставных страницах и виртуальных часах), потом то же на настоящем Chromium
 * по локальным страницам. Без patchright или браузера вторая часть пропускается.
 *
 *   NODE_PATH=…/node_modules node --test test/driver.test.js
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const chromium = require('../testkit/browser-chromium.js');
const { serve } = require('../testkit/browser-site.js');
const { createDriver, DriverError, parseTarget, parseAction, hostAllowed, checkGoto, watchNetwork, settle } = require('../driver.js');

// ---------------------------------------------------------------- без браузера

test('DriverError: status и code по контракту, в том числе при разных способах создания', () => {
  const table = { bad_request: 400, forbidden: 403, not_found: 404, needs_human: 409, stale_ref: 410, ambiguous: 422 };
  for (const [code, status] of Object.entries(table)) {
    const e = new DriverError(code, 'сообщение');
    assert.ok(e instanceof Error && e instanceof DriverError);
    assert.deepEqual([e.status, e.code, e.message, e.name], [status, code, 'сообщение', 'DriverError']);
  }
  const a = new DriverError('ambiguous', 'несколько', { candidates: [{ ref: 1, text: 'x' }] });
  assert.deepEqual(a.candidates, [{ ref: 1, text: 'x' }]);
  const b = new DriverError(409, 'needs_human', 'капча', { guard: 'captcha' });
  assert.deepEqual([b.status, b.code, b.guard], [409, 'needs_human', 'captcha']);
  const c = new DriverError({ status: 410, code: 'stale_ref', message: 'устарел' });
  assert.deepEqual([c.status, c.code, c.message], [410, 'stale_ref', 'устарел']);
});

test('parseTarget: число — номер, строка — текст, объект — css или номер', () => {
  assert.deepEqual(parseTarget(7), { ref: 7 });
  assert.deepEqual(parseTarget('Откликнуться'), { text: 'Откликнуться' });
  assert.deepEqual(parseTarget('  7  '), { text: '7' }, 'строка с цифрами — это текст кнопки (страницы пагинации), а не номер');
  assert.deepEqual(parseTarget({ css: 'a.next' }), { css: 'a.next' });
  assert.deepEqual(parseTarget({ ref: 3 }), { ref: 3 }, 'кандидат из ответа ambiguous можно вернуть как есть');
  for (const bad of [undefined, null, '', '   ', 0, -1, 1.5, NaN, true, [], {}, { css: '' }, { css: 5 }, { css: 'a', ref: 1 }, { other: 1 }]) {
    assert.throws(() => parseTarget(bad), (e) => e instanceof DriverError && e.status === 400 && e.code === 'bad_request', `принято ${JSON.stringify(bad)}`);
  }
});

test('parseAction: нужные поля, лишнее и неизвестное — 400', () => {
  assert.deepEqual(parseAction({ do: 'goto', url: 'https://a.test/' }), { do: 'goto', url: 'https://a.test/' });
  assert.deepEqual(parseAction({ do: 'click', target: 'Войти' }), { do: 'click', target: { text: 'Войти' } });
  assert.deepEqual(parseAction({ do: 'fill', target: 3, text: 'Иван' }), { do: 'fill', target: { ref: 3 }, text: 'Иван' });
  assert.deepEqual(parseAction({ do: 'fill', target: 3, text: '' }), { do: 'fill', target: { ref: 3 }, text: '' }, 'пустой текст — очистить поле');
  assert.deepEqual(parseAction({ do: 'type', text: 'привет' }), { do: 'type', text: 'привет' });
  assert.deepEqual(parseAction({ do: 'key', key: 'Enter' }), { do: 'key', key: 'Enter' });
  assert.deepEqual(parseAction({ do: 'scroll', px: -300 }), { do: 'scroll', px: -300 });
  assert.deepEqual(parseAction({ do: 'scroll', to: 'bottom' }), { do: 'scroll', to: 'bottom' });
  assert.deepEqual(parseAction({ do: 'back' }), { do: 'back' });
  assert.deepEqual(parseAction({ do: 'pause', from: 500, to: 900 }), { do: 'pause', from: 500, to: 900 });
  const dflt = parseAction({ do: 'pause' });
  assert.ok(dflt.from > 0 && dflt.to >= dflt.from, 'пауза без границ — обычная человеческая');

  const bad = [
    null, 'click', {}, { do: 5 }, { do: 'dance' }, { do: 'begin' }, { do: 'end' }, { do: 'resume' },
    { do: 'goto' }, { do: 'goto', url: '' }, { do: 'goto', url: 5 },
    { do: 'click' }, { do: 'click', target: 0 },
    { do: 'fill', target: 1 }, { do: 'fill', text: 'x' }, { do: 'fill', target: 1, text: 5 },
    { do: 'type' }, { do: 'type', text: 5 },
    { do: 'key' }, { do: 'key', key: '' }, { do: 'key', key: 'A'.repeat(50) },
    { do: 'scroll' }, { do: 'scroll', px: 0 }, { do: 'scroll', px: 'много' }, { do: 'scroll', px: 1e9 }, { do: 'scroll', to: 'middle' }, { do: 'scroll', px: 5, to: 'bottom' },
    { do: 'pause', from: 900, to: 500 }, { do: 'pause', from: -1, to: 5 }, { do: 'pause', from: 0, to: 3600000 }, { do: 'pause', from: 'a', to: 5 },
  ];
  for (const b of bad) {
    assert.throws(() => parseAction(b), (e) => e instanceof DriverError && e.status === 400 && e.code === 'bad_request', `принято ${JSON.stringify(b)}`);
  }
});

test('createDriver: без адреса браузера — 400, а не ошибка где-то глубже', async () => {
  await assert.rejects(createDriver({}), (e) => e instanceof DriverError && e.status === 400);
  await assert.rejects(createDriver(), (e) => e instanceof DriverError && e.status === 400);
});

test('hostAllowed: сам хост и его поддомены, порт не важен, чужое и похожее нельзя', () => {
  const allow = ['hh.kz', '*.hhcdn.ru', 'https://Tinder.com/app'];
  for (const h of ['hh.kz', 'www.hh.kz', 'spb.hh.kz', 'HH.KZ', 'img.hhcdn.ru', 'hhcdn.ru', 'tinder.com', 'api.tinder.com']) assert.ok(hostAllowed(h, allow), h);
  for (const h of ['hh.kz.evil.test', 'evilhh.kz', 'hh.ru', 'kz', '', 'tinder.com.evil.test', 'localhost']) assert.ok(!hostAllowed(h, allow), h);
  assert.ok(!hostAllowed('hh.kz', []), 'пустой список ничего не разрешает');
});

test('checkGoto: только http(s) и только разрешённые хосты; относительный адрес — от текущей страницы', () => {
  const allow = ['a.test'];
  assert.equal(checkGoto('https://a.test/x?y=1#z', allow), 'https://a.test/x?y=1#z');
  assert.equal(checkGoto('http://www.a.test:8080/', allow), 'http://www.a.test:8080/');
  assert.equal(checkGoto('/vacancy/1', allow, 'https://a.test/list'), 'https://a.test/vacancy/1');
  assert.equal(checkGoto('?page=2', allow, 'https://a.test/list'), 'https://a.test/list?page=2');

  const forbidden = ['https://b.test/', 'https://a.test.evil.test/', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,<p>x</p>', 'about:blank', 'chrome://settings', 'ftp://a.test/', '//b.test/', 'https://a.test@evil.test/', 'https://a.test:pw@evil.test/'];
  for (const u of forbidden) {
    assert.throws(() => checkGoto(u, allow, 'https://a.test/'), (e) => e instanceof DriverError && e.status === 403 && e.code === 'forbidden', `пропущено ${u}`);
  }
  assert.equal(checkGoto('https://evil.test@a.test/x', allow), 'https://evil.test@a.test/x', 'хост — то, что после @, а не то, что похоже на хост до неё');
  for (const u of ['', 'не адрес', 'tinder.com', 'a.test/path', 'http://']) {
    assert.throws(() => checkGoto(u, allow, 'https://a.test/'), (e) => e instanceof DriverError && e.status === 400, `принято ${JSON.stringify(u)}`);
  }
  assert.throws(() => checkGoto('/x', allow, 'about:blank'), (e) => e.status === 400, 'относительный адрес без страницы не разрешить');
});

/** Подставная страница для ожидания: события сети и виртуальное время. */
function netPage() {
  const page = new EventEmitter();
  const clock = { t: 1000 };
  const req = (type = 'fetch') => ({ resourceType: () => type });
  return {
    page, clock, req,
    now: () => clock.t,
    sleep: async (ms) => { clock.t += ms; },
  };
}

test('settle: тихая страница успокаивается через quietMs после действия', async () => {
  const f = netPage();
  const net = watchNetwork(f.page, { now: f.now });
  const t0 = f.clock.t;
  assert.equal(await settle(net, { quietMs: 500, maxMs: 10000, now: f.now, sleep: f.sleep }), true);
  assert.ok(f.clock.t - t0 >= 500 && f.clock.t - t0 < 700, `ждал ${f.clock.t - t0} мс`);
});

test('settle: пока запрос идёт, ждёт; после ответа ещё quietMs', async () => {
  const f = netPage();
  const net = watchNetwork(f.page, { now: f.now });
  const r = f.req();
  const t0 = f.clock.t;
  f.page.emit('request', r);
  let sleeps = 0;
  const sleep = async (ms) => { f.clock.t += ms; if (++sleeps === 40) f.page.emit('requestfinished', r); }; // ответ через ~2 с
  assert.equal(await settle(net, { quietMs: 500, maxMs: 10000, now: f.now, sleep }), true);
  const spent = f.clock.t - t0;
  assert.ok(spent >= 2000 + 500 && spent < 3500, `ждал ${spent} мс`);
});

test('settle: запрос, который не кончается, — не дождался (false) к maxMs, не ошибка', async () => {
  const f = netPage();
  const net = watchNetwork(f.page, { now: f.now, longMs: 60000 });
  f.page.emit('request', f.req());
  const t0 = f.clock.t;
  assert.equal(await settle(net, { quietMs: 500, maxMs: 4000, now: f.now, sleep: f.sleep }), false);
  assert.ok(f.clock.t - t0 >= 4000 && f.clock.t - t0 < 4200);
});

test('settle: потоки (websocket, media, eventsource) не держат, свежий опрос держит, пока не станет старше longMs', async () => {
  const f = netPage();
  const net = watchNetwork(f.page, { now: f.now, longMs: 5000 });
  const t0 = f.clock.t;
  f.page.emit('request', f.req('websocket'));
  f.page.emit('request', f.req('media'));
  f.page.emit('request', f.req('eventsource'));
  f.page.emit('request', f.req('xhr')); // долгий опрос: ответа не будет
  assert.equal(await settle(net, { quietMs: 500, maxMs: 20000, now: f.now, sleep: f.sleep }), true);
  const spent = f.clock.t - t0;
  assert.ok(spent >= 5000 && spent < 6000, `ждал ${spent} мс: опрос должен держать ровно longMs`);
});

test('settle: без долгого опроса потоки страницу не задерживают', async () => {
  const f = netPage();
  const net = watchNetwork(f.page, { now: f.now, longMs: 5000 });
  const t0 = f.clock.t;
  for (const type of ['websocket', 'media', 'eventsource', 'ping']) f.page.emit('request', f.req(type));
  assert.equal(await settle(net, { quietMs: 500, maxMs: 20000, now: f.now, sleep: f.sleep }), true);
  assert.ok(f.clock.t - t0 < 1500, `ждал ${f.clock.t - t0} мс`);
});

test('settle: навигация и новый запрос в ожидании начинают отсчёт заново', async () => {
  const f = netPage();
  const net = watchNetwork(f.page, { now: f.now });
  const t0 = f.clock.t;
  let n = 0;
  const sleep = async (ms) => {
    f.clock.t += ms;
    n++;
    if (n === 6) f.page.emit('framenavigated', {}); // на 300 мс
    if (n === 14) { const r = f.req('document'); f.page.emit('request', r); f.page.emit('requestfinished', r); } // на 700 мс
  };
  assert.equal(await settle(net, { quietMs: 500, maxMs: 10000, now: f.now, sleep }), true);
  assert.ok(f.clock.t - t0 >= 700 + 500, `успокоилась слишком рано: ${f.clock.t - t0}`);
  net.dispose();
  for (const ev of ['request', 'requestfinished', 'requestfailed', 'framenavigated']) assert.equal(f.page.listenerCount(ev), 0, `dispose не снял ${ev}`);
});

// ------------------------------------------------------------ настоящий Chromium

const skip = chromium.unavailable();
let browser, site, driver, realTime, ids = [];
// Человеческий темп ускорен в 25 раз: часы рук идут быстрее настоящих и согласованы со сном, иначе план печати «догоняет» время и не ускоряется.
const SPEED = 25;
const fastHands = { sleep: (ms) => new Promise((r) => setTimeout(r, ms / SPEED)), now: () => Date.now() * SPEED };

const shop = `
  <h1>Магазин</h1>
  <button onclick="out.textContent='куплено-1'">Купить</button>
  <button onclick="out.textContent='куплено-2'">Купить</button>
  <button onclick="out.textContent='вошли'">Войти</button>
  <button onclick="out.textContent='вошли-через-google'">Войти через Google</button>
  <a href="/next">Дальше</a> <a href="/blocked">Опасная ссылка</a> <a href="/popup">Окна</a>
  <button onclick="fetch('/api/slow').then(r => r.text()).then(t => out.textContent = t)">Загрузить</button>
  <button onclick="fetch('/api/hang')">Зависнуть</button>
  <p id="out">пусто</p>`;

before(async () => {
  if (skip) return;
  browser = await chromium.launch();
  site = await serve({
    '/': shop,
    '/next': '<h1>Следующая</h1><a href="/">Назад на главную</a>',
    '/blocked': '<html><head><meta charset="utf-8"><title>Just a moment...</title></head><body><p>Checking your browser before accessing</p></body></html>',
    '/popup': '<a href="/popped" target="_blank">В новой вкладке</a> <a href="/popped" target="_blank" rel="noopener">Без связи</a>',
    '/popped': '<h1>Всплывшая страница</h1>',
    '/form': `<form action="/submitted"><label>Запрос <input name="q"></label></form>
      <label for="msg">Сообщение</label><textarea id="msg"></textarea>
      <label for="city">Город</label><select id="city" name="city" oninput="selmark.textContent += 'input:' + event.isTrusted + ' '" onchange="selmark.textContent += 'change:' + event.isTrusted + ' '"><option>Алматы</option><option>Астана</option><option>Шымкент</option></select><p id="selmark"></p>
      <input type="checkbox" id="ok"><label for="ok">Согласен</label>`,
    '/submitted': (req, res) => {
      const q = new URL(req.url, 'http://x').searchParams.get('q') || '';
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>Ответ</title><p>Вы искали: ${q.replace(/[<&]/g, '')}</p>`);
    },
    '/long': '<div style="height:2500px">длинная страница</div><p>конец</p>',
    '/api/slow': { body: 'загружено-после-ожидания', type: 'text/plain; charset=utf-8', delay: 700, raw: true },
    '/api/hang': () => { /* ответа не будет */ },
  });
  const cfg = { cdpUrl: browser.cdpUrl, env: fastHands, settle: { quietMs: 120, maxMs: 4000 } };
  driver = await createDriver(cfg);
  realTime = await createDriver({ cdpUrl: browser.cdpUrl, settle: { quietMs: 120, maxMs: 4000 } });
});

after(async () => {
  if (skip) return;
  await Promise.all(ids.map((id) => driver.close(id).catch(() => {})));
  await driver.disconnect().catch(() => {});
  await realTime.disconnect().catch(() => {});
  await site.close();
  await browser.stop();
});

/** Новое окно на локальном сайте; закрывается в after, если тест не закрыл сам. */
async function win(path = '/', allow = ['127.0.0.1']) {
  const { id } = await driver.open({ site: '127.0.0.1', allow });
  ids.push(id);
  if (path) await driver.act(id, { do: 'goto', url: site.origin + path });
  return id;
}
const refOf = (html, text) => { const m = new RegExp(`data-ms="(\\d+)"[^>]*>${text}<`).exec(html); return m && Number(m[1]); };
const rejects = async (promise, status, code) => {
  try { await promise; } catch (e) {
    assert.ok(e instanceof DriverError, `не DriverError: ${e && e.stack}`);
    assert.deepEqual([e.status, e.code], [status, code], e.message);
    return e;
  }
  assert.fail(`ждали ${status} ${code}, а вышло без ошибки`);
};

test('open: отдельное окно, а не вкладка в моём; close закрывает его', { skip }, async () => {
  const before = await chromium.windows(browser.cdpUrl);
  const { id } = await driver.open({ site: '127.0.0.1', allow: [] });
  assert.ok(typeof id === 'string' && id);
  const mid = await chromium.windows(browser.cdpUrl);
  const fresh = mid.filter((t) => !before.some((b) => b.targetId === t.targetId));
  assert.equal(fresh.length, 1, 'должна появиться одна страница');
  assert.ok(!before.some((b) => b.windowId === fresh[0].windowId), `страница открылась вкладкой в окне ${fresh[0].windowId}, а не в своём`);

  await driver.close(id);
  const end = await chromium.windows(browser.cdpUrl);
  assert.ok(!end.some((t) => t.targetId === fresh[0].targetId), 'окно не закрылось');
  await rejects(driver.view(id), 404, 'not_found');
  await rejects(driver.close(id), 404, 'not_found');
  await rejects(driver.open({}), 400, 'bad_request');
});

test('goto и view: страница открывается, в ответе head и номера', { skip }, async () => {
  const id = await win(null);
  const r = await driver.act(id, { do: 'goto', url: site.origin + '/' });
  assert.deepEqual([r.ok, r.url, r.settled, r.guard], [true, site.origin + '/', true, null]);
  const v = await driver.view(id);
  assert.equal(v.url, site.origin + '/');
  assert.equal(v.guard, null);
  assert.ok(v.html.includes('<h1>Магазин</h1>') && /data-ms="\d+"/.test(v.html));
  const top = await driver.view(id, { scope: 'viewport' });
  assert.ok(top.html.includes('Магазин'));
  assert.ok((await driver.view(id, { scope: 'document' })).html.includes('Магазин'), 'document — то же, что page (так зовёт server.js)');
  await rejects(driver.view(id, { scope: 'вся' }), 400, 'bad_request');
});

test('click по номеру из view', { skip }, async () => {
  const id = await win();
  const { html } = await driver.view(id);
  const n = refOf(html, 'Войти');
  assert.ok(n, 'нет номера у кнопки «Войти»');
  const r = await driver.act(id, { do: 'click', target: n });
  assert.deepEqual([r.ok, r.guard], [true, null]);
  assert.ok((await driver.view(id)).html.includes('<p id="out">вошли</p>') || (await driver.view(id)).html.includes('вошли<'), 'клик не сработал');
});

test('click по тексту: сначала точное совпадение, потом вхождение; по css', { skip }, async () => {
  const id = await win();
  const text = async () => /<p>([^<]*)<\/p>/.exec((await driver.view(id)).html)[1];
  await driver.act(id, { do: 'click', target: 'Войти' }); // точное: не «Войти через Google»
  assert.equal(await text(), 'вошли');
  await driver.act(id, { do: 'click', target: 'через google' }); // вхождение, регистр не важен
  assert.equal(await text(), 'вошли-через-google');
  await driver.act(id, { do: 'click', target: { css: 'a[href="/next"]' } });
  assert.equal((await driver.view(id)).url, site.origin + '/next');
});

test('неоднозначный текст: 422 ambiguous с кандидатами, номер кандидата работает', { skip }, async () => {
  const id = await win();
  const e = await rejects(driver.act(id, { do: 'click', target: 'Купить' }), 422, 'ambiguous');
  assert.equal(e.candidates.length, 2);
  assert.ok(e.candidates.every((c) => Number.isInteger(c.ref) && c.text === 'Купить'));
  await driver.act(id, { do: 'click', target: e.candidates[1].ref });
  assert.ok((await driver.view(id)).html.includes('куплено-2'));
  await rejects(driver.act(id, { do: 'click', target: { css: 'button' } }), 422, 'ambiguous');
});

test('цель не найдена: 404; кривой селектор: 400', { skip }, async () => {
  const id = await win();
  await rejects(driver.act(id, { do: 'click', target: 'Нет такой кнопки' }), 404, 'not_found');
  await rejects(driver.act(id, { do: 'click', target: { css: '#нет' } }), 404, 'not_found');
  await rejects(driver.act(id, { do: 'click', target: { css: '[[[' } }), 400, 'bad_request');
});

test('устаревший номер: 410 stale_ref (элемент пропал, новый view, переход)', { skip }, async () => {
  const id = await win();
  const first = await driver.view(id);
  const buy = refOf(first.html, 'Войти');
  await rejects(driver.act(id, { do: 'click', target: 99999 }), 410, 'stale_ref');

  const second = await driver.view(id); // новый view: прежние номера не действуют
  await rejects(driver.act(id, { do: 'click', target: buy }), 410, 'stale_ref');

  const fresh = refOf(second.html, 'Войти');
  await driver.act(id, { do: 'goto', url: site.origin + '/next' }); // навигация
  await rejects(driver.act(id, { do: 'click', target: fresh }), 410, 'stale_ref');
});

test('goto за пределы сайтов задачи и не http(s): 403, запроса к сети нет', { skip }, async () => {
  const id = await win();
  const hits = site.hits.length;
  await rejects(driver.act(id, { do: 'goto', url: `http://localhost:${site.port}/next` }), 403, 'forbidden'); // тот же сервер, но хост не из allow
  await rejects(driver.act(id, { do: 'goto', url: 'https://evil.invalid/' }), 403, 'forbidden');
  await rejects(driver.act(id, { do: 'goto', url: 'file:///etc/passwd' }), 403, 'forbidden');
  await rejects(driver.act(id, { do: 'goto', url: 'javascript:alert(1)' }), 403, 'forbidden');
  await rejects(driver.act(id, { do: 'goto', url: 'data:text/html,<p>x</p>' }), 403, 'forbidden');
  await rejects(driver.act(id, { do: 'goto', url: 'tinder.com' }), 400, 'bad_request');
  assert.equal(site.hits.length, hits, 'запрещённый переход дошёл до сети');
  assert.equal((await driver.view(id)).url, site.origin + '/', 'страница осталась прежней');
  // относительный адрес идёт от текущей страницы
  await driver.act(id, { do: 'goto', url: '/next' });
  assert.equal((await driver.view(id)).url, site.origin + '/next');
});

test('страница-блок: 409 needs_human, окно остаётся, resume перепроверяет', { skip }, async () => {
  const id = await win();
  const e = await rejects(driver.act(id, { do: 'click', target: 'Опасная ссылка' }), 409, 'needs_human');
  assert.equal(e.guard, 'captcha');
  assert.ok(e.url.endsWith('/blocked'));

  const v = await driver.view(id); // окно живо, страницу видно
  assert.equal(v.guard, 'captcha');
  assert.ok(v.html.includes('Checking your browser'));
  assert.deepEqual(await driver.resume(id), { guard: 'captcha' }, 'пока не решено, guard остаётся');

  // «я решил капчу в зеркале»: страница сменилась без участия бота
  await driver.act(id, { do: 'goto', url: site.origin + '/next' });
  assert.deepEqual(await driver.resume(id), { guard: null });
});

test('goto на страницу-блок тоже 409, а ответ guard после обычного действия — null', { skip }, async () => {
  const id = await win();
  await rejects(driver.act(id, { do: 'goto', url: site.origin + '/blocked' }), 409, 'needs_human');
  assert.equal((await driver.view(id)).guard, 'captcha');
});

test('fill: клик в поле, очистка, ввод; подпись находит поле; повторный fill заменяет', { skip }, async () => {
  const id = await win('/form');
  const value = async (name) => new RegExp(`<input[^>]*name="${name}"[^>]*value="([^"]*)"`).exec((await driver.view(id)).html)?.[1] ?? null;
  await driver.act(id, { do: 'fill', target: 'Запрос', text: 'Иван Петров, привет!' });
  assert.equal(await value('q'), 'Иван Петров, привет!');
  await driver.act(id, { do: 'fill', target: 'Запрос', text: 'второй' });
  assert.equal(await value('q'), 'второй', 'старый текст должен быть стёрт');
  await driver.act(id, { do: 'fill', target: 'Запрос', text: '' });
  assert.equal(await value('q'), null, 'пустой текст очищает поле');

  await driver.act(id, { do: 'fill', target: 'Сообщение', text: 'строка для textarea' });
  assert.ok((await driver.view(id)).html.includes('>строка для textarea</textarea>'));

  await driver.act(id, { do: 'fill', target: 'Город', text: 'Астана' });
  assert.ok((await driver.view(id)).html.includes('<option selected>Астана</option>'), 'select: вариант по тексту');
  // События выбора должны быть настоящими (isTrusted): selectOption у Playwright шлёт синтетические, их видно из страницы.
  const marks = async () => ((await driver.view(id)).html.match(/(?:input|change):(?:true|false)/g) || []).join(' ');
  assert.match(await marks(), /change:true/, `выбор варианта: change не настоящий (${await marks()})`);
  assert.doesNotMatch(await marks(), /false/, 'ни одно событие выбора не должно быть синтетическим');
  await driver.act(id, { do: 'fill', target: 'Город', text: 'Шымкент' }); // на два варианта вниз
  assert.ok((await driver.view(id)).html.includes('<option selected>Шымкент</option>'), 'select: два шага вниз');
  await driver.act(id, { do: 'fill', target: 'Город', text: 'Алматы' }); // вверх
  assert.ok((await driver.view(id)).html.includes('<option selected>Алматы</option>'), 'select: вверх');
  assert.doesNotMatch(await marks(), /false/, 'и при выборе вверх события настоящие');
  await rejects(driver.act(id, { do: 'fill', target: 'Город', text: 'Париж' }), 400, 'bad_request');
  await rejects(driver.act(id, { do: 'fill', target: 'Согласен', text: 'x' }), 400, 'bad_request');
});

test('type попадает в сфокусированное поле; key Enter отправляет форму', { skip }, async () => {
  const id = await win('/form');
  await driver.act(id, { do: 'click', target: 'Запрос' });
  await driver.act(id, { do: 'type', text: 'кириллица Mixed 123' });
  assert.ok((await driver.view(id)).html.includes('value="кириллица Mixed 123"'));
  const r = await driver.act(id, { do: 'key', key: 'Enter' });
  assert.ok(r.url.includes('/submitted?q='), r.url);
  assert.ok((await driver.view(id)).html.includes('Вы искали: кириллица Mixed 123'));
  await rejects(driver.act(id, { do: 'key', key: 'НетТакойКлавиши' }), 400, 'bad_request');
});

test('scroll: px колесом и to:bottom; back возвращает назад', { skip }, async () => {
  const id = await win('/long');
  const meta = async (name) => Number(new RegExp(`name="${name}" content="(\\d+)"`).exec((await driver.view(id)).html)[1]);
  assert.equal(await meta('scroll-y'), 0);
  await driver.act(id, { do: 'scroll', px: 600 });
  const y = await meta('scroll-y');
  assert.ok(y >= 500 && y <= 700, `прокручено на ${y}`);
  await driver.act(id, { do: 'scroll', px: -300 });
  assert.ok(await meta('scroll-y') < y, 'px со знаком минус не вернул вверх');
  await driver.act(id, { do: 'scroll', to: 'bottom' });
  assert.ok((await meta('scroll-y')) + (await meta('viewport-height')) >= (await meta('page-height')) - 2, 'до конца не дошёл');

  await driver.act(id, { do: 'goto', url: site.origin + '/next' });
  const r = await driver.act(id, { do: 'back' });
  assert.equal(r.url, site.origin + '/long');
});

test('pause: ждёт указанное время', { skip }, async () => {
  const { id } = await realTime.open({ site: '127.0.0.1' });
  ids.push(id);
  const t0 = Date.now();
  const r = await realTime.act(id, { do: 'pause', from: 300, to: 400 });
  const spent = Date.now() - t0;
  assert.equal(r.ok, true);
  assert.ok(spent >= 290 && spent < 1500, `пауза ${spent} мс`);
  await realTime.close(id);
});

test('ожидание: после клика ждёт ответ сети; зависший запрос — settled:false, не ошибка', { skip }, async () => {
  const id = await win();
  const r = await driver.act(id, { do: 'click', target: 'Загрузить' });
  assert.equal(r.settled, true);
  assert.ok((await driver.view(id)).html.includes('загружено-после-ожидания'), 'ответ сети не дождались');

  const t0 = Date.now();
  const h = await driver.act(id, { do: 'click', target: 'Зависнуть' });
  assert.equal(h.ok, true);
  assert.equal(h.settled, false);
  assert.ok(Date.now() - t0 >= 3500, 'ждал меньше maxMs');
});

test('ссылка в новой вкладке: view и act следуют за ней; close закрывает всё', { skip }, async () => {
  const before = await chromium.windows(browser.cdpUrl);
  const id = await win('/popup');
  await driver.act(id, { do: 'click', target: 'В новой вкладке' });
  assert.ok((await driver.view(id)).html.includes('Всплывшая страница'), 'остались на старой странице');
  await driver.act(id, { do: 'goto', url: site.origin + '/next' });
  assert.equal((await driver.view(id)).url, site.origin + '/next');
  await driver.close(id);
  const end = await chromium.windows(browser.cdpUrl);
  assert.equal(end.length, before.length, 'после close остались страницы окна задачи');
});

test('действия неизвестного вида и lifecycle не здесь: 400', { skip }, async () => {
  const id = await win();
  await rejects(driver.act(id, { do: 'begin' }), 400, 'bad_request');
  await rejects(driver.act(id, { do: 'dance' }), 400, 'bad_request');
  await rejects(driver.act(id, { do: 'click' }), 400, 'bad_request');
  await rejects(driver.act('нет-такого-окна', { do: 'back' }), 404, 'not_found');
});
