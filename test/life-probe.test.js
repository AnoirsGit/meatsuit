/**
 * Пробы страницы (life/probe.js) и поиск ссылки по разметке (life/session.js) на настоящем
 * Chromium: размеры, прозрачность, видимость и положение считает только браузер, фальшивая
 * страница тут бесполезна. Без patchright или браузера тесты пропускаются.
 *
 *   NODE_PATH=…/node_modules node --test test/life-probe.test.js
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const chromium = require('../testkit/browser-chromium.js');
const { serve } = require('../testkit/browser-site.js');

const skip = chromium.unavailable();
const probe = skip ? null : require('../life/probe.js');
const { linkLocator } = skip ? {} : require('../life/session.js');
const { pickLink } = require('../life/plan.js');

let browser, cdp, context, site;

// Страницы, на которые ведут iframe: адрес должен содержать то, по чему probe узнаёт фрейм проверки.
const FRAME = '<!doctype html><title>frame</title><p>frame</p>';
const ROUTES = {
  '/recaptcha/api2/bframe': FRAME,
  '/hcaptcha.com/captcha/v1': FRAME,
  '/challenges.cloudflare.com/x': FRAME,
};

before(async () => {
  if (skip) return;
  site = await serve(ROUTES);
  browser = await chromium.launch();
  const c = await chromium.connect(browser.cdpUrl);
  cdp = c.browser;
  context = c.context;
});

after(async () => {
  if (skip) return;
  await cdp.close().catch(() => {});
  await browser.stop();
  await site.close();
});

/** Страница с заданным телом; путь служит только для того, чтобы у страницы был свой адрес. */
async function withPage(body, fn) {
  const page = await context.newPage();
  try {
    const s = await serve({ '/': `<!doctype html><html><head><meta charset="utf-8"><title>Тест</title></head><body style="margin:0">${body.replaceAll('{S}', site.origin)}</body></html>` });
    try {
      await page.goto(s.origin + '/');
      return await fn(page);
    } finally { await s.close(); }
  } finally { await page.close().catch(() => {}); }
}

const frame = (style, src = '/recaptcha/api2/bframe?hl=ru') => `<div style="${style}"><iframe src="{S}${src}" width="400" height="580"></iframe></div>`;

test('скрытый фрейм reCAPTCHA (visibility, opacity, за краем окна) капчей не считается', { skip }, async () => {
  const hidden = {
    'как у настоящей reCAPTCHA: visibility+opacity+top': frame('visibility:hidden;opacity:0;position:absolute;top:-10000px'),
    'только opacity: 0': frame('opacity:0;position:absolute;top:50px;left:50px'),
    'только visibility: hidden': frame('visibility:hidden;position:absolute;top:50px;left:50px'),
    'только за верхним краем': frame('position:absolute;top:-10000px;left:0'),
    'только за левым краем': frame('position:absolute;top:50px;left:-10000px'),
    'далеко внизу страницы, окно не там': frame('position:absolute;top:6000px;left:0'),
    'прозрачный у самого фрейма': `<div style="position:absolute;top:50px;left:50px"><iframe style="opacity:0" src="{S}/recaptcha/api2/bframe" width="400" height="580"></iframe></div>`,
    'display: none': frame('display:none'),
  };
  for (const [name, body] of Object.entries(hidden)) {
    const snap = await withPage(body, (page) => probe.snapshot(page));
    assert.equal(snap.captchaFrame, false, name);
  }
});

test('показанный фрейм проверки (reCAPTCHA, hCaptcha, Cloudflare) по-прежнему капча', { skip }, async () => {
  const shown = {
    'reCAPTCHA в окне': frame('position:absolute;top:40px;left:100px;visibility:visible;opacity:1'),
    'reCAPTCHA, прозрачность почти полная': frame('position:absolute;top:40px;left:100px;opacity:0.9'),
    'hCaptcha': frame('position:absolute;top:40px;left:100px', '/hcaptcha.com/captcha/v1'),
    'Cloudflare': frame('position:absolute;top:40px;left:100px', '/challenges.cloudflare.com/x'),
    'reCAPTCHA, виден только краем': frame('position:absolute;top:-300px;left:-100px'),
    'блок Cloudflare': '<div id="cf-challenge-running" style="width:300px;height:100px">проверка</div>',
  };
  for (const [name, body] of Object.entries(shown)) {
    const snap = await withPage(body, (page) => probe.snapshot(page));
    assert.equal(snap.captchaFrame, true, name);
  }
});

const TRAPS = `
  <p style="margin:20px"><a id="ok" href="/news/1" style="display:inline-block;padding:4px">Обычная ссылка на новость дня</a></p>
  <a href="/trap/left" style="position:absolute;left:-9999px;top:60px">Ловушка за левым краем окна</a>
  <a href="/trap/right" style="position:absolute;left:3000px;top:60px">Ловушка за правым краем окна</a>
  <a href="/trap/partly" style="position:absolute;left:-60px;top:90px;width:200px">Ловушка наполовину за краем</a>
  <a href="/trap/opacity" style="position:absolute;left:20px;top:120px;opacity:0">Ловушка прозрачная целиком</a>
  <a href="/trap/faint" style="position:absolute;left:20px;top:150px;opacity:0.05">Ловушка почти прозрачная</a>
  <a href="/trap/hidden" style="position:absolute;left:20px;top:180px;visibility:hidden">Ловушка со скрытой видимостью</a>
  <div style="opacity:0"><a href="/trap/parent" style="position:absolute;left:20px;top:210px">Ловушка в прозрачном блоке</a></div>
  <div style="position:absolute;left:20px;top:240px;width:300px;height:24px"><a href="/trap/covered" style="display:block">Ловушка под накладкой</a><div style="position:absolute;inset:0;background:#fff"></div></div>
  <a href="/trap/tiny" style="position:absolute;left:20px;top:280px;width:1px;height:1px;overflow:hidden;display:block">Ловушка размером в точку</a>
  <p style="margin:300px 20px 20px"><a href="/news/2" style="display:inline-block;padding:4px">Вторая обычная ссылка на новость</a></p>`;

test('ссылки-ловушки (за краем окна, прозрачные, скрытые, под накладкой, в точку) не отдаются, обычные отдаются', { skip }, async () => {
  const found = await withPage(TRAPS, (page) => probe.links(page));
  assert.deepEqual(found.map((l) => new URL(l.href).pathname).sort(), ['/news/1', '/news/2']);
  assert.ok(found.every((l) => l.x >= 0 && l.x + l.w <= 1280 + 1), 'ссылка не целиком в окне');
});

test('поиск ссылки по ловушкам: ни одна не выбирается, сколько бы раз ни выбирали', { skip }, async () => {
  const found = await withPage(TRAPS, (page) => probe.links(page));
  const picked = new Set();
  for (let i = 0; i < 200; i++) picked.add(new URL(pickLink(found, 'http://127.0.0.1/start', Math.random).href).pathname); // тот же хост, что у страницы
  assert.deepEqual([...picked].sort(), ['/news/1', '/news/2']);
});

test('ссылка с переводом строки, табуляцией и управляющим символом в href находится по разметке и кликается', { skip }, async () => {
  const raws = ['\n  /go/1\n', '\t/go/2', '/go/3\u0001x', '/go/4?q="b"&c=\\d', '  /go/5  ', '/go/6\f', '/\r\n7', '/go/8\u007f', '/go/ё9', "/go/10'x", '/go/11\\'];
  const page = await context.newPage();
  const s = await serve(Object.fromEntries([['/', '<!doctype html><meta charset=utf-8><body style="margin:20px"></body>'], ['/go/hit', '<p>hit</p>']]));
  try {
    await page.goto(`${s.origin}/`);
    await page.evaluate((list) => {
      list.forEach((raw, i) => {
        const a = document.createElement('a');
        a.setAttribute('href', raw);
        a.textContent = `Ссылка номер ${i + 1} с трудным адресом`;
        a.style.display = 'block';
        document.body.append(a);
      });
    }, raws);
    const found = await probe.links(page);
    assert.equal(found.length, raws.length, 'не все ссылки видны пробе');
    for (const link of found) {
      assert.ok(raws.includes(link.raw), `raw ${JSON.stringify(link.raw)} изменился по дороге`);
      assert.equal(await linkLocator(page, link).count(), 1, `ссылка с href ${JSON.stringify(link.raw)} не найдена по селектору`);
    }
  } finally { await page.close().catch(() => {}); await s.close(); }
});

test('зона ссылки: меню и шапка — nav, подвал — footer, остальное — content', { skip }, async () => {
  const body = `<header style="height:40px"><a href="/h1">Ссылка в шапке сайта</a></header>
    <nav style="height:40px"><a href="/n1">Раздел в меню навигации</a></nav>
    <div role="navigation" style="height:40px"><a href="/n2">Пункт с ролью навигации</a></div>
    <main style="height:80px"><a href="/c1">Статья в основном содержимом</a></main>
    <footer style="height:40px"><a href="/f1">Политика конфиденциальности сайта</a></footer>`;
  const zones = await withPage(body, async (page) => Object.fromEntries((await probe.links(page)).map((l) => [l.raw, l.zone])));
  assert.deepEqual(zones, { '/h1': 'nav', '/n1': 'nav', '/n2': 'nav', '/c1': 'content', '/f1': 'footer' });
});

test('поле поиска: видимое находится, скрытое, за краем, под накладкой, во фрейме и выключенное — нет', { skip }, async () => {
  const input = (style = '', attrs = '') => `<input type="search" name="q" style="width:300px;height:30px;${style}" ${attrs}>`;
  const found = await withPage(input(), (p) => probe.searchBox(p));
  assert.ok(found && found.w >= 300, 'видимое поле не найдено');
  assert.equal((await withPage(`<input name="q" placeholder="Поиск по сайту" style="width:300px;height:30px">`, (p) => probe.searchBox(p))).name, 'Поиск по сайту');

  const none = {
    'display:none': input('display:none'),
    'visibility:hidden': input('visibility:hidden'),
    'opacity:0': input('opacity:0'),
    'за краем окна': input('position:absolute;left:-9999px'),
    'выключено': input('', 'disabled'),
    'только для чтения': input('', 'readonly'),
    'под накладкой': `${input('position:absolute;top:50px;left:50px')}<div style="position:absolute;top:0;left:0;width:100%;height:300px;background:#fff"></div>`,
    'во фрейме': '<iframe src="{S}/recaptcha/api2/bframe" width="400" height="300"></iframe>',
    'скрытый type=hidden': '<input type="hidden" name="q" value="x">',
    'крошечное': input('width:10px;height:6px'),
  };
  for (const [name, body] of Object.entries(none)) assert.equal(await withPage(body, (p) => probe.searchBox(p)), null, name);
});

test('поиск целиком на настоящем браузере: русский запрос уходит клавишами и Enter, результаты читаются', { skip }, async () => {
  const { seeded } = require('../human/random.js');
  const { runSession } = require('../life/session.js');
  const wrap = (b) => `<!doctype html><html><head><meta charset="utf-8"><title>Вики</title></head><body style="margin:20px;font:16px sans-serif">${b}</body></html>`;
  const results = Array.from({ length: 12 }, (_, i) => `<p>Результат ${i + 1}. ${'Подробное описание найденной статьи. '.repeat(8)}</p>`).join('');
  const s = await serve({
    '/': wrap('<h1>Википедия</h1><form action="/w" method="get"><input type="search" name="search" id="searchInput" style="width:320px;height:32px"></form><p>Главная страница энциклопедии.</p>'),
    '/w': wrap(`<h1>Результаты поиска</h1>${results}`),
  });
  const page = await context.newPage();
  const journal = [];
  try {
    await page.setViewportSize({ width: 1100, height: 700 });
    const env = { sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 120))), now: Date.now, rnd: seeded(9) };
    await runSession(page, [{ url: `${s.origin}/`, kind: 'search', query: 'Алматы', follow: 0, budgetMs: 20000 }], { env, probe, log: (e) => journal.push(e), wander: 0 });
    const hit = s.hits.find((h) => h.startsWith('/w?'));
    assert.ok(hit, `форма не отправлена: ${s.hits}`);
    assert.equal(new URL(s.origin + hit).searchParams.get('search'), 'Алматы', 'в поле ушло не то');
    assert.deepEqual(journal.filter((e) => e.event === 'step').map((e) => [e.kind, e.result]), [['search', 'ok']]);
  } finally { await page.close().catch(() => {}); await s.close(); }
});
