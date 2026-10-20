/**
 * Границы суток там, где переводят часы (Европа: 29 марта и 25 октября 2026; США: 1 ноября 2026).
 * Остальные тесты времени идут в поясе UTC+5, где перевода нет, и вторую поправку в startOfLocalDay,
 * «+6 часов» в challenge и сутки по 23 и 25 часов проверить не могут.
 *
 *   node --test test/timezone-dst.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startOfLocalDay, localDay, planDay } = require('../life/plan.js');
const { createLimits } = require('../limits.js');

const BERLIN = 'Europe/Berlin';
const H = 3600e3;
const utc = (...a) => Date.UTC(...a);

test('начало суток в день перехода на летнее время (23 часа) и сразу после', () => {
  // 29 марта 2026: в 02:00 часы идут на 03:00; полночь ещё по зимнему (UTC+1)
  assert.equal(startOfLocalDay(utc(2026, 2, 29, 10), BERLIN), utc(2026, 2, 28, 23));
  assert.equal(startOfLocalDay(utc(2026, 2, 29, 0, 30), BERLIN), utc(2026, 2, 28, 23)); // 01:30 по Берлину
  assert.equal(startOfLocalDay(utc(2026, 2, 30, 10), BERLIN), utc(2026, 2, 29, 22)); // 30 марта: уже UTC+2
  assert.equal(localDay(utc(2026, 2, 29, 0, 30), BERLIN), '2026-03-29');
  assert.equal(localDay(utc(2026, 2, 28, 22, 59), BERLIN), '2026-03-28');
  assert.equal(localDay(utc(2026, 2, 28, 23, 0), BERLIN), '2026-03-29');
});

test('начало суток в день возврата на зимнее время (25 часов) и сразу после', () => {
  // 25 октября 2026: в 03:00 часы идут на 02:00; полночь по летнему (UTC+2)
  assert.equal(startOfLocalDay(utc(2026, 9, 25, 12), BERLIN), utc(2026, 9, 24, 22));
  assert.equal(startOfLocalDay(utc(2026, 9, 25, 22, 30), BERLIN), utc(2026, 9, 24, 22)); // 23:30 по Берлину, последний час суток
  assert.equal(startOfLocalDay(utc(2026, 9, 26, 12), BERLIN), utc(2026, 9, 25, 23)); // 26 октября: UTC+1
  assert.equal(localDay(utc(2026, 9, 25, 22, 59), BERLIN), '2026-10-25');
  assert.equal(localDay(utc(2026, 9, 25, 23, 0), BERLIN), '2026-10-26');
});

test('в Нью-Йорке полночь по часам тоже находится правильно в дни перехода', () => {
  const NY = 'America/New_York';
  assert.equal(startOfLocalDay(utc(2026, 10, 1, 12), NY), utc(2026, 10, 1, 4)); // 1 ноября: полночь ещё по летнему (UTC-4), сутки 25 часов
  assert.equal(startOfLocalDay(utc(2026, 10, 2, 12), NY), utc(2026, 10, 2, 5)); // 2 ноября: UTC-5
});

test('limits: следующие сутки и retry_at верны через перевод часов', () => {
  let t;
  const make = (sites) => createLimits({ sites, file: null, now: () => t, tz: BERLIN });

  // окно часов 10–21: в 09:59 по Берлину 29 марта (уже UTC+2) открытие в 10:00 = 08:00 UTC
  t = utc(2026, 2, 29, 7, 59);
  let r = make({ 'a.test': { perDay: 5, hours: '10-21' } }).take('a.test', 1);
  assert.deepEqual([r.ok, r.reason, r.retry_at], [false, 'hours', utc(2026, 2, 29, 8, 0)]);

  // после закрытия окна 28 марта (22:00 по UTC+1) следующее открытие 29-го в 10:00 по UTC+2
  t = utc(2026, 2, 28, 21, 30);
  r = make({ 'a.test': { perDay: 5, hours: '10-21' } }).take('a.test', 1);
  assert.deepEqual([r.ok, r.reason, r.retry_at], [false, 'hours', utc(2026, 2, 29, 8, 0)]);

  // исчерпан дневной лимит в день возврата часов (25 часов): ждать до полуночи по UTC+2→UTC+1, то есть 22:00 → 23:00 UTC
  t = utc(2026, 9, 25, 12);
  const lim = make({ 'a.test': { perDay: 1 } });
  assert.equal(lim.take('a.test', 1).ok, true);
  r = lim.take('a.test', 1);
  assert.deepEqual([r.ok, r.reason, r.retry_at], [false, 'day', utc(2026, 9, 25, 23, 0)]);
});

test('limits.challenge: пауза в днях считается по календарю, а не по 24 часа, и через перевод часов', () => {
  let t = utc(2026, 2, 27, 12); // 27 марта 13:00 по Берлину
  const lim = createLimits({ sites: { 'a.test': { perDay: 5, challengePauseDays: 3 } }, file: null, now: () => t, tz: BERLIN });
  const r = lim.challenge('a.test', t);
  assert.equal(r.ok, true);
  assert.equal(r.until, utc(2026, 2, 29, 22), '27 марта + 3 дня = начало 30 марта: 00:00 по UTC+2 — это 29 марта 22:00 UTC');
  t = utc(2026, 9, 23, 12); // 23 октября (UTC+2): +3 дня через возврат часов
  const lim2 = createLimits({ sites: { 'b.test': { perDay: 5, challengePauseDays: 3 } }, file: null, now: () => t, tz: BERLIN });
  assert.equal(lim2.challenge('b.test', t).until, utc(2026, 9, 25, 23), '26 октября 00:00 по UTC+1 = 25 октября 23:00 UTC');
});

const localHour = (ms) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: BERLIN, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms)).replace(':', '.'));

test('planDay: в сутки из 23 и 25 часов старты лежат в окне часов по местным часам', () => {
  const { seeded } = require('../human/random.js');
  const cfg = { tz: BERLIN, hours: [9, 23], sessionsPerDay: [5, 5], minGapMinutes: 10, lateMinutes: 90, cooldownHours: 24,
    session: { minutes: [5, 8], sites: [2, 3] }, sites: [{ url: 'https://a.test/', kind: 'read', weight: 1 }] };
  for (const [name, day] of [['29 марта (23 ч)', utc(2026, 2, 29, 12)], ['25 октября (25 ч)', utc(2026, 9, 25, 12)], ['обычный день', utc(2026, 5, 10, 12)]]) {
    const start = startOfLocalDay(day, BERLIN);
    let seen = 0;
    for (let i = 1; i <= 60; i++) {
      for (const at of planDay(start, cfg, seeded(i))) {
        seen++;
        assert.ok(localHour(at) >= 9, `${name}: старт в ${localHour(at)} раньше окна, seed ${i}`);
        assert.ok(localHour(at) < 23, `${name}: старт в ${localHour(at)} позже окна, seed ${i}`);
        assert.equal(localDay(at, BERLIN), localDay(day, BERLIN), `${name}: старт не в тех сутках`);
      }
    }
    assert.ok(seen > 100, `${name}: слишком мало стартов (${seen})`);
  }
});

test('limits.snapshot: «открыто» по местным часам и в сутки с переводом часов', () => {
  let t = utc(2026, 9, 25, 8, 30); // 25 октября, 09:30 по UTC+1: от полуночи прошло 10,5 часа (сутки на час длиннее), а на часах 09:30
  const lim = createLimits({ sites: { 'a.test': { perDay: 5, hours: '10-21' } }, file: null, now: () => t, tz: BERLIN });
  assert.equal(lim.snapshot()['a.test'].open, false, 'в 09:30 по часам ещё закрыто');
  t = utc(2026, 9, 25, 9, 30); // на часах 10:30
  assert.equal(lim.snapshot()['a.test'].open, true);
});
