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
const { NeedsHuman, check: guardCheck } = require('./guard.js');
const eyes = require('./eyes.js');
const { telegramNotifier, createTelegram, findChats, TelegramError } = require('./telegram.js');
const { openWindow } = require('./window.js');
const { supervise, BudgetExceeded } = require('./supervise.js');
const { signature, normalizeName, urlPattern } = require('./capture.js');
const { ruleFor, reserve, charge, peek, lock, LimitReached } = require('./limits.js');

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

  const hostOn = (u, site) => { try { const h = new URL(u).hostname; return h === site || h.endsWith('.' + site); } catch { return false; } };

  // singleTab: ищем уже открытую вкладку площадки (по хосту); нет её — undefined, окно откроет task() после reserve.
  async function siteTab(site) {
    const onSite = (u) => hostOn(u, site);
    const found = browser.contexts()[0].pages().find((p) => onSite(p.url()));
    if (found) {
      // Снимок без команд: на вкладке может быть капча, которую решает человек (оставлена прошлой задачей,
      // в том числе другим процессом), её не трогаем.
      const snap = await eyes.see(found);
      const reason = guardCheck(snap);
      if (reason) throw new NeedsHuman(reason, snap.url);
      return found;
    }
    // Playwright мог не увидеть существующую вкладку (Debian Chromium): тогда новую не открываем, чтобы не плодить дубль.
    const session = await browser.newBrowserCDPSession();
    try {
      const { targetInfos } = await session.send('Target.getTargets');
      if (targetInfos.some((t) => t.type === 'page' && onSite(t.url))) throw new Error(`singleTab: вкладка ${site} есть, но Playwright её не видит`);
    } finally { await session.detach().catch(() => {}); }
  }

  async function task(name, fn, { site, maxCommands = 60, maxMinutes = 10, dryRun = false, dryRunNavigation = false, readOnly = false, capture } = {}) {
    if (!site) throw new Error('task: нужен site');
    const rule = ruleFor(JSON.parse(fs.readFileSync(sitesFile, 'utf8')), site); // своя запись или "*"
    // Потолок бюджета задаёт площадка, а не вызывающий проект.
    if (rule && rule.maxCommands) maxCommands = Math.min(maxCommands, rule.maxCommands);
    if (rule && rule.maxMinutes) maxMinutes = Math.min(maxMinutes, rule.maxMinutes);

    const release = await lock(path.join(dir, 'queue.lock'));
    let page;
    let opened = false; // окно открыла эта задача
    let onPopup;
    let run; // присмотр за задачей: стоп, бюджет, конец
    const started = Date.now();
    try {
      const found = rule && rule.singleTab ? await siteTab(site) : null; // до reserve: сбой поиска не тратит слот
      const limitsFile = path.join(dir, 'limits.json');
      const slot = new Date();
      try { (dryRun ? peek : reserve)(site, rule, limitsFile, slot, { readOnly }); } // репетиция квоту не тратит
      catch (e) {
        if (e instanceof LimitReached) await emit('limit', `meatsuit: «${name}» не запущена: ${e.message}`);
        throw e;
      }
      page = found || await openWindow(browser);
      opened = !found;
      botPages.add(page);
      onPopup = (p) => { botPages.add(p); p.close().catch(() => {}); }; // новые вкладки бот не ведёт
      page.on('popup', onPopup);
      const h = hands(page, { dryRun, dryRunNavigation, logFile: path.join(dir, 'journal.jsonl'), allowedHosts: [site], capture });
      run = supervise(h, { name, site, notify: (t) => emit('needsHuman', t), maxCommands, maxMinutes,
        onWrite: readOnly && !dryRun ? () => charge(site, rule, limitsFile, slot) : null }); // read-only задача записала: полный слот задним числом
      await emit('start', `meatsuit: «${name}» на ${site} запущена${dryRun ? ' (dryRun)' : ''}`);
      const result = await fn(run.api);
      if (run.state.stopped) throw run.state.stopped; // проект проглотил NeedsHuman и вернулся как ни в чём не бывало
      await emit('done', `meatsuit: «${name}» на ${site} завершена за ${Math.round((Date.now() - started) / 1000)} с, команд: ${run.state.commands}`);
      return result;
    } catch (err) {
      // NeedsHuman уже отправлен из supervise; остальное (бюджет, сбой в проекте) сообщаем здесь.
      if (err instanceof NeedsHuman && !run) await emit('needsHuman', `meatsuit: «${name}» на ${site} остановлен: ${err.message}`); // при взятии вкладки supervise ещё не создан
      if (!(err instanceof NeedsHuman) && !(err instanceof LimitReached)) {
        await emit('error', `meatsuit: «${name}» на ${site} упала: ${err.message}`);
      }
      throw err;
    } finally {
      if (run) run.state.finish();
      if (page && rule && rule.singleTab) { // вкладка площадки живёт дальше: убираем только свои следы
        page.off('popup', onPopup);
        botPages.delete(page);
        if (opened && !(run && run.state.stopped) && !hostOn(page.url(), site)) await page.close().catch(() => {}); // задача упала до goto: пустое окно не копим
      } else if (page && !(run && run.state.stopped)) await page.close().catch(() => {});
      release();
    }
  }

  return { task, close: () => browser.close() };
}

module.exports = { connect, hands, replay, signature, normalizeName, urlPattern, NeedsHuman, LimitReached, BudgetExceeded, BadCommand, StaleElement, telegramNotifier, createTelegram, findChats, TelegramError };
