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
function path(from, to, rnd = Math.random) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  const bend = () => (rnd() - 0.5) * dist * 0.5;
  const c1 = { x: from.x + dx * 0.3 + bend(), y: from.y + dy * 0.3 + bend() };
  const c2 = { x: from.x + dx * 0.7 + bend(), y: from.y + dy * 0.7 + bend() };
  const steps = Math.max(8, Math.round(dist / 12));
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

const cursor = new WeakMap();

async function moveTo(page, x, y) {
  const from = cursor.get(page) || { x: rand(100, 600), y: rand(100, 400) };
  // Изредка — перелёт мимо цели и возврат.
  const overshoot = Math.random() < 0.15 ? { x: x + rand(-25, 25), y: y + rand(-15, 15) } : null;
  for (const target of overshoot ? [overshoot, { x, y }] : [{ x, y }]) {
    for (const p of path(cursor.get(page) || from, target)) {
      await page.mouse.move(p.x, p.y);
      await sleep(rand(4, 18));
    }
    cursor.set(page, target);
  }
}

/** Навести и кликнуть в случайную точку внутри элемента, а не в центр. */
async function click(page, locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error('элемент не виден');
  await moveTo(page, box.x + box.width * rand(0.25, 0.75), box.y + box.height * rand(0.3, 0.7));
  await pause(80, 350);
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

module.exports = { path, moveTo, click, scroll, type, pause, rand, sleep };
