/**
 * Руки человека (human.js): мышь, колесо, клавиатура и повадки на фальшивой странице.
 * Страница и часы фальшивые: sleep двигает время, а не ждёт, поэтому минута печати
 * проигрывается мгновенно, а разговор со страницей настоящий.
 *
 *   node test/human.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { seeded } = require('../human/random.js');
const { planTyping } = require('../human/keys.js');
const { loadPersona } = require('../human/persona-file.js');
const human = require('../human.js');

/** Элемент с прямоугольником; state нужен, если страница прокручивается колесом. */
const locatorAt = (box, state, onScrollIntoView) => ({
  boundingBox: async () => ({ ...box, y: box.y - (state ? state.scrollY : 0) }),
  scrollIntoViewIfNeeded: async () => { if (onScrollIntoView) onScrollIntoView(); },
});

/** Страница playwright в объёме, который трогает human.js; журнал вызовов и виртуальные часы. */
function fakePage({ cdp = true } = {}) {
  const log = [];
  const clock = { t: 0 };
  const state = { scrollY: 0 };
  const page = {
    mouse: {
      move: async (x, y) => log.push({ op: 'move', x, y, t: clock.t }),
      down: async () => log.push({ op: 'down', t: clock.t }),
      up: async () => log.push({ op: 'up', t: clock.t }),
      wheel: async (dx, dy) => { state.scrollY += dy; log.push({ op: 'wheel', dy, t: clock.t }); },
    },
    keyboard: {
      down: async (k) => log.push({ op: 'kdown', k, t: clock.t }),
      up: async (k) => log.push({ op: 'kup', k, t: clock.t }),
      insertText: async (s) => log.push({ op: 'insert', s, t: clock.t }),
    },
    context: () => ({
      newCDPSession: async () => {
        if (!cdp) throw new Error('нет CDP');
        return { send: async (method, params) => log.push({ op: 'cdp', method, params, t: clock.t }) };
      },
    }),
    evaluate: async () => ({ w: 1280, h: 720 }),
  };
  let sleeps = 0;
  const env = {
    sleep: async (ms) => {
      if (++sleeps > 50000) throw new Error('виртуальное время зациклилось');
      clock.t += ms;
    },
    now: () => clock.t,
    rnd: seeded(7),
  };
  return { page, env, log, clock, state };
}

test('click: приходит внутрь элемента, задерживается и кликает с удержанием кнопки', async () => {
  const { page, env, log } = fakePage();
  await human.click(page, locatorAt({ x: 400, y: 300, width: 100, height: 30 }), env);
  const moves = log.filter((e) => e.op === 'move');
  const down = log.find((e) => e.op === 'down'), up = log.find((e) => e.op === 'up');
  const last = moves[moves.length - 1];
  assert.ok(last.x >= 400 && last.x <= 500 && last.y >= 300 && last.y <= 330, `последняя точка (${last.x},${last.y}) вне элемента`);
  assert.ok(log.indexOf(down) > log.indexOf(last), 'нажал, не дойдя до цели');
  assert.ok(down.t - last.t >= 50, `клик через ${down.t - last.t} мс после наведения: нет задержки`);
  assert.ok(up.t - down.t >= 40 && up.t - down.t <= 220, `кнопка держалась ${up.t - down.t} мс`);
});

test('click: перед нажатием verifyAt получает точку курсора; бросил — нажатия нет', async () => {
  const { page, env, log } = fakePage();
  const box = { x: 400, y: 300, width: 100, height: 30 };
  const seen = [];
  await human.click(page, locatorAt(box), { ...env, verifyAt: async (pt) => { seen.push({ ...pt, downs: log.filter((e) => e.op === 'down').length }); } });
  assert.equal(seen.length, 1);
  const last = log.filter((e) => e.op === 'move').pop();
  assert.deepEqual([seen[0].x, seen[0].y], [last.x, last.y], 'verifyAt получил не ту точку, где курсор');
  assert.equal(seen[0].downs, 0, 'verifyAt вызван после нажатия');

  const before = log.length;
  await assert.rejects(human.click(page, locatorAt(box), { ...env, verifyAt: async () => { throw new Error('оверлей'); } }), /оверлей/);
  assert.ok(!log.slice(before).some((e) => e.op === 'down' || e.op === 'up'), 'нажал, хотя точка не прошла проверку');
});

test('click: курсор уже над элементом — рука к нему не едет', async () => {
  const box = { x: 400, y: 300, width: 100, height: 30 };
  for (let seed = 1; seed <= 20; seed++) {
    const { page, env, log } = fakePage();
    const rnd = seeded(seed);
    await human.click(page, locatorAt(box), { ...env, rnd });
    const before = log.length;
    await human.click(page, locatorAt(box), { ...env, rnd });
    const moves = log.slice(before).filter((e) => e.op === 'move');
    const start = log.slice(0, before).filter((e) => e.op === 'move').pop();
    // Стоять неподвижно рука не умеет (дрожь в linger), но не дальше пары пикселей и не за пределы элемента.
    for (const m of moves) {
      assert.ok(Math.hypot(m.x - start.x, m.y - start.y) <= 14, `seed ${seed}: рука уехала (${m.x},${m.y}) от (${start.x},${start.y})`);
      assert.ok(m.x > box.x && m.x < box.x + box.width && m.y > box.y && m.y < box.y + box.height, `seed ${seed}: съехала с элемента`);
    }
    assert.ok(log.slice(before).some((e) => e.op === 'down'), 'второго клика нет');
  }
  // Издалека — едет.
  const { page, env, log } = fakePage();
  await human.moveTo(page, 1000, 600, env);
  const before = log.length;
  await human.click(page, locatorAt(box), env);
  assert.ok(log.slice(before).filter((e) => e.op === 'move').length > 5, 'издалека мышь не двигалась');
});

test('inside: курсор над элементом с отступом от края', () => {
  const box = { x: 100, y: 100, width: 80, height: 30 };
  assert.equal(human.inside({ x: 140, y: 115 }, box), true);
  assert.equal(human.inside({ x: 101, y: 115 }, box), false, 'у самого края — ещё нет');
  assert.equal(human.inside({ x: 400, y: 400 }, box), false);
  assert.equal(human.inside(undefined, box), false);
});

test('click по элементу ниже экрана: сначала крутит колесом, а не прыгает мгновенно', async () => {
  const { page, env, log, state } = fakePage();
  let jumps = 0;
  await human.click(page, locatorAt({ x: 300, y: 1500, width: 120, height: 30 }, state, () => jumps++), env);
  const wheels = log.filter((e) => e.op === 'wheel');
  assert.ok(wheels.length >= 8, `колесо провернулось ${wheels.length} раз`);
  assert.equal(jumps, 0, 'прокрутка скриптом: страница дёрнулась мгновенно');
  const last = log.filter((e) => e.op === 'move').pop();
  const top = 1500 - state.scrollY;
  assert.ok(top > 0 && top < 720, `элемент остался за экраном: top=${top}`);
  assert.ok(last.y >= top && last.y <= top + 30, 'клик не по элементу после прокрутки');
});

test('type: латиница идёт клавишами с Shift, кириллица сырыми событиями CDP', async () => {
  const { page, env, log } = fakePage();
  await human.type(page, 'Hй', { ...env, typoRate: 0 });
  const keys = log.filter((e) => e.op === 'kdown' || e.op === 'kup').map((e) => `${e.op === 'kdown' ? '↓' : '↑'}${e.k}`);
  assert.deepEqual(keys.slice(0, 4), ['↓ShiftLeft', '↓H', '↑H', '↑ShiftLeft']);
  const cdp = log.filter((e) => e.op === 'cdp');
  assert.deepEqual(cdp.map((c) => [c.method, c.params.type, c.params.key, c.params.code, c.params.windowsVirtualKeyCode, c.params.text]), [
    ['Input.dispatchKeyEvent', 'keyDown', 'й', 'KeyQ', 81, 'й'],
    ['Input.dispatchKeyEvent', 'keyUp', 'й', 'KeyQ', 81, undefined],
  ]);
});

test('type: без CDP кириллица уходит вставкой текста, а не теряется', async () => {
  const { page, env, log } = fakePage({ cdp: false });
  await human.type(page, 'й', { ...env, typoRate: 0 });
  assert.deepEqual(log.filter((e) => e.op === 'insert').map((e) => e.s), ['й']);
});

test('type: перевод строки — Shift+Enter (в чате это новая строка, а не отправка)', async () => {
  const { page, env, log } = fakePage();
  await human.type(page, 'a\nb', { ...env, typoRate: 0 });
  const keys = log.filter((e) => e.op === 'kdown' || e.op === 'kup').map((e) => `${e.op === 'kdown' ? '↓' : '↑'}${e.k}`);
  const enter = keys.indexOf('↓Enter');
  assert.ok(enter > 0, `Enter не нажат: ${keys}`);
  const shiftDown = keys.lastIndexOf('↓ShiftLeft', enter);
  const shiftUp = keys.indexOf('↑ShiftLeft', enter);
  assert.ok(shiftDown >= 0 && shiftDown < enter && shiftUp > keys.indexOf('↑Enter'), `Enter без Shift: ${keys}`);
  // В плане тоже: перевод строки никогда не идёт голым Enter, и опечатки на нём не бывает.
  for (let seed = 1; seed <= 30; seed++) {
    const plan = planTyping('Здравствуйте!\nМеня зовут Анна.\n\nС уважением', { typoRate: 0.3, rnd: seeded(seed) });
    let shift = false;
    for (const ev of plan) {
      if (ev.entry && /^Shift/.test(ev.entry.code)) shift = ev.op === 'down';
      if (ev.entry && ev.entry.code === 'Enter' && ev.op === 'down') assert.ok(shift, `seed ${seed}: Enter без Shift`);
    }
  }
});

test('press: одна клавиша с удержанием, как нажимает человек', async () => {
  const { page, env, log } = fakePage();
  await human.press(page, 'Escape', env);
  const keys = log.filter((e) => e.op === 'kdown' || e.op === 'kup');
  assert.deepEqual(keys.map((e) => [e.op, e.k]), [['kdown', 'Escape'], ['kup', 'Escape']]);
  const held = keys[1].t - keys[0].t;
  assert.ok(held >= 40 && held <= 200, `клавиша удерживалась ${held} мс`);
});

test('type занимает человеческое время', async () => {
  const { page, env, clock } = fakePage();
  await human.type(page, 'привет как дела', { ...env, wpm: 55, typoRate: 0 });
  assert.ok(clock.t > 2000 && clock.t < 12000, `15 знаков за ${clock.t} мс`);
});

test('scroll: рывки колеса по 100 с паузами, итог не меньше заказанного', async () => {
  const { page, env, log, clock } = fakePage();
  await human.scroll(page, 1500, env);
  const wheels = log.filter((e) => e.op === 'wheel');
  assert.ok(wheels.every((w) => Math.abs(w.dy) === 100));
  const net = wheels.reduce((s, w) => s + w.dy, 0);
  assert.ok(net >= 1500 && net < 1600, `итог ${net}`);
  assert.ok(clock.t > 1000, `прокрутка за ${clock.t} мс: без пауз на чтение`);
});

test('pause и sleep ждут по-настоящему', async () => {
  const t0 = Date.now();
  await human.sleep(50);
  await human.pause(20, 30);
  assert.ok(Date.now() - t0 >= 65);
});

test('linger: иногда дёргает рукой, но остаётся на элементе и успокаивается до клика', async () => {
  const box = { x: 400, y: 300, width: 100, height: 30 };
  let twitched = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const { page, env, log, clock } = fakePage();
    const rnd = seeded(seed);
    await human.moveTo(page, 450, 315, { ...env, rnd });
    const start = log.filter((e) => e.op === 'move').pop();
    const before = log.length, t0 = clock.t;
    await human.linger(page, 700 + seed * 20, { ...env, rnd, box, twitch: 1 });
    const moves = log.slice(before).filter((e) => e.op === 'move');
    if (moves.some((m) => Math.hypot(m.x - start.x, m.y - start.y) >= 4)) twitched++;
    for (const m of moves) assert.ok(m.x > box.x && m.x < box.x + box.width && m.y > box.y && m.y < box.y + box.height, `съехала с элемента: (${m.x},${m.y})`);
    if (moves.length) assert.ok(clock.t - moves[moves.length - 1].t >= 60, `seed ${seed}: рука дёргалась прямо перед кликом`);
    assert.ok(clock.t - t0 >= 700 + seed * 20 - 1, `seed ${seed}: задержка короче заказанной`);
  }
  assert.ok(twitched >= 30, `рука дёрнулась только в ${twitched} из 40 прогонов при twitch=1`);
});

test('moveTo к краю окна и за окно: путь не выходит за окно, конец в ближайшей точке', async () => {
  const W = 1280, H = 720;
  for (const [x, y] of [[0, 300], [W - 1, 300], [640, 0], [640, H - 1], [0, 0], [W - 1, H - 1]]) {
    for (let seed = 1; seed <= 20; seed++) {
      const { page, env, log } = fakePage();
      await human.moveTo(page, x, y, { ...env, rnd: seeded(seed) });
      for (const m of log.filter((e) => e.op === 'move')) assert.ok(m.x >= 0 && m.x <= W - 1 && m.y >= 0 && m.y <= H - 1, `к (${x},${y}), seed ${seed}: (${m.x},${m.y})`);
    }
  }
  for (const [x, y, ex, ey] of [[-50, 300, 0, 300], [5000, 300, 1279, 300], [640, 9999, 640, 719]]) {
    const { page, env, log } = fakePage();
    await human.moveTo(page, x, y, { ...env, rnd: seeded(3) });
    const last = log.filter((e) => e.op === 'move').pop();
    assert.deepEqual([last.x, last.y], [ex, ey], `цель (${x},${y})`);
  }
});

test('повадки: в человеческих пределах, разные, с темпом печати и долей опечаток', () => {
  const personas = Array.from({ length: 200 }, (_, i) => human.newPersona(seeded(i + 1)));
  for (const p of personas) {
    assert.deepEqual(Object.keys(p).sort(), ['speed', 'tremor', 'twitch', 'typoRate', 'wpm']);
    assert.ok(p.speed >= 0.7 && p.speed <= 1.4, `speed ${p.speed}`);
    assert.ok(p.wpm >= 30 && p.wpm <= 95, `wpm ${p.wpm}`);
    assert.ok(p.typoRate >= 0.005 && p.typoRate <= 0.06, `typoRate ${p.typoRate}`);
  }
  assert.ok(new Set(personas.map((p) => p.wpm)).size > 50, 'у всех одинаковый темп');
  assert.ok(new Set(personas.map((p) => p.typoRate)).size > 50, 'у всех одинаковая доля опечаток');
});

test('повадки общие на процесс: темп печати и доля опечаток персоны применяются', async () => {
  const run = async (persona, text) => {
    human.usePersona(persona);
    const { page, env, clock, log } = fakePage();
    await human.type(page, text, env);
    return { t: clock.t, backspaces: log.filter((e) => e.op === 'kdown' && e.k === 'Backspace').length };
  };
  try {
    const slow = await run({ speed: 1, tremor: 0.7, twitch: 0.3, wpm: 35, typoRate: 0 }, 'привет как дела');
    const fast = await run({ speed: 1, tremor: 0.7, twitch: 0.3, wpm: 90, typoRate: 0 }, 'привет как дела');
    assert.ok(slow.t > 1.5 * fast.t, `35 wpm ${slow.t} мс, 90 wpm ${fast.t} мс: темп персоны не применился`);
    const text = 'the quick brown fox jumps over the lazy dog '.repeat(6);
    assert.equal((await run({ speed: 1, tremor: 0.7, twitch: 0.3, wpm: 60, typoRate: 0 }, text)).backspaces, 0, 'typoRate 0, а опечатки есть');
    assert.ok((await run({ speed: 1, tremor: 0.7, twitch: 0.3, wpm: 60, typoRate: 0.1 }, text)).backspaces > 0, 'typoRate персоны не применился');
  } finally { human.usePersona(null); }
});

test('сохранённые повадки: годные возвращаются как есть, мусор и дыры заменяются годными', () => {
  const good = { speed: 1.1, tremor: 0.6, twitch: 0.3, wpm: 48, typoRate: 0.02 };
  assert.deepEqual(human.restorePersona(good, seeded(1)), good);
  assert.deepEqual(human.restorePersona({ ...good, extra: 'x' }, seeded(1)), good, 'лишние поля не тащим');
  const junk = [null, {}, [], 'text', { speed: 'fast' }, { ...good, wpm: 0 }, { ...good, speed: NaN }, { ...good, typoRate: 0.5 }, { ...good, typoRate: -1 }];
  for (const saved of junk) {
    const p = human.restorePersona(saved, seeded(2));
    assert.deepEqual(Object.keys(p).sort(), ['speed', 'tremor', 'twitch', 'typoRate', 'wpm'], JSON.stringify(saved));
    assert.ok(p.speed >= 0.5 && p.speed <= 2 && p.wpm >= 20 && p.wpm <= 150 && p.typoRate >= 0 && p.typoRate <= 0.1, `${JSON.stringify(saved)} → ${JSON.stringify(p)}`);
  }
});

test('persona.json в каталоге состояния: создаётся, потом читается тот же человек, мусор заменяется', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meatsuit-persona-'));
  const dir = path.join(tmp, 'state');
  try {
    const a = loadPersona(dir);
    assert.ok(a.wpm > 0 && a.speed > 0 && a.typoRate >= 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'persona.json'), 'utf8')), a);
    assert.deepEqual(loadPersona(dir), a, 'второй запуск: тот же человек');
    fs.writeFileSync(path.join(dir, 'persona.json'), '{"wpm":0}');
    assert.ok(loadPersona(dir).wpm > 0, 'нулевой темп заменён');
  } finally {
    human.usePersona(null);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
