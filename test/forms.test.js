/**
 * Формы на фальшивой странице: журнал без набранного текста.
 *
 *   node test/forms.test.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { hands } = require('../hands.js');

const FORM = `<body style="margin:0">
  <input aria-label="Имя">
  <textarea aria-label="Письмо" style="width:400px;height:120px"></textarea>
</body>`;

const readLog = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').map(JSON.parse);
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

  await browser.close();
  console.log('forms.test: ok');
})().catch((e) => { console.error(e); process.exit(1); });
