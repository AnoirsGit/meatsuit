/**
 * Глаза: снимок страницы, который можно отдать модели.
 *
 * observe() читает видимые интерактивные элементы и нумерует их. Сами элементы остаются
 * в изолированном мире (dom.js), страница не меняется: ни атрибутов, ни свойств window.
 * Номера живут в пределах одного снимка. Поколения (gen) считает вызывающий (hands) в Node.
 *
 * diff() — чистая функция, её проверяет test/eyes.test.js.
 */
const { openWorld, run } = require('./dom.js');

const TEXT_LIMIT = 6000;
const NAME_LIMIT = 80;

/** Выполняется внутри страницы, поэтому самодостаточна. */
function collect({ textLimit, nameLimit, gen }) {
  // Хранилище живёт в изолированном мире: страница его не видит.
  const norm = (el) => (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const store = (globalThis.__ms = {
    els: [null], // els[id] = элемент; нулевой номер не используем
    text: [null], // текст узла в момент снимка: по нему видно подмену содержимого
    same: (id) => { const e = store.els[id]; return !!e && e.isConnected && norm(e) === store.text[id]; },
    box: (id) => { const e = store.els[id]; if (!e || !e.isConnected) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; },
  });

  const SELECTOR = [
    'a[href]', 'button', 'input:not([type=hidden])', 'textarea', 'select', 'summary',
    '[role=button]', '[role=link]', '[role=tab]', '[role=checkbox]', '[role=radio]',
    '[role=switch]', '[role=menuitem]', '[role=option]', '[role=textbox]', '[contenteditable=""]',
    '[contenteditable=true]',
  ].join(',');

  const clip = (s, n) => {
    s = (s || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  };

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) return null;
    return r;
  };

  const inViewport = (r) =>
    r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;

  // Предок в составном дереве: слотированный узел поднимается через свой <slot>, из shadow-корня — к хосту.
  const inside = (anc, el) => {
    for (let n = el; n; n = n.assignedSlot || n.parentNode || n.host) if (n === anc) return true;
    return false;
  };

  // Элементы в порядке документа, с заходом в открытые shadow-корни (closed недоступны).
  const deepAll = (root, test, out = []) => {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (test(n)) out.push(n);
      if (n.shadowRoot) deepAll(n.shadowRoot, test, out);
    }
    return out;
  };

  // Элемент перекрыт, если в его центре лежит чужой элемент (модалка, оверлей).
  const covered = (el, r) => {
    const x = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1);
    const y = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1);
    let top = document.elementFromPoint(x, y);
    // elementFromPoint отдаёт хост: спускаемся внутрь открытых корней.
    for (let s = top && top.shadowRoot; s; s = top.shadowRoot) {
      const inner = s.elementFromPoint(x, y);
      if (!inner || inner === top) break;
      top = inner;
    }
    return !top || !(el === top || inside(el, top) || inside(top, el));
  };

  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'select';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      return { checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button' }[t] || 'textbox';
    }
    return 'textbox';
  };

  // Отрисован ли узел. У неотрисованного (<style>, display:none, скрытый хост) innerText равен textContent, то есть
  // с CSS и скрытым текстом. Range, а не checkVisibility: тот отбрасывает display:contents и <slot>.
  const drawn = (n) => {
    const r = document.createRange();
    if (n.nodeType === Node.TEXT_NODE) r.selectNode(n); else r.selectNodeContents(n);
    return r.getClientRects().length > 0;
  };
  // У обёртки, где лежит только <slot>, своих прямоугольников нет: её смотрим по display. Предков уже
  // проверила рекурсия (slotText идёт вниз от видимого элемента), поэтому хватает своего стиля.
  const shown = (e) => drawn(e) || (!!e.querySelector('slot') && getComputedStyle(e).display !== 'none');

  // innerText не заходит в <slot>: если внутри есть слот, собираем текст с назначенными ему узлами.
  // Неотрисованный элемент даёт '', у отрисованного берём innerText: скрытого текста в нём нет.
  const slotText = (n) => n.nodeType === Node.TEXT_NODE ? n.data
    : n.nodeType !== Node.ELEMENT_NODE ? ''
    : n.tagName === 'SLOT' ? (getComputedStyle(n).display === 'none' ? '' : n.assignedNodes({ flatten: true }).map(slotText).join(' '))
    : !shown(n) ? ''
    : n.querySelector('slot') ? [...n.childNodes].map(slotText).join(' ')
    : n.innerText;
  const textOf = (el) => el.querySelector('slot') ? [...el.childNodes].map(slotText).join(' ') : el.innerText || el.textContent;

  const nameOf = (el) => {
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const t = labelledby.split(/\s+/).map((id) => el.getRootNode().getElementById?.(id)?.textContent || '').join(' ');
      if (t.trim()) return clip(t, nameLimit);
    }
    const aria = el.getAttribute('aria-label');
    if (aria) return clip(aria, nameLimit);
    if (el.labels && el.labels[0]) return clip(el.labels[0].textContent, nameLimit);
    const own = clip(textOf(el), nameLimit);
    if (own) return own;
    return clip(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt')
      || el.querySelector('img[alt]')?.getAttribute('alt') || el.getAttribute('value'), nameLimit);
  };

  // innerText не заходит в shadow-корни: текст каждого корня идёт отдельным куском после light DOM (порядок
  // документа теряется). Из корня берём все отрисованные узлы верхнего уровня, в том числе текстовые (так рендерит Lit).
  const squash = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const rootText = (root) => [...root.childNodes].map((c) => (
    c.nodeType === Node.ELEMENT_NODE ? (drawn(c) ? c.innerText : '')
      : c.nodeType === Node.TEXT_NODE && drawn(c) && getComputedStyle(root.host).visibility === 'visible' ? c.data
        : '')).join(' ');
  // Куски непустые и уже сжаты: text = их склейка через пробел, а длины кусков guard берёт из textParts.
  const textParts = () => [document.body ? document.body.innerText : '']
    .concat(deepAll(document, (e) => e.shadowRoot).map((h) => rootText(h.shadowRoot)))
    .map(squash).filter(Boolean);

  const elements = [];
  let n = 0;
  for (const el of deepAll(document, (e) => e.matches(SELECTOR))) {
    const r = visible(el);
    if (!r) continue;
    const seen = inViewport(r);
    if (seen && covered(el, r)) continue;
    n += 1;
    store.els[n] = el;
    store.text[n] = norm(el);
    const role = roleOf(el);
    const item = { id: n, role, name: nameOf(el), inView: seen };
    const inputType = el.tagName === 'INPUT' ? (el.getAttribute('type') || 'text').toLowerCase() : undefined;
    if (el.tagName === 'A' && el.getAttribute('href')) item.href = clip(el.getAttribute('href'), 200); // нужен проектам, чтобы узнавать страницы и записи по адресу
    if (inputType === 'password') item.inputType = 'password'; // значение пароля модели не отдаём никогда
    else if (role === 'textbox' || role === 'select') item.value = clip(el.value ?? el.textContent, nameLimit);
    if (role === 'checkbox' || role === 'radio' || role === 'switch') {
      item.checked = el.checked ?? el.getAttribute('aria-checked') === 'true';
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') item.disabled = true;
    if (el === document.activeElement) item.focused = true;
    if (el.getAttribute('aria-selected') === 'true') item.selected = true;
    elements.push(item);
  }

  const dialogs = [];
  for (const d of deepAll(document, (e) => e.matches('dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true]'))) {
    if (!visible(d)) continue;
    const ids = [];
    store.els.forEach((e, i) => { if (e && inside(d, e)) ids.push(i); });
    dialogs.push({ name: nameOf(d) || clip(d.innerText, nameLimit), text: clip(d.innerText, 600), elements: ids });
  }

  const parts = textParts();
  return {
    gen,
    url: location.href,
    title: document.title,
    text: clip(parts.join(' '), textLimit),
    // Длины кусков text (light DOM, затем каждый shadow-корень): порог короткой страницы в guard к каждому отдельно.
    ...(parts.length > 1 ? { textParts: parts.map((p) => p.length) } : {}),
    elements,
    dialogs,
  };
}

/**
 * Снимок страницы.
 * opts.screenshot — добавить сжатый JPEG (base64).
 * opts.since      — прошлый снимок: вернуть только изменения (см. diff).
 * opts.gen        — номер поколения; hands держит монотонный счётчик.
 */
let standaloneGen = 0;

/**
 * Снимок и мир, в котором лежат его элементы (нужен рукам).
 * opts.screenshot — добавить сжатый JPEG (base64).
 * opts.gen        — номер поколения; hands держит монотонный счётчик.
 */
async function observe(page, opts = {}) {
  const gen = opts.gen || ++standaloneGen;
  const world = await openWorld(page);
  const snap = await run(world, collect, { textLimit: TEXT_LIMIT, nameLimit: NAME_LIMIT, gen });
  // Чужие iframe (капча, Arkose) в DOM страницы не видны, поэтому отдаём их адреса.
  snap.frames = page.frames().filter((f) => f !== page.mainFrame()).map((f) => f.url())
    .filter((u) => u && u !== 'about:blank');
  if (opts.screenshot) {
    const buf = await page.screenshot({ type: 'jpeg', quality: 60, scale: 'css' });
    snap.screenshot = buf.toString('base64');
  }
  return { snap, world };
}

/**
 * Снимок страницы.
 * opts.since — прошлый снимок: вернуть только изменения (см. diff).
 */
async function see(page, opts = {}) {
  const { snap } = await observe(page, opts);
  return opts.since ? diff(opts.since, snap) : snap;
}

const keyOf = (e) => `${e.role}|${e.name}`;

/** Что изменилось между снимками. Без изменений text/dialogs не повторяются. */
function diff(prev, next) {
  const had = new Map(prev.elements.map((e) => [keyOf(e), e]));
  const has = new Map(next.elements.map((e) => [keyOf(e), e]));
  const out = {
    gen: next.gen,
    url: next.url,
    title: next.title,
    urlChanged: prev.url !== next.url,
    // id в новом поколении другие, поэтому отдаём полный список ключей для навигации:
    elements: next.elements,
    added: next.elements.filter((e) => !had.has(keyOf(e))),
    removed: prev.elements.filter((e) => !has.has(keyOf(e))).map(({ role, name }) => ({ role, name })),
  };
  if (prev.text !== next.text) {
    out.text = next.text;
    if (next.textParts) out.textParts = next.textParts;
  }
  if (JSON.stringify(prev.dialogs) !== JSON.stringify(next.dialogs)) out.dialogs = next.dialogs;
  out.frames = next.frames;
  if (next.screenshot) out.screenshot = next.screenshot;
  out.changed = out.urlChanged || out.added.length > 0 || out.removed.length > 0
    || 'text' in out || 'dialogs' in out;
  return out;
}

module.exports = { see, observe, diff, collect };
