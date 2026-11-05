/**
 * Глаза, чтение по запросу: see({ within, tree, items, textLimit }). Остальной снимок от этих опций не меняется
 * (его смотрит guard), неверные опции — BadCommand до снимка, страница не тронута.
 *
 *   node test/eyes-read.test.js
 */
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { see, readOpts, BadRead } = require('../eyes.js');
const { hands, BadCommand } = require('../hands.js');
const { check } = require('../guard.js');

// Сконструированная страница, не дамп: подобие Telegram Web K по фактам из исходников tweb, как их записал план
// интеграции (пузырь — role=article, сторона только в классе is-in/is-out; строка списка — <a href="#peerId">;
// лента — role=region «Message history»; эмодзи — <img alt>). Живой Web K с ней не сверялся.
// Перед лентой — 7000 знаков списка: в обычном text (6000) последние сообщения не попадают.
const FILLER = 'Длинное превью чата в списке слева. '.repeat(200);
const HTML = `
<body style="margin:0">
  <style>.time{display:inline-block;margin-left:6px;color:#888}.bubble{margin:4px}</style>
  <script>window.pageVar = 1</script>
  <svg width="10" height="10"><text>svg-текст</text></svg>
  <details><summary>Вопросы</summary><h3>Скрытый ответ</h3>скрытый текст</details>
  <div style="content-visibility:hidden"><h3>Не отрисовано</h3>и это</div>
  <h3 style="display:contents"><span style="display:none">спрятано в contents</span></h3>
  <div id="column-left">
    <div class="filler">${FILLER}</div>
    <ul class="chatlist">
      <li><a class="chatlist-chat" href="#101" data-peer-id="101"><span class="peer-title">Айгерим</span> <span class="badge" style="display:inline-block">2</span></a></li>
      <li><a class="chatlist-chat" href="#-100500" data-peer-id="-100500"><span class="peer-title">Группа</span></a></li>
      <li style="display:none"><a class="chatlist-chat" href="#7">Скрытая папка</a></li>
    </ul>
  </div>
  <div id="column-center">
    <div class="bubbles" role="region" aria-label="Message history"><div class="scrollable"><div class="bubbles-inner">
      <div class="bubble is-in" role="article" data-mid="1"><div class="bubble-content"><div class="message">Привет! <img class="emoji" alt="😂" src="data:,"> как дела?<span class="time">20:14</span></div></div></div>
      <div class="bubble is-out is-read" role="article" data-mid="2"><div class="bubble-content"><div class="message">Норм, а ты?<span class="time">20:15</span></div></div></div>
      <div class="bubble is-in" role="article" data-mid="3" title="подсказка"><div class="bubble-content"><div class="message">Последнее <b>сообщение</b><span style="display:none">скрытое</span><span class="time">20:16</span></div></div></div>
    </div></div></div>
    <div class="chat-input">
      <div class="input-message-input" contenteditable="true" role="textbox" aria-label="Message" style="min-height:20px;border:1px solid"></div>
      <button class="btn-send" aria-label="Send">➤</button>
      <button style="visibility:hidden" aria-label="Запись">🎤</button>
      <input type="password" class="pw" aria-label="Пароль" data-kind="secret">
    </div>
  </div>
</body>`;

(async () => {
  // Проверка опций без браузера: всё лишнее и неверное — до снимка.
  const bad = (o) => assert.throws(() => readOpts(o), BadRead, JSON.stringify(o));
  bad({ within: 'body' });
  bad({ within: {} });
  bad({ within: { css: 'a', role: 'link' } });
  bad({ within: { css: '' } });
  bad({ within: { role: 'region', name: 1 } });
  bad({ within: { css: 'a', deep: true } });
  bad({ tree: 1 });
  bad({ textLimit: 100 }); // без within и tree ему не к чему относиться
  bad({ tree: true, textLimit: 0 });
  bad({ tree: true, textLimit: 1.5 });
  bad({ items: { css: '.b' } }); // нет ни first, ни last
  bad({ items: { css: '.b', first: 1, last: 1 } });
  bad({ items: { css: '.b', last: -1 } });
  bad({ items: { css: '.b', last: 1, attrs: ['value'] } }); // value — нет: в нём бывает пароль
  bad({ items: { css: '.b', last: 1, attrs: ['onclick'] } });
  bad({ items: { css: '.b', last: 1, attrs: 'data-mid' } });
  bad({ items: { css: '.b', last: 1, flags: { out: 5 } } });
  bad({ items: { css: '.b', last: 1, flags: [] } });
  bad({ items: { css: '.b', last: 1, js: 'x' } });
  // числа выше потолка срезаются до потолка
  assert.equal(readOpts({ tree: true, textLimit: 1e9 }).textLimit, 20000);
  assert.equal(readOpts({ items: { css: '.b', last: 1000 } }).items.n, 50);
  assert.equal(readOpts({ items: { css: '.b', first: 3, textLimit: 1e6 } }).items.textLimit, 2000);
  assert.deepEqual(readOpts({ tree: false }), {});

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.setContent(HTML);
  await page.fill('.pw', 'typed-secret');
  await page.evaluate(() => window.scrollTo(0, 0)); // fill прокрутил вниз; сверху виден только список: лента и строки вне экрана

  // Без опций снимок как раньше: тех же полей, обычный text обрезан на 6000 и последних сообщений в нём нет.
  const plain = await see(page);
  assert.deepEqual(Object.keys(plain), ['gen', 'url', 'title', 'text', 'elements', 'dialogs', 'frames', 'hiddenFrames']);
  assert.equal(plain.text.length, 6000);
  assert.ok(!plain.text.includes('Последнее'), 'фикстура должна вылезать за 6000');
  assert.ok(!plain.text.includes('😂'), 'alt в обычном text не появляется: он как раньше');

  // within по роли и имени: текст ленты целиком, с эмодзи на месте, без скрытого; номера элементов ленты.
  const reading = { within: { role: 'region', name: 'Message history' }, tree: true,
    items: { css: '[role=article]', last: 2, flags: { out: '.is-out', read: '.is-read' }, attrs: ['data-mid', 'title'] } };
  const s = await see(page, reading);
  for (const k of ['url', 'title', 'text', 'elements', 'dialogs', 'frames', 'hiddenFrames']) {
    assert.deepEqual(s[k], plain[k], `чтение не меняет ${k}`);
  }
  assert.equal(s.within.text, 'Привет! 😂 как дела? 20:14\nНорм, а ты? 20:15\nПоследнее сообщение 20:16', 'строка на сообщение');
  assert.deepEqual(s.within.elements, [], 'в ленте нет интерактивных элементов');

  // Дерево: обёртки схлопнуты, пузырь — текст и время отдельно, слова не рвутся (<b> внутри слова строки).
  assert.equal(s.tree, [
    '- [article]',
    '  - Привет! 😂 как дела?',
    '  - 20:14',
    '- [article]',
    '  - Норм, а ты?',
    '  - 20:15',
    '- [article]',
    '  - Последнее сообщение',
    '  - 20:16',
  ].join('\n'));

  // items: последние два пузыря со стороной из класса и выбранными атрибутами; всего их три.
  assert.deepEqual(s.items, [
    { text: 'Норм, а ты? 20:15', inView: false, flags: { out: true, read: true }, attrs: { 'data-mid': '2' } },
    { text: 'Последнее сообщение 20:16', inView: false, flags: { out: false, read: false }, attrs: { 'data-mid': '3', title: 'подсказка' } },
  ]);
  assert.equal(s.itemsTotal, 3);

  // Строки списка: first, номер из снимка (по нему click), скрытая строка не считается, href из белого списка.
  const rows = await see(page, { items: { css: '.chatlist-chat', first: 5, attrs: ['href', 'data-peer-id'] } });
  const byName = Object.fromEntries(rows.elements.map((e) => [e.name, e.id]));
  assert.deepEqual(rows.items, [
    { text: 'Айгерим 2', inView: false, id: byName['Айгерим 2'], attrs: { href: '#101', 'data-peer-id': '101' } },
    { text: 'Группа', inView: false, id: byName['Группа'], attrs: { href: '#-100500', 'data-peer-id': '-100500' } },
  ]);
  assert.ok(!('itemsTotal' in rows), 'все найденные отданы — itemsTotal нет');
  assert.ok(!('within' in rows) && !('tree' in rows), 'не просили — полей нет');

  // within по CSS: поле и кнопка внутри, их номера — в within.elements и в дереве; пароля нет нигде.
  const input = await see(page, { within: { css: '.chat-input' }, tree: true, items: { css: '.pw', first: 1, attrs: ['data-kind'] } });
  const ids = Object.fromEntries(input.elements.map((e) => [e.name, e.id]));
  assert.deepEqual(input.within.elements, [ids.Message, ids.Send, ids['Пароль']]);
  assert.equal(input.tree, `- [textbox #${ids.Message} "Message"]\n- [button #${ids.Send} "Send"] ➤\n- [textbox #${ids['Пароль']} "Пароль"]`);
  assert.deepEqual(input.items, [{ text: '', inView: false, id: ids['Пароль'], attrs: {} }], 'у поля пароля атрибуты не читаются');
  assert.ok(!JSON.stringify(input).includes('typed-secret'), 'значение пароля в снимке');
  assert.ok(!JSON.stringify(await see(page, { within: { css: 'body' }, tree: true, textLimit: 20000 })).includes('typed-secret'));

  // items ищутся только внутри within: пузырей в левой колонке нет.
  const left = await see(page, { within: { css: '#column-left' }, textLimit: 20000, items: { css: '[role=article], .chatlist-chat', first: 10 } });
  assert.deepEqual(left.items.map((i) => i.text), ['Айгерим 2', 'Группа']);
  assert.deepEqual(left.within.text.split('\n').slice(1), ['Айгерим 2', 'Группа'], 'строка на строку списка');

  // within не найден: within, tree и items — null (items ищутся внутри within). Найден только видимый.
  const none = await see(page, { within: { css: '#nope' }, tree: true, items: { css: 'a', first: 1 } });
  assert.deepEqual([none.within, none.tree, none.items], [null, null, null]);
  assert.equal((await see(page, { within: { css: 'li[style]' } })).within, null, 'скрытый within не находится');
  assert.equal((await see(page, { within: { role: 'region', name: 'Другое' } })).within, null);
  await page.evaluate(() => { document.querySelector('.chat-input').style.visibility = 'hidden'; });
  assert.equal((await see(page, { within: { css: '.chat-input' } })).within, null, 'within с visibility:hidden не находится');
  await page.evaluate(() => { document.querySelector('.chat-input').style.visibility = ''; });

  // Дерево всей страницы: без <script>, <style>, <svg>, закрытого <details> и content-visibility:hidden (их нет и в
  // innerText); подпись <summary> — кнопка с номером.
  const whole = (await see(page, { tree: true, textLimit: 20000 })).tree;
  for (const hidden of ['pageVar', 'margin-left', 'svg-текст', 'Скрытый ответ', 'скрытый текст', 'скрытое', 'Не отрисовано', 'и это', 'спрятано в contents']) {
    assert.ok(!whole.includes(hidden), `в дереве страницы «${hidden}»`);
  }
  assert.match(whole, /- \[button #\d+\] Вопросы\n/);

  // textLimit: длина within.text и tree; потолок 20000.
  const short = await see(page, { within: { css: '#column-left' }, tree: true, textLimit: 50 });
  assert.equal(short.within.text.length, 50);
  assert.ok(short.within.text.endsWith('…') && short.tree.endsWith('…') && short.tree.length === 50);
  const long = await see(page, { within: { css: 'body' }, textLimit: 1e9 });
  assert.ok(long.within.text.length > 7000 && long.within.text.includes('Последнее сообщение'), 'textLimit выше 6000');
  await page.evaluate(() => { document.querySelector('.filler').textContent = 'x'.repeat(30000); });
  assert.equal((await see(page, { within: { css: 'body' }, textLimit: 1e9 })).within.text.length, 20000, 'потолок textLimit');

  // guard смотрит обычный снимок: капча вне within останавливает так же, как без чтения.
  await page.evaluate(() => document.body.insertAdjacentHTML('afterbegin', '<div role="dialog" aria-label="Проверка">Подтвердите, что вы не робот</div>'));
  const capt = await see(page, { within: { css: '.bubbles' }, items: { css: '[role=article]', last: 1 } });
  assert.equal(check(capt), 'капча');
  assert.ok(!capt.within.text.includes('робот'));

  // Страница не тронута: разметка та же, в window страницы ничего не появилось.
  const before = await page.content();
  await see(page, reading);
  assert.equal(await page.content(), before, 'чтение изменило разметку');
  assert.ok(!(await page.evaluate(() => Object.getOwnPropertyNames(window).some((k) => k.startsWith('__ms')))));

  // Через руки: неверное чтение — BadCommand, прошлый снимок и его номера годны (клик по ним работает).
  await page.setContent('<body style="margin:0"><button onclick="document.title=\'clicked\'">Go</button><ul><li class="it" data-n="1">Раз</li><li class="it">Два <img alt="🔥"></li></ul></body>');
  const h = hands(page);
  const first = await h.see();
  await assert.rejects(h.see({ items: { css: 'li[', first: 1 } }), (e) => e instanceof BadCommand && /неверный CSS-селектор/.test(e.message));
  await assert.rejects(h.see({ items: { css: 'li', first: 1, flags: { x: ':::' } } }), BadCommand);
  await assert.rejects(h.see({ within: { css: 'li' }, settle: { quietMs: 100 }, textLimit: -1 }), BadCommand);
  await assert.rejects(h.see({ settle: { quietMs: 100 }, within: { css: 'li[' } }), BadCommand); // и с ожиданием SPA
  await h.act({ cmd: 'click', id: first.elements[0].id, gen: first.gen });
  assert.equal(await page.title(), 'clicked', 'после отказа see() прошлый снимок должен остаться рабочим');
  // settle и since: чтение приходит и в снимке после ожидания, и в diff (целиком; changed его не учитывает).
  const settled = await h.see({ settle: { quietMs: 100, timeoutMs: 2000 }, items: { css: '.it', last: 5, attrs: ['data-n'] } });
  assert.deepEqual(settled.items, [{ text: 'Раз', inView: true, attrs: { 'data-n': '1' } }, { text: 'Два 🔥', inView: true, attrs: {} }]);
  const d = await h.see({ since: settled, items: { css: '.it', last: 1 } });
  assert.equal(d.changed, false);
  assert.deepEqual(d.items, [{ text: 'Два 🔥', inView: true }]);
  assert.equal(d.itemsTotal, 2);

  // open shadow DOM и <slot>: дерево идёт по составному дереву, как его видит человек.
  await page.setContent('<body><div id="host"><span slot="s">Слот</span></div><p>Light</p></body>');
  await page.evaluate(() => { document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<h2>В тени</h2><div><slot name="s"></slot> и текст</div><button>Тень</button>'; });
  const sh = await see(page, { tree: true, items: { css: 'button', first: 1 } });
  // Хост с тремя кусками внутри — группа «- - …», абзац рядом — отдельно.
  assert.equal(sh.tree, `- - [heading] В тени\n  - Слот и текст\n  - [button #${sh.elements[0].id}] Тень\n- Light`);
  assert.deepEqual(sh.items, [{ text: 'Тень', inView: true, id: sh.elements[0].id }]);

  await browser.close();
  console.log('eyes-read.test: ok');
})().catch((e) => { console.error(e); process.exit(1); });
