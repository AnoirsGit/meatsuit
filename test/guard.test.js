/**
 * guard и лимиты: чистые проверки + очередь.
 *
 *   node test/guard.test.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { check } = require('../guard.js');
const { telegramNotifier } = require('../index.js'); // экспорт для вызывающих сохранён (решение 3)
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

  // правило по умолчанию "*": неописанный хост берёт его, явная запись заменяет целиком, без "*" как раньше
  const sites = { '*': rule, 'closed.example.test': { perDay: 0 }, 'own.example.test': { perDay: 1 } };
  assert.equal(limits.ruleFor(sites, 'new.example.test'), rule);
  limits.check('new.example.test', limits.ruleFor(sites, 'new.example.test'), [], at(12));
  assert.throws(() => limits.check('closed.example.test', limits.ruleFor(sites, 'closed.example.test'), [], at(12)), /perDay 0/);
  limits.check('own.example.test', limits.ruleFor(sites, 'own.example.test'), [], at(9)); // hours из "*" не подмешиваются
  // поддомен описанной площадки под "*" не попадает: закрытую площадку не обойти сменой site
  assert.equal(limits.ruleFor(sites, 'www.closed.example.test'), undefined);
  assert.throws(() => limits.check('www.closed.example.test', limits.ruleFor(sites, 'www.closed.example.test'), [], at(12)), /не описана/);
  assert.equal(limits.ruleFor(sites, 'a.b.own.example.test'), undefined);
  assert.equal(limits.ruleFor(sites, 'xclosed.example.test'), rule, 'совпадение без точки — не поддомен');
  assert.equal(limits.ruleFor({ 'a.example.test': rule }, 'b.example.test'), undefined);
  assert.throws(() => limits.check('b.example.test', limits.ruleFor({ 'a.example.test': rule }, 'b.example.test'), [], at(12)), /не описана/);
  assert.throws(() => limits.ruleFor(sites, '*'), (e) => !(e instanceof limits.LimitReached) && /не хост/.test(e.message), '"*" — ключ правила, а не хост');
  const fstar = path.join(dir, 'star.json'); // счётчики у каждого "*"-хоста свои
  const star = limits.ruleFor({ '*': { perDay: 1 } }, 'one.example.test');
  limits.reserve('one.example.test', star, fstar, now);
  assert.throws(() => limits.reserve('one.example.test', star, fstar, now), /на сегодня/);
  limits.reserve('two.example.test', star, fstar, now);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(fstar, 'utf8'))).sort(), ['one.example.test', 'two.example.test']);

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

  // reCAPTCHA в iframe: невидимый якорь (size=invisible) и скрытый bframe — не капча; галочка,
  // показанный bframe, hCaptcha и Turnstile — капча. Адрес разбирается через URL, а не подстрокой.
  {
    const anchor = (path, q) => `https://www.google.com/recaptcha/${path}/anchor?ar=1&k=KEY&co=aHR0cHM&hl=en&v=V&${q}`;
    const invisible = anchor('api2', 'size=invisible&cb=x');
    const bframe = 'https://www.google.com/recaptcha/api2/bframe?hl=en&v=V&k=KEY';
    const frames = (frames, hiddenFrames) => check(snap({ frames, hiddenFrames }));
    assert.equal(frames([invisible]), null, 'невидимый якорь api2');
    assert.equal(frames([anchor('enterprise', 'size=invisible&cb=x')]), null, 'невидимый якорь enterprise');
    assert.equal(frames(['https://www.recaptcha.net/recaptcha/enterprise/anchor?k=KEY&size=invisible']), null, 'невидимый якорь на recaptcha.net');
    assert.equal(frames([anchor('api2', 'cb=x')]), 'капча', 'галочка «I\'m not a robot»');
    assert.equal(frames([anchor('api2', 'size=normal&cb=x')]), 'капча');
    assert.equal(frames([anchor('api2', 'cb=size=invisible')]), 'капча', 'size=invisible в чужом параметре');
    assert.equal(frames([anchor('api2', 'cb=x#size=invisible')]), 'капча', 'size=invisible во фрагменте');
    assert.equal(frames(['https://evil.example/recaptcha/api2/anchor?size=invisible']), 'капча', 'не хост reCAPTCHA');
    assert.equal(frames(['https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=checkbox&size=invisible']), 'капча', 'hCaptcha');
    assert.equal(frames(['https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/x/0x4AAAA/auto/fbE/new/normal/auto/']), 'капча', 'Turnstile');
    assert.equal(frames([invisible, bframe], [bframe]), null, 'скрытый bframe рядом с невидимым якорем');
    assert.equal(frames([invisible, bframe], []), 'капча', 'показанный bframe — задание');
    assert.equal(frames([bframe]), 'капча', 'без hiddenFrames кадр считается показанным');
    assert.equal(frames([bframe, bframe], [bframe]), 'капча', 'два одинаковых bframe, один показан');

    // Признак видимости приходит из eyes: форма с невидимой reCAPTCHA (бейдж и скрытый bframe), сеть заглушена.
    const { diff } = require('../eyes.js');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
      await page.route('**/*', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>stub</p>' }));
      await page.setContent(`<body><form><input aria-label="Имя"></form>
        <div style="position:fixed;bottom:14px;right:14px;width:256px;height:60px;overflow:hidden"><iframe src="${invisible}" width="256" height="60"></iframe></div>
        <div id="challenge" style="visibility:hidden;position:absolute;top:-10000px;left:0;width:100%;opacity:0"><iframe src="${bframe}" width="400" height="580"></iframe></div>
      </body>`);
      await page.waitForLoadState('networkidle');
      const quiet = await see(page);
      assert.deepEqual(quiet.frames, [invisible, bframe], 'в frames все кадры, скрытый тоже');
      assert.deepEqual(quiet.hiddenFrames, [bframe]);
      assert.equal(check(quiet), null, 'невидимая reCAPTCHA не останавливает');
      // Задание показалось: контейнер bframe стал видимым.
      await page.evaluate(() => { const c = document.getElementById('challenge'); c.style.visibility = 'visible'; c.style.opacity = '1'; c.style.top = '0'; });
      const shown = await see(page);
      assert.deepEqual(shown.hiddenFrames, []);
      assert.equal(check(shown), 'капча', 'показанное задание — стоп');
      // Результат act — diff: признак видимости в нём тот же, guard проверяет и его.
      assert.equal(check(diff(quiet, shown)), 'капча');
      assert.equal(check(diff(shown, quiet)), null);
    } finally { await browser.close(); }
  }

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
