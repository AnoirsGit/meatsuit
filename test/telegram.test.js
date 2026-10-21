/**
 * Адаптер Telegram: группа, тема форума, деление, повторы, миграция группы, токен не течёт.
 *
 *   node test/telegram.test.js
 */
const assert = require('node:assert/strict');
const { createTelegram, findChats, chunk, escapeHtml, TelegramError } = require('../telegram.js');

const TOKEN = '123456:SECRET-token';
const ok = (result = { message_id: 1 }) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) });
const fail = (status, description, parameters) => ({ ok: false, status, json: async () => ({ ok: false, error_code: status, description, parameters }) });

/** fetch, который отдаёт ответы по очереди и запоминает запросы. */
const fakeFetch = (...replies) => {
  const calls = [];
  const f = async (url, o) => {
    calls.push({ url, body: JSON.parse(o.body) });
    const r = replies.length > 1 ? replies.shift() : replies[0];
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r(calls.length) : r;
  };
  f.calls = calls;
  return f;
};
const sleeps = [];
const sleep = async (ms) => { sleeps.push(ms); };

(async () => {
  // Нужны токен и группа.
  assert.throws(() => createTelegram({ chatId: 1 }), /token/);
  assert.throws(() => createTelegram({ token: TOKEN }), /chatId/);

  // Обычная отправка: простой текст, без разметки и без превью ссылок.
  let f = fakeFetch(ok({ message_id: 77 }));
  const tg = createTelegram({ token: TOKEN, chatId: -1001234, fetchImpl: f, sleep });
  assert.deepEqual(await tg.send('Нужен человек: капча <b>на</b> tinder.com'), [77]);
  assert.equal(f.calls[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.deepEqual(f.calls[0].body, { chat_id: -1001234, text: 'Нужен человек: капча <b>на</b> tinder.com', disable_web_page_preview: true });

  // Тема форума, без звука, разметка по запросу.
  f = fakeFetch(ok());
  await createTelegram({ token: TOKEN, chatId: -1, threadId: '42', fetchImpl: f }).send('x', { silent: true, parseMode: 'HTML' });
  assert.equal(f.calls[0].body.message_thread_id, 42);
  assert.equal(f.calls[0].body.disable_notification, true);
  assert.equal(f.calls[0].body.parse_mode, 'HTML');
  await createTelegram({ token: TOKEN, chatId: -1, threadId: 42, fetchImpl: f }).send('x', { threadId: 7 });
  assert.equal(f.calls[1].body.message_thread_id, 7, 'threadId вызова главнее общего');

  // Пустое — ошибка, до сети не доходит.
  f = fakeFetch(ok());
  await assert.rejects(createTelegram({ token: TOKEN, chatId: 1, fetchImpl: f }).send('  '), /пустое/);
  assert.equal(f.calls.length, 0);

  // Длинный текст режется до 4096, склеивается обратно без потерь.
  const long = Array.from({ length: 300 }, (_, i) => `строка ${i} ${'я'.repeat(30)}`).join('\n');
  const parts = chunk(long);
  assert.ok(parts.length > 1 && parts.every((p) => p.length <= 4096));
  assert.equal(parts.join('\n'), long, 'при делении по строкам ничего не теряется');
  assert.ok(chunk('я'.repeat(9000)).every((p) => p.length <= 4096), 'без переводов строк режет жёстко');
  assert.equal(chunk('я'.repeat(9000)).join(''), 'я'.repeat(9000));
  let n = 0;
  f = fakeFetch(() => ok({ message_id: ++n }));
  assert.deepEqual(await createTelegram({ token: TOKEN, chatId: 1, fetchImpl: f }).send(long), parts.map((_, i) => i + 1));
  assert.equal(f.calls.length, parts.length);

  // 429: ждём retry_after и повторяем; потолок ожидания 30 с.
  sleeps.length = 0;
  f = fakeFetch(fail(429, 'Too Many Requests: retry after 5', { retry_after: 5 }), fail(429, 'Too Many Requests', { retry_after: 999 }), ok({ message_id: 9 }));
  assert.deepEqual(await createTelegram({ token: TOKEN, chatId: 1, fetchImpl: f, sleep }).send('x'), [9]);
  assert.deepEqual(sleeps, [5000, 30000]);

  // Бесконечно ждать не будем: после трёх повторов ошибка.
  f = fakeFetch(fail(429, 'Too Many Requests', { retry_after: 1 }));
  await assert.rejects(createTelegram({ token: TOKEN, chatId: 1, fetchImpl: f, sleep }).send('x'), (e) => e instanceof TelegramError && e.code === 429);
  assert.equal(f.calls.length, 4);

  // 5xx: один повтор.
  f = fakeFetch(fail(502, 'Bad Gateway'), ok({ message_id: 3 }));
  assert.deepEqual(await createTelegram({ token: TOKEN, chatId: 1, fetchImpl: f, sleep }).send('x'), [3]);
  f = fakeFetch(fail(500, 'oops'));
  await assert.rejects(createTelegram({ token: TOKEN, chatId: 1, fetchImpl: f, sleep }).send('x'), /oops/);
  assert.equal(f.calls.length, 2);

  // Группа стала супергруппой: берём новый id и запоминаем.
  const warns = [];
  f = fakeFetch(fail(400, 'Bad Request: group chat was upgraded to a supergroup chat', { migrate_to_chat_id: -1009999 }), ok({ message_id: 5 }));
  const mig = createTelegram({ token: TOKEN, chatId: -555, fetchImpl: f, sleep, warn: (m) => warns.push(m) });
  assert.deepEqual(await mig.send('x'), [5]);
  assert.equal(f.calls[1].body.chat_id, -1009999);
  assert.equal(mig.chatId, -1009999);
  assert.match(warns[0], /-1009999/);

  // Понятные подсказки на типичные ошибки; без повторов на 4xx.
  for (const [status, desc, hint] of [[401, 'Unauthorized', /токен/], [403, 'Forbidden: bot was kicked from the group chat', /удалён из группы/], [400, 'Bad Request: chat not found', /chatId/]]) {
    f = fakeFetch(fail(status, desc));
    await assert.rejects(createTelegram({ token: TOKEN, chatId: 1, fetchImpl: f, sleep }).send('x'), hint);
    assert.equal(f.calls.length, 1, `${status}: повторять бессмысленно`);
  }

  // Токен не попадает в ошибки: ни из сети, ни из ответа API.
  f = fakeFetch(new Error(`getaddrinfo failed for https://api.telegram.org/bot${TOKEN}/sendMessage`));
  await assert.rejects(createTelegram({ token: TOKEN, chatId: 1, fetchImpl: f }).send('x'), (e) => {
    assert.ok(!e.message.includes(TOKEN) && !e.message.includes('SECRET'), 'токен утёк в ошибку: ' + e.message);
    return /нет связи/.test(e.message);
  });
  f = fakeFetch(fail(400, `bad token ${TOKEN}`));
  await assert.rejects(createTelegram({ token: TOKEN, chatId: 1, fetchImpl: f }).send('x'), (e) => !e.message.includes(TOKEN));

  // Ответ не JSON: ошибка с HTTP-статусом, а не падение разбора.
  f = fakeFetch({ ok: false, status: 504, json: async () => { throw new Error('not json'); } });
  await assert.rejects(createTelegram({ token: TOKEN, chatId: 1, fetchImpl: f, sleep }).send('x'), /HTTP 504/);

  // escapeHtml для parseMode HTML.
  assert.equal(escapeHtml('a<b>&c'), 'a&lt;b&gt;&amp;c');

  // findChats: группы без дублей, темы форума, личные чаты тоже видны.
  const upd = (result) => fakeFetch({ ok: true, status: 200, json: async () => ({ ok: true, result }) });
  const chats = await findChats({ token: TOKEN, fetchImpl: upd([
    { update_id: 1, my_chat_member: { chat: { id: -100777, type: 'supergroup', title: 'Алерты' } } },
    { update_id: 2, message: { chat: { id: -100777, type: 'supergroup', title: 'Алерты' }, is_topic_message: true, message_thread_id: 12 } },
    { update_id: 3, message: { chat: { id: -100777, type: 'supergroup', title: 'Алерты' }, is_topic_message: true, message_thread_id: 12 } },
    { update_id: 4, message: { chat: { id: 55, type: 'private', first_name: 'Аня', username: 'anya' } } },
    { update_id: 5, callback_query: {} },
  ]) });
  assert.deepEqual(chats, [
    { id: -100777, type: 'supergroup', title: 'Алерты', threads: [12] },
    { id: 55, type: 'private', title: 'Аня anya', threads: [] },
  ]);
  await assert.rejects(findChats({ token: TOKEN, fetchImpl: fakeFetch({ ok: true, status: 200, json: async () => ({ ok: false, error_code: 409, description: `Conflict: webhook is active ${TOKEN}` }) }) }), (e) => !e.message.includes(TOKEN) && /webhook/.test(e.message));

  // CLI для человека, который настраивает уведомления (tools/telegram-chats.js): токен из его окружения.
  const http = require('node:http');
  const cli = require('../tools/telegram-chats.js');
  const hits = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      hits.push({ url: req.url, body: JSON.parse(body || '{}') });
      const result = req.url.endsWith('/getUpdates')
        ? [{ message: { chat: { id: -100777, type: 'supergroup', title: 'Группа' }, is_topic_message: true, message_thread_id: 5 } }]
        : { message_id: 1 };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, result }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const env = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '-100777', TELEGRAM_API_BASE: `http://127.0.0.1:${srv.address().port}` };
  const out = [];
  await cli.main([], env, (l) => out.push(l));
  assert.deepEqual(out, ['-100777\tsupergroup\tГруппа\tтемы: 5']);
  await cli.main(['send', 'проверка'], env, (l) => out.push(l));
  assert.equal(hits.at(-1).url, `/bot${TOKEN}/sendMessage`);
  assert.equal(hits.at(-1).body.text, 'проверка');
  assert.equal(hits.at(-1).body.chat_id, '-100777');
  srv.close();

  console.log('telegram.test: ok');
})().catch((e) => { console.error(e); process.exit(1); });
