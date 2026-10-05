/**
 * Мышь: форма, скорость и разброс движения. Случайность подставляется
 * генератором с seed, поэтому прогон воспроизводим.
 *
 *   node --test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { seeded } = require('../human/random.js');
const { glide, planMove, clampPlan, pickPoint, planScroll, planTwitch } = require('../human/mouse.js');

const A = { x: 100, y: 100 }, B = { x: 900, y: 500 }; // длина ≈ 894
const D = Math.hypot(B.x - A.x, B.y - A.y);
const runs = (n, fn) => Array.from({ length: n }, (_, i) => fn(seeded(i + 1), i));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const cv = (xs) => Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2))) / mean(xs);
const total = (pts) => pts[pts.length - 1].t;

// Расстояние точки от прямой from→to.
const offLine = (p, from, to) => Math.abs((to.y - from.y) * p.x - (to.x - from.x) * p.y + to.x * from.y - to.y * from.x)
  / Math.hypot(to.x - from.x, to.y - from.y);

test('движение приходит ровно в цель, целыми пикселями, время растёт', () => {
  for (const pts of runs(100, (r) => planMove(A, B, {}, r))) {
    assert.deepEqual(pts[pts.length - 1], { x: 900, y: 500, t: total(pts) });
    pts.forEach((p, i) => {
      assert.ok(Number.isInteger(p.x) && Number.isInteger(p.y), 'дробные координаты выдают скрипт');
      if (i) assert.ok(p.t > pts[i - 1].t, 'время не растёт');
    });
  }
});

test('события идут ровным ритмом опроса, как у железной мыши, а не случайными интервалами', () => {
  const gaps = runs(100, (r) => glide(A, B, { twitch: 0 }, r)).flatMap((pts) => pts.slice(1).map((p, i) => p.t - pts[i].t));
  const sorted = [...gaps].sort((a, b) => a - b);
  const q = (f) => sorted[Math.floor(sorted.length * f)];
  assert.ok(q(0.5) >= 7 && q(0.5) <= 10, `медианный интервал ${q(0.5)} мс`);
  assert.ok(q(0.75) - q(0.25) <= 3, `интервалы разбросаны: ${q(0.25)}–${q(0.75)} мс`);
  assert.ok(q(0.05) >= 4, `слишком частые события: ${q(0.05)} мс`);
});

test('мышь не шлёт события, пока стоит на месте', () => {
  for (const pts of runs(100, (r) => planMove(A, B, {}, r))) {
    pts.forEach((p, i) => {
      if (i) assert.ok(p.x !== pts[i - 1].x || p.y !== pts[i - 1].y, `две точки подряд в (${p.x},${p.y})`);
    });
  }
});

test('скорость колоколом: начало и конец медленнее середины', () => {
  const fifths = (pts) => {
    const T = total(pts);
    const at = (t) => pts.filter((p) => p.t <= t).pop() || A;
    return [0, 1, 2, 3, 4].map((k) => Math.hypot(at(T * (k + 1) / 5).x - at(T * k / 5).x, at(T * (k + 1) / 5).y - at(T * k / 5).y));
  };
  for (const pts of runs(200, (r) => glide(A, B, {}, r))) {
    const f = fifths(pts);
    assert.ok(f[0] < 0.65 * f[2], `разгон слишком резкий: ${f.map(Math.round)}`);
    assert.ok(f[4] < 0.4 * f[2], `нет торможения у цели: ${f.map(Math.round)}`);
  }
});

test('путь слегка кривой: не прямая и не дуга на пол-экрана', () => {
  const devs = runs(300, (r) => Math.max(...glide(A, B, {}, r).map((p) => offLine(p, A, B))));
  assert.ok(median(devs) > 0.015 * D, `слишком прямо: медиана ${median(devs).toFixed(1)} px`);
  assert.ok(median(devs) < 0.08 * D, `слишком круто: медиана ${median(devs).toFixed(1)} px`);
  assert.ok(Math.max(...devs) < 0.12 * D + 3, `выброс ${Math.max(...devs).toFixed(1)} px`);
});

test('у каждого движения своя скорость', () => {
  const durations = runs(200, (r) => total(glide(A, B, {}, r)));
  assert.ok(cv(durations) > 0.12, `длительность почти постоянна: cv=${cv(durations).toFixed(3)}`);
  assert.ok(cv(durations) < 0.6, `разброс неправдоподобный: cv=${cv(durations).toFixed(3)}`);
});

// Тот же seed — та же траектория; отличие двух прогонов — только подёргивания.
const twitchGap = (seed, opts) => {
  const base = glide(A, B, { twitch: 0 }, seeded(seed));
  const wild = glide(A, B, opts, seeded(seed));
  const baseAt = new Map(base.map((p) => [p.t, p]));
  const diffs = wild.filter((p) => baseAt.has(p.t)).map((p) => ({ t: p.t, d: Math.hypot(p.x - baseAt.get(p.t).x, p.y - baseAt.get(p.t).y) }));
  return { base, wild, diffs, max: Math.max(...diffs.map((x) => x.d)) };
};

test('подёргивание в пути: рывок на несколько пикселей, который гаснет к цели', () => {
  let seen = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const { base, wild, diffs, max } = twitchGap(seed, { twitch: 1 });
    assert.deepEqual(wild[wild.length - 1], base[base.length - 1], 'подёргивание сдвинуло цель');
    assert.ok(max <= 21, `рывок на ${max.toFixed(1)} px — это уже не подёргивание`);
    assert.ok(diffs.filter((x) => x.t > total(base) - 100).every((x) => x.d <= 1.5), 'рывок не затих к цели');
    if (max >= 2.5) seen++;
  }
  assert.ok(seen >= 190, `рывок виден только в ${seen} из 200 путей при twitch=1`);
});

test('по умолчанию подёргивания редкие: примерно в каждом третьем движении', () => {
  let twitched = 0;
  for (let seed = 1; seed <= 300; seed++) if (twitchGap(seed, {}).max >= 2.5) twitched++;
  assert.ok(twitched / 300 > 0.15 && twitched / 300 < 0.5, `${twitched} из 300`);
});

test('twitch=0 — траектория гладкая, без рывков', () => {
  for (let seed = 1; seed <= 50; seed++) assert.deepEqual(glide(A, B, { twitch: 0 }, seeded(seed)), glide(A, B, { twitch: 0 }, seeded(seed)));
  assert.equal(twitchGap(1, { twitch: 0 }).max, 0);
});

test('очень короткое движение не подёргивается', () => {
  for (let seed = 1; seed <= 100; seed++) {
    const to = { x: 112, y: 100 };
    assert.deepEqual(glide(A, to, { twitch: 1 }, seeded(seed)), glide(A, to, { twitch: 0 }, seeded(seed)));
  }
});

test('подёргивание в покое: резкий уход на несколько пикселей и возврат почти на место', () => {
  for (const tw of runs(200, (r) => planTwitch(r))) {
    const out = Math.hypot(tw[1].dx, tw[1].dy), back = tw[tw.length - 1];
    assert.ok(out >= 3.5 && out <= 14.5, `уход на ${out.toFixed(1)} px`);
    assert.ok(Math.hypot(back.dx, back.dy) <= 2.2, `не вернулась: (${back.dx},${back.dy})`);
    assert.ok(tw.every((p) => Number.isInteger(p.dx) && Number.isInteger(p.dy)), 'дробные смещения');
    tw.forEach((p, i) => i && assert.ok(p.t > tw[i - 1].t, 'время не растёт'));
    assert.ok(back.t >= 80 && back.t <= 400, `подёргивание длилось ${back.t} мс`);
  }
});

test('время по закону Фиттса: дальше и мельче цель — дольше', () => {
  const med = (from, to, width) => median(runs(200, (r) => total(glide(from, to, { width }, r))));
  assert.ok(med(A, { x: 200, y: 100 }, 40) < med(A, { x: 900, y: 100 }, 40), 'дальняя цель не дольше ближней');
  assert.ok(med(A, { x: 500, y: 100 }, 100) < med(A, { x: 500, y: 100 }, 10), 'мелкая цель не дольше крупной');
  const cross = med(A, B, 40);
  assert.ok(cross > 500 && cross < 1500, `через весь экран ${Math.round(cross)} мс: не по-человечески`);
});

test('параметр speed ускоряет движение', () => {
  const med = (speed) => median(runs(200, (r) => total(glide(A, B, { speed }, r))));
  const ratio = med(2) / med(1);
  assert.ok(ratio > 0.4 && ratio < 0.65, `в два раза быстрее дало ${ratio.toFixed(2)}`);
});

test('на длинном пути иногда промахивается мимо цели и возвращается', () => {
  const ux = (B.x - A.x) / D, uy = (B.y - A.y) / D;
  const proj = (p) => (p.x - A.x) * ux + (p.y - A.y) * uy;
  const paths = runs(400, (r) => planMove(A, B, {}, r));
  const over = paths.filter((pts) => Math.max(...pts.map(proj)) > D + 4);
  assert.ok(over.length / paths.length > 0.05 && over.length / paths.length < 0.45, `доля перелётов ${over.length}/400`);
  for (const pts of over) {
    assert.ok(pts.some((p, i) => i && p.t - pts[i - 1].t > 40), 'перелёт без паузы «заметил»');
  }
});

test('на короткой дистанции не промахивается', () => {
  const to = { x: 130, y: 100 };
  for (const pts of runs(200, (r) => planMove(A, to, {}, r))) {
    assert.ok(Math.max(...pts.map((p) => p.x)) <= to.x + 4, 'перелёт на коротком шаге');
  }
});

test('точка клика внутри элемента, разбросана вокруг центра', () => {
  const box = { x: 200, y: 300, width: 120, height: 40 };
  const pts = runs(300, (r) => pickPoint(box, A, r));
  for (const p of pts) {
    assert.ok(Number.isInteger(p.x) && Number.isInteger(p.y));
    assert.ok(p.x >= 200 && p.x <= 320 && p.y >= 300 && p.y <= 340, `вне элемента: (${p.x},${p.y})`);
  }
  const xs = pts.map((p) => p.x);
  assert.ok(Math.abs(mean(xs) - 260) < 8, `смещение от центра: ${mean(xs)}`);
  assert.ok(new Set(xs).size > 20, 'клик всегда в одну и ту же точку');
});

test('крошечный элемент: точка остаётся внутри', () => {
  for (const p of runs(100, (r) => pickPoint({ x: 10, y: 10, width: 3, height: 3 }, A, r))) {
    assert.ok(p.x >= 10 && p.x <= 13 && p.y >= 10 && p.y <= 13, `(${p.x},${p.y})`);
  }
});

test('прокрутка: рывки по 100, не меньше заказанного, с паузами на чтение', () => {
  for (const ev of runs(50, (r) => planScroll(2200, {}, r))) {
    const sum = ev.reduce((s, e) => s + e.dy, 0);
    assert.ok(sum >= 2200 && sum < 2300, `итог ${sum}`);
    assert.ok(ev.every((e) => Math.abs(e.dy) === 100), 'рывок не равен делению колеса');
    ev.forEach((e, i) => i && assert.ok(e.t >= ev[i - 1].t, 'время назад'));
    const gaps = ev.slice(1).map((e, i) => e.t - ev[i].t);
    assert.ok(Math.max(...gaps) >= 300, 'нет паузы «прочитать»');
    assert.ok(Math.min(...gaps) >= 15, 'рывки идут быстрее, чем крутит палец');
  }
});

test('прокрутка вверх: отрицательная дельта, итог не меньше заказанного', () => {
  for (const ev of runs(50, (r) => planScroll(-1500, {}, r))) {
    const sum = ev.reduce((s, e) => s + e.dy, 0);
    assert.ok(sum <= -1500 && sum > -1600, `итог ${sum}`);
  }
});

test('иногда прокрутка делает шаг назад', () => {
  const back = runs(300, (r) => planScroll(2200, {}, r)).filter((ev) => ev.some((e) => e.dy < 0));
  assert.ok(back.length > 0, 'ни разу не вернулся назад');
});

test('clampPlan: точки в окне, одинаковые подряд после зажима сливаются, конец плана остаётся', () => {
  const plan = [{ x: 5, y: 10, t: 8 }, { x: -3, y: 10, t: 16 }, { x: -1, y: 11, t: 24 }, { x: 2000, y: 900, t: 32 }, { x: 1300, y: 721, t: 40 }];
  assert.deepEqual(clampPlan(plan, 1280, 720, { x: 9, y: 10 }), [
    { x: 5, y: 10, t: 8 }, { x: 0, y: 10, t: 16 }, { x: 0, y: 11, t: 24 }, { x: 1279, y: 719, t: 32 },
  ]);
  // всё плана схлопнулось в текущую точку: конец остаётся, у плана есть последняя точка
  assert.deepEqual(clampPlan([{ x: -9, y: 5, t: 0 }], 1280, 720, { x: 0, y: 5 }), [{ x: 0, y: 5, t: 0 }]);
  // размер окна неизвестен (0): не зажимаем, а не делаем окно нулевым
  assert.deepEqual(clampPlan([{ x: -3, y: 4, t: 0 }], 0, 0), [{ x: 0, y: 4, t: 0 }]);
});
