/**
 * Глаза: снимок страницы, который можно отдать модели.
 *
 * observe() читает видимые интерактивные элементы и нумерует их. Сами элементы остаются
 * в изолированном мире (dom.js), страница не меняется: ни атрибутов, ни свойств window.
 * Номера живут в пределах одного снимка. Поколения (gen) считает вызывающий (hands) в Node.
 *
 * Чтение по запросу (within, tree, items, см. readOpts) только добавляет поля: остальной снимок тот же, guard
 * смотрит его. Это описание того, что прочитать (селекторы, имена атрибутов), а не код: JS вызывающего не выполняется.
 *
 * diff() — чистая функция, её проверяет test/eyes.test.js.
 */
const { openWorld, run } = require('./dom.js');

const TEXT_LIMIT = 6000;
const NAME_LIMIT = 80;
const OPTIONS_LIMIT = 100; // вариантов <select> в снимке; больше — первые 100 и optionsTotal
const TEXT_MAX = 20000; // потолок textLimit у within и tree
const ITEMS_MAX = 50;
const ITEM_TEXT = 600; // текст одного item по умолчанию; потолок ITEM_TEXT_MAX
const ITEM_TEXT_MAX = 2000;
const FLAGS_MAX = 10;
const ATTRS_MAX = 10;
// Атрибуты item, которые можно запросить: data-* и эти. value нет: в нём бывает пароль.
const ATTRS = new Set(['alt', 'aria-label', 'datetime', 'href', 'title']);
const DATA_ATTR = /^data-[a-z0-9_.:-]+$/;

/** Неверные within/tree/items/textLimit у see(); hands отдаёт её вызывающему как BadCommand. */
class BadRead extends Error {}

/** Проверить и привести опции чтения see() к виду для collect. Числа выше потолка срезаются до потолка. */
function readOpts({ within, tree, items, textLimit } = {}) {
  const bad = (m) => { throw new BadRead(`see: ${m}`); };
  const obj = (o, keys, what) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) bad(`${what} — объект`);
    const extra = keys ? Object.keys(o).filter((k) => !keys.includes(k)) : [];
    if (extra.length) bad(`${what}: лишние поля ${extra.join(', ')}`);
  };
  const css = (s, what) => (typeof s === 'string' && s.trim() && s.length <= 500 ? s : bad(`${what} — CSS-селектор, непустая строка до 500 символов`));
  const count = (n, max, what) => (Number.isInteger(n) && n > 0 ? Math.min(n, max) : bad(`${what} — целое больше 0`));
  const out = {};
  if (within !== undefined) {
    obj(within, ['css', 'role', 'name'], 'within');
    if (within.css !== undefined) {
      if (within.role !== undefined || within.name !== undefined) bad('within — либо { css }, либо { role, name? }');
      out.within = { css: css(within.css, 'within.css') };
    } else {
      if (typeof within.role !== 'string' || !within.role) bad('within.role — непустая строка');
      if (within.name !== undefined && typeof within.name !== 'string') bad('within.name — строка');
      out.within = { role: within.role, name: within.name };
    }
  }
  if (tree !== undefined && tree !== false) {
    if (tree !== true) bad('tree — true или false');
    out.tree = true;
  }
  if (textLimit !== undefined) {
    if (!out.within && !out.tree) bad('textLimit — длина within.text и tree; у items свой items.textLimit');
    out.textLimit = count(textLimit, TEXT_MAX, 'textLimit');
  }
  if (items !== undefined) {
    obj(items, ['css', 'first', 'last', 'textLimit', 'flags', 'attrs'], 'items');
    if ((items.first === undefined) === (items.last === undefined)) bad('items — ровно одно из first и last');
    const flags = items.flags === undefined ? {} : items.flags;
    obj(flags, null, 'items.flags');
    const attrs = items.attrs === undefined ? [] : items.attrs;
    if (Object.keys(flags).length > FLAGS_MAX) bad(`items.flags — не больше ${FLAGS_MAX}`);
    if (!Array.isArray(attrs) || attrs.length > ATTRS_MAX) bad(`items.attrs — массив до ${ATTRS_MAX} имён`);
    for (const a of attrs) if (!(ATTRS.has(a) || DATA_ATTR.test(a))) bad(`items.attrs: «${a}» нельзя, можно data-* и ${[...ATTRS].join(', ')}`);
    out.items = {
      css: css(items.css, 'items.css'),
      last: items.last !== undefined,
      n: count(items.last ?? items.first, ITEMS_MAX, items.last !== undefined ? 'items.last' : 'items.first'),
      textLimit: items.textLimit === undefined ? ITEM_TEXT : count(items.textLimit, ITEM_TEXT_MAX, 'items.textLimit'),
      flags: Object.entries(flags).map(([k, v]) => [k, css(v, `items.flags.${k}`)]),
      attrs,
    };
  }
  return out;
}

/** Выполняется внутри страницы, поэтому самодостаточна. */
function collect({ textLimit, nameLimit, optionsLimit, gen, read }) {
  // Селекторы чтения проверяем до всего: неверный — ответ без снимка, observe бросит BadRead.
  if (read) {
    const sels = [read.within && read.within.css, read.items && read.items.css, ...(read.items ? read.items.flags.map((f) => f[1]) : [])];
    for (const s of sels.filter(Boolean)) {
      try { document.createDocumentFragment().querySelector(s); } catch { return { badSelector: s }; }
    }
  }
  // Хранилище живёт в изолированном мире: страница его не видит. Мир с этим именем в документе один и тот же,
  // поэтому в globalThis оно попадает, только когда снимок собран: упавший снимок не перепривязывает номера прошлого.
  const norm = (el) => (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const store = {
    els: [null], // els[id] = элемент; нулевой номер не используем
    text: [null], // текст узла в момент снимка: по нему видно подмену содержимого
    same: (id) => { const e = store.els[id]; return !!e && e.isConnected && norm(e) === store.text[id]; },
    box: (id) => { const e = store.els[id]; if (!e || !e.isConnected) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; },
  };

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

  // Верхний элемент в центре прямоугольника. elementFromPoint отдаёт хост: спускаемся внутрь открытых корней.
  const topAt = (r) => {
    const x = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1);
    const y = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1);
    let top = document.elementFromPoint(x, y);
    for (let s = top && top.shadowRoot; s; s = top.shadowRoot) {
      const inner = s.elementFromPoint(x, y);
      if (!inner || inner === top) break;
      top = inner;
    }
    return top;
  };
  // Элемент перекрыт, если в его центре лежит чужой элемент (модалка, оверлей).
  const covered = (el, r) => {
    const top = topAt(r);
    return !top || !(el === top || inside(el, top) || inside(top, el));
  };

  // Поле файла почти всегда спрятано (display:none, hidden, opacity:0), а человек видит его метку или кнопку
  // рядом. Такое поле в снимке есть: видимость и перекрытие — по метке (label for или обёртка) или кнопке
  // в том же родителе, номер ведёт на само поле (upload ставит файл в него). Прозрачное поле поверх метки
  // перекрытием не считается.
  const isFile = (el) => el.tagName === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'file';
  const fileProxy = (el) => {
    const cands = [...(el.labels || [])];
    const parent = el.parentElement;
    if (parent && parent !== document.body) cands.push(...parent.querySelectorAll('button,[role=button]'));
    for (const p of cands) {
      const r = visible(p);
      if (!r) continue;
      if (inViewport(r) && covered(p, r) && topAt(r) !== el) continue;
      return { el: p, rect: r };
    }
    return null;
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
      return { checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', file: 'button' }[t] || 'textbox';
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
    let r = visible(el);
    let proxy = null;
    if (isFile(el) && (!r || (inViewport(r) && covered(el, r)))) { // спрятано или накрыто своей же меткой
      proxy = fileProxy(el);
      if (!proxy) continue;
      r = proxy.rect;
    }
    if (!r) continue;
    const seen = inViewport(r);
    if (!proxy && seen && covered(el, r)) continue;
    n += 1;
    store.els[n] = el;
    store.text[n] = norm(el);
    const role = roleOf(el);
    const item = { id: n, role, name: nameOf(el) || (proxy ? nameOf(proxy.el) : ''), inView: seen };
    const inputType = el.tagName === 'INPUT' ? (el.getAttribute('type') || 'text').toLowerCase() : undefined;
    if (el.tagName === 'A' && el.getAttribute('href')) item.href = clip(el.getAttribute('href'), 200); // нужен проектам, чтобы узнавать страницы и записи по адресу
    if (inputType === 'password') item.inputType = 'password'; // значение пароля модели не отдаём никогда
    else if (inputType === 'file') {
      // Что прикреплено: имена файлов (Chrome в value отдаёт C:\fakepath\…), по ним видно, что резюме встало.
      item.inputType = 'file';
      item.value = clip([...(el.files || [])].map((f) => f.name).join(', '), nameLimit);
    } else if (el.tagName === 'SELECT') {
      // Человек видит подписи, а не value: подпись выбранного и подписи вариантов (по ним команда select).
      const opts = [...el.options];
      item.value = clip(opts.filter((o) => o.selected).map((o) => o.label).join(', '), nameLimit);
      item.options = opts.slice(0, optionsLimit).map((o) => clip(o.label, nameLimit));
      if (opts.length > optionsLimit) item.optionsTotal = opts.length;
    } else if (role === 'textbox' || role === 'select') item.value = clip(el.value ?? el.textContent, nameLimit);
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
  const snap = {
    gen,
    url: location.href,
    title: document.title,
    text: clip(parts.join(' '), textLimit),
    // Длины кусков text (light DOM, затем каждый shadow-корень): порог короткой страницы в guard к каждому отдельно.
    ...(parts.length > 1 ? { textParts: parts.map((p) => p.length) } : {}),
    elements,
    dialogs,
  };
  const done = () => { globalThis.__ms = store; return snap; };
  if (!read) return done();

  // Чтение по запросу. Дерево: текст и смысловые узлы (роль, заголовок, список, статья, время, поля и кнопки
  // с номерами снимка); обёртки без роли схлопываются: пустая пропадает, с одним ребёнком становится им, с
  // несколькими остаётся группой. Строчные обёртки прозрачны, их текст течёт дальше, поэтому слова не рвутся,
  // а alt картинки (эмодзи) стоит на своём месте. Скрытое (display:none, visibility:hidden), <script>, <style>,
  // <svg> и содержимое полей ввода не входят: значения полей — в elements, их имена — как в elements.
  // Не ariaSnapshot() Playwright: в playwright-core 1.63 он отдаёт значение поля пароля, а номеров снимка для рук у
  // его узлов нет (проверено 05.11 в headless Chromium).
  const TAG_ROLE = { H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading', UL: 'list', OL: 'list', LI: 'listitem', ARTICLE: 'article', DIALOG: 'dialog', TIME: 'time' };
  const semRole = (el) => {
    const r = el.getAttribute('role');
    if (r) return /^(none|presentation|generic)$/.test(r) ? null : r;
    return el.matches(SELECTOR) ? roleOf(el) : TAG_ROLE[el.tagName] || null;
  };
  const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|IFRAME|FRAME|OBJECT|EMBED|CANVAS|VIDEO|AUDIO|HEAD|LINK|META)$/;
  const FIELD = /^(INPUT|TEXTAREA|SELECT)$/;
  const idOf = new Map(store.els.map((e, i) => [e, i]));
  // Дети в составном дереве; у закрытого <details> человек видит только <summary>.
  const kidsOf = (el) => (el.tagName === 'SLOT' ? el.assignedNodes({ flatten: true })
    : el.tagName === 'DETAILS' && !el.open ? [...el.children].filter((c) => c.tagName === 'SUMMARY').slice(0, 1)
      : [...(el.shadowRoot || el).childNodes]);
  const walk = (el) => {
    const out = [];
    let run = '';
    const flush = () => { const t = squash(run); if (t) out.push(t); run = ''; };
    const add = (n) => {
      if (n.nodeType === Node.TEXT_NODE) {
        const host = n.parentElement || n.getRootNode().host;
        if (!n.data.trim()) run += ' ';
        else if (drawn(n) && (!host || getComputedStyle(host).visibility === 'visible')) run += n.data;
        return;
      }
      if (n.nodeType !== Node.ELEMENT_NODE || SKIP.test(n.tagName) || n instanceof SVGElement) return;
      const st = getComputedStyle(n);
      if (st.display === 'none' || st.contentVisibility === 'hidden') return; // содержимое не отрисовано (innerText его тоже не берёт)
      if (st.visibility !== 'visible') { kidsOf(n).forEach(add); return; } // сам не виден, видимым может быть потомок
      if (n.tagName === 'BR') { run += ' '; return; }
      if (n.tagName === 'IMG') { run += ` ${n.getAttribute('alt') || ''} `; return; }
      // Строчная обёртка (inline, contents) прозрачна. inline-block и прочие — отдельный кусок: значок, время, счётчик.
      const inline = st.display === 'inline' || st.display === 'contents';
      const role = semRole(n);
      if (!role) {
        if (inline) { kidsOf(n).forEach(add); return; }
        flush();
        const kids = walk(n);
        if (kids.length > 1) out.push({ kids }); else out.push(...kids);
        return;
      }
      flush();
      const kids = FIELD.test(n.tagName) || role === 'textbox' ? [] : walk(n);
      const text = kids.length === 1 && typeof kids[0] === 'string' ? kids[0] : '';
      // Имя — то, чего нет в тексте узла: у пустого (поле, кнопка-иконка) — имя снимка, у остальных — aria-label, у time — datetime.
      let name = clip(role === 'time' ? n.getAttribute('datetime') : kids.length ? n.getAttribute('aria-label') : nameOf(n), nameLimit);
      if (name === clip(text, nameLimit)) name = '';
      const id = idOf.get(n);
      if (!kids.length && !id && !visible(n)) return; // пустой и без своей рамки: имя из nameOf было бы скрытым текстом
      if (kids.length || name || id) out.push({ role, name, id, kids });
    };
    kidsOf(el).forEach(add);
    flush();
    return out.length === 1 && !out[0].role && out[0].kids ? out[0].kids : out; // единственная группа — это и есть дети
  };
  // Дерево текстом, как список YAML: «- текст», «- [роль #номер "имя"] текст», группа — «- - …».
  const render = (nodes, depth) => nodes.map((n) => {
    const pad = '  '.repeat(depth);
    if (typeof n === 'string') return `${pad}- ${n}`;
    if (!n.role) return `${pad}- ${render(n.kids, depth + 1).slice(pad.length + 2)}`;
    const head = `${pad}- [${n.role}${n.id ? ` #${n.id}` : ''}${n.name ? ` ${JSON.stringify(n.name)}` : ''}]`;
    if (n.kids.length === 1 && typeof n.kids[0] === 'string') return `${head} ${n.kids[0]}`;
    return n.kids.length ? `${head}\n${render(n.kids, depth + 1)}` : head;
  }).join('\n');
  const flat = (nodes) => nodes.map((n) => (typeof n === 'string' ? n : flat(n.kids))).filter(Boolean).join(' ');
  const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  // Текст строками: узел не глубже двух уровней (сообщение со временем, строка списка со ссылкой, абзац со ссылкой) —
  // одна строка, узел крупнее — строки его детей.
  const height = (n) => (typeof n === 'string' ? 0 : 1 + n.kids.reduce((m, k) => Math.max(m, height(k)), 0));
  const lines = (list) => list.flatMap((n) => (typeof n === 'string' || height(n) <= 2 ? [flat([n])] : lines(n.kids))).filter(Boolean);

  const limit = read.textLimit || textLimit;
  let root = document.body;
  if (read.within) {
    const { css, role, name } = read.within;
    root = deepAll(document, (e) => (css ? e.matches(css) : semRole(e) === role && (name === undefined || nameOf(e) === name)) && drawn(e) && getComputedStyle(e).visibility === 'visible')[0] || null;
  }
  const nodes = root && (read.within || read.tree) ? walk(root) : null;
  if (read.within) {
    const ids = [];
    if (root) store.els.forEach((e, i) => { if (e && inside(root, e)) ids.push(i); });
    snap.within = root && { text: cut(lines(nodes).join('\n'), limit), elements: ids };
  }
  if (read.tree) snap.tree = root && cut(render(nodes, 0), limit);
  if (read.items) {
    const { css, last, n, textLimit: itemLimit, flags, attrs } = read.items;
    const all = root && deepAll(document, (e) => e.matches(css) && (root === document.body || inside(root, e)) && !!visible(e));
    const pick = all && (last ? all.slice(-n) : all.slice(0, n));
    snap.items = pick && pick.map((e) => {
      const it = { text: cut(lines([{ kids: walk(e) }]).join('\n'), itemLimit), inView: inViewport(e.getBoundingClientRect()) };
      if (idOf.has(e)) it.id = idOf.get(e);
      if (flags.length) it.flags = Object.fromEntries(flags.map(([k, sel]) => [k, e.matches(sel)]));
      if (attrs.length) {
        it.attrs = {};
        const password = e.tagName === 'INPUT' && (e.getAttribute('type') || '').toLowerCase() === 'password';
        for (const a of attrs) if (!password && e.hasAttribute(a)) it.attrs[a] = clip(e.getAttribute(a), 200);
      }
      return it;
    });
    if (all && all.length > pick.length) snap.itemsTotal = all.length;
  }
  return done();
}

/**
 * Снимок страницы.
 * opts.screenshot — добавить сжатый JPEG (base64).
 * opts.since      — прошлый снимок: вернуть только изменения (см. diff).
 * opts.gen        — номер поколения; hands держит монотонный счётчик.
 * opts.within, opts.tree, opts.items, opts.textLimit — чтение по запросу (readOpts).
 */
let standaloneGen = 0;

/** <iframe> кадра сейчас скрыт: visibility: hidden, display: none или нулевой размер. Кадр исчез — считаем показанным, guard не ослабляем. */
async function frameHidden(frame) {
  let el;
  try { el = await frame.frameElement(); return !(await el.isVisible()); }
  catch { return false; }
  finally { if (el) await el.dispose().catch(() => {}); }
}

/**
 * Снимок и мир, в котором лежат его элементы (нужен рукам).
 * opts.screenshot — добавить сжатый JPEG (base64).
 * opts.gen        — номер поколения; hands держит монотонный счётчик.
 */
async function observe(page, opts = {}) {
  const read = readOpts(opts);
  const gen = opts.gen || ++standaloneGen;
  const world = await openWorld(page);
  const snap = await run(world, collect, { textLimit: TEXT_LIMIT, nameLimit: NAME_LIMIT, optionsLimit: OPTIONS_LIMIT, gen,
    read: Object.keys(read).length ? read : undefined });
  if (snap.badSelector !== undefined) throw new BadRead(`see: неверный CSS-селектор ${JSON.stringify(snap.badSelector)}`);
  // Чужие iframe (капча, Arkose) в DOM страницы не видны, поэтому отдаём их адреса.
  // page.frames() отдаёт все кадры, в том числе скрытые. Какие из них человек сейчас не видит,
  // отдаём отдельно: по этому guard отличает спрятанное задание reCAPTCHA от показанного.
  const frames = page.frames().filter((f) => f !== page.mainFrame() && f.url() && f.url() !== 'about:blank');
  snap.frames = frames.map((f) => f.url());
  const hidden = await Promise.all(frames.map(frameHidden));
  snap.hiddenFrames = snap.frames.filter((u, i) => hidden[i]);
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
  out.hiddenFrames = next.hiddenFrames;
  if (next.screenshot) out.screenshot = next.screenshot;
  // Чтение по запросу отдаётся целиком и в changed не входит: сравнивает вызывающий.
  for (const k of ['within', 'tree', 'items', 'itemsTotal']) if (k in next) out[k] = next[k];
  out.changed = out.urlChanged || out.added.length > 0 || out.removed.length > 0
    || 'text' in out || 'dialogs' in out;
  return out;
}

module.exports = { see, observe, diff, collect, readOpts, BadRead };
