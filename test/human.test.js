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
