/**
 * Формы на фальшивой странице: журнал без набранного текста, выбор в <select>.
 *
 *   node test/forms.test.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { hands, validate, BadCommand } = require('../hands.js');

const FORM = `<body style="margin:0">
  <input aria-label="Имя">
  <textarea aria-label="Письмо" style="width:400px;height:120px"></textarea>
</body>`;

// Список стран: «Россия» недоступна; события пишутся в заголовок вместе с isTrusted.
const CITIES = Array.from({ length: 60 }, (_, i) => `<option>Город ${i + 1}</option>`).join('');
const SELECTS = `<body style="margin:0">
  <label for="c">Страна</label>
  <select id="c" onchange="document.title += 'change:' + this.value + ':' + event.isTrusted + ';'">
    <option value="">— выберите —</option><option value="kz">Казахстан</option><option value="ru" disabled>Россия</option>
    <option value="us">United States</option><option value="uz">Узбекистан</option>
  </select>
  <select id="far" aria-label="Город" onchange="window.changes = (window.changes || 0) + 1">${CITIES}<option value="ala">Алматы</option></select>
  <select id="many" multiple aria-label="Языки"><option>RU</option><option>EN</option></select>
  <input aria-label="Имя">
</body>`;

const readLog = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').map(JSON.parse);
const rejects = (c) => assert.throws(() => validate(c), BadCommand, JSON.stringify(c));
const idOf = (s, name) => s.elements.find((e) => e.name === name).id;

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meatsuit-forms-'));
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.route('https://example.test/**', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: FORM }));

  // --- Журнал: что сделано и где, но не что набрано. Текст — длиной, адреса — без query и hash.
  const SECRET = 'Тайное слово 7Q';
  const logFile = path.join(tmp, 'journal.jsonl');
  const h = hands(page, { logFile, allowedHosts: ['example.test'] });
  await h.act({ cmd: 'goto', url: 'https://example.test/form?token=Q-TOKEN-1#otp-frag' });
  const s0 = await h.see();
  const s1 = await h.act({ cmd: 'fill', id: idOf(s0, 'Имя'), gen: s0.gen, text: SECRET });
  assert.equal(await page.inputValue('input'), SECRET);
  await h.act({ cmd: 'type', text: ' ещё', id: idOf(s1, 'Имя'), gen: s1.gen });
  // Ошибка Playwright цитирует искомый текст: в журнал он не попадает.
  await assert.rejects(h.act({ cmd: 'wait', text: SECRET + ' нет на странице' }));
  const dry = hands(page, { dryRun: true, logFile });
  const d0 = await dry.see();
  await dry.act({ cmd: 'fill', id: idOf(d0, 'Письмо'), gen: d0.gen, text: SECRET });

  const raw = fs.readFileSync(logFile, 'utf8');
  for (const leak of ['Тайное', '7Q', 'ещё', 'Q-TOKEN-1', 'token=', 'otp-frag']) assert.ok(!raw.includes(leak), `в журнале «${leak}»: ${raw}`);
  const lines = readLog(logFile);
  const fill = lines.find((l) => l.cmd.cmd === 'fill' && l.result === 'ok');
  assert.deepEqual(fill.cmd, { cmd: 'fill', id: idOf(s0, 'Имя'), gen: s0.gen, textLength: SECRET.length });
  assert.equal(lines.find((l) => l.cmd.cmd === 'type').cmd.textLength, ' ещё'.length);
  assert.deepEqual(lines.find((l) => l.cmd.cmd === 'goto').cmd, { cmd: 'goto', url: 'https://example.test/form' });
  assert.equal(lines.find((l) => l.cmd.cmd === 'goto').urlAfter, 'https://example.test/form');
  assert.ok(lines.find((l) => l.cmd.cmd === 'wait').error, 'ошибка wait должна быть в журнале');
  assert.equal(lines.find((l) => l.result === 'dry-run').cmd.textLength, SECRET.length);
  assert.ok(lines.every((l) => l.ts && l.url), 'у каждой строки время и адрес');

  // --- select: закрытый набор полей; value — атрибут варианта, label — подпись (как в снимке).
  rejects({ cmd: 'select', id: 1, gen: 1 });
  rejects({ cmd: 'select', id: 1, gen: 1, value: 'kz', label: 'Казахстан' });
  rejects({ cmd: 'select', id: 1, gen: 1, label: '' });
  rejects({ cmd: 'select', id: 1, gen: 1, label: 'x'.repeat(201) });
  rejects({ cmd: 'select', id: 1, gen: 1, value: 7 });
  rejects({ cmd: 'select', gen: 1, label: 'x' });
  validate({ cmd: 'select', id: 1, gen: 1, value: '' }); // пустой value — законный вариант «не выбрано»
  validate({ cmd: 'select', id: 1, gen: 1, label: 'Казахстан' });

  await page.setContent(SELECTS);
  const sel = hands(page, { logFile });
  const c0 = await sel.see();
  const country = c0.elements.find((e) => e.name === 'Страна');
  assert.equal(country.role, 'select');
  assert.equal(country.value, '— выберите —', 'value списка — подпись выбранного варианта');
  assert.deepEqual(country.options, ['— выберите —', 'Казахстан', 'Россия', 'United States', 'Узбекистан']);
  assert.ok(!('optionsTotal' in country));

  // По подписи: стрелками с клавиатуры, события настоящие (isTrusted), вариант на месте и виден в снимке.
  const c1 = await sel.act({ cmd: 'select', id: country.id, gen: c0.gen, label: 'Казахстан' });
  assert.equal(await page.inputValue('#c'), 'kz');
  assert.equal(await page.title(), 'change:kz:true;', 'выбор не настоящими событиями');
  assert.equal(c1.elements.find((e) => e.name === 'Страна').value, 'Казахстан');
  // По value, через недоступный вариант: стрелка его перепрыгивает, лишних нажатий нет.
  await page.evaluate(() => { document.title = ''; });
  const c2 = await sel.act({ cmd: 'select', id: idOf(c1, 'Страна'), gen: c1.gen, value: 'us' });
  assert.equal(await page.inputValue('#c'), 'us');
  assert.ok((await page.title()).endsWith('change:us:true;'), await page.title());
  // Подпись без учёта регистра и лишних пробелов.
  const c3 = await sel.act({ cmd: 'select', id: idOf(c2, 'Страна'), gen: c2.gen, label: '  узбекистан ' });
  assert.equal(await page.inputValue('#c'), 'uz');

  // Отказы до любого действия: недоступный и несуществующий вариант, не список, список с выбором нескольких, fill по списку.
  await page.evaluate(() => { document.title = ''; });
  const bad = async (c, re) => assert.rejects(sel.act(c), (e) => e instanceof BadCommand && re.test(e.message), JSON.stringify(c));
  await bad({ cmd: 'select', id: idOf(c3, 'Страна'), gen: c3.gen, label: 'Россия' }, /недоступен/);
  await bad({ cmd: 'select', id: idOf(c3, 'Страна'), gen: c3.gen, label: 'Атлантида' }, /нет такого варианта/);
  await bad({ cmd: 'select', id: idOf(c3, 'Имя'), gen: c3.gen, label: 'Казахстан' }, /не список/);
  await bad({ cmd: 'select', id: idOf(c3, 'Языки'), gen: c3.gen, label: 'EN' }, /нескольких/);
  await bad({ cmd: 'fill', id: idOf(c3, 'Страна'), gen: c3.gen, text: 'Казахстан' }, /select/);
  assert.equal(await page.inputValue('#c'), 'uz');
  assert.equal(await page.title(), '', 'отказ что-то выбрал');

  // Далёкий вариант (61-й): не 60 нажатий стрелки, а первые буквы подписи, как человек; итог верный.
  const f0 = await sel.see();
  const city = f0.elements.find((e) => e.name === 'Город');
  assert.equal(city.options.length, 61);
  const t0 = Date.now();
  const f1 = await sel.act({ cmd: 'select', id: city.id, gen: f0.gen, label: 'Алматы' });
  assert.equal(await page.inputValue('#far'), 'ala');
  assert.equal(f1.elements.find((e) => e.name === 'Город').value, 'Алматы');
  assert.ok(Date.now() - t0 < 25000, `далёкий вариант выбирался ${Date.now() - t0} мс`);
  assert.ok(await page.evaluate(() => window.changes) >= 1);

  // Больше 100 вариантов: в снимке первые 100 и общее число.
  await page.setContent(`<select aria-label="Много">${Array.from({ length: 130 }, (_, i) => `<option>v${i}</option>`).join('')}</select>`);
  const m0 = await sel.see();
  assert.equal(m0.elements[0].options.length, 100);
  assert.equal(m0.elements[0].optionsTotal, 130);

  // dryRun: не выбирает, в журнале длина подписи.
  await page.setContent(SELECTS);
  const dsel = hands(page, { dryRun: true, logFile });
  const ds = await dsel.see();
  assert.deepEqual(await dsel.act({ cmd: 'select', id: idOf(ds, 'Страна'), gen: ds.gen, label: 'Казахстан' }), { dryRun: true, changed: false });
  assert.equal(await page.inputValue('#c'), '');
  const selLines = readLog(logFile).filter((l) => l.cmd.cmd === 'select');
  assert.ok(selLines.some((l) => l.result === 'dry-run' && l.cmd.labelLength === 'Казахстан'.length));
  assert.ok(selLines.some((l) => l.result === 'ok' && l.cmd.valueLength === 2));
  assert.ok(!fs.readFileSync(logFile, 'utf8').includes('Казахстан'), 'подпись варианта попала в журнал');

  await browser.close();
  console.log('forms.test: ok');
})().catch((e) => { console.error(e); process.exit(1); });
