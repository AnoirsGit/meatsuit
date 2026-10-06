/**
 * Подключение проекта к общему браузеру.
 *
 *   const ms = await connect({ cdpUrl: 'http://browser:9222', notify });
 *   await ms.task('tinder:match-chat', async ({ see, act }) => {
 *     const snap = await see();
 *     await act({ cmd: 'click', id: 3, gen: snap.gen });
 *   }, { site: 'tinder.com' });
 *
 * task(): очередь → лимит площадки → отдельное окно → задача под присмотром
 * guard и бюджета → окно закрывается. На NeedsHuman окно остаётся открытым:
 * я решаю капчу в зеркале руками.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { hands, replay, BadCommand, StaleElement } = require('./hands.js');
const { NeedsHuman } = require('./guard.js');
const { telegramNotifier, createTelegram, findChats, TelegramError } = require('./telegram.js');
const { openWindow } = require('./window.js');
const { supervise, BudgetExceeded } = require('./supervise.js');
const { reserve, peek, lock, LimitReached } = require('./limits.js');

async function connect({
  cdpUrl,
  dir = path.join(os.homedir(), '.meatsuit'),
  sitesFile = path.join(__dirname, 'sites.json'),
  notify = async () => {},
  // Какие события отправлять в notify(text, event). По умолчанию только плохие: на каждую
  // задачу-матч писать «ок» значило бы засыпать группу. Проект сам шлёт итог запуска.
  notifyOn = ['needsHuman', 'limit', 'error'],
} = {}) {
  if (!cdpUrl) throw new Error('connect: нужен cdpUrl');
  const browser = await chromium.connectOverCDP(cdpUrl);
  fs.mkdirSync(dir, { recursive: true });

  // Пока есть подключение, Playwright сам отклоняет все диалоги во ВСЕХ вкладках, если на
  // контексте нет слушателя. Слушатель есть, и он трогает только окна бота: мои оставляет мне.
  const botPages = new WeakSet();
  browser.contexts()[0].on('dialog', (d) => { if (botPages.has(d.page())) d.dismiss().catch(() => {}); });

  const emit = async (event, text) => {
    if (!notifyOn.includes(event)) return;
    try { await notify(text, event); }
    catch (e) { console.error('meatsuit: не удалось отправить уведомление:', e.message); }
  };

  async function task(name, fn, { site, maxCommands = 60, maxMinutes = 10, dryRun = false } = {}) {
    if (!site) throw new Error('task: нужен site');
    const rule = JSON.parse(fs.readFileSync(sitesFile, 'utf8'))[site];
    // Потолок бюджета задаёт площадка, а не вызывающий проект.
    if (rule && rule.maxCommands) maxCommands = Math.min(maxCommands, rule.maxCommands);
    if (rule && rule.maxMinutes) maxMinutes = Math.min(maxMinutes, rule.maxMinutes);

    const release = await lock(path.join(dir, 'queue.lock'));
    let page;
    let run; // присмотр за задачей: стоп, бюджет, конец
    const started = Date.now();
    try {
      try { (dryRun ? peek : reserve)(site, rule, path.join(dir, 'limits.json')); } // репетиция квоту не тратит
      catch (e) {
        if (e instanceof LimitReached) await emit('limit', `meatsuit: «${name}» не запущена: ${e.message}`);
        throw e;
      }
      page = await openWindow(browser);
      botPages.add(page);
      page.on('popup', (p) => { botPages.add(p); p.close().catch(() => {}); }); // новые вкладки бот не ведёт
      const h = hands(page, { dryRun, logFile: path.join(dir, 'journal.jsonl'), allowedHosts: [site] });
      run = supervise(h, { name, site, notify: (t) => emit('needsHuman', t), maxCommands, maxMinutes });
      await emit('start', `meatsuit: «${name}» на ${site} запущена${dryRun ? ' (dryRun)' : ''}`);
      const result = await fn(run.api);
      if (run.state.stopped) throw run.state.stopped; // проект проглотил NeedsHuman и вернулся как ни в чём не бывало
      await emit('done', `meatsuit: «${name}» на ${site} завершена за ${Math.round((Date.now() - started) / 1000)} с, команд: ${run.state.commands}`);
      return result;
    } catch (err) {
      // NeedsHuman уже отправлен из supervise; остальное (бюджет, сбой в проекте) сообщаем здесь.
      if (!(err instanceof NeedsHuman) && !(err instanceof LimitReached)) {
        await emit('error', `meatsuit: «${name}» на ${site} упала: ${err.message}`);
      }
      throw err;
    } finally {
      if (run) run.state.finish();
      if (page && !(run && run.state.stopped)) await page.close().catch(() => {});
      release();
    }
  }

  return { task, close: () => browser.close() };
}

module.exports = { connect, hands, replay, NeedsHuman, LimitReached, BudgetExceeded, BadCommand, StaleElement, telegramNotifier, createTelegram, findChats, TelegramError };
