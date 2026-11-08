#!/usr/bin/env node
/**
 * Руль от зеркала: пока хозяин держит управление браузером в зеркале Neko, руль ботов взят — все боты этого dir
 * ждут (wheel.js ядра: задача не начинается, команда не идёт, печать обрывается). Ботам для этого ничего не нужно:
 * ни ownerPresent, ни пароля админа Neko.
 *
 *   node extras/wheel-watch.js [--dir /meatsuit/state] [--every 2.5]
 *
 * --dir — общий dir вызывающих (с зеркалом из docker/ — папка state/ тома meatsuit_profile); по умолчанию
 * MEATSUIT_DIR, иначе ~/.meatsuit, как у tools/wheel.js. --every — опрос раз в столько секунд (по умолчанию 2,5).
 * Окружение: MEATSUIT_NEKO_URL и NEKO_ADMIN_PASSWORD, как у life и server. Нет адреса, пароля или папки —
 * одна строка в stderr и код 2. Пароль не печатается.
 *
 * Каждый опрос — presence.check() (presence.js: Neko знает, кто у руля; хост, чья сессия не подключена, хозяином
 * не считается). Руль пишется функциями ядра, не копией: файл и замок <dir>/wheel.lock у всех одни.
 *   - хозяин у руля → takeWheel({ by: 'mirror' }) на WHEEL.mirrorTtlMs (30 с) вперёд — ровно то, что ядро делает
 *     для connect({ ownerPresent }): срок не укорачивается, ручной руль не становится 'mirror';
 *   - хозяина нет → releaseWheel({ by: 'mirror' }): снимается только руль зеркала, ручной — никогда;
 *   - Neko не ответил → руль не трогается: это «не знаю», а не «нет». Руль зеркала не продлевается и кончается
 *     сам через WHEEL.mirrorTtlMs после последнего «да» (ядро в этом случае руль зеркала снимает).
 * В журнал — строка на смену состояния (у руля / нет / Neko молчит / руль не записать), не на каждый опрос.
 * SIGTERM, Ctrl+C: дождаться текущего опроса, выйти из Neko и выйти; руль не трогается (перезапуск контейнера не
 * отпускает ботов, руль кончится сам). Второй сигнал или 5 с без ответа — выход сразу.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: wait } = require('node:timers/promises');
const { wheelState, takeWheel, releaseWheel, WHEEL } = require('../wheel.js');

const MIN = 60e3;
const EVERY_MS = 2500;

const pad = (n) => String(n).padStart(2, '0');
const hms = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };

/** Ждать ms; stop() прерывает ожидание. */
const abortable = (ms, signal) => wait(ms, undefined, { signal }).catch((e) => { if (e.name !== 'AbortError') throw e; });

/**
 * presence — { check, logout } из presence.js; now — часы (мс); log — строка в журнал; hide — что вычистить из строк
 * (пароль). → { step, run, stop, state }.
 */
function createWheelWatch({ dir, presence, now = Date.now, log = console.log, hide = [] } = {}) {
  if (!dir) throw new Error('wheel-watch: нужен dir');
  if (!presence || typeof presence.check !== 'function') throw new Error('wheel-watch: нужен presence с check()');
  const secrets = hide.filter((s) => typeof s === 'string' && s);
  const say = (line) => log(secrets.reduce((l, s) => l.split(s).join('***'), line));
  const ttl = WHEEL.mirrorTtlMs;
  let state = null;
  let stopped = false;
  const ac = new AbortController();

  function report(next, line) {
    if (next !== state) say(line);
    state = next;
    return { state };
  }

  /** Один опрос. Не бросает: что бы ни случилось, следующий опрос будет. → { state }. */
  async function step() {
    let who;
    try { who = await presence.check({ force: true }); }
    catch (e) { who = { present: false, error: e.message }; }
    if (who.error) return report('error', `Neko не отвечает (${who.error}): руль зеркала не продлеваю, он кончится сам за ${ttl / 1000} с`);
    try {
      if (who.present) {
        const w = await takeWheel({ dir, by: 'mirror', minutes: ttl / MIN, now: now() });
        return report('present', w.by === 'mirror'
          ? `хозяин держит управление в зеркале: руль взят до ${hms(w.until)} и продлевается, боты ждут`
          : `хозяин держит управление в зеркале; руль уже взят руками (${w.by}) до ${hms(w.until)}: срок не трогаю`);
      }
      const t = now();
      const { released } = await releaseWheel({ dir, by: 'mirror', now: t });
      const left = released ? null : wheelState({ dir, now: t });
      const why = who.stale ? 'хост зеркала отключился, не отпустив управление' : 'хозяин не держит управление в зеркале';
      return report('absent', `${why}: ${left ? `руль взят руками (${left.by}) до ${hms(left.until)}, его не трогаю`
        : released ? 'руль зеркала снят, боты работают' : 'руль свободен, боты работают'}`);
    } catch (e) {
      return report('wheel-error', `руль в ${dir} не записать (${e.message}): боты хозяина не ждут`);
    }
  }

  /** Опрос раз в everyMs, пока не stop(). В конце — выход из Neko. */
  async function run({ everyMs = EVERY_MS, sleep = abortable } = {}) {
    try {
      while (!stopped) {
        await step();
        if (stopped) break;
        await sleep(everyMs, ac.signal);
      }
    } finally {
      if (typeof presence.logout === 'function') await presence.logout().catch(() => {});
    }
  }

  function stop() { stopped = true; ac.abort(); }

  return { step, run, stop, state: () => state };
}

class Usage extends Error {}

function parseArgs(argv, env = process.env) {
  const opts = { dir: env.MEATSUIT_DIR || path.join(os.homedir(), '.meatsuit'), everyMs: EVERY_MS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir' && argv[i + 1]) opts.dir = argv[++i];
    else if (a === '--every' && argv[i + 1]) {
      const s = Number(argv[++i]);
      if (!(s >= 0.01 && s <= 60)) throw new Usage(`--every: секунды от 0.01 до 60, пришло ${JSON.stringify(argv[i])}`);
      opts.everyMs = s * 1000;
    } else throw new Usage(`непонятный аргумент ${JSON.stringify(a)}; использование: node extras/wheel-watch.js [--dir <папка состояния>] [--every <секунды>]`);
  }
  return opts;
}

/** Адрес Neko без учётных данных и пути — для журнала. */
function origin(url) {
  try { return new URL(url).origin; } catch { return null; }
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const fail = (msg) => { console.error(`wheel-watch: ${msg}`); process.exit(2); };
  let opts;
  try { opts = parseArgs(argv, env); } catch (e) { if (e instanceof Usage) fail(e.message); throw e; }
  const url = env.MEATSUIT_NEKO_URL;
  const password = env.NEKO_ADMIN_PASSWORD;
  if (!url) fail('нет MEATSUIT_NEKO_URL (адрес Neko; в compose http://127.0.0.1:8080): смотреть, кто у руля, негде');
  if (!origin(url)) fail('MEATSUIT_NEKO_URL — не адрес вида http://127.0.0.1:8080');
  if (!password) fail('нет NEKO_ADMIN_PASSWORD (пароль админа Neko из файла деплоя): без него Neko не скажет, кто у руля');
  if (!fs.statSync(opts.dir, { throwIfNoEntry: false })?.isDirectory()) fail(`нет папки ${opts.dir} (общий dir ботов: state/ тома meatsuit_profile; --dir или MEATSUIT_DIR)`);

  // Своё имя в Neko: logout при остановке не снимет сессию 'meatsuit', под которой спрашивают life и server.
  const presence = require('./presence.js').createPresence({ url, password, username: 'meatsuit-wheel' });
  const watch = createWheelWatch({ dir: opts.dir, presence, hide: [password] });

  let stopping = false;
  const onSignal = () => {
    if (stopping) process.exit(1);
    stopping = true;
    setTimeout(() => process.exit(1), 5000).unref();
    watch.stop();
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  console.log(`wheel-watch: смотрю, кто у руля в зеркале (${origin(url)}), раз в ${opts.everyMs / 1000} с; руль ботов — ${path.join(opts.dir, 'wheel.json')}`);
  await watch.run({ everyMs: opts.everyMs });
  process.exit(0);
}

if (require.main === module) main().catch((err) => { console.error(`wheel-watch: ${err.message}`); process.exit(1); });

module.exports = { createWheelWatch, parseArgs, EVERY_MS };
