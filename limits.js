/**
 * Лимиты площадки, часы работы и очередь «один бот за раз».
 *
 * check() — чистая функция (test/limits.test.js). Площадки нет в sites.json —
 * значит нельзя: по умолчанию закрыто.
 */
const fs = require('node:fs');
const path = require('node:path');

class LimitReached extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOUR = 3600e3;

function parseHours(s) {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(s);
  if (!m || +m[1] > 24 || +m[2] > 24 || m[1] === m[2]) throw new Error(`hours: ждали "10-21", пришло ${JSON.stringify(s)}`);
  return [+m[1], +m[2]];
}

/** Бросает LimitReached. stamps — времена прошлых задач площадки, мс. */
function check(site, rule, stamps, now = new Date()) {
  if (!rule) throw new LimitReached(`${site}: площадка не описана в sites.json`);
  if (rule.perDay === 0) throw new LimitReached(`${site}: perDay 0, бот здесь ничего не делает`);
  if (rule.hours) {
    const [a, b] = parseHours(rule.hours);
    const h = now.getHours();
    const inside = a < b ? h >= a && h < b : h >= a || h < b;
    if (!inside) throw new LimitReached(`${site}: вне часов работы ${rule.hours}`);
  }
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  if (rule.perDay != null && stamps.filter((t) => t >= midnight).length >= rule.perDay) {
    throw new LimitReached(`${site}: исчерпан лимит на сегодня (${rule.perDay})`);
  }
  if (rule.perHour != null && stamps.filter((t) => t > +now - HOUR).length >= rule.perHour) {
    throw new LimitReached(`${site}: исчерпан лимит на час (${rule.perHour})`);
  }
}

const readStamps = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
};

/** Только проверить лимит, ничего не записывая (для dryRun: репетиция не должна съедать квоту). */
function peek(site, rule, file, now = new Date()) {
  check(site, rule, readStamps(file)[site] || [], now);
}

/** Проверить лимит и записать задачу. Вызывать под lock(). */
function reserve(site, rule, file, now = new Date()) {
  let all = {};
  try { all = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const stamps = (all[site] || []).filter((t) => t > +now - 48 * HOUR);
  check(site, rule, stamps, now);
  all[site] = [...stamps, +now];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(all));
}

/**
 * Межпроцессный замок на файле. Держатель раз в heartbeatMs обновляет mtime;
 * замок старше staleMs считается брошенным и забирается атомарным rename.
 * По PID нельзя: в контейнере после перезапуска PID тот же, и замок жил бы вечно.
 * Возвращает release().
 */
async function lock(file, { pollMs = 500, timeoutMs = 30 * 60e3, heartbeatMs = 5000, staleMs = 30000 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
      const beat = setInterval(() => { try { const t = new Date(); fs.utimesSync(file, t, t); } catch {} }, heartbeatMs);
      beat.unref();
      return () => { clearInterval(beat); try { fs.unlinkSync(file); } catch {} };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let age = 0;
      try { age = Date.now() - fs.statSync(file).mtimeMs; } catch { continue; } // исчез между проверками
      if (age > staleMs) {
        const dead = `${file}.dead-${process.pid}-${Date.now()}`;
        try { fs.renameSync(file, dead); fs.unlinkSync(dead); } catch {} // из нескольких ждущих rename удастся одному
        continue;
      }
      if (Date.now() > until) throw new Error('очередь: не дождались своей очереди');
      await sleep(pollMs);
    }
  }
}

module.exports = { check, peek, reserve, lock, LimitReached };
