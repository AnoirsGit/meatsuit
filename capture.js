/**
 * Архив экранов: подпись структуры экрана (signature) и запись снимков/HTML на диск.
 *
 *   const cap = createCapture({ dir, htmlPerSignature: 5, maxMB: 500 });
 *   await cap.write(snapshot, cmd, () => page.content());
 *
 * Пишет <dir>/<дата>/<seq>.json ({ts, signature, shape, urlPattern, title, snapshot, cmd, html?})
 * и рядом <seq>.html (санитизированный) не больше htmlPerSignature раз на подпись.
 * Страницу не трогает: page.content() только читает.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// ---- Подпись ----

const NAME_MAX = 40;
const NAME_TEXT = '<текст>';
const NAME_PERSON = '<имя>';

/** Шаблон адреса: id, числа и длинные токены в пути заменяются на :id; query и hash отбрасываются. */
function urlPattern(url) {
  let p;
  try { p = new URL(url, 'https://x.invalid').pathname; } catch { return '?'; }
  const seg = (s) => (/^\d+$/.test(s) || (/\d/.test(s) && s.length >= 6) || s.length >= 20 ? ':id' : s);
  return p.split('/').map(seg).join('/') || '/';
}

/** Имя элемента без людей, цифр и длинных текстов: то, что одинаково на похожих экранах. */
function normalizeName(el) {
  if (el.role === 'link' && el.href && urlPattern(el.href).includes(':id')) return NAME_PERSON;
  const n = String(el.name || '').toLowerCase().replace(/\s+/g, ' ').trim().replace(/\d+/g, '#');
  return n.length > NAME_MAX ? NAME_TEXT : n;
}

const elementKey = (e) => {
  const flags = (e.disabled ? ' disabled' : '') + (e.role === 'textbox' && e.value ? ' filled' : '');
  return `${e.role} «${normalizeName(e)}»${e.href ? ` -> ${urlPattern(e.href)}` : ''}${flags}`;
};

// Количество одинаковых элементов сглаживаем: 3 и 4 человека в списке — один экран, 7 — другой.
const bucket = (n) => (n === 1 ? 'x1' : n <= 5 ? 'x2-5' : 'x6+');

/**
 * Структурный отпечаток экрана. Чистая функция: { hash, shape, urlPattern }.
 * Разные люди, тексты сообщений, id в адресе и цифры в именах подпись не меняют;
 * другой набор элементов/ролей, диалоги и frames — меняют.
 */
function signature(snap) {
  const counts = new Map();
  for (const e of snap.elements || []) { const k = elementKey(e); counts.set(k, (counts.get(k) || 0) + 1); }
  const lines = [...counts].map(([k, n]) => `${k} ${bucket(n)}`).sort();
  const byId = new Map((snap.elements || []).map((e) => [e.id, elementKey(e)]));
  const dialogs = (snap.dialogs || [])
    .map((d) => `dialog[${[...new Set((d.elements || []).map((id) => byId.get(id)).filter(Boolean))].sort().join('; ')}]`).sort();
  const hosts = [...new Set((snap.frames || []).map((u) => { try { return new URL(u).hostname; } catch { return '?'; } }))].sort();
  const pat = urlPattern(snap.url);
  const shape = [`url ${pat}`, ...lines, ...dialogs, ...(hosts.length ? [`frames ${hosts.join(',')}`] : [])].join('\n');
  return { hash: crypto.createHash('sha1').update(shape).digest('hex').slice(0, 10), shape, urlPattern: pat };
}

// ---- Санитизация HTML ----

const ATTRS = '(?:"[^"]*"|\'[^\']*\'|[^>"\'])*';

/** Вырезает тела script/style, value у password/hidden и длинные data:-URI. Работает по строке. */
function sanitizeHtml(html) {
  return String(html)
    .replace(/(<(script|style)\b[^>]*>)[\s\S]*?(?:<\/\2\s*>|$)/gi, (m, open, tag) => `${open}</${tag}>`)
    // value у полей ввода: пароль, hidden (csrf), почта, телефон, автозаполнение. Структуре они не нужны.
    // Оставляем только у кнопок и переключателей: там value часто и есть подпись.
    .replace(new RegExp(`<input\\b${ATTRS}>`, 'gi'), (tag) => (/\btype\s*=\s*["']?(checkbox|radio|submit|button|reset|image)\b/i.test(tag)
      ? tag : tag.replace(/\svalue\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')))
    // <meta name="csrf-token" content="…"> и подобные: токены страницы
    .replace(/<meta\b[^>]*\bname\s*=\s*["']?[^"'>\s]*(csrf|token|nonce)[^"'>\s]*["']?[^>]*>/gi, (tag) => tag.replace(/\scontent\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, ' content=""'))
    .replace(/data:[^"'\s)<>]+/gi, (m) => (m.length > 200 ? 'data:[вырезано]' : m));
}

// ---- Запись ----

const sizeOf = (dir) => {
  let total = 0;
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    total += f.isDirectory() ? sizeOf(p) : fs.statSync(p).size;
  }
  return total;
};
const dateDirs = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name)).map((d) => d.name).sort();

function createCapture({ dir, htmlPerSignature = 5, maxMB = 500, now = () => new Date() }) {
  if (!dir) throw new Error('capture: нужен dir');
  const countsFile = path.join(dir, 'html-counts.json');
  let counts = null; // подпись → сколько HTML сохранено (переживает перезапуски)
  let total = 0;     // байт в архиве
  const seqs = new Map(); // дата → следующий номер

  const init = () => {
    fs.mkdirSync(dir, { recursive: true });
    try { counts = JSON.parse(fs.readFileSync(countsFile, 'utf8')); } catch { counts = {}; }
    total = sizeOf(dir);
  };

  const trim = () => {
    const days = dateDirs(dir);
    while (total > maxMB * 1024 * 1024 && days.length > 1) { // сегодняшнюю папку не удаляем
      fs.rmSync(path.join(dir, days.shift()), { recursive: true, force: true });
      total = sizeOf(dir);
    }
  };

  const nextSeq = (day) => {
    if (!seqs.has(day)) {
      const names = fs.existsSync(path.join(dir, day)) ? fs.readdirSync(path.join(dir, day)) : [];
      seqs.set(day, 1 + Math.max(0, ...names.map((n) => parseInt(n, 10) || 0)));
    }
    const n = seqs.get(day);
    seqs.set(day, n + 1);
    return String(n).padStart(5, '0');
  };

  /** getHtml вызывается только когда HTML ещё нужен для этой подписи. */
  async function write(snapshot, cmd, getHtml) {
    if (!counts) init();
    const ts = now();
    const day = ts.toISOString().slice(0, 10);
    const sig = signature(snapshot);
    const seq = nextSeq(day);
    fs.mkdirSync(path.join(dir, day), { recursive: true });
    const entry = { ts: ts.toISOString(), signature: sig.hash, shape: sig.shape, urlPattern: sig.urlPattern, title: snapshot.title };
    let html = null;
    if ((counts[sig.hash] || 0) < htmlPerSignature && getHtml) {
      html = sanitizeHtml(await getHtml());
      entry.html = `${seq}.html`;
      counts[sig.hash] = (counts[sig.hash] || 0) + 1;
    }
    const { screenshot, ...snap } = snapshot; // картинка раздула бы архив
    entry.snapshot = snap;
    if (cmd) entry.cmd = cmd;
    const json = JSON.stringify(entry);
    fs.writeFileSync(path.join(dir, day, `${seq}.json`), json);
    total += Buffer.byteLength(json);
    if (html !== null) { fs.writeFileSync(path.join(dir, day, entry.html), html); total += Buffer.byteLength(html); }
    fs.writeFileSync(countsFile, JSON.stringify(counts));
    trim();
    return entry;
  }

  return { write };
}

module.exports = { signature, urlPattern, normalizeName, sanitizeHtml, createCapture };
