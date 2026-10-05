/**
 * Конфиг прогрева: подставляет умолчания и проверяет то, с чем бот пошёл бы не
 * туда. Сайты берутся только из конфига, поэтому адреса проверяются строго:
 * только http и https (никаких file:, chrome:, javascript:).
 */
const { maxSessionMs } = require('./plan.js');

const DEFAULTS = {
  tz: 'Asia/Almaty',
  hours: [9, 23],
  daysPerWeek: [7, 7], // в какие дни работает: от и до дней в неделю, остальные выходные (7 — каждый день)
  sessionsPerDay: [2, 5],
  minGapMinutes: 60,
  lateMinutes: 90,
  cooldownHours: 24,
  consent: 'reject', // баннер cookies: отказаться от необязательного ('reject') или принять ('accept')
};
const SESSION = { minutes: [5, 14], sites: [2, 4] };
const KINDS = ['read', 'video', 'search'];

const fail = (what) => { throw new Error(`life: ${what}`); };

function range(name, value, min, max) {
  const ok = Array.isArray(value) && value.length === 2 && value.every((x) => Number.isFinite(x))
    && value[0] >= min && value[1] <= max && value[0] <= value[1];
  if (!ok) fail(`${name} должен быть [от, до] в пределах ${min}–${max} и не перевёрнут, а не ${JSON.stringify(value)}`);
  return value;
}

function normalizeConfig(raw = {}) {
  const cfg = { ...DEFAULTS, ...raw, session: { ...SESSION, ...(raw.session || {}) } };

  try { new Intl.DateTimeFormat('en-US', { timeZone: cfg.tz }); } catch { fail(`tz «${cfg.tz}» неизвестен`); }
  if (!['reject', 'accept'].includes(cfg.consent)) fail(`consent должен быть reject или accept, а не «${cfg.consent}»`);
  range('hours', cfg.hours, 0, 24);
  range('daysPerWeek', cfg.daysPerWeek, 1, 7);
  if (!cfg.daysPerWeek.every(Number.isInteger)) fail(`daysPerWeek: целые числа, а не ${JSON.stringify(cfg.daysPerWeek)}`);
  range('sessionsPerDay', cfg.sessionsPerDay, 1, 20);
  range('session.minutes', cfg.session.minutes, 0.1, 120);
  range('session.sites', cfg.session.sites, 1, 20);
  if (!(cfg.minGapMinutes >= 0) || !(cfg.lateMinutes >= 0) || !(cfg.cooldownHours >= 0)) fail('minGapMinutes, lateMinutes и cooldownHours не могут быть отрицательными');
  if ((cfg.hours[1] - cfg.hours[0]) * 3600000 <= maxSessionMs(cfg)) fail(`самая длинная сессия (${cfg.session.minutes[1]} мин и запас на перерасход) не влезает в окно часов ${cfg.hours}`);

  if (!Array.isArray(cfg.sites) || !cfg.sites.length) fail('sites: нужен хотя бы один сайт');
  cfg.sites = cfg.sites.map((s) => {
    let u;
    try { u = new URL(s.url); } catch { fail(`сайт «${s.url}»: не адрес, нужен http или https`); }
    if (!/^https?:$/.test(u.protocol)) fail(`сайт «${s.url}»: только http и https`);
    const kind = s.kind || 'read', weight = s.weight ?? 1;
    if (!KINDS.includes(kind)) fail(`сайт «${s.url}»: kind должен быть ${KINDS.join(' или ')}, а не «${kind}»`);
    if (!(weight > 0)) fail(`сайт «${s.url}»: weight должен быть больше нуля`);
    if (kind === 'search') {
      const ok = Array.isArray(s.queries) && s.queries.length && s.queries.every((q) => typeof q === 'string' && q.trim() && q.length <= 60);
      if (!ok) fail(`сайт «${s.url}»: для kind search нужен queries — непустой список строк до 60 знаков`);
    }
    return { ...s, kind, weight };
  });
  return cfg;
}

module.exports = { normalizeConfig };
