/**
 * codeLogin: вход по одноразовому коду (supervise и task). Опция задачи + своя запись площадки в sites.json →
 * страница входа на объявленном пути не стоп; пароль, капча, блокировка, чужой путь или площадка — стоп как всегда.
 * Бюджет такой задачи урезан, набранный код в журнал не попадает.
 *
 *   node test/code-login.test.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { cdpPort } = require('./cdp-port.js');
const { supervise, BudgetExceeded } = require('../supervise.js');
const { codeLoginRule, NeedsHuman, CODE_LOGIN_MAX_COMMANDS } = require('../guard.js');

const CODE = '482913';

(async () => {
  // --- supervise без браузера: подменные руки отдают заданные снимки.
  const page = (url, o = {}) => ({ gen: 1, url, title: 'Вход', text: '', elements: [{ id: 1, role: 'textbox', name: 'Код из SMS' }], dialogs: [], ...o });
  const rule = codeLoginRule({ path: '^/account/login', maxMinutes: 3 });
  const run = (snaps, opts = {}) => {
    const notes = [];
    let i = 0;
    const next = () => snaps[Math.min(i++, snaps.length - 1)];
    const h = { see: async () => next(), act: async () => ({ ...next(), dryRun: false }) };
    const r = supervise(h, { name: 'cvs-login', site: 'hh.kz', notify: (t) => notes.push(t), maxCommands: 60, maxMinutes: 10, ...opts });
    return { ...r, notes };
  };

  { // разрешено: объявленный путь, поле кода
    const { api, state, notes } = run([page('https://hh.kz/account/login'), page('https://hh.kz/account/login?step=code')], { codeLogin: rule });
    await api.see();
    await api.act({ cmd: 'fill', id: 1, gen: 1, text: CODE });
    assert.equal(state.stopped, null);
    assert.deepEqual(notes, []);
  }
  { // без codeLogin — стоп «страница входа», и он липкий
    const { api, state, notes } = run([page('https://hh.kz/account/login')]);
    await assert.rejects(api.see(), (e) => e instanceof NeedsHuman && e.reason === 'страница входа');
    await assert.rejects(api.act({ cmd: 'wait', ms: 1 }), NeedsHuman);
    assert.ok(state.stopped);
    assert.match(notes[0], /cvs-login.*страница входа/);
  }
  const denied = async (snaps, reason, opts = { codeLogin: rule }) => {
    const { api, state } = run(snaps, opts);
    await api.see().then(() => api.act({ cmd: 'wait', ms: 1 })).then(() => assert.fail('нет стопа'), (e) => {
      assert.ok(e instanceof NeedsHuman, e.message);
      assert.match(e.reason, reason);
    });
    await assert.rejects(api.see(), NeedsHuman, 'стоп липкий и для codeLogin');
    assert.ok(state.stopped);
  };
  // запрещено: поле пароля (сразу или после действия), капча, подозрительная страница, чужой путь, чужая площадка
  await denied([page('https://hh.kz/account/login', { elements: [{ id: 2, role: 'textbox', name: 'Пароль', inputType: 'password' }] })], /страница входа/);
  await denied([page('https://hh.kz/account/login'), page('https://hh.kz/account/login', { elements: [{ id: 2, role: 'textbox', name: 'Пароль' }] })], /страница входа/);
  await denied([page('https://hh.kz/account/login', { text: 'Подтвердите, что вы не робот' })], /капча/);
  await denied([page('https://hh.kz/account/login', { frames: ['https://www.google.com/recaptcha/api2/anchor?k=K'] })], /капча/);
  await denied([page('https://hh.kz/account/login', { text: 'Подозрительная активность' })], /подозрительная/);
  await denied([page('https://hh.kz/login')], /страница входа/);
  await denied([page('https://hh.kz/account/login'), page('https://hh.ru/account/login')], /страница входа/);
  // extraHosts — не площадка: на них codeLogin не действует
  await denied([page('https://hh.ru/account/login')], /страница входа/, { codeLogin: rule, extraHosts: ['hh.ru'] });

  { // бюджет: не больше CODE_LOGIN_MAX_COMMANDS команд и не дольше codeLogin.maxMinutes, даже если вызывающий просил больше
    const { api, state } = run([page('https://hh.kz/account/login')], { codeLogin: rule });
    assert.equal(CODE_LOGIN_MAX_COMMANDS, 20);
    assert.equal(state.maxCommands, 20);
    assert.equal(state.maxMinutes, 3);
    for (let k = 0; k < 20; k++) await api.act({ cmd: 'wait', ms: 1 });
    await assert.rejects(api.act({ cmd: 'wait', ms: 1 }), (e) => e instanceof BudgetExceeded && /20 команд/.test(e.message));
    const small = run([page('https://hh.kz/account/login')], { codeLogin: rule, maxCommands: 5, maxMinutes: 1 }).state;
    assert.deepEqual([small.maxCommands, small.maxMinutes], [5, 1], 'меньший бюджет вызывающего остаётся');
    const plain = run([page('https://hh.kz/')]).state;
    assert.deepEqual([plain.maxCommands, plain.maxMinutes], [60, 10], 'без codeLogin бюджет прежний');
  }

  // --- task() в настоящем Chromium: оба согласия, отказы до очереди, журнал без кода.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meatsuit-codelogin-'));
  const sitesFile = path.join(tmp, 'sites.json');
  const declared = { path: '^/account/login' };
  fs.writeFileSync(sitesFile, JSON.stringify({
    'code.test': { perDay: 100, codeLogin: declared },
    'plain.test': { perDay: 100 },
    'bad.test': { perDay: 100, codeLogin: { path: 'account/login' } },
    '*': { perDay: 100, codeLogin: declared }, // из "*" codeLogin не берётся
  }));
  const ctx = await chromium.launchPersistentContext(path.join(tmp, 'profile'), { headless: true, args: ['--remote-debugging-port=0'] });
  const PORT = await cdpPort(path.join(tmp, 'profile'));
  const { connect } = require('../index.js');
  let ms;
  try {
    const mine = ctx.pages()[0] || (await ctx.newPage());
    await mine.setContent('<title>моя вкладка</title>');
    await ctx.route(/\.test\//, (r) => {
      const u = new URL(r.request().url());
      const body = u.pathname === '/account/login/pw' ? '<input aria-label="Телефон"><input type="password" aria-label="Пароль">'
        : u.pathname === '/account/login/captcha' ? '<p>Подтвердите, что вы не робот</p>'
        : u.pathname.startsWith('/account/login') ? '<title>Вход</title><input aria-label="Код из SMS"><button>Войти</button>'
        : '<title>Мои отклики</title><p>Привет</p>';
      return r.fulfill({ contentType: 'text/html; charset=utf-8', body });
    });
    const notes = [];
    const dir = path.join(tmp, 'state');
    ms = await connect({ cdpUrl: `http://127.0.0.1:${PORT}`, dir, sitesFile, notify: async (t, e) => notes.push({ t, e }) });
    const windows = () => ctx.pages().length;
    const settle = () => new Promise((r) => setTimeout(r, 300));
    const closeLeft = async () => { for (const p of ctx.pages()) if (p !== mine) await p.close(); };
    const limitsFile = path.join(dir, 'limits.json');
    const spent = (site) => { try { return (JSON.parse(fs.readFileSync(limitsFile, 'utf8'))[site] || []).length; } catch { return 0; } };

    // 1. Разрешено: задача с codeLogin на объявленном пути вписывает код; окно закрывается.
    const ok = await ms.task('cvs-login', async ({ see, act }) => {
      await act({ cmd: 'goto', url: 'https://code.test/account/login?backurl=%2Fapplicant' });
      const s = await see();
      const field = s.elements.find((e) => e.name === 'Код из SMS');
      await act({ cmd: 'fill', id: field.id, gen: s.gen, text: CODE });
      await act({ cmd: 'goto', url: 'https://code.test/applicant' });
      return (await see()).title;
    }, { site: 'code.test', codeLogin: true });
    assert.equal(ok, 'Мои отклики');
    await settle();
    assert.equal(windows(), 1, 'окно задачи закрылось');
    const journal = fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8');
    assert.ok(journal.includes('"cmd":"fill"'), 'fill в журнале есть');
    assert.ok(!journal.includes(CODE), 'код не должен попадать в журнал');
    assert.ok(!journal.includes('backurl'), 'query адреса не должен попадать в журнал');

    // 2. Своя запись с codeLogin, но задача не просила — стоп «страница входа», окно остаётся человеку.
    await assert.rejects(ms.task('no-opt', async ({ act }) => { await act({ cmd: 'goto', url: 'https://code.test/account/login' }); }, { site: 'code.test' }),
      (e) => e instanceof NeedsHuman && e.reason === 'страница входа');
    await settle();
    assert.equal(windows(), 2, 'окно со стопом осталось');
    await closeLeft();

    // 3. Пароль и капча на объявленном пути — стоп и для codeLogin.
    for (const [p, reason] of [['/account/login/pw', 'страница входа'], ['/account/login/captcha', 'капча']]) {
      await assert.rejects(ms.task('deny', async ({ act }) => { await act({ cmd: 'goto', url: `https://code.test${p}` }); }, { site: 'code.test', codeLogin: true }),
        (e) => e instanceof NeedsHuman && e.reason === reason, p);
      await closeLeft();
    }
    // 4. Бюджет: 21-я команда задачи с codeLogin — BudgetExceeded, хотя просили 60.
    await assert.rejects(ms.task('budget', async ({ act }) => { for (let k = 0; k < 21; k++) await act({ cmd: 'wait', ms: 1 }); }, { site: 'code.test', codeLogin: true, maxCommands: 60 }),
      (e) => e instanceof BudgetExceeded && /20 команд/.test(e.message));
    await settle();

    // 5. Отказы до очереди и браузера: слот не тратится, окно не открывается.
    const before = windows();
    const spentBefore = ['plain.test', 'other.test', 'bad.test'].map(spent);
    await assert.rejects(ms.task('x', async () => 1, { site: 'plain.test', codeLogin: true }), /нет своего "codeLogin"/);
    await assert.rejects(ms.task('x', async () => 1, { site: 'other.test', codeLogin: true }), /из "\*" не берётся/);
    await assert.rejects(ms.task('x', async () => 1, { site: 'bad.test', codeLogin: true }), /codeLogin: path/);
    await assert.rejects(ms.task('x', async () => 1, { site: 'code.test', codeLogin: 'yes' }), /codeLogin — true или false/);
    assert.equal(windows(), before);
    assert.deepEqual(['plain.test', 'other.test', 'bad.test'].map(spent), spentBefore);
    // Неверное правило площадки без опции задачи ни на что не влияет.
    assert.equal(await ms.task('x', async () => 'ok', { site: 'bad.test' }), 'ok');
    assert.equal(notes.filter((n) => n.e === 'needsHuman').length, 3);
  } finally {
    if (ms) await ms.close().catch(() => {});
    await ctx.close();
  }
  console.log('code-login.test: ok');
})().catch((e) => { console.error(e); process.exit(1); });
