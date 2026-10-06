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
  rejects({ cmd: 'fill', id: 1, gen: 1, text: 'x'.repeat(1001) });
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

  // Живые руки.
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
