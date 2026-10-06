/**
 * guard и лимиты: чистые проверки + очередь.
 *
 *   node test/guard.test.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { check, telegramNotifier } = require('../guard.js');
const limits = require('../limits.js');

const snap = (o) => ({ url: 'https://tinder.com/app/recs', title: 'Tinder', text: '', elements: [], dialogs: [], ...o });

// guard
assert.equal(check(snap({ text: 'Аня, 24. Люблю рок и горы' })), null);
assert.equal(check(snap({ title: 'Just a moment... captcha' })), 'капча');
assert.equal(check(snap({ text: 'Verify you are human' })), 'капча');
assert.equal(check(snap({ dialogs: [{ name: 'Check', text: 'Подтвердите, что вы не робот', elements: [] }] })), 'капча');
assert.match(check(snap({ text: 'Unusual activity detected' })), /подозрительная/);
assert.match(check(snap({ text: 'Ваш аккаунт заблокирован' })), /подозрительная/);
assert.equal(check(snap({ url: 'https://hh.kz/account/login' })), 'страница входа');
assert.equal(check(snap({ elements: [{ id: 1, role: 'textbox', name: 'Пароль' }] })), 'страница входа');
// Слово в длинном био — не повод для остановки.
assert.equal(check(snap({ text: 'captcha '.repeat(200) })), null);

(async () => {
  // Простая проверка совместимости импорта; подробно адаптер проверяет test/telegram.test.js.
  const sent = [];
  const okFetch = async (u, o) => { sent.push([u, JSON.parse(o.body)]); return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) }; };
  await telegramNotifier({ token: '123:ABC', chatId: -100, fetchImpl: okFetch })('привет');
  assert.equal(sent[0][0], 'https://api.telegram.org/bot123:ABC/sendMessage');
  assert.equal(sent[0][1].chat_id, -100);
  assert.equal(sent[0][1].text, 'привет');

  // лимиты (локальное время: now задаём через конструктор от компонентов)
  const at = (h) => new Date(2026, 9, 6, h, 0, 0);
  const rule = { perDay: 3, perHour: 2, hours: '10-21' };
  const stamp = (h, m = 0) => +new Date(2026, 9, 6, h, m);
  assert.equal(check(snap({ url: 'не адрес' })), null, 'битый url не должен ронять guard');
  limits.check('s', rule, [], at(12));
  assert.throws(() => limits.check('s', rule, [], at(9)), /вне часов/);
  assert.throws(() => limits.check('s', rule, [], at(21)), /вне часов/);
  assert.throws(() => limits.check('s', null, [], at(12)), /не описана/);
  assert.throws(() => limits.check('s', { perDay: 0 }, [], at(12)), /perDay 0/);
  assert.throws(() => limits.check('s', rule, [stamp(11, 10), stamp(11, 40)], at(12)), /на час/);
  limits.check('s', rule, [stamp(10, 10), stamp(10, 40)], at(12)); // час прошёл
  assert.throws(() => limits.check('s', rule, [stamp(10), stamp(11), stamp(11, 30)], at(13)), /на сегодня/);
  limits.check('s', rule, [+new Date(2026, 9, 5, 15)], at(12)); // вчерашнее не считается
  limits.check('s', { perDay: 1, hours: '22-6' }, [], at(23)); // окно через полночь
  limits.check('s', { perDay: 1, hours: '22-6' }, [], at(3));
  assert.throws(() => limits.check('s', { hours: '22-6' }, [], at(12)), /вне часов/);
  assert.throws(() => limits.check('s', { hours: 'ночью' }, [], at(12)), /hours/);

  // reserve пишет и не обходит лимит
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meatsuit-lim-'));
  const f = path.join(dir, 'limits.json');
  const now = at(12);
  limits.reserve('s', { perDay: 2 }, f, now);
  limits.reserve('s', { perDay: 2 }, f, now);
  assert.throws(() => limits.reserve('s', { perDay: 2 }, f, now), /на сегодня/);
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).s.length, 2, 'отказ не должен писаться');

  // очередь: второй ждёт первого; замок мёртвого процесса забирается
  const lf = path.join(dir, 'q.lock');
  const order = [];
  const r1 = await limits.lock(lf, { pollMs: 20 });
  const second = limits.lock(lf, { pollMs: 20 }).then((rel) => { order.push('second'); rel(); });
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(order, [], 'второй не должен проскочить');
  order.push('first'); r1();
  await second;
  assert.deepEqual(order, ['first', 'second']);
  fs.writeFileSync(lf, String(process.pid)); // свой же PID, но замок давно не обновляли
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lf, old, old);
  (await limits.lock(lf, { pollMs: 20, timeoutMs: 1000, staleMs: 30000 }))();
  await assert.rejects(async () => { await limits.lock(lf, { pollMs: 20 }); await limits.lock(lf, { pollMs: 20, timeoutMs: 100 }); }, /очереди/);

  console.log('guard.test: ok');
})().catch((e) => { console.error(e); process.exit(1); });
