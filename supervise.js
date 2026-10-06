/**
 * Присмотр за задачей: оборачивает see/act руками hands в guard, бюджет и стоп.
 *
 *   const { api, state } = supervise(h, { name, site, notify, maxCommands, maxMinutes });
 *   ... await fn(api) ...; state.finish();
 *
 * После NeedsHuman (капча, вход, уход с площадки) стоп не снимается: все следующие
 * вызовы бросают ту же ошибку, даже если проект её поймал. state.stopped говорит
 * вызывающему, что окно надо оставить человеку.
 */
const { check: guardCheck, NeedsHuman } = require('./guard.js');

class BudgetExceeded extends Error {}

// В уведомление уходит адрес без query и hash: там бывают токены входа и коды подтверждения.
const publicUrl = (url) => { try { const u = new URL(url); return u.origin + u.pathname; } catch { return 'неизвестный адрес'; } };

const onSite = (url, site) => {
  if (url === 'about:blank') return true;
  try { const host = new URL(url).hostname; return host === site || host.endsWith('.' + site); } catch { return false; }
};

function supervise(h, { name, site, notify, maxCommands, maxMinutes }) {
  const state = { stopped: null, finished: false, commands: 0, finish() { state.finished = true; } };
  const deadline = Date.now() + maxMinutes * 60e3;

  const stopIfNeeded = async (snap) => {
    let reason = guardCheck(snap);
    if (!reason && !onSite(snap.url, site)) reason = `страница вне площадки ${site}`;
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
    async see(o) { ensureOpen(); const s = await h.see(o); await stopIfNeeded(s); return s; },
    async act(c) {
      ensureOpen();
      if (++state.commands > maxCommands) throw new BudgetExceeded(`${name}: больше ${maxCommands} команд`);
      const r = await h.act(c);
      if (!r.dryRun) await stopIfNeeded(r); // результат dryRun — не снимок, у него нет url: страница не менялась

      return r;
    },
  };
  return { api, state };
}

module.exports = { supervise, BudgetExceeded };
