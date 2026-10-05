/**
 * Прогрев, чистая часть: когда выходить в сеть, что открывать, сколько читать,
 * по какой ссылке идти, что делать планировщику сейчас. Времени и случайности
 * здесь не берётся откуда попало: оба приходят аргументами.
 */
const { between, chance, clamp, lognormal } = require('../human/random');

const MIN = 60000, H = 3600000, DAY_MS = 86400000;

// Сессия может перерасти сумму бюджетов (возвраты вверх за ссылками в бюджет не входят). Жёсткий срок:
// сумма бюджетов ×1,25 и паузы между сайтами (до 12 с на сайт); после него сессия заканчивается сама.
const OVERRUN = 1.25, PAUSE_MAX = 12000;
const deadlineOf = (steps) => steps.reduce((s, x) => s + x.budgetMs, 0) * OVERRUN + steps.length * PAUSE_MAX;
/** Самый долгий срок, какой может получиться по конфигу: на столько окно часов должно оставаться после старта. */
const maxSessionMs = (cfg) => cfg.session.minutes[1] * MIN * OVERRUN + cfg.session.sites[1] * PAUSE_MAX;

const randInt = (rnd, a, b) => a + Math.floor(rnd() * (b - a + 1));

/** Насколько часовой пояс опережает UTC в момент ms. */
function tzOffsetMs(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}

/** Дата по местному времени, '2026-10-05'. */
const localDay = (ms, tz) => new Date(ms + tzOffsetMs(ms, tz)).toISOString().slice(0, 10);

/** Местная полночь суток, в которые попадает ms, в миллисекундах UTC. */
function startOfLocalDay(ms, tz) {
  const wall = Math.floor((ms + tzOffsetMs(ms, tz)) / DAY_MS) * DAY_MS;
  return wall - tzOffsetMs(wall - tzOffsetMs(ms, tz), tz); // второй заход — на случай перевода часов в эти сутки
}

const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const mondayIndex = (ymd) => (new Date(`${ymd}T00:00:00Z`).getUTCDay() + 6) % 7; // 0 — понедельник

/** Семь местных дат недели (с понедельника), в которую попадает ms. */
function weekDays(ms, tz) {
  const today = localDay(ms, tz);
  const monday = addDays(today, -mondayIndex(today));
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/** Номер недели по ISO ('2026-W41'): год и номер определяет четверг этой недели. */
function weekId(ms, tz) {
  const thursday = weekDays(ms, tz)[3];
  const ordinal = Math.floor((Date.parse(`${thursday}T00:00:00Z`) - Date.parse(`${thursday.slice(0, 4)}-01-01T00:00:00Z`)) / DAY_MS);
  return `${thursday.slice(0, 4)}-W${String(Math.floor(ordinal / 7) + 1).padStart(2, '0')}`;
}

/** В какие дни недели прогрев работает: от daysPerWeek[0] до [1] случайных дней; остальные — выходные. */
function planWeek(ms, cfg, rnd = Math.random) {
  const days = weekDays(ms, cfg.tz);
  const n = randInt(rnd, cfg.daysPerWeek[0], cfg.daysPerWeek[1]);
  for (let i = days.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [days[i], days[j]] = [days[j], days[i]]; } // перемешать
  return { id: weekId(ms, cfg.tz), days: days.slice(0, n).sort() };
}

/**
 * Старты сессий одного дня: случайное число, случайное время в окне часов,
 * не ближе minGapMinutes друг к другу, и самая долгая сессия (до своего срока) влезает до конца окна.
 * Не помещается заказанное — берёт сколько помещается.
 */
function planDay(dayStart, cfg, rnd = Math.random) {
  const from = dayStart + cfg.hours[0] * H;
  const to = dayStart + cfg.hours[1] * H - maxSessionMs(cfg);
  if (to <= from) return [];
  const gap = cfg.minGapMinutes * MIN;
  for (let want = randInt(rnd, cfg.sessionsPerDay[0], cfg.sessionsPerDay[1]); want > 0; want--) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const starts = Array.from({ length: want }, () => Math.round(from + rnd() * (to - from))).sort((a, b) => a - b);
      if (starts.every((t, i) => !i || t - starts[i - 1] >= gap)) return starts;
    }
  }
  return [];
}

/** Сколько переходов по ссылкам за визит на читаемый сайт: чаще ни одного, глубокие маршруты редки. */
function followCount(rnd) {
  const r = rnd();
  return r < 0.45 ? 0 : r < 0.75 ? 1 : r < 0.92 ? 2 : 3;
}

function weighted(rnd, items) {
  let r = rnd() * items.reduce((s, x) => s + (x.weight ?? 1), 0);
  for (const x of items) { r -= x.weight ?? 1; if (r < 0) return x; }
  return items[items.length - 1];
}

/**
 * Одна сессия: несколько сайтов из конфига по весам, без одного и того же подряд;
 * общее время делится между ними неровно. На сайт-чтение иногда выпадает пройти по ссылке.
 */
function planSession(cfg, rnd = Math.random) {
  const n = randInt(rnd, cfg.session.sites[0], cfg.session.sites[1]);
  const total = between(rnd, cfg.session.minutes[0], cfg.session.minutes[1]) * MIN;
  const picks = [];
  for (let i = 0, last = null; i < n; i++) {
    const site = weighted(rnd, cfg.sites.filter((s) => cfg.sites.length < 2 || s.url !== last));
    last = site.url;
    const kind = site.kind || 'read';
    picks.push({
      url: site.url, kind, share: lognormal(rnd, 1, 0.35),
      follow: kind === 'video' ? 0 : followCount(rnd),
      ...(kind === 'search' ? { query: site.queries[Math.floor(rnd() * site.queries.length)] } : {}),
    });
  }
  const sum = picks.reduce((s, p) => s + p.share, 0);
  return picks.map(({ share, ...p }) => ({ ...p, budgetMs: Math.round(total * share / sum) }));
}

/** Сколько человек просидит над страницей: пролистывает, а не читает всё, поэтому доля от полного чтения. */
function readingTime(chars, rnd = Math.random) {
  const fullMs = chars / 6 / 238 * MIN; // слов ≈ знаков/6, читает ≈ 238 слов в минуту
  return clamp(fullMs * clamp(lognormal(rnd, 0.4, 0.35), 0.15, 1), 8000, 240000);
}

const DENY = /log-?out|log-?in|sign-?(in|up)|register|subscribe|unsubscribe|\bcart\b|checkout|\bbuy\b|download|account|settings|password|donate|sponsor|advert|\/ads?\b|mailto:|tel:|javascript:|войти|выйти|регистрац|подпис|корзин|купить|скачать|пожертв|реклам/i;

/**
 * Ссылка, по которой можно пойти: того же сайта, осмысленная по длине текста,
 * не в новой вкладке, не вход, покупка, подписка или скачивание, не якорь на этой же странице, не из подвала.
 * zone: 'nav' — только из меню и шапки, 'content' — только из содержимого; без zone — любая.
 */
function pickLink(links, origin, rnd = Math.random, { include, zone } = {}) {
  const here = new URL(origin);
  const key = (u) => u.origin + u.pathname + u.search;
  const ok = links.filter((l) => {
    let u;
    try { u = new URL(l.href); } catch { return false; }
    return /^https?:$/.test(u.protocol) && u.hostname === here.hostname && key(u) !== key(here)
      && l.target !== '_blank' && l.text.length >= 12 && l.text.length <= 140
      && !DENY.test(`${l.href} ${l.text}`) && (!include || include.test(l.href))
      && (l.zone || 'content') !== 'footer' && (!zone || (l.zone || 'content') === zone);
  });
  return ok.length ? ok[Math.floor(rnd() * ok.length)] : null;
}

/**
 * Что планировщику делать сейчас. state: { day, starts, done, pausedUntil }.
 * replan — новые сутки или нет состояния; wait — спать до until; run — выходить;
 * skip — старт пропущен (проспали дольше lateMinutes).
 */
function nextAction(state, now, cfg) {
  if (!state || state.day !== localDay(now, cfg.tz)) return { type: 'replan' };
  if (state.pausedUntil > now) return { type: 'wait', until: state.pausedUntil };
  const next = state.starts.find((s) => !state.done.includes(s));
  if (next === undefined) return { type: 'wait', until: startOfLocalDay(startOfLocalDay(now, cfg.tz) + 30 * H, cfg.tz) };
  if (next > now) return { type: 'wait', until: next };
  return now - next > cfg.lateMinutes * MIN ? { type: 'skip', start: next } : { type: 'run', start: next };
}

module.exports = { PAUSE_MAX, deadlineOf, maxSessionMs, tzOffsetMs, localDay, startOfLocalDay, weekDays, weekId, planWeek, planDay, planSession, readingTime, pickLink, nextAction };
