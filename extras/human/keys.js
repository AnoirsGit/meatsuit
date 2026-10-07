/**
 * Печать: чистое планирование, без страницы. planTyping(text) возвращает
 * события клавиатуры со временем: нажатия и отпускания, Shift, опечатки с
 * исправлением. Нажатия описаны как у настоящей клавиатуры (код клавиши,
 * символ, раскладка), а не как «вставить текст».
 */
const { between, chance, clamp, normal, lognormal } = require('./random');

// Физические клавиши: [код, US, US+Shift, RU, RU+Shift, виртуальный код].
// Ряды сверху вниз; смещение ряда в «клавишах» нужно для геометрии соседей.
const ROWS = [
  { offset: 0, keys: [
    ['Backquote', '`', '~', 'ё', 'Ё', 192], ['Digit1', '1', '!', '1', '!', 49], ['Digit2', '2', '@', '2', '"', 50],
    ['Digit3', '3', '#', '3', '№', 51], ['Digit4', '4', '$', '4', ';', 52], ['Digit5', '5', '%', '5', '%', 53],
    ['Digit6', '6', '^', '6', ':', 54], ['Digit7', '7', '&', '7', '?', 55], ['Digit8', '8', '*', '8', '*', 56],
    ['Digit9', '9', '(', '9', '(', 57], ['Digit0', '0', ')', '0', ')', 48], ['Minus', '-', '_', '-', '_', 189],
    ['Equal', '=', '+', '=', '+', 187]] },
  { offset: 1.5, keys: [
    ['KeyQ', 'q', 'Q', 'й', 'Й', 81], ['KeyW', 'w', 'W', 'ц', 'Ц', 87], ['KeyE', 'e', 'E', 'у', 'У', 69],
    ['KeyR', 'r', 'R', 'к', 'К', 82], ['KeyT', 't', 'T', 'е', 'Е', 84], ['KeyY', 'y', 'Y', 'н', 'Н', 89],
    ['KeyU', 'u', 'U', 'г', 'Г', 85], ['KeyI', 'i', 'I', 'ш', 'Ш', 73], ['KeyO', 'o', 'O', 'щ', 'Щ', 79],
    ['KeyP', 'p', 'P', 'з', 'З', 80], ['BracketLeft', '[', '{', 'х', 'Х', 219], ['BracketRight', ']', '}', 'ъ', 'Ъ', 221],
    ['Backslash', '\\', '|', '\\', '/', 220]] },
  { offset: 1.75, keys: [
    ['KeyA', 'a', 'A', 'ф', 'Ф', 65], ['KeyS', 's', 'S', 'ы', 'Ы', 83], ['KeyD', 'd', 'D', 'в', 'В', 68],
    ['KeyF', 'f', 'F', 'а', 'А', 70], ['KeyG', 'g', 'G', 'п', 'П', 71], ['KeyH', 'h', 'H', 'р', 'Р', 72],
    ['KeyJ', 'j', 'J', 'о', 'О', 74], ['KeyK', 'k', 'K', 'л', 'Л', 75], ['KeyL', 'l', 'L', 'д', 'Д', 76],
    ['Semicolon', ';', ':', 'ж', 'Ж', 186], ['Quote', "'", '"', 'э', 'Э', 222]] },
  { offset: 2.25, keys: [
    ['KeyZ', 'z', 'Z', 'я', 'Я', 90], ['KeyX', 'x', 'X', 'ч', 'Ч', 88], ['KeyC', 'c', 'C', 'с', 'С', 67],
    ['KeyV', 'v', 'V', 'м', 'М', 86], ['KeyB', 'b', 'B', 'и', 'И', 66], ['KeyN', 'n', 'N', 'т', 'Т', 78],
    ['KeyM', 'm', 'M', 'ь', 'Ь', 77], ['Comma', ',', '<', 'б', 'Б', 188], ['Period', '.', '>', 'ю', 'Ю', 190],
    ['Slash', '/', '?', '.', ',', 191]] },
];

// Палец на клавишу: 0–3 левая рука (мизинец…указательный), 4–7 правая (указательный…мизинец), 8 — большой.
const FINGERS = [
  ['Backquote Digit1 KeyQ KeyA KeyZ', 0], ['Digit2 KeyW KeyS KeyX', 1], ['Digit3 KeyE KeyD KeyC', 2],
  ['Digit4 Digit5 KeyR KeyT KeyF KeyG KeyV KeyB', 3], ['Digit6 Digit7 KeyY KeyU KeyH KeyJ KeyN KeyM', 4],
  ['Digit8 KeyI KeyK Comma', 5], ['Digit9 KeyO KeyL Period', 6],
  ['Digit0 Minus Equal KeyP BracketLeft BracketRight Backslash Semicolon Quote Slash', 7],
];
const fingerOf = new Map(FINGERS.flatMap(([codes, f]) => codes.split(' ').map((c) => [c, f])));
const handOf = (finger) => (finger < 4 ? 'L' : finger < 8 ? 'R' : 'T');

const KEYS = new Map();
ROWS.forEach((row, r) => row.keys.forEach(([code, us, usShift, ru, ruShift, vk], i) => {
  KEYS.set(code, { code, us, usShift, ru, ruShift, vk, row: r, x: row.offset + i, finger: fingerOf.get(code) });
}));

/** Нажатие: что получится, какая клавиша, нужен ли Shift, идёт ли сырым событием раскладки. */
function entryFor(k, shift, layout) {
  const text = layout === 'ru' ? (shift ? k.ruShift : k.ru) : (shift ? k.usShift : k.us);
  return { code: k.code, key: text, text, name: text, vk: k.vk, shift, finger: k.finger, row: k.row, raw: layout === 'ru' };
}
const special = (code, key, text, vk, finger, row) => ({ code, key, text, name: key === ' ' ? ' ' : key, vk, shift: false, finger, row, raw: false });
const SPACE = special('Space', ' ', ' ', 32, 8, 4);
const ENTER = special('Enter', 'Enter', '\n', 13, 7, 2);
const BACKSPACE = special('Backspace', 'Backspace', '', 8, 7, 0);
const shiftFor = (finger) => {
  const code = handOf(finger) === 'L' ? 'ShiftRight' : 'ShiftLeft';
  return { ...special(code, 'Shift', '', 16, 8, 3), name: code };
};

const US = new Map([[' ', SPACE], ['\n', ENTER]]);
const RU = new Map();
for (const k of KEYS.values()) {
  for (const shift of [false, true]) {
    const us = entryFor(k, shift, 'us'), ru = entryFor(k, shift, 'ru');
    if (!US.has(us.text)) US.set(us.text, us);
    if (ru.text !== us.text && !RU.has(ru.text)) RU.set(ru.text, ru);
  }
}

/** Клавиша для символа в активной раскладке; null, если такой нет ни в одной. */
function lookup(ch, layout) {
  if (layout === 'ru' && RU.has(ch)) return RU.get(ch);
  return US.get(ch) || RU.get(ch) || null;
}
const CYRILLIC = /\p{Script=Cyrillic}/u, LATIN = /[A-Za-z]/;

const neighborCache = new Map();
/** Коды соседних клавиш: в том же ряду рядом и в соседних рядах с учётом сдвига рядов. */
function neighbors(code) {
  if (!neighborCache.has(code)) {
    const me = KEYS.get(code);
    const found = new Set();
    for (const k of KEYS.values()) {
      const dx = Math.abs(k.x - me.x), dr = Math.abs(k.row - me.row);
      if ((dr === 0 && dx > 0 && dx <= 1) || (dr === 1 && dx < 1)) found.add(k.code);
    }
    neighborCache.set(code, found);
  }
  return neighborCache.get(code);
}

/** Множитель интервала для пары клавиш: руки чередуются быстрее, один палец медленнее. */
function digraph(a, b) {
  if (!a || a.code === 'Backspace') return 1;
  if (b.code === 'Space') return 0.9;
  if (a.code === 'Space') return 1.05;
  if (a.code === b.code) return 1.15;
  const rows = Math.abs(a.row - b.row);
  if (handOf(a.finger) !== handOf(b.finger)) return 0.82;
  if (a.finger === b.finger) return 1.4 * (1 + 0.1 * rows);
  return 1 + 0.06 * rows;
}

/**
 * Что нажимать и когда. Опечатка и её исправление планируются целиком:
 * промах, несколько символов «вслепую» до того как заметил, пауза,
 * Backspace, перепечатка. Итог в поле всегда равен заказанному тексту.
 */
function planTyping(text, { wpm, typoRate = 0.025, rnd = Math.random } = {}) {
  wpm = wpm ?? clamp(52 + 10 * normal(rnd), 30, 95);
  const sigma = 0.4;
  const median = 60000 / (wpm * 5) / Math.exp(sigma * sigma / 2); // среднее выходит ровно по wpm
  const chars = [...String(text)];

  // Раскладка в каждой позиции: кириллическая буква переключает на ru, латинская на us.
  const layoutAt = [];
  let layout = 'us';
  for (const ch of chars) {
    if (CYRILLIC.test(ch)) layout = 'ru'; else if (LATIN.test(ch)) layout = 'us';
    layoutAt.push(layout);
  }
  const entryAt = (i) => lookup(chars[i], layoutAt[i]);

  const strokes = [];
  let prev = null, flow = 0;
  const hold = () => clamp(lognormal(rnd, 85, 0.3), 40, 200);
  const emit = (entry, extra = 0) => {
    flow = 0.9 * flow + Math.sqrt(1 - 0.81) * normal(rnd); // темп плавает волнами, а не шумит
    const base = lognormal(rnd, median, sigma) * Math.exp(0.15 * flow) * digraph(prev, entry);
    strokes.push({ entry, gap: Math.max(25, base) + extra, hold: hold() });
    prev = entry;
  };
  const emitText = (ch, extra = 0) => {
    flow = 0.9 * flow + Math.sqrt(1 - 0.81) * normal(rnd);
    strokes.push({ insert: ch, gap: Math.max(25, lognormal(rnd, median, sigma)) + extra, hold: 0 });
    prev = null;
  };
  const backspace = (extra = 0) => {
    strokes.push({ entry: BACKSPACE, gap: clamp(lognormal(rnd, 95, 0.3), 45, 250) + extra, hold: clamp(lognormal(rnd, 60, 0.3), 30, 140) });
    prev = BACKSPACE;
  };

  // Паузы перед символом: реакция после фокуса, начало предложения, абзац, «задумался».
  const pauseBefore = (i) => {
    if (i === 0) return clamp(lognormal(rnd, 380, 0.4), 180, 1500);
    const p = chars[i - 1], pp = chars[i - 2];
    let extra = 0;
    if (p === '\n') extra += lognormal(rnd, 500, 0.5);
    else if (p === ' ' && /[.!?…]/.test(pp)) extra += lognormal(rnd, 350, 0.4);
    else if (p === ' ' && /[,;:]/.test(pp)) extra += lognormal(rnd, 120, 0.4);
    if (p === ' ' && chance(rnd, 0.03)) extra += lognormal(rnd, 900, 0.5);
    return extra;
  };

  // Сколько символов успеет напечатать, пока заметит ошибку.
  const noticeAfter = () => { const r = rnd(); return r < 0.45 ? 0 : r < 0.7 ? 1 : r < 0.87 ? 2 : 3; };
  const mappable = (i) => i < chars.length && entryAt(i) !== null;
  const isLetter = (i) => /\p{L}/u.test(chars[i]) && mappable(i);

  /** Ошибка на позиции i: что набрать вместо, что стереть, что набрать заново. */
  function mistake(i) {
    const e = entryAt(i);
    const kinds = [['neighbor', 0.5], ['extra', 0.15], ['double', 0.1], ['omission', 0.1], ['swap', 0.15]];
    let r = rnd(), kind = 'neighbor';
    for (const [k, w] of kinds) { if (r < w) { kind = k; break; } r -= w; }
    if ((kind === 'omission' || kind === 'swap') && !(isLetter(i + 1) && chars[i + 1] !== chars[i])) kind = 'neighbor';

    const lay = layoutAt[i] === 'ru' ? 'ru' : 'us';
    const wrongKeys = [...neighbors(e.code)].map((c) => entryFor(KEYS.get(c), e.shift, lay)).filter((w) => /\p{L}/u.test(w.text));
    if (kind !== 'double' && kind !== 'omission' && kind !== 'swap' && !wrongKeys.length) return null;
    const wrong = wrongKeys[Math.floor(rnd() * wrongKeys.length)];

    switch (kind) {
      case 'neighbor': return { prefix: [], wrong: [wrong], retype: [e], used: 1 };
      case 'extra': return { prefix: [], wrong: [wrong, e], retype: [e], used: 1 };
      case 'double': return { prefix: [e], wrong: [e], retype: [], used: 1 };
      case 'omission': return { prefix: [], wrong: [], retype: [e], used: 1, minNotice: 1 };
      default: return { prefix: [], wrong: [entryAt(i + 1), e], retype: [e, entryAt(i + 1)], used: 2 };
    }
  }

  for (let i = 0; i < chars.length;) {
    const e = entryAt(i);
    if (!e) { emitText(chars[i], pauseBefore(i)); i++; continue; }

    const m = isLetter(i) && chance(rnd, typoRate) ? mistake(i) : null;
    if (!m) { emit(e, pauseBefore(i)); i++; continue; }

    // Вслепую можно напечатать только то, что есть на клавиатуре; без этого ошибку не заметить.
    // Enter вслепую нельзя: он отправит форму с опечаткой, поэтому на нём останавливаемся.
    let room = 0;
    while (room < 3 && mappable(i + m.used + room) && chars[i + m.used + room] !== '\n') room++;
    const k = Math.min(Math.max(noticeAfter(), m.minNotice || 0), room);
    if (k < (m.minNotice || 0)) { emit(e, pauseBefore(i)); i++; continue; }

    const ahead = Array.from({ length: k }, (_, j) => entryAt(i + m.used + j));
    let first = true;
    for (const x of [...m.prefix, ...m.wrong, ...ahead]) { emit(x, first ? pauseBefore(i) : 0); first = false; }
    for (let b = 0; b < m.wrong.length + k; b++) backspace(b === 0 ? clamp(lognormal(rnd, 320, 0.35), 150, 1200) : 0);
    [...m.retype, ...ahead].forEach((x, j) => emit(x, j === 0 ? lognormal(rnd, 150, 0.4) : 0));
    i += m.used + k;
  }
  return schedule(strokes, rnd);
}

/** Из нажатий с интервалами в события со временем; Shift нажимает рука, противоположная клавише. */
function schedule(strokes, rnd) {
  let t = 0;
  const recs = strokes.map((s) => ({ ...s, downAt: (t += s.gap), upAt: t + s.hold }));

  // Одна и та же клавиша подряд: прежде чем нажать снова, надо отпустить.
  recs.forEach((r, i) => {
    for (let j = i + 1; j < Math.min(recs.length, i + 4); j++) {
      if (recs[j].entry && r.entry && recs[j].entry.code === r.entry.code && r.upAt > recs[j].downAt - 10) {
        r.upAt = Math.max(r.downAt + 15, recs[j].downAt - 10);
      }
    }
  });

  const events = [];
  let shifted = null, before = null; // before — предыдущая запись
  const release = (nextDownAt) => {
    const at = Math.max(Math.min(before.upAt + between(rnd, 10, 40), nextDownAt - 3), before.downAt + 5);
    events.push({ t: at, op: 'up', entry: shifted });
    shifted = null;
  };
  for (const r of recs) {
    if (shifted && !(r.entry && r.entry.shift)) release(r.downAt);
    if (r.entry && r.entry.shift && !shifted) {
      const lead = Math.min(between(rnd, 30, 80), 0.6 * (r.downAt - (before ? before.downAt : 0)));
      shifted = shiftFor(r.entry.finger);
      events.push({ t: r.downAt - lead, op: 'down', entry: shifted });
    }
    if (r.insert !== undefined) events.push({ t: r.downAt, op: 'insert', text: r.insert });
    else events.push({ t: r.downAt, op: 'down', entry: r.entry }, { t: r.upAt, op: 'up', entry: r.entry });
    before = r;
  }
  if (shifted) events.push({ t: before.upAt + between(rnd, 10, 40), op: 'up', entry: shifted });

  return events.map((e) => ({ ...e, t: Math.round(e.t) })).sort((a, b) => a.t - b.t);
}

module.exports = { planTyping, neighbors, lookup };
