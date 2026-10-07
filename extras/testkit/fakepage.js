/**
 * Фальшивая страница playwright для тестов рук и прогрева. Пишет журнал
 * вызовов; часы виртуальные: sleep двигает время, а не ждёт, поэтому минута
 * печати или чтения проигрывается мгновенно.
 */
const { seeded } = require('../human/random.js');

/** Элемент с заданным прямоугольником; state нужен, если страница прокручивается колесом. */
const locatorAt = (box, state, onScrollIntoView) => {
  const loc = {
    boundingBox: async () => ({ ...box, y: box.y - (state ? state.scrollY : 0) }),
    scrollIntoViewIfNeeded: async () => { if (onScrollIntoView) onScrollIntoView(); },
    first: () => loc,
  };
  return loc;
};

/**
 * Строка CSS из src с позиции i (там кавычка), по правилам CSS Syntax: \ + 1–6 шестнадцатеричных
 * цифр (и один пробел после них) — символ с этим кодом, \ + перевод строки — продолжение строки,
 * \ + любой другой символ — он сам. Голый перевод строки в строке — ошибка. Так читает селектор
 * браузер; JSON.parse читал бы «\n» как перевод строки, а CSS читает его как букву n.
 * Возвращает { value, end }.
 */
function readCssString(src, i = 0) {
  const quote = src[i];
  if (quote !== '"' && quote !== "'") throw new Error(`css: строка должна начинаться с кавычки: ${src.slice(i, i + 10)}`);
  let value = '';
  for (i++; i < src.length;) {
    const c = src[i];
    if (c === quote) return { value, end: i + 1 };
    if (c === '\n' || c === '\r' || c === '\f') throw new Error('css: перевод строки внутри строки (bad-string)');
    if (c !== '\\') { value += c; i++; continue; }
    i++;
    if (i >= src.length) break;
    if (src[i] === '\r' && src[i + 1] === '\n') { i += 2; continue; }
    if (src[i] === '\n' || src[i] === '\r' || src[i] === '\f') { i++; continue; }
    const hex = /^[0-9a-fA-F]{1,6}/.exec(src.slice(i, i + 6));
    if (!hex) { value += src[i]; i++; continue; }
    i += hex[0].length;
    if (src[i] === '\r' && src[i + 1] === '\n') i += 2; else if (/[ \t\n\r\f]/.test(src[i] || '')) i++;
    const cp = parseInt(hex[0], 16);
    value += String.fromCodePoint(cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? 0xfffd : cp);
  }
  throw new Error('css: строка не закрыта');
}

/** Значение href из селектора вида a[href=<строка CSS>]:visible; null — селектор другого вида. */
function hrefOfSelector(selector) {
  if (!selector.startsWith('a[href=')) return null;
  const { value, end } = readCssString(selector, 'a[href='.length);
  return selector.slice(end) === ']:visible' ? value : null;
}

/**
 * anchors — ссылки страницы как в разметке: { raw: значение атрибута href, href: абсолютный адрес }.
 * Селектор вида a[href="…"]:visible находит ссылку только по raw, как настоящий браузер:
 * абсолютный адрес из a.href атрибуту не равен, и такой селектор ничего не найдёт.
 */
function fakePage({ cdp = true, failGoto = [], anchors = [], linkBox = { x: 300, y: 300, width: 200, height: 20 } } = {}) {
  const log = [];
  const clock = { t: 0 };
  const state = { scrollY: 0, url: 'about:blank', visited: [], linkAt: null };
  const handlers = {};
  const page = {
    mouse: {
      move: async (x, y) => log.push({ op: 'move', x, y, t: clock.t }),
      down: async () => log.push({ op: 'down', t: clock.t }),
      up: async () => {
        log.push({ op: 'up', t: clock.t });
        if (state.linkAt) { state.url = state.linkAt; state.visited.push(state.linkAt); state.linkAt = null; } // клик по ссылке — переход
      },
      wheel: async (dx, dy) => { state.scrollY += dy; log.push({ op: 'wheel', dy, t: clock.t }); },
    },
    keyboard: {
      down: async (k) => log.push({ op: 'kdown', k, t: clock.t }),
      up: async (k) => log.push({ op: 'kup', k, t: clock.t }),
      insertText: async (s) => log.push({ op: 'insert', s, t: clock.t }),
    },
    context: () => ({
      newCDPSession: async () => {
        if (!cdp) throw new Error('нет CDP');
        return { send: async (method, params) => log.push({ op: 'cdp', method, params, t: clock.t }) };
      },
    }),
    evaluate: async () => ({ w: 1280, h: 720 }),
    goto: async (url) => {
      log.push({ op: 'goto', url, t: clock.t });
      if (failGoto.includes(url)) throw new Error('net::ERR_CONNECTION_REFUSED');
      state.url = url;
      state.visited.push(url);
    },
    url: () => state.url,
    // События страницы (dialog, popup): on() — как у playwright, emit() — только для тестов.
    on: (event, handler) => { (handlers[event] = handlers[event] || []).push(handler); },
    emit: (event, arg) => Promise.all((handlers[event] || []).map((h) => h(arg))),
    goBack: async () => { log.push({ op: 'back', t: clock.t }); },
    waitForLoadState: async () => {},
    locator: (selector) => {
      const want = hrefOfSelector(selector);
      const anchor = want !== null && anchors.find((a) => a.raw === want);
      if (!anchor) {
        const missing = { boundingBox: async () => { throw new Error(`locator.boundingBox: Timeout exceeded, ждали ${selector}`); }, first: () => missing };
        return missing;
      }
      state.linkAt = anchor.href;
      return locatorAt(linkBox);
    },
  };
  // Виртуальное время, которое не идёт вперёд, превращает цикл «пока не прошло N мс» в вечный:
  // лучше упасть с понятным сообщением, чем повесить прогон тестов.
  let sleeps = 0;
  const env = {
    sleep: async (ms) => {
      if (++sleeps > 50000) throw new Error('виртуальное время зациклилось: sleep вызван более 50000 раз');
      clock.t += ms;
    },
    now: () => clock.t,
    rnd: seeded(7),
  };
  return { page, env, log, clock, state };
}

module.exports = { fakePage, locatorAt, readCssString };
