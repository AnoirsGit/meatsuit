/**
 * tools/live-check.js (docs/acceptance.md) на настоящем Chromium с портом отладки, как у Neko. Страницы
 * площадки подставляет сам браузер (route), в сеть ничего не уходит.
 *
 *   node test/live-check.test.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright-core');
const { parseArgs, run, pages } = require('../tools/live-check.js');

const PORT = 9338;
const CDP = `http://127.0.0.1:${PORT}`;

(async () => {
  // Аргументы: обязательные --cdp и --dir, хост без схемы, путь входа с /; из командной строки — код 2.
  assert.throws(() => parseArgs(['--dir', '/x']), /--cdp/);
  assert.throws(() => parseArgs(['--cdp', CDP]), /--dir/);
  assert.throws(() => parseArgs(['--cdp', CDP, '--dir', '/x', '--site', 'https://example.com']), /имя хоста/);
  assert.throws(() => parseArgs(['--cdp', CDP, '--dir', '/x', '--login-path', 'login']), /начинается с \//);
  assert.throws(() => parseArgs(['--cdp', CDP, '--dir', '/x', '--token', 'y']), /неизвестный/);
  assert.deepEqual(parseArgs(['--cdp', CDP, '--dir', '/x']), { cdp: CDP, dir: '/x', site: 'example.com', loginPath: '/login' });
  const cli = spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'live-check.js')], { encoding: 'utf8' });
  assert.equal(cli.status, 2);
  assert.match(cli.stderr, /нужен --cdp/);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meatsuit-live-'));
  const ctx = await chromium.launchPersistentContext(path.join(tmp, 'profile'), { headless: true, args: [`--remote-debugging-port=${PORT}`] });
  try {
    const login = '<title>Sign in</title><form><input type="password" aria-label="Password"></form>';
    await ctx.route('https://example.com/**', (r) => {
      const body = new URL(r.request().url()).pathname === '/login' ? login : '<title>Example Domain</title><a href="/more">More information</a>';
      return r.fulfill({ contentType: 'text/html', body });
    });
    const mine = ctx.pages()[0] || (await ctx.newPage());
    await mine.setContent('<title>вкладка человека</title>');
    const state = path.join(tmp, 'state');

    // Всё в порядке: оба шага OK, окно задачи закрыто, окно входа оставлено, вкладка человека цела.
    const lines = [];
    assert.equal(await run({ cdp: CDP, dir: state, site: 'example.com', loginPath: '/login' }, (s) => lines.push(s)), 0, lines.join('\n'));
    assert.equal(lines.length, 4, lines.join('\n'));
    assert.ok(lines.every((l) => l.startsWith('OK  ')), lines.join('\n'));
    assert.match(lines[0], /https:\/\/example\.com\/ «Example Domain», элементов: 1/);
    assert.match(lines[2], /страница входа, https:\/\/example\.com\/login/);
    let open = await pages(CDP);
    assert.equal(open.length, 2, 'окно входа должно остаться');
    assert.ok(open.some((p) => p.url === 'https://example.com/login'));
    assert.ok(fs.existsSync(path.join(state, 'journal.jsonl')), 'журнал в общем dir');
    const left = ctx.pages().find((p) => p.url() === 'https://example.com/login');
    await left.close();

    // Страница входа не распознана (обычная страница вместо входа): FAIL и код 1, а не молчаливый успех.
    const bad = [];
    assert.equal(await run({ cdp: CDP, dir: state, site: 'example.com', loginPath: '/welcome' }, (s) => bad.push(s)), 1);
    assert.match(bad[2], /^FAIL страница входа остановила задачу/);
    assert.match(bad[3], /^FAIL окно после NeedsHuman/);
    open = await pages(CDP);
    assert.equal(open.length, 1, 'обычная dryRun-задача закрывает своё окно');
    assert.equal(await mine.title(), 'вкладка человека');
    console.log('live-check.test: ok');
  } finally {
    await ctx.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
