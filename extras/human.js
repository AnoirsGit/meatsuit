/**
 * Человеческий темп: мышь по кривой со своей скоростью, прокрутка колесом,
 * печать клавишами с ритмом и опечатками.
 *
 * Планы считают human/mouse.js и human/keys.js (чистые функции, их проверяют
 * тесты). Здесь они проигрываются на странице playwright по часам: время
 * берётся от начала плана, а не копится из пауз, поэтому задержки запросов
 * к браузеру ритм не сбивают. Последнюю позицию курсора держим сами:
 * playwright её не отдаёт.
 *
 * Последний аргумент функций — {sleep, now, rnd}: часы и генератор можно
 * подменить, в тестах минута печати проигрывается мгновенно.
 */
const { between, chance, clamp, lognormal, normal } = require('./human/random');
const { planMove, clampPlan, pickPoint, planScroll, planTwitch } = require('./human/mouse');
const { planTyping } = require('./human/keys');

const rand = (a, b) => a + Math.random() * (b - a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pause = (a = 300, b = 1200) => sleep(rand(a, b));

const envOf = (o = {}) => ({ sleep: o.sleep || sleep, now: o.now || Date.now, rnd: o.rnd || Math.random });

/** Проиграть план: каждое событие в своё время от начала. */
async function play(events, env, fire) {
  const t0 = env.now();
  for (const ev of events) {
    const wait = ev.t - (env.now() - t0);
    if (wait > 0) await env.sleep(wait);
    await fire(ev);
  }
}

/** Повадки человека: быстрая или медленная рука, дрожь, как часто дёргается, как печатает. */
function newPersona(rnd = Math.random) {
  return {
    speed: clamp(lognormal(rnd, 1, 0.15), 0.7, 1.4),
    tremor: between(rnd, 0.4, 1),
    twitch: between(rnd, 0.1, 0.5),
    wpm: clamp(52 + 10 * normal(rnd), 30, 95),
  };
}

// Допустимые границы повадок: за ними рука превращается в телепорт (speed NaN), а печать в вечность (wpm 0).
const PERSONA_RANGE = { speed: [0.5, 2], tremor: [0, 2], twitch: [0, 1], wpm: [20, 150] };
const inRange = (v, [lo, hi]) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

/**
 * Сохранённые повадки (из persona.json или откуда угодно): годные поля остаются, негодные
 * и недостающие берутся у новой персоны. Лишние поля отбрасываются.
 */
function restorePersona(saved, rnd = Math.random) {
  const fresh = newPersona(rnd), from = saved && typeof saved === 'object' ? saved : {};
  return Object.fromEntries(Object.entries(PERSONA_RANGE).map(([k, range]) => [k, inRange(from[k], range) ? from[k] : fresh[k]]));
}

// Человек в браузере один, поэтому повадки общие на все страницы и держатся, пока жив процесс.
// usePersona подставляет сохранённые (чтобы после перезапуска печатал в том же темпе); null — сбросить.
let shared = null;
const usePersona = (p) => { shared = p == null ? null : restorePersona(p); };
const personaOf = (rnd) => shared || (shared = newPersona(rnd));

const cursor = new WeakMap();
const sizes = new WeakMap();

/** Размер окна страницы. Мышь не должна выходить за него; fresh — спросить заново, иначе берётся прежний ответ. */
async function sizeOf(page, fresh = false) {
  if (fresh || !sizes.has(page)) sizes.set(page, await page.evaluate(() => ({ w: innerWidth, h: innerHeight })));
  return sizes.get(page);
}

/** Курсор уже где-то есть: при первом обращении появляется в правдоподобной точке окна. */
async function cursorOf(page, rnd) {
  if (!cursor.has(page)) {
    const win = await sizeOf(page);
    const at = { x: clamp(Math.round(between(rnd, 100, 600)), 0, win.w - 1), y: clamp(Math.round(between(rnd, 100, 400)), 0, win.h - 1) };
    await page.mouse.move(at.x, at.y);
    cursor.set(page, at);
  }
  return cursor.get(page);
}

/** Провести мышь в точку по кривой; width — размер цели, от него зависит время. */
async function moveTo(page, x, y, opts = {}) {
  const env = envOf(opts), me = personaOf(env.rnd);
  const from = await cursorOf(page, env.rnd);
  const win = await sizeOf(page, true);
  const to = { x: clamp(x, 0, win.w - 1), y: clamp(y, 0, win.h - 1) }; // цель за окном: ближайшая точка в окне
  const raw = planMove(from, to, { width: opts.width, speed: (opts.speed || 1) * me.speed, tremor: me.tremor, twitch: opts.twitch ?? me.twitch }, env.rnd);
  const plan = clampPlan(raw, win.w, win.h, from); // путь (перелёт, дрожь) тоже не выходит за окно
  await play(plan, env, (p) => page.mouse.move(p.x, p.y));
  const end = plan[plan.length - 1];
  cursor.set(page, { x: end.x, y: end.y });
}

/**
 * Постоять на месте: рука не замирает, а чуть сдвигается, а иногда резко дёргается
 * и возвращается. box не даёт съехать с цели; перед концом рука успокаивается.
 */
async function linger(page, ms, opts = {}) {
  const env = envOf(opts), me = personaOf(env.rnd);
  const b = opts.box || {};
  const win = await sizeOf(page);
  const keep = (v, lo, size, limit) => clamp(opts.box ? clamp(v, Math.ceil(lo) + 1, Math.floor(lo + size) - 1) : v, 0, limit - 1); // без цели держаться не за что, но окно есть всегда
  const twitchChance = opts.twitch ?? (me.twitch ?? 0.25) * 0.4;
  let left = ms;
  while (left > 150) {
    const chunk = Math.min(left, clamp(lognormal(env.rnd, 220, 0.5), 80, 600));
    await env.sleep(chunk);
    left -= chunk;
    if (left >= 450 && chance(env.rnd, twitchChance)) {
      const at = await cursorOf(page, env.rnd);
      const plan = planTwitch(env.rnd).map((m) => ({ t: m.t, x: keep(at.x + m.dx, b.x, b.width, win.w), y: keep(at.y + m.dy, b.y, b.height, win.h) }));
      await play(plan, env, (p) => page.mouse.move(p.x, p.y));
      const end = plan[plan.length - 1];
      cursor.set(page, { x: end.x, y: end.y });
      left -= end.t;
    } else if (left >= 60 && chance(env.rnd, 0.6)) {
      const at = await cursorOf(page, env.rnd);
      const next = { x: keep(at.x + Math.round(between(env.rnd, -2, 2)), b.x, b.width, win.w), y: keep(at.y + Math.round(between(env.rnd, -2, 2)), b.y, b.height, win.h) };
      if (next.x !== at.x || next.y !== at.y) { await page.mouse.move(next.x, next.y); cursor.set(page, next); }
    }
  }
  if (left > 0) await env.sleep(left);
}

/** Колесо мыши: рывки по 100 с паузами на чтение; знак px — направление. */
async function scroll(page, px = rand(600, 2200), opts = {}) {
  const env = envOf(opts);
  await cursorOf(page, env.rnd);
  await play(planScroll(px, {}, env.rnd), env, (e) => page.mouse.wheel(0, e.dy));
}

/**
 * Довести элемент до удобной зоны экрана колесом, а не мгновенной прокруткой скриптом:
 * человек крутит, смотрит, крутит дальше. Если колесо не двигает страницу
 * (элемент во вложенной прокрутке), остаётся мгновенная прокрутка.
 */
async function scrollToView(page, locator, env) {
  const { h } = await sizeOf(page, true);
  let stuck = 0, lastY = null;
  for (let i = 0; i < 25; i++) {
    const box = await locator.boundingBox({ timeout: 5000 }); // нет элемента — не ждать 30 секунд
    if (!box) throw new Error('элемент не виден');
    const mid = box.y + box.height / 2;
    if (mid >= h * 0.12 && mid <= h * 0.88) return;
    stuck = lastY !== null && Math.abs(box.y - lastY) < 1 ? stuck + 1 : 0;
    if (stuck >= 2) return locator.scrollIntoViewIfNeeded();
    lastY = box.y;
    const need = mid - h * 0.4;
    await scroll(page, Math.sign(need) * Math.min(Math.abs(need), 500), env);
    await env.sleep(clamp(lognormal(env.rnd, 250, 0.3), 120, 700)); // дать докатиться
  }
  return locator.scrollIntoViewIfNeeded();
}

/** Подвести мышь к элементу: прокрутка колесом, путь к точке около центра, недолгая задержка над ним. */
async function hover(page, locator, opts = {}) {
  const env = envOf(opts);
  await scrollToView(page, locator, env);
  const box = await locator.boundingBox({ timeout: 5000 }); // нет элемента — не ждать 30 секунд
  if (!box) throw new Error('элемент не виден');
  const target = pickPoint(box, await cursorOf(page, env.rnd), env.rnd);
  await moveTo(page, target.x, target.y, { ...opts, width: Math.min(box.width, box.height) });
  await linger(page, clamp(lognormal(env.rnd, 130, 0.4), 50, 500), { ...opts, box });
}

/** Навести и кликнуть: точка около центра, задержка перед нажатием, кнопка держится не мгновенно. */
async function click(page, locator, opts = {}) {
  const env = envOf(opts);
  await hover(page, locator, opts);
  await page.mouse.down();
  await env.sleep(clamp(lognormal(env.rnd, 85, 0.3), 45, 200));
  await page.mouse.up();
}

// Сырые события клавиатуры для раскладки, которой нет у playwright (кириллица): через CDP, как это делает сам браузер.
const sessions = new WeakMap();
const cdpOf = (page) => {
  if (!sessions.has(page)) sessions.set(page, Promise.resolve().then(() => page.context().newCDPSession(page)).catch(() => null));
  return sessions.get(page);
};

async function press(page, ev, state) {
  if (ev.op === 'insert') return page.keyboard.insertText(ev.text);
  const e = ev.entry, down = ev.op === 'down';
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') state.shift = down;
  if (!e.raw) return page.keyboard[down ? 'down' : 'up'](e.name);

  const session = await cdpOf(page);
  if (!session) return down ? page.keyboard.insertText(e.text) : undefined; // без CDP хотя бы текст не потерять
  return session.send('Input.dispatchKeyEvent', {
    type: down ? 'keyDown' : 'keyUp',
    modifiers: state.shift ? 8 : 0,
    key: e.key,
    code: e.code,
    windowsVirtualKeyCode: e.vk,
    nativeVirtualKeyCode: e.vk,
    text: down ? e.text : undefined,
    unmodifiedText: down ? e.text : undefined,
  });
}

/** Печать в сфокусированное поле: opts.wpm и opts.typoRate переопределяют повадки страницы. */
async function type(page, text, opts = {}) {
  const env = envOf(opts), me = personaOf(env.rnd);
  const plan = planTyping(text, { wpm: opts.wpm || me.wpm, typoRate: opts.typoRate, rnd: env.rnd });
  const state = { shift: false };
  await play(plan, env, (ev) => press(page, ev, state));
}

/** Одна клавиша целиком (Escape, Enter, Tab…): нажал, подержал, отпустил. */
async function pressKey(page, key, opts = {}) {
  const env = envOf(opts);
  await page.keyboard.down(key);
  await env.sleep(clamp(lognormal(env.rnd, 85, 0.3), 45, 200));
  await page.keyboard.up(key);
}

module.exports = { moveTo, hover, click, scroll, type, press: pressKey, linger, pause, rand, sleep, newPersona, restorePersona, usePersona, planMove, planTyping, planScroll };
