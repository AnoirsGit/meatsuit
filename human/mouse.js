/**
 * Мышь: чистое планирование, без страницы. Каждая функция возвращает план,
 * а проигрывает его human.js. Время в мс от начала плана, координаты целые:
 * у настоящей мыши clientX целый, а дробные значения выдают скрипт.
 */
const { between, chance, clamp, normal, lognormal } = require('./random');

const TAU = Math.PI * 2;

/** Профиль «минимального рывка»: плавный разгон и торможение, скорость колоколом. */
const minJerk = (x) => x * x * x * (10 - 15 * x + 6 * x * x);

/** Подёргивания по пути: резкий рывок на несколько пикселей, затухающий за десятые доли секунды. */
function planTwitches(T, rate, rnd) {
  const out = [];
  if (rate <= 0 || T < 400) return out;
  for (let k = 0; k < 2; k++) {
    if (!chance(rnd, k === 0 ? rate : rate * 0.25)) break;
    const angle = between(rnd, 0, TAU), amp = between(rnd, 4, 9);
    out.push({ at: between(rnd, 0.1 * T, T - 300), ax: Math.cos(angle) * amp, ay: Math.sin(angle) * amp, decay: between(rnd, 40, 65) });
  }
  return out;
}
const twitchShape = (w, t) => {
  const dt = t - w.at;
  if (dt <= 0) return 0;
  return dt < 15 ? dt / 15 : Math.exp(-(dt - 15) / w.decay);
};

/**
 * Подёргивание рукой в покое: резкий уход на несколько пикселей и возврат почти
 * на место. [{dx, dy, t}] — смещения от текущей позиции, t в мс от начала.
 */
function planTwitch(rnd = Math.random) {
  const angle = between(rnd, 0, TAU), reach = between(rnd, 5, 13);
  const at = (k) => ({ dx: Math.round(Math.cos(angle) * reach * k), dy: Math.round(Math.sin(angle) * reach * k) });
  const back = clamp(lognormal(rnd, 110, 0.4), 60, 300);
  return [
    { ...at(0.6), t: 10 },
    { ...at(1), t: 22 },
    { ...at(0.3), t: Math.round(22 + back) },
    { dx: Math.round(between(rnd, -1.2, 1.2)), dy: Math.round(between(rnd, -1.2, 1.2)), t: Math.round(36 + back) },
  ];
}

/**
 * Одно движение по слегка изогнутой кривой.
 * Длительность по закону Фиттса, у каждого движения свой разброс скорости;
 * скорость колоколом с пиком раньше середины; поверх неё дрожь руки,
 * которая к цели затихает, чтобы закончить точно в ней.
 */
function glide(from, to, { width = 40, speed = 1, tremor = 0.7, twitch = 0.3 } = {}, rnd = Math.random) {
  const end = { x: Math.round(to.x), y: Math.round(to.y) };
  const dx = to.x - from.x, dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 0.5) return [{ ...end, t: 0 }];

  const fitts = 120 + 135 * Math.log2(dist / Math.max(width, 8) + 1);
  const T = clamp(fitts * lognormal(rnd, 1, 0.22) / speed, 140, 3000);

  // Кубическая кривая: основная дуга в одну сторону, у второй точки иногда в другую (S-образно).
  const nx = -dy / dist, ny = dx / dist;
  const side = chance(rnd, 0.5) ? 1 : -1;
  const arc1 = side * dist * between(rnd, 0.02, 0.09);
  const arc2 = (chance(rnd, 0.35) ? -side : side) * dist * between(rnd, 0, 0.06);
  const f1 = between(rnd, 0.2, 0.4), f2 = between(rnd, 0.6, 0.8);
  const c1 = { x: from.x + dx * f1 + nx * arc1, y: from.y + dy * f1 + ny * arc1 };
  const c2 = { x: from.x + dx * f2 + nx * arc2, y: from.y + dy * f2 + ny * arc2 };
  const bezier = (u) => {
    const v = 1 - u, a = v * v * v, b = 3 * v * v * u, c = 3 * v * u * u, d = u * u * u;
    return { x: a * from.x + b * c1.x + c * c2.x + d * to.x, y: a * from.y + b * c1.y + c * c2.y + d * to.y };
  };

  // Разгон быстрее торможения; лёгкая неровность скорости, но назад не едем.
  const skew = between(rnd, 0.8, 0.95);
  const wobble = { a: between(rnd, 0.004, 0.012), f: between(rnd, 1.5, 3.5), ph: between(rnd, 0, TAU) };
  let reached = 0;
  const progress = (tau) => {
    const s = minJerk(tau ** skew) + wobble.a * Math.sin(TAU * wobble.f * tau + wobble.ph) * 4 * tau * (1 - tau);
    reached = Math.max(reached, clamp(s, 0, 1));
    return reached;
  };

  // Физиологический тремор 6–12 Гц.
  const shake = [0, 1].map(() => ({ f: between(rnd, 6, 12), ph: between(rnd, 0, TAU), a: tremor * between(rnd, 0.4, 1) }));
  const jitter = (t) => shake.reduce((s, h) => s + h.a * Math.sin(TAU * h.f * t / 1000 + h.ph), 0);

  // Мышь с опросом 125 Гц: событие раз в 8 мс, у таймера лишь небольшое дрожание.
  // Случайные интервалы дали бы неровные шаги пути, которых у железной мыши нет.
  const raw = [];
  for (let t = between(rnd, 5, 12); t < T - 4; t += clamp(8 + 0.7 * normal(rnd), 5, 12)) {
    const p = bezier(progress(t / T));
    const j = jitter(t) * Math.min(1, (T - t) / 150);
    raw.push({ x: p.x + nx * j, y: p.y + ny * j, t });
  }

  // Подёргивания накладываются поверх готового пути и случайность берут последней,
  // поэтому гладкая траектория при том же seed не меняется от того, есть они или нет.
  const twitches = planTwitches(T, twitch, rnd);
  const pts = [];
  let last = { x: Math.round(from.x), y: Math.round(from.y) };
  for (const r of raw) {
    const fade = Math.min(1, (T - r.t) / 150);
    let ox = 0, oy = 0;
    for (const w of twitches) { const k = twitchShape(w, r.t) * fade; ox += w.ax * k; oy += w.ay * k; }
    const q = { x: Math.round(r.x + ox), y: Math.round(r.y + oy), t: Math.round(r.t) };
    if (q.x !== last.x || q.y !== last.y) { pts.push(q); last = q; }
  }
  const tail = pts[pts.length - 1];
  if (tail && tail.x === end.x && tail.y === end.y) tail.t = Math.round(T); // уже в цели: не дублируем точку
  else pts.push({ ...end, t: Math.round(T) });
  return pts;
}

/**
 * Движение к цели. На длинной дистанции иногда перелетает или не доезжает,
 * замечает, делает паузу и доводит медленнее.
 */
function planMove(from, to, opts = {}, rnd = Math.random) {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const chanceOver = clamp(dist / 3000, 0.03, 0.3);
  const roll = rnd();
  const over = dist >= 80 && roll < chanceOver;
  const under = dist >= 80 && !over && roll < chanceOver + 0.12;
  if (!over && !under) return glide(from, to, opts, rnd);

  const ux = (to.x - from.x) / dist, uy = (to.y - from.y) / dist;
  const along = over ? Math.max(dist * between(rnd, 0.02, 0.06), 6) : -dist * between(rnd, 0.03, 0.08);
  const aside = between(rnd, -1, 1) * Math.abs(along) * 0.4;
  const miss = { x: to.x + ux * along - uy * aside, y: to.y + uy * along + ux * aside };

  const first = glide(from, miss, opts, rnd);
  const second = glide(miss, to, { ...opts, speed: (opts.speed || 1) * 0.7 }, rnd);
  const shift = first[first.length - 1].t + clamp(lognormal(rnd, 110, 0.4), 50, 400);
  const tail = second.map((p) => ({ ...p, t: p.t + shift }));
  const join = first[first.length - 1];
  if (tail[0].x === join.x && tail[0].y === join.y) tail.shift();
  return first.concat(tail);
}

/**
 * Удержать точки плана в окне w×h: Chromium отбрасывает события мыши вне окна, и следующее
 * приходило бы телепортом. Подряд одинаковые точки (после зажима) сливаются; from — где рука сейчас.
 * Последняя точка остаётся всегда, чтобы у плана был конец.
 */
function clampPlan(plan, w, h, from = null) {
  const maxX = w > 0 ? w - 1 : Infinity, maxY = h > 0 ? h - 1 : Infinity;
  const out = [];
  plan.forEach((p, i) => {
    const q = { ...p, x: clamp(p.x, 0, maxX), y: clamp(p.y, 0, maxY) };
    const prev = out.length ? out[out.length - 1] : from;
    const same = prev && prev.x === q.x && prev.y === q.y;
    if (!same || (i === plan.length - 1 && !out.length)) out.push(q);
  });
  return out;
}

/** Куда кликнуть внутри элемента: около центра, чуть ближе к стороне, откуда пришла мышь. */
function pickPoint(box, from, rnd = Math.random) {
  const axis = (start, size, fromAt, sigmaCap) => {
    const centre = start + size / 2;
    const lean = Math.sign(fromAt - centre) * 0.05 * size;
    const inset = Math.min(size * 0.12, size / 2);
    const x = Math.round(centre + lean + normal(rnd) * Math.min(size / 6, sigmaCap));
    return clamp(x, Math.ceil(start + inset), Math.floor(start + size - inset));
  };
  return { x: axis(box.x, box.width, from.x, 45), y: axis(box.y, box.height, from.y, 25) };
}

/**
 * Прокрутка колесом: пачки рывков по делению колеса, между пачками пауза
 * «прочитать», изредка шаг назад. Знак total — направление.
 */
function planScroll(total, { notch = 100 } = {}, rnd = Math.random) {
  const dir = total < 0 ? -1 : 1;
  let left = Math.abs(total), t = 0;
  const events = [];
  while (left > 0 && events.length < 500) {
    const burst = clamp(Math.round(lognormal(rnd, 3, 0.5)), 1, 8);
    for (let i = 0; i < burst && left > 0; i++) {
      events.push({ t: Math.round(t), dy: dir * notch });
      left -= notch;
      t += clamp(lognormal(rnd, 55, 0.4), 20, 200);
    }
    if (left <= 0) break;
    t += clamp(lognormal(rnd, 700, 0.6), 300, 5000);
    if (left > 2 * notch && chance(rnd, 0.07)) {
      events.push({ t: Math.round(t), dy: -dir * notch });
      left += notch;
      t += clamp(lognormal(rnd, 400, 0.4), 150, 2000);
    }
  }
  return events;
}

module.exports = { glide, planMove, clampPlan, pickPoint, planScroll, planTwitch };
