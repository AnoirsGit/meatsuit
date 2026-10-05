/**
 * Случайные числа: генератор подставляется (в тестах с seed), распределения
 * нужны те, что у людей: логнормальные задержки с тяжёлым правым хвостом.
 */

/** Воспроизводимый генератор (mulberry32): тот же seed, та же последовательность. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (rnd, a, b) => a + rnd() * (b - a);
const chance = (rnd, p) => rnd() < p;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** Стандартное нормальное (Бокс — Мюллер). */
function normal(rnd) {
  let u = 0;
  while (u === 0) u = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
}

/** Логнормальное с заданной медианой: чаще чуть быстрее, изредка заметно дольше. */
const lognormal = (rnd, median, sigma) => median * Math.exp(sigma * normal(rnd));

module.exports = { seeded, between, chance, clamp, normal, lognormal };
