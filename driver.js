/**
 * Driver: весь доступ сервиса к браузеру. Patchright connectOverCDP к уже
 * запущенному браузеру (моему, с моими входами); руки — human.js, глаза — view.js.
 *
 *   const driver = await createDriver({ cdpUrl })
 *   const { id } = await driver.open({ site, allow })   // отдельное окно; allow — разрешённые для goto хосты
 *   await driver.view(id, { scope })                    // { html, url, title, guard }
 *   await driver.act(id, action)                        // { ok, url, settled, guard }
 *   await driver.resume(id)                             // { guard }: перепроверить после ручного решения капчи
 *   await driver.close(id)
 *
 * Все ошибки — DriverError с status и code (400 bad_request, 403 forbidden, 404 not_found,
 * 409 needs_human, 410 stale_ref, 422 ambiguous), плюс 502 nav_failed и 503 browser_gone.
 *
 * Окно, а не вкладка. context.newPage() через CDP зовёт Target.createTarget без newWindow:
 * проверено на настоящем Chromium, страница получает тот же windowId, то есть открывается
 * вкладкой в чужом окне (моём). Поэтому окно создаётся браузерным сеансом CDP,
 * Target.createTarget {newWindow: true}, и страница находится по targetId.
 *
 * Ссылка с target=_blank или window.open открывает вкладку в окне задачи: окно следует за ней
 * (view и act работают со всплывшей страницей), закрылась она — возвращается к прежней.
 */
const human = require('./human.js');
const { between, clamp, lognormal } = require('./human/random.js');
const { classify } = require('./guard.js');
const probe = require('./life/probe.js');
const V = require('./view.js');

// ---------------------------------------------------------------- ошибки

const STATUS = { bad_request: 400, forbidden: 403, not_found: 404, needs_human: 409, stale_ref: 410, ambiguous: 422, nav_failed: 502, browser_gone: 503 };

/**
 * new DriverError('stale_ref', 'номер устарел', { …поля })       status берётся по code
 * new DriverError(409, 'needs_human', 'капча', { guard })          или задаётся явно
 * new DriverError({ status, code, message, …поля })
 */
class DriverError extends Error {
  constructor(...args) {
    let status, code, message, extra;
    if (args[0] && typeof args[0] === 'object') ({ status, code, message, ...extra } = args[0]);
    else if (typeof args[0] === 'number') [status, code, message, extra] = args;
    else [code, message, extra] = args;
    super(message || code);
    this.name = 'DriverError';
    this.status = status ?? STATUS[code] ?? 500;
    this.code = code;
    Object.assign(this, extra);
  }
}
const bad = (message) => new DriverError('bad_request', message);

// ---------------------------------------------------------------- разбор запроса (чистые функции)

/** Цель действия: число — номер из view, строка — текст, { css } — селектор, { ref } — номер (так отдаются кандидаты). */
function parseTarget(target) {
  if (typeof target === 'number') {
    if (!Number.isInteger(target) || target < 1) throw bad('target: номер — целое число от 1');
    return { ref: target };
  }
  if (typeof target === 'string') {
    const text = target.trim();
    if (!text) throw bad('target: пустой текст');
    return { text }; // строка из цифр — тоже текст (кнопка «2» в пагинации); номер приходит числом
  }
  if (target && typeof target === 'object' && !Array.isArray(target)) {
    const keys = Object.keys(target);
    if (keys.length === 1 && keys[0] === 'css' && typeof target.css === 'string' && target.css.trim()) return { css: target.css };
    if (keys.length === 1 && keys[0] === 'ref') return parseTarget(target.ref);
  }
  throw bad('target: номер из view, текст кнопки или {"css":"…"}');
}

const MAX_PAUSE = 60000;
const MAX_SCROLL = 20000; // колесом по-человечески это около минуты

/** Проверить действие и привести к виду для выполнения. begin, end, resume сюда не попадают: это дело сервера. */
function parseAction(action) {
  if (!action || typeof action !== 'object' || typeof action.do !== 'string') throw bad('действие: нужно поле do');
  const need = (name, type) => { if (typeof action[name] !== type) throw bad(`${action.do}: нужно поле ${name} (${type === 'string' ? 'строка' : 'число'})`); return action[name]; };
  switch (action.do) {
    case 'goto': {
      const url = need('url', 'string');
      if (!url.trim()) throw bad('goto: пустой url');
      return { do: 'goto', url };
    }
    case 'click': return { do: 'click', target: parseTarget(action.target) };
    case 'fill': return { do: 'fill', target: parseTarget(action.target), text: need('text', 'string') };
    case 'type': return { do: 'type', text: need('text', 'string') };
    case 'key': {
      const key = need('key', 'string');
      if (!key || key.length > 40) throw bad('key: название клавиши, например Enter');
      return { do: 'key', key };
    }
    case 'scroll': {
      const hasPx = action.px !== undefined, hasTo = action.to !== undefined;
      if (hasPx === hasTo) throw bad('scroll: нужно одно из px или to');
      if (hasTo) {
        if (action.to !== 'bottom' && action.to !== 'top') throw bad('scroll: to — bottom или top');
        return { do: 'scroll', to: action.to };
      }
      if (typeof action.px !== 'number' || !Number.isFinite(action.px) || action.px === 0 || Math.abs(action.px) > MAX_SCROLL) throw bad(`scroll: px — число от -${MAX_SCROLL} до ${MAX_SCROLL}, не ноль`);
      return { do: 'scroll', px: action.px };
    }
    case 'back': return { do: 'back' };
    case 'pause': {
      const from = action.from === undefined ? 300 : action.from;
      const to = action.to === undefined ? Math.max(from, 1200) : action.to;
      if (![from, to].every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_PAUSE) || from > to) throw bad(`pause: from и to в миллисекундах, от 0 до ${MAX_PAUSE}, from не больше to`);
      return { do: 'pause', from, to };
    }
    case 'begin': case 'end': case 'resume': throw bad(`${action.do}: жизненный цикл задачи, к Driver не относится`);
    default: throw bad(`неизвестное действие «${String(action.do).slice(0, 40)}»`);
  }
}

/** Хост из записи списка разрешённых: «hh.kz», «*.hh.kz», «https://hh.kz/app». */
function hostOfEntry(entry) {
  let s = String(entry || '').trim().toLowerCase();
  if (!s) return null;
  if (s.includes('://')) { try { s = new URL(s).hostname; } catch { return null; } }
  s = s.replace(/^\*?\./, '').replace(/[/:].*$/, '');
  return s || null;
}

/** Хост разрешён, если он сам в списке или его поддомен (hh.kz → spb.hh.kz); порт не важен. */
function hostAllowed(host, allow) {
  const h = String(host || '').toLowerCase();
  if (!h) return false;
  return (allow || []).some((entry) => { const e = hostOfEntry(entry); return e && (h === e || h.endsWith(`.${e}`)); });
}

/**
 * Адрес для goto: только http(s) и только разрешённые хосты. Относительный (/путь, ?запрос, #якорь)
 * разбирается от текущей страницы base. Возвращает абсолютный адрес.
 */
function checkGoto(url, allow, base) {
  const raw = String(url).trim();
  let u;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) {
    try { u = new URL(raw, base && /^https?:/i.test(base) ? base : 'http://invalid.invalid/'); } catch { throw bad('goto: не адрес'); }
  } else if (/^[/?#]/.test(raw)) {
    if (!base || !/^https?:/i.test(base)) throw bad('goto: относительный адрес, а страницы ещё нет');
    try { u = new URL(raw, base); } catch { throw bad('goto: не адрес'); }
  } else {
    throw bad('goto: нужен полный адрес http(s)://…');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new DriverError('forbidden', `goto: только http и https, а не ${u.protocol}`);
  if (!u.hostname || u.hostname === 'invalid.invalid') throw bad('goto: нет хоста');
  if (!hostAllowed(u.hostname, allow)) throw new DriverError('forbidden', `goto: хост ${u.hostname} вне сайтов задачи`);
  return u.href;
}

// ---------------------------------------------------------------- «страница успокоилась»

const IGNORED_TYPES = new Set(['websocket', 'eventsource', 'media', 'ping']); // долгоживущие потоки: сети «тихо» они не мешают

/**
 * Следит за сетью страницы: идущие запросы и время последней активности.
 * Запрос, который тянется дольше longMs (долгий опрос, потоковая выдача), не считается:
 * иначе чат или аналитика не дали бы странице «успокоиться» никогда.
 */
function watchNetwork(page, { now = Date.now, longMs = 5000 } = {}) {
  const open = new Map();
  let last = now();
  const onRequest = (r) => { if (!IGNORED_TYPES.has(r.resourceType())) open.set(r, now()); last = now(); };
  const onDone = (r) => { if (open.delete(r)) last = now(); };
  const onNavigated = () => { last = now(); };
  page.on('request', onRequest);
  page.on('requestfinished', onDone);
  page.on('requestfailed', onDone);
  page.on('framenavigated', onNavigated);
  const pending = () => { const t = now(); let n = 0; for (const since of open.values()) if (t - since < longMs) n++; return n; };
  return {
    pending,
    quietFor: () => (pending() ? 0 : now() - last),
    touch: () => { last = now(); },
    dispose() {
      page.off('request', onRequest); page.off('requestfinished', onDone); page.off('requestfailed', onDone); page.off('framenavigated', onNavigated);
      open.clear();
    },
  };
}

/** Ждать, пока сеть тиха quietMs (отсчёт от конца действия), но не дольше maxMs. false — не дождались, это не ошибка. */
async function settle(net, { quietMs = 500, maxMs = 10000, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  net.touch();
  const t0 = now();
  for (;;) {
    if (net.quietFor() >= quietMs) return true;
    const spent = now() - t0;
    if (spent >= maxMs) return false;
    await sleep(Math.min(50, maxMs - spent));
  }
}

/**
 * Выбрать вариант в <select> настоящими событиями. selectOption у Playwright выставляет значение сам и шлёт
 * синтетические input и change (isTrusted: false), страница это видит. Поэтому: мышь подходит к списку, он
 * получает фокус, и вариант выбирается стрелками, как у человека, не раскрывая список (его окно у браузера
 * с экраном рисуется отдельно, и мышью до него не дотянуться). Если стрелки не привели к нужному варианту
 * (недоступные варианты в списке), вариант ставится через selectOption: верное значение важнее.
 */
async function chooseOption(page, el, index, hands) {
  const at = () => el.evaluate((s) => s.selectedIndex);
  const from = await at();
  if (from === index) return;
  await human.hover(page, el, hands);
  await el.focus();
  const key = index > from ? 'ArrowDown' : 'ArrowUp';
  for (let i = Math.abs(index - from); i > 0; i--) {
    await hands.sleep(between(hands.rnd, 140, 380));
    await human.press(page, key, hands);
  }
  if (await at() !== index) await el.selectOption({ index });
}

// ---------------------------------------------------------------- Driver

/**
 * Подключиться к браузеру. cdpUrl (или cdp, как зовёт server.js): http://127.0.0.1:9222 или ws-адрес.
 * Необязательно: env { sleep, now, rnd } — часы и случайность рук (в тестах человеческий темп ускоряют);
 * settle { quietMs, maxMs, longMs } — ожидание успокоения по настоящим часам (по умолчанию 500 мс, 10 с, 5 с).
 */
async function createDriver({ cdpUrl, cdp, env = {}, settle: settleOpts = {} } = {}) {
  const endpoint = cdpUrl || cdp;
  if (!endpoint) throw bad('createDriver: нужен cdpUrl');
  const { chromium } = require('patchright'); // позже, чтобы require('./driver.js') ради DriverError не требовал браузера

  const browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0] || await browser.newContext(); // основной контекст: профиль с моими входами
  const bcdp = await browser.newBrowserCDPSession();
  let dead = false;
  browser.on('disconnected', () => { dead = true; });

  const hands = { sleep: env.sleep || human.sleep, now: env.now || Date.now, rnd: env.rnd || Math.random };
  const wait = { quietMs: 500, maxMs: 10000, longMs: 5000, ...settleOpts };
  const windows = new Map();
  let counter = 0;

  const alive = () => { if (dead) throw new DriverError('browser_gone', 'браузер отключился'); };

  /** Страница → targetId: так среди страниц контекста находится именно та, что создана нами. */
  async function targetIdOf(page) {
    const s = await context.newCDPSession(page);
    try { return (await s.send('Target.getTargetInfo')).targetInfo.targetId; } finally { await s.detach().catch(() => {}); }
  }

  async function newWindow() {
    let made;
    const known = new Promise((resolve) => { made = resolve; });
    const waiting = context.waitForEvent('page', { timeout: 15000, predicate: async (p) => (await targetIdOf(p).catch(() => null)) === await known });
    waiting.catch(() => {}); // если Target.createTarget упадёт, висящее ожидание не должно давать необработанную ошибку
    try {
      const { targetId } = await bcdp.send('Target.createTarget', { url: 'about:blank', newWindow: true });
      made(targetId);
      return await waiting;
    } catch (err) {
      made(null);
      throw new DriverError('browser_gone', `не удалось открыть окно: ${err.message}`, { status: 503 });
    }
  }

  /** Страницы окна: подписка на сеть, всплывающие вкладки. */
  function adopt(w, page) {
    const net = watchNetwork(page, { longMs: wait.longMs });
    w.nets.set(page, net);
    w.pages.push(page);
    w.page = page;
    page.on('popup', (popup) => { net.touch(); adopt(w, popup); });
    page.on('close', () => {
      net.dispose();
      w.nets.delete(page);
      w.pages = w.pages.filter((p) => p !== page);
      if (w.page === page) w.page = w.pages[w.pages.length - 1] || null;
    });
  }

  function win(id) {
    alive();
    const w = windows.get(id);
    if (!w) throw new DriverError('not_found', `нет окна ${String(id).slice(0, 40)}`);
    if (!w.page || w.page.isClosed()) { windows.delete(id); throw new DriverError('not_found', 'окно закрыто'); }
    return w;
  }

  // ---- цели

  /** Элемент по цели: номер из view, текст или css. Ни нашлось, ни единственное — ошибка. */
  async function resolve(page, target) {
    if (target.ref !== undefined) {
      const el = await V.element(page, target.ref);
      if (!el) throw new DriverError('stale_ref', `номер ${target.ref} устарел: перечитай view`);
      return el;
    }
    const css = target.css !== undefined;
    const found = await V.find(page, css ? { css: target.css } : { text: target.text });
    if (found.error) throw bad(`css: некорректный селектор ${JSON.stringify(target.css).slice(0, 80)}`);
    const what = css ? `css ${JSON.stringify(target.css).slice(0, 80)}` : `«${target.text.slice(0, 80)}»`;
    if (!found.matches.length) throw new DriverError('not_found', `среди видимых нет ${what}`);
    if (found.matches.length > 1) {
      throw new DriverError('ambiguous', `${what}: подходит несколько элементов (${found.total})`, { candidates: found.matches.slice(0, 20).map(({ ref, text }) => ({ ref, text })) });
    }
    const el = await V.element(page, found.matches[0].ref);
    if (!el) throw new DriverError('stale_ref', `${what}: элемент пропал`);
    return el;
  }

  /** Работа с найденным элементом; пропал из-под рук — устаревший номер; дескриптор отпускается. */
  async function withElement(page, target, fn) {
    const el = await resolve(page, target);
    try { return await fn(el); } catch (err) {
      if (err instanceof DriverError) throw err;
      if (!(await el.isVisible().catch(() => false))) throw new DriverError('stale_ref', 'элемент пропал со страницы, перечитай view');
      throw err;
    } finally {
      el.dispose().catch(() => {});
    }
  }

  // ---- действия

  const TEXT_INPUT_BLOCKED = /^(checkbox|radio|button|submit|reset|image|file|hidden|range|color)$/;

  const doers = {
    async goto(w, a) {
      const url = checkGoto(a.url, w.allow, w.page.url());
      try { await w.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (err) {
        throw new DriverError('nav_failed', `goto ${url}: ${err.message.split('\n')[0]}`);
      }
    },

    click: (w, a) => withElement(w.page, a.target, (el) => human.click(w.page, el, hands)),

    fill: (w, a) => withElement(w.page, a.target, async (el) => {
      const kind = await el.evaluate((e) => {
        const tag = e.localName;
        if (tag === 'select') return { kind: 'select' };
        const text = tag === 'textarea' || (tag === 'input' && !/^(checkbox|radio|button|submit|reset|image|file|hidden|range|color)$/.test(e.type));
        if (!text && !e.isContentEditable) return { kind: 'none', tag };
        return { kind: 'text', filled: (tag === 'input' || tag === 'textarea' ? e.value : e.textContent).length > 0 };
      });
      if (kind.kind === 'none') throw bad(`fill: ${kind.tag} — не поле ввода`);
      if (kind.kind === 'select') {
        // у выпадающего списка нет DOM, по которому можно кликнуть мышью: вариант выбирается по тексту (точно, потом по вхождению) или value
        const index = await el.evaluate((s, t) => {
          const o = [...s.options], low = t.toLowerCase();
          const at = (f) => o.findIndex(f);
          const i = at((x) => x.text.trim() === t); if (i >= 0) return i;
          const v = at((x) => x.value === t); if (v >= 0) return v;
          return at((x) => x.text.toLowerCase().includes(low));
        }, a.text);
        if (index < 0) throw bad(`fill: в списке нет варианта «${a.text.slice(0, 60)}»`);
        await chooseOption(w.page, el, index, hands);
        return;
      }
      await human.click(w.page, el, hands); // клик в поле даёт фокус
      if (kind.filled) {
        await hands.sleep(between(hands.rnd, 80, 220));
        await w.page.keyboard.press('ControlOrMeta+A');
        await hands.sleep(between(hands.rnd, 80, 220));
        await w.page.keyboard.press('Backspace');
        await hands.sleep(between(hands.rnd, 120, 350));
      }
      if (a.text) await human.type(w.page, a.text, hands);
    }),

    type: (w, a) => human.type(w.page, a.text, hands),

    async key(w, a) {
      await hands.sleep(clamp(lognormal(hands.rnd, 170, 0.4), 80, 600)); // собраться нажать
      try { await w.page.keyboard.press(a.key, { delay: clamp(lognormal(hands.rnd, 70, 0.3), 40, 160) }); } catch (err) {
        if (/unknown key/i.test(err.message)) throw bad(`key: неизвестная клавиша «${a.key}»`);
        throw err;
      }
    },

    async scroll(w, a) {
      if (a.px !== undefined) return human.scroll(w.page, a.px, hands);
      const dir = a.to === 'top' ? -1 : 1;
      let stuck = 0, last = -1;
      for (let i = 0; i < 40; i++) { // страница с бесконечной лентой растёт без конца: сорок рывков — предел
        const m = await probe.metrics(w.page);
        if (dir > 0 ? m.scrollY + m.innerH >= m.height - 4 : m.scrollY <= 0) return;
        stuck = Math.abs(m.scrollY - last) < 1 ? stuck + 1 : 0;
        if (stuck >= 2) return; // колесо не двигает страницу: прокручивается что-то другое или конец
        last = m.scrollY;
        await human.scroll(w.page, dir * between(hands.rnd, 700, 1500), hands);
      }
    },

    async back(w) {
      await w.page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null); // истории нет — остаёмся
    },

    pause: (w, a) => hands.sleep(between(hands.rnd, a.from, a.to)),
  };

  /** Снимок страницы для guard; перешедшая страница читается устойчиво (probe.snapshot повторяет). */
  const guardOf = async (page) => classify(await probe.snapshot(page));

  return {
    async open({ site, allow } = {}) {
      alive();
      if (allow !== undefined && !Array.isArray(allow)) throw bad('open: allow — список хостов');
      const hosts = [site, ...(allow || [])].map(hostOfEntry).filter(Boolean);
      if (!hosts.length) throw bad('open: нужен site или allow');
      const page = await newWindow();
      const id = `w${++counter}-${Math.random().toString(36).slice(2, 8)}`;
      const w = { id, allow: hosts, pages: [], page: null, nets: new Map() };
      adopt(w, page);
      windows.set(id, w);
      return { id };
    },

    async view(id, { scope } = {}) {
      const w = win(id);
      try { return await V.view(w.page, { scope }); } catch (err) {
        if (err instanceof TypeError) throw bad(err.message);
        throw err;
      }
    },

    async act(id, action) {
      const w = win(id);
      const a = parseAction(action);
      await doers[a.do](w, a);
      const page = w.page; // клик мог открыть вкладку: дальше работаем с ней
      if (!page) throw new DriverError('not_found', 'окно закрыто');
      const net = w.nets.get(page);
      const settled = a.do === 'pause' ? true : await settle(net, wait);
      const guard = await guardOf(page);
      if (guard) throw new DriverError('needs_human', `${guard}: ${page.url()}`, { guard, url: page.url() }); // окно остаётся открытым
      return { ok: true, url: page.url(), settled, guard: null };
    },

    async resume(id) {
      const w = win(id);
      return { guard: await guardOf(w.page) };
    },

    async close(id) {
      alive();
      const w = windows.get(id);
      if (!w) throw new DriverError('not_found', `нет окна ${String(id).slice(0, 40)}`);
      windows.delete(id);
      await Promise.all([...w.pages].map((p) => p.close().catch(() => {})));
    },

    /** Закрыть окна задач и отключиться от браузера (сам браузер остаётся: он мой). */
    async disconnect() {
      await Promise.all([...windows.keys()].map((id) => this.close(id).catch(() => {})));
      await browser.close().catch(() => {});
    },
  };
}

module.exports = { createDriver, DriverError, parseTarget, parseAction, hostAllowed, checkGoto, watchNetwork, settle };
