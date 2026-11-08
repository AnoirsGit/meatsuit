/**
 * Лимиты площадки, часы работы и замок очереди площадки «один бот за раз на площадке».
 *
 * check() — чистая функция (test/guard.test.js, test/budgets.test.js). Площадки нет в sites.json
 * и нет правила "*" — значит нельзя: по умолчанию закрыто.
 *
 * Как считать, решает правило площадки:
 *   - как раньше (нет readsPerHour): perHour — все задачи за час, perDay — задачи с записью за день; задача без
 *     readOnly тратит полный слот на старте, readOnly — только perHour, а первая запись делает слот полным (charge);
 *   - раздельный бюджет (есть readsPerHour, по желанию readsPerDay): старт любой задачи — слот чтения (readsPerHour,
 *     readsPerDay), первая команда записи — слот записи (perHour и perDay считают только записи; chargeWrite). Слот
 *     чтения при записи не возвращается: чтение было. Отказ — LimitReached с budget ('read' | 'write') и freeAt.
 * Отметки те же: <site> — записи, read:<site> — чтения; меняется только то, что с чем сравнивается.
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

const inHours = (hours, t) => {
  const [a, b] = parseHours(hours);
  const h = new Date(t).getHours();
  return a < b ? h >= a && h < b : h >= a || h < b;
};

const budgetNumber = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/**
 * Бюджет чтений площадки: { perHour, perDay } из readsPerHour и readsPerDay; null — его нет, считаем как раньше.
 * readsPerDay без readsPerHour и кривые числа — Error (до очереди и браузера), а не молча мимо.
 */
function readBudget(rule) {
  if (!rule || (rule.readsPerHour === undefined && rule.readsPerDay === undefined)) return null;
  if (rule.readsPerHour === undefined) throw new Error('sites.json: readsPerDay без readsPerHour не действует — задайте readsPerHour');
  if (!budgetNumber(rule.readsPerHour)) throw new Error(`sites.json: readsPerHour — число ≥ 0, пришло ${JSON.stringify(rule.readsPerHour)}`);
  if (rule.readsPerDay !== undefined && !budgetNumber(rule.readsPerDay)) throw new Error(`sites.json: readsPerDay — число ≥ 0, пришло ${JSON.stringify(rule.readsPerDay)}`);
  return { perHour: rule.readsPerHour, perDay: rule.readsPerDay ?? null };
}

/**
 * Когда освободится слот: null — сам по времени не освободится (лимит 0, perDay 0, площадки нет) или свободен уже
 * сейчас. Иначе первый миг (мс), когда открыты часы работы и есть место и за день, и за час (новых отметок не ждём).
 */
function freeAt(rule, stamps, now, { perHour = null, perDay = null } = {}) {
  if (!rule || rule.perDay === 0 || perHour === 0 || perDay === 0) return null;
  let t = +now;
  for (let i = 0; i < 50; i++) {
    let next = 0;
    if (rule.hours && !inHours(rule.hours, t)) {
      const open = new Date(t);
      open.setHours(parseHours(rule.hours)[0], 0, 0, 0);
      if (+open <= t) open.setDate(open.getDate() + 1);
      next = Math.max(next, +open);
    }
    const midnight = new Date(t).setHours(0, 0, 0, 0);
    if (perDay != null && stamps.filter((x) => x >= midnight).length >= perDay) next = Math.max(next, new Date(t).setHours(24, 0, 0, 0));
    const hour = stamps.filter((x) => x > t - HOUR).sort((x, y) => x - y);
    if (perHour != null && hour.length >= perHour) next = Math.max(next, hour[hour.length - perHour] + HOUR);
    if (!next) return t === +now ? null : t;
    t = next;
  }
  return t;
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

function limitCheck(site, rule, stamps, now, { reads, readOnly, kind }) {
  if (!rule) throw new LimitReached(`${site}: площадка не описана в sites.json`);
  if (rule.perDay === 0) throw new LimitReached(`${site}: perDay 0, бот здесь ничего не делает`);
  if (rule.hours && !inHours(rule.hours, now)) throw new LimitReached(`${site}: вне часов работы ${rule.hours}`);
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  const today = (a) => a.filter((t) => t >= midnight).length;
  const lastHour = (a) => a.filter((t) => t > +now - HOUR).length;
  if (kind === 'read') {
    const r = readBudget(rule);
    if (r.perDay != null && today(reads) >= r.perDay) throw new LimitReached(`${site}: исчерпан лимит чтений на сегодня (${r.perDay})`);
    if (lastHour(reads) >= r.perHour) throw new LimitReached(`${site}: исчерпан лимит чтений на час (${r.perHour})`);
    return;
  }
  const what = kind === 'write' ? 'лимит записей' : 'лимит';
  if (!readOnly && rule.perDay != null && today(stamps) >= rule.perDay) throw new LimitReached(`${site}: исчерпан ${what} на сегодня (${rule.perDay})`);
  // Как раньше perHour считает все задачи (и читающие); при раздельном бюджете — только записи.
  if (rule.perHour != null && lastHour(kind === 'write' ? stamps : [...stamps, ...reads]) >= rule.perHour) {
    throw new LimitReached(`${site}: исчерпан ${what} на час (${rule.perHour})`);
  }
}

/**
 * Бросает LimitReached. stamps — времена прошлых задач с записью, мс.
 * reads — времена read-only задач: как раньше они считаются только в perHour.
 * readOnly — эта задача пока только читает: perDay её не останавливает (слот дня тратится при записи).
 * kind — раздельный бюджет (readBudget): 'read' — слот чтения (reads против readsPerHour и readsPerDay), 'write' —
 * слот записи (stamps против perHour и perDay, чтения не в счёт). Тогда у LimitReached есть budget (= kind) и freeAt.
 */
function check(site, rule, stamps, now = new Date(), { reads = [], readOnly = false, kind = null } = {}) {
  try { limitCheck(site, rule, stamps, now, { reads, readOnly, kind }); }
  catch (e) {
    if (kind && e instanceof LimitReached) {
      e.budget = kind;
      e.freeAt = kind === 'read' ? freeAt(rule, reads, now, readBudget(rule) || {}) : freeAt(rule, stamps, now, rule || {});
    }
    throw e;
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

/** Только проверить лимит старта, ничего не записывая (для dryRun: репетиция не должна съедать квоту). */
function peek(site, rule, file, now = new Date(), opts) {
  const all = readStamps(file);
  const kind = readBudget(rule) ? 'read' : null;
  check(site, rule, all[site] || [], now, { ...opts, reads: all[READS + site] || [], kind });
}

/**
 * Состояние площадки без траты слота: { ok, reason, usedDay, usedHour, leftDay, leftHour }.
 * reason — текст LimitReached, с которым задача сейчас не запустилась бы (null — запустится).
 * usedDay — задачи с записью с местной полуночи; usedHour — то, что считает perHour за час: как раньше все задачи
 * (и только читающие), при раздельном бюджете — только записи.
 * left* — сколько ещё можно: null — лимита нет; площадки нет в файле — 0. Кривое правило — Error, как у reserve.
 * При раздельном бюджете ещё reads и writes: { ok, reason, usedHour, usedDay, leftHour, leftDay, freeAt } — дадут ли
 * сейчас слот чтения (старт задачи) и слот записи, и когда освободится (freeAt, мс; null — свободен или сам не
 * освободится). Без readsPerHour вид прежний, без reads и writes.
 */
function status(site, rule, file, now = new Date(), { readOnly = false } = {}) {
  const all = readStamps(file);
  const stamps = all[site] || [];
  const reads = all[READS + site] || [];
  const split = readBudget(rule);
  const verdict = (kind) => {
    try { check(site, rule, stamps, now, { reads, readOnly, kind }); return { reason: null, freeAt: null }; }
    catch (e) { if (!(e instanceof LimitReached)) throw e; return { reason: e.message, freeAt: e.freeAt ?? null }; }
  };
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  const today = (a) => a.filter((t) => t >= midnight).length;
  const lastHour = (a) => a.filter((t) => t > +now - HOUR).length;
  const left = (cap, used) => (!rule ? 0 : cap == null ? null : Math.max(0, cap - used));
  const { reason } = verdict(split ? 'read' : null);
  const usedDay = today(stamps);
  const usedHour = lastHour(split ? stamps : [...stamps, ...reads]);
  const out = { ok: !reason, reason, usedDay, usedHour, leftDay: left(rule && rule.perDay, usedDay), leftHour: left(rule && rule.perHour, usedHour) };
  if (!split) return out;
  const budget = (kind, list, caps) => {
    const v = verdict(kind);
    const usedH = lastHour(list), usedD = today(list);
    return { ok: !v.reason, reason: v.reason, usedHour: usedH, usedDay: usedD, leftHour: left(caps.perHour, usedH), leftDay: left(caps.perDay, usedD), freeAt: v.freeAt };
  };
  return { ...out, reads: budget('read', reads, split), writes: budget('write', stamps, rule) };
}

/**
 * Проверить лимит и записать задачу. Вызывать под lock().
 * readOnly: слот пишется в reads и тратит только perHour; полным его делает charge().
 * Раздельный бюджет (readsPerHour): слот чтения у любой задачи, readOnly ничего не меняет; запись — chargeWrite().
 */
function reserve(site, rule, file, now = new Date(), { readOnly = false } = {}) {
  const all = readStamps(file);
  const fresh = (a) => (a || []).filter((t) => t > +now - 48 * HOUR);
  const stamps = fresh(all[site]);
  const reads = fresh(all[READS + site]);
  if (readBudget(rule)) {
    check(site, rule, stamps, now, { reads, kind: 'read' });
    all[READS + site] = [...reads, +now];
  } else {
    check(site, rule, stamps, now, { reads, readOnly });
    if (readOnly) all[READS + site] = [...reads, +now];
    else all[site] = [...stamps, +now];
  }
  writeStamps(file, all);
}

/**
 * Раздельный бюджет: первая команда записи задачи берёт слот записи (perHour и perDay считают только записи; часы
 * работы и perDay: 0 — как у старта). Вызывать под lock() до команды; исчерпан — LimitReached с budget 'write' и
 * freeAt, команда не выполняется. Без readsPerHour — ошибка кода (там запись считает charge).
 */
function chargeWrite(site, rule, file, now = new Date()) {
  if (!readBudget(rule)) throw new Error(`chargeWrite: у ${site} нет readsPerHour — запись считает charge`);
  const all = readStamps(file);
  const stamps = (all[site] || []).filter((t) => t > +now - 48 * HOUR);
  check(site, rule, stamps, now, { kind: 'write' });
  all[site] = [...stamps, +now];
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

/**
 * Текст отказа «очередь занята»: чья задача, на какой площадке и с какого времени, сколько ждали. what — замок не
 * очереди (state.lock, wheel.lock): тогда текст называет его, а не «браузер занят».
 */
function busyText(file, timeoutMs, queue = null, what = null) {
  const h = lockHolder(file);
  const str = (v) => (typeof v === 'string' && v ? v.slice(0, 100) : null);
  const name = h && str(h.name), site = h && str(h.site);
  const since = h && Number.isFinite(h.since) ? ` с ${new Date(h.since).toTimeString().slice(0, 5)}` : '';
  const who = name ? `задачей «${name}»${site ? ` (${site})` : ''}${since}` : 'другой задачей';
  const waited = timeoutMs >= 60e3 ? `${Math.round(timeoutMs / 60e3)} мин` : `${Math.round(timeoutMs / 1000)} с`;
  if (what) return `${what}: занят ${who}, не освободился за ${waited}`;
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
 * замок всего браузера; с what — «<what>: занят …»): как исчерпанный лимит, задача не начинается, повторить позже.
 * Возвращает release(); release.update({ targetId }) дописывает в файл, какую страницу держит задача (heldTargets).
 */
async function lock(file, { pollMs = 500, timeoutMs = 30 * 60e3, heartbeatMs = 5000, staleMs = STALE_MS, holder = {}, queue = null, what = null } = {}) {
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
      if (Date.now() > until) throw new LimitReached(busyText(file, timeoutMs, queue, what));
      await sleep(pollMs);
    }
  }
}

module.exports = { ruleFor, check, peek, status, reserve, charge, chargeWrite, readBudget, lock, queueKey, queueFile, heldTargets, LimitReached };
