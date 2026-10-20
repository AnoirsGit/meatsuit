/**
 * Пауза «подумать» (human/pace.js): распределения по видам и расчёт недостающего.
 *
 *   node --test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { seeded } = require('../human/random.js');
const { reactionMs, owed, KINDS } = require('../human/pace.js');

const runs = (n, fn) => Array.from({ length: n }, (_, i) => fn(seeded(i + 1)));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

test('пауза по виду: в границах, целая, новая страница дольше нажатия, нажатие дольше клавиши', () => {
  const by = {};
  for (const kind of Object.keys(KINDS)) {
    const xs = runs(500, (r) => reactionMs(kind, r));
    for (const x of xs) {
      assert.ok(Number.isInteger(x), `${kind}: не целое ${x}`);
      assert.ok(x >= KINDS[kind].lo && x <= KINDS[kind].hi, `${kind}: ${x} вне границ`);
    }
    by[kind] = median(xs);
    assert.ok(new Set(xs).size > 100, `${kind}: пауза почти не меняется`);
  }
  assert.ok(by.page > 1.8 * by.act, `новая страница ${by.page} мс, нажатие ${by.act} мс`);
  assert.ok(by.act > 1.5 * by.keys, `нажатие ${by.act} мс, клавиша ${by.keys} мс`);
  assert.ok(by.page >= 1200 && by.page <= 2600, `медиана осмотра страницы ${by.page} мс: не человеческая`);
});

test('неизвестный вид — ошибка, а не молчаливый ноль', () => {
  assert.throws(() => reactionMs('dance', seeded(1)), /pace: неизвестный вид/);
});

test('owed: ждать только недостающее; клиент, который думал сам, не ждёт', () => {
  assert.equal(owed(1000, 0), 1000);
  assert.equal(owed(1000, 400), 600);
  assert.equal(owed(1000, 1000), 0);
  assert.equal(owed(1000, 25000), 0);
  assert.equal(owed(1000, -5), 1000, 'часы ушли назад: считаем, что не ждали');
  assert.equal(owed(1000, undefined), 1000);
  assert.equal(owed(999.6, 0), 1000, 'целое число миллисекунд');
});
