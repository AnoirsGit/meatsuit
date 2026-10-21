/**
 * Замок на браузер между процессами: HTTP-сервис и прогрев живут в разных контейнерах, но руки
 * у браузера одни. Кто взял замок, тот и работает; второй ждёт или пропускает. Замок — файл в общем
 * каталоге data (у контейнеров это один том): { holder, since, until }. Срок until защищает от
 * упавшего держателя: просроченный замок берётся свободно. Держатель продлевает срок, пока работает.
 *
 *   const lease = createLease({ file: 'data/browser.lock', holder: 'server' })
 *   lease.acquire(ttlMs)  → { ok: true } или { ok: false, holder, until }
 *   lease.renew(ttlMs)    → продлить свой замок (чужой не трогает)
 *   lease.release()       → снять свой замок
 *   lease.peek()          → { holder, since, until } | null (чужой или свой, не просроченный)
 *
 * Запись через временный файл и rename: оборванная запись не оставит полузамка. Гонка двух процессов,
 * берущих замок в одну миллисекунду, не исключена (файл — не мьютекс), но оба процесса работают
 * минутами и с паузами в минуты, поэтому цена гонки — одна совместная сессия, а не поломка.
 * Время и файловая система подставляются.
 */
const nodeFs = require('node:fs');
const path = require('node:path');

function createLease({ file, holder, fs = nodeFs, now = Date.now }) {
  if (!file || !holder) throw new Error('lease: нужны file и holder');

  function read() {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
    try {
      const v = JSON.parse(text);
      return v && typeof v.holder === 'string' && Number.isFinite(v.until) && Number.isFinite(v.since) ? v : null; // мусор — как нет замка
    } catch { return null; }
  }

  function write(v) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(v));
    fs.renameSync(`${file}.tmp`, file);
  }

  /** Действующий замок (свой или чужой) или null. */
  function peek() {
    const v = read();
    return v && v.until > now() ? v : null;
  }

  const mine = (v) => !!v && v.holder === holder;

  function acquire(ttlMs) {
    const cur = peek();
    if (cur && !mine(cur)) return { ok: false, holder: cur.holder, until: cur.until };
    const t = now();
    write({ holder, since: mine(cur) ? cur.since : t, until: t + ttlMs });
    return { ok: true };
  }

  function renew(ttlMs) {
    const cur = peek();
    if (!mine(cur)) return false;
    write({ ...cur, until: now() + ttlMs });
    return true;
  }

  function release() {
    const cur = read();
    if (!mine(cur)) return false;
    try { fs.unlinkSync(file); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    return true;
  }

  return { acquire, renew, release, peek, holder };
}

module.exports = { createLease };
