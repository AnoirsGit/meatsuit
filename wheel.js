/**
 * Хозяин у руля: пока он управляет браузером в зеркале, боты ждут — все площадки и все вызывающие одного dir.
 * Очереди у площадок свои (задачи разных площадок идут одновременно), а руль один на браузер.
 *
 * Руль — файл <dir>/wheel.json: { by, since, until } (мс). Действует, пока until в будущем; битый файл — как нет
 * руля (он не должен держать ботов вечно). Ставят его:
 *   - хозяин сам: node tools/wheel.js take [минуты] и give, или takeWheel/releaseWheel отсюда (require('meatsuit/wheel.js'));
 *   - connect({ ownerPresent }) — функция вызывающего, «держит ли хозяин управление» (например, check() из
 *     extras/presence.js: Neko знает, кто у руля). Ответ «да» ядро записывает рулём by: 'mirror' на WHEEL.mirrorTtlMs
 *     вперёд и продлевает, пока ответ «да»; ответ «нет» снимает только руль by: 'mirror'. Так паузу видят и
 *     вызывающие того же dir без своего ownerPresent. Сам модуль никуда не ходит и окружение не читает.
 *
 * Что делает руль с задачами — index.js: задача не входит в очередь своей площадки, пока руль у хозяина, а начатая
 * ждёт перед каждой командой act(); время ожидания в бюджет maxMinutes не входит. Ждут не дольше WHEEL.maxWaitMs,
 * потом LimitReached (задача не запускается или команда не выполняется).
 *
 * wheelState, takeWheel, releaseWheel — без браузера (test/wheel.test.js).
 */
const fs = require('node:fs');
const path = require('node:path');

const MIN = 60e3;
// Объект, а не числа: тест укорачивает сроки, не трогая список экспорта ядра (как HANG в supervise.js).
const WHEEL = {
  pollMs: 2000, // как часто ждущая задача смотрит руль и спрашивает ownerPresent
  mirrorTtlMs: 30e3, // руль от ownerPresent: столько держится после последнего «да», если спросить больше некому
  maxWaitMs: 30 * MIN, // столько задача ждёт руль до входа и перед командой, потом LimitReached
};

const fileOf = (dir) => path.join(dir, 'wheel.json');

function read(dir) {
  try { return JSON.parse(fs.readFileSync(fileOf(dir), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT' || e instanceof SyntaxError) return null; throw e; }
}

const active = (w, now) => (w && typeof w === 'object' && Number.isFinite(w.until) && w.until > now ? w : null);

/** Руль сейчас: { by, since, until } или null. */
function wheelState({ dir, now = Date.now() } = {}) {
  if (!dir) throw new Error('wheelState: нужен dir');
  const w = active(read(dir), +now);
  return w && { by: typeof w.by === 'string' ? w.by : 'owner', since: w.since, until: w.until };
}

/**
 * Взять руль: боты этого dir ждут. minutes — на сколько (по умолчанию 60, не больше суток); by — кто взял.
 * Руль уже взят дольше — срок не укорачивается. → { by, since, until }.
 */
function takeWheel({ dir, minutes = 60, by = 'owner', now = Date.now() } = {}) {
  if (!dir) throw new Error('takeWheel: нужен dir');
  if (!(typeof minutes === 'number' && minutes > 0 && minutes <= 24 * 60)) throw new Error(`takeWheel: minutes — число минут от 0 до 1440, пришло ${JSON.stringify(minutes)}`);
  if (typeof by !== 'string' || !by) throw new Error('takeWheel: by — непустая строка');
  const cur = active(read(dir), +now);
  const until = Math.max(+now + minutes * MIN, cur ? cur.until : 0);
  // Ручной руль сильнее зеркального: «да» от зеркала не превращает руль хозяина в by: 'mirror' (и «нет» его не снимет).
  const w = { by: cur && cur.by !== 'mirror' && by === 'mirror' ? cur.by : by, since: cur ? cur.since : +now, until };
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${fileOf(dir)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(w));
  fs.renameSync(tmp, fileOf(dir)); // целиком или никак: задача другого процесса не прочтёт половину
  return w;
}

/** Отдать руль. by — снять, только если руль взял этот by ('mirror' не снимает руль хозяина). → { released }. */
function releaseWheel({ dir, by, now = Date.now() } = {}) {
  if (!dir) throw new Error('releaseWheel: нужен dir');
  const w = read(dir);
  if (by !== undefined && w && w.by !== by) return { released: false };
  const was = !!active(w, +now);
  if (w) fs.rmSync(fileOf(dir), { force: true });
  return { released: was };
}

/**
 * Руль для задач одного connect(): held() — руль сейчас (спросив ownerPresent не чаще раза в WHEEL.pollMs).
 * Сбой ownerPresent — «хозяина нет» (присутствие — вежливость, а не предохранитель), причина в stderr один раз.
 */
function watcher({ dir, ownerPresent }) {
  if (ownerPresent !== undefined && typeof ownerPresent !== 'function') throw new Error('connect: ownerPresent — async-функция → true | false | { present }');
  let asked = 0;
  let failed = false;
  let inflight = null;
  const ask = async () => {
    let r;
    try { r = await ownerPresent(); failed = false; }
    catch (e) { if (!failed) console.error('meatsuit: ownerPresent не ответил, считаю, что хозяина нет:', e.message); failed = true; return; }
    const present = r === true || (!!r && typeof r === 'object' && r.present === true);
    if (present) takeWheel({ dir, by: 'mirror', minutes: WHEEL.mirrorTtlMs / MIN });
    else releaseWheel({ dir, by: 'mirror' });
  };
  async function held() {
    if (ownerPresent && Date.now() - asked >= WHEEL.pollMs) {
      asked = Date.now();
      if (!inflight) inflight = ask().finally(() => { inflight = null; });
      await inflight;
    }
    return wheelState({ dir });
  }
  return { held };
}

module.exports = { wheelState, takeWheel, releaseWheel, watcher, WHEEL };
