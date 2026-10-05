/**
 * Случайные мелочи за чтением. Человек за страницей не только листает вниз: возвращается
 * вверх, наводит на меню, замирает, отходит от экрана. Ни одна из них ничего не нажимает
 * и не меняет, но разнообразит ритм сессии.
 */
const human = require('../human.js');
const { between, clamp, lognormal } = require('../human/random');

// Вид мелочи и вес: листнуть вверх и постоять чаще, отвлечься реже.
const KINDS = [['scrollUp', 0.35], ['idle', 0.3], ['hover', 0.25], ['away', 0.1]];

function pickWander(rnd = Math.random) {
  let r = rnd();
  for (const [kind, weight] of KINDS) { r -= weight; if (r < 0) return kind; }
  return KINDS[0][0];
}

/**
 * Сделать одну мелочь. opts.kind задаёт вид (в тестах); иначе выбирается случайно.
 * Любая длительность ограничена остатком срока сессии (env.room, если есть).
 * Возвращает вид сделанного, чтобы сессия записала его в журнал.
 */
async function wander(page, env, probe, { kind = pickWander(env.rnd) } = {}) {
  const room = () => (typeof env.room === 'function' ? Math.max(env.room(), 0) : Infinity);
  const wait = (median, sigma, lo, hi) => Math.min(clamp(lognormal(env.rnd, median, sigma), lo, hi), room());
  switch (kind) {
    case 'scrollUp':
      await human.scroll(page, -between(env.rnd, 100, 400), env);
      break;
    case 'hover': {
      const links = typeof probe.links === 'function' ? await probe.links(page) : [];
      const l = links[Math.floor(env.rnd() * links.length)];
      if (!l) { await human.linger(page, wait(9000, 0.5, 3000, 30000), env); return 'idle'; } // навести не на что
      await human.moveTo(page, Math.round(l.x + l.w * between(env.rnd, 0.2, 0.8)), Math.round(l.y + l.h * between(env.rnd, 0.3, 0.7)), { ...env, width: Math.min(l.w, l.h) });
      await human.linger(page, wait(900, 0.5, 300, 3500), env);
      break;
    }
    case 'idle':
      await human.linger(page, wait(9000, 0.5, 3000, 30000), env);
      break;
    case 'away': // отошёл от экрана: мышь не трогает вовсе
      await env.sleep(wait(35000, 0.4, 15000, 90000));
      break;
    default:
      throw new Error(`wander: неизвестный вид «${kind}»`);
  }
  return kind;
}

module.exports = { pickWander, wander, KINDS };
