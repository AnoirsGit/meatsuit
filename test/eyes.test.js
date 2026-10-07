/**
 * Глаза: видимые элементы получают номера, перекрытые и скрытые не попадают,
 * модалки выделены, diff показывает изменения.
 *
 *   node test/eyes.test.js
 */
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { see, diff } = require('../eyes.js');

const HTML = `
<body style="margin:0">
  <h1>Профиль: Аня, 24</h1>
  <p>Люблю рок и горы</p>
  <button id="like">Like</button>
  <button style="display:none">Скрытая</button>
  <button style="visibility:hidden">Невидимая</button>
  <a href="/m">Matches</a>
  <label for="msg">Сообщение</label><textarea id="msg">привет</textarea>
  <input type="checkbox" id="c" checked aria-label="Rock">
  <button disabled>Недоступная</button>
  <div style="position:fixed;inset:0;background:#0008;z-index:9"></div>
  <div role="dialog" aria-label="Уведомления" style="position:fixed;top:100px;left:100px;width:300px;height:150px;background:#fff;z-index:10">
    Включить уведомления?
    <button id="later">Не сейчас</button>
  </div>
</body>`;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.setContent(HTML);

  const s = await see(page);
  const names = s.elements.map((e) => e.name);

  assert.ok(s.text.includes('Люблю рок'), 'нет видимого текста');
  assert.deepEqual(names, ['Не сейчас'], 'под модалкой элементы должны быть перекрыты, скрытые не видны');
  assert.equal(s.dialogs.length, 1);
  assert.equal(s.dialogs[0].name, 'Уведомления');
  assert.deepEqual(s.dialogs[0].elements, [s.elements[0].id]);

  // Закрыли модалку: страница открылась.
  await page.evaluate(() => document.querySelectorAll('[role=dialog], body > div').forEach((e) => e.remove()));
  const s2 = await see(page);
  const byName = Object.fromEntries(s2.elements.map((e) => [e.name, e]));

  assert.equal(byName.Like.role, 'button');
  assert.equal(byName.Matches.role, 'link');
  assert.equal(byName.Matches.href, '/m', 'у ссылки должен быть href');
  assert.ok(!('href' in byName.Like), 'у кнопки href нет');
  assert.equal(byName['Сообщение'].role, 'textbox');
  assert.equal(byName['Сообщение'].value, 'привет');
  assert.equal(byName.Rock.checked, true);
  assert.equal(byName['Недоступная'].disabled, true);
  assert.ok(!('Скрытая' in byName) && !('Невидимая' in byName));
  assert.ok(s2.gen > s.gen, 'поколение должно расти');

  // Страница не тронута: ни атрибутов в DOM, ни новых свойств window.
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-ms-id],[data-ms-gen],[data-ms-text]').length), 0);
  assert.ok(!(await page.evaluate(() => Object.getOwnPropertyNames(window).some((k) => k.startsWith('__ms')))), 'в window страницы появилось __ms');
  const htmlBefore = await page.content();
  await see(page);
  assert.equal(await page.content(), htmlBefore, 'see() изменил разметку');

  // Скриншот — JPEG в base64.
  const shot = await see(page, { screenshot: true });
  assert.ok(Buffer.from(shot.screenshot, 'base64').slice(0, 2).equals(Buffer.from([0xff, 0xd8])), 'не JPEG');

  // diff: ничего не менялось.
  const same = await see(page, { since: s2 });
  assert.equal(same.changed, false);
  assert.deepEqual(same.added, []);
  assert.ok(!('text' in same));

  // diff: появилась кнопка и поменялся текст.
  await page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<button>Send</button>');
    document.querySelector('p').textContent = 'Люблю метал';
  });
  const changed = await see(page, { since: s2 });
  assert.equal(changed.changed, true);
  assert.deepEqual(changed.added.map((e) => e.name), ['Send']);
  assert.ok(changed.text.includes('метал'));

  // diff как чистая функция: исчезнувший элемент.
  const gone = diff({ ...s2, elements: [...s2.elements, { id: 99, role: 'button', name: 'Old' }] }, s2);
  assert.deepEqual(gone.removed, [{ role: 'button', name: 'Old' }]);

  // open shadow DOM: элементы и текст внутри видны, нумерация и __ms.els работают, вложенные корни тоже.
  const shadowPage = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await shadowPage.setContent(`<body style="margin:0"><button>Light</button><div id="host"></div><div id="closed"></div></body>`);
  await shadowPage.evaluate(() => {
    const r = document.getElementById('host').attachShadow({ mode: 'open' });
    r.innerHTML = '<p>Текст в тени</p><button id="sb">Shadow btn</button><input aria-label="Shadow in" value="v"><div id="inner"></div>';
    r.getElementById('sb').onclick = () => { window.clicked = true; };
    const r2 = r.getElementById('inner').attachShadow({ mode: 'open' });
    r2.innerHTML = '<a href="/deep">Deep link</a>';
    const c = document.getElementById('closed').attachShadow({ mode: 'closed' });
    c.innerHTML = '<button>Closed btn</button>';
  });
  const sh = await see(shadowPage);
  assert.deepEqual(sh.elements.map((e) => e.name), ['Light', 'Shadow btn', 'Shadow in', 'Deep link'], 'open shadow: порядок документа, closed недоступен');
  assert.ok(sh.text.includes('Текст в тени'), 'текст из shadow DOM не виден');
  assert.equal(sh.elements[2].value, 'v');
  assert.equal(sh.elements[3].href, '/deep');
  const { observe } = require('../eyes.js');
  const dom = require('../dom.js');
  const { snap, world } = await observe(shadowPage);
  const sid = snap.elements.find((e) => e.name === 'Shadow btn').id;
  const el = dom.handle(world, sid);
  assert.equal(await el.same(), true);
  await el.scrollIntoViewIfNeeded();
  const box = await el.boundingBox();
  assert.ok(box && box.width > 0, 'boundingBox элемента в shadow');
  await shadowPage.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  assert.equal(await shadowPage.evaluate(() => window.clicked), true, 'клик по координатам элемента в shadow не дошёл');
  // перекрытие оверлеем над хостом скрывает и элементы внутри
  await shadowPage.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div style="position:fixed;inset:0;background:#0008;z-index:9"></div>'));
  assert.deepEqual((await see(shadowPage)).elements, [], 'оверлей должен перекрывать и shadow-элементы');
  // оверлей внутри того же корня: elementFromPoint отдаёт хост, covered должен спуститься в корень
  await shadowPage.setContent('<body style="margin:0"><div id="h"></div></body>');
  await shadowPage.evaluate(() => {
    document.getElementById('h').attachShadow({ mode: 'open' }).innerHTML =
      '<button>Under</button><div style="position:fixed;inset:0;background:#0008;z-index:9"></div>';
  });
  assert.deepEqual((await see(shadowPage)).elements, [], 'оверлей в том же shadow-корне должен перекрывать кнопку');
  // подпись кнопки приходит через <slot>: элементом из light DOM и голым текстом
  await shadowPage.setContent('<body><my-btn id="a"><span>Label</span></my-btn><my-btn id="b">Bare</my-btn></body>');
  await shadowPage.evaluate(() => {
    for (const id of ['a', 'b']) document.getElementById(id).attachShadow({ mode: 'open' }).innerHTML = '<button style="padding:10px"><slot></slot></button>';
  });
  assert.deepEqual((await see(shadowPage)).elements.map((e) => `${e.role}|${e.name}`), ['button|Label', 'button|Bare'], 'кнопка со слотом: в снимке и с подписью из слота');

  await browser.close();
  console.log('eyes.test: ok');
})().catch((e) => { console.error(e); process.exit(1); });
