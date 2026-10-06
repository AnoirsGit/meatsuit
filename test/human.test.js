/**
 * Кривая мыши: доходит точно до цели, не идёт прямой линией.
 *
 *   node test/human.test.js
 */
const assert = require('node:assert/strict');
const { path } = require('../human.js');

const from = { x: 100, y: 100 }, to = { x: 900, y: 500 };
const pts = path(from, to);

assert.ok(pts.length >= 8, 'слишком мало шагов');
const last = pts[pts.length - 1];
assert.ok(Math.abs(last.x - to.x) < 1e-6 && Math.abs(last.y - to.y) < 1e-6, 'кривая не дошла до цели');

// Хоть одна точка заметно в стороне от прямой from→to.
const off = (p) => Math.abs((to.y - from.y) * p.x - (to.x - from.x) * p.y + to.x * from.y - to.y * from.x)
  / Math.hypot(to.x - from.x, to.y - from.y);
const curved = Array.from({ length: 20 }, () => Math.max(...path(from, to).map(off))).some((d) => d > 5);
assert.ok(curved, 'курсор ходит по прямой');

// Шаги неравные: к концу замедление.
const step = (i) => Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
assert.ok(step(0) > step(pts.length - 2), 'нет замедления к цели');

console.log('human.test: ok');

// --- темпы и «аим» ---
const { plan, inside, SPEEDS } = require('../human.js');
const sum = (p) => p.reduce((t, x) => t + x.dt, 0);
const A = { x: 100, y: 100 }, B = { x: 900, y: 500 };

// Последняя точка всегда ровно цель, в любом темпе.
for (const speed of Object.keys(SPEEDS)) {
  for (let i = 0; i < 50; i++) {
    const p = plan(A, B, { speed });
    const l = p[p.length - 1];
    assert.ok(l.x === B.x && l.y === B.y, `${speed}: план не заканчивается в цели`);
  }
}

// Длительность в своём диапазоне; fast около секунды и быстрее normal/slow.
const avg = (speed) => Array.from({ length: 200 }, () => sum(plan(A, B, { speed }))).reduce((t, x) => t + x) / 200;
const [f, n, s] = [avg('fast'), avg('normal'), avg('slow')];
assert.ok(f > 500 && f < 1800, `fast вне ~1 секунды: ${f | 0} мс`);
assert.ok(f < n && n < s, `темпы не по порядку: ${f | 0} < ${n | 0} < ${s | 0}`);

// Короткий ход быстрее длинного.
const shortMs = Array.from({ length: 100 }, () => sum(plan(A, { x: 140, y: 120 }, { speed: 'normal' }))).reduce((t, x) => t + x) / 100;
assert.ok(shortMs < n * 0.6, 'короткий ход не короче длинного');

// Перелёт: в fast часто, в slow редко; после перелёта есть возврат с дрожью к цели.
const overshootRate = (speed) => Array.from({ length: 400 }, () => {
  const p = plan(A, B, { speed });
  const far = p.some((q) => Math.hypot(q.x - B.x, q.y - B.y) > 8 && (q.x - A.x) * (B.x - A.x) + (q.y - A.y) * (B.y - A.y) > (B.x - A.x) ** 2 + (B.y - A.y) ** 2);
  return far;
}).filter(Boolean).length / 400;
assert.ok(overshootRate('fast') > 0.4, 'fast редко промахивается');
assert.ok(overshootRate('slow') < 0.15, 'slow слишком часто промахивается');
assert.ok(overshootRate('fast') > overshootRate('slow'));

// Перелёт: движение проходит за цель вдоль направления, потом точки возвращаются и сходятся в цель.
const over = Array.from({ length: 200 }, () => plan(A, B, { speed: 'fast' })).find((p) => {
  const proj = (q) => ((q.x - A.x) * (B.x - A.x) + (q.y - A.y) * (B.y - A.y)) / ((B.x - A.x) ** 2 + (B.y - A.y) ** 2);
  return p.some((q) => proj(q) > 1.01);
});
assert.ok(over, 'не нашли план с перелётом');
const projOf = (q) => ((q.x - A.x) * (B.x - A.x) + (q.y - A.y) * (B.y - A.y)) / ((B.x - A.x) ** 2 + (B.y - A.y) ** 2);
const peak = over.reduce((bi, q, i, arr) => (projOf(q) > projOf(arr[bi]) ? i : bi), 0); // самая дальняя за целью точка
assert.ok(over.slice(peak + 1).length >= 3, 'после перелёта нет возврата');
assert.ok(over[peak].dt > 40, 'нет замера после перелёта');

// Курсор уже на кнопке — двигать не надо.
const box = { x: 100, y: 100, width: 80, height: 30 };
assert.equal(inside({ x: 140, y: 115 }, box), true);
assert.equal(inside({ x: 101, y: 115 }, box), false, 'у самого края — ещё нет');
assert.equal(inside({ x: 400, y: 400 }, box), false);
assert.equal(inside(undefined, box), false);

// click() на fake-странице: на месте мышь не двигается, издалека двигается.
(async () => {
  const moves = [];
  const page = { mouse: { move: async (x, y) => moves.push([x, y]), down: async () => {}, up: async () => {} } };
  const loc = { scrollIntoViewIfNeeded: async () => {}, boundingBox: async () => box };
  const h = require('../human.js');
  await h.click(page, loc, { speed: 'fast' });
  const first = moves.length;
  assert.ok(first > 5, 'первый клик должен двигать мышь');
  const orig = Math.random;
  Math.random = () => 0.1; // детерминированно: «уже на кнопке» → не двигаем
  await h.click(page, loc, { speed: 'fast' });
  Math.random = orig;
  assert.equal(moves.length, first, 'курсор уже на кнопке, а мышь двигалась');
  console.log('human.test (темпы): ok');
})().catch((e) => { console.error(e); process.exit(1); });
