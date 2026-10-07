/**
 * Человеческий темп: мышь по кривой, прокрутка рывками, ввод с опечатками.
 *
 * path() — чистая функция, её проверяет test/human.test.js. Остальное
 * работает поверх страницы playwright и держит последнюю позицию курсора сам:
 * playwright её не отдаёт.
 */
const rand = (a, b) => a + Math.random() * (b - a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pause = (a = 300, b = 1200) => sleep(rand(a, b));

/** Точки кубической кривой Безье от from к to, с замедлением к концу. */
function path(from, to, rnd = Math.random, minSteps = 8) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  const bend = () => (rnd() - 0.5) * dist * 0.5;
  const c1 = { x: from.x + dx * 0.3 + bend(), y: from.y + dy * 0.3 + bend() };
  const c2 = { x: from.x + dx * 0.7 + bend(), y: from.y + dy * 0.7 + bend() };
  const steps = Math.max(minSteps, Math.round(dist / 12));
  const pts = [];
  for (let i = 1; i <= steps; i++) {
    const t = 1 - (1 - i / steps) ** 2; // ease-out
    const u = 1 - t;
    pts.push({
      x: u ** 3 * from.x + 3 * u ** 2 * t * c1.x + 3 * u * t ** 2 * c2.x + t ** 3 * to.x,
      y: u ** 3 * from.y + 3 * u ** 2 * t * c1.y + 3 * u * t ** 2 * c2.y + t ** 3 * to.y,
    });
  }
  return pts;
}

/**
 * Три темпа руки. fast — «аим»: быстрый бросок примерно за секунду, который часто
 * пролетает мимо цели и возвращается. normal — обычное движение. slow — неторопливое.
 * ms — длительность движения на длинной дистанции (на короткой пропорционально меньше).
 */
const SPEEDS = {
  fast:   { ms: [600, 1300],  overshoot: 0.65, dwell: [30, 140] },
  normal: { ms: [1000, 1900], overshoot: 0.15, dwell: [80, 350] },
  slow:   { ms: [1800, 3200], overshoot: 0.05, dwell: [150, 600] },
};

function pickSpeed(rnd = Math.random) {
  const r = rnd();
  return r < 0.35 ? 'fast' : r < 0.8 ? 'normal' : 'slow';
}

/** Курсор уже над элементом: двигать мышь не нужно. */
function inside(pos, box, margin = 2) {
  return !!pos && pos.x >= box.x + margin && pos.x <= box.x + box.width - margin
    && pos.y >= box.y + margin && pos.y <= box.y + box.height - margin;
}

/**
 * План движения мыши from → to: список точек { x, y, dt } (dt — пауза перед точкой, мс).
 * Чистая функция, её проверяет test/human.test.js.
 * При перелёте мышь доходит до точки за целью, замирает на мгновение и возвращается
 * короткими дёргаными шажками; последняя точка плана всегда ровно to.
 */
function plan(from, to, { speed = pickSpeed(), rnd = Math.random } = {}) {
  const cfg = SPEEDS[speed];
  const dx = to.x - from.x, dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  const total = (cfg.ms[0] + rnd() * (cfg.ms[1] - cfg.ms[0])) * Math.min(1, 0.35 + dist / 900);

  const over = dist > 60 && rnd() < cfg.overshoot;
  const ux = dist ? dx / dist : 0, uy = dist ? dy / dist : 0;
  const reach = (speed === 'fast' ? 12 + rnd() * 34 : 8 + rnd() * 20);
  const side = (rnd() - 0.5) * 16;
  const aim = over ? { x: to.x + ux * reach - uy * side, y: to.y + uy * reach + ux * side } : to;

  const mainMs = over ? total * 0.8 : total;
  const pts = path(from, aim, rnd, Math.round(mainMs / 16));
  const out = pts.map((p) => ({ ...p, dt: (mainMs / pts.length) * (0.6 + rnd() * 0.8) }));

  if (over) {
    out[out.length - 1].dt += 40 + rnd() * 110; // замер: «увидел, что промахнулся»
    const n = 3 + Math.floor(rnd() * 4);
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const noise = (1 - t) * 3; // дрожь затухает к цели
      out.push({
        x: aim.x + (to.x - aim.x) * t + (rnd() - 0.5) * 2 * noise,
        y: aim.y + (to.y - aim.y) * t + (rnd() - 0.5) * 2 * noise,
        dt: 18 + rnd() * 45,
      });
    }
    Object.assign(out[out.length - 1], { x: to.x, y: to.y });
  }
  return out;
}

const cursor = new WeakMap();

async function moveTo(page, x, y, opts = {}) {
  const from = cursor.get(page) || { x: rand(100, 600), y: rand(100, 400) };
  for (const p of plan(from, { x, y }, opts)) {
    await sleep(p.dt);
    await page.mouse.move(p.x, p.y);
  }
  cursor.set(page, { x, y });
}

/**
 * Навести и кликнуть в случайную точку внутри элемента, а не в центр.
 * Курсор уже над элементом — не двигаем (изредка всё же чуть смещаемся).
 * opts.speed: 'fast' | 'normal' | 'slow'; по умолчанию случайно.
 */
async function click(page, locator, opts = {}) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error('элемент не виден');
  const speed = opts.speed || pickSpeed();
  const here = cursor.get(page);
  if (!(inside(here, box) && Math.random() < 0.85)) {
    await moveTo(page, box.x + box.width * rand(0.25, 0.75), box.y + box.height * rand(0.3, 0.7), { ...opts, speed });
  }
  const [a, b] = SPEEDS[speed].dwell;
  await pause(a, b);
  // Пока мышь шла, страница могла сдвинуться: вызывающий проверяет точку клика (бросает — клика нет).
  if (opts.verifyAt) await opts.verifyAt(cursor.get(page) || {});
  await page.mouse.down();
  await sleep(rand(40, 130));
  await page.mouse.up();
}

/** Прокрутка колесом несколькими рывками. */
async function scroll(page, total = rand(600, 2200)) {
  let done = 0;
  while (done < total) {
    const step = rand(80, 260);
    await page.mouse.wheel(0, step);
    done += step;
    await sleep(rand(60, 400));
    if (Math.random() < 0.1) await pause(800, 2500); // задержался прочитать
  }
}

/** Ввод посимвольно; изредка опечатка, которая тут же стирается. */
async function type(page, text) {
  const near = 'qwertyuiopasdfghjklzxcvbnm';
  for (const ch of text) {
    if (/[a-z]/i.test(ch) && Math.random() < 0.03) {
      await page.keyboard.type(near[Math.floor(Math.random() * near.length)]);
      await sleep(rand(120, 300));
      await page.keyboard.press('Backspace');
    }
    await page.keyboard.type(ch);
    await sleep(ch === ' ' ? rand(60, 220) : rand(35, 160));
  }
}

module.exports = { path, plan, inside, SPEEDS, moveTo, click, scroll, type, pause, rand, sleep };
