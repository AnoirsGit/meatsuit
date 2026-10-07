/**
 * Что бот видит на странице: тонкий слой над page.evaluate. Сессия читает
 * страницу только через него, поэтому в тестах его подменяют, а здесь он
 * проверяется на настоящем браузере. Страницу эти вызовы только читают.
 */

/**
 * Читать страницу, пока она не перестанет переходить. Сразу после клика по ссылке
 * контекст страницы ещё старый и уничтожается на середине вызова: ждём загрузки и повторяем.
 */
async function stable(page, read) {
  for (let attempt = 0; ; attempt++) {
    try { return await read(); } catch (err) {
      if (attempt >= 4 || !/context was destroyed|navigat/i.test(err.message)) throw err;
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

/**
 * Снимок для guard: адрес, заголовок, начало текста, виден ли фрейм проверки.
 * Фрейм виден, только если его не прячут (visibility, opacity) и он в окне: reCAPTCHA держит окно
 * проверки в странице всегда, но скрытым (visibility:hidden; opacity:0; top:-10000px).
 */
const snapshot = (page) => stable(page, async () => {
  const s = await page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 80 || r.height <= 40) return false;
      if (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) return false; // не в окне
      if (typeof el.checkVisibility === 'function') return el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
      const style = getComputedStyle(el);
      return style.visibility === 'visible' && style.opacity !== '0';
    };
    // Чекбокс «Я не робот» (reCAPTCHA v2) — фрейм anchor; тот же anchor с size=invisible — это бейдж v3/невидимой
    // reCAPTCHA, он есть на каждой странице сайта и капчей не бывает. Имена фреймов Arkose, DataDome, SmartCaptcha
    // и PerimeterX взяты из общих знаний автора, на живых сайтах не проверены.
    const challenge = document.querySelectorAll([
      'iframe[src*="recaptcha/api2/bframe"]', 'iframe[src*="recaptcha/enterprise/bframe"]',
      'iframe[src*="recaptcha/api2/anchor"]:not([src*="size=invisible"])', 'iframe[src*="recaptcha/enterprise/anchor"]:not([src*="size=invisible"])',
      'iframe[src*="hcaptcha.com/captcha"]', 'iframe[src*="challenges.cloudflare.com"]',
      'iframe[src*="arkoselabs.com"]', 'iframe[src*="captcha-delivery.com"]', 'iframe[src*="smartcaptcha.yandexcloud.net"]',
      '#cf-challenge-running', '#px-captcha',
    ].join(', '));
    return {
      title: document.title,
      text: (document.body ? document.body.innerText : '').slice(0, 3000), // длиннее 2000 — уже «длинная страница» для guard
      captchaFrame: [...challenge].some((el) => !el.closest('.grecaptcha-badge') && visible(el)),
    };
  });
  return { url: page.url(), ...s };
});

/** Размеры страницы и положение прокрутки. */
const metrics = (page) => stable(page, () => page.evaluate(() => ({
  textLen: (document.body ? document.body.innerText : '').length,
  height: document.documentElement.scrollHeight,
  scrollY: Math.round(scrollY),
  innerH: innerHeight,
})));

/**
 * Ссылки, которые человек видит и может нажать: целиком в окне по ширине, начало на экране, не прозрачные
 * (с учётом прозрачности предков), не спрятанные, не под другим элементом (в центре ссылки именно она).
 * Остальное на сайтах ставят как ловушку для ботов: клик по ним выдаёт скрипт.
 */
const links = (page) => stable(page, () => page.evaluate(() => {
  const opacity = (el) => { let o = 1; for (let n = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity); return o; };
  const out = [];
  for (const a of document.querySelectorAll('a[href]')) {
    const r = a.getBoundingClientRect();
    if (r.width < 10 || r.height < 8 || typeof a.href !== 'string') continue; // точка размером в пиксель — не ссылка
    if (r.x < 0 || r.x + r.width > innerWidth || r.y < 0 || r.y >= innerHeight - 20) continue;
    const first = a.getClientRects()[0] || r; // ссылка в несколько строк: центр первой строки, а не всего блока
    const hit = document.elementFromPoint(first.x + first.width / 2, first.y + first.height / 2);
    if (!hit || !a.contains(hit)) continue; // visibility:hidden и накладки сюда не попадают
    if (opacity(a) <= 0.1) continue;
    // raw — как в разметке (часто относительный): по нему ссылку потом ищет селектор, а не по a.href
    const zone = a.closest('footer') ? 'footer' : a.closest('nav,header,[role=navigation],[role=menubar]') ? 'nav' : 'content'; // меню, шапка, подвал или содержимое
    out.push({ href: a.href, raw: a.getAttribute('href'), text: (a.innerText || '').trim().replace(/\s+/g, ' '), target: a.target, zone, x: r.x, y: r.y, w: r.width, h: r.height });
  }
  return out;
}));

/**
 * Всплывающее, которое человек закроет: диалоги ([role=dialog], aria-modal, dialog[open]), баннеры cookies
 * и крупные фиксированные слои. Берётся только видимое, лежащее сверху (в центре слоя именно он) и в окне.
 * Внутрь iframe не заглядываем: фиксированный слой, в котором только iframe, считаем рекламой и не отдаём:
 * кликать туда нельзя. Кнопки отдаются с номером (ref): по нему boxOf даёт свежий прямоугольник для клика.
 */
const overlays = (page) => stable(page, () => page.evaluate(() => {
  const store = (globalThis.__meatsuitLife = globalThis.__meatsuitLife || { next: 1, map: new Map() });
  store.map.clear();
  const W = innerWidth, H = innerHeight;
  const opacity = (el) => { let o = 1; for (let n = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity); return o; };
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    if (r.right <= 0 || r.bottom <= 0 || r.left >= W || r.top >= H) return false;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return false;
    return opacity(el) > 0.1 && getComputedStyle(el).visibility !== 'hidden';
  };
  const DIALOG = '[role=dialog],[role=alertdialog],[aria-modal=true],dialog[open]';
  const CONSENT = /cookie|куки|consent|gdpr|персональн[а-яё]+ данн/i; // \w в JS знает только латиницу, поэтому для русских слов [а-яё]

  const cands = new Set(document.querySelectorAll(DIALOG));
  for (const top of document.body ? document.body.children : []) {
    for (const el of [top, ...top.children]) {
      const pos = getComputedStyle(el).position;
      if (pos === 'fixed' || pos === 'sticky') cands.add(el);
    }
  }
  const found = [];
  for (const el of cands) {
    if (el.tagName === 'IFRAME' || !shown(el)) continue;
    const r = el.getBoundingClientRect();
    const text = (el.innerText || '').trim();
    const visibleArea = Math.max(0, Math.min(r.right, W) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, H) - Math.max(r.top, 0));
    const dialogLike = el.matches(DIALOG), consent = CONSENT.test(text) && !el.querySelector('input[type=password]'); // форма с паролем — вход или регистрация, не баннер cookies
    if (!(dialogLike || visibleArea >= 0.2 * W * H || (consent && r.width >= 0.5 * W))) continue;
    const hit = document.elementFromPoint(Math.min(Math.max(r.x + r.width / 2, 1), W - 1), Math.min(Math.max(r.y + r.height / 2, 1), H - 1));
    if (!hit || !(el.contains(hit) || hit.contains(el))) continue; // закрыт другим слоем
    found.push({ el, r, text, consent, area: visibleArea });
  }
  const outer = found.filter((a) => !found.some((b) => b !== a && b.el.contains(a.el))); // вложенные не дублируем

  const result = [];
  for (const { el, r, text, consent, area } of outer) {
    const buttons = [];
    for (const b of el.querySelectorAll('button,[role=button],a,input[type=button],input[type=submit],[aria-label],[title],[onclick]')) {
      if (buttons.length >= 12 || !shown(b)) continue;
      if (b.tagName === 'A') { const h = b.getAttribute('href'); if (h && !h.startsWith('#') && !/^javascript:/i.test(h)) continue; } // не уходить со страницы
      const br = b.getBoundingClientRect();
      const name = (b.getAttribute('aria-label') || b.innerText || b.value || b.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 60);
      const corner = !name && br.width <= 60 && br.height <= 60
        && br.right >= r.right - Math.max(60, r.width * 0.15) && br.top <= r.top + Math.max(60, r.height * 0.2);
      const ref = store.next++;
      store.map.set(ref, b);
      buttons.push({ ref, name, corner, x: br.x, y: br.y, w: br.width, h: br.height });
    }
    if (!buttons.length && el.querySelector('iframe')) continue; // реклама во фрейме: не наше
    result.push({ kind: consent ? 'consent' : 'dialog', text: text.slice(0, 120), x: r.x, y: r.y, w: r.width, h: r.height, area, buttons });
  }
  return result.sort((a, b) => b.area - a.area).slice(0, 3).map(({ area, ...o }) => o);
}));

/**
 * Поле поиска на странице: видимое, не прозрачное, лежащее сверху и целиком в окне, не внутри iframe
 * (туда мы не заглядываем). Отдаётся с номером (ref), по нему boxOf даёт свежий прямоугольник для клика;
 * null — поля нет (например, оно раскрывается кликом по значку: такой сайт мы пропускаем).
 */
const searchBox = (page) => stable(page, () => page.evaluate(() => {
  const store = (globalThis.__meatsuitLife = globalThis.__meatsuitLife || { next: 1, map: new Map() });
  const SEL = 'input[type=search],input[name=search],input[name=q],input[name=query],input[name=s],[role=searchbox],input[placeholder*="оиск" i],input[placeholder*="earch" i]';
  const opacity = (el) => { let o = 1; for (let n = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity); return o; };
  for (const el of document.querySelectorAll(SEL)) {
    if (el.disabled || el.readOnly) continue;
    if (el.tagName === 'INPUT' && /^(hidden|checkbox|radio|submit|button)$/i.test(el.type)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 12 || r.x < 0 || r.x + r.width > innerWidth || r.y < 0 || r.y + r.height > innerHeight) continue;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
    if (opacity(el) <= 0.1) continue;
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    if (!hit || !(el === hit || el.contains(hit))) continue;
    const ref = store.next++;
    store.map.set(ref, el);
    return { ref, name: el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || 'поиск', x: r.x, y: r.y, w: r.width, h: r.height };
  }
  return null;
}));

/** Свежий прямоугольник элемента по номеру из overlays; null — элемент пропал. */
const boxOf = (page, ref) => stable(page, () => page.evaluate((r) => {
  const store = globalThis.__meatsuitLife;
  const el = store && store.map.get(r);
  if (!el || !el.isConnected) return null;
  const b = el.getBoundingClientRect();
  return b.width && b.height ? { x: b.x, y: b.y, width: b.width, height: b.height } : null;
}, ref));

/** Подождать, пока страница после перехода хоть как-то загрузится; не дождались — не беда. */
async function settle(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
}

module.exports = { snapshot, metrics, links, overlays, searchBox, boxOf, settle };
