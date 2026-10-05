/**
 * Лимиты площадок из sites.json: perDay, perHour и часы работы по Алматы.
 * Единица лимита — cost из begin. perDay 0 — площадка закрыта. Счётчики лежат в
 * файле (запись целиком через tmp + rename) и переживают перезапуск. Отказ несёт
 * retry_at: когда освободится окно, час или сутки (null — при таком cost никогда).
 *
 * Лимит ведёт себя не как ровная планка, а как человек (все поля необязательны):
 *   ramp { days, startShare }  растёт от первого успешного begin: в день 0 доля startShare от perDay, через days суток полный;
 *   restDaysPerWeek            столько случайных выходных в неделю (дни выбраны по сиду, не меняются при перезапуске);
 *   jitter                     дневной лимит гуляет в [1−jitter, 1+jitter] от обычного, у каждых суток свой;
 *   challengePauseDays         после капчи или блока площадка замирает на столько суток (challenge()).
 * Время и файловая система подставляются.
 */
const crypto = require('node:crypto');
const nodeFs = require('node:fs');
const path = require('node:path');
const { startOfLocalDay, localDay } = require('./life/plan.js');
const { seeded } = require('./human/random');

const H = 3600000, DAY_MS = 86400000;
const KEYS = ['perDay', 'perHour', 'hours', 'ramp', 'restDaysPerWeek', 'jitter', 'challengePauseDays'];
const MAX_STEPS = 40; // сколько раз можно отодвинуть retry_at, пока запреты не сойдутся (рост на две недели и выходные съедают десятки суток)
const STATE = '_state'; // служебный ключ файла: у имени площадки такого быть не может (в имени нет «_»)
const DEFAULT_PAUSE_DAYS = 3;
const EPS = 1e-9; // 100 × 0,07 = 7,000000000000001: без допуска округление вверх дало бы лишнюю единицу

const fail = (what) => { throw new Error(`limits: ${what}`); };
const isCount = (x) => Number.isInteger(x) && x >= 0;
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const ceil = (x) => Math.ceil(x - EPS);

/** Воспроизводимый генератор из строки: тот же текст, та же последовательность. */
const rndOf = (text) => seeded(crypto.createHash('sha256').update(text).digest().readUInt32BE(0));

/** Следующие сутки по местному времени (в 30 часах от полуночи всегда уже следующие, даже при переводе часов). */
const nextDayStart = (dayStart, tz) => startOfLocalDay(dayStart + 30 * H, tz);

/**
 * sites.json → { 'hh.kz': { perDay, perHour|null, hours:[от,до]|null } }; невозможное отвергается.
 * Поля ramp, restDaysPerWeek, jitter, challengePauseDays попадают в результат, только если заданы.
 */
function normalizeSites(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Object.keys(raw).length) fail('sites: нужна хотя бы одна площадка');
  const out = {};
  for (const [name, cfg] of Object.entries(raw)) {
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) fail(`площадка «${name}»: ожидается объект { perDay, perHour, hours }`);
    for (const k of Object.keys(cfg)) if (!KEYS.includes(k)) fail(`площадка «${name}»: неизвестное поле «${k}» (бывают ${KEYS.join(', ')})`);
    if (!isCount(cfg.perDay)) fail(`площадка «${name}»: perDay должен быть целым числом от нуля, а не ${JSON.stringify(cfg.perDay)}`);
    if (cfg.perHour !== undefined && !isCount(cfg.perHour)) fail(`площадка «${name}»: perHour должен быть целым числом от нуля, а не ${JSON.stringify(cfg.perHour)}`);
    let hours = null;
    if (cfg.hours !== undefined) {
      const m = /^(\d{1,2})-(\d{1,2})$/.exec(typeof cfg.hours === 'string' ? cfg.hours : '');
      hours = m && [+m[1], +m[2]];
      if (!hours || hours[0] >= hours[1] || hours[1] > 24) fail(`площадка «${name}»: hours «${cfg.hours}» должен быть вида «10-21» (от меньшего к большему, до 24)`);
    }
    const site = { perDay: cfg.perDay, perHour: cfg.perHour ?? null, hours };
    if (cfg.ramp !== undefined) {
      const r = cfg.ramp;
      const ok = r && typeof r === 'object' && !Array.isArray(r) && Object.keys(r).every((k) => k === 'days' || k === 'startShare')
        && Number.isInteger(r.days) && r.days >= 1 && isNum(r.startShare) && r.startShare >= 0 && r.startShare <= 1;
      if (!ok) fail(`площадка «${name}»: ramp должен быть вида { "days": 14, "startShare": 0.3 } (days — целое от 1, startShare — от 0 до 1), а не ${JSON.stringify(r)}`);
      site.ramp = { days: r.days, startShare: r.startShare };
    }
    if (cfg.restDaysPerWeek !== undefined) {
      if (!Number.isInteger(cfg.restDaysPerWeek) || cfg.restDaysPerWeek < 0 || cfg.restDaysPerWeek > 6) fail(`площадка «${name}»: restDaysPerWeek — целое от 0 до 6 (все семь дней — это perDay 0), а не ${JSON.stringify(cfg.restDaysPerWeek)}`);
      site.restDaysPerWeek = cfg.restDaysPerWeek;
    }
    if (cfg.jitter !== undefined) {
      if (!isNum(cfg.jitter) || cfg.jitter < 0 || cfg.jitter >= 1) fail(`площадка «${name}»: jitter — число от 0 до 1 (не включая 1), например 0.2, а не ${JSON.stringify(cfg.jitter)}`);
      site.jitter = cfg.jitter;
    }
    if (cfg.challengePauseDays !== undefined) {
      if (!isCount(cfg.challengePauseDays)) fail(`площадка «${name}»: challengePauseDays должен быть целым числом от нуля, а не ${JSON.stringify(cfg.challengePauseDays)}`);
      site.challengePauseDays = cfg.challengePauseDays;
    }
    out[name.toLowerCase()] = site;
  }
  return out;
}

// ---------------------------------------------------------------- выходные дни

/** Все наборы из n дней недели (0 — понедельник … 6 — воскресенье), по возрастанию. */
const COMBOS = [];
for (let mask = 0; mask < 128; mask++) {
  const days = [0, 1, 2, 3, 4, 5, 6].filter((i) => (mask >> i) & 1);
  (COMBOS[days.length] = COMBOS[days.length] || []).push(days);
}

/**
 * Выходные одной недели. Берётся набор с наименьшим числом соседних дней (двое подряд — только
 * когда иначе не поместить), из равных выбирает rnd. Воскресенье прошлой недели — сосед понедельника.
 */
function pickRest(n, prevSunday, rnd) {
  const pairs = (d) => d.reduce((s, x, i) => s + (i && x - d[i - 1] === 1 ? 1 : 0), 0) + (prevSunday && d[0] === 0 ? 1 : 0);
  const best = Math.min(...COMBOS[n].map(pairs));
  const pool = COMBOS[n].filter((d) => pairs(d) === best);
  return pool[Math.floor(rnd() * pool.length)];
}

const restCache = new Map(); // «площадка|n» → выходные по неделям с 1970 года

/**
 * Выходные недели week (от понедельника). Каждая неделя зависит от воскресенья прошлой, поэтому
 * недели считаются подряд от начала отсчёта и запоминаются: ответ не зависит ни от порядка
 * вопросов, ни от перезапуска. Сид — площадка и номер недели.
 */
function restOfWeek(name, n, week) {
  if (week < 0) return [];
  const key = `${name}|${n}`;
  let weeks = restCache.get(key);
  if (!weeks) restCache.set(key, weeks = []);
  for (let w = weeks.length; w <= week; w++) weeks.push(pickRest(n, w > 0 && weeks[w - 1].includes(6), rndOf(`rest|${name}|${w}`)));
  return weeks[week];
}

/** Самый большой дневной лимит, какой вообще бывает: выше него cost не влезет никогда. */
const maxDay = (c) => (c.jitter ? Math.floor(c.perDay * (1 + c.jitter) + EPS) : c.perDay);

function createLimits({ sites, file, now = Date.now, tz = 'Asia/Almaty', fs = nodeFs }) {
  const cfg = normalizeSites(sites);
  const events = Object.create(null); // площадка → [{ t, c }] по возрастанию t
  const state = Object.create(null); // площадка → { first: первый успешный begin, frozenUntil: конец паузы }

  if (file) {
    let text = null;
    try { text = fs.readFileSync(file, 'utf8'); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    if (text !== null) {
      let raw;
      try { raw = JSON.parse(text); } catch { fail(`файл счётчиков ${file} испорчен (не JSON); чинить руками, сбрасывать лимиты молча нельзя`); }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`файл счётчиков ${file}: ожидается объект`);
      for (const [name, list] of Object.entries(raw)) {
        if (name === STATE) {
          const ok = list && typeof list === 'object' && !Array.isArray(list)
            && Object.values(list).every((v) => v && typeof v === 'object' && !Array.isArray(v) && ['first', 'frozenUntil'].every((k) => v[k] === undefined || Number.isFinite(v[k])));
          if (!ok) fail(`файл счётчиков ${file}: «${STATE}» должен быть { площадка: { first, frozenUntil } } с числами`);
          for (const [site, v] of Object.entries(list)) state[site] = { ...v };
          continue;
        }
        const ok = Array.isArray(list) && list.every((e) => Array.isArray(e) && Number.isFinite(e[0]) && Number.isFinite(e[1]));
        if (!ok) fail(`файл счётчиков ${file}: у «${name}» должен быть список [время, cost]`);
        events[name] = list.map(([t, c]) => ({ t, c }));
      }
    }
  }

  function persist() {
    if (!file) return;
    const t = now(), keep = Math.min(startOfLocalDay(t, tz), t - H);
    const out = {};
    for (const [name, list] of Object.entries(events)) {
      events[name] = list.filter((e) => e.t >= keep);
      if (events[name].length) out[name] = events[name].map((e) => [e.t, e.c]);
    }
    const saved = {};
    for (const [name, v] of Object.entries(state)) {
      const keep = {};
      if (v.first !== undefined) keep.first = v.first; // первый begin помнится всегда: от него растёт лимит
      if (v.frozenUntil > t) keep.frozenUntil = v.frozenUntil; // кончившаяся пауза в файле не нужна
      if (Object.keys(keep).length) saved[name] = keep;
    }
    if (Object.keys(saved).length) out[STATE] = saved;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(out)); // целиком или никак: оборванная запись не испортит счётчики
    fs.renameSync(`${file}.tmp`, file);
  }

  /** Название из sites.json: по имени, www и поддомену, по адресу; не описана — null. */
  function find(site) {
    if (typeof site !== 'string' || !site.trim()) return null;
    let host = site.trim().toLowerCase();
    if (host.includes('/')) { try { host = new URL(host).hostname; } catch { return null; } }
    return Object.keys(cfg).filter((k) => host === k || host.endsWith(`.${k}`)).sort((a, b) => b.length - a.length)[0] || null;
  }

  const sum = (list, from) => list.reduce((s, e) => (e.t >= from ? s + e.c : s), 0);

  /**
   * Сутки, в которые попадает t: начало, выходной ли и сколько можно за день. Лимит дня:
   * perDay × рост (от первого begin; пока begin не было, идёт день 0) × разброс (сид из площадки и даты),
   * вверх до целого, не меньше 1 и не больше perDay × (1 + jitter).
   */
  function dayPlan(name, t) {
    const c = cfg[name], dayStart = startOfLocalDay(t, tz), day = localDay(t, tz);
    let rest = false;
    if (c.restDaysPerWeek) {
      const shifted = Date.parse(day) / DAY_MS + 3; // 1 января 1970 был четвергом: сдвиг на 3 дня от понедельника
      rest = restOfWeek(name, c.restDaysPerWeek, Math.floor(shifted / 7)).includes(((shifted % 7) + 7) % 7);
    }
    if (c.perDay === 0) return { dayStart, rest, limit: 0 };
    let v = c.perDay;
    if (c.ramp) {
      const first = state[name] && state[name].first !== undefined ? state[name].first : t;
      const d = Math.max(0, Math.round((dayStart - startOfLocalDay(first, tz)) / DAY_MS));
      v *= c.ramp.startShare + (1 - c.ramp.startShare) * Math.min(1, d / c.ramp.days);
    }
    if (c.jitter) v *= 1 - c.jitter + 2 * c.jitter * rndOf(`jitter|${name}|${day}`)();
    return { dayStart, rest, limit: Math.min(Math.max(1, ceil(v)), maxDay(c)) };
  }

  /** Что мешает в момент t: { reason, until } (until null — не освободится), иначе null. */
  function blocked(name, cost, t) {
    const c = cfg[name], list = events[name] || [], frozen = state[name] && state[name].frozenUntil;
    if (c.perDay === 0 || c.perHour === 0) return { reason: 'closed', until: null };
    if (cost > maxDay(c) || (c.perHour !== null && cost > c.perHour)) return { reason: 'too_big', until: null };
    if (frozen > t) return { reason: 'challenge_pause', until: frozen };
    const { dayStart, rest, limit } = dayPlan(name, t);
    if (rest) return { reason: 'rest_day', until: nextDayStart(dayStart, tz) };
    if (c.hours) {
      const tod = t - dayStart;
      if (tod < c.hours[0] * H) return { reason: 'hours', until: dayStart + c.hours[0] * H };
      if (tod >= c.hours[1] * H) return { reason: 'hours', until: nextDayStart(dayStart, tz) + c.hours[0] * H };
    }
    if (sum(list, dayStart) + cost > limit) return { reason: 'day', until: nextDayStart(dayStart, tz) };
    if (c.perHour !== null) {
      const inHour = list.filter((e) => e.t > t - H);
      let used = inHour.reduce((s, e) => s + e.c, 0);
      if (used + cost > c.perHour) {
        for (const e of inHour) { // сколько самых старых должно выйти из часа, чтобы влезло
          used -= e.c;
          if (used + cost <= c.perHour) return { reason: 'hour', until: e.t + H };
        }
      }
    }
    return null;
  }

  /** Можно ли сейчас. Отказ: первая причина и время, когда сойдутся все запреты. */
  function check(name, cost) {
    let t = now(), first = null;
    for (let i = 0; i < MAX_STEPS; i++) {
      const b = blocked(name, cost, t);
      if (!b) return first ? { ok: false, reason: first, retry_at: t } : { ok: true };
      first = first || b.reason;
      if (b.until === null) return { ok: false, reason: first, retry_at: null };
      t = Math.max(b.until, t + 1);
    }
    return { ok: false, reason: first, retry_at: t };
  }

  /** Списать cost. ok:true несёт запись для refund. */
  function take(site, cost = 1) {
    const name = find(site);
    if (!name) return { ok: false, reason: 'unknown_site', retry_at: null };
    const r = check(name, cost);
    if (!r.ok) return r;
    const entry = { t: now(), c: cost };
    (events[name] = events[name] || []).push(entry);
    const st = (state[name] = state[name] || {});
    if (st.first === undefined) { st.first = entry.t; entry.first = true; } // первый успешный begin: от него растёт лимит
    persist();
    return { ok: true, site: name, entry };
  }

  /** Вернуть списанное: задача не открылась. */
  function refund(taken) {
    const list = taken && taken.ok && events[taken.site];
    const i = list ? list.indexOf(taken.entry) : -1;
    if (i < 0) return;
    list.splice(i, 1);
    if (taken.entry.first && state[taken.site]) delete state[taken.site].first; // окно не открылось: begin не состоялся
    persist();
  }

  /**
   * Капча, блок или слетевший вход: площадка замирает до начала суток по Алматы + challengePauseDays
   * (по умолчанию 3). Повторная проверка срок только продлевает. Пауза пишется в файл.
   */
  function challenge(site, t = now()) {
    const name = find(site);
    if (!name) return { ok: false, reason: 'unknown_site', retry_at: null };
    const days = cfg[name].challengePauseDays ?? DEFAULT_PAUSE_DAYS;
    const until = startOfLocalDay(startOfLocalDay(t, tz) + days * DAY_MS + 6 * H, tz); // +6 часов: попасть внутрь нужных суток при любом переводе часов
    const st = (state[name] = state[name] || {});
    st.frozenUntil = Math.max(st.frozenUntil ?? 0, until);
    persist();
    return { ok: true, site: name, until: st.frozenUntil };
  }

  /** Для страницы статуса: лимит сегодня (с ростом и разбросом), расход, выходной ли, до какого времени пауза. */
  function status(site, t = now()) {
    const name = find(site);
    if (!name) return null;
    const { dayStart, rest, limit } = dayPlan(name, t), frozen = state[name] && state[name].frozenUntil;
    return { site: name, perDay: cfg[name].perDay, effective: limit, usedDay: sum(events[name] || [], dayStart), rest, frozenUntil: frozen > t ? frozen : null };
  }

  function snapshot() {
    const t = now(), dayStart = startOfLocalDay(t, tz), out = {};
    for (const [name, c] of Object.entries(cfg)) {
      const list = events[name] || [];
      const tod = t - dayStart;
      out[name] = {
        perDay: c.perDay, perHour: c.perHour, hours: c.hours ? `${c.hours[0]}-${c.hours[1]}` : null,
        usedDay: sum(list, dayStart), usedHour: sum(list, t - H + 1),
        open: c.perDay > 0 && c.perHour !== 0 && (!c.hours || (tod >= c.hours[0] * H && tod < c.hours[1] * H)),
      };
    }
    return out;
  }

  return { find, take, refund, challenge, status, snapshot, sites: () => Object.keys(cfg) };
}

module.exports = { createLimits, normalizeSites };
