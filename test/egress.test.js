/**
 * Проверка выхода в сеть: страна и провайдер по сервису-эхо, сверка с egress.json,
 * кэш, запасной сервис, fail closed. Сеть подставляется, настоящих запросов нет.
 *
 *   node --test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEgress, normalizeExpected } = require('../egress.js');

const EXPECTED = { country: 'KZ', asn: [64500] };

const IPINFO_KZ = { ip: '203.0.113.7', country: 'KZ', org: 'AS64500 Example ISP', timezone: 'Asia/Almaty' };
const IPINFO_NL = { ip: '198.51.100.9', country: 'NL', org: 'AS64502 Example Datacenter' };
const IPWHO_KZ = { ip: '203.0.113.7', success: true, country_code: 'KZ', connection: { asn: 64500, org: 'Example ISP' } };

const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

/** fetch с ответами по подстроке адреса; считает вызовы. Значение-функция или Error — как есть. */
function fakeFetch(routes) {
  const calls = [];
  const f = async (url, opts = {}) => {
    calls.push(url);
    const key = Object.keys(f.routes).find((k) => url.includes(k));
    if (!key) throw new Error(`нет маршрута ${url}`);
    const r = f.routes[key];
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r(url, opts) : r;
  };
  f.routes = routes;
  f.calls = calls;
  return f;
}

function setup(routes, opts = {}) {
  const clock = { t: 1000000 };
  const fetch = fakeFetch(routes);
  const egress = createEgress({ expected: EXPECTED, fetch, now: () => clock.t, ...opts });
  return { egress, fetch, clock };
}

test('Алматы и нужный провайдер: ok', async () => {
  const { egress } = setup({ 'ipinfo.io': reply(IPINFO_KZ) });
  const r = await egress.check();
  assert.deepEqual([r.ok, r.country, r.asn], [true, 'KZ', 64500]);
  assert.equal(r.error, undefined);
});

test('другая страна: egress_wrong', async () => {
  const { egress } = setup({ 'ipinfo.io': reply(IPINFO_NL) });
  const r = await egress.check();
  assert.deepEqual([r.ok, r.error, r.country, r.asn], [false, 'egress_wrong', 'NL', 64502]);
});

test('та же страна, чужой провайдер: egress_wrong', async () => {
  const { egress } = setup({ 'ipinfo.io': reply({ country: 'KZ', org: 'AS64501 Example Other ISP' }) });
  const r = await egress.check();
  assert.deepEqual([r.ok, r.error], [false, 'egress_wrong']);
});

test('сверка по номеру провайдера, а не по названию', async () => {
  const { egress } = setup({ 'ipinfo.io': reply({ country: 'KZ', org: 'AS64500 Renamed Example Telecom' }) });
  assert.equal((await egress.check()).ok, true);
});

test('страна в другом регистре не обман', async () => {
  const { egress } = setup({ 'ipinfo.io': reply({ country: 'kz', org: 'AS64500 Example ISP' }) });
  assert.equal((await egress.check()).ok, true);
});

test('основной сервис упал: берёт запасной (ipwho.is)', async () => {
  const { egress, fetch } = setup({ 'ipinfo.io': new Error('ECONNRESET'), 'ipwho.is': reply(IPWHO_KZ) });
  const r = await egress.check();
  assert.deepEqual([r.ok, r.country, r.asn, r.source], [true, 'KZ', 64500, 'ipwho.is']);
  assert.equal(fetch.calls.length, 2);
});

test('основной ответил 429 или мусором: тоже запасной', async () => {
  for (const bad of [reply({}, 429), reply({ nonsense: 1 }), { ok: true, status: 200, json: async () => { throw new SyntaxError('не JSON'); } }]) {
    const { egress } = setup({ 'ipinfo.io': bad, 'ipwho.is': reply(IPWHO_KZ) });
    assert.equal((await egress.check()).ok, true);
  }
});

test('не определилось ни там, ни там: egress_unknown (fail closed)', async () => {
  const { egress } = setup({ 'ipinfo.io': new Error('нет сети'), 'ipwho.is': reply({ success: false }) });
  const r = await egress.check();
  assert.deepEqual([r.ok, r.error], [false, 'egress_unknown']);
});

test('нужен провайдер, а сервис его не назвал: не определилось, а не «подошло»', async () => {
  const { egress } = setup({ 'ipinfo.io': reply({ country: 'KZ' }), 'ipwho.is': reply({ success: true, country_code: 'KZ' }) });
  assert.equal((await egress.check()).error, 'egress_unknown');
});

test('если в egress.json только страна, провайдер не требуется', async () => {
  const { egress } = setup({ 'ipinfo.io': reply({ country: 'KZ' }) }, { expected: { country: 'KZ' } });
  assert.equal((await egress.check()).ok, true);
});

test('сервис завис: по таймауту не определилось', async () => {
  const hang = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('прервано'))));
  const { egress } = setup({ 'ipinfo.io': hang, 'ipwho.is': hang }, { timeoutMs: 20 });
  const r = await egress.check();
  assert.equal(r.error, 'egress_unknown');
});

test('кэш на минуту: повторная проверка без запроса, потом снова', async () => {
  const { egress, fetch, clock } = setup({ 'ipinfo.io': reply(IPINFO_KZ) });
  await egress.check();
  clock.t += 59000;
  await egress.check();
  assert.equal(fetch.calls.length, 1);
  clock.t += 1000;
  await egress.check();
  assert.equal(fetch.calls.length, 2);
});

test('force обходит кэш', async () => {
  const { egress, fetch } = setup({ 'ipinfo.io': reply(IPINFO_KZ) });
  await egress.check();
  await egress.check({ force: true });
  assert.equal(fetch.calls.length, 2);
});

test('«не определилось» не кэшируется: следующий begin проверяет заново', async () => {
  const { egress, fetch } = setup({ 'ipinfo.io': new Error('x'), 'ipwho.is': new Error('y') });
  await egress.check();
  fetch.routes['ipinfo.io'] = reply(IPINFO_KZ);
  assert.equal((await egress.check()).ok, true);
});

test('«не из Алматы» кэшируется: минуту не дёргаем сервис, но и не пускаем', async () => {
  const { egress, fetch } = setup({ 'ipinfo.io': reply(IPINFO_NL) });
  await egress.check();
  assert.equal((await egress.check()).error, 'egress_wrong');
  assert.equal(fetch.calls.length, 1);
});

test('одновременные проверки делят один запрос', async () => {
  const { egress, fetch } = setup({ 'ipinfo.io': reply(IPINFO_KZ) });
  await Promise.all([egress.check(), egress.check(), egress.check({ force: true })]);
  assert.equal(fetch.calls.length, 1);
});

test('start: проверяет при старте и повторяет по таймеру раз в 5 минут', async () => {
  const timers = [];
  const { egress, fetch } = setup({ 'ipinfo.io': reply(IPINFO_KZ) }, {
    setIntervalFn: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearIntervalFn: (h) => { timers[h - 1].cleared = true; },
  });
  const first = await egress.start();
  assert.equal(first.ok, true);
  assert.equal(fetch.calls.length, 1);
  assert.equal(timers[0].ms, 5 * 60000);
  await timers[0].fn();
  assert.equal(fetch.calls.length, 2, 'по таймеру в обход кэша');
  egress.stop();
  assert.equal(timers[0].cleared, true);
});

test('подписчик узнаёт о каждой настоящей проверке и о смене состояния', async () => {
  const { egress, fetch } = setup({ 'ipinfo.io': reply(IPINFO_KZ) });
  const seen = [];
  egress.subscribe((r, prev) => seen.push([r.ok ? 'ok' : r.error, prev ? (prev.ok ? 'ok' : prev.error) : null]));
  await egress.check();
  await egress.check(); // из кэша: не событие
  fetch.routes['ipinfo.io'] = reply(IPINFO_NL);
  await egress.check({ force: true });
  fetch.routes['ipinfo.io'] = reply(IPINFO_KZ);
  await egress.check({ force: true });
  assert.deepEqual(seen, [['ok', null], ['egress_wrong', 'ok'], ['ok', 'egress_wrong']]);
});

test('упавший подписчик проверку не ломает', async () => {
  const { egress } = setup({ 'ipinfo.io': reply(IPINFO_KZ) });
  egress.subscribe(() => { throw new Error('подписчик упал'); });
  assert.equal((await egress.check()).ok, true);
});

test('last: последний результат для страницы статуса, до первой проверки null; IP наружу не уходит', async () => {
  const { egress } = setup({ 'ipinfo.io': reply(IPINFO_KZ) });
  assert.equal(egress.last(), null);
  await egress.check();
  const last = egress.last();
  assert.deepEqual([last.ok, last.country, last.asn], [true, 'KZ', 64500]);
  assert.ok(!JSON.stringify(last).includes('203.0.113'));
});

test('normalizeExpected: страна двумя буквами, провайдеры — числа', () => {
  assert.deepEqual(normalizeExpected({ country: 'kz', asn: [64500] }), { country: 'KZ', asn: [64500] });
  assert.deepEqual(normalizeExpected({ country: 'KZ' }), { country: 'KZ', asn: [] });
  assert.throws(() => normalizeExpected({}), /country/);
  assert.throws(() => normalizeExpected({ country: 'Kazakhstan' }), /country/);
  assert.throws(() => normalizeExpected({ country: 'KZ', asn: ['AS64500'] }), /asn/);
  assert.throws(() => normalizeExpected({ country: 'KZ', asn: 64500 }), /asn/);
  assert.throws(() => normalizeExpected(null), /egress/);
});
