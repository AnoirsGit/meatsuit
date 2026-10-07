/**
 * Конфиг прогрева: подставляет умолчания и отвергает то, с чем бот пошёл бы
 * не туда (не http-адреса, перевёрнутые диапазоны, сессия длиннее окна).
 *
 *   node --test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeConfig } = require('../life/config.js');

const sites = [{ url: 'https://a.test/' }];

test('умолчания подставляются, заданное не затирается', () => {
  const cfg = normalizeConfig({ sites, hours: [10, 22], session: { minutes: [3, 6] } });
  assert.deepEqual(
    [cfg.tz, cfg.hours, cfg.sessionsPerDay, cfg.minGapMinutes, cfg.lateMinutes, cfg.cooldownHours, cfg.session.minutes, cfg.session.sites],
    ['Asia/Almaty', [10, 22], [2, 5], 60, 90, 24, [3, 6], [2, 4]],
  );
  assert.deepEqual(cfg.sites, [{ url: 'https://a.test/', kind: 'read', weight: 1 }]);
});

test('сайты обязательны', () => {
  assert.throws(() => normalizeConfig({}), /sites/);
  assert.throws(() => normalizeConfig({ sites: [] }), /sites/);
});

test('ходит только по http и https: file:, javascript: и мусор отвергаются', () => {
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://a.test/', 'not a url', 'chrome://settings']) {
    assert.throws(() => normalizeConfig({ sites: [{ url }] }), /http/, url);
  }
});

test('вид сайта и вес проверяются', () => {
  assert.throws(() => normalizeConfig({ sites: [{ url: 'https://a.test/', kind: 'hack' }] }), /kind/);
  assert.throws(() => normalizeConfig({ sites: [{ url: 'https://a.test/', weight: 0 }] }), /weight/);
  assert.throws(() => normalizeConfig({ sites: [{ url: 'https://a.test/', weight: -2 }] }), /weight/);
});

test('диапазоны: перевёрнутые и вне суток отвергаются', () => {
  assert.throws(() => normalizeConfig({ sites, hours: [23, 9] }), /hours/);
  assert.throws(() => normalizeConfig({ sites, hours: [9, 25] }), /hours/);
  assert.throws(() => normalizeConfig({ sites, sessionsPerDay: [5, 2] }), /sessionsPerDay/);
  assert.throws(() => normalizeConfig({ sites, session: { minutes: [10, 5] } }), /minutes/);
  assert.throws(() => normalizeConfig({ sites, session: { sites: [0, 3] } }), /sites/);
});

test('самая длинная сессия должна влезать в окно часов', () => {
  assert.throws(() => normalizeConfig({ sites, hours: [9, 10], session: { minutes: [5, 90] } }), /окн/);
});

test('неизвестный часовой пояс отвергается, а не молча считается по UTC', () => {
  assert.throws(() => normalizeConfig({ sites, tz: 'Mars/Olympus' }), /tz/);
});

test('политика cookies: по умолчанию отказ, «accept» разрешён, прочее отвергается', () => {
  assert.equal(normalizeConfig({ sites }).consent, 'reject');
  assert.equal(normalizeConfig({ sites, consent: 'accept' }).consent, 'accept');
  assert.throws(() => normalizeConfig({ sites, consent: 'maybe' }), /consent/);
});

test('сайт с видом search: нужен непустой список запросов из строк до 60 знаков', () => {
  const ok = normalizeConfig({ sites: [{ url: 'https://ru.wikipedia.org/', kind: 'search', queries: ['Шахматы', 'Docker'] }] });
  assert.deepEqual(ok.sites[0].queries, ['Шахматы', 'Docker']);
  for (const queries of [undefined, [], [''], ['   '], [5], 'Шахматы', ['а'.repeat(61)]]) {
    assert.throws(() => normalizeConfig({ sites: [{ url: 'https://ru.wikipedia.org/', kind: 'search', queries }] }), /queries/, JSON.stringify(queries));
  }
  assert.doesNotThrow(() => normalizeConfig({ sites: [{ url: 'https://a.test/', kind: 'read' }] }), 'у чтения запросов не требуют');
});

test('дней в неделю: по умолчанию все семь, диапазон целый, от 1 до 7 и не перевёрнутый', () => {
  assert.deepEqual(normalizeConfig({ sites }).daysPerWeek, [7, 7]);
  assert.deepEqual(normalizeConfig({ sites, daysPerWeek: [3, 4] }).daysPerWeek, [3, 4]);
  for (const bad of [[0, 3], [3, 8], [4, 3], [2.5, 4], [3], 'семь']) {
    assert.throws(() => normalizeConfig({ sites, daysPerWeek: bad }), /daysPerWeek/, JSON.stringify(bad));
  }
});
