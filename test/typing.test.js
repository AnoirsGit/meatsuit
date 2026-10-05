/**
 * Печать: темп, ритм, опечатки и раскладки. Событийный план проверяется
 * симулятором клавиатуры: он повторяет, что получилось бы в поле ввода.
 *
 *   node --test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { seeded } = require('../human/random.js');
const { planTyping, neighbors } = require('../human/keys.js');

const runs = (n, fn) => Array.from({ length: n }, (_, i) => fn(seeded(i + 1), i));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const cv = (xs) => Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2))) / mean(xs);
const isShift = (e) => e.code === 'ShiftLeft' || e.code === 'ShiftRight';

/**
 * Что окажется в поле, если проиграть события; заодно проверяет инварианты клавиатуры.
 * enters (если передан) пополняется содержимым поля в момент каждого Enter:
 * в форме Enter отправляет то, что напечатано к этой секунде, а не итог.
 */
function simulate(events, enters = []) {
  let shift = false, text = '', last = 0;
  const held = new Set();
  for (const ev of events) {
    assert.ok(ev.t >= last, 'время пошло назад');
    last = ev.t;
    if (ev.op === 'insert') { text += ev.text; continue; }
    const e = ev.entry;
    if (isShift(e)) { shift = ev.op === 'down'; continue; }
    if (ev.op === 'up') { assert.ok(held.delete(e.code), `отпущена ненажатая ${e.code}`); continue; }
    assert.ok(!held.has(e.code), `${e.code} нажата повторно без отпускания`);
    held.add(e.code);
    if (e.code === 'Backspace') { text = text.slice(0, -1); continue; }
    if (e.code === 'Enter') enters.push(text);
    assert.equal(shift, Boolean(e.shift), `Shift ${shift ? 'зажат' : 'отпущен'} при вводе «${e.text}»`);
    text += e.text;
  }
  assert.equal(held.size, 0, 'остались зажатые клавиши');
  assert.equal(shift, false, 'Shift остался зажат');
  return text;
}
const downs = (events) => events.filter((e) => e.op === 'down' && !isShift(e.entry));
const gapsOf = (events) => downs(events).slice(1).map((e, i) => e.t - downs(events)[i].t);

test('напечатанное совпадает с заказанным при любых опечатках', () => {
  const texts = [
    'Hello, World! How are you?',
    'Здравствуйте! Меня зовут Иван, мне 27 лет.',
    'Mix: Привет, world — "кавычки" (скобки) №1; 50% a-z\nвторая строка',
    'FAST typing ALL CAPS 123',
    'aaa lllll Оооо ээээ',
    'a', 'ab', 'Я', '',
  ];
  for (const text of texts) {
    for (const wpm of [40, 120]) {
      runs(25, (r) => simulate(planTyping(text, { wpm, typoRate: 0.25, rnd: r }))).forEach((got) => {
        assert.equal(got, text);
      });
    }
  }
});

test('Enter нажимается, когда в поле уже ровно заказанный текст: опечатка не уходит в отправленную форму', () => {
  const texts = ['Привет\nмир', 'Hello world\n', 'ab\ncd\nef', 'Mix: Привет, world\nвторая строка\n\nтретья'];
  for (const text of texts) {
    const want = [];
    [...text].forEach((ch, i) => { if (ch === '\n') want.push(text.slice(0, i)); });
    for (const typoRate of [0.1, 0.3, 0.6]) {
      runs(150, (r) => {
        const enters = [];
        assert.equal(simulate(planTyping(text, { wpm: 60, typoRate, rnd: r }), enters), text);
        assert.deepEqual(enters, want, `typoRate ${typoRate}: Enter нажат с неисправленным текстом`);
      });
    }
  }
});

test('кириллица идёт настоящими клавишами раскладки, а не вставкой текста', () => {
  const ev = planTyping('й', { typoRate: 0, rnd: seeded(1) });
  assert.equal(ev.some((e) => e.op === 'insert'), false);
  const [d] = downs(ev);
  assert.deepEqual([d.entry.code, d.entry.key, d.entry.text, d.entry.vk, d.entry.raw], ['KeyQ', 'й', 'й', 81, true]);
});

test('заглавная буква: Shift нажимает рука, противоположная пальцу клавиши', () => {
  const left = planTyping('Й', { typoRate: 0, rnd: seeded(1) }); // й — левый мизинец
  assert.equal(left[0].entry.code, 'ShiftRight');
  const right = planTyping('H', { typoRate: 0, rnd: seeded(1) }); // h — правый указательный
  assert.equal(right[0].entry.code, 'ShiftLeft');
});

test('знаки препинания следуют раскладке, в которой пишется текст', () => {
  const lastKey = (text) => { const d = downs(planTyping(text, { typoRate: 0, rnd: seeded(1) })).pop().entry; return [d.code, Boolean(d.shift)]; };
  assert.deepEqual(lastKey('hello.'), ['Period', false]);
  assert.deepEqual(lastKey('привет.'), ['Slash', false]);
  assert.deepEqual(lastKey('привет,'), ['Slash', true]);
  assert.deepEqual(lastKey('привет?'), ['Digit7', true]);
});

test('символа нет в раскладках: уходит вставкой, а не теряется', () => {
  const ev = planTyping('a—b', { typoRate: 0, rnd: seeded(1) });
  assert.deepEqual(ev.filter((e) => e.op === 'insert').map((e) => e.text), ['—']);
  assert.equal(simulate(ev), 'a—b');
});

test('wpm управляет темпом, а 55 wpm — это темп человека, а не скрипта', () => {
  const text = 'Добрый день! Меня заинтересовала ваша вакансия. Готов обсудить детали. '.repeat(4);
  const dur = (wpm) => median(runs(15, (r) => { const ev = planTyping(text, { wpm, typoRate: 0, rnd: r }); return ev[ev.length - 1].t; }));
  const ratio = dur(40) / dur(80);
  assert.ok(ratio > 1.5 && ratio < 2.3, `40 wpm к 80 wpm: ${ratio.toFixed(2)}`);
  const seconds = dur(55) / 1000;
  assert.ok(seconds > 0.8 * text.length * 60 / (55 * 5) && seconds < 1.6 * text.length * 60 / (55 * 5), `${text.length} знаков за ${seconds.toFixed(0)} с`);
});

test('интервалы между нажатиями неровные', () => {
  const gaps = gapsOf(planTyping('the quick brown fox jumps over the lazy dog '.repeat(5), { typoRate: 0, rnd: seeded(3) }));
  assert.ok(cv(gaps) > 0.3, `почти метроном: cv=${cv(gaps).toFixed(2)}`);
  assert.ok(Math.min(...gaps) >= 20, `интервал ${Math.min(...gaps)} мс быстрее пальцев`);
});

test('чередование рук быстрее, чем один палец подряд', () => {
  const med = (text) => median(runs(20, (r) => median(gapsOf(planTyping(text, { wpm: 55, typoRate: 0, rnd: r })))));
  const alt = med('fj'.repeat(60)); // левая рука, правая рука
  const same = med('fg'.repeat(60)); // оба — левый указательный
  assert.ok(same / alt > 1.25, `один палец ${same.toFixed(0)} мс, две руки ${alt.toFixed(0)} мс`);
});

test('перед первым словом нового предложения пауза длиннее обычной', () => {
  const text = 'ab cd ef. gh ij kl. mn op qr. st uv wx. yz ab cd. ef gh ij. ';
  const inside = [], starts = [];
  runs(30, (r) => {
    const g = gapsOf(planTyping(text, { wpm: 55, typoRate: 0, rnd: r }));
    for (let i = 1; i < text.length; i++) {
      if (text[i - 1] === ' ' && text[i - 2] === '.') starts.push(g[i - 1]);
      else if (/[a-z]/.test(text[i]) && /[a-z]/.test(text[i - 1])) inside.push(g[i - 1]);
    }
  });
  assert.ok(median(starts) > 1.5 * median(inside), `начало предложения ${median(starts)} мс, внутри слова ${median(inside)} мс`);
});

test('опечатки случаются и стираются Backspace; при typoRate 0 их нет', () => {
  const text = 'Привет, как дела? Hello, how are you doing today? '.repeat(6);
  const backs = (typoRate, r) => planTyping(text, { typoRate, rnd: r }).filter((e) => e.op === 'down' && e.entry.code === 'Backspace').length;
  assert.deepEqual(runs(10, (r) => backs(0, r)), Array(10).fill(0));
  runs(20, (r) => assert.ok(backs(0.03, r) > 0, 'за 300 знаков ни одной опечатки'));
});

test('частота опечаток по умолчанию человеческая: единицы процента нажатий, не каждая пятая', () => {
  const text = 'Привет, как дела? Hello, how are you doing today? '.repeat(6);
  const share = mean(runs(30, (r) => {
    const d = downs(planTyping(text, { rnd: r }));
    return d.filter((e) => e.entry.code === 'Backspace').length / d.length;
  }));
  assert.ok(share > 0.005 && share < 0.08, `Backspace — ${(share * 100).toFixed(1)}% нажатий`);
});

test('ошибочные клавиши всегда соседние, а не «следующая по таблице символов»', () => {
  const allowed = new Set(['s', 'a', 'd', 'w', 'e', 'z', 'x']);
  const typed = new Set();
  runs(20, (r) => downs(planTyping('s'.repeat(200), { typoRate: 0.3, rnd: r }))
    .forEach((e) => e.entry.code !== 'Backspace' && typed.add(e.entry.text)));
  assert.ok(typed.size > 1, 'опечаток не было вовсе');
  for (const ch of typed) assert.ok(allowed.has(ch), `«${ch}» не соседняя с «s» клавиша`);
});

test('после фокуса первая клавиша не сразу: время на реакцию', () => {
  const first = runs(50, (r) => planTyping('hello', { typoRate: 0, rnd: r })[0].t);
  assert.ok(Math.min(...first) >= 150, `первая клавиша через ${Math.min(...first)} мс`);
});

test('промах по соседней клавише: соседи считаются по геометрии клавиатуры', () => {
  assert.deepEqual([...neighbors('KeyS')].sort(), ['KeyA', 'KeyD', 'KeyE', 'KeyW', 'KeyX', 'KeyZ']);
  assert.equal(neighbors('KeyS').has('KeyP'), false);
});

test('один и тот же seed даёт один и тот же план, разные — разные', () => {
  const plan = (s) => planTyping('Привет, мир! Hello.', { rnd: seeded(s) });
  assert.deepEqual(plan(5), plan(5));
  assert.notDeepEqual(plan(5), plan(6));
});
