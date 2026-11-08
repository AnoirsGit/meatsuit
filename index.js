/**
 * Подключение проекта к общему браузеру.
 *
 *   const ms = await connect({ cdpUrl: 'http://browser:9222', sitesFile: './sites.json', notify });
 *   await ms.task('tinder:match-chat', async ({ see, act }) => {
 *     const snap = await see();
 *     await act({ cmd: 'click', id: 3, gen: snap.gen });
 *   }, { site: 'tinder.com' });
 *
 * task(): руль хозяина → очередь своей площадки → лимит площадки → своё окно (или своя вкладка площадки) →
 * задача под присмотром guard и бюджета → окно закрывается. Очереди у площадок свои: задачи разных площадок
 * (tinder-matcher, cvs, датчик Telegram — один браузер) идут одновременно, каждая в своём окне; задачи одной
 * площадки — по одной. Руль один на все: пока хозяин у руля (wheel.js), не входит и не жмёт никто.
 * На NeedsHuman окно остаётся открытым: я решаю капчу в зеркале руками.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { hands, replay, journalUrl, BadCommand, StaleElement } = require('./hands.js');
const { NeedsHuman, check: guardCheck, codeLoginRule } = require('./guard.js');
const eyes = require('./eyes.js');
const { StaleWorld } = require('./dom.js');
const tabs = require('./tabs.js');
const { telegramNotifier, createTelegram, findChats, TelegramError } = require('./telegram.js');
const { openWindow } = require('./window.js');
const { supervise, BudgetExceeded, HANG } = require('./supervise.js');
const { signature, normalizeName, urlPattern } = require('./capture.js');
const { ruleFor, reserve, charge, peek: peekLimit, status: limitStatus, lock, queueKey, queueFile, LimitReached } = require('./limits.js');
const { loadPersona } = require('./human/persona-file.js');
const holds = require('./holds.js');
const { watcher: wheelWatcher, WHEEL } = require('./wheel.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const minutes = (ms) => (ms >= 60e3 ? `${Math.round(ms / 60e3)} мин` : `${Math.round(ms / 1000)} с`);

/**
 * Лимиты площадок принадлежат вызывающему проекту: путь к его sites.json (читается на каждую задачу,
 * правка действует без перезапуска) или сам объект. Своего sites.json у meatsuit нет, только образец.
 */
function sitesSource({ sitesFile, sites }) {
  const hint = 'образец: sites.example.json в meatsuit';
  if (sitesFile && sites) throw new Error('connect: нужен либо sitesFile, либо sites, не оба');
  if (sites) {
    if (typeof sites !== 'object' || Array.isArray(sites)) throw new Error(`connect: sites — объект { "хост": { perDay, … } } (${hint})`);
    return () => sites;
  }
  if (!sitesFile) throw new Error(`connect: нужен sitesFile (путь к своему sites.json) или sites (объект лимитов); ${hint}`);
  if (!fs.existsSync(sitesFile)) throw new Error(`connect: нет файла лимитов ${sitesFile} (${hint})`);
  return () => JSON.parse(fs.readFileSync(sitesFile, 'utf8'));
}

const DEFAULT_DIR = path.join(os.homedir(), '.meatsuit');

/**
 * Сколько осталось у площадки — без браузера, без очереди и без траты слота (проверка перед запуском, отчёт).
 * Те же sitesFile|sites и dir, что у connect(): ошибки файла лимитов те же. Счётчики не пишет.
 * → { site, rule, ok, reason, usedDay, usedHour, leftDay, leftHour } (см. status() в limits.js).
 */
function peek(site, { sitesFile, sites, dir = DEFAULT_DIR, now = new Date(), readOnly = false } = {}) {
  if (!site) throw new Error('peek: нужен site');
  const rule = ruleFor(sitesSource({ sitesFile, sites })(), site);
  return { site, rule: rule || null, ...limitStatus(site, rule, path.join(dir, 'limits.json'), now, { readOnly }) };
}

/**
 * Стоп площадки после NeedsHuman (holds.js) — без браузера, тот же dir, что у connect().
 * holdState → { site, reason, url, since, until } или null; releaseHold → { released }.
 */
const holdState = (site, { dir = DEFAULT_DIR, now } = {}) => holds.holdState(site, { dir, now });
const releaseHold = (site, { dir = DEFAULT_DIR, now } = {}) => holds.releaseHold(site, { dir, now });

/**
 * Вход по одноразовому коду: нужны оба согласия — опция задачи и правило в своей записи площадки
 * в sites.json вызывающего (не в "*"). Без опции → null (правило площадки ни на что не влияет).
 * С опцией, но без правила или с неверным правилом — ошибка до очереди и браузера.
 */
function codeLoginFor(sites, site, optIn) {
  if (optIn === false || optIn === undefined) return null;
  if (optIn !== true) throw new Error('task: codeLogin — true или false');
  const own = Object.hasOwn(sites, site) ? sites[site] : null;
  if (!own || own.codeLogin === undefined) throw new Error(`task: codeLogin — у площадки ${site} в sites.json нет своего "codeLogin": { "path": "^/…" } (из "*" не берётся)`);
  return codeLoginRule(own.codeLogin);
}

// Так Playwright отвечает про вкладку, которой уже нет: «Target page, context or browser has been closed»,
// «…: page: no object with guid …» (подключение уже забыло вкладку), «Target closed», «Session closed».
const CLOSED_PAGE = /has been closed|no object with guid|Target closed|Session closed/i;

const isHost = (h) => typeof h === 'string' && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(h);

async function connect({
  cdpUrl,
  dir = DEFAULT_DIR,
  sitesFile, // свой sites.json вызывающего проекта…
  sites, // …или объект лимитов; без одного из них connect не стартует
  notify = async () => {},
  // Какие события отправлять в notify(text, event). По умолчанию только плохие: на каждую
  // задачу-матч писать «ок» значило бы засыпать группу. Проект сам шлёт итог запуска.
  notifyOn = ['needsHuman', 'limit', 'error'],
  // Держит ли хозяин управление в зеркале: async () → true | false | { present } (например, check() из
  // extras/presence.js с паролем админа Neko вызывающего). Ответ «да» ставит руль на всех вызывающих этого dir.
  ownerPresent,
} = {}) {
  if (!cdpUrl) throw new Error('connect: нужен cdpUrl');
  const loadSites = sitesSource({ sitesFile, sites }); // до подключения: без лимитов браузер не трогаем
  const wheel = wheelWatcher({ dir, ownerPresent }); // кривой ownerPresent — ошибка до браузера
  const browser = await chromium.connectOverCDP(cdpUrl);
  fs.mkdirSync(dir, { recursive: true });
  loadPersona(dir); // повадки человека (темп руки и печати, опечатки) — в <dir>/persona.json: тот же человек после перезапуска

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

  // Чтение-правка-запись общих файлов dir (limits.json, tabs.json) — под коротким замком состояния: задачи разных
  // площадок идут одновременно, в том числе из разных процессов, и без замка одна затёрла бы запись другой
  // (пропавшая отметка лимита — лишняя задача сверх perDay).
  const atomically = async (fn) => {
    const release = await lock(path.join(dir, 'state.lock'), { pollMs: 10, heartbeatMs: 1000, staleMs: 10000, timeoutMs: 60e3 });
    try { return await fn(); } finally { release(); }
  };

  // Руль у хозяина: ждать, пока отпустит, не дольше WHEEL.maxWaitMs, иначе LimitReached с полем wheel.
  // what — хвост текста ошибки («команда не выполнена»); alive — задача ещё жива (сработал сторож — ждать нечего).
  async function waitWheel({ what = '', before = false, alive = () => true } = {}) {
    const until = Date.now() + WHEEL.maxWaitMs;
    for (let w = await wheel.held(); w; w = await wheel.held()) {
      if (!alive()) return;
      if (Date.now() >= until) {
        const who = w.by === 'mirror' ? 'хозяин у руля в зеркале' : `хозяин взял руль до ${holds.clock(w.until)}`;
        const e = new LimitReached(`${who}, ждали ${minutes(WHEEL.maxWaitMs)}${what ? `: ${what}` : ''}`);
        e.wheel = w;
        if (before) e.before = true; // команда не выполнялась
        throw e;
      }
      await sleep(Math.max(10, Math.min(WHEEL.pollMs, until - Date.now())));
    }
  }

  // Очередь своей площадки (limits.queueFile: <dir>/queue/<ключ>.lock) — «один бот за раз на площадке».
  // Порядок: руль → замок площадки → замок всего браузера прежней версии ядра, если он есть → руль ещё раз.
  // Руль взяли, пока ждали замок, — замок отдаём (другие задачи площадки ждут руль так же) и ждём руль снаружи.
  async function enterQueue(name, site) {
    const holder = { name, site };
    for (;;) {
      await waitWheel();
      const release = await lock(queueFile(dir, site), { holder, queue: queueKey(site) });
      try {
        // <dir>/queue.lock — замок всего браузера у вызывающего на прежней версии ядра: пока он держит браузер, эта
        // версия не входит (пройти сквозь замок — взять и сразу отдать). Обратного прежняя версия не знает: её задача
        // может войти, пока идут задачи этой. Обновлять всех вызывающих одного dir вместе.
        const legacy = path.join(dir, 'queue.lock');
        if (fs.existsSync(legacy)) (await lock(legacy, { holder }))();
      } catch (e) { release(); throw e; }
      if (!(await wheel.held())) return release;
      release();
    }
  }

  // singleTab: ищем уже открытую вкладку площадки (по хосту); нет её — undefined, окно откроет task() после reserve.
  // Вкладку могли закрыть прямо перед задачей (человек в зеркале, другой клиент CDP): подключение узнаёт об этом
  // событием чуть позже и ещё отдаёт её в pages(). Такую пропускаем, а не падаем «Target page … closed».
  // Из нескольких вкладок площадки рабочая — на экране, иначе с самой свежей активностью; остальные без активности
  // дольше staleTabHours закрываются (правило и исключения — tabs.js). Отметки — в <dir>/tabs.json.
  async function siteTab(site, codeLogin, onExamine = () => {}, { hours = 0, dryRun = false, alive = () => true } = {}) {
    const onSite = (u) => hostOn(u, site);
    const tabsFile = path.join(dir, 'tabs.json');
    const seen = [];
    let busy; // вкладка сменила документ во время снимка: в этот раз её не трогаем (ни выбора, ни закрытия)
    for (const found of browser.contexts()[0].pages()) {
      if (found.isClosed() || !onSite(found.url())) continue;
      onExamine(found); // сторож задачи закроет её, если снимок повиснет
      // Снимок без команд: на вкладке может быть капча, которую решает человек (оставлена прошлой задачей,
      // в том числе другим процессом), её не трогаем.
      let snap, info;
      try { snap = await eyes.see(found); info = await tabs.probe(found); }
      catch (e) {
        if (found.isClosed() || CLOSED_PAGE.test(e.message)) continue;
        if (e instanceof StaleWorld) { busy = busy || e; continue; }
        throw e;
      }
      if (!onSite(snap.url)) continue; // вкладку только что увели с площадки, а подключение ещё помнит старый адрес
      const reason = guardCheck(snap, codeLogin ? { codeLogin: { site, path: codeLogin.path } } : {});
      seen.push({ page: found, ...info, url: snap.url, title: snap.title, reason, typed: tabs.typed(snap) });
    }
    if (!alive()) return; // сработал сторож: очередь уже отдана, ничего не закрываем и не пишем
    const now = Date.now();
    const known = tabs.load(tabsFile);
    const state = tabs.update(known, seen, now);
    const chosen = tabs.pick(seen, state);
    if (chosen) onExamine(chosen.page);
    for (const t of dryRun ? [] : tabs.stale(seen, state, chosen, hours, now)) {
      await t.page.close().catch(() => {});
      journal({ ts: new Date(now).toISOString(), dryRun: false, cmd: { cmd: 'closeTab' }, url: journalUrl(t.url), result: 'ok', idleHours: Math.round((now - state[t.id].at) / tabs.HOUR) });
    }
    // Playwright мог не увидеть существующую вкладку (Debian Chromium): тогда новую не открываем, чтобы не плодить дубль.
    const session = await browser.newBrowserCDPSession();
    let targetInfos;
    try { ({ targetInfos } = await session.send('Target.getTargets')); }
    finally { await session.detach().catch(() => {}); }
    // tabs.json общий: пока эта задача смотрела свои вкладки, задача другой площадки могла записать свои отметки.
    // Поверх файла как он есть сейчас — только отметки своих вкладок; убираются записи вкладок, которых нет, но только
    // те, что были в файле до проверки (новую отметку чужой задачи список целей, снятый раньше, ещё не знает).
    const live = new Set(targetInfos.filter((t) => t.type === 'page').map((t) => t.targetId));
    const mine = Object.fromEntries(seen.filter((t) => live.has(t.id)).map((t) => [t.id, state[t.id]]));
    await atomically(() => {
      const cur = tabs.load(tabsFile);
      tabs.save(tabsFile, { ...tabs.prune(cur, Object.keys(cur).filter((id) => live.has(id) || !(id in known))), ...mine });
    });
    if (chosen) {
      if (chosen.reason) throw new NeedsHuman(chosen.reason, chosen.url);
      return chosen.page;
    }
    if (busy) throw busy; // как раньше: ни одна вкладка площадки не дала снимок — ошибка снимка, а не новое окно
    if (targetInfos.some((t) => t.type === 'page' && onSite(t.url))) throw new Error(`singleTab: вкладка ${site} есть, но Playwright её не видит`);
  }

  // Отметить активность вкладки сейчас (под замком состояния: tabs.json общий у всех площадок). Сбой не роняет задачу:
  // худшее — вкладка простоит дольше.
  async function touchTab(page) {
    try {
      const file = path.join(dir, 'tabs.json');
      const id = await tabs.targetId(page);
      await atomically(() => { const state = tabs.load(file); tabs.save(file, { ...state, [id]: { ...state[id], at: Date.now() } }); });
    } catch (e) { console.error('meatsuit: отметка вкладки не записана:', e.message); }
  }

  // Строка журнала рук не от команды (закрытая вкладка). Не записалась — не беда: причина в stderr, как в hands.js.
  const journal = (entry) => {
    try { fs.appendFileSync(path.join(dir, 'journal.jsonl'), JSON.stringify(entry) + '\n'); }
    catch (e) { console.error('meatsuit: не удалось записать журнал:', e.message); }
  };

  async function task(name, fn, { site, extraHosts = [], uploadDirs = [], maxCommands = 60, maxMinutes = 10, dryRun = false, dryRunNavigation = false, readOnly = false, capture, codeLogin: codeLoginOpt = false } = {}) {
    if (!site) throw new Error('task: нужен site');
    // Хосты, где страница может оказаться без стопа (страница «спасибо» на сайте компании после формы ATS).
    // goto туда нельзя, лимиты и счётчики — по site.
    if (!Array.isArray(extraHosts) || !extraHosts.every(isHost)) throw new Error('task: extraHosts — массив хостов вида company.com (без схемы, пути и «*»)');
    // Каталоги вызывающего, откуда upload может брать файлы (резюме); без них upload выключен.
    if (!Array.isArray(uploadDirs) || !uploadDirs.every((d) => typeof d === 'string' && path.isAbsolute(d))) throw new Error('task: uploadDirs — массив абсолютных путей к каталогам');
    const sitesNow = loadSites();
    const rule = ruleFor(sitesNow, site); // своя запись или "*"
    const codeLogin = codeLoginFor(sitesNow, site, codeLoginOpt); // вход по коду: опция задачи + своя запись площадки
    // Потолок бюджета задаёт площадка, а не вызывающий проект.
    if (rule && rule.maxCommands) maxCommands = Math.min(maxCommands, rule.maxCommands);
    if (rule && rule.maxMinutes) maxMinutes = Math.min(maxMinutes, rule.maxMinutes);
    const staleHours = rule && rule.singleTab ? tabs.staleHours(rule) : 0; // кривой staleTabHours — ошибка до очереди
    const holdFor = holds.holdHours(rule); // кривой holdHours — тоже
    // Стоп площадки после прошлого NeedsHuman: в браузер не идём, очередь не ждём, слот не тратим, notify не шлём
    // (о стопе уже сообщили, когда его ставили).
    // В команде снятия — --dir этой задачи: release.js без него берёт MEATSUIT_DIR, а connect() эту переменную не читает.
    const onHold = () => {
      const held = holds.holdState(site, { dir });
      if (!held) return null;
      const e = new NeedsHuman(`${site} на стопе до ${holds.clock(held.until)} после «${held.reason}»; снять раньше — releaseHold('${site}') или node tools/release.js ${site} --dir ${JSON.stringify(dir)}`, held.url);
      e.hold = held;
      e.onHold = true;
      return e;
    };
    const heldBefore = onHold();
    if (heldBefore) throw heldBefore;

    // Очередь «один бот за раз» — своя у площадки (queueKey: поддомены вместе), общая у всех вызывающих одного dir.
    // Задачи других площадок в это время идут. Площадка занята дольше срока или хозяин не отпускает руль —
    // LimitReached с тем, кто занял (повторить позже), а не ошибка: вызывающий не должен считать это своей поломкой.
    let release;
    try { release = await enterQueue(name, site); }
    catch (e) {
      if (e instanceof LimitReached) await emit('limit', `meatsuit: «${name}» не запущена: ${e.message}`);
      throw e;
    }
    // Пока ждали очередь, задача другого процесса на этой площадке могла упереться в капчу и поставить стоп.
    const heldNow = onHold();
    if (heldNow) { release(); throw heldNow; }
    let released = false;
    const unlock = () => { if (!released) { released = true; release(); } };
    let page;
    let examined = null; // вкладка площадки, которую siteTab снимает до того, как она станет окном задачи
    let opened = false; // окно открыла эта задача
    let onPopup;
    let run; // присмотр за задачей: стоп, бюджет, конец
    let hung = null; // сработал сторож: BudgetExceeded «задача не закончилась»
    const started = Date.now();
    // Сторож. maxMinutes проверяется перед каждой командой, но зависшая страница (бесконечный цикл в её скрипте:
    // CDP не отвечает) или зависшее ожидание в коде вызывающего держали бы задачу — и очередь её площадки —
    // вечно, замок при этом обновлялся бы. Через maxMinutes + HANG.graceMs задача кончается: окно закрывается
    // (зависшие вызовы на странице обрываются; после NeedsHuman окно остаётся человеку), следующие see/act бросают,
    // очередь свободна. Начатая длинная команда (fill до ~13 минут) в запас укладывается.
    // Пока хозяин у руля, задача не зависла, а ждёт: срок сторожа сдвигается на время ожидания (run.state.pausedMs).
    const hangMs = Number.isFinite(maxMinutes) && maxMinutes > 0 ? maxMinutes * 60e3 + HANG.graceMs : null;
    let watchdog = null;
    const onHang = () => {
      const left = started + hangMs + (run ? run.state.pausedMs() : 0) - Date.now();
      if (left > 0) { watchdog = setTimeout(onHang, left); watchdog.unref(); return; }
      const keep = !!(run && run.state.stopped);
      const took = minutes(hangMs);
      hung = new BudgetExceeded(`${name}: задача не закончилась за ${took} (страница или код вызывающего не отвечает), ${keep ? 'окно оставлено человеку' : 'окно закрыто'}`);
      if (run) run.state.finish();
      const p = page || examined;
      if (p && !keep) p.close().catch(() => {});
      unlock();
      emit('error', `meatsuit: «${name}» на ${site} зависла: ${hung.message}`);
    };
    if (hangMs) { watchdog = setTimeout(onHang, hangMs); watchdog.unref(); }
    try {
      const found = rule && rule.singleTab ? await siteTab(site, codeLogin, (p) => { examined = p; }, { hours: staleHours, dryRun, alive: () => !hung }) : null; // до reserve: сбой поиска не тратит слот
      if (hung) throw hung;
      const limitsFile = path.join(dir, 'limits.json');
      const slot = new Date();
      try { // репетиция квоту не тратит; запись отметки — под замком состояния (limits.json общий у всех площадок)
        if (dryRun) peekLimit(site, rule, limitsFile, slot, { readOnly });
        else await atomically(() => reserve(site, rule, limitsFile, slot, { readOnly }));
      }
      catch (e) {
        if (e instanceof LimitReached) await emit('limit', `meatsuit: «${name}» не запущена: ${e.message}`);
        throw e;
      }
      page = found || await openWindow(browser);
      opened = !found;
      if (hung) throw hung;
      botPages.add(page);
      onPopup = (p) => { botPages.add(p); p.close().catch(() => {}); }; // новые вкладки бот не ведёт
      page.on('popup', onPopup);
      const h = hands(page, { dryRun, dryRunNavigation, logFile: path.join(dir, 'journal.jsonl'), allowedHosts: [site], uploadDirs, capture });
      // Хозяин взял руль посреди задачи: команда ждёт его (окно и очередь площадки остаются за задачей). Не дождались —
      // LimitReached с before: true, команда не выполнялась.
      const pause = async () => {
        try { await waitWheel({ what: 'команда не выполнена', before: true, alive: () => !hung }); }
        catch (e) { if (e instanceof LimitReached) await emit('limit', `meatsuit: «${name}» на ${site} остановлена: ${e.message}`); throw e; }
      };
      run = supervise(h, { name, site, extraHosts, notify: (t) => emit('needsHuman', t), maxCommands, maxMinutes, codeLogin, pause,
        onWrite: readOnly && !dryRun ? () => atomically(() => charge(site, rule, limitsFile, slot)) : null }); // read-only задача записала: полный слот задним числом
      await emit('start', `meatsuit: «${name}» на ${site} запущена${dryRun ? ' (dryRun)' : ''}`);
      if (hung) throw hung;
      const result = await fn(run.api);
      if (hung) throw hung; // код вызывающего вернулся уже после сторожа
      if (run.state.stopped) throw run.state.stopped; // проект проглотил NeedsHuman и вернулся как ни в чём не бывало
      await emit('done', `meatsuit: «${name}» на ${site} завершена за ${Math.round((Date.now() - started) / 1000)} с, команд: ${run.state.commands}`);
      return result;
    } catch (err) {
      // Любой NeedsHuman (guard ядра или проект) ставит стоп площадки на holdHours: cron не заходит на капчу снова.
      const stop = err instanceof NeedsHuman ? err : run && run.state.stopped;
      if (stop) {
        try { stop.hold = holds.hold(site, { dir, reason: stop.reason ?? stop.message, url: stop.url, hours: holdFor }) || undefined; }
        catch (e) { console.error(`meatsuit: не удалось поставить стоп ${site}:`, e.message); }
      }
      if (hung) throw hung; // сторож уже сообщил; зависший вызов оборвался закрытием окна — причина в зависании
      // NeedsHuman уже отправлен из supervise; остальное (бюджет, сбой в проекте) сообщаем здесь.
      if (err instanceof NeedsHuman && !run) await emit('needsHuman', `meatsuit: «${name}» на ${site} остановлен: ${err.message}`); // при взятии вкладки supervise ещё не создан
      if (!(err instanceof NeedsHuman) && !(err instanceof LimitReached)) {
        await emit('error', `meatsuit: «${name}» на ${site} упала: ${err.message}`);
      }
      throw err;
    } finally {
      clearTimeout(watchdog);
      if (run) run.state.finish();
      if (page && rule && rule.singleTab) { // вкладка площадки живёт дальше: убираем только свои следы
        page.off('popup', onPopup);
        botPages.delete(page);
        if (opened && !(run && run.state.stopped) && !hostOn(page.url(), site)) await page.close().catch(() => {}); // задача упала до goto: пустое окно не копим
        if (run && !hung && !page.isClosed()) await touchTab(page); // бот работал во вкладке — это её активность
      } else if (page && !(run && run.state.stopped)) await page.close().catch(() => {});
      unlock();
    }
  }

  return { task, close: () => browser.close() };
}

// telegramNotifier и остальное из telegram.js — помощник для вызывающего (токен и группу передаёт он);
// оставлены здесь для совместимости импорта, новым проектам проще require('meatsuit/telegram.js').
module.exports = { connect, hands, replay, signature, normalizeName, urlPattern, NeedsHuman, LimitReached, BudgetExceeded, BadCommand, StaleElement, telegramNotifier, createTelegram, findChats, TelegramError, peek, holdState, releaseHold };
