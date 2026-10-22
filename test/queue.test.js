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

const PORT = 9341;
const SITE = 'example.test';

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
  const ctx = await chromium.launchPersistentContext(path.join(tmp, 'profile'), { headless: true, args: [`--remote-debugging-port=${PORT}`] });
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
    await ms.close();
  } finally { await ctx.close(); }

  console.log('queue.test: ok');
})().catch((e) => { console.error(e); process.exit(1); });
