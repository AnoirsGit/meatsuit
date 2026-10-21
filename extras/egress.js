/**
 * Выход в сеть: страну и провайдера определяет сервис-эхо (из той же сети, что и
 * браузер), результат сверяется с egress.json { country, asn }. Сверка по номеру
 * провайдера, а не по названию: названия в базах разные, номер один.
 * Не совпало или не определилось — отказ (fail closed): ok:false с error
 * 'egress_wrong' или 'egress_unknown'. Сеть и время подставляются.
 */
const MIN = 60000;

const asnOf = (s) => { const m = /^AS(\d+)/i.exec(String(s ?? '')); return m ? +m[1] : null; };
const orgOf = (s) => String(s ?? '').replace(/^AS\d+\s*/i, '') || null;
const bad = (what) => { throw new Error(what); };

/** Разбор ответа каждого сервиса свой: поля называются по-разному. Нет страны — ответ негоден. */
const SERVICES = [
  {
    name: 'ipinfo.io', url: 'https://ipinfo.io/json',
    parse: (j) => (typeof j.country === 'string' ? { country: j.country, asn: asnOf(j.org), org: orgOf(j.org) } : bad('нет country')),
  },
  {
    name: 'ipwho.is', url: 'https://ipwho.is/',
    parse: (j) => (j.success !== false && typeof j.country_code === 'string'
      ? { country: j.country_code, asn: Number.isInteger(j.connection?.asn) ? j.connection.asn : null, org: j.connection?.org || null }
      : bad('нет country_code')),
  },
];

/** egress.json → { country: 'KZ', asn: [64500] } */
function normalizeExpected(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('egress: нужен объект { country, asn }');
  if (typeof raw.country !== 'string' || !/^[A-Za-z]{2}$/.test(raw.country)) throw new Error(`egress: country должна быть двумя буквами (KZ), а не ${JSON.stringify(raw.country)}`);
  const asn = raw.asn ?? [];
  if (!Array.isArray(asn) || !asn.every((n) => Number.isInteger(n) && n > 0)) throw new Error('egress: asn должен быть списком чисел, например [64500] (без «AS»)');
  return { country: raw.country.toUpperCase(), asn };
}

function createEgress({
  expected, fetch = globalThis.fetch, now = Date.now, services = SERVICES,
  ttlMs = MIN, intervalMs = 5 * MIN, timeoutMs = 5000,
  setIntervalFn = setInterval, clearIntervalFn = clearInterval,
} = {}) {
  const want = normalizeExpected(expected);
  let cached = null; // { result, at }
  let inflight = null;
  let timer = null;
  const listeners = [];

  /** 'ok' | 'wrong' | null (нечем проверить: провайдер нужен, а сервис его не назвал). */
  function judge({ country, asn }) {
    if (country.toUpperCase() !== want.country) return 'wrong';
    if (!want.asn.length) return 'ok';
    if (asn === null) return null;
    return want.asn.includes(asn) ? 'ok' : 'wrong';
  }

  async function ask(svc) {
    const res = await fetch(svc.url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return svc.parse(await res.json());
  }

  async function measure() {
    const errors = [];
    for (const svc of services) {
      let seen;
      try { seen = await ask(svc); } catch (err) { errors.push(`${svc.name}: ${err.message}`); continue; }
      const verdict = judge(seen);
      if (verdict) return { ok: verdict === 'ok', ...(verdict === 'ok' ? {} : { error: 'egress_wrong' }), country: seen.country.toUpperCase(), asn: seen.asn, org: seen.org, source: svc.name };
      errors.push(`${svc.name}: не назвал провайдера`);
    }
    return { ok: false, error: 'egress_unknown', country: null, asn: null, org: null, source: null, detail: errors.join('; ') };
  }

  /** Проверка с кэшем: ok и «не оттуда» держатся ttl, «не определилось» не кэшируется. */
  function check({ force = false } = {}) {
    if (!force && cached && cached.result.error !== 'egress_unknown' && now() - cached.at < ttlMs) return Promise.resolve(cached.result);
    if (!inflight) {
      inflight = measure().then((result) => {
        const prev = cached && cached.result;
        result.at = now();
        cached = { result, at: result.at };
        for (const fn of listeners) { try { fn(result, prev); } catch { /* подписчик не должен ломать проверку */ } }
        return result;
      }).finally(() => { inflight = null; });
    }
    return inflight;
  }

  /** Проверка при старте и дальше по таймеру, в обход кэша. */
  async function start() {
    stop();
    const first = await check({ force: true });
    timer = setIntervalFn(() => check({ force: true }), intervalMs);
    if (timer && timer.unref) timer.unref();
    return first;
  }

  function stop() {
    if (timer !== null) clearIntervalFn(timer);
    timer = null;
  }

  return {
    check, start, stop,
    subscribe: (fn) => { listeners.push(fn); },
    last: () => (cached ? cached.result : null),
  };
}

module.exports = { createEgress, normalizeExpected, SERVICES };
