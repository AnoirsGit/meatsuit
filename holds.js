/**
 * Стоп площадки после NeedsHuman: капча, вход, блокировка. Пока стоп стоит, task() этой площадки не идёт
 * в браузер (окно не трогает, слот не тратит). Другие площадки работают. Снимается сам через holdHours
 * или руками: releaseHold() из index.js, `node tools/release.js <площадка>`.
 *
 * Стоп — файл <dir>/holds/<площадка>.json: { reason, url, since, until } (мс). По файлу на площадку:
 * поставить и снять — одна запись или удаление, без «прочитать-изменить-записать» между процессами.
 *
 * holdHours, active — чистые (test/holds.test.js).
 */
const fs = require('node:fs');
const path = require('node:path');

const HOUR = 3600e3;
// Капча у владельца частая и к бану не ведёт: сутки — потерянный день, час-два — возврат, пока аккаунт ещё под
// подозрением. 6 часов — не больше двух повторных заходов за рабочий день.
const DEFAULT_HOURS = 6;

/** Срок стопа из правила площадки: holdHours, по умолчанию 6; 0 — стоп не ставить. Кривое значение — Error. */
function holdHours(rule) {
  const h = rule && rule.holdHours;
  if (h === undefined) return DEFAULT_HOURS;
  if (typeof h !== 'number' || !Number.isFinite(h) || h < 0) throw new Error(`sites.json: holdHours — число часов ≥ 0, пришло ${JSON.stringify(h)}`);
  return h;
}

const fileOf = (dir, site) => path.join(dir, 'holds', `${encodeURIComponent(site)}.json`);

/** Стоп из файла, если он ещё действует в now; иначе null. Битый файл — как нет стопа: он не должен держать площадку вечно. */
function active(hold, now) {
  return hold && Number.isFinite(hold.until) && hold.until > now ? hold : null;
}

function read(dir, site) {
  try { return JSON.parse(fs.readFileSync(fileOf(dir, site), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT' || e instanceof SyntaxError) return null; throw e; }
}

/** Действующий стоп площадки → { site, reason, url, since, until } или null. Без браузера. */
function holdState(site, { dir, now = Date.now() } = {}) {
  if (!site) throw new Error('holdState: нужен site');
  const h = active(read(dir, site), +now);
  return h && { site, ...h };
}

/** Поставить стоп на hours часов (0 — не ставить). → стоп или null. */
function hold(site, { dir, reason, url, hours, now = Date.now() }) {
  if (!(hours > 0)) return null;
  const h = { reason: String(reason ?? ''), url: url ?? null, since: +now, until: +now + hours * HOUR };
  const file = fileOf(dir, site);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(h));
  fs.renameSync(tmp, file); // целиком или никак: task() другого процесса не прочтёт половину
  return { site, ...h };
}

const pad = (n) => String(n).padStart(2, '0');
/** «20:15» сегодня, иначе «27.10 03:15» — по поясу процесса (TZ). */
function clock(ms, now = Date.now()) {
  const d = new Date(ms);
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === new Date(now).toDateString() ? t : `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${t}`;
}

/** Снять стоп руками. → { released: был ли действующий стоп }. */
function releaseHold(site, { dir, now = Date.now() } = {}) {
  if (!site) throw new Error('releaseHold: нужен site');
  const was = !!active(read(dir, site), +now);
  fs.rmSync(fileOf(dir, site), { force: true });
  return { released: was };
}

module.exports = { holdHours, active, holdState, hold, releaseHold, clock, DEFAULT_HOURS };
