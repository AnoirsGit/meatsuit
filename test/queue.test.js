/**
 * Очередь «один бот за раз» между вызывающими (tinder-matcher и cvs в одном браузере): браузер занят дольше
 * срока ожидания — LimitReached с задачей и площадкой того, кто держит, уведомление 'limit', браузер и слот
 * лимита не тронуты. Замок снимает только тот, кто его держит.
 *
 *   node test/queue.test.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const limits = require('../limits.js');

// Ждать очередь 30 минут тест не может: срок короче, и подставить его надо до того, как index.js возьмёт lock.
const realLock = limits.lock;
limits.lock = (file, o = {}) => realLock(file, { ...o, timeoutMs: 300, pollMs: 20 });
const { connect, LimitReached } = require('../index.js');
const { chromium } = require('playwright-core');
const { cdpPort } = require('./cdp-port.js');

const SITE = 'example.test';
const settle = () => new Promise((r) => setTimeout(r, 300));

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meatsuit-queue-'));

  // lock: не дождались — LimitReached, в тексте задача и площадка держателя.
  const lf = path.join(tmp, 'q.lock');
  const held = await realLock(lf, { pollMs: 20, holder: { name: 'tinder-matcher:chat', site: 'tinder.com' } });
  await assert.rejects(realLock(lf, { pollMs: 20, timeoutMs: 100 }),
    (e) => e instanceof LimitReached && /очеред/.test(e.message) && /tinder-matcher:chat/.test(e.message) && /tinder\.com/.test(e.message));
  held();
  assert.ok(!fs.existsSync(lf), 'свой замок снимается');

  // Замок старой версии библиотеки (в файле только PID): держатель неизвестен, отказ тот же.
  fs.writeFileSync(lf, '12345');
  await assert.rejects(realLock(lf, { pollMs: 20, timeoutMs: 100 }), (e) => e instanceof LimitReached && /очеред/.test(e.message));
  fs.unlinkSync(lf);

  // release снимает только свой замок: A завис дольше staleMs, его замок признали брошенным и забрал B;
  // проснувшийся A не должен унести замок B (иначе следующий вошёл бы вместе с B).
  const a = await realLock(lf, { pollMs: 20 });
  fs.unlinkSync(lf);
  const b = await realLock(lf, { pollMs: 20, holder: { name: 'cvs-apply', site: 'jobs.lever.co' } });
  a();
  assert.ok(fs.existsSync(lf), 'A снял чужой замок');
  b();
  assert.ok(!fs.existsSync(lf), 'B не снял свой замок');

  // task(): браузер занят другим вызывающим — LimitReached до окна и до слота, notify('limit'); освободился — идёт.
  const sitesFile = path.join(tmp, 'sites.json');
  fs.writeFileSync(sitesFile, JSON.stringify({ [SITE]: { perDay: 5 } }));
  const ctx = await chromium.launchPersistentContext(path.join(tmp, 'profile'), { headless: true, args: ['--remote-debugging-port=0'] });
  const PORT = await cdpPort(path.join(tmp, 'profile'));
  try {
    const state = path.join(tmp, 'state');
    const notes = [];
    const ms = await connect({ cdpUrl: `http://127.0.0.1:${PORT}`, dir: state, sitesFile, notify: async (text, event) => { notes.push({ text, event }); } });
    const hold = await realLock(path.join(state, 'queue.lock'), { pollMs: 20, holder: { name: 'cvs-apply', site: 'jobs.lever.co' } });
    const pages = ctx.pages().length;
    let ran = false;
    await assert.rejects(ms.task('t1', async () => { ran = true; }, { site: SITE }),
      (e) => e instanceof LimitReached && /cvs-apply/.test(e.message) && /jobs\.lever\.co/.test(e.message));
    assert.equal(ran, false, 'задача не должна запускаться');
    assert.equal(ctx.pages().length, pages, 'окно не открывается');
    assert.ok(!fs.existsSync(path.join(state, 'limits.json')), 'слот лимита не потрачен');
    assert.ok(notes.some((n) => n.event === 'limit' && /t1/.test(n.text) && /не запущена/.test(n.text) && /cvs-apply/.test(n.text)), JSON.stringify(notes));
    assert.ok(!notes.some((n) => n.event === 'error'), 'занятый браузер — не ошибка');
    hold();
    assert.equal(await ms.task('t2', async () => 'ok', { site: SITE }), 'ok');

    // Зависшая задача не держит очередь вечно. maxMinutes проверяется перед командой, а see() на странице
    // с зависшим главным потоком (бесконечный цикл в её скрипте) не возвращается никогда, и замок очереди всё это
    // время обновляется. Сторож: через maxMinutes + запас задача кончается BudgetExceeded, окно закрывается
    // (зависший вызов обрывается), очередь свободна для другого вызывающего; notify('error') один раз.
    const { HANG, BudgetExceeded } = require('../supervise.js');
    HANG.graceMs = 300;
    await ctx.route('https://hang.test/**', (r) => r.fulfill({ contentType: 'text/html',
      body: '<button>Like</button><script>setTimeout(() => { for (;;) {} }, 300)</script>' }));
    fs.writeFileSync(sitesFile, JSON.stringify({ [SITE]: { perDay: 5 }, 'hang.test': { perDay: 5 } }));
    notes.length = 0;
    const base = ctx.pages().length;
    const hung = ms.task('hung', async ({ see, act }) => {
      await act({ cmd: 'goto', url: 'https://hang.test/' });
      await new Promise((r) => setTimeout(r, 700)); // скрипт страницы уже крутит цикл
      await see();
    }, { site: 'hang.test', maxMinutes: 0.05 });
    hung.catch(() => {});
    const t0 = Date.now();
    const other = await realLock(path.join(state, 'queue.lock'), { pollMs: 20, timeoutMs: 20000 }); // другой вызывающий
    other();
    assert.ok(Date.now() - t0 < 15000, 'очередь освободилась только по сроку ожидания');
    await assert.rejects(hung, (e) => e instanceof BudgetExceeded && /не закончилась/.test(e.message), 'зависшая задача кончается BudgetExceeded');
    await settle();
    assert.equal(ctx.pages().length, base, 'окно зависшей задачи закрыто');
    assert.equal(notes.filter((n) => n.event === 'error').length, 1, JSON.stringify(notes));
    assert.match(notes.find((n) => n.event === 'error').text, /hung.*не закончилась/);
    HANG.graceMs = 15 * 60e3;
    assert.equal(await ms.task('t3', async () => 'ok', { site: SITE }), 'ok', 'после зависшей задачи браузер работает');
    await ms.close();
  } finally { await ctx.close(); }

  console.log('queue.test: ok');
})().catch((e) => { console.error(e); process.exit(1); });
