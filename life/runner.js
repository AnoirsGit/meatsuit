/**
 * Оркестрация прогрева: одна сессия и цикл по расписанию. Всё внешнее приходит аргументами
 * (подключение к браузеру, часы, журнал, файл состояния, проверка выхода в сеть, сама сессия),
 * поэтому тесты гоняют её без браузера и сети, на виртуальном времени.
 *
 * Правила, ради которых она отдельно от life.js:
 *   - сбой браузера (CDP упал, Neko перезапускается) не роняет процесс: событие error, страница
 *     и соединение закрываются, в цикле старт считается сделанным;
 *   - остановка (SIGTERM, Ctrl+C) закрывает вкладку и соединение, сессия не доигрывается;
 *   - перед сессией проверяется выход в сеть: не тот — сессия пропущена, пауза суток не ставится;
 *   - файл состояния может быть оборван или недописан: планируем заново, но паузу не теряем.
 */
const { createEgress } = require('../egress.js');
const { planDay, planWeek, planSession, nextAction, startOfLocalDay, localDay, weekId } = require('./plan.js');
const { runSession, Blocked } = require('./session.js');

const H = 3600000, MIN = 60000;
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Файл состояния: чтение мусора даёт null, запись через временный файл (целиком или никак). */
function createStore({ fs = require('node:fs'), path = require('node:path'), file }) {
  return {
    read() { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } },
    write(value) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
      fs.renameSync(`${file}.tmp`, file);
    },
  };
}

/** Журнал: строка JSON в life.jsonl и краткая строка на экран. Сбой записи не роняет прогрев. */
function createJournal({ fs = require('node:fs'), path = require('node:path'), dir, now = Date.now, print = console.log }) {
  return (entry) => {
    const line = { ts: new Date(now()).toISOString(), ...entry };
    print(`${line.ts.slice(11, 19)} ${entry.event}${entry.url ? ` ${entry.url}` : ''}${entry.result ? ` → ${entry.result}` : ''}${entry.reason ? ` (${entry.reason})` : ''}`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'life.jsonl'), `${JSON.stringify(line)}\n`);
    } catch (err) { print(`  (не записан в журнал: ${err.message})`); }
  };
}

/**
 * Состояние планировщика из того, что лежало в файле. Целое — как есть; с дырами — только пауза
 * (день спланируется заново, но суточная пауза после капчи не должна пропасть); не объект — null.
 */
function cleanState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const pausedUntil = Number.isFinite(raw.pausedUntil) ? raw.pausedUntil : 0;
  const whole = typeof raw.day === 'string' && Array.isArray(raw.starts) && raw.starts.every(Number.isFinite)
    && Array.isArray(raw.done) && raw.done.every(Number.isFinite);
  const week = raw.week && typeof raw.week.id === 'string' && Array.isArray(raw.week.days) && raw.week.days.every((d) => typeof d === 'string') ? raw.week : undefined;
  const out = whole ? { day: raw.day, starts: raw.starts, done: raw.done, pausedUntil } : { pausedUntil };
  if (week) out.week = week; // пустой ключ не добавляем
  return out;
}

/** Проверка выхода в сеть по файлу egress.json; нет файла — null (не проверяем), неверный — ошибка. */
function loadEgress({ fs = require('node:fs'), file, fetch } = {}) {
  if (!fs.existsSync(file)) return null;
  let expected;
  try { expected = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { throw new Error(`egress: ${file} не читается как JSON (${err.message})`); }
  return createEgress({ expected, fetch });
}

/**
 * connect() → { openPage(), close() }; store → { read(), write(v) }; egress — { check() } или null;
 * session — runSession (подменяется в тестах). cfg уже прошёл normalizeConfig.
 */
function createRunner({ cfg, connect, store, journal = () => {}, egress = null, now = Date.now, sleep = realSleep, rnd = Math.random, session = runSession }) {
  let stopping = false;
  let active = null; // { link, page }: что открыто сейчас, stop() закрывает это
  let busy = false;  // идёт сессия: об остановке пишет stop() (процесс выходит сразу после него)
  const clock = (ms) => new Date(ms).toLocaleTimeString('ru-RU', { timeZone: cfg.tz, hour: '2-digit', minute: '2-digit' });

  /** null — можно идти; иначе запись egress-wrong для журнала. */
  async function egressVerdict() {
    if (!egress) { journal({ event: 'warning', reason: 'выход в сеть не проверяется (нет egress.json)' }); return null; }
    let r;
    try { r = await egress.check({ force: true }); } catch (err) { r = { ok: false, error: 'egress_unknown', detail: err.message }; }
    if (r.ok) return null;
    return { event: 'egress-wrong', reason: r.error, country: r.country ?? null, asn: r.asn ?? null, ...(r.org ? { org: r.org } : {}), ...(r.detail ? { detail: r.detail } : {}) };
  }

  /**
   * Одна сессия. Не бросает: итог 'ok' | 'blocked' | 'error' | 'egress-wrong' | 'stopped'.
   * Капча или блок ставят state.pausedUntil.
   */
  async function oneSession(state) {
    if (stopping) return 'stopped';
    busy = true;
    try { return await sessionBody(state); } finally { busy = false; }
  }

  async function sessionBody(state) {
    const wrong = await egressVerdict();
    if (wrong) { journal(wrong); return 'egress-wrong'; }
    if (stopping) return 'stopped';

    const steps = planSession(cfg, rnd);
    journal({ event: 'session-start', steps: steps.map((s) => ({ url: s.url, kind: s.kind, minutes: +(s.budgetMs / MIN).toFixed(1), follow: s.follow })) });
    let stage = 'connect', link = null, page = null;
    try {
      link = await connect();
      active = { link, page: null };
      if (stopping) return 'stopped';
      stage = 'page';
      page = await link.openPage();
      active.page = page;
      if (stopping) return 'stopped';
      stage = 'session';
      const out = await session(page, steps, { log: journal, env: { sleep, now, rnd }, consent: cfg.consent });
      journal({ event: 'session-end', ...(out && out.cut ? { cut: true } : {}) });
      return 'ok';
    } catch (err) {
      if (stopping) return 'stopped';
      if (err instanceof Blocked) {
        state.pausedUntil = now() + cfg.cooldownHours * H;
        journal({ event: 'cooldown', reason: err.reason, url: err.url, until: new Date(state.pausedUntil).toISOString() });
        return 'blocked';
      }
      const what = { connect: 'не подключиться к браузеру', page: 'не открыть вкладку', session: null }[stage];
      journal({ event: 'error', reason: what ? `${what}: ${err.message}` : err.message });
      return 'error';
    } finally {
      active = null;
      if (page) await page.close().catch(() => {});
      if (link) await link.close().catch(() => {}); // close только отключает нас, браузер живёт
    }
  }

  /**
   * node life.js now: одна сессия сейчас. В паузе (после капчи или блока) без force не запускается:
   * { result: 'paused', until }. Иначе { result }, как у oneSession.
   */
  async function runNow({ force = false } = {}) {
    const state = cleanState(store.read()) || {};
    if (state.pausedUntil > now()) {
      if (!force) return { result: 'paused', until: state.pausedUntil };
      journal({ event: 'warning', reason: `пауза до ${new Date(state.pausedUntil).toISOString()}, запуск по --force` });
    }
    const result = await oneSession(state);
    if (result === 'blocked') store.write({ ...(cleanState(store.read()) || {}), pausedUntil: state.pausedUntil });
    return { result };
  }

  /** node life.js run: по расписанию, пока не вызовут stop(). */
  async function loop() {
    let state = cleanState(store.read());
    while (!stopping) {
      try {
        const t = now();
        const action = nextAction(state, t, cfg);
        if (action.type === 'replan') {
          const day = localDay(t, cfg.tz);
          // Какие дни недели рабочие, выбирается один раз на неделю и хранится: перезапуск не перетасует дни.
          const week = state && state.week && state.week.id === weekId(t, cfg.tz) ? state.week : planWeek(t, cfg, rnd);
          const working = week.days.includes(day);
          const starts = working ? planDay(startOfLocalDay(t, cfg.tz), cfg, rnd).filter((s) => s > t - cfg.lateMinutes * MIN) : [];
          state = { day, starts, done: [], pausedUntil: state ? state.pausedUntil || 0 : 0, week };
          store.write(state);
          journal({ event: 'plan', day, starts, reason: starts.length ? `старты ${starts.map(clock).join(', ')}` : working ? 'без сессий' : 'выходной' });
        } else if (action.type === 'wait') {
          await sleep(Math.min(Math.max(action.until - t, 1000), MIN)); // просыпаемся раз в минуту: часы могли уйти
        } else {
          if (action.type === 'run' && (await oneSession(state)) === 'stopped') break; // прерванный старт не сделан
          state.done.push(action.start);
          store.write(state);
        }
      } catch (err) {
        journal({ event: 'error', reason: err.message });
        await sleep(MIN); // ломается что-то постоянное (диск, часы): не крутиться вхолостую
      }
    }
  }

  /** Остановка: закрыть вкладку и соединение, сессия не доигрывается, цикл выходит. */
  async function stop() {
    stopping = true;
    if (busy) journal({ event: 'stopped', reason: 'сессия прервана остановкой' });
    const a = active;
    if (a) {
      if (a.page) await a.page.close().catch(() => {});
      await a.link.close().catch(() => {});
    }
  }

  return { runNow, loop, stop, oneSession };
}

module.exports = { createRunner, createStore, createJournal, loadEgress, cleanState };
