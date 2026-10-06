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

  // Элемент перекрыт, если в его центре лежит чужой элемент (модалка, оверлей).
  const covered = (el, r) => {
    const top = document.elementFromPoint(
      Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1),
      Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1),
    );
    return !top || !(el === top || el.contains(top) || top.contains(el));
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

  const nameOf = (el) => {
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const t = labelledby.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ');
      if (t.trim()) return clip(t, nameLimit);
    }
    const aria = el.getAttribute('aria-label');
    if (aria) return clip(aria, nameLimit);
    if (el.labels && el.labels[0]) return clip(el.labels[0].textContent, nameLimit);
    const own = clip(el.innerText || el.textContent, nameLimit);
    if (own) return own;
    return clip(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt')
      || el.querySelector('img[alt]')?.getAttribute('alt') || el.getAttribute('value'), nameLimit);
  };

  const elements = [];
  let n = 0;
  for (const el of document.querySelectorAll(SELECTOR)) {
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
  for (const d of document.querySelectorAll('dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true]')) {
    if (!visible(d)) continue;
    const ids = [];
    store.els.forEach((e, i) => { if (e && d.contains(e)) ids.push(i); });
    dialogs.push({ name: nameOf(d) || clip(d.innerText, nameLimit), text: clip(d.innerText, 600), elements: ids });
  }

  return {
    gen,
    url: location.href,
    title: document.title,
    text: clip(document.body ? document.body.innerText : '', textLimit),
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
  if (prev.text !== next.text) out.text = next.text;
  if (JSON.stringify(prev.dialogs) !== JSON.stringify(next.dialogs)) out.dialogs = next.dialogs;
  out.frames = next.frames;
  if (next.screenshot) out.screenshot = next.screenshot;
  out.changed = out.urlChanged || out.added.length > 0 || out.removed.length > 0
    || 'text' in out || 'dialogs' in out;
  return out;
}

module.exports = { see, observe, diff, collect };
