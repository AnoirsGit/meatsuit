/**
 * Сквозные тесты на настоящем Chromium: настоящие руки (human.js), сессия
 * (life/session.js), пробы (life/probe.js) и guard. Они ловят то, что фальшивая
 * страница пропустила: относительный href у ссылки, гонку «Execution context
 * was destroyed» после клика, ссылки только в видимой части экрана, точный
 * ввод кириллицы настоящими клавишами. Время реальное, прогон около полутора минут.
 *
 *   npm run test:e2e   (E2E=1; нужны Chromium и patchright, например NODE_PATH=…/node_modules)
 *
 * Без E2E=1, patchright или браузера файл сразу пропускается и обычный `node --test` не ломает.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { skipReason, startSite, startChromium } = require('../testkit/e2e-site.js');

const why = skipReason();
if (why) test('E2E на настоящем Chromium', (t) => t.skip(why));
else suite();

function suite() {
  const { describe, it, before, after, beforeEach } = test;
  const { chromium } = require('patchright');
  const human = require('../human.js');
  const probe = require('../life/probe.js');
  const { classify } = require('../guard.js');
  const { runSession, Blocked } = require('../life/session.js');

  let site, browser, chrome, context;

  // Кириллица на физических клавишах ЙЦУКЕН: буква → код клавиши. Оракул независим от human/keys.js.
  const RU_CODES = {};
  [['йцукенгшщзхъ', ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP', 'BracketLeft', 'BracketRight']],
    ['фывапролджэ', ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon', 'Quote']],
    ['ячсмитьбю', ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma', 'Period']],
    ['ё', ['Backquote']]].forEach(([letters, codes]) => [...letters].forEach((ch, i) => { RU_CODES[ch] = codes[i]; }));

  const withPage = async (fn) => {
    const page = await context.newPage();
    try { return await fn(page); } finally { await page.close().catch(() => {}); }
  };
  const read = (path, budgetMs, follow = 0) => ({ url: site.url(path), kind: 'read', budgetMs, follow });
  const steps = (journal) => journal.filter((e) => e.event === 'step').map((e) => [new URL(e.url).pathname, e.result, e.reason]);

  describe('E2E на настоящем Chromium', { timeout: 170000 }, () => {
    before(async () => {
      site = await startSite();
      chrome = await startChromium();
      browser = await chromium.connectOverCDP(chrome.cdp);
      context = browser.contexts()[0] || await browser.newContext();
      human.usePersona({ speed: 1, tremor: 0.7, twitch: 0.3, wpm: 60 }); // одни повадки на все тесты
    });
    after(async () => {
      human.usePersona(null);
      if (browser) await browser.close().catch(() => {}); // только отключает нас
      if (chrome) await chrome.stop();
      if (site) await site.close();
    });
    beforeEach(() => { site.requests.length = 0; });

    /** Напечатать текст в поле формы настоящими руками и вернуть значение поля и журнал событий страницы. */
    const typeInto = (text, opts) => withPage(async (page) => {
      await page.goto(site.url('/form'), { waitUntil: 'domcontentloaded' });
      await human.click(page, page.locator('#name'));
      assert.equal(await page.evaluate(() => document.activeElement.id), 'name', 'клик не поставил курсор в поле');
      await human.type(page, text, opts);
      return { value: await page.inputValue('#name'), log: (await page.evaluate(() => document.getElementById('log').textContent)).split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
    });

    it('печать: кириллица, заглавные, знаки RU-раскладки и № в поле точно, клавиши настоящие', { timeout: 60000 }, async () => {
      const TEXT = 'Йошкар-Ола, Привет, Мир! Hello, World. Как дела? №5 Ёж, чай.';
      const { value, log } = await typeInto(TEXT, { wpm: 130 });
      assert.equal(value, TEXT);

      const keys = log.filter((e) => e.t === 'keydown' || e.t === 'keyup');
      assert.ok(keys.length > TEXT.length, `событий клавиатуры мало: ${keys.length}`);
      assert.ok(keys.every((e) => e.trusted), 'есть недоверенные (скриптовые) события клавиатуры');
      assert.ok(log.filter((e) => e.t === 'input').length > 0 && log.filter((e) => e.t === 'input').every((e) => e.trusted), 'input не от клавиатуры');
      assert.ok(log.filter((e) => e.t === 'mousedown' || e.t === 'click').every((e) => e.trusted), 'клик по полю недоверенный');

      const down = keys.filter((e) => e.t === 'keydown');
      const cyr = down.filter((e) => /[а-яё]/i.test(e.key));
      assert.ok(cyr.length >= 20, `кириллических нажатий ${cyr.length}`);
      for (const e of cyr) assert.equal(e.code, RU_CODES[e.key.toLowerCase()], `«${e.key}» нажата как ${e.code}`);
      assert.ok(down.some((e) => e.key === 'Й' && e.code === 'KeyQ' && e.shift), 'заглавная «Й» не KeyQ с Shift');
      assert.ok(down.some((e) => e.key === 'й' && e.code === 'KeyQ' && !e.shift), 'строчная «й» не KeyQ без Shift');

      const has = (key, code, shift) => down.some((e) => e.key === key && e.code === code && e.shift === shift);
      assert.ok(has(',', 'Slash', true), 'запятая в русской раскладке: Shift+Slash');
      assert.ok(has('.', 'Slash', false), 'точка в русской раскладке: Slash');
      assert.ok(has('?', 'Digit7', true), 'вопрос в русской раскладке: Shift+Digit7');
      assert.ok(has('№', 'Digit3', true), '№: Shift+Digit3');
      assert.ok(has(',', 'Comma', false), 'запятая в английской раскладке: Comma');
      assert.ok(down.some((e) => e.key === 'Shift'), 'Shift не нажимался');
      for (const e of down.filter((x) => /^[a-z]$/i.test(x.key))) assert.equal(e.code, `Key${e.key.toUpperCase()}`, `латинская «${e.key}» нажата как ${e.code}`);
    });

    it('печать с опечатками: стирает Backspace, итог в поле точный', { timeout: 60000 }, async () => {
      const TEXT = 'Привет, Мир! Съешь ещё булок.';
      const { value, log } = await typeInto(TEXT, { wpm: 130, typoRate: 0.5 });
      assert.equal(value, TEXT);
      const down = log.filter((e) => e.t === 'keydown');
      assert.ok(down.filter((e) => e.key === 'Backspace').length >= 2, 'опечаток не было: Backspace не нажимался');
      assert.ok(down.every((e) => /[а-яё]/i.test(e.key) ? e.code === RU_CODES[e.key.toLowerCase()] : true), 'у кириллицы неверный code (в том числе у опечаток)');
      assert.ok(log.filter((e) => e.t === 'keydown' || e.t === 'keyup').every((e) => e.trusted), 'есть недоверенные события');
    });

    it('guard и пробы на настоящих страницах: блок, капча, обычная страница', { timeout: 60000 }, async () => {
      await withPage(async (page) => {
        const verdict = async (path) => {
          await page.goto(site.url(path), { waitUntil: 'domcontentloaded' });
          return classify(await probe.snapshot(page));
        };
        assert.equal(await verdict('/blocked'), 'blocked');
        assert.equal(await verdict('/captcha'), 'captcha');
        assert.equal(await verdict('/news'), null);
      });
    });

    it('probe: чтение страницы посреди перехода не падает «Execution context was destroyed»', { timeout: 60000 }, async () => {
      await withPage(async (page) => {
        // Запустить переход на медленную страницу и читать без пауз, пока адрес не сменится; вернуть ошибки и последний результат.
        const during = async (readIt) => {
          await page.goto(site.url('/news/3'), { waitUntil: 'domcontentloaded' });
          await page.evaluate((u) => { setTimeout(() => { location.href = u; }, 0); }, site.url('/slow'));
          const errors = [];
          let last;
          for (const t0 = Date.now(); !page.url().includes('/slow') && Date.now() - t0 < 8000;) {
            try { last = await readIt(); } catch (err) { errors.push(err.message.split('\n')[0]); }
          }
          assert.ok(page.url().includes('/slow'), 'переход не завершился');
          return { errors, last };
        };

        // Сам стенд: сырое чтение посреди перехода рвётся. Иначе тест ничего бы не проверял.
        const raw = await during(() => page.evaluate(() => document.body.innerText.length));
        assert.ok(raw.errors.some((m) => /context was destroyed/i.test(m)), `стенд не воспроизвёл гонку, ошибки: ${JSON.stringify(raw.errors)}`);

        for (const name of ['metrics', 'links', 'snapshot']) {
          const { errors, last } = await during(() => probe[name](page));
          assert.deepEqual(errors, [], `probe.${name} упал посреди перехода`);
          assert.ok(last !== undefined, `probe.${name} ничего не вернул`);
          if (name === 'snapshot') assert.equal(last.title, 'Медленная', 'прочитана старая страница, а не новая');
          if (name === 'metrics') assert.ok(last.textLen > 100, 'метрики не новой страницы');
        }
      });
    });

    it('чтение со ссылкой: заголовки только вверху, после прокрутки возвращается наверх и идёт по относительному href', { timeout: 90000 }, async () => {
      const seen = []; // что видели пробы ссылок: куда прокручено и сколько ссылок на экране
      const watching = { ...probe, links: async (page) => {
        const found = await probe.links(page);
        seen.push({ n: found.length, scrollY: (await probe.metrics(page)).scrollY });
        return found;
      } };
      const journal = [];
      await withPage((page) => runSession(page, [read('/news', 24000, 1)], { probe: watching, log: (e) => journal.push(e) }));

      assert.deepEqual(steps(journal).map(([, result, reason]) => [result, reason]), [['ok', undefined]], 'сайт не прочитан до конца');
      const go = journal.find((e) => e.event === 'follow');
      assert.ok(go && /^\/news\/[23]$/.test(new URL(go.href).pathname), `переход по ссылке не состоялся: ${JSON.stringify(go)}`);

      const hidden = seen.findIndex((s) => s.n === 0 && s.scrollY > 150);
      assert.ok(hidden >= 0, `после чтения ссылок не пришлось искать: ${JSON.stringify(seen)}`);
      assert.ok(seen.slice(hidden + 1).some((s) => s.n > 0 && s.scrollY < seen[hidden].scrollY), `не вернулся вверх и не нашёл ссылки: ${JSON.stringify(seen)}`);

      const hit = site.requests.find((r) => /^\/news\/[23]$/.test(r.path));
      assert.ok(hit, 'страница по ссылке не запрашивалась');
      assert.equal(hit.referer, site.url('/news'), 'на страницу попали не кликом по ссылке');
    });

    it('видео: находит ролик по относительному href /watch?v=… и смотрит его', { timeout: 90000 }, async () => {
      const journal = [];
      const t0 = Date.now();
      await withPage((page) => runSession(page, [{ url: site.url('/video'), kind: 'video', budgetMs: 30000, follow: 0 }], { log: (e) => journal.push(e) }));

      assert.deepEqual(steps(journal).map(([, result, reason]) => [result, reason]), [['ok', undefined]], 'ролик не открыт');
      assert.equal(journal.find((e) => e.event === 'follow').href, site.url('/watch?v=abc'));
      assert.equal(site.hits('/watch?v=abc')[0].referer, site.url('/video'), 'на ролик попали не кликом по ссылке');
      assert.ok(Date.now() - t0 >= 30000, `смотрел всего ${Date.now() - t0} мс при бюджете 30000`);
    });

    it('страница-блок («unusual traffic»): сессия останавливается ошибкой Blocked, дальше сайты не открываются', { timeout: 60000 }, async () => {
      const journal = [];
      await withPage(async (page) => {
        await assert.rejects(runSession(page, [read('/blocked', 20000), read('/news/3', 20000)], { log: (e) => journal.push(e) }),
          (e) => e instanceof Blocked && e.reason === 'blocked' && e.url === site.url('/blocked'));
      });
      assert.deepEqual(steps(journal), [['/blocked', 'blocked', 'blocked']]);
      assert.equal(site.hits('/news/3').length, 0, 'после блока открыт следующий сайт');
    });

    it('капча (виден фрейм проверки): Blocked с причиной captcha', { timeout: 60000 }, async () => {
      await withPage(async (page) => {
        await assert.rejects(runSession(page, [read('/captcha', 20000), read('/news/3', 20000)]), (e) => e instanceof Blocked && e.reason === 'captcha');
      });
      assert.equal(site.hits('/news/3').length, 0, 'после капчи открыт следующий сайт');
    });
  });
}
