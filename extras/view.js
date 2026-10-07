/**
 * «Видимый HTML»: копия того, что человек видит на странице, и номера кнопок,
 * полей и ссылок, по которым их потом нажимают.
 *
 * Страницу не трогаем: ни атрибутов, ни скриптов в её мир. Копия строится
 * внутри patchright на странице в изолированном мире (page.evaluate по умолчанию
 * идёт туда), страница своих переменных там не видит.
 *
 * Номер → элемент хранится в том же изолированном мире, в globalThis.__meatsuit
 * (Map). Проверено на настоящем Chromium через connectOverCDP: данные переживают
 * отдельные вызовы page.evaluate, пропадают при навигации и перезагрузке (новый
 * документ — новый мир), остаются при pushState (документ тот же). Это ровно
 * срок жизни, нужный по 04-http-api.md, поэтому запасной путь «путь по DOM»
 * не понадобился. Номера растут и после нового view не начинаются заново:
 * старый номер из прошлого view не должен молча попасть в другой элемент.
 *
 * Номер получает интерактивный элемент, только если в центре видимой части
 * elementFromPoint отдаёт его самого или потомка (иначе кнопку под модальным
 * окном модель «увидела» бы и нажала). За экраном проверить нечем, и там отсекает
 * только открытое модальное окно (dialog:modal или aria-modal="true").
 */
const { classify } = require('./guard.js');
const probe = require('./life/probe.js');

/**
 * Страничная часть: уходит в page.evaluate как есть и ничего снаружи не использует.
 * op: 'view' (копия и номера), 'find' (поиск цели по тексту или css), 'resolve' (номер → элемент).
 */
function inPage({ op, scope, kind, value, ref }) {
  const W = window, D = document;
  const S = (globalThis.__meatsuit = globalThis.__meatsuit || { map: new Map(), ids: new WeakMap(), next: 1 });
  const vw = W.innerWidth, vh = W.innerHeight;

  const norm = (s) => String(s == null ? '' : s).replace(/[\s\u00a0]+/g, ' ').trim();
  // Невидимое глазу: нулевая ширина, управляющие направления, символы-«теги» и прочее; они годятся только для скрытых вставок в текст.
  const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]/gu;
  const clean = (s) => String(s).replace(INVISIBLE, '');
  const esc = (s) => clean(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'base', 'title', 'svg', 'canvas', 'video', 'audio', 'object', 'embed', 'map', 'datalist', 'param', 'source', 'track']);
  const KEEP = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'a', 'button', 'label', 'form', 'fieldset', 'legend', 'details', 'summary', 'nav', 'main', 'header', 'footer', 'section', 'article', 'aside', 'blockquote', 'pre', 'code', 'strong', 'b', 'em', 'i']);
  const LEAF = new Set(['input', 'select', 'textarea', 'img', 'button', 'iframe', 'hr']);
  const ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'switch', 'textbox', 'combobox', 'searchbox', 'slider', 'spinbutton', 'treeitem']);
  const BLOCK = /^(block|flex|grid|list-item|table|table-row|table-row-group|table-header-group|table-footer-group|table-caption|flow-root)$/;

  const refOf = (el) => {
    let n = S.ids.get(el);
    if (!n) { n = S.next++; S.ids.set(el, n); S.map.set(n, el); }
    return n;
  };
  const checkVis = (el) => (el.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : true);

  if (op === 'resolve') {
    const el = S.map.get(ref);
    return el && el.isConnected && checkVis(el) ? el : null;
  }

  // ---- геометрия и перекрытие
  const inView = (r) => r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh;
  const rectsOf = (el) => [...el.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
  const composedContains = (a, b) => { for (let n = b; n; n = n.parentNode || n.host) if (n === a) return true; return false; };
  const hit = (x, y) => {
    let h = D.elementFromPoint(x, y);
    while (h && h.shadowRoot) { const inner = h.shadowRoot.elementFromPoint(x, y); if (!inner || inner === h) break; h = inner; }
    return h;
  };
  // Открытые модальные окна: они перекрывают всё, что не внутри них, даже за краем экрана.
  const modals = [...D.querySelectorAll('dialog[open], [aria-modal="true"]')].filter((m) => {
    let modal = m.getAttribute('aria-modal') === 'true';
    try { modal = modal || m.matches(':modal'); } catch (e) { /* старый браузер */ }
    return modal && checkVis(m) && rectsOf(m).length > 0;
  });
  const onTop = (el) => {
    const r = rectsOf(el)[0] || el.getBoundingClientRect();
    const x0 = Math.max(r.left, 0), x1 = Math.min(r.right, vw), y0 = Math.max(r.top, 0), y1 = Math.min(r.bottom, vh);
    if (x0 >= x1 || y0 >= y1) return !modals.some((m) => !composedContains(m, el)); // за экраном elementFromPoint не работает
    const h = hit((x0 + x1) / 2, (y0 + y1) / 2);
    return !!h && composedContains(el, h);
  };

  // ---- видимость самого элемента (предков проверяет обход сверху вниз)
  function shown(el, st) {
    if (st.display === 'none' || +st.opacity === 0) return false;
    if (el === D.body) return true; // у body с одними абсолютными потомками высота нулевая, страница при этом не пуста
    if (st.display === 'contents') return true;
    const r = el.getBoundingClientRect();
    const clips = st.overflowX !== 'visible' || st.overflowY !== 'visible';
    if (r.width === 0 || r.height === 0) return !clips && !LEAF.has(el.localName); // пустая коробка без обрезки: решают потомки
    if (clips && r.width <= 1 && r.height <= 1) return false;
    if (st.clip === 'rect(0px, 0px, 0px, 0px)') return false;
    return !(r.right + W.scrollX <= 0 || r.bottom + W.scrollY <= 0); // левее и выше начала документа
  }

  const controlShown = (c) => { const st = getComputedStyle(c); const r = c.getBoundingClientRect(); return checkVis(c) && st.display !== 'none' && r.width > 0 && r.height > 0; };
  function interactive(el, st) {
    const tag = el.localName;
    if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') return false;
    if (tag === 'input') return el.type !== 'hidden';
    if (tag === 'button' || tag === 'select' || tag === 'textarea' || tag === 'summary') return true;
    if (tag === 'a' && el.hasAttribute('href')) return true;
    if (tag === 'label') return !!el.control && !controlShown(el.control); // подпись скрытого флажка: нажимать приходится её
    const role = (el.getAttribute('role') || '').trim().toLowerCase().split(/\s+/)[0];
    if (ROLES.has(role)) return true;
    if (el.hasAttribute('tabindex') && el.tabIndex >= 0) return true;
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return true;
    if (el.hasAttribute('onclick')) return true;
    if (st.cursor === 'pointer' && st.pointerEvents !== 'none') {
      const p = el.parentElement; // cursor наследуется: номер у корня «кликабельного», а не у каждого его потомка
      return !(p && getComputedStyle(p).cursor === 'pointer');
    }
    return false;
  }

  // Как элемент называют на странице: по этим строкам его ищут по тексту.
  function names(el) {
    const out = [];
    const add = (s) => { s = norm(s); if (s && !out.includes(s)) out.push(s); };
    add(el.getAttribute('aria-label'));
    const by = el.getAttribute('aria-labelledby');
    if (by) add(by.split(/\s+/).map((id) => { const t = el.getRootNode().getElementById && el.getRootNode().getElementById(id); return t ? t.textContent : ''; }).join(' '));
    if (el.labels) for (const l of el.labels) add(l.innerText || l.textContent);
    const tag = el.localName;
    if (tag === 'input') { if (/^(button|submit|reset)$/.test(el.type)) add(el.value); }
    else if (tag !== 'select' && tag !== 'textarea') {
      add(el.innerText || el.textContent);
      const img = el.querySelector && el.querySelector('img[alt]');
      if (img) add(img.alt);
    }
    add(el.getAttribute('placeholder'));
    add(el.getAttribute('title'));
    return out;
  }

  // ---- обход: копия видимого и список интерактивных (cands) с признаком «лежит сверху»
  function walk(wanted, assign) {
    const st0 = { cands: [], seen: new WeakSet() };
    const range = D.createRange();

    const kids = (el) => {
      if (el.shadowRoot) return [...el.shadowRoot.childNodes];
      if (el.localName === 'slot') { const a = el.assignedNodes({ flatten: true }); return a.length ? a : [...el.childNodes]; }
      return [...el.childNodes];
    };

    function text(n, ctx) {
      if (!ctx.vis) return '';
      const raw = n.nodeValue || '';
      if (!raw.trim()) return /\s/.test(raw) && !ctx.pre ? ' ' : '';
      range.selectNodeContents(n);
      const rs = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
      if (!rs.length) return '';
      if (wanted === 'viewport' && !rs.some(inView)) return '';
      if (rs.every((r) => r.right + W.scrollX <= 0 || r.bottom + W.scrollY <= 0)) return '';
      if (!ctx.pre) return esc(raw.replace(/[\s\u00a0]+/g, ' '));
      return raw.split(/\r?\n/).map((l) => esc(l.replace(/[ \t\u00a0]+/g, ' '))).join('\u0001'); // переносы в pre переживают разбор по строкам
    }

    function attrs(el, ref) {
      const a = [];
      const put = (k, v) => { if (v !== null && v !== undefined && v !== false) a.push(v === true ? ` ${k}` : ` ${k}="${esc(String(v).slice(0, 2000))}"`); };
      const get = (k) => el.getAttribute(k);
      const tag = el.localName;
      if (ref) put('data-ms', ref);
      if (tag === 'a' && el.hasAttribute('href')) {
        put('href', get('href'));
        let abs = null; try { abs = el.href; } catch (e) { /* не ссылка */ }
        if (typeof abs === 'string' && abs !== get('href')) put('data-abs', abs);
      }
      if (tag === 'label') put('for', get('for'));
      if (tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'button') {
        put('id', get('id')); put('name', get('name'));
      }
      if (tag === 'button') put('type', get('type'));
      if (ref || tag === 'button') for (const k of ['role', 'aria-label', 'title', 'aria-checked', 'aria-expanded', 'aria-selected', 'aria-pressed', 'aria-haspopup']) put(k, get(k));
      if (el.isContentEditable && ref) put('contenteditable', 'true');
      if (el.disabled) put('disabled', true);
      return a.join('');
    }

    function control(el, ref) {
      const tag = el.localName;
      const a = attrs(el, ref);
      const label = !el.getAttribute('aria-label') && el.labels && el.labels.length ? norm([...el.labels].map((l) => l.innerText || l.textContent).join(' / ')).slice(0, 120) : '';
      const lab = label ? ` data-label="${esc(label)}"` : '';
      if (tag === 'input') {
        const type = (el.type || 'text').toLowerCase();
        const secret = type === 'password' || /\b(current-password|new-password|cc-number|cc-csc)\b/i.test(el.getAttribute('autocomplete') || '');
        let v = '';
        v += ` type="${esc(type)}"`;
        if (el.placeholder) v += ` placeholder="${esc(el.placeholder)}"`;
        if (type === 'checkbox' || type === 'radio') {
          if (el.hasAttribute('value')) v += ` value="${esc(el.getAttribute('value'))}"`;
          if (el.checked) v += ' checked';
        } else if (!secret && type !== 'file' && el.value) v += ` value="${esc(String(el.value).slice(0, 2000))}"`;
        if (type === 'image' && el.alt) v += ` alt="${esc(el.alt)}"`;
        if (el.readOnly) v += ' readonly';
        if (el.required) v += ' required';
        return `<input${a}${v}${lab}>`;
      }
      if (tag === 'textarea') {
        const ph = el.placeholder ? ` placeholder="${esc(el.placeholder)}"` : '';
        return `<textarea${a}${ph}${lab}>${esc(String(el.value).slice(0, 5000))}</textarea>`;
      }
      // select
      const opts = [...el.options].filter((o) => !o.hidden).slice(0, 500).map((o) => {
        const t = norm(o.text), v = o.value;
        return `<option${v !== t ? ` value="${esc(v)}"` : ''}${o.selected ? ' selected' : ''}${o.disabled ? ' disabled' : ''}>${esc(t)}</option>`;
      }).join('');
      return `<select${a}${el.multiple ? ' multiple' : ''}${lab}>${opts}</select>`;
    }

    function elem(el, depth, ctx) {
      const tag = el.localName;
      if (SKIP.has(tag) || depth > 400) return '';
      const st = getComputedStyle(el);
      if (!shown(el, st)) return '';
      const vis = st.visibility === 'visible';
      if (vis) st0.seen.add(el);
      const block = BLOCK.test(st.display);
      const sub = { vis, pre: st.whiteSpace.startsWith('pre') };

      // интерактивность и номер
      let ref = 0;
      if (vis && interactive(el, st)) {
        const rs = rectsOf(el);
        const inScope = wanted !== 'viewport' || rs.some(inView);
        const top = inScope && onTop(el);
        if (inScope) st0.cands.push({ el, top });
        if (top && assign) ref = refOf(el);
      }

      const flat = (s) => (block ? `\n${s}\n` : s);
      if (!vis) return flat(children(el, depth, sub)); // скрыт сам, но потомок мог вернуть visibility

      if (tag === 'br') return '\n';
      if (tag === 'hr') return flat('<hr>');
      if (tag === 'iframe') { const src = el.getAttribute('src'); return src ? flat(`<iframe src="${esc(src)}"></iframe>`) : ''; }
      if (tag === 'img') {
        if (wanted === 'viewport' && !rectsOf(el).some(inView)) return '';
        const alt = norm(el.getAttribute('alt'));
        if (!alt) return '';
        const src = el.getAttribute('src') || '';
        return `<img alt="${esc(alt)}"${src && !/^data:/i.test(src) ? ` src="${esc(src.slice(0, 500))}"` : ''}>`;
      }
      if (tag === 'input' || tag === 'select' || tag === 'textarea') {
        if (tag === 'input' && el.type === 'hidden') return '';
        if (wanted === 'viewport' && !rectsOf(el).some(inView)) return '';
        return `\n${control(el, ref)}\n`; // поля — каждое на своей строке
      }

      const inner = children(el, depth, sub);
      if (!KEEP.has(tag) && !ref) return flat(inner);
      if (wanted === 'viewport' && tag === 'button' && !ref && !rectsOf(el).some(inView)) return '';
      if (!inner.trim() && !ref && tag !== 'button') return ''; // пустая оболочка
      const name = /^[a-z][a-z0-9-]*$/.test(tag) ? tag : 'div';
      const out = `<${name}${attrs(el, ref)}>${inner}</${name}>`;
      return tag === 'button' ? `\n${out}\n` : flat(out);
    }

    function children(el, depth, ctx) {
      let s = '';
      for (const c of kids(el)) {
        if (c.nodeType === 3) s += text(c, ctx);
        else if (c.nodeType === 1) s += elem(c, depth + 1, ctx);
      }
      return s;
    }

    const body = (D.body ? elem(D.body, 0, { vis: true, pre: false }) : '')
      .replace(/[ \t]+/g, ' ')
      .split('\n').map((l) => l.trim()).filter(Boolean).join('\n')
      .replace(/\u0001/g, '\n');
    return { ...st0, body };
  }

  if (op === 'view') {
    S.map.clear(); // номера прошлого view больше не действуют (счётчик не сбрасывается: старый номер не попадёт в другой элемент)
    S.ids = new WeakMap();
    const w = walk(scope, true);
    return { body: w.body, count: S.map.size, scrollY: Math.round(W.scrollY), height: D.documentElement.scrollHeight, viewport: vh };
  }

  // op === 'find'
  const w = walk('page', false);
  let list;
  if (kind === 'css') {
    let found;
    try { found = [...D.querySelectorAll(value)]; } catch (e) { return { error: 'selector' }; }
    list = found.filter((el) => w.seen.has(el));
  } else {
    const q = norm(value).toLowerCase();
    const tops = w.cands.filter((c) => c.top).map((c) => c.el);
    const exact = tops.filter((el) => names(el).some((n) => n.toLowerCase() === q));
    list = exact.length ? exact : tops.filter((el) => names(el).some((n) => n.length <= 300 && n.toLowerCase().includes(q)));
  }
  list = list.filter((el) => !list.some((o) => o !== el && el.contains(o))); // вложенная пара: берём внутреннюю
  const label = (el) => (kind === 'text' ? (names(el).find((n) => n.toLowerCase() === norm(value).toLowerCase()) || names(el).find((n) => n.toLowerCase().includes(norm(value).toLowerCase())) || '') : (names(el)[0] || el.localName)).slice(0, 80);
  return { matches: list.slice(0, 50).map((el) => ({ ref: refOf(el), text: label(el) })), total: list.length };
}

/** Страница переходит: контекст уничтожается на середине вызова. Подождать загрузки и повторить (как stable в life/probe.js, там не экспортирован). */
async function stable(page, read) {
  for (let attempt = 0; ; attempt++) {
    try { return await read(); } catch (err) {
      if (attempt >= 4 || !/context was destroyed|navigat/i.test(err.message)) throw err;
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * Копия видимого. scope: 'page' или 'document' (весь документ, по умолчанию) или 'viewport'.
 * Возвращает { html, url, title, guard }; в head копии те же url, title, guard.
 */
async function view(page, { scope = 'page' } = {}) {
  if (scope === 'document') scope = 'page'; // server.js зовёт «document», в задании «page»: это одно и то же
  if (scope !== 'page' && scope !== 'viewport') throw new TypeError(`scope: «page» (он же «document») или «viewport», а не ${JSON.stringify(scope)}`);
  const r = await stable(page, () => page.evaluate(inPage, { op: 'view', scope }));
  const snap = await probe.snapshot(page);
  const guard = classify(snap);
  const head = [
    '<meta charset="utf-8">',
    `<title>${esc(snap.title)}</title>`,
    `<meta name="url" content="${esc(snap.url)}">`,
    `<meta name="guard" content="${guard === null ? 'null' : esc(guard)}">`,
    `<meta name="scope" content="${scope}">`,
    `<meta name="scroll-y" content="${r.scrollY}">`,
    `<meta name="page-height" content="${r.height}">`,
    `<meta name="viewport-height" content="${r.viewport}">`,
  ];
  const html = `<!doctype html>\n<html>\n<head>\n${head.join('\n')}\n</head>\n<body>\n${r.body}\n</body>\n</html>\n`;
  return { html, url: snap.url, title: snap.title, guard };
}

/** Элемент по номеру из последнего view (ElementHandle) или null, если номер устарел. */
async function element(page, ref) {
  const handle = await stable(page, () => page.evaluateHandle(inPage, { op: 'resolve', ref }));
  const el = handle.asElement();
  if (!el) await handle.dispose().catch(() => {});
  return el;
}

/**
 * Найти цель: { text } среди видимых интерактивных (сначала точное совпадение,
 * потом вхождение, регистр не важен) или { css } среди видимых. Совпавшим выдаются
 * номера (прежние, если уже есть). Вернёт { matches: [{ref, text}], total } или { error: 'selector' }.
 */
async function find(page, target) {
  const css = target.css !== undefined;
  return stable(page, () => page.evaluate(inPage, { op: 'find', kind: css ? 'css' : 'text', value: css ? target.css : target.text }));
}

module.exports = { view, element, find };
