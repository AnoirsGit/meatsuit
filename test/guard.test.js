/**
 * guard и лимиты: чистые проверки + очередь.
 *
 *   node test/guard.test.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { check, telegramNotifier } = require('../guard.js');
const limits = require('../limits.js');

const snap = (o) => ({ url: 'https://tinder.com/app/recs', title: 'Tinder', text: '', elements: [], dialogs: [], ...o });

// guard
assert.equal(check(snap({ text: 'Аня, 24. Люблю рок и горы' })), null);
assert.equal(check(snap({ title: 'Just a moment... captcha' })), 'капча');
assert.equal(check(snap({ text: 'Verify you are human' })), 'капча');
assert.equal(check(snap({ dialogs: [{ name: 'Check', text: 'Подтвердите, что вы не робот', elements: [] }] })), 'капча');
assert.match(check(snap({ text: 'Unusual activity detected' })), /подозрительная/);
assert.match(check(snap({ text: 'Ваш аккаунт заблокирован' })), /подозрительная/);
assert.equal(check(snap({ url: 'https://hh.kz/account/login' })), 'страница входа');
assert.equal(check(snap({ elements: [{ id: 1, role: 'textbox', name: 'Пароль' }] })), 'страница входа');
// Слово в длинном био — не повод для остановки.
assert.equal(check(snap({ text: 'captcha '.repeat(200) })), null);
// Порог короткой страницы — к каждому куску text отдельно (textParts: длины light DOM и shadow-корней).
const block = 'Too many requests. Try again later.';
const banner = 'We use cookies to improve your experience. '.repeat(20).trim();
assert.match(check(snap({ text: `${block} ${banner}`, textParts: [block.length, banner.length] })), /подозрительная/, 'длинный кусок спрятал короткую заглушку');
const bio = 'captcha '.repeat(200).trim();
assert.equal(check(snap({ text: `${bio} Привет`, textParts: [bio.length, 'Привет'.length] })), null, 'длинный кусок проверен рядом с коротким');

(async () => {
  // Простая проверка совместимости импорта; подробно адаптер проверяет test/telegram.test.js.
  const sent = [];
  const okFetch = async (u, o) => { sent.push([u, JSON.parse(o.body)]); return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) }; };
  await telegramNotifier({ token: '123:ABC', chatId: -100, fetchImpl: okFetch })('привет');
  assert.equal(sent[0][0], 'https://api.telegram.org/bot123:ABC/sendMessage');
  assert.equal(sent[0][1].chat_id, -100);
  assert.equal(sent[0][1].text, 'привет');

  // лимиты (локальное время: now задаём через конструктор от компонентов)
  const at = (h) => new Date(2026, 9, 6, h, 0, 0);
  const rule = { perDay: 3, perHour: 2, hours: '10-21' };
  const stamp = (h, m = 0) => +new Date(2026, 9, 6, h, m);
  assert.equal(check(snap({ url: 'не адрес' })), null, 'битый url не должен ронять guard');
  limits.check('s', rule, [], at(12));
  assert.throws(() => limits.check('s', rule, [], at(9)), /вне часов/);
  assert.throws(() => limits.check('s', rule, [], at(21)), /вне часов/);
  assert.throws(() => limits.check('s', null, [], at(12)), /не описана/);
  assert.throws(() => limits.check('s', { perDay: 0 }, [], at(12)), /perDay 0/);
  assert.throws(() => limits.check('s', rule, [stamp(11, 10), stamp(11, 40)], at(12)), /на час/);
  limits.check('s', rule, [stamp(10, 10), stamp(10, 40)], at(12)); // час прошёл
  assert.throws(() => limits.check('s', rule, [stamp(10), stamp(11), stamp(11, 30)], at(13)), /на сегодня/);
  limits.check('s', rule, [+new Date(2026, 9, 5, 15)], at(12)); // вчерашнее не считается
  limits.check('s', { perDay: 1, hours: '22-6' }, [], at(23)); // окно через полночь
  limits.check('s', { perDay: 1, hours: '22-6' }, [], at(3));
  assert.throws(() => limits.check('s', { hours: '22-6' }, [], at(12)), /вне часов/);
  assert.throws(() => limits.check('s', { hours: 'ночью' }, [], at(12)), /hours/);

  // reserve пишет и не обходит лимит
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meatsuit-lim-'));
  const f = path.join(dir, 'limits.json');
  const now = at(12);
  limits.reserve('s', { perDay: 2 }, f, now);
  limits.reserve('s', { perDay: 2 }, f, now);
  assert.throws(() => limits.reserve('s', { perDay: 2 }, f, now), /на сегодня/);
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).s.length, 2, 'отказ не должен писаться');

  // readOnly: тратит perHour, а не perDay; charge делает слот полным
  const fr = path.join(dir, 'ro.json');
  const ro = { perDay: 1, perHour: 3 };
  limits.reserve('r', ro, fr, now, { readOnly: true });
  limits.reserve('r', ro, fr, now, { readOnly: true }); // perDay: 1, а чтений уже два
  limits.reserve('r', ro, fr, now); // полный слот дня всё ещё свободен... но час уже занят чтениями
  assert.throws(() => limits.reserve('r', ro, fr, now, { readOnly: true }), /на час/);
  assert.throws(() => limits.check('r', { perDay: 0 }, [], now, { readOnly: true }), /perDay 0/);
  assert.throws(() => limits.check('r', rule, [], at(9), { readOnly: true }), /вне часов/);
  const slot = at(12);
  const fc = path.join(dir, 'ch.json');
  limits.reserve('c', { perDay: 1 }, fc, slot, { readOnly: true });
  limits.reserve('c', { perDay: 1 }, fc, slot, { readOnly: true }); // дневной остаток цел
  limits.charge('c', { perDay: 1 }, fc, slot);
  assert.throws(() => limits.reserve('c', { perDay: 1 }, fc, slot), /на сегодня/);
  assert.throws(() => limits.charge('c', { perDay: 1 }, fc, slot), /на сегодня/); // день исчерпан: запись read-only задаче не проходит
  limits.reserve('c', { perDay: 1 }, fc, slot, { readOnly: true }); // читать после записи можно
  assert.equal(JSON.parse(fs.readFileSync(fc, 'utf8')).c.length, 1);

  // supervise: запись — fill, type, Enter, клик не по вкладке; вкладка и чтение — нет
  const { supervise } = require('../supervise.js');
  const els = { gen: 1, url: 'about:blank', title: '', text: '', elements: [{ id: 1, role: 'tab', name: 'a' }, { id: 2, role: 'button', name: 'b' }] };
  const fake = { see: async () => els, act: async () => ({ ...els, dryRun: false }) };
  const writes = async (cmds) => {
    let n = 0;
    const { api } = supervise(fake, { name: 't', site: 's', notify() {}, maxCommands: 99, maxMinutes: 1, onWrite: () => n++ });
    await api.see();
    for (const c of cmds) await api.act(c);
    return n;
  };
  assert.equal(await writes([{ cmd: 'click', id: 1, gen: 1 }, { cmd: 'press', key: 'Escape' }, { cmd: 'scroll' }, { cmd: 'goto', url: 'https://s/' }]), 0);
  assert.equal(await writes([{ cmd: 'click', id: 2, gen: 1 }, { cmd: 'fill', id: 2, gen: 1, text: 'x' }]), 1, 'слот засчитывается один раз');
  assert.equal(await writes([{ cmd: 'press', key: 'Enter' }]), 1);
  assert.equal(await writes([{ cmd: 'type', text: 'x' }]), 1);
  { // onWrite бросил LimitReached (день исчерпан) — команда до рук не доходит
    let acted = 0;
    const h = { see: async () => els, act: async () => { acted++; return { ...els, dryRun: false }; } };
    const { api } = supervise(h, { name: 't', site: 's', notify() {}, maxCommands: 99, maxMinutes: 1, onWrite: () => { throw new limits.LimitReached('день'); } });
    await api.see();
    await assert.rejects(() => api.act({ cmd: 'click', id: 2, gen: 1 }), /день/);
    assert.equal(acted, 0, 'запись не должна выполняться');
  }

  // очередь: второй ждёт первого; замок мёртвого процесса забирается
  const lf = path.join(dir, 'q.lock');
  const order = [];
  const r1 = await limits.lock(lf, { pollMs: 20 });
  const second = limits.lock(lf, { pollMs: 20 }).then((rel) => { order.push('second'); rel(); });
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(order, [], 'второй не должен проскочить');
  order.push('first'); r1();
  await second;
  assert.deepEqual(order, ['first', 'second']);
  fs.writeFileSync(lf, String(process.pid)); // свой же PID, но замок давно не обновляли
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lf, old, old);
  (await limits.lock(lf, { pollMs: 20, timeoutMs: 1000, staleMs: 30000 }))();
  await assert.rejects(async () => { await limits.lock(lf, { pollMs: 20 }); await limits.lock(lf, { pollMs: 20, timeoutMs: 100 }); }, /очереди/);

  // shadow DOM: признаки капчи и входа внутри open-корня доходят до guard через снимок eyes
  const { chromium } = require('playwright-core');
  const { see } = require('../eyes.js');
  const browser = await chromium.launch();
  try {
    const shadowCase = async (inner, light = '') => {
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
      await page.setContent(`<body>${light}<div id="h"></div></body>`);
      await page.evaluate((html) => { document.getElementById('h').attachShadow({ mode: 'open' }).innerHTML = html; }, inner);
      const r = check(await see(page));
      await page.close();
      return r;
    };
    assert.equal(await shadowCase('<p>Подтвердите, что вы не робот</p>'), 'капча');
    assert.equal(await shadowCase('<button aria-label="I\'m not a robot">Go</button>'), 'капча');
    assert.equal(await shadowCase('<input type="password" aria-label="x">'), 'страница входа');
    assert.equal(await shadowCase('<p>Привет, Аня</p>'), null);
    // в text корней — только отрисованное: CSS не раздувает заглушку сверх лимита, скрытый шаблон не даёт ложный стоп
    const css = '<style>' + '.bar{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;}'.repeat(10) + '</style><div>We use cookies</div>';
    assert.match(await shadowCase(css, '<p>Too many requests. Try again later.</p>'), /подозрительная/);
    assert.equal(await shadowCase('<div style="display:none">Verify you are human (captcha)</div><p>Привет, Аня</p>'), null);
    assert.equal(await shadowCase('<slot>Подтвердите, что вы не робот</slot>'), 'капча', 'отрисованный display:contents (<slot>) не теряется');
    // баннер cookie в shadow длиннее порога не прячет заглушку из light DOM: порог к каждому корню отдельно
    assert.match(await shadowCase(`<div>${banner}</div>`, `<p>${block}</p>`), /подозрительная/, 'баннер в shadow спрятал заглушку');
    assert.equal(await shadowCase(`<div>${banner}</div>`, '<p>Привет, Аня</p>'), null);
    // текст прямо в корне, без элемента-обёртки (так рендерит Lit); у скрытого хоста он не отрисован
    assert.equal(await shadowCase('Please verify you are human'), 'капча', 'текстовый узел верхнего уровня в корне потерян');
    assert.equal(await shadowCase('<style>:host{display:none}</style>Please verify you are human'), null, 'текст скрытого хоста');
    { // кнопка со слотом: скрытый текст из light DOM не попадает в имя и не даёт ложный стоп
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
      await page.setContent('<body><p>Привет, Аня</p><my-btn id="b"><span style="display:none">Подтвердите, что вы не робот</span>Отправить</my-btn></body>');
      await page.evaluate(() => { document.getElementById('b').attachShadow({ mode: 'open' }).innerHTML = '<button><slot></slot></button>'; });
      assert.equal(check(await see(page)), null, 'скрытый текст в имени кнопки со слотом');
      await page.close();
    }
  } finally { await browser.close(); }

  // гонка ждущих за брошенный замок: медленный процесс проверил возраст, быстрый забрал и взял замок,
  // медленный не должен унести свежий замок и войти вместе с ним
  {
    const { spawn } = require('node:child_process');
    const rf = path.join(dir, 'race.lock');
    fs.writeFileSync(rf, '1');
    fs.utimesSync(rf, old, old);
    const child = `
      const fs = require('fs'); const [role, f, lim] = process.argv.slice(1);
      if (role === 'slow') { const o = fs.statSync; fs.statSync = function (p, ...a) { const r = o.call(this, p, ...a); if (String(p) === f) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400); return r; }; }
      require(lim).lock(f, { pollMs: 20 }).then(async (rel) => {
        try { fs.writeFileSync(f + '.in', 'x', { flag: 'wx' }); } catch { process.exit(3); }
        await new Promise((r) => setTimeout(r, 800)); fs.unlinkSync(f + '.in'); rel();
      });`;
    const run = (role) => new Promise((res) => spawn(process.execPath, ['-e', child, role, rf, path.resolve(__dirname, '../limits.js')]).on('exit', res));
    const slow = run('slow');
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(await Promise.all([slow, run('fast')]), [0, 0], 'двое держали замок одновременно');
  }

  console.log('guard.test: ok');
})().catch((e) => { console.error(e); process.exit(1); });
