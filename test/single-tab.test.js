/**
 * sites.json: "singleTab": true: задачи идут в уже открытой вкладке площадки, число вкладок
 * не меняется, вкладка не закрывается. Без флага: окно на задачу, как раньше.
 *
 *   node test/single-tab.test.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { connect } = require('../index.js');

const PORT = 9337;
const SINGLE = 'single.test';
const MULTI = 'multi.test';
const CAP = 'cap.test';
const HIDE = 'hide.test';
const FRESH = 'fresh.test';

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meatsuit-single-'));
  const sitesFile = path.join(tmp, 'sites.json');
  fs.writeFileSync(sitesFile, JSON.stringify({ [SINGLE]: { perDay: 100, singleTab: true }, [MULTI]: { perDay: 100 }, [CAP]: { perDay: 100, singleTab: true }, [HIDE]: { perDay: 1, singleTab: true }, [FRESH]: { perDay: 1, singleTab: true } }));

  const ctx = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
    headless: true, args: [`--remote-debugging-port=${PORT}`],
  });
  await ctx.route(/\.test\//, (r) => r.fulfill({ contentType: 'text/html', body: r.request().url().includes('/captcha') ? '<p>Please solve the captcha</p>' : '<button>Like</button>' }));
  const mine = ctx.pages()[0] || (await ctx.newPage());
  await mine.goto(`https://${SINGLE}/app`); // «вкладка человека»

  const ms = await connect({ cdpUrl: `http://127.0.0.1:${PORT}`, dir: path.join(tmp, 'state'), sitesFile });
  const count = () => ctx.pages().length;
  const settle = () => new Promise((r) => setTimeout(r, 300));
  const used = [];
  const run = (site, name) => ms.task(name, async ({ see }) => {
    const s = await see();
    used.push(s.url);
    return s.url;
  }, { site });

  // Две задачи подряд: та же вкладка, число вкладок прежнее, вкладка человека жива.
  const before = count();
  assert.equal(before, 1);
  await run(SINGLE, 's1');
  assert.equal(count(), before, 'singleTab не должен открывать окно');
  await run(SINGLE, 's2');
  await settle();
  assert.equal(count(), before);
  assert.equal(mine.isClosed(), false, 'вкладка человека закрыта');
  assert.deepEqual(used, [`https://${SINGLE}/app`, `https://${SINGLE}/app`]);

  // Слушатель popup не копится на вкладке: после задачи страница открывает окна как обычно.
  assert.equal(ctx.pages().length, 1);
  const popup = ctx.waitForEvent('page');
  await mine.evaluate(() => window.open('about:blank'));
  const p = await popup;
  await settle();
  assert.equal(p.isClosed(), false, 'после задачи бот не должен закрывать popup человека');
  await p.close();

  // Нет вкладки площадки: открывается одна и остаётся; вторая задача её же и берёт.
  await mine.goto('about:blank');
  await ms.task('s3', async ({ act }) => { await act({ cmd: 'goto', url: `https://${SINGLE}/app` }); }, { site: SINGLE });
  await settle();
  assert.equal(count(), 2, 'вкладка, открытая ботом, остаётся');
  await run(SINGLE, 's4');
  await settle();
  assert.equal(count(), 2, 'вторая задача не должна открывать ещё одну');

  // Без флага: окно на задачу, закрывается.
  await ctx.pages().find((q) => q !== mine).close();
  await mine.goto('about:blank');
  await ms.task('m1', async ({ see }) => { await see(); assert.equal(count(), 2); }, { site: MULTI });
  await settle();
  assert.equal(count(), 1, 'без флага окно задачи закрывается');

  // Дыра 1: вкладку с капчей, оставленную человеку, следующая задача не трогает, пока капча не решена.
  const { NeedsHuman } = require('../index.js');
  await mine.goto(`https://${CAP}/captcha`);
  await assert.rejects(ms.task('c1', async ({ see }) => { await see(); }, { site: CAP }), NeedsHuman);
  let ran = false;
  await assert.rejects(ms.task('c2', async ({ act }) => { ran = true; await act({ cmd: 'goto', url: `https://${CAP}/app` }); }, { site: CAP }), NeedsHuman);
  assert.equal(ran, false, 'задача не должна запускаться, пока капча на странице');
  assert.equal(mine.url(), `https://${CAP}/captcha`, 'goto не должен уводить страницу с капчей');
  await mine.goto(`https://${CAP}/app`); // человек решил
  await ms.task('c3', async ({ see }) => { await see(); ran = true; }, { site: CAP });
  assert.equal(ran, true, 'после решения капчи задача идёт');

  // Дыра 2: окно, открытое задачей, закрывается, если она упала до goto; после NeedsHuman остаётся.
  await mine.goto('about:blank');
  await assert.rejects(ms.task('e1', async () => { throw new Error('boom'); }, { site: SINGLE }), /boom/);
  await settle();
  assert.equal(count(), 1, 'пустое окно упавшей задачи не копится');
  await assert.rejects(ms.task('e2', async ({ act }) => { await act({ cmd: 'goto', url: `https://${CAP}/captcha` }); }, { site: CAP }), NeedsHuman);
  await settle();
  assert.equal(count(), 2, 'после NeedsHuman окно остаётся человеку');
  const left = ctx.pages().find((q) => q !== mine);
  ran = false; // задача остановилась на середине: следующая эту вкладку не трогает
  await assert.rejects(ms.task('e3', async () => { ran = true; }, { site: CAP }), NeedsHuman);
  assert.equal(ran, false, 'вкладку, оставленную после NeedsHuman, следующая задача не трогает');
  assert.equal(left.url(), `https://${CAP}/captcha`);
  await left.close();

  // Дыра 3: если Playwright не видит вкладку, слот лимита не тратится (perDay: 1 хватает на повтор).
  await mine.goto(`https://${HIDE}/app`);
  let pb;
  const orig = chromium.connectOverCDP;
  chromium.connectOverCDP = async (u) => { pb = await orig.call(chromium, u); return pb; };
  const ms2 = await connect({ cdpUrl: `http://127.0.0.1:${PORT}`, dir: path.join(tmp, 'state2'), sitesFile });
  chromium.connectOverCDP = orig;
  pb.contexts()[0].pages = () => [];
  await assert.rejects(ms2.task('h1', async () => {}, { site: HIDE }), /не видит/);
  delete pb.contexts()[0].pages;
  await ms2.task('h2', async ({ see }) => { await see(); }, { site: HIDE });
  await ms2.close();

  // Дыра 4: новый процесс (cron) ничего не помнит о прошлом, а вкладка площадки уже на капче.
  // Задача не запускается, страница не тронута, слот не потрачен (perDay: 1), человеку уходит needsHuman.
  await mine.goto(`https://${FRESH}/captcha`);
  const notes = [];
  const ms3 = await connect({ cdpUrl: `http://127.0.0.1:${PORT}`, dir: path.join(tmp, 'state3'), sitesFile,
    notify: async (text, event) => { notes.push({ text, event }); } });
  let ranFresh = false;
  await assert.rejects(ms3.task('f1', async ({ act }) => { ranFresh = true; await act({ cmd: 'goto', url: `https://${FRESH}/app` }); }, { site: FRESH }), NeedsHuman);
  assert.equal(ranFresh, false, 'задача не должна запускаться на вкладке с капчей');
  assert.equal(mine.url(), `https://${FRESH}/captcha`, 'страница с капчей не должна уходить');
  assert.ok(notes.some((n) => n.event === 'needsHuman' && /f1/.test(n.text)), 'человеку должно уйти needsHuman');
  await mine.goto(`https://${FRESH}/app`); // человек решил
  await ms3.task('f2', async ({ see }) => { await see(); ranFresh = true; }, { site: FRESH });
  assert.equal(ranFresh, true, 'после решения капчи задача идёт: слот не был потрачен');
  await ms3.close();

  await ms.close();
  await ctx.close();
  console.log('single-tab.test: ok');
})().catch((e) => { console.error(e); process.exit(1); });
