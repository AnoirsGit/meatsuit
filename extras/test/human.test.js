/**
 * Ручки поверх страницы: страница и часы фальшивые (testkit/fakepage.js), но
 * разговор с ней настоящий.
 *
 *   node --test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { seeded } = require('../human/random.js');
const { fakePage, locatorAt } = require('../testkit/fakepage.js');
const human = require('../human.js');

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

test('linger: иногда дёргает рукой, но остаётся на элементе и успокаивается до клика', async () => {
  const box = { x: 400, y: 300, width: 100, height: 30 };
  let twitched = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const { page, env, log, clock } = fakePage();
    const rnd = seeded(seed);
    await human.moveTo(page, 450, 315, { ...env, rnd });
    const start = log.filter((e) => e.op === 'move').pop();
    const before = log.length, t0 = clock.t;
    await human.linger(page, 700 + seed * 20, { ...env, rnd, box, twitch: 1 }); // короткие паузы: конец рядом

    const moves = log.slice(before).filter((e) => e.op === 'move');
    if (moves.some((m) => Math.hypot(m.x - start.x, m.y - start.y) >= 4)) twitched++;
    for (const m of moves) assert.ok(m.x > box.x && m.x < box.x + box.width && m.y > box.y && m.y < box.y + box.height, `съехала с элемента: (${m.x},${m.y})`);
    if (moves.length) assert.ok(clock.t - moves[moves.length - 1].t >= 60, `seed ${seed}: рука дёргалась прямо перед кликом`);
    assert.ok(clock.t - t0 >= 700 + seed * 20 - 1, `seed ${seed}: задержка короче заказанной`);
  }
  assert.ok(twitched >= 30, `рука дёрнулась только в ${twitched} из 40 прогонов при twitch=1`);
});

test('linger без цели-элемента: рука двигается целыми пикселями, координаты не портятся', async () => {
  const { page, env, log } = fakePage();
  await human.moveTo(page, 300, 300, env);
  const before = log.length;
  await human.linger(page, 5000, { ...env, twitch: 1 });
  const moves = log.slice(before).filter((e) => e.op === 'move');
  assert.ok(moves.length > 0, 'рука не шевелилась');
  for (const m of moves) assert.ok(Number.isInteger(m.x) && Number.isInteger(m.y), `(${m.x},${m.y})`);
});

test('у человека повадки в человеческих пределах и они разные', () => {
  const personas = Array.from({ length: 200 }, (_, i) => human.newPersona(seeded(i + 1)));
  for (const p of personas) {
    assert.ok(p.speed >= 0.7 && p.speed <= 1.4, `speed ${p.speed}`);
    assert.ok(p.wpm >= 30 && p.wpm <= 95, `wpm ${p.wpm}`);
    assert.ok(p.tremor >= 0.3 && p.tremor <= 1.1, `tremor ${p.tremor}`);
    assert.ok(p.twitch >= 0.1 && p.twitch <= 0.5, `twitch ${p.twitch}`);
  }
  assert.ok(new Set(personas.map((p) => p.wpm)).size > 50, 'у всех одинаковый темп');
});

test('повадки общие на весь браузер: человек один, на любой странице печатает с тем же темпом', async () => {
  const typeFor = async (wpm) => {
    human.usePersona({ speed: 1, tremor: 0.7, wpm });
    const { page, env, clock } = fakePage();
    await human.type(page, 'привет как дела', { ...env, typoRate: 0 });
    return clock.t;
  };
  try {
    const slow = await typeFor(35), fast = await typeFor(90);
    assert.ok(slow > 1.5 * fast, `35 wpm ${slow} мс, 90 wpm ${fast} мс: темп персоны не применился`);
  } finally { human.usePersona(null); }
});

test('скорость руки из повадок применяется к движению мыши', async () => {
  const moveFor = async (speed) => {
    human.usePersona({ speed, tremor: 0.7, wpm: 55 });
    const { page, env, clock } = fakePage();
    await human.moveTo(page, 900, 500, env);
    return clock.t;
  };
  try {
    const slow = await moveFor(0.7), fast = await moveFor(1.4);
    assert.ok(slow > 1.5 * fast, `медленная рука ${slow} мс, быстрая ${fast} мс`);
  } finally { human.usePersona(null); }
});

test('moveTo к краю окна: ни одна точка пути не выходит за окно (там события отбрасываются)', async () => {
  const W = 1280, H = 720;
  const targets = [[2, 300], [0, 300], [1, 100], [W - 1, 300], [W - 2, 650], [640, 0], [640, H - 1], [0, 0], [W - 1, H - 1]];
  for (const [x, y] of targets) {
    for (let seed = 1; seed <= 60; seed++) {
      const { page, env, log } = fakePage();
      await human.moveTo(page, x, y, { ...env, rnd: seeded(seed) });
      for (const m of log.filter((e) => e.op === 'move')) {
        assert.ok(m.x >= 0 && m.x <= W - 1 && m.y >= 0 && m.y <= H - 1, `к (${x},${y}), seed ${seed}: точка (${m.x},${m.y}) вне окна`);
      }
    }
  }
});

test('moveTo в точку за окном: приходит на ближайшую точку окна', async () => {
  const cases = [[-50, 300, 0, 300], [5000, 300, 1279, 300], [640, -9, 640, 0], [640, 9999, 640, 719], [-1, -1, 0, 0]];
  for (const [x, y, ex, ey] of cases) {
    const { page, env, log } = fakePage();
    await human.moveTo(page, x, y, { ...env, rnd: seeded(3) });
    const last = log.filter((e) => e.op === 'move').pop();
    assert.deepEqual([last.x, last.y], [ex, ey], `цель (${x},${y})`);
  }
});

test('linger у самого края окна: рука не уходит за него', async () => {
  for (let seed = 1; seed <= 40; seed++) {
    const { page, env, log } = fakePage();
    const rnd = seeded(seed);
    await human.moveTo(page, 0, 719, { ...env, rnd });
    const before = log.length;
    await human.linger(page, 6000, { ...env, rnd, twitch: 1 });
    for (const m of log.slice(before).filter((e) => e.op === 'move')) {
      assert.ok(m.x >= 0 && m.x <= 1279 && m.y >= 0 && m.y <= 719, `seed ${seed}: (${m.x},${m.y}) вне окна`);
    }
  }
});

test('сохранённые повадки: годные возвращаются как есть, мусор и дыры заменяются годными', () => {
  const good = { speed: 1.1, tremor: 0.6, twitch: 0.3, wpm: 48 };
  assert.deepEqual(human.restorePersona(good, seeded(1)), good);
  assert.deepEqual(human.restorePersona({ ...good, extra: 'x' }, seeded(1)), good, 'лишние поля не тащим');

  const junk = [null, undefined, {}, [], 'text', 42, { speed: 'fast' }, { speed: NaN, tremor: 0.6, twitch: 0.3, wpm: 48 },
    { ...good, wpm: 0 }, { ...good, wpm: -5 }, { ...good, wpm: Infinity }, { ...good, speed: 0 }, { ...good, speed: 50 }, { ...good, tremor: -1 }, { ...good, twitch: 7 }, { ...good, wpm: '55' }];
  for (const saved of junk) {
    const p = human.restorePersona(saved, seeded(2));
    assert.deepEqual(Object.keys(p).sort(), ['speed', 'tremor', 'twitch', 'wpm'], JSON.stringify(saved));
    assert.ok(p.speed >= 0.5 && p.speed <= 2 && p.tremor >= 0 && p.tremor <= 2 && p.twitch >= 0 && p.twitch <= 1 && p.wpm >= 20 && p.wpm <= 150, `${JSON.stringify(saved)} → ${JSON.stringify(p)}`);
  }
});

test('испорченные повадки не ломают руку: движение не телепорт, печать не бесконечная', async () => {
  human.usePersona({ wpm: 0, speed: NaN }); // то, что вышло бы из {} или wpm:0 в persona.json
  try {
    const { page, env, log, clock } = fakePage();
    await human.moveTo(page, 900, 500, { ...env, rnd: seeded(5) });
    assert.ok(log.filter((e) => e.op === 'move').length > 5, 'движение — телепорт');
    const t0 = clock.t;
    await human.type(page, 'привет', { ...env, typoRate: 0 });
    assert.ok(Number.isFinite(clock.t) && clock.t - t0 > 500 && clock.t - t0 < 20000, `печать заняла ${clock.t - t0} мс`);
  } finally { human.usePersona(null); }
});
