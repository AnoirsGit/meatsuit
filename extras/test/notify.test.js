/**
 * Уведомление в Telegram через Bot API: без зависимостей, токен из env,
 * транспорт подставляется. Нет токена — только журнал; сбой не роняет сервис.
 *
 *   node --test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createNotifier, fromEnv, httpsTransport } = require('../notify.js');

const TOKEN = '123456:SECRET-token_abc';

function setup({ transport, cfg } = {}) {
  const sent = [], logs = [];
  const fake = transport || (async (req) => { sent.push(req); return { status: 200, body: JSON.stringify({ ok: true, result: {} }) }; });
  const notify = createNotifier({ token: TOKEN, chatId: '42', transport: fake, log: (e) => logs.push(e), ...cfg });
  return { notify, sent, logs };
}

test('отправляет sendMessage в Bot API: хост, путь с токеном, JSON с chat_id и текстом', async () => {
  const { notify, sent, logs } = setup();
  const r = await notify('капча на tinder.com');
  assert.deepEqual(r, { sent: true });
  assert.equal(sent.length, 1);
  const req = sent[0];
  assert.equal(req.hostname, 'api.telegram.org');
  assert.equal(req.method, 'POST');
  assert.equal(req.path, `/bot${TOKEN}/sendMessage`);
  assert.match(req.headers['content-type'], /application\/json/);
  assert.deepEqual(JSON.parse(req.body), { chat_id: '42', text: 'капча на tinder.com', disable_web_page_preview: true });
  assert.deepEqual(logs.map((l) => [l.event, l.result]), [['notify', 'sent']]);
});

test('нет токена: ничего не отправляет, пишет в журнал и не падает', async () => {
  for (const cfg of [{ token: '' }, { token: undefined }, { chatId: '' }]) {
    const { notify, sent, logs } = setup({ cfg });
    const r = await notify('выход не из Алматы');
    assert.deepEqual(r, { sent: false, reason: 'no_token' });
    assert.equal(sent.length, 0);
    assert.equal(logs[0].result, 'no_token');
    assert.match(logs[0].text, /выход не из Алматы/);
  }
});

test('ответ не ok, 4xx и 5xx: sent:false, не бросает; токена в журнале нет', async () => {
  const cases = [
    { status: 401, body: JSON.stringify({ ok: false, description: 'Unauthorized' }) },
    { status: 200, body: JSON.stringify({ ok: false, description: 'chat not found' }) },
    { status: 502, body: '<html>bad gateway</html>' },
    { status: 200, body: 'не json' },
  ];
  for (const reply of cases) {
    const { notify, logs } = setup({ transport: async () => reply });
    const r = await notify('привет');
    assert.equal(r.sent, false, JSON.stringify(reply));
    assert.equal(r.reason, 'failed');
    assert.equal(logs.at(-1).result, 'failed');
    assert.ok(!JSON.stringify(logs).includes(TOKEN));
  }
});

test('транспорт упал: не бросает, а текст ошибки без токена', async () => {
  const { notify, logs } = setup({ transport: async () => { throw new Error(`connect ECONNREFUSED /bot${TOKEN}/sendMessage`); } });
  const r = await notify('привет');
  assert.deepEqual([r.sent, r.reason], [false, 'failed']);
  const dump = JSON.stringify([r, logs]);
  assert.ok(!dump.includes(TOKEN), 'токен не должен попасть ни в ответ, ни в журнал');
  assert.match(dump, /ECONNREFUSED/);
});

test('длинный текст режется под лимит Telegram', async () => {
  const { notify, sent } = setup();
  await notify('я'.repeat(10000));
  assert.ok(JSON.parse(sent[0].body).text.length <= 4096);
});

test('fromEnv: токен и chat_id из окружения, без них — молчаливый режим', async () => {
  const sent = [];
  const transport = async (req) => { sent.push(req); return { status: 200, body: '{"ok":true}' }; };
  const on = fromEnv({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '7' }, { transport, log() {} });
  assert.equal((await on('x')).sent, true);
  assert.equal(JSON.parse(sent[0].body).chat_id, '7');
  const off = fromEnv({}, { transport, log() {} });
  assert.deepEqual(await off('x'), { sent: false, reason: 'no_token' });
  assert.equal(sent.length, 1);
});

test('настоящий транспорт: POST с телом и заголовками доходит до сервера, ответ разбирается', async (t) => {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, type: req.headers['content-type'], len: +req.headers['content-length'], body });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const notify = createNotifier({
    token: TOKEN, chatId: '42', host: '127.0.0.1', port: srv.address().port,
    transport: httpsTransport(http), log() {},
  });
  assert.deepEqual(await notify('проверка: кириллица и emoji'), { sent: true });
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].url, `/bot${TOKEN}/sendMessage`);
  assert.match(seen[0].type, /application\/json/);
  assert.equal(seen[0].len, Buffer.byteLength(seen[0].body), 'длина считается в байтах, а не в знаках');
  assert.equal(JSON.parse(seen[0].body).text, 'проверка: кириллица и emoji');
});

test('настоящий транспорт: сервер молчит дольше таймаута — sent:false, а не зависание', async (t) => {
  const srv = http.createServer(() => { /* не отвечает */ });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => { srv.closeAllConnections(); srv.close(); });
  const notify = createNotifier({
    token: TOKEN, chatId: '42', host: '127.0.0.1', port: srv.address().port,
    transport: httpsTransport(http), timeoutMs: 50, log() {},
  });
  const r = await notify('x');
  assert.deepEqual([r.sent, r.reason], [false, 'failed']);
});
