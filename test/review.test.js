/**
 * Регрессии по ревью: gen после загрузки страницы, клик с переходом, очередь команд,
 * пароль, iframe-капча, стоп guard, уход с площадки, диалоги в моих вкладках.
 *
 *   node test/review.test.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { hands, BadCommand, StaleElement, connect, NeedsHuman } = require('../index.js');
const { validate } = require('../hands.js');
const { check } = require('../guard.js');

const PORT = 9334;
const PAGES = {
  'https://example.test/a': '<a href="https://example.test/b">Next page</a><button>Apply 1</button>',
  'https://example.test/b': '<button>Delete account</button><button>Two</button>',
  'https://example.test/out': '<a href="https://other.test/x?token=SECRET-OTP#frag">Away</a>',
  'https://other.test/x': '<p>other</p>',
  'https://example.test/two': '<button onclick="window.n=(window.n||[]);n.push(\'One\')">One</button><button onclick="window.n=(window.n||[]);n.push(\'Two\')">Two</button>',
  'https://example.test/pw': '<input type="password" placeholder="••••" value="s3cret">',
};

(async () => {
  // Чистые проверки.
  assert.throws(() => validate({ cmd: 'fill', id: 1, gen: 1, text: 'hi\nthere' }), BadCommand);
  assert.throws(() => validate({ cmd: 'type', text: 'a\rb' }), BadCommand);
  assert.throws(() => validate({ cmd: 'scroll', px: -300 }), BadCommand);
  const snap = (o) => ({ url: 'https://tinder.com/app/recs', title: '', text: '', elements: [], dialogs: [], frames: [], ...o });
  assert.equal(check(snap({ frames: ['https://www.google.com/recaptcha/api2/anchor'] })), 'капча');
  assert.equal(check(snap({ frames: ['https://client-api.arkoselabs.com/fc/gc/'] })), 'капча');
  assert.equal(check(snap({ elements: [{ id: 1, role: 'textbox', name: '', inputType: 'password' }] })), 'страница входа');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meatsuit-rev-'));
  const sitesFile = path.join(tmp, 'sites.json');
  fs.writeFileSync(sitesFile, JSON.stringify({ 'example.test': { perDay: 100 } }));
  const ctx = await chromium.launchPersistentContext(path.join(tmp, 'profile'), { headless: true, args: [`--remote-debugging-port=${PORT}`] });
  await ctx.route('**/*', (r) => {
    const body = PAGES[r.request().url().replace(/\?.*$/, '')];
    return body ? r.fulfill({ contentType: 'text/html', body }) : r.fulfill({ status: 404, body: 'no' });
  });
  let myDialog = null;
  ctx.on('dialog', (d) => { myDialog = d; }); // свой слушатель: наш Playwright сам диалоги не закроет, проверяем meatsuit
  const mine = ctx.pages()[0] || (await ctx.newPage());
  await mine.goto('https://example.test/a');

  // Голые hands на своей странице.
  const page = await ctx.newPage();
  await page.goto('https://example.test/a');
  const h = hands(page, {});
  const a = await h.see();
  const next = a.elements.find((e) => e.name === 'Next page');
  const apply = a.elements.find((e) => e.name === 'Apply 1');

  // Клик с переходом не падает и возвращает снимок новой страницы.
  const b = await h.act({ cmd: 'click', id: next.id, gen: a.gen });
  assert.equal(b.urlChanged, true);
  assert.ok(b.elements.some((e) => e.name === 'Delete account'));
  assert.ok(b.gen > a.gen, 'gen должен расти и через загрузку нового документа');

  // Старый id со старым gen больше не годится: на новой странице тот же номер = «Delete account».
  await assert.rejects(h.act({ cmd: 'click', id: apply.id, gen: a.gen }), StaleElement);
  assert.equal(await page.evaluate(() => document.title), '');

  // Команды идут по очереди: оба клика проходят, и каждый в свой элемент.
  await page.goto('https://example.test/two');
  const t = await h.see();
  const one = t.elements.find((e) => e.name === 'One');
  const two = t.elements.find((e) => e.name === 'Two');
  const results = await Promise.allSettled([
    h.act({ cmd: 'click', id: one.id, gen: t.gen }),
    h.act({ cmd: 'click', id: two.id, gen: t.gen }),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected', 'второй клик по старому gen отклоняется, а не повторяет первый');
  assert.deepEqual(await page.evaluate(() => window.n), ['One']);

  // Пароль: тип виден, значение не отдаётся.
  await page.goto('https://example.test/pw');
  const pw = await h.see();
  assert.equal(pw.elements[0].inputType, 'password');
  assert.ok(!('value' in pw.elements[0]), 'значение пароля не должно попасть в снимок');
  assert.equal(check(pw), 'страница входа');
  await page.close();

  // task(): стоп не снимается; уход с площадки; диалог в моей вкладке.
  const notes = [];
  const ms = await connect({ cdpUrl: `http://127.0.0.1:${PORT}`, dir: path.join(tmp, 'state'), sitesFile, notify: async (x, event) => { if (event === 'needsHuman') notes.push(x); } });
  const count = () => ctx.pages().length;

  // Мой диалог не закрывается сам, пока meatsuit подключён: закрыть его удаётся только нам.
  await mine.evaluate(() => { setTimeout(() => { window.answer = String(confirm('Leave?')); }, 0); });
  await new Promise((r) => setTimeout(r, 1000));
  assert.ok(myDialog, 'диалог не появился');
  await myDialog.dismiss(); // бросит, если meatsuit уже закрыл его за нас
  assert.equal(await mine.evaluate(() => window.answer), 'false');

  // Ушли на чужой хост кликом: стоп, окно остаётся.
  await assert.rejects(ms.task('away', async ({ see, act }) => {
    await act({ cmd: 'goto', url: 'https://example.test/out' });
    const s = await see();
    await act({ cmd: 'click', id: s.elements[0].id, gen: s.gen });
  }, { site: 'example.test' }), (e) => e instanceof NeedsHuman && /вне площадки/.test(e.reason));
  assert.equal(notes.length, 1);
  assert.ok(!/SECRET|token=|frag/.test(notes[0]), 'в уведомление не должны попадать query и hash: ' + notes[0]);
  assert.match(notes[0], /https:\/\/other\.test\/x/);
  const left = count();
  assert.ok(left >= 2, 'окно после стопа остаётся человеку');
  await ctx.pages().find((p) => p.url().includes('other.test'))?.close();

  // Проект проглотил NeedsHuman и пошёл дальше: страницы больше не касаемся, окно не закрываем.
  const before = count();
  await assert.rejects(ms.task('swallow', async ({ see, act }) => {
    await act({ cmd: 'goto', url: 'https://example.test/pw' }).catch(() => {});
    await see().catch(() => {}); // guard: страница входа
    await act({ cmd: 'press', key: 'Enter' }).catch((e) => assert.ok(e instanceof NeedsHuman, 'повтор должен быть тем же NeedsHuman'));
    return 'как ни в чём не бывало';
  }, { site: 'example.test' }), NeedsHuman);
  assert.equal(count(), before + 1, 'окно остаётся');
  assert.equal(notes.length, 2, 'уведомление отправлено один раз');

  await ms.close();
  await ctx.close();
  console.log('review.test: ok');
})().catch((e) => { console.error(e); process.exit(1); });
