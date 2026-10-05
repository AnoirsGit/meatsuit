/**
 * Всплывающее на странице: диалоги, баннеры cookies, подписки, лишние вкладки.
 * Чистый выбор кнопки и порядок действий проверяются на фальшивой странице;
 * что считать всплывающим и куда реально попадает клик, решает только браузер,
 * поэтому второй блок идёт на настоящем Chromium (без него пропускается).
 *
 *   NODE_PATH=…/node_modules node --test test/life-overlay.test.js
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { seeded } = require('../human/random.js');
const { fakePage } = require('../testkit/fakepage.js');
const { chooseCloser, dismissOverlays, watchPage } = require('../life/overlay.js');

const btn = (name, extra = {}) => ({ ref: Math.floor(Math.random() * 1e6), name, x: 400, y: 300, w: 90, h: 32, ...extra });
const dialog = (buttons, kind = 'dialog') => ({ kind, text: 'Подпишитесь на рассылку', x: 300, y: 200, w: 500, h: 300, buttons });
const names = (list) => list.map((b) => b.name);
const pickName = (overlay, opts) => { const b = chooseCloser(overlay, opts); return b ? b.name : null; };

test('баннер cookies: политика reject выбирает «Отклонить», accept — «Принять»', () => {
  const banner = dialog([btn('Принять все'), btn('Отклонить все'), btn('Настроить')], 'consent');
  assert.equal(pickName(banner, { consent: 'reject' }), 'Отклонить все');
  assert.equal(pickName(banner, { consent: 'accept' }), 'Принять все');
  const en = dialog([btn('Accept all'), btn('Only necessary')], 'consent');
  assert.equal(pickName(en, { consent: 'reject' }), 'Only necessary');
});

test('баннер cookies только с «Принять»: закрывает им при любой политике, иначе он перекрывает сайт', () => {
  const banner = dialog([btn('Got it')], 'consent');
  assert.equal(pickName(banner, { consent: 'reject' }), 'Got it');
});

test('обычный диалог закрывается «закрыть» и отказом, а не согласием и не подпиской', () => {
  assert.equal(pickName(dialog([btn('Subscribe'), btn('×')])), '×');
  assert.equal(pickName(dialog([btn('Подписаться'), btn('Не сейчас')])), 'Не сейчас');
  assert.equal(pickName(dialog([btn('Allow notifications'), btn('Block')])), 'Block');
  assert.equal(pickName(dialog([btn('Нет, спасибо'), btn('Скачать приложение')])), 'Нет, спасибо');
  assert.equal(pickName(dialog([btn('Close')])), 'Close');
});

test('на диалоге без кнопки закрытия не нажимает ничего: подписка, установка, вход и реклама под запретом', () => {
  for (const only of ['Subscribe', 'Sign up now', 'Install app', 'Open in app', 'Войти', 'Зарегистрироваться', 'Скачать', 'Закрыть рекламу', 'Get the app', 'Купить']) {
    assert.equal(chooseCloser(dialog([btn(only)])), null, only);
  }
  assert.equal(chooseCloser(dialog([])), null);
});

test('значок-крестик без подписи в верхнем правом углу диалога считается кнопкой закрытия, но с низшим приоритетом', () => {
  const corner = btn('', { corner: true });
  assert.equal(chooseCloser(dialog([btn('Subscribe'), corner])), corner);
  assert.equal(pickName(dialog([corner, btn('Не сейчас')])), 'Не сейчас');
  assert.equal(chooseCloser(dialog([btn('Subscribe'), btn('', { corner: false })])), null, 'безымянная кнопка не в углу — не крестик');
});

// ---------------------------------------------------------------- порядок действий, фальшивая страница

/** probe.overlays отдаёт заготовленные ответы по очереди; boxOf — прямоугольник кнопки из описания. */
function scriptedProbe(answers) {
  let i = 0;
  const seen = [];
  return {
    seen,
    overlays: async () => { seen.push(i); return answers[Math.min(i++, answers.length - 1)]; },
    boxOf: async (_p, ref) => { for (const o of answers.flat()) for (const b of o.buttons) if (b.ref === ref) return { x: b.x, y: b.y, width: b.w, height: b.h }; return null; },
  };
}
const inside = (m, b) => m.x >= b.x && m.x <= b.x + b.w && m.y >= b.y && m.y <= b.y + b.h;

test('закрывает всплывающее настоящим кликом по кнопке, после паузы «прочитать»', async () => {
  const close = btn('×', { x: 700, y: 210, w: 28, h: 28 });
  const { page, env, log, clock } = fakePage();
  const events = [];
  const probe = scriptedProbe([[dialog([btn('Subscribe'), close])], []]);
  const res = await dismissOverlays(page, env, probe, { log: (e) => events.push(e) });

  assert.deepEqual(res, { closed: 1, stuck: false });
  const down = log.find((e) => e.op === 'down');
  const lastMove = log.filter((e) => e.op === 'move' && e.t <= down.t).pop();
  assert.ok(inside(lastMove, close), `клик мимо кнопки: (${lastMove.x},${lastMove.y})`);
  assert.ok(down.t >= 500, `закрыл через ${down.t} мс после появления: слишком быстро для человека`);
  assert.ok(clock.t < 15000, `${clock.t} мс на закрытие`);
  assert.deepEqual(events.map((e) => [e.event, e.result]), [['overlay', 'closed']]);
  assert.ok(!log.some((e) => e.op === 'kdown'), 'Esc без нужды');
});

test('нечем закрыть: один Esc; закрылось — хорошо, нет — «не закрылось», клик не делается', async () => {
  const sub = dialog([btn('Subscribe')]);
  // Esc помог: после него всплывающего нет.
  const a = fakePage();
  const pa = scriptedProbe([[sub], []]);
  assert.deepEqual(await dismissOverlays(a.page, a.env, pa, { log: () => {} }), { closed: 1, stuck: false });
  assert.deepEqual(a.log.filter((e) => e.op === 'kdown').map((e) => e.k), ['Escape']);

  // Esc не помог: всплывающее осталось.
  const b = fakePage();
  const pb = scriptedProbe([[sub]]);
  const events = [];
  assert.deepEqual(await dismissOverlays(b.page, b.env, pb, { log: (e) => events.push(e) }), { closed: 0, stuck: true });
  assert.deepEqual(b.log.filter((e) => e.op === 'kdown').map((e) => e.k), ['Escape'], 'Esc ровно один раз');
  assert.ok(!b.log.some((e) => e.op === 'down'), 'кликнул по подписке');
  assert.equal(events[events.length - 1].result, 'stuck');
});

test('всплывающее появляется снова и снова: не больше maxTries кликов, дальше «не закрылось»', async () => {
  const again = () => dialog([btn('Закрыть')]);
  const { page, env, log } = fakePage();
  const res = await dismissOverlays(page, env, scriptedProbe([[again()]]), { log: () => {}, maxTries: 2 });
  assert.equal(res.stuck, true);
  assert.equal(log.filter((e) => e.op === 'down').length, 2);
});

test('нет всплывающего — ничего не трогает и почти не тратит время', async () => {
  const { page, env, log, clock } = fakePage();
  assert.deepEqual(await dismissOverlays(page, env, scriptedProbe([[]]), { log: () => {} }), { closed: 0, stuck: false });
  assert.equal(log.length, 0);
  assert.ok(clock.t < 1000, `${clock.t} мс на пустую проверку`);
});

test('политика cookies доходит до выбора кнопки', async () => {
  const reject = btn('Отклонить', { x: 100, y: 500 }), accept = btn('Принять', { x: 600, y: 500 });
  const banner = () => dialog([accept, reject], 'consent');
  for (const [consent, want] of [['reject', reject], ['accept', accept]]) {
    const { page, env, log } = fakePage();
    await dismissOverlays(page, env, scriptedProbe([[banner()], []]), { log: () => {}, consent });
    const down = log.find((e) => e.op === 'down');
    const m = log.filter((e) => e.op === 'move' && e.t <= down.t).pop();
    assert.ok(inside(m, want), `${consent}: клик не туда (${m.x},${m.y})`);
  }
});

// ---------------------------------------------------------------- лишние окна и системные диалоги

test('системный диалог (alert, confirm) закрывается отказом через человеческую паузу, уход со страницы разрешается', async () => {
  const { page, env, clock } = fakePage();
  watchPage(page, env, () => {});
  const made = (type) => { const d = { type: () => type, done: null, dismiss: async () => { d.done = ['dismiss', clock.t]; }, accept: async () => { d.done = ['accept', clock.t]; } }; return d; };
  for (const [type, want] of [['alert', 'dismiss'], ['confirm', 'dismiss'], ['prompt', 'dismiss'], ['beforeunload', 'accept']]) {
    const d = made(type);
    const t0 = clock.t;
    await page.emit('dialog', d);
    assert.equal(d.done[0], want, type);
    assert.ok(d.done[1] - t0 >= 500, `${type}: ответил за ${d.done[1] - t0} мс`);
  }
});

test('всплывшая вкладка (реклама, window.open) закрывается через паузу, а наша остаётся', async () => {
  const { page, env, clock } = fakePage();
  const events = [];
  watchPage(page, env, (e) => events.push(e));
  let closedAt = null;
  const t0 = clock.t;
  await page.emit('popup', { close: async () => { closedAt = clock.t; } });
  assert.ok(closedAt !== null && closedAt - t0 >= 500, `закрыта через ${closedAt - t0} мс`);
  assert.deepEqual(events.map((e) => e.event), ['popup-closed']);
});

test('страница без on() (нечем следить) не ломает watchPage', () => {
  assert.doesNotThrow(() => watchPage({}, fakePage().env, () => {}));
});

// ---------------------------------------------------------------- настоящий браузер

const chromium = require('../testkit/browser-chromium.js');
const { serve } = require('../testkit/browser-site.js');
const skip = chromium.unavailable();
const probe = skip ? null : require('../life/probe.js');
const human = require('../human.js');

let browser, cdp, context;
before(async () => {
  if (skip) return;
  browser = await chromium.launch();
  const c = await chromium.connect(browser.cdpUrl);
  cdp = c.browser;
  context = c.context;
});
after(async () => {
  if (skip) return;
  await cdp.close().catch(() => {});
  await browser.stop();
});

async function withPage(routes, fn) {
  const site = await serve(routes);
  const page = await context.newPage();
  try {
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.goto(`${site.origin}/`);
    return await fn(page, site);
  } finally { await page.close().catch(() => {}); await site.close(); }
}
const body = (inner) => `<!doctype html><html><head><meta charset="utf-8"><title>Тест</title></head><body style="margin:0;font:16px sans-serif">${inner}</body></html>`;
const realEnv = { sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 60))), now: Date.now, rnd: seeded(5) }; // паузы ужаты: проверяем куда, а не как долго

const COOKIE = `<div id="b" style="position:fixed;left:0;right:0;bottom:0;background:#eee;padding:16px;z-index:50">Мы используем cookies.
  <button id="acc" onclick="document.getElementById('b').remove()">Принять все</button>
  <button id="rej" onclick="document.getElementById('b').remove();window.__rejected=1">Отклонить все</button></div>`;
const MODAL = `<div role="dialog" aria-modal="true" id="m" style="position:fixed;top:120px;left:300px;width:500px;height:300px;background:#fff;border:1px solid #000;z-index:100">
  <button aria-label="Закрыть" id="x" style="position:absolute;top:6px;right:6px;width:30px;height:30px" onclick="document.getElementById('m').remove()">×</button>
  <h3>Подпишитесь!</h3><button id="sub" onclick="window.__subscribed=1">Subscribe</button></div>`;

test('настоящий браузер: баннер cookies и модальное окно находятся, скрытое и мелкое — нет', { skip }, async () => {
  const page1 = await withPage({ '/': body(`<h1>Статья</h1>${COOKIE}${MODAL}`) }, (p) => probe.overlays(p));
  assert.deepEqual(page1.map((o) => o.kind).sort(), ['consent', 'dialog']);
  const m = page1.find((o) => o.kind === 'dialog');
  assert.ok(m.buttons.some((b) => b.name === 'Закрыть'), `кнопки модального окна: ${names(m.buttons)}`);
  const cons = page1.find((o) => o.kind === 'consent');
  assert.deepEqual(names(cons.buttons).sort(), ['Отклонить все', 'Принять все']);

  const hidden = {
    'display:none': '<div role="dialog" style="display:none"><button>×</button></div>',
    'visibility:hidden': '<div role="dialog" style="position:fixed;top:100px;left:100px;width:400px;height:300px;visibility:hidden"><button>×</button></div>',
    'opacity:0': '<div role="dialog" style="position:fixed;top:100px;left:100px;width:400px;height:300px;opacity:0"><button>×</button></div>',
    'за краем окна': '<div role="dialog" style="position:fixed;top:-5000px;left:100px;width:400px;height:300px"><button>×</button></div>',
    'узкая шапка с меню': '<div style="position:fixed;top:0;left:0;right:0;height:50px;background:#ddd;z-index:200"><button>Меню</button> <button>Войти</button></div>',
    'чат-кнопка в углу': '<button style="position:fixed;right:20px;bottom:20px;width:60px;height:60px;z-index:300">Чат</button>',
  };
  for (const [name, html] of Object.entries(hidden)) {
    const found = await withPage({ '/': body(`<h1>Статья</h1>${html}`) }, (p) => probe.overlays(p));
    assert.deepEqual(found, [], name);
  }
});

test('настоящий браузер: оверлей без role, закрытый перекрытием и внутри iframe', { skip }, async () => {
  const bare = '<div style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:999"><div style="margin:100px auto;width:400px;height:250px;background:#fff;position:relative"><span id="closebare" role="button" aria-label="Close" style="position:absolute;top:4px;right:4px">x</span>Присоединяйтесь</div></div>';
  const found = await withPage({ '/': body(`<h1>Статья</h1>${bare}`) }, (p) => probe.overlays(p));
  assert.equal(found.length, 1, 'полноэкранный оверлей без role не найден');
  assert.ok(found[0].buttons.some((b) => b.name === 'Close'));

  const covered = `<div role="dialog" style="position:fixed;top:100px;left:100px;width:400px;height:300px;z-index:10"><button>Под низом</button></div>
    <div style="position:fixed;inset:0;background:#fff;z-index:20"><div role="dialog" style="margin:80px;width:300px;height:200px"><button>Сверху</button></div></div>`;
  const top = await withPage({ '/': body(covered) }, (p) => probe.overlays(p));
  assert.ok(top.every((o) => !o.buttons.some((b) => b.name === 'Под низом')), 'нашёл всплывающее, закрытое другим');

  const inFrame = await withPage({ '/': body('<h1>Статья</h1><iframe src="/ad" width="1000" height="600" style="position:fixed;top:50px;left:50px;z-index:99"></iframe>'),
    '/ad': body('<div role="dialog" style="position:fixed;inset:0"><button>Закрыть</button></div>') }, (p) => probe.overlays(p));
  assert.deepEqual(inFrame, [], 'всплывающее внутри iframe (реклама) не должно быть видно: туда кликать нельзя');
});

test('настоящий браузер: русский баннер без слова cookie («обрабатываем персональные данные») — всё равно баннер согласия', { skip }, async () => {
  const banner = '<div style="position:fixed;left:0;right:0;bottom:0;background:#eee;padding:16px;z-index:50">Мы обрабатываем персональные данные посетителей. <button>Принять</button> <button>Отклонить</button></div>';
  const found = await withPage({ '/': body(`<h1>Статья</h1>${banner}`) }, (p) => probe.overlays(p));
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'consent');
});

test('настоящий браузер: окно входа или регистрации с «персональными данными» и паролем — не баннер cookies, «Понятно» в нём не нажимается', { skip }, async () => {
  const signup = `<div role="dialog" style="position:fixed;top:100px;left:300px;width:500px;height:300px;background:#fff;z-index:100">
    Создайте аккаунт. Нажимая кнопку, вы даёте согласие на обработку персональных данных.
    <input type="password" aria-label="Пароль"> <button>Понятно</button> <button aria-label="Закрыть">×</button></div>`;
  const found = await withPage({ '/': body(`<h1>Статья</h1>${signup}`) }, (p) => probe.overlays(p));
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'dialog', 'форма с паролем принята за баннер cookies');
  assert.equal(chooseCloser(found[0], { consent: 'accept' }).name, 'Закрыть');
});

test('настоящий браузер: ссылка «Закрыть», уводящая со страницы, не предлагается, якорная «Не сейчас» — да', { skip }, async () => {
  const html = '<div role="dialog" style="position:fixed;top:100px;left:300px;width:400px;height:250px;background:#fff;z-index:100"><a href="/other" id="away">Закрыть</a> <a href="#" id="stay">Не сейчас</a></div>';
  const found = await withPage({ '/': body(`<h1>Статья</h1>${html}`) }, (p) => probe.overlays(p));
  assert.deepEqual(names(found[0].buttons), ['Не сейчас']);
});

test('настоящий браузер: настоящим кликом закрывается cookies по политике и модальное окно, подписка не нажата', { skip }, async () => {
  await withPage({ '/': body(`<h1>Статья</h1>${COOKIE}`) }, async (p) => {
    const res = await dismissOverlays(p, realEnv, probe, { consent: 'reject', log: () => {} });
    assert.deepEqual(res, { closed: 1, stuck: false });
    assert.equal(await p.evaluate(() => window.__rejected === 1 || document.getElementById('b') === null), true);
    assert.equal(await p.locator('#b').count(), 0, 'баннер остался');
  });
  await withPage({ '/': body(`<h1>Статья</h1>${MODAL}`) }, async (p) => {
    const res = await dismissOverlays(p, realEnv, probe, { log: () => {} });
    assert.deepEqual(res, { closed: 1, stuck: false });
    assert.equal(await p.locator('#m').count(), 0, 'окно осталось');
    assert.equal(await p.evaluate(() => window.__subscribed || 0), 0, 'нажата подписка');
  });
});

test('настоящий браузер: рекламный оверлей с «Закрыть рекламу» не нажимается, сессия узнаёт, что не закрылось', { skip }, async () => {
  const ad = '<div role="dialog" style="position:fixed;top:100px;left:300px;width:500px;height:300px;background:#fffbe0;z-index:100"><button id="adclose" onclick="window.__adclicked=1">Закрыть рекламу</button></div>';
  await withPage({ '/': body(`<h1>Статья</h1>${ad}`) }, async (p) => {
    const res = await dismissOverlays(p, realEnv, probe, { log: () => {} });
    assert.equal(res.stuck, true);
    assert.equal(await p.evaluate(() => window.__adclicked || 0), 0, 'кликнул по рекламе');
  });
});

test('настоящий браузер: вкладка от window.open закрывается, наша остаётся', { skip }, async () => {
  await withPage({ '/': body('<button id="o" onclick="window.open(\'/ad\')">Открыть</button>'), '/ad': body('<p>реклама</p>') }, async (p) => {
    const events = [];
    watchPage(p, { ...realEnv, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 100))) }, (e) => events.push(e));
    const before = context.pages().length;
    await p.click('#o');
    for (let i = 0; i < 60 && !events.length; i++) await new Promise((r) => setTimeout(r, 100)); // ждём именно закрытие: вкладка появляется не мгновенно
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(context.pages().length, before, 'лишняя вкладка осталась');
    assert.ok(!p.isClosed(), 'закрыта наша вкладка');
    assert.deepEqual(events.map((e) => e.event), ['popup-closed']);
  });
});
