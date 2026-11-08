/**
 * Руки: закрытый набор команд, номера из снимка, StaleElement, dryRun,
 * журнал, запись и воспроизведение.
 *
 *   node test/hands.test.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { hands, replay, validate, BadCommand, StaleElement, FieldMismatch } = require('../hands.js');
const human = require('../human.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HTML = `
<body style="margin:0">
  <button id="like" onclick="document.body.insertAdjacentText('beforeend','Лайк поставлен'); this.remove()">Like</button>
  <textarea id="msg" aria-label="Сообщение">старое</textarea>
  <button onclick="document.title='sent:'+document.getElementById('msg').value">Send</button>
</body>`;

const rejects = (c, hosts) => assert.throws(() => validate(c, hosts), BadCommand, JSON.stringify(c));

(async () => {
  // Закрытый набор: всё лишнее отклоняется до выполнения.
  rejects({ cmd: 'eval', code: '1' });
  rejects({ cmd: 'click' });
  rejects({ cmd: 'click', id: '7', gen: 1 });
  rejects({ cmd: 'click', id: 7 }); // без gen
  rejects({ cmd: 'fill', id: 1, gen: 1, text: '' });
  rejects({ cmd: 'fill', id: 1, gen: 1, text: 'x'.repeat(2001) }); // 1001–2000 и переводы строк — только в textarea (test/forms.test.js)
  rejects({ cmd: 'press', key: 'F12' });
  rejects({ cmd: 'wait', ms: 999999 });
  rejects({ cmd: 'goto', url: 'https://evil.example/' }, ['tinder.com']);
  rejects({ cmd: 'goto', url: 'https://tinder.com.evil.example/' }, ['tinder.com']);
  rejects({ cmd: 'goto', url: 'http://tinder.com/' }, ['tinder.com']);
  rejects({ cmd: 'goto', url: 'file:///etc/passwd' }, ['tinder.com']);
  rejects({ cmd: 'goto', url: 'javascript:alert(1)' }, ['tinder.com']);
  rejects(null);
  validate({ cmd: 'goto', url: 'https://tinder.com/app/recs' }, ['tinder.com']);
  validate({ cmd: 'press', key: 'Enter' });
  // press и type могут назвать поле, которое должно быть в фокусе: id и gen только вместе.
  rejects({ cmd: 'press', key: 'Enter', id: 1 });
  rejects({ cmd: 'type', text: 'x', gen: 1 });
  rejects({ cmd: 'type', text: 'x', id: '1', gen: 1 });
  validate({ cmd: 'press', key: 'Enter', id: 1, gen: 1 });
  validate({ cmd: 'type', text: 'x', id: 1, gen: 1 });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meatsuit-'));
  const logFile = path.join(dir, 'log.jsonl');
  const recordDir = path.join(dir, 'rec');

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.setContent(HTML);

  // dryRun: ничего не происходит, но записано.
  const dry = hands(page, { dryRun: true, logFile });
  const d0 = await dry.see();
  const likeId = d0.elements.find((e) => e.name === 'Like').id;
  assert.deepEqual(await dry.act({ cmd: 'click', id: likeId, gen: d0.gen }), { dryRun: true, changed: false });
  assert.equal(await page.locator('#like').count(), 1, 'dryRun кликнул');
  // goto в dryRun выполняется (только читает), иначе окно остаётся about:blank и видеть нечего.
  await page.route('https://example.test/**', (r) => r.fulfill({ contentType: 'text/html', body: '<title>там</title>' }));
  const dryNav = hands(page, { dryRun: true, allowedHosts: ['example.test'] });
  const nav = await dryNav.act({ cmd: 'goto', url: 'https://example.test/x' });
  assert.equal(nav.url, 'https://example.test/x', 'dryRun goto не перешёл');
  await page.setContent(HTML);

  // dryRunNavigation: клик по role=tab выполняется, остальное только в журнал; без опции tab тоже не кликается.
  const TABS = `<body style="margin:0">
    <div role="tab" onclick="document.title='tab'">Messages</div>
    <button onclick="document.title='button'">Btn</button>
    <a href="#x" onclick="document.title='link'">Lnk</a>
    <input aria-label="Поле" onkeydown="document.title='key'">
  </body>`;
  const navLog = path.join(dir, 'nav.jsonl');
  for (const [dryRunNavigation, label] of [[false, 'по умолчанию'], [true, 'с dryRunNavigation']]) {
    await page.setContent(TABS);
    const hn = hands(page, { dryRun: true, dryRunNavigation, logFile: navLog });
    const t0 = await hn.see();
    const by = (n) => t0.elements.find((e) => e.name === n).id;
    for (const n of ['Btn', 'Lnk']) assert.deepEqual(await hn.act({ cmd: 'click', id: by(n), gen: t0.gen }), { dryRun: true, changed: false });
    assert.deepEqual(await hn.act({ cmd: 'fill', id: by('Поле'), gen: t0.gen, text: 'x' }), { dryRun: true, changed: false });
    assert.deepEqual(await hn.act({ cmd: 'press', key: 'Enter' }), { dryRun: true, changed: false });
    assert.equal(await page.title(), '', `${label}: dryRun выполнил запись`);
    const tab = await hn.act({ cmd: 'click', id: by('Messages'), gen: t0.gen });
    if (dryRunNavigation) {
      assert.equal(tab.dryRun, undefined);
      assert.equal(await page.title(), 'tab', 'клик по tab не выполнен');
    } else {
      assert.deepEqual(tab, { dryRun: true, changed: false });
      assert.equal(await page.title(), '', 'без опции tab кликнут');
    }
  }
  const navLines = fs.readFileSync(navLog, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(navLines.some((l) => l.cmd.cmd === 'click' && l.result === 'ok' && l.dryRun === true), 'клик по tab должен быть в журнале как ok');
  assert.equal(navLines.filter((l) => l.result === 'dry-run').length, 9);

  // scroll с id/gen: колесо над прокруткой элемента двигает её (окно не двигается), даже если элемент обрезан краем панели;
  // dryRunNavigation выполняет scroll (только вид), без опции он остаётся в журнале.
  rejects({ cmd: 'scroll', px: 300, id: 1 });
  validate({ cmd: 'scroll', px: 300, id: 1, gen: 1 });
  const PANEL = `<body style="margin:0"><div id="p" style="height:190px;width:300px;overflow-y:auto">
    ${Array.from({ length: 40 }, (_, i) => `<a href="#c${i}" style="display:block;height:40px">Chat ${i}</a>`).join('')}
  </div></body>`;
  for (const dryRunNavigation of [false, true]) {
    await page.setContent(PANEL);
    const hs = hands(page, { dryRun: true, dryRunNavigation });
    const s0 = await hs.see();
    const res = await hs.act({ cmd: 'scroll', px: 600, id: s0.elements.find((e) => e.name === 'Chat 4').id, gen: s0.gen }); // видна на 30 из 40 px
    const top = await page.evaluate(() => document.getElementById('p').scrollTop);
    if (dryRunNavigation) {
      assert.equal(res.dryRun, undefined);
      assert.ok(top > 0, 'scroll над списком не сдвинул вложенную прокрутку');
    } else {
      assert.deepEqual(res, { dryRun: true, changed: false });
      assert.equal(top, 0, 'dryRun без dryRunNavigation прокрутил');
    }
  }
  await page.setContent(PANEL);
  const hst = hands(page, { dryRun: true, dryRunNavigation: true });
  const st0 = await hst.see();
  await hst.see(); // новый gen: старый id устарел
  await assert.rejects(hst.act({ cmd: 'scroll', px: 600, id: st0.elements[0].id, gen: st0.gen }), StaleElement);

  // Оверлей появился, пока мышь шла к tab: клик по координатам попал бы в него. Клика нет, StaleElement.
  await page.setContent(TABS);
  const ho = hands(page, { dryRun: true, dryRunNavigation: true });
  const o0 = await ho.see();
  await page.evaluate(() => {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;inset:0;background:#0001';
    d.onclick = () => { document.title = 'overlay'; };
    document.body.append(d);
  });
  await assert.rejects(ho.act({ cmd: 'click', id: o0.elements.find((e) => e.name === 'Messages').id, gen: o0.gen }), StaleElement);
  assert.equal(await page.title(), '', 'клик ушёл в оверлей');

  // Вкладка в DOM или в open shadow; кнопка «закрыть» внутри неё занимает всю площадь, поэтому клик в любую точку вкладки попадает в кнопку.
  const CLOSE = '<button aria-label="Закрыть" style="display:block;box-sizing:border-box;margin:0;width:100%;height:40px">×</button>';
  const clickTab = async (html, shadow) => {
    await page.setContent('<body style="margin:0"><div id="h"></div></body>');
    await page.evaluate(([inner, sh]) => {
      const host = document.getElementById('h');
      const root = sh ? host.attachShadow({ mode: 'open' }) : host;
      root.innerHTML = inner;
      root.querySelector('[role=tab]').addEventListener('click', () => { document.title += 'tab'; });
      root.querySelector('button')?.addEventListener('click', () => { document.title += 'close'; });
    }, [html, shadow]);
    const hx = hands(page, { dryRun: true, dryRunNavigation: true });
    const x0 = await hx.see();
    return hx.act({ cmd: 'click', id: x0.elements.find((e) => e.role === 'tab').id, gen: x0.gen });
  };
  // Вложенный интерактивный элемент вкладки: dryRun его не нажимает.
  await assert.rejects(clickTab(`<div role="tab" aria-label="Messages">${CLOSE}</div>`, false), StaleElement);
  assert.equal(await page.title(), '', 'dryRun нажал кнопку внутри tab');
  // Shadow DOM: elementFromPoint отдаёт хост, проверка спускается в открытый корень; клик по tab проходит.
  assert.equal((await clickTab('<div role="tab" style="padding:20px">Messages</div>', true)).dryRun, undefined);
  assert.equal(await page.title(), 'tab', 'tab в shadow не кликнут');
  await assert.rejects(clickTab(`<div role="tab" aria-label="Messages">${CLOSE}</div>`, true), StaleElement);
  assert.equal(await page.title(), '', 'dryRun нажал кнопку внутри tab в shadow');

  // Вкладка внутри ссылки, кнопки или метки: клик всплывёт к предку (переход, отправка формы, переключение поля).
  // Под курсором сама вкладка, поэтому проверка точки клика этого не видит; нужен подъём от вкладки вверх.
  const clickWrapped = async (label, html, shadow) => {
    await page.setContent(`<body style="margin:0">${html}</body>`);
    if (shadow) {
      await page.evaluate((inner) => {
        const root = document.getElementById('h').attachShadow({ mode: 'open' });
        root.innerHTML = inner;
        root.querySelector('button')?.addEventListener('click', () => { document.title += 'button'; });
      }, shadow);
    }
    const hx = hands(page, { dryRun: true, dryRunNavigation: true });
    const x0 = await hx.see();
    const tab = x0.elements.find((e) => e.role === 'tab');
    assert.ok(tab, `${label}: вкладки нет в снимке`);
    await assert.rejects(hx.act({ cmd: 'click', id: tab.id, gen: x0.gen }), StaleElement, `${label}: клик не отклонён`);
    const after = await page.evaluate(() => [document.title, location.hash, !!document.querySelector('input:checked')]);
    assert.deepEqual(after, ['', '', false], `${label}: dryRun выполнил запись`);
  };
  await clickWrapped('ссылка', `<a href="#go" onclick="document.title+='link'"><div role="tab" style="padding:20px">Messages</div></a>`);
  await clickWrapped('кнопка формы', `<form onsubmit="document.title+='submit';return false"><button style="padding:10px"><span role="tab">Messages</span></button></form>`);
  await clickWrapped('метка', `<label><input type="checkbox"><span role="tab" style="padding:10px">Messages</span></label>`);
  // Составное дерево: хост shadow-корня лежит в ссылке; вкладка из light DOM назначена слоту внутри кнопки.
  await clickWrapped('хост в ссылке', `<a href="#go" onclick="document.title+='link'"><div id="h"></div></a>`, '<div role="tab" style="padding:20px">Messages</div>');
  await clickWrapped('слот в кнопке', '<div id="h"><span role="tab">Messages</span></div>', '<button style="padding:10px"><slot></slot></button>');

  // see({ settle }): SPA рисует элементы через 2 с. Обычный see() видит пустоту, settle ждёт.
  const LATE = '<body><script>setTimeout(()=>{for(const n of ["A","B","C"]){const b=document.createElement("button");b.textContent=n;document.body.append(b)}},2000)</script></body>';
  await page.setContent(LATE);
  const hs = hands(page);
  assert.equal((await hs.see()).elements.length, 0, 'обычный see() должен вернуть как раньше');
  const ready = await hs.see({ settle: { minElements: 3, quietMs: 300, timeoutMs: 8000 } });
  assert.equal(ready.elements.length, 3, 'settle не дождался элементов');
  // Таймаут не бросает: отдаёт последний снимок.
  await page.setContent('<body>пусто</body>');
  const t1 = Date.now();
  const empty = await hs.see({ settle: { minElements: 3, timeoutMs: 600 } });
  assert.equal(empty.elements.length, 0);
  assert.ok(Date.now() - t1 < 3000, 'settle не уложился в таймаут');

  // timeoutMs ограничен сверху (MAX_WAIT 15 с): settle не обходит maxMinutes задачи.
  const t2 = Date.now();
  await hs.see({ settle: { minElements: 3, timeoutMs: 600000 } });
  const waited = Date.now() - t2;
  assert.ok(waited >= 14000 && waited < 20000, `settle без потолка: ${waited} мс`);

  // Живой режим: оверлей появился, пока мышь шла к цели. click и fill его не нажимают: StaleElement, клика нет.
  const FORM = `<body style="margin:0">
    <input id="a" aria-label="A" onkeydown="document.title+='a:'+event.key+';'">
    <input id="b" aria-label="B" onkeydown="document.title+='b:'+event.key+';'">
    <button onclick="document.title+='btn;'">Go</button>
  </body>`;
  const idOf = (s, n) => s.elements.find((e) => e.name === n).id;
  await page.setContent(FORM);
  const hl = hands(page);
  const l0 = await hl.see();
  await page.evaluate(() => {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;inset:0;background:#0001';
    d.onclick = () => { document.title += 'overlay;'; };
    document.body.append(d);
  });
  await assert.rejects(hl.act({ cmd: 'click', id: idOf(l0, 'Go'), gen: l0.gen }), StaleElement, 'живой click не проверил точку');
  await assert.rejects(hl.act({ cmd: 'fill', id: idOf(l0, 'A'), gen: l0.gen, text: 'x' }), StaleElement, 'живой fill не проверил точку');
  assert.equal(await page.title(), '', 'клик ушёл в оверлей');
  assert.equal(await page.inputValue('#a'), '');

  // press и type с id: фокус сверяется прямо перед клавишами. Ушёл (автофокус, тост) — StaleElement, нажатия нет.
  await page.setContent(FORM);
  const f0 = await hl.see();
  const f1 = await hl.act({ cmd: 'fill', id: idOf(f0, 'A'), gen: f0.gen, text: 'привет' });
  assert.equal(f1.elements.find((e) => e.name === 'A').focused, true);
  await page.evaluate(() => { document.title = ''; document.getElementById('b').focus(); });
  await assert.rejects(hl.act({ cmd: 'press', key: 'Enter', id: idOf(f1, 'A'), gen: f1.gen }), StaleElement, 'press ушёл в чужое поле');
  await assert.rejects(hl.act({ cmd: 'type', text: 'ещё', id: idOf(f1, 'A'), gen: f1.gen }), StaleElement, 'type ушёл в чужое поле');
  assert.equal(await page.title(), '', 'клавиши ушли в другое поле');
  assert.equal(await page.inputValue('#b'), '');
  // Фокус на месте — нажатие проходит; без id — как раньше, по текущему фокусу.
  await page.evaluate(() => document.getElementById('a').focus());
  const p1 = await hl.act({ cmd: 'press', key: 'Enter', id: idOf(f1, 'A'), gen: f1.gen });
  await hl.act({ cmd: 'type', text: '!', id: idOf(p1, 'A'), gen: p1.gen });
  await hl.act({ cmd: 'press', key: 'Escape' });
  assert.equal(await page.title(), 'a:Enter;a:Shift;a:!;a:Escape;'); // «!» — Shift+1, как на настоящей клавиатуре
  assert.equal(await page.inputValue('#a'), 'привет!');
  // Поле в open shadow: фокус ищется внутри корня (document.activeElement — это хост).
  await page.setContent('<body><div id="h"></div></body>');
  await page.evaluate(() => { document.getElementById('h').attachShadow({ mode: 'open' }).innerHTML = '<input aria-label="S" onkeydown="document.title+=\'s:\'+event.key+\';\'">'; });
  const sh0 = await hl.see();
  const sh1 = await hl.act({ cmd: 'fill', id: idOf(sh0, 'S'), gen: sh0.gen, text: 'да' });
  await page.evaluate(() => { document.title = ''; });
  await hl.act({ cmd: 'press', key: 'Enter', id: idOf(sh1, 'S'), gen: sh1.gen });
  assert.equal(await page.title(), 's:Enter;', 'поле в shadow не признано сфокусированным');

  // fill и type сверяют поле с заказанным текстом, а press Enter — ещё раз прямо перед клавишей (FieldMismatch).
  // Случай из зеркала 08.11: хозяин печатал, пока печатал бот, буквы перемешались («ooпooенoрвая задача»), и Enter
  // отправил бы это живому человеку. В сообщении и полях ошибки только длины: тексты — личные сообщения, а ошибка
  // уходит в журнал и в notify. «Хозяин» здесь — insertText теста посреди печати бота, в ту же страницу.
  {
    human.usePersona({ speed: 1.4, tremor: 0.5, twitch: 0.1, wpm: 150, typoRate: 0 }); // быстро и без опечаток: длины точные
    const CHAT = `<body style="margin:0">
      <textarea id="m" aria-label="Чат"></textarea>
      <div id="ce" contenteditable="true" aria-label="Редактор" style="min-height:30px;border:1px solid"></div>
      <input id="o" aria-label="Другое" value="чужой текст">
      <script>window.keys = []; addEventListener('keydown', (e) => keys.push(e.key), true);</script>
    </body>`;
    const SECRET = 'первая задача';
    const enters = () => page.evaluate(() => keys.filter((k) => k === 'Enter').length);
    const valueOf = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return e.isContentEditable ? e.innerText : e.value; }, sel);
    const private_ = (e) => {
      for (const part of [SECRET, ...SECRET.split(' '), 'oo']) assert.ok(!e.message.includes(part), `в сообщении FieldMismatch текст поля: ${e.message}`);
      assert.deepEqual(Object.keys(e).sort(), ['actualLength', 'cmd', 'diffAt', 'expectedLength', 'id', 'reason', ...(e.before ? ['before'] : [])].sort());
    };
    // «Хозяин» вставляет свои буквы, когда бот набрал не меньше трёх (в поле было from знаков).
    const interleave = async (sel, run, from = 0, extra = 'oo') => {
      const pending = run.then(() => null, (e) => e);
      while ((await valueOf(sel)).length < from + 3) await sleep(10);
      await page.keyboard.insertText(extra);
      return pending;
    };
    const hm = hands(page);

    // Чистый fill проходит, Enter после него нажимается (ровно один).
    await page.setContent(CHAT);
    const c0 = await hm.see();
    const c1 = await hm.act({ cmd: 'fill', id: idOf(c0, 'Чат'), gen: c0.gen, text: SECRET });
    assert.equal(c1.elements.find((e) => e.name === 'Чат').value, SECRET);
    await hm.act({ cmd: 'press', key: 'Enter', id: idOf(c1, 'Чат'), gen: c1.gen });
    assert.equal(await enters(), 1, 'Enter после чистого fill не нажат');

    // Буквы вклинились посреди fill: FieldMismatch (команда шла — before нет), и Enter в это поле не нажимается ни с id,
    // ни без него (по фокусу).
    await page.setContent(CHAT);
    const m0 = await hm.see();
    const err = await interleave('#m', hm.act({ cmd: 'fill', id: idOf(m0, 'Чат'), gen: m0.gen, text: SECRET }));
    assert.ok(err instanceof FieldMismatch, `fill не заметил чужие буквы: ${err}`);
    assert.equal(err.cmd, 'fill');
    assert.equal(err.id, idOf(m0, 'Чат'));
    assert.equal(err.expectedLength, SECRET.length);
    assert.equal(err.actualLength, SECRET.length + 2);
    assert.equal(err.actualLength, (await valueOf('#m')).length);
    assert.ok(err.diffAt >= 3 && err.diffAt < SECRET.length, `diffAt ${err.diffAt}`);
    assert.equal(err.before, undefined, 'fill выполнялся: before не ставится');
    assert.equal(err.reason, 'text');
    private_(err);
    const m1 = await hm.see();
    const pe = await hm.act({ cmd: 'press', key: 'Enter', id: idOf(m1, 'Чат'), gen: m1.gen }).then(() => null, (e) => e);
    assert.ok(pe instanceof FieldMismatch && pe.before === true && pe.cmd === 'press', `Enter не остановлен: ${pe}`);
    private_(pe);
    await assert.rejects(hm.act({ cmd: 'press', key: 'Enter' }), (e) => e instanceof FieldMismatch && e.before === true, 'Enter без id ушёл в поле с чужими буквами');
    assert.equal(await enters(), 0, 'Enter дошёл до страницы');
    // В журнал ошибка уходит тем же сообщением — без текста.
    const jl = path.join(dir, 'mismatch.jsonl');
    const hj = hands(page, { logFile: jl });
    const j0 = await hj.see();
    await assert.rejects(hj.act({ cmd: 'press', key: 'Enter', id: idOf(j0, 'Чат'), gen: j0.gen }), FieldMismatch);
    const jtext = fs.readFileSync(jl, 'utf8');
    assert.ok(/не тот текст/.test(jtext) && !/первая|задача|oo/.test(jtext), jtext);

    // Поле поменялось между fill и Enter (хозяин дописал в зеркале): FieldMismatch до клавиши; вернули как было — Enter идёт.
    await page.setContent(CHAT);
    const v0 = await hm.see();
    const v1 = await hm.act({ cmd: 'fill', id: idOf(v0, 'Чат'), gen: v0.gen, text: SECRET });
    await page.evaluate(() => { document.getElementById('m').value += ' ой'; });
    await assert.rejects(hm.act({ cmd: 'press', key: 'Enter', id: idOf(v1, 'Чат'), gen: v1.gen }), (e) => e instanceof FieldMismatch && e.before === true);
    assert.equal(await enters(), 0, 'Enter ушёл в изменённое поле');
    await page.evaluate((t) => { document.getElementById('m').value = t; }, SECRET);
    await hm.act({ cmd: 'press', key: 'Enter', id: idOf(v1, 'Чат'), gen: v1.gen });
    assert.equal(await enters(), 1);

    // contenteditable (поле чата в Telegram Web): то же — чистый fill, буквы посреди fill, правка до Enter.
    await page.setContent(CHAT);
    const e0 = await hm.see();
    const e1 = await hm.act({ cmd: 'fill', id: idOf(e0, 'Редактор'), gen: e0.gen, text: SECRET });
    assert.equal((await valueOf('#ce')).replace(/\u00a0/g, ' ').trim(), SECRET);
    await page.evaluate(() => { document.getElementById('ce').append(' ой'); });
    const e1b = await hm.see(); // содержимое редактора сменилось: прежний номер устарел (StaleElement), берём свежий
    await assert.rejects(hm.act({ cmd: 'press', key: 'Enter', id: idOf(e1b, 'Редактор'), gen: e1b.gen }), (e) => e instanceof FieldMismatch && e.before === true);
    await page.setContent(CHAT);
    const e2 = await hm.see();
    const ce = await interleave('#ce', hm.act({ cmd: 'fill', id: idOf(e2, 'Редактор'), gen: e2.gen, text: SECRET }));
    assert.ok(ce instanceof FieldMismatch && ce.actualLength === SECRET.length + 2, `contenteditable: ${ce}`);
    assert.equal(await enters(), 0);

    // type сверяет: в поле должно стать «что было + text» (с места курсора). Буквы посреди type — FieldMismatch.
    await page.setContent(CHAT);
    const t0 = await hm.see();
    const t1 = await hm.act({ cmd: 'fill', id: idOf(t0, 'Чат'), gen: t0.gen, text: 'да' });
    const t2 = await hm.act({ cmd: 'type', text: ', ' + SECRET, id: idOf(t1, 'Чат'), gen: t1.gen });
    assert.equal(t2.elements.find((e) => e.name === 'Чат').value, 'да, ' + SECRET);
    const te = await interleave('#m', hm.act({ cmd: 'type', text: ' и ' + SECRET, id: idOf(t2, 'Чат'), gen: t2.gen }), ('да, ' + SECRET).length);
    assert.ok(te instanceof FieldMismatch && te.cmd === 'type' && te.before === undefined, `type не заметил чужие буквы: ${te}`);
    private_(te);
    await assert.rejects(hm.act({ cmd: 'press', key: 'Enter' }), FieldMismatch);
    assert.equal(await enters(), 0);
    // Дописать в поле, где после бота стало другое: FieldMismatch до первой клавиши (иначе чужие буквы ушли бы с Enter).
    await page.setContent(CHAT);
    const u0 = await hm.see();
    const u1 = await hm.act({ cmd: 'fill', id: idOf(u0, 'Чат'), gen: u0.gen, text: 'да' });
    await page.evaluate(() => { document.getElementById('m').value += 'oo'; });
    await assert.rejects(hm.act({ cmd: 'type', text: ' нет', id: idOf(u1, 'Чат'), gen: u1.gen }), (e) => e instanceof FieldMismatch && e.before === true);
    assert.equal(await page.inputValue('#m'), 'даoo', 'type дописал в поле с чужими буквами');

    // Своя клавиша бота (Backspace) в поле, куда он печатал, — не «чужие буквы»: Enter после неё идёт.
    await page.setContent(CHAT);
    const b0 = await hm.see();
    const b1 = await hm.act({ cmd: 'fill', id: idOf(b0, 'Чат'), gen: b0.gen, text: 'да!' });
    const b2 = await hm.act({ cmd: 'press', key: 'Backspace', id: idOf(b1, 'Чат'), gen: b1.gen });
    await hm.act({ cmd: 'press', key: 'Enter', id: idOf(b2, 'Чат'), gen: b2.gen });
    assert.equal(await enters(), 1, 'Enter после своего Backspace не нажат');
    // А если чужие буквы были до Backspace — Enter всё равно нет.
    await page.setContent(CHAT);
    const x0 = await hm.see();
    const x1 = await hm.act({ cmd: 'fill', id: idOf(x0, 'Чат'), gen: x0.gen, text: 'да' });
    await page.evaluate(() => { document.getElementById('m').value += 'oo'; });
    const x2 = await hm.act({ cmd: 'press', key: 'Backspace', id: idOf(x1, 'Чат'), gen: x1.gen });
    await assert.rejects(hm.act({ cmd: 'press', key: 'Enter', id: idOf(x2, 'Чат'), gen: x2.gen }), FieldMismatch, 'Backspace «отмыл» чужие буквы');
    assert.equal(await enters(), 0);

    // Поля, которые сами меняют ввод. Маска телефона (type=tel, префикс +7 ставит сама, цифры — в шаблон): по умолчанию
    // сверяются цифры — цифры поля = цифры текста (или префикс поля после очистки + цифры текста). Не те цифры — ошибка
    // (reason 'digits'): «+77012345678» в маску с готовым +7 даёт «+7 (770) 123-45-67». Буквы хозяина в такое поле —
    // тоже ошибка. maxlength — reason 'maxlength'. Код из ячеек с автопереходом фокуса: ячейки вместе = текст —
    // принято. verify: false — не сверять и не помнить (Enter в это поле не сверяется); verify: 'exact' — без поблажек.
    const MASKED = `<body style="margin:0">
      <input id="tel" type="tel" aria-label="Телефон" style="width:300px">
      <input id="ml" aria-label="Короткое" maxlength="5">
      <input id="up" aria-label="Заглавные" oninput="this.value=this.value.toUpperCase()">
      <div id="otp">${[1, 2, 3, 4, 5, 6].map((n) => `<input class="c" inputmode="numeric" maxlength="1" aria-label="Цифра ${n}" style="width:30px">`).join('')}</div>
      <script>(() => { // setContent не меняет window: без обёртки второй раз const упал бы, и маски не было бы
        window.keys = []; addEventListener('keydown', (e) => keys.push(e.key), true);
        const tel = document.getElementById('tel');
        const fmt = () => {
          let d = tel.value.replace(/\\D/g, '');
          if (tel.value.startsWith('+7')) d = d.slice(1);
          d = d.slice(0, 10);
          const p = [d.slice(0, 3), d.slice(3, 6), d.slice(6, 8), d.slice(8, 10)];
          tel.value = '+7 ' + (d ? '(' + p[0] + (d.length > 3 ? ') ' + p[1] : '') + (d.length > 6 ? '-' + p[2] : '') + (d.length > 8 ? '-' + p[3] : '') : '');
        };
        tel.addEventListener('focus', () => { if (!tel.value) tel.value = '+7 '; });
        tel.addEventListener('input', fmt);
        const cells = [...document.querySelectorAll('.c')];
        cells.forEach((c, i) => c.addEventListener('input', () => { if (c.value && cells[i + 1]) cells[i + 1].focus(); }));
      })();</script>
    </body>`;
    const reasonOf = (p) => p.then(() => null, (e) => e);
    await page.setContent(MASKED);
    const k0 = await hm.see();
    const k1 = await hm.act({ cmd: 'fill', id: idOf(k0, 'Телефон'), gen: k0.gen, text: '7012345678' });
    assert.equal(await page.inputValue('#tel'), '+7 (701) 234-56-78');
    await hm.act({ cmd: 'press', key: 'Enter', id: idOf(k1, 'Телефон'), gen: k1.gen });
    assert.equal(await enters(), 1, 'Enter в принятое по цифрам поле не нажат');
    const k3 = await hm.see();
    const wrong = await reasonOf(hm.act({ cmd: 'fill', id: idOf(k3, 'Телефон'), gen: k3.gen, text: '+77012345678' }));
    assert.ok(wrong instanceof FieldMismatch && wrong.reason === 'digits', `не те цифры в маске приняты: ${wrong}`);
    private_(wrong);
    const k4 = await hm.see();
    await assert.rejects(hm.act({ cmd: 'press', key: 'Enter', id: idOf(k4, 'Телефон'), gen: k4.gen }), FieldMismatch, 'Enter после не тех цифр');
    const k5 = await hm.see();
    const exact = await reasonOf(hm.act({ cmd: 'fill', id: idOf(k5, 'Телефон'), gen: k5.gen, text: '7012345678', verify: 'exact' }));
    assert.ok(exact instanceof FieldMismatch && exact.reason === 'text', `verify: 'exact' сверил по цифрам: ${exact}`);
    await page.setContent(MASKED); // поле пустое: «хозяин» вклинивается, когда бот уже набрал часть номера
    const k6 = await hm.see();
    // Цифры хозяина посреди ввода в маску (буквы маска сама выбросит) — цифры уже не те.
    const owner = await interleave('#tel', hm.act({ cmd: 'fill', id: idOf(k6, 'Телефон'), gen: k6.gen, text: '7012345678' }), 7, '55');
    assert.ok(owner instanceof FieldMismatch && owner.reason === 'digits', `цифры хозяина в поле с маской приняты: ${owner}`);
    // maxlength: текст не поместился — reason 'maxlength'.
    const m2 = await hm.see();
    const ml = await reasonOf(hm.act({ cmd: 'fill', id: idOf(m2, 'Короткое'), gen: m2.gen, text: '1234567' }));
    assert.ok(ml instanceof FieldMismatch && ml.reason === 'maxlength' && ml.expectedLength === 7 && ml.actualLength === 5, `maxlength: ${ml}`);
    assert.match(ml.message, /maxlength 5/);
    // Ячейки кода с автопереходом: fill в первую, фокус уходит дальше, вместе ячейки дают код — принято.
    const o0 = await hm.see();
    await hm.act({ cmd: 'fill', id: idOf(o0, 'Цифра 1'), gen: o0.gen, text: '123456' });
    assert.deepEqual(await page.$$eval('.c', (cs) => cs.map((c) => c.value).join('')), '123456');
    // Страница меняет ввод сама (заглавные): по умолчанию — ошибка; verify: false — нет, и Enter в это поле не сверяется.
    const q0 = await hm.see();
    const up = await reasonOf(hm.act({ cmd: 'fill', id: idOf(q0, 'Заглавные'), gen: q0.gen, text: 'abc' }));
    assert.ok(up instanceof FieldMismatch && up.reason === 'text', String(up));
    const q1 = await hm.see();
    const q2 = await hm.act({ cmd: 'fill', id: idOf(q1, 'Заглавные'), gen: q1.gen, text: 'abc', verify: false });
    await hm.act({ cmd: 'press', key: 'Enter', id: idOf(q2, 'Заглавные'), gen: q2.gen });
    assert.equal(await enters(), 1, 'verify: false — Enter всё равно сверялся'); // счёт с последней загрузки страницы
    rejects({ cmd: 'fill', id: 1, gen: 1, text: 'x', verify: 'loose' });
    rejects({ cmd: 'fill', id: 1, gen: 1, text: 'x', verify: true });
    validate({ cmd: 'fill', id: 1, gen: 1, text: 'x', verify: false });
    validate({ cmd: 'type', text: 'x', verify: 'digits' });

    // fill сверяет фокус перед Ctrl+A и Backspace: страница увела фокус в другое поле — StaleElement, чужое поле цело.
    await page.setContent('<body style="margin:0"><input id="a" aria-label="A" onfocus="document.getElementById(\'o\').focus()"><input id="o" aria-label="Другое" value="чужой текст"></body>');
    const g0 = await hm.see();
    await assert.rejects(hm.act({ cmd: 'fill', id: idOf(g0, 'A'), gen: g0.gen, text: 'x' }), StaleElement, 'fill стёр бы чужое поле');
    assert.equal(await page.inputValue('#o'), 'чужой текст', 'Ctrl+A и Backspace ушли в чужое поле');
    human.usePersona(null);
  }

  // Живые руки.
  await page.setContent(HTML);
  const h = hands(page, { logFile, recordDir });
  const s0 = await h.see();
  const like = s0.elements.find((e) => e.name === 'Like');

  const r1 = await h.act({ cmd: 'click', id: like.id, gen: s0.gen });
  assert.equal(r1.changed, true);
  assert.ok(r1.removed.some((e) => e.name === 'Like'), 'кнопка должна исчезнуть');
  assert.ok(r1.text.includes('Лайк поставлен'));

  // Номера из прошлого снимка: StaleElement, а не клик по чужому элементу
  // (после клика нумерация сменилась, id 1 теперь другой элемент).
  await assert.rejects(h.act({ cmd: 'click', id: 1, gen: s0.gen }), StaleElement);

  // Новый снимок приходит в ответе act: r1.gen и r1.elements.
  const msg1 = r1.elements.find((e) => e.name === 'Сообщение');
  const send1 = r1.elements.find((e) => e.name === 'Send');
  const r2 = await h.act({ cmd: 'fill', id: msg1.id, gen: r1.gen, text: 'го в телегу' });
  assert.equal(await page.inputValue('#msg'), 'го в телегу', 'fill должен заменить старый текст');
  await h.act({ cmd: 'click', id: send1.id, gen: r2.gen });
  assert.equal(await page.title(), 'sent:го в телегу');

  // Журнал: dry-run, ok и ошибка.
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines[0].result, 'dry-run');
  assert.equal(lines[0].dryRun, true);
  assert.ok(lines.some((l) => l.result === 'ok' && l.cmd.cmd === 'fill'));
  assert.ok(lines.every((l) => l.ts && l.url));

  // Журнал не пишется (нет прав на файл в общем dir, диск полон): команда, которая уже выполнилась, не должна
  // выглядеть упавшей — вызывающий повторил бы её (второе сообщение, второй отклик). Ошибка команды остаётся своей,
  // а сбой журнала уходит в stderr.
  {
    await page.setContent(HTML);
    const brokenLog = path.join(dir, 'log-is-a-dir');
    fs.mkdirSync(brokenLog); // каталог вместо файла: appendFileSync бросает EISDIR
    const errs = [];
    const origErr = console.error;
    console.error = (...a) => errs.push(a.join(' '));
    try {
      const hb = hands(page, { logFile: brokenLog });
      const b0 = await hb.see();
      const rb = await hb.act({ cmd: 'click', id: b0.elements.find((e) => e.name === 'Like').id, gen: b0.gen });
      assert.ok(rb.removed.some((e) => e.name === 'Like'), 'клик выполнен, а act упал на журнале');
      await assert.rejects(hb.act({ cmd: 'click', id: 1, gen: b0.gen }), StaleElement, 'ошибку команды подменил сбой журнала');
      const hd = hands(page, { dryRun: true, logFile: brokenLog });
      const d1 = await hd.see();
      assert.deepEqual(await hd.act({ cmd: 'click', id: d1.elements[0].id, gen: d1.gen }), { dryRun: true, changed: false });
    } finally { console.error = origErr; }
    assert.ok(errs.some((m) => /журнал/.test(m)), 'сбой журнала должен уйти в stderr');
  }

  // Проверочный снимок (probe, guard перед командой в task) не трогает номера прошлого: мир с этим именем в документе
  // один, и probe не должен перепривязывать в нём id. Выше цели вставили кнопку — клик по старому id идёт в цель.
  {
    await page.setContent('<body style="margin:0"><div id="top"></div><button onclick="document.title=\'A\'">A</button></body>');
    const hp = hands(page);
    const p0 = await hp.see();
    await page.evaluate(() => { document.getElementById('top').innerHTML = '<button onclick="document.title=\'X\'">X</button>'; });
    await hp.probe();
    await hp.act({ cmd: 'click', id: p0.elements.find((e) => e.name === 'A').id, gen: p0.gen });
    assert.equal(await page.title(), 'A', 'после probe старый номер попал в другой элемент');
  }

  await browser.close();

  // Воспроизведение: тот же интерфейс, без браузера.
  const r = replay(recordDir);
  const rs0 = await r.see();
  assert.ok(rs0.elements.some((e) => e.name === 'Like'));
  await assert.rejects(r.act({ cmd: 'click', id: 999, gen: rs0.gen }), StaleElement);
  await assert.rejects(r.act({ cmd: 'click', id: like.id, gen: rs0.gen + 100 }), StaleElement);
  await assert.rejects(r.act({ cmd: 'eval' }), BadCommand);
  const rr = await r.act({ cmd: 'click', id: like.id, gen: rs0.gen });
  assert.ok(rr.removed.some((e) => e.name === 'Like'));
  const rr2 = await r.act({ cmd: 'fill', id: msg1.id, gen: rr.gen, text: 'x' });
  await r.act({ cmd: 'click', id: send1.id, gen: rr2.gen });
  await assert.rejects(r.act({ cmd: 'press', key: 'Enter' }), /запись закончилась/);

  console.log('hands.test: ok');
})().catch((e) => { console.error(e); process.exit(1); });
