/**
 * Ручное сохранение экранов: вкладки пользователя, дедуп по структуре, санитизация,
 * режим без браузера.
 *
 *   node test/save-tab.test.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { saveTabs, sanitizeFiles } = require('../tools/save-tab.js');

const PORT = 9336;
const PAGES = {
  'https://example.test/app/matches': '<a href="/app/messages/abc123">Анна</a><a href="/app/messages/def456">Белла</a><script>window.T="СЕКРЕТ-СКРИПТ"</script><input type="email" value="me@example.com">',
  'https://example.test/app/messages/abc123': '<textarea placeholder="Type a message"></textarea><button>Send</button>',
  'https://other.test/x': '<button>Чужой сайт</button>',
};

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meatsuit-save-'));
  const ctx = await chromium.launchPersistentContext(path.join(tmp, 'profile'), { headless: true, args: [`--remote-debugging-port=${PORT}`] });
  await ctx.route('**/*', (r) => {
    const body = PAGES[r.request().url().replace(/\?.*$/, '')];
    return body ? r.fulfill({ contentType: 'text/html', body }) : r.fulfill({ status: 404, body: 'no' });
  });
  const open = async (url) => { const p = await ctx.newPage(); await p.goto(url); return p; };
  const p1 = await open('https://example.test/app/matches');
  await open('https://example.test/app/messages/abc123');
  await open('https://other.test/x');
  const before = await p1.content();

  const dir = path.join(tmp, 'archive');
  const n = await saveTabs({ cdpUrl: `http://127.0.0.1:${PORT}`, dir, filter: 'example.test' });
  assert.equal(n, 2, 'две вкладки площадки; чужой сайт и about:blank пропущены');
  assert.equal(await p1.content(), before, 'вкладка пользователя не должна измениться');

  const day = fs.readdirSync(dir).find((f) => /^\d{4}-/.test(f));
  const files = fs.readdirSync(path.join(dir, day));
  assert.equal(files.filter((f) => f.endsWith('.json')).length, 2);
  const html = files.filter((f) => f.endsWith('.html')).map((f) => fs.readFileSync(path.join(dir, day, f), 'utf8')).join('\n');
  assert.ok(html.includes('/app/messages/abc123') && html.includes('Type a message'), 'HTML сохранён');
  assert.ok(!/СЕКРЕТ|me@example/.test(html), 'санитизация: ' + html);

  // Второй проход по тем же экранам ничего не добавляет (дедуп в рамках запуска).
  const again = await saveTabs({ cdpUrl: `http://127.0.0.1:${PORT}`, dir, filter: 'example.test' });
  assert.equal(again, 2, 'новый запуск — новая память; дубли HTML ограничены htmlPerSignature');
  const counts = JSON.parse(fs.readFileSync(path.join(dir, 'html-counts.json'), 'utf8'));
  assert.ok(Object.values(counts).every((c) => c <= 5));

  // watch: новый экран подхватывается, прежний нет; остановка по signal.
  const ac = new AbortController();
  const dir2 = path.join(tmp, 'archive2');
  const run = saveTabs({ cdpUrl: `http://127.0.0.1:${PORT}`, dir: dir2, filter: 'example.test', once: false, intervalMs: 150, signal: ac.signal });
  await new Promise((r) => setTimeout(r, 700));
  await p1.evaluate(() => { document.body.insertAdjacentHTML('beforeend', '<button>Новая кнопка</button>'); });
  await new Promise((r) => setTimeout(r, 700));
  ac.abort();
  assert.equal(await run, 3, 'два экрана сразу и один новый после изменения страницы');

  // Режим без браузера.
  const raw = path.join(tmp, 'saved.html');
  fs.writeFileSync(raw, '<html><script>var t="СЕКРЕТ-ФАЙЛ"</script><input type="password" value="pw"><p>ok</p></html>');
  const [out] = sanitizeFiles([raw], path.join(tmp, 'archive3'));
  const clean = fs.readFileSync(out, 'utf8');
  assert.ok(!/СЕКРЕТ|pw"/.test(clean) && clean.includes('<p>ok</p>'), clean);

  await ctx.close();
  console.log('save-tab.test: ok');
})().catch((e) => { console.error(e); process.exit(1); });
