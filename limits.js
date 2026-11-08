/**
 * Лимиты площадки, часы работы и замок очереди площадки «один бот за раз на площадке».
 *
 * check() — чистая функция (test/limits.test.js). Площадки нет в sites.json
 * и нет правила "*" — значит нельзя: по умолчанию закрыто.
 */
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

class LimitReached extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOUR = 3600e3;

function parseHours(s) {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(s);
  if (!m || +m[1] > 24 || +m[2] > 24 || m[1] === m[2]) throw new Error(`hours: ждали "10-21", пришло ${JSON.stringify(s)}`);
  return [+m[1], +m[2]];
}

/**
 * Правило площадки из разобранного sites.json: своя запись по точному ключу, иначе общее "*"
 * (если есть), иначе undefined. Записи не сливаются: явная заменяет "*" целиком.
 * Счётчики при этом всё равно ведутся по хосту, поэтому "*" — ключ правила, а не хост.
 * Поддомен описанной площадки под "*" не попадает и её правило не наследует: undefined,
 * иначе закрытую площадку обошли бы сменой site на www.
 */
function ruleFor(sites, site) {
  if (site === '*') throw new Error('site: "*" — ключ правила по умолчанию, а не хост');
  if (Object.hasOwn(sites, site)) return sites[site];
  if (Object.keys(sites).some((k) => k !== '*' && site.endsWith('.' + k))) return undefined;
  return sites['*'];
}

/**
 * Бросает LimitReached. stamps — времена прошлых задач с записью, мс.
 * reads — времена read-only задач: они считаются только в perHour.
 * readOnly — эта задача пока только читает: perDay её не останавливает (слот дня тратится при записи).
 */
function check(site, rule, stamps, now = new Date(), { reads = [], readOnly = false } = {}) {
  if (!rule) throw new LimitReached(`${site}: площадка не описана в sites.json`);
  if (rule.perDay === 0) throw new LimitReached(`${site}: perDay 0, бот здесь ничего не делает`);
  if (rule.hours) {
    const [a, b] = parseHours(rule.hours);
    const h = now.getHours();
    const inside = a < b ? h >= a && h < b : h >= a || h < b;
    if (!inside) throw new LimitReached(`${site}: вне часов работы ${rule.hours}`);
  }
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  if (!readOnly && rule.perDay != null && stamps.filter((t) => t >= midnight).length >= rule.perDay) {
    throw new LimitReached(`${site}: исчерпан лимит на сегодня (${rule.perDay})`);
  }
  if (rule.perHour != null && [...stamps, ...reads].filter((t) => t > +now - HOUR).length >= rule.perHour) {
    throw new LimitReached(`${site}: исчерпан лимит на час (${rule.perHour})`);
  }
}

const READS = 'read:'; // ключ в limits.json для read-only задач: у площадок точек в начале нет
const readStamps = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
};

// Файл счётчиков читают без замка (peek, status, другие процессы): пишем целиком через rename, чтобы читатель
// не увидел половину. Чтение-правка-запись под замком состояния вызывающий берёт сам (index.js): задачи разных
// площадок идут одновременно, а счётчики у них в одном файле.
function writeStamps(file, all) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all));
  fs.renameSync(tmp, file);
}

/** Только проверить лимит, ничего не записывая (для dryRun: репетиция не должна съедать квоту). */
function peek(site, rule, file, now = new Date(), opts) {
  const all = readStamps(file);
  check(site, rule, all[site] || [], now, { ...opts, reads: all[READS + site] || [] });
}

/**
 * Состояние площадки без траты слота: { ok, reason, usedDay, usedHour, leftDay, leftHour }.
 * reason — текст LimitReached, с которым задача сейчас не запустилась бы (null — запустится).
 * usedDay — задачи с записью с местной полуночи; usedHour — все задачи (и только читающие) за час.
 * left* — сколько ещё можно: null — лимита нет; площадки нет в файле — 0. Кривое правило — Error, как у reserve.
 */
function status(site, rule, file, now = new Date(), { readOnly = false } = {}) {
  const all = readStamps(file);
  const stamps = all[site] || [];
  const reads = all[READS + site] || [];
  let reason = null;
  try { check(site, rule, stamps, now, { reads, readOnly }); } catch (e) {
    if (!(e instanceof LimitReached)) throw e;
    reason = e.message;
  }
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  const usedDay = stamps.filter((t) => t >= midnight).length;
  const usedHour = [...stamps, ...reads].filter((t) => t > +now - HOUR).length;
  const left = (cap, used) => (!rule ? 0 : cap == null ? null : Math.max(0, cap - used));
  return { ok: !reason, reason, usedDay, usedHour, leftDay: left(rule && rule.perDay, usedDay), leftHour: left(rule && rule.perHour, usedHour) };
}

/**
 * Проверить лимит и записать задачу. Вызывать под lock().
 * readOnly: слот пишется в reads и тратит только perHour; полным его делает charge().
 */
function reserve(site, rule, file, now = new Date(), { readOnly = false } = {}) {
  const all = readStamps(file);
  const fresh = (a) => (a || []).filter((t) => t > +now - 48 * HOUR);
  const stamps = fresh(all[site]);
  const reads = fresh(all[READS + site]);
  check(site, rule, stamps, now, { reads, readOnly });
  if (readOnly) all[READS + site] = [...reads, +now];
  else all[site] = [...stamps, +now];
  writeStamps(file, all);
}

/** Read-only задача собирается записать: засчитать полный слот ДО команды; дневной лимит исчерпан — LimitReached, команда не выполняется. */
function charge(site, rule, file, at) {
  const all = readStamps(file);
  const midnight = new Date(at).setHours(0, 0, 0, 0);
  const today = (all[site] || []).filter((t) => t >= midnight).length;
  if (rule.perDay != null && today >= rule.perDay) throw new LimitReached(`${site}: исчерпан лимит на сегодня (${rule.perDay})`);
  const reads = all[READS + site] || [];
  const i = reads.indexOf(+at);
  if (i >= 0) reads.splice(i, 1);
  all[READS + site] = reads;
  all[site] = [...(all[site] || []), +at];
  writeStamps(file, all);
}

/** Кто держит замок: { token, pid, name?, site?, since } из файла или null (пусто, мусор, старая версия с одним PID). */
function lockHolder(file) {
  try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return v && typeof v === 'object' ? v : null; } catch { return null; }
}

/**
 * Очередь площадки: одна на ключ queueKey(site). Ключ — два последних звена хоста: web.telegram.org и telegram.org,
 * www.linkedin.com и linkedin.com — одна очередь. Иначе задача singleTab на telegram.org взяла бы вкладку
 * web.telegram.org, где в это время работает другая задача (вкладку площадки ищут по хосту и поддоменам).
 * Площадки под общим суффиксом вроде co.uk тоже попадут в одну очередь: лишнее ожидание, но не две задачи в одной
 * вкладке. Адрес IPv4 и одно звено (localhost) — ключ как есть. Лимиты и стопы считаются по самой площадке, не по ключу.
 */
function queueKey(site) {
  const h = String(site).toLowerCase().replace(/\.+$/, '');
  if (!h || /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':')) return h;
  const labels = h.split('.');
  if (labels[labels.length - 1] === 'localhost') return 'localhost';
  return labels.slice(-2).join('.');
}

/** Файл замка очереди площадки: <dir>/queue/<ключ>.lock. */
const queueFile = (dir, site) => path.join(dir, 'queue', `${encodeURIComponent(queueKey(site))}.lock`);

const STALE_MS = 30000; // lock(): замок, не обновлявшийся дольше, брошен

/**
 * targetId страниц, в которых сейчас идут задачи: из живых замков очередей <dir>/queue/*.lock (кроме except — своего).
 * Задача пишет туда targetId своего окна (release.update): задача singleTab другой площадки не возьмёт эту страницу
 * за свою вкладку, даже если она открыта на её хосте (extraHosts держателя). Брошенный замок не в счёт.
 */
function heldTargets(dir, except = null, now = Date.now()) {
  const qdir = path.join(dir, 'queue');
  const out = new Set();
  let names = [];
  try { names = fs.readdirSync(qdir); } catch { return out; }
  for (const n of names) {
    if (!n.endsWith('.lock')) continue;
    const f = path.join(qdir, n);
    if (except && path.resolve(f) === path.resolve(except)) continue;
    try { if (now - fs.statSync(f).mtimeMs > STALE_MS) continue; } catch { continue; }
    const h = lockHolder(f);
    if (h && typeof h.targetId === 'string' && h.targetId) out.add(h.targetId);
  }
  return out;
}

/** Текст отказа «очередь занята»: чья задача, на какой площадке и с какого времени, сколько ждали. */
function busyText(file, timeoutMs, queue = null) {
  const h = lockHolder(file);
  const str = (v) => (typeof v === 'string' && v ? v.slice(0, 100) : null);
  const name = h && str(h.name), site = h && str(h.site);
  const since = h && Number.isFinite(h.since) ? ` с ${new Date(h.since).toTimeString().slice(0, 5)}` : '';
  const who = name ? `задачей «${name}»${site ? ` (${site})` : ''}${since}` : 'другой задачей';
  const waited = timeoutMs >= 60e3 ? `${Math.round(timeoutMs / 60e3)} мин` : `${Math.round(timeoutMs / 1000)} с`;
  return queue ? `очередь ${queue}: занята ${who}, не дождались своей очереди за ${waited}`
    : `очередь: браузер занят ${who}, не дождались своей очереди за ${waited}`;
}

/**
 * Межпроцессный замок на файле. Держатель раз в heartbeatMs обновляет mtime;
 * замок старше staleMs считается брошенным; забирает его один ждущий под вторым замком `.reclaim`.
 * По PID нельзя: в контейнере после перезапуска PID тот же, и замок жил бы вечно.
 * В файле — кто держит: { token, pid, name, site, since } (holder — { name, site } задачи). release() снимает
 * только свой замок: держатель, который завис дольше staleMs, просыпается и не уносит замок того, кто его забрал.
 * Не дождались за timeoutMs — LimitReached «очередь <queue>: занята …» (без queue — «браузер занят …», так звучал
 * замок всего браузера): как исчерпанный лимит, задача не начинается, браузер не тронут, повторить позже.
 * Возвращает release(); release.update({ targetId }) дописывает в файл, какую страницу держит задача (heldTargets).
 */
async function lock(file, { pollMs = 500, timeoutMs = 30 * 60e3, heartbeatMs = 5000, staleMs = STALE_MS, holder = {}, queue = null } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const until = Date.now() + timeoutMs;
  const token = `${process.pid}-${randomUUID()}`;
  const who = {};
  for (const k of ['name', 'site']) if (typeof holder[k] === 'string' && holder[k]) who[k] = holder[k].slice(0, 100);
  for (;;) {
    try {
      fs.writeFileSync(file, JSON.stringify({ token, pid: process.pid, ...who, since: Date.now() }), { flag: 'wx' });
      const beat = setInterval(() => { try { const t = new Date(); fs.utimesSync(file, t, t); } catch {} }, heartbeatMs);
      beat.unref();
      const release = () => {
        clearInterval(beat);
        const h = lockHolder(file);
        if (h && h.token === token) { try { fs.unlinkSync(file); } catch {} }
      };
      // Замок свой — переписать целиком через rename (читатель не увидит половину, путь не пропадает ни на миг).
      release.update = ({ targetId } = {}) => {
        const h = lockHolder(file);
        if (!h || h.token !== token) return false;
        if (typeof targetId === 'string' && targetId) h.targetId = targetId.slice(0, 100);
        const tmp = `${file}.${randomUUID()}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(h));
        fs.renameSync(tmp, file);
        return true;
      };
      return release;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let age = 0;
      try { age = Date.now() - fs.statSync(file).mtimeMs; } catch { continue; } // исчез между проверками
      if (age > staleMs) {
        // Забирать можно только под вторым замком и с повторной проверкой возраста: иначе
        // rename по пути унесёт свежий замок, который другой ждущий успел взять после нашей проверки.
        const g = `${file}.reclaim`;
        try {
          fs.writeFileSync(g, '', { flag: 'wx' });
          try { if (Date.now() - fs.statSync(file).mtimeMs > staleMs) fs.unlinkSync(file); } catch {}
          try { fs.unlinkSync(g); } catch {}
        } catch (e2) {
          if (e2.code !== 'EEXIST') throw e2;
          try { if (Date.now() - fs.statSync(g).mtimeMs > staleMs) fs.unlinkSync(g); } catch {} // забравший умер
        }
        continue;
      }
      if (Date.now() > until) throw new LimitReached(busyText(file, timeoutMs, queue));
      await sleep(pollMs);
    }
  }
}

module.exports = { ruleFor, check, peek, status, reserve, charge, lock, queueKey, queueFile, heldTargets, LimitReached };
