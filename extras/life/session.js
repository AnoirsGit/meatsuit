/**
 * Сессия прогрева: бот открывает сайты по плану и ведёт себя как читатель:
 * листает колесом, задерживается над текстом, иногда идёт по ссылке того же
 * сайта, на видео смотрит. Ничего не вводит и не нажимает, кроме ссылок:
 * это чтение, а не действия в аккаунте. Капча или блок останавливают сессию.
 * Всплывающее (диалоги, баннеры cookies, подписки) закрывается как у человека, лишние вкладки и
 * системные диалоги закрываются сами; не закрылось — сайт пропускается (life/overlay.js).
 */
const human = require('../human.js');
const { between, chance, clamp, lognormal } = require('../human/random');
const { classify } = require('../guard.js');
const { readingTime, pickLink, deadlineOf, PAUSE_MAX } = require('./plan.js');
const { dismissOverlays, watchPage } = require('./overlay.js');
const { wander } = require('./wander.js');

/** Сайт показал капчу или блок: сессию надо остановить, а планировщику притихнуть. */
class Blocked extends Error {
  constructor(reason, url) { super(`${reason}: ${url}`); this.reason = reason; this.url = url; }
}
class Skip extends Error {}

/**
 * Строка для селектора CSS. JSON.stringify не годится: в CSS «\n» значит букву n, а «\u0001» буквы u0001,
 * поэтому управляющие символы пишутся кодом (\a ), а NUL заменяется на U+FFFD, как делает сам CSS.
 */
function cssString(text) {
  const body = [...String(text)].map((ch) => {
    const code = ch.codePointAt(0);
    if (ch === '"' || ch === '\\') return `\\${ch}`;
    if (code === 0) return '\ufffd';
    if (code < 0x20 || code === 0x7f) return `\\${code.toString(16)} `;
    return ch;
  });
  return `"${body.join('')}"`;
}

// Ссылка ищется по значению атрибута из разметки (a.href — абсолютный, атрибуту не равен) и среди видимых.
const linkLocator = (page, link) => page.locator(`a[href=${cssString(link.raw ?? link.href)}]:visible`).first();

async function check(page, probe) {
  const verdict = classify(await probe.snapshot(page));
  if (verdict === 'captcha' || verdict === 'blocked') throw new Blocked(verdict, page.url());
  if (verdict === 'login') throw new Skip('редирект на вход');
}

/** Закрыть всплывающее; не закрылось — сайт пропускается, под баннером человек не читает. */
async function clearOverlays(page, env, probe, log) {
  if (typeof probe.overlays !== 'function') return;
  const res = await dismissOverlays(page, env, probe, { consent: env.consent, log });
  if (res.stuck) throw new Skip('всплывающее не закрылось');
}

/** Прочитать открытую страницу: смотрит экран, крутит дальше, дошёл до конца — задержался и всё. */
async function readHere(page, budgetMs, env, probe, log) {
  const m = await probe.metrics(page);
  const dwell = Math.min(budgetMs, readingTime(m.textLen, env.rnd), env.room());
  const scrollable = m.height > m.innerH + 40;
  const chunks = clamp(Math.round(m.height / 700), 1, 10);
  const t0 = env.now();
  const left = () => dwell - (env.now() - t0);
  // «Остаток больше миллисекунды», а не «больше нуля»: на дробном остатке время может перестать идти.
  while (left() > 1) {
    await human.linger(page, Math.min(left(), clamp(lognormal(env.rnd, dwell / chunks * 0.7, 0.35), 1500, 60000)), env);
    await clearOverlays(page, env, probe, log);
    if (left() > 1 && chance(env.rnd, env.wander)) log({ event: 'wander', reason: await wander(page, env, probe) }); // листнул вверх, навёл на меню, отвлёкся
    if (left() <= 1 || !scrollable) continue;
    if (env.late()) return;
    await human.scroll(page, between(env.rnd, 400, 900), env);
    const now = await probe.metrics(page);
    if (now.scrollY + now.innerH >= now.height - 40) { // дошёл до конца страницы
      await human.linger(page, Math.min(Math.max(left(), 0), 2500), env);
      break;
    }
  }
}

// Насколько вернуться вверх на каждой следующей попытке найти ссылку: сначала чуть-чуть, потом почти до верха.
const BACK_UP = [0, 1000, 2500, 6000];

/** Пойти по ссылке со страницы. Ссылок на экране нет — как человек, возвращается вверх, всё выше. */
async function follow(page, env, probe, log, options) {
  for (let attempt = 0; attempt < BACK_UP.length; attempt++) {
    if (env.late()) return false;
    if (attempt) await human.scroll(page, -BACK_UP[attempt] * between(env.rnd, 0.8, 1.2), env);
    const links = await probe.links(page);
    // Четверть переходов идёт через меню или шапку, остальные из содержимого; нет нужной зоны — любая.
    const zone = chance(env.rnd, 0.25) ? 'nav' : 'content';
    const pick = pickLink(links, page.url(), env.rnd, { ...options, zone }) || pickLink(links, page.url(), env.rnd, options);
    if (pick) {
      log({ event: 'follow', from: page.url(), href: pick.href, zone: pick.zone || 'content' });
      await human.click(page, linkLocator(page, pick), env);
      await probe.settle(page);
      await check(page, probe);
      await clearOverlays(page, env, probe, log);
      return true;
    }
  }
  return false;
}

/** Найти поле поиска, кликнуть, напечатать запрос клавишами, нажать Enter. Поля нет — сайт пропускается. */
async function search(page, step, env, probe, log) {
  const box = typeof probe.searchBox === 'function' ? await probe.searchBox(page) : null;
  if (!box) throw new Skip('нет поля поиска');
  log({ event: 'search', reason: step.query });
  const field = { boundingBox: () => probe.boxOf(page, box.ref), scrollIntoViewIfNeeded: async () => {} };
  await human.click(page, field, env);
  await env.sleep(clamp(lognormal(env.rnd, 500, 0.4), 200, 1500)); // руку на клавиатуру
  await human.type(page, step.query, env);
  await env.sleep(clamp(lognormal(env.rnd, 400, 0.4), 150, 1200));
  await human.press(page, 'Enter', env);
  await probe.settle(page);
  await check(page, probe);
  await clearOverlays(page, env, probe, log);
}

async function visit(page, step, env, probe, log) {
  await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await probe.settle(page);
  await check(page, probe);
  await clearOverlays(page, env, probe, log);
  if (step.kind === 'search') await search(page, step, env, probe, log);

  if (step.kind === 'video') {
    if (!(await follow(page, env, probe, log, { include: /\/watch\?v=|\/video\//i }))) return;
    const watchMs = Math.min(clamp(step.budgetMs, 30000, 600000), env.room());
    const t0 = env.now();
    const left = () => watchMs - (env.now() - t0);
    while (left() > 1) {
      await human.linger(page, Math.min(left(), clamp(lognormal(env.rnd, 25000, 0.5), 5000, 90000)), env);
      if (chance(env.rnd, 0.3) && left() > 1) await human.scroll(page, between(env.rnd, 100, 300), env); // глянул комментарии
    }
    return;
  }

  // Бюджет сайта делится между первой страницей и переходами по ссылкам.
  const first = step.budgetMs / (1 + 0.6 * step.follow);
  await readHere(page, first, env, probe, log);
  for (let i = 0; i < step.follow; i++) {
    if (!(await follow(page, env, probe, log))) break;
    if (env.late()) break;
    await readHere(page, first * 0.6, env, probe, log);
    if (chance(env.rnd, 0.5)) { // иногда остаётся и идёт дальше отсюда, иногда назад, изредка сразу на два шага
      await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
      if (chance(env.rnd, 0.2)) { await env.sleep(clamp(lognormal(env.rnd, 1500, 0.4), 600, 4000)); await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {}); }
    }
  }
}

/**
 * Проиграть план сессии. Сайт не открылся или перекинул на вход — пропускается,
 * сессия идёт дальше. Капча или блок — Blocked, дальше ничего не открывается.
 * Срок (по умолчанию deadlineOf(steps), или deadlineMs): вышел — новых шагов, переходов по ссылкам
 * и возвратов вверх нет, сессия тихо кончается; то, что шло в момент срока, доделывается.
 * env: { sleep, now, rnd }; probe — чтение страницы; log — журнал событий;
 * consent — что делать с баннером cookies: 'reject' (по умолчанию) или 'accept';
 * wander — вероятность случайной мелочи (листнуть вверх, навести на меню, постоять, отойти) за проход чтения.
 * Возвращает { cut }: true, если сессию оборвал срок.
 */
async function runSession(page, steps, { env = {}, probe = require('./probe.js'), log = () => {}, deadlineMs, consent = 'reject', wander: wanderChance = 0.2 } = {}) {
  const e = { sleep: env.sleep || human.sleep, now: env.now || Date.now, rnd: env.rnd || Math.random, consent, wander: wanderChance };
  watchPage(page, e, log); // лишние вкладки и системные диалоги закрываются сами
  const deadline = e.now() + (deadlineMs ?? deadlineOf(steps));
  let cut = false;
  e.room = () => deadline - e.now();
  e.late = () => { if (e.room() > 0) return false; cut = true; return true; };
  for (const step of steps) {
    if (e.late()) break;
    await e.sleep(clamp(lognormal(e.rnd, 3000, 0.4), 1000, PAUSE_MAX)); // глянуть на экран, собраться с мыслью
    if (e.late()) break;
    const t0 = e.now();
    const done = (result, reason) => log({ event: 'step', url: step.url, kind: step.kind, result, reason, ms: e.now() - t0 });
    try {
      await visit(page, step, e, probe, log);
      done('ok');
    } catch (err) {
      if (err instanceof Blocked) { done('blocked', err.reason); throw err; }
      if (err instanceof TypeError || err instanceof ReferenceError) throw err; // ошибка в коде, а не на сайте
      done('skipped', err.message);
    }
  }
  return { cut };
}

module.exports = { runSession, Blocked, cssString, linkLocator };
