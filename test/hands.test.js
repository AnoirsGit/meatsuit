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
const { hands, replay, validate, BadCommand, StaleElement } = require('../hands.js');

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
