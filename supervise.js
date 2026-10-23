/**
 * Присмотр за задачей: оборачивает see/act руками hands в guard, бюджет и стоп.
 *
 *   const { api, state } = supervise(h, { name, site, notify, maxCommands, maxMinutes, codeLogin? });
 *
 * codeLogin — { path: RegExp, maxMinutes? } из codeLoginRule (guard.js): задача входит по одноразовому коду.
 * Тогда guard не считает стопом страницу входа на этом пути площадки (если на ней нет поля пароля), а бюджет
 * задачи урезан: не больше CODE_LOGIN_MAX_COMMANDS команд и не дольше codeLogin.maxMinutes, если задано.
 *   ... await fn(api) ...; state.finish();
 *
 * После NeedsHuman (капча, вход, уход с площадки) стоп не снимается: все следующие
 * вызовы бросают ту же ошибку, даже если проект её поймал. state.stopped говорит
 * вызывающему, что окно надо оставить человеку.
 */
const { check: guardCheck, NeedsHuman, CODE_LOGIN_MAX_COMMANDS } = require('./guard.js');

class BudgetExceeded extends Error {}

// Сторож задачи (index.js): сколько ждать сверх maxMinutes, прежде чем считать задачу зависшей. Срок проверяется
// перед каждой командой, а начатая команда не обрывается: самая долгая — fill на 2000 знаков, до ~13 минут печати.
// Объект, а не число: тест укорачивает запас, не трогая список экспорта ядра.
const HANG = { graceMs: 15 * 60e3 };

// В уведомление уходит адрес без query и hash: там бывают токены входа и коды подтверждения.
const publicUrl = (url) => { try { const u = new URL(url); return u.origin + u.pathname; } catch { return 'неизвестный адрес'; } };

const onSite = (url, hosts) => {
  if (url === 'about:blank') return true;
  try { const host = new URL(url).hostname; return hosts.some((h) => host === h || host.endsWith('.' + h)); } catch { return false; }
};

/** Команда записи: меняет что-то на площадке. Клик не по заведомой вкладке считается записью. */
// Команды, которые трогают содержимое страницы: перед ними страница проверяется заново (guard до команды).
// goto, back, scroll и wait — нет: они не нажимают и не вводят ничего на текущей странице.
const TOUCHES = new Set(['click', 'fill', 'type', 'press', 'select', 'upload']);

const isWrite = (c, els) => {
  if (c.cmd === 'fill' || c.cmd === 'type' || c.cmd === 'select' || c.cmd === 'upload') return true;
  if (c.cmd === 'press') return c.key === 'Enter';
  if (c.cmd === 'click') return !(els && els.gen === c.gen && els.elements.some((e) => e.id === c.id && e.role === 'tab'));
  return false;
};

function supervise(h, { name, site, extraHosts = [], notify, maxCommands, maxMinutes, onWrite, codeLogin = null }) {
  const guardOpts = codeLogin ? { codeLogin: { site, path: codeLogin.path } } : {};
  if (codeLogin) {
    maxCommands = Math.min(maxCommands, CODE_LOGIN_MAX_COMMANDS);
    if (codeLogin.maxMinutes) maxMinutes = Math.min(maxMinutes, codeLogin.maxMinutes);
  }
  const hosts = [site, ...extraHosts]; // площадка и хосты, где страница может оказаться (extraHosts из task)
  let els = null; // последний виденный список элементов: по нему отличаем клик по вкладке
  const state = { stopped: null, finished: false, commands: 0, maxCommands, maxMinutes, finish() { state.finished = true; } };
  const deadline = Date.now() + maxMinutes * 60e3;

  const stopIfNeeded = async (snap) => {
    let reason = guardCheck(snap, guardOpts);
    if (!reason && !onSite(snap.url, hosts)) reason = `страница вне площадки ${site}`;
    if (!reason) return;
    state.stopped = new NeedsHuman(reason, snap.url);
    try { await notify(`meatsuit: «${name}» на ${site} остановлен: ${reason}. ${publicUrl(snap.url)}`); }
    catch (e) { console.error('meatsuit: не удалось отправить уведомление:', e.message); }
    throw state.stopped;
  };

  const ensureOpen = () => {
    if (state.stopped) throw state.stopped;
    if (state.finished) throw new Error(`${name}: задача уже завершена`);
    if (Date.now() > deadline) throw new BudgetExceeded(`${name}: вышло время (${maxMinutes} мин)`);
  };

  const api = {
    async see(o) { ensureOpen(); const s = await h.see(o); await stopIfNeeded(s); if (s.elements) els = s; return s; },
    async act(c) {
      ensureOpen();
      if (++state.commands > maxCommands) throw new BudgetExceeded(`${name}: больше ${maxCommands} команд`);
      // Guard до команды: капча, блок, вход или чужой хост могли появиться, пока вызывающий думал после see(), и не
      // накрыть цель (проверка точки под курсором её не видит). Тогда стоп до нажатия, а не после (ревью скрытности
      // 20.10, как у сервиса из extras/). Свежий снимок не меняет id и gen вызывающего.
      if (TOUCHES.has(c && c.cmd) && h.probe) await stopIfNeeded(await h.probe());
      if (onWrite && isWrite(c, els)) { const f = onWrite; onWrite = null; f(); } // до команды и один раз: слот один, дневной лимит может остановить запись
      const r = await h.act(c);
      if (!r.dryRun && r.elements) els = r;
      if (!r.dryRun) await stopIfNeeded(r); // результат dryRun — не снимок, у него нет url: страница не менялась

      return r;
    },
  };
  return { api, state };
}

module.exports = { supervise, BudgetExceeded, HANG };
