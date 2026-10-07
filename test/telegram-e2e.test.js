/**
 * Сквозная проверка уведомлений: настоящий Chromium, настоящая задача meatsuit,
 * настоящий HTTP до локального сервера, который изображает Telegram Bot API.
 * (Реальный Telegram здесь не нужен; проверка с живым ботом: `node tools/telegram-chats.js send`.)
 *
 *   node test/telegram-e2e.test.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { connect, createTelegram, NeedsHuman, LimitReached } = require('../index.js');

const PORT = 9335;
const TOKEN = '777:E2E-secret';
const GROUP = -1002233;
const THREAD = 5;

(async () => {
  // «Telegram»: принимает sendMessage, помнит всё, что пришло.
  const got = [];
  const api = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      got.push({ url: req.url, body: JSON.parse(raw) });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, result: { message_id: got.length } }));
    });
  });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  const apiBase = `http://127.0.0.1:${api.address().port}`;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meatsuit-tg-'));
  const sitesFile = path.join(tmp, 'sites.json');
  fs.writeFileSync(sitesFile, JSON.stringify({ 'example.test': { perDay: 100 }, 'closed.test': { perDay: 0 } }));
  const ctx = await chromium.launchPersistentContext(path.join(tmp, 'profile'), { headless: true, args: [`--remote-debugging-port=${PORT}`] });
  let html = '<button>Like</button>';
  ctx.on('page', (p) => { p.setContent(html).catch(() => {}); });

  const tg = createTelegram({ token: TOKEN, chatId: GROUP, threadId: THREAD, apiBase });
  const ms = await connect({
    cdpUrl: `http://127.0.0.1:${PORT}`, dir: path.join(tmp, 'state'), sitesFile,
    notifyOn: ['start', 'done', 'limit', 'error', 'needsHuman'],
    notify: (text) => tg.send(text),
  });

  // Успешная задача: «запущена» и «завершена».
  await ms.task('e2e:ok', async ({ see }) => { await see(); }, { site: 'example.test' });
  // Площадка закрыта: «не запущена».
  await assert.rejects(ms.task('e2e:closed', async () => {}, { site: 'closed.test' }), LimitReached);
  // Капча: «остановлен», окно остаётся человеку.
  html = '<p>Verify you are human</p>';
  await assert.rejects(ms.task('e2e:captcha', async ({ see }) => { await see(); }, { site: 'example.test' }), NeedsHuman);
  // Сбой в проекте.
  html = '<button>Like</button>';
  await assert.rejects(ms.task('e2e:boom', async () => { throw new Error('что-то сломалось'); }, { site: 'example.test' }), /сломалось/);

  const texts = got.map((g) => g.body.text);
  assert.equal(got.length, 7, 'ожидали start+done, limit, start+needsHuman, start+error:\n' + texts.join('\n'));
  assert.match(texts[0], /e2e:ok.*запущена/);
  assert.match(texts[1], /e2e:ok.*завершена.*команд: 0/);
  assert.match(texts[2], /e2e:closed.*не запущена.*perDay 0/);
  assert.match(texts[3], /e2e:captcha.*запущена/);
  assert.match(texts[4], /e2e:captcha.*остановлен.*капча/);
  assert.match(texts[5], /e2e:boom.*запущена/);
  assert.match(texts[6], /e2e:boom.*упала.*сломалось/);
  for (const g of got) {
    assert.equal(g.url, `/bot${TOKEN}/sendMessage`);
    assert.equal(g.body.chat_id, GROUP, 'не в ту группу');
    assert.equal(g.body.message_thread_id, THREAD, 'не в ту тему');
  }

  // Telegram лёг: задача не должна падать из-за уведомлений.
  api.close();
  api.closeAllConnections();
  const errs = [];
  const origErr = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  html = '<button>Like</button>';
  const res = await ms.task('e2e:no-telegram', async () => 'работа сделана', { site: 'example.test' });
  console.error = origErr;
  assert.equal(res, 'работа сделана');
  assert.ok(errs.some((e) => /не удалось отправить уведомление/.test(e) && !e.includes(TOKEN)), 'сбой отправки должен быть в stderr без токена: ' + errs.join(' | '));

  await ms.close();
  await ctx.close();
  console.log('telegram-e2e.test: ok');
})().catch((e) => { console.error(e); process.exit(1); });
