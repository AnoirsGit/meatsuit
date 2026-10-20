/**
 * «Видимый HTML»: что из страницы попадает в ответ, какие элементы получают номера.
 * Настоящий Chromium и локальные страницы; без patchright или браузера тесты пропускаются.
 *
 *   NODE_PATH=…/node_modules node --test test/view.test.js
 */
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const chromium = require('../testkit/browser-chromium.js');
const { serve } = require('../testkit/browser-site.js');

const skip = chromium.unavailable();
const { view, element, find } = skip ? {} : require('../view.js');

let browser, context, scratch, cdp;
const opened = [];

before(async () => {
  if (skip) return;
  browser = await chromium.launch();
  const c = await chromium.connect(browser.cdpUrl);
  cdp = c.browser;
  context = c.context;
  scratch = await context.newPage();
});

after(async () => {
  if (skip) return;
  await cdp.close().catch(() => {});
  await browser.stop();
});

afterEach(async () => {
  while (opened.length) await opened.pop().close().catch(() => {});
});

/** Страница из HTML-фикстуры: новый маршрут на локальном сервере и новая вкладка. */
let n = 0;
async function open(body) {
  const path = `/p${++n}`;
  const html = /<html/i.test(body) ? body : `<!doctype html><html><head><meta charset="utf-8"><title>Тест</title></head><body>${body}</body></html>`;
  const s = await serve({ [path]: html });
  const page = await context.newPage();
  opened.push({ close: async () => { await page.close(); await s.close(); } });
  await page.goto(s.origin + path);
  return Object.assign(page, { origin: s.origin });
}

/** Разобрать HTML ответа настоящим парсером и прогнать по нему fn (в браузере, без исполнения скриптов). */
const inDoc = (html, fn) => scratch.evaluate(([h, src]) => {
  const d = new DOMParser().parseFromString(h, 'text/html');
  return new Function('d', `return (${src})(d)`)(d);
}, [html, fn.toString()]);

const numbered = (html) => inDoc(html, (d) => [...d.querySelectorAll('[data-ms]')].map((e) => ({
  ms: Number(e.getAttribute('data-ms')), tag: e.localName, text: (e.textContent || '').replace(/\s+/g, ' ').trim(), name: e.getAttribute('name'),
})));
const textOf = (html) => inDoc(html, (d) => d.body.textContent.replace(/\s+/g, ' '));

test('в ответ не попадает скрытое, скрипты, шаблоны и закрытые shadow-root', { skip }, async () => {
  const page = await open(`
    <h1>Заголовок ВИДИМ</h1>
    <p>Абзац ВИДИМ</p>
    <style>.hid{display:none}</style>
    <p style="display:none">СКРЫТО-display</p>
    <p class="hid">СКРЫТО-класс</p>
    <p style="visibility:hidden">СКРЫТО-visibility</p>
    <p style="opacity:0">СКРЫТО-opacity</p>
    <div style="width:0;height:0;overflow:hidden">СКРЫТО-нулевой</div>
    <div style="position:absolute;left:-9999px">СКРЫТО-за-экраном</div>
    <div style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)">СКРЫТО-sr-only</div>
    <div hidden>СКРЫТО-атрибут</div>
    <script>window.MARK = 'СКРЫТО-скрипт'</script>
    <noscript>СКРЫТО-noscript</noscript>
    <template><p>СКРЫТО-template</p></template>
    <span style="visibility:hidden">СКРЫТО-родитель<b style="visibility:visible">ВИДИМ-потомок</b></span>
    <div id="open"></div><div id="closed"></div><div id="host"><span>ВИДИМ-slot</span></div>
    <script>
      document.getElementById('open').attachShadow({ mode: 'open' }).innerHTML = '<p>ВИДИМ-shadow-open</p>';
      document.getElementById('closed').attachShadow({ mode: 'closed' }).innerHTML = '<p>СКРЫТО-shadow-closed</p>';
      document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<i>до</i><slot></slot>';
    </script>`);
  const { html } = await view(page);
  const text = await textOf(html);
  for (const m of ['Заголовок ВИДИМ', 'Абзац ВИДИМ', 'ВИДИМ-потомок', 'ВИДИМ-shadow-open', 'ВИДИМ-slot']) assert.ok(text.includes(m), `нет «${m}»: ${text}`);
  for (const m of ['display', 'класс', 'visibility', 'opacity', 'нулевой', 'за-экраном', 'sr-only', 'атрибут', 'скрипт', 'noscript', 'template', 'родитель', 'shadow-closed']) {
    assert.ok(!text.includes(`СКРЫТО-${m}`), `попало скрытое «${m}»`);
  }
  assert.ok(!/MARK/.test(html), 'текст скрипта в ответе');
});

test('структура: списки, таблицы, img с alt, ссылки, select, поля с подписями, заглушка iframe', { skip }, async () => {
  const page = await open(`
    <ul><li>раз</li><li>два</li></ul>
    <table><tr><th>Имя</th><td>Иван</td></tr></table>
    <img src="/logo.png" alt="Логотип"><img src="/decor.png">
    <a href="/vacancy/1">Вакансия</a>
    <select name="country"><option value="kz">Казахстан</option><option value="ru" selected>Россия</option></select>
    <label for="mail">Почта</label><input id="mail" name="email" value="a@b.kz" placeholder="Адрес">
    <iframe src="https://other.invalid/frame"></iframe>`);
  const { html } = await view(page);
  const got = await inDoc(html, (d) => ({
    li: [...d.querySelectorAll('ul > li')].map((e) => e.textContent.trim()),
    cell: d.querySelector('table th + td').textContent.trim(),
    imgs: [...d.querySelectorAll('img')].map((e) => e.getAttribute('alt')),
    a: [d.querySelector('a').getAttribute('href'), d.querySelector('a').getAttribute('data-abs')],
    options: [...d.querySelectorAll('select option')].map((e) => [e.getAttribute('value'), e.textContent, e.hasAttribute('selected')]),
    label: [d.querySelector('label').getAttribute('for'), d.querySelector('label').textContent],
    input: [d.querySelector('input').getAttribute('id'), d.querySelector('input').getAttribute('value'), d.querySelector('input').getAttribute('placeholder'), d.querySelector('input').getAttribute('data-label')],
    iframe: [d.querySelectorAll('iframe').length, d.querySelector('iframe').getAttribute('src'), d.querySelector('iframe').textContent],
  }));
  assert.deepEqual(got.li, ['раз', 'два']);
  assert.equal(got.cell, 'Иван');
  assert.deepEqual(got.imgs, ['Логотип'], 'img без alt не нужен, с alt обязателен');
  assert.deepEqual(got.a, ['/vacancy/1', `${page.origin}/vacancy/1`], 'href как в разметке и абсолютный');
  assert.deepEqual(got.options, [['kz', 'Казахстан', false], ['ru', 'Россия', true]]);
  assert.deepEqual(got.label, ['mail', 'Почта']);
  assert.deepEqual(got.input, ['mail', 'a@b.kz', 'Адрес', 'Почта'], 'подпись привязана к полю');
  assert.deepEqual(got.iframe, [1, 'https://other.invalid/frame', ''], 'iframe — только заглушка');
});

test('номера получают только интерактивные элементы', { skip }, async () => {
  const page = await open(`
    <a href="/a">Ссылка</a> <a>Якорь без href</a> <button>Кнопка</button> <input name="q"> <textarea name="msg"></textarea>
    <select name="sel"><option>1</option></select>
    <div role="button">Роль</div> <div tabindex="0">Фокус</div> <div tabindex="-1">Программный фокус</div>
    <div style="cursor:pointer">Курсор <span>вложенный</span></div>
    <div contenteditable="true">Редактор</div>
    <p>Обычный абзац</p><h2>Подзаголовок</h2>
    <button disabled>Выключена</button><input type="hidden" name="h" value="1">`);
  const { html } = await view(page);
  const got = await numbered(html);
  assert.deepEqual(got.map((e) => `${e.tag}:${e.text || e.name}`), [
    'a:Ссылка', 'button:Кнопка', 'input:q', 'textarea:msg', 'select:1', 'div:Роль', 'div:Фокус', 'div:Курсор вложенный', 'div:Редактор',
  ]);
  const ids = got.map((e) => e.ms);
  assert.equal(new Set(ids).size, ids.length, 'номера не уникальны');
  assert.ok(ids.every((i) => Number.isInteger(i) && i > 0));
  assert.ok(!/name="h"/.test(html), 'hidden-поле в ответе');
});

test('кнопка под модальным окном номера не получает', { skip }, async () => {
  const page = await open(`
    <button style="position:absolute;left:100px;top:100px">Под окном</button>
    <div style="position:fixed;inset:0;background:rgba(0,0,0,.5)">
      <div role="dialog" aria-modal="true" style="position:absolute;left:300px;top:200px;width:400px;height:200px;background:#fff">
        <button>Закрыть</button>
      </div>
    </div>
    <button style="position:absolute;left:100px;top:3000px">Внизу под окном</button>
    <div style="height:4000px"></div>`);
  const { html } = await view(page);
  const got = await numbered(html);
  assert.deepEqual(got.map((e) => e.text), ['Закрыть']);
  assert.ok((await textOf(html)).includes('Под окном'), 'текст под окном остаётся виден, но без номера');
});

test('без модального окна кнопка под сгибом страницы получает номер', { skip }, async () => {
  const page = await open(`<button style="position:absolute;left:100px;top:3000px">Внизу</button><div style="height:4000px"></div>`);
  const got = await numbered((await view(page)).html);
  assert.deepEqual(got.map((e) => e.text), ['Внизу']);
});

test('копия страницу не меняет: ни DOM, ни окно страницы', { skip }, async () => {
  const page = await open(`<h1>Привет</h1><button>Кнопка</button><input name="a"><div style="cursor:pointer">Курсор</div><div id="h"></div>
    <script>document.getElementById('h').attachShadow({mode:'open'}).innerHTML = '<a href="/s">в тени</a>'</script>`);
  const session = await context.newCDPSession(page);
  const main = (expression) => session.send('Runtime.evaluate', { expression, returnByValue: true }).then((r) => r.result.value);
  const dom = () => page.evaluate(() => document.documentElement.outerHTML);
  const globals = () => main('Object.getOwnPropertyNames(window).sort().join()');

  const [domBefore, globalsBefore] = [await dom(), await globals()];
  await view(page);
  await view(page, { scope: 'viewport' });
  assert.equal(await dom(), domBefore, 'DOM страницы изменился');
  assert.equal(await globals(), globalsBefore, 'страница видит новые глобальные переменные');
  assert.equal(await main('typeof window.__meatsuit'), 'undefined');
  assert.ok(!(await dom()).includes('data-ms'), 'номера попали в страницу');
});

test('значение пароля не отдаётся никогда', { skip }, async () => {
  const page = await open(`
    <input type="password" name="p" value="сек-ret-1">
    <input type="text" id="t1" value="открытое-значение">
    <input type="text" id="t2" autocomplete="current-password" value="спрятано-2">
    <input type="text" id="t3" autocomplete="cc-number" value="4111111111111111">`);
  await page.evaluate(() => {
    document.querySelector('[name=p]').value = 'набрано-3';
    document.getElementById('t1').value = 'набрано-вручную';
  });
  const { html } = await view(page);
  for (const s of ['сек-ret-1', 'набрано-3', 'спрятано-2', '4111111111111111']) assert.ok(!html.includes(s), `в ответе «${s}»`);
  assert.ok(html.includes('набрано-вручную'), 'обычное поле должно показывать текущее значение');
  const pw = await inDoc(html, (d) => { const e = d.querySelector('input[type=password]'); return { has: !!e, value: e.hasAttribute('value'), ms: e.hasAttribute('data-ms') }; });
  assert.deepEqual(pw, { has: true, value: false, ms: true }, 'поле пароля есть и с номером, но без value');
});

test('scope viewport оставляет то, что на экране, page — весь документ', { skip }, async () => {
  const page = await open(`<body style="margin:0">
    <button style="position:absolute;top:50px">Верх</button><p style="position:absolute;top:50px;left:200px">Текст-верх</p>
    <button style="position:absolute;top:4000px">Низ</button><p style="position:absolute;top:4000px;left:200px">Текст-низ</p>
    <div style="height:5000px"></div></body>`);
  const all = await view(page);
  const top = await view(page, { scope: 'viewport' });
  assert.deepEqual((await numbered(all.html)).map((e) => e.text), ['Верх', 'Низ']);
  assert.deepEqual((await numbered(top.html)).map((e) => e.text), ['Верх']);
  const [tAll, tTop] = [await textOf(all.html), await textOf(top.html)];
  assert.ok(tAll.includes('Текст-низ') && tAll.includes('Текст-верх'));
  assert.ok(tTop.includes('Текст-верх') && !tTop.includes('Текст-низ'));
  assert.deepEqual((await numbered((await view(page, { scope: 'document' })).html)).map((e) => e.text), ['Верх', 'Низ'], 'document — то же, что page');
  await assert.rejects(view(page, { scope: 'всё' }), TypeError);
  await page.evaluate(() => scrollTo(0, 3900));
  const down = await view(page, { scope: 'viewport' });
  assert.deepEqual((await numbered(down.html)).map((e) => e.text), ['Низ']);
});

test('текст страницы не превращается в разметку ответа; кириллица и спецсимволы целы', { skip }, async () => {
  const page = await open(`<p id="t"></p><img id="i" alt="x"><a id="a" href="/x">ссылка</a><button id="b">кнопка</button><input id="in" name="q">`);
  const evil = '<script>window.pwn = 1</script>';
  await page.evaluate((evil) => {
    document.getElementById('t').textContent = `${evil} & «Привет, мир» — №5 "кавычки" 'апостроф' </p><b>`;
    document.getElementById('i').alt = `"><script>window.pwn = 2</script>`;
    document.getElementById('a').setAttribute('href', `/x?a=1&b="2"><script>window.pwn = 3</script>`);
    document.getElementById('b').setAttribute('aria-label', `" onmouseover="window.pwn = 4`);
    document.getElementById('in').value = `"><script>window.pwn = 5</script>`;
  }, evil);
  const { html } = await view(page);

  assert.ok(!/<script/i.test(html), 'в ответе живой <script>');
  const parsed = await inDoc(html, (d) => ({
    scripts: d.querySelectorAll('script').length,
    text: d.querySelector('p').textContent,
    alt: d.querySelector('img').getAttribute('alt'),
    href: d.querySelector('a').getAttribute('href'),
    aria: d.querySelector('button').getAttribute('aria-label'),
    onmouse: d.querySelector('button').hasAttribute('onmouseover'),
    value: d.querySelector('input').getAttribute('value'),
    bold: d.querySelectorAll('p b').length,
  }));
  assert.equal(parsed.scripts, 0);
  assert.equal(parsed.text.trim(), `${evil} & «Привет, мир» — №5 "кавычки" 'апостроф' </p><b>`);
  assert.equal(parsed.alt, '"><script>window.pwn = 2</script>', 'атрибут вернулся ровно таким, каким был');
  assert.equal(parsed.href, '/x?a=1&b="2"><script>window.pwn = 3</script>');
  assert.equal(parsed.aria, '" onmouseover="window.pwn = 4');
  assert.equal(parsed.onmouse, false);
  assert.equal(parsed.value, '"><script>window.pwn = 5</script>');
  assert.equal(parsed.bold, 0);

  // и по-настоящему: открыть ответ в браузере, скрипты включены, ничего не должно выполниться
  await scratch.setContent(html);
  await scratch.waitForTimeout(100);
  assert.equal(await scratch.evaluate(() => window.pwn), undefined, 'выполнился код из текста страницы');
});

test('невидимые управляющие символы вырезаются', { skip }, async () => {
  const page = await open(`<p id="t"></p>`);
  await page.evaluate(() => {
    document.getElementById('t').textContent = 'до\u202Eтекст\u200B\u2060после' + String.fromCodePoint(0xE0049, 0xE0067) + 'конец\u0007';
  });
  const text = await textOf((await view(page)).html);
  assert.ok(text.includes('дотекстпослеконец'), `осталось: ${JSON.stringify(text)}`);
});

test('в head: url, title, guard; guard выдаёт страница-блок', { skip }, async () => {
  const ok = await open(`<html><head><meta charset="utf-8"><title>Вакансии & работа</title></head><body><p>обычная страница</p></body></html>`);
  const r1 = await view(ok);
  assert.equal(r1.guard, null);
  assert.equal(r1.title, 'Вакансии & работа');
  assert.equal(r1.url, ok.url());
  const head1 = await inDoc(r1.html, (d) => ({ title: d.title, url: d.querySelector('meta[name=url]').content, guard: d.querySelector('meta[name=guard]').content }));
  assert.deepEqual(head1, { title: 'Вакансии & работа', url: ok.url(), guard: 'null' });

  const blocked = await open(`<html><head><meta charset="utf-8"><title>Just a moment...</title></head><body><p>Checking your browser</p></body></html>`);
  const r2 = await view(blocked);
  assert.equal(r2.guard, 'captcha');
  assert.equal(await inDoc(r2.html, (d) => d.querySelector('meta[name=guard]').content), 'captcha');
});

test('номера живут между вызовами до следующего view или навигации', { skip }, async () => {
  const page = await open(`<button id="a">Первая</button><button id="b">Вторая</button>`);
  const first = await numbered((await view(page)).html);
  const [a, b] = first.map((e) => e.ms);

  const ha = await element(page, a);
  assert.equal(await ha.evaluate((e) => e.id), 'a', 'номер указывает на тот же элемент');
  assert.equal(await (await element(page, b)).evaluate((e) => e.id), 'b');
  assert.ok((await element(page, 9999)) === null, 'неизвестный номер');

  await page.evaluate(() => document.getElementById('a').remove());
  assert.ok((await element(page, a)) === null, 'удалённый элемент: номер устарел');

  await view(page); // новый view: старые номера не действуют, даже у уцелевших элементов
  assert.ok((await element(page, b)) === null, 'номер из прошлого view');

  const fresh = (await numbered((await view(page)).html))[0].ms;
  assert.ok(await element(page, fresh));
  await page.goto('about:blank');
  assert.ok((await element(page, fresh)) === null, 'после навигации номера нет');
});

test('поиск по тексту: сначала точное совпадение, потом вхождение; кандидаты с номерами', { skip }, async () => {
  const page = await open(`
    <button>Войти</button><button>Войти через Google</button><a href="/x">Купить</a><button>Купить</button><p>Текст Купить в абзаце</p>
    <button aria-label="Закрыть окно">×</button><input type="submit" value="Отправить">
    <label for="n">Ваше имя</label><input id="n" name="n"><button style="display:none">Скрытая</button>`);
  const { html } = await view(page);
  const nums = await numbered(html);
  const byText = (t) => nums.find((e) => e.text === t).ms;

  const exact = await find(page, { text: 'войти' });
  assert.deepEqual(exact.matches.map((m) => m.ref), [byText('Войти')], 'точное побеждает вхождение (регистр не важен)');

  const sub = await find(page, { text: 'через' });
  assert.deepEqual(sub.matches.map((m) => m.text), ['Войти через Google']);

  const two = await find(page, { text: 'Купить' });
  assert.equal(two.matches.length, 2, 'ссылка и кнопка; абзац не цель');
  assert.ok(two.matches.every((m) => m.text === 'Купить' && Number.isInteger(m.ref)));
  assert.equal(await (await element(page, two.matches[1].ref)).evaluate((e) => e.localName), 'button', 'номер кандидата рабочий');

  assert.equal((await find(page, { text: 'Закрыть окно' })).matches.length, 1, 'aria-label');
  assert.equal((await find(page, { text: 'Отправить' })).matches.length, 1, 'value кнопки');
  const field = await find(page, { text: 'Ваше имя' });
  assert.equal(await (await element(page, field.matches[0].ref)).evaluate((e) => e.localName), 'input', 'подпись ведёт к полю');
  assert.equal((await find(page, { text: 'Скрытая' })).matches.length, 0, 'скрытое не ищется');
  assert.equal((await find(page, { text: 'нет такого' })).matches.length, 0);
});

test('поиск по css: только видимые; кривой селектор — ошибка', { skip }, async () => {
  const page = await open(`<button class="b">раз</button><button class="b" style="display:none">скрытая</button><div class="b">блок</div><input id="one">`);
  const r = await find(page, { css: '.b' });
  assert.deepEqual(r.matches.map((m) => m.text), ['раз', 'блок']);
  assert.equal((await find(page, { css: '#one' })).matches.length, 1);
  assert.equal((await find(page, { css: '[[[' })).error, 'selector');
});

test('подпись скрытого флажка получает номер и находится по тексту', { skip }, async () => {
  const page = await open(`<input type="checkbox" id="agree" style="opacity:0;position:absolute"><label for="agree">Согласен с условиями</label>`);
  const { html } = await view(page);
  const got = await numbered(html);
  assert.deepEqual(got.map((e) => `${e.tag}:${e.text}`), ['label:Согласен с условиями']);
  const r = await find(page, { text: 'Согласен' });
  assert.equal(r.matches.length, 1);
});
