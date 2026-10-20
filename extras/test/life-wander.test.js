/**
 * Случайные мелочи за чтением (life/wander.js): листнуть вверх, навести на пункт меню,
 * постоять, отвлечься. Выбор чистый, действия идут по фальшивой странице.
 *
 *   node --test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { seeded } = require('../human/random.js');
const { fakePage } = require('../testkit/fakepage.js');
const { pickWander, wander } = require('../life/wander.js');

const link = (x, y, w = 120, h = 24) => ({ href: 'https://a.test/x', raw: '/x', text: 'Пункт меню сайта', target: '', zone: 'nav', x, y, w, h });
const probeWith = (links) => ({ links: async () => links });

test('выбор мелочи: все четыре вида встречаются, листнуть вверх и постоять чаще, отвлечься реже', () => {
  const rnd = seeded(3), n = {};
  for (let i = 0; i < 4000; i++) { const k = pickWander(rnd); n[k] = (n[k] || 0) + 1; }
  assert.deepEqual(Object.keys(n).sort(), ['away', 'hover', 'idle', 'scrollUp']);
  assert.ok(n.scrollUp > n.hover && n.idle > n.hover && n.hover > n.away, JSON.stringify(n));
  assert.ok(n.away / 4000 > 0.04 && n.away / 4000 < 0.2, `отвлёкся в ${n.away} из 4000`);
});

test('листнуть вверх: колесом, на 1–4 деления, не вниз', async () => {
  for (let seed = 1; seed <= 30; seed++) {
    const { page, env, log } = fakePage();
    await wander(page, { ...env, rnd: seeded(seed) }, probeWith([]), { kind: 'scrollUp' });
    const w = log.filter((e) => e.op === 'wheel');
    assert.ok(w.length >= 1 && w.length <= 4 + 1, `${w.length} рывков`);
    assert.ok(w.every((e) => e.dy < 0 || w.length === 0), 'листнул вниз');
  }
});

test('навести на пункт меню: рука приходит на ссылку, но не нажимает', async () => {
  const l = link(300, 40);
  for (let seed = 1; seed <= 30; seed++) {
    const { page, env, log } = fakePage();
    await wander(page, { ...env, rnd: seeded(seed) }, probeWith([l]), { kind: 'hover' });
    const last = log.filter((e) => e.op === 'move').pop();
    assert.ok(last.x >= l.x && last.x <= l.x + l.w && last.y >= l.y && last.y <= l.y + l.h, `рука не на ссылке: (${last.x},${last.y})`);
    assert.ok(!log.some((e) => e.op === 'down' || e.op === 'up'), 'нажал вместо наведения');
  }
});

test('навести не на что: просто постоял', async () => {
  const { page, env, log, clock } = fakePage();
  await wander(page, env, probeWith([]), { kind: 'hover' });
  assert.ok(!log.some((e) => e.op === 'down'));
  assert.ok(clock.t >= 3000, `${clock.t} мс`);
});

test('постоять: несколько секунд без нажатий и прокрутки; отвлёкся: долго и без единого движения', async () => {
  const a = fakePage();
  await wander(a.page, a.env, probeWith([]), { kind: 'idle' });
  assert.ok(a.clock.t >= 3000 && a.clock.t <= 30000, `постоял ${a.clock.t} мс`);
  assert.ok(!a.log.some((e) => e.op === 'down' || e.op === 'wheel'));

  const b = fakePage();
  await wander(b.page, b.env, probeWith([]), { kind: 'away' });
  assert.ok(b.clock.t >= 15000 && b.clock.t <= 90000, `отвлёкся на ${b.clock.t} мс`);
  assert.equal(b.log.length, 0, 'за время «отошёл» мышь двигалась');
});

test('не выходит за срок сессии: остаток времени ограничивает любую мелочь', async () => {
  for (const kind of ['idle', 'away', 'hover']) {
    const { page, env, clock } = fakePage();
    await wander(page, { ...env, room: () => 2500 }, probeWith([link(300, 40)]), { kind });
    assert.ok(clock.t <= 6000, `${kind}: ${clock.t} мс при остатке 2500`); // допуск на ход руки к ссылке
  }
});
