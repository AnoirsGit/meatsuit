/**
 * Лимиты площадок: perDay, perHour и часы по поясу (по умолчанию UTC+5), единица — cost, счётчики
 * переживают перезапуск, ответ несёт retry_at. Часы и файлы подставляются.
 *
 *   node --test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLimits, normalizeSites } = require('../limits.js');

/** Местное время пояса по умолчанию (UTC+5) → миллисекунды UTC. */
const at = (h, m = 0, day = 5) => Date.UTC(2026, 9, day, h - 5, m);

const SITES = {
  'hh.kz': { perDay: 5, perHour: 2, hours: '10-21' },
  'linkedin.com': { perDay: 0 },
  'greenhouse.io': { perDay: 25, perHour: 4, hours: '9-22' },
  'open.test': { perDay: 3 },
};

/** Файловая система в памяти: видно, что и в каком порядке записано. */
function memFs() {
  const files = new Map(), ops = [];
  return {
    files, ops,
    readFileSync(f) { if (!files.has(f)) throw Object.assign(new Error('нет файла'), { code: 'ENOENT' }); return files.get(f); },
    writeFileSync(f, data) { ops.push(['write', f]); files.set(f, String(data)); },
    renameSync(a, b) { ops.push(['rename', a, b]); files.set(b, files.get(a)); files.delete(a); },
    mkdirSync(d) { ops.push(['mkdir', d]); },
  };
}

function setup(clockAt = at(12), sites = SITES) {
  const clock = { t: clockAt };
  const mem = memFs();
  const make = () => createLimits({ sites, file: 'data/limits.json', now: () => clock.t, fs: mem });
  return { clock, mem, make, limits: make() };
}

test('normalizeSites: часы разбираются, остальное по умолчанию без лимита', () => {
  assert.deepEqual(normalizeSites({ 'HH.kz': { perDay: 3, hours: '10-21' }, 'a.test': { perDay: 0 } }), {
    'hh.kz': { perDay: 3, perHour: null, hours: [10, 21] },
    'a.test': { perDay: 0, perHour: null, hours: null },
  });
});

test('normalizeSites: опечатки и невозможные значения отвергаются, а не молча пропускаются', () => {
  const bad = (cfg, re) => assert.throws(() => normalizeSites(cfg), re, JSON.stringify(cfg));
  bad({}, /площадк/);
  bad(null, /площадк/);
  bad({ 'a.test': {} }, /perDay/);
  bad({ 'a.test': { perDay: -1 } }, /perDay/);
  bad({ 'a.test': { perDay: 1.5 } }, /perDay/);
  bad({ 'a.test': { perDay: '3' } }, /perDay/);
  bad({ 'a.test': { perDay: 3, perHour: -1 } }, /perHour/);
  bad({ 'a.test': { perDay: 3, hours: '21-10' } }, /hours/);
  bad({ 'a.test': { perDay: 3, hours: '10' } }, /hours/);
  bad({ 'a.test': { perDay: 3, hours: '10-25' } }, /hours/);
  bad({ 'a.test': { perDay: 3, hours: [10, 21] } }, /hours/);
  bad({ 'a.test': { perDay: 3, perday: 4 } }, /perday/);
  bad({ 'a.test': 5 }, /a\.test/);
});

test('find: площадка по имени, www и поддомену, по адресу; не описанная — null', () => {
  const { limits } = setup();
  assert.equal(limits.find('hh.kz'), 'hh.kz');
  assert.equal(limits.find('HH.KZ'), 'hh.kz');
  assert.equal(limits.find('www.hh.kz'), 'hh.kz');
  assert.equal(limits.find('https://spb.hh.kz/vacancy/1?x=1'), 'hh.kz');
  assert.equal(limits.find('boards.greenhouse.io'), 'greenhouse.io');
  assert.equal(limits.find('evilhh.kz'), null, 'суффикс считается по границе имени');
  assert.equal(limits.find('hh.kz.evil.com'), null);
  assert.equal(limits.find('tinder.com'), null);
  assert.equal(limits.find(''), null);
  assert.equal(limits.find(undefined), null);
});

test('в пределах лимита пускает и считает', () => {
  const { limits, clock } = setup();
  assert.equal(limits.take('hh.kz', 1).ok, true);
  clock.t += 60000;
  assert.equal(limits.take('hh.kz', 1).ok, true);
  const s = limits.snapshot()['hh.kz'];
  assert.deepEqual([s.usedDay, s.usedHour], [2, 2]);
});

test('perHour скользящий: когда освободится, говорит retry_at', () => {
  const { limits, clock } = setup(at(12, 0));
  limits.take('hh.kz', 1);
  clock.t = at(12, 20);
  limits.take('hh.kz', 1);
  clock.t = at(12, 30);
  const r = limits.take('hh.kz', 1);
  assert.deepEqual([r.ok, r.reason, r.retry_at], [false, 'hour', at(13, 0)]);
  clock.t = at(12, 59);
  assert.equal(limits.take('hh.kz', 1).ok, false);
  clock.t = at(13, 0);
  assert.equal(limits.take('hh.kz', 1).ok, true, 'первое действие вышло из часа');
});

test('perDay: сутки по UTC+5, retry_at — когда откроется окно следующих суток', () => {
  const { limits, clock } = setup(at(10, 0));
  for (const [h, m] of [[10, 0], [10, 5], [11, 10], [11, 15], [12, 30]]) { clock.t = at(h, m); assert.equal(limits.take('hh.kz', 1).ok, true, `${h}:${m}`); }
  clock.t = at(14, 0);
  const r = limits.take('hh.kz', 1);
  assert.deepEqual([r.ok, r.reason, r.retry_at], [false, 'day', at(10, 0, 6)]);
});

test('сутки сбрасываются в полночь по UTC+5, а не по UTC', () => {
  const { limits, clock } = setup(at(20, 0), { 'late.test': { perDay: 1 } });
  assert.equal(limits.take('late.test', 1).ok, true);
  clock.t = at(23, 30); // 18:30 UTC: дата по UTC та же, по UTC+5 ещё те же сутки
  assert.equal(limits.take('late.test', 1).ok, false);
  clock.t = at(0, 30, 6); // 19:30 UTC: по UTC всё ещё 5 октября, по UTC+5 уже 6-е
  assert.equal(limits.take('late.test', 1).ok, true);
});

test('часы работы: до открытия и после закрытия, retry_at — ближайшее открытие', () => {
  const { limits, clock } = setup(at(9, 0));
  let r = limits.take('hh.kz', 1);
  assert.deepEqual([r.ok, r.reason, r.retry_at], [false, 'hours', at(10, 0)]);
  clock.t = at(21, 0); // граница: 21:00 уже закрыто
  r = limits.take('hh.kz', 1);
  assert.deepEqual([r.ok, r.reason, r.retry_at], [false, 'hours', at(10, 0, 6)]);
  clock.t = at(10, 0);
  assert.equal(limits.take('hh.kz', 1).ok, true, '10:00 уже открыто');
  clock.t = at(20, 59);
  assert.equal(limits.take('hh.kz', 1).ok, true);
});

test('без hours площадка открыта круглые сутки', () => {
  const { limits, clock } = setup(at(3, 0));
  assert.equal(limits.take('open.test', 1).ok, true);
  clock.t = at(23, 59);
  assert.equal(limits.take('open.test', 1).ok, true);
});

test('несколько запретов сразу: retry_at там, где откроются все', () => {
  const { limits, clock } = setup(at(10, 0), { 'combo.test': { perDay: 5, hours: '9-22' } });
  limits.take('combo.test', 5); // выбрал суточный лимит за раз
  clock.t = at(23, 0); // окно закрыто и сутки выбраны
  const r = limits.take('combo.test', 1);
  assert.deepEqual([r.ok, r.reason, r.retry_at], [false, 'hours', at(9, 0, 6)]);
});

test('cost: сессия ест несколько единиц; не влезающая в час ждёт, не влезающая никогда — retry_at null', () => {
  const { limits } = setup(at(12, 0));
  assert.equal(limits.take('greenhouse.io', 4).ok, true);
  let r = limits.take('greenhouse.io', 1);
  assert.deepEqual([r.ok, r.reason], [false, 'hour']);
  r = limits.take('greenhouse.io', 5);
  assert.deepEqual([r.ok, r.reason, r.retry_at], [false, 'too_big', null]);
  r = limits.take('greenhouse.io', 26);
  assert.deepEqual([r.ok, r.reason, r.retry_at], [false, 'too_big', null]);
});

test('perDay 0: площадка закрыта, retry_at нет', () => {
  const { limits } = setup();
  const r = limits.take('linkedin.com', 1);
  assert.deepEqual([r.ok, r.reason, r.retry_at], [false, 'closed', null]);
  assert.equal(limits.snapshot()['linkedin.com'].open, false);
});

test('отказ ничего не списывает', () => {
  const { limits, clock } = setup(at(9, 0));
  limits.take('hh.kz', 1); // вне часов
  clock.t = at(10, 0);
  assert.equal(limits.snapshot()['hh.kz'].usedDay, 0);
});

test('refund возвращает списанное, когда задача не открылась', () => {
  const { limits } = setup();
  const a = limits.take('hh.kz', 2);
  assert.equal(limits.snapshot()['hh.kz'].usedHour, 2);
  limits.refund(a);
  assert.equal(limits.snapshot()['hh.kz'].usedHour, 0);
  limits.refund(a); // повторный возврат безвреден
  assert.equal(limits.snapshot()['hh.kz'].usedHour, 0);
});

test('неописанная площадка: take отказывает, а не считает', () => {
  const { limits } = setup();
  const r = limits.take('tinder.com', 1);
  assert.deepEqual([r.ok, r.reason], [false, 'unknown_site']);
});

test('счётчики пишутся целиком через tmp и rename и переживают перезапуск', () => {
  const { limits, mem, make, clock } = setup();
  limits.take('hh.kz', 2);
  assert.deepEqual(mem.ops.filter((o) => o[0] !== 'mkdir'), [['write', 'data/limits.json.tmp'], ['rename', 'data/limits.json.tmp', 'data/limits.json']]);
  assert.ok(!mem.files.has('data/limits.json.tmp'));

  const restarted = make();
  assert.equal(restarted.snapshot()['hh.kz'].usedDay, 2);
  clock.t += 60000;
  assert.equal(restarted.take('hh.kz', 1).ok, false, 'час уже выбран: 2 из 2');
});

test('старые записи не копятся: в файле только то, что ещё считается', () => {
  const { limits, mem, clock } = setup(at(12, 0));
  limits.take('hh.kz', 1);
  clock.t = at(12, 0, 8);
  limits.take('hh.kz', 1);
  assert.equal(JSON.parse(mem.files.get('data/limits.json'))['hh.kz'].length, 1);
});

test('испорченный файл счётчиков: ошибка, а не молчаливый сброс лимитов', () => {
  const mem = memFs();
  mem.files.set('data/limits.json', '{ oops');
  assert.throws(() => createLimits({ sites: SITES, file: 'data/limits.json', now: () => at(12), fs: mem }), /limits/);
  mem.files.set('data/limits.json', JSON.stringify({ 'hh.kz': 'много' }));
  assert.throws(() => createLimits({ sites: SITES, file: 'data/limits.json', now: () => at(12), fs: mem }), /limits/);
});

test('в файле площадка, которой больше нет в sites.json: не мешает', () => {
  const mem = memFs();
  mem.files.set('data/limits.json', JSON.stringify({ 'old.test': [[at(11), 1]] }));
  const limits = createLimits({ sites: SITES, file: 'data/limits.json', now: () => at(12), fs: mem });
  assert.equal(limits.take('hh.kz', 1).ok, true);
});

test('на настоящем диске: запись и чтение после «перезапуска»', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meatsuit-limits-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'nested', 'limits.json'); // каталога ещё нет
  const a = createLimits({ sites: SITES, file, now: () => at(12) });
  assert.equal(a.take('hh.kz', 1).ok, true);
  const b = createLimits({ sites: SITES, file, now: () => at(12) });
  assert.equal(b.snapshot()['hh.kz'].usedDay, 1);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['limits.json']);
});

test('snapshot для страницы статуса: лимиты, расход, открыта ли сейчас', () => {
  const { limits } = setup(at(12, 0));
  limits.take('hh.kz', 1);
  const s = limits.snapshot();
  assert.deepEqual(s['hh.kz'], { perDay: 5, perHour: 2, hours: '10-21', usedDay: 1, usedHour: 1, open: true });
  assert.equal(s['open.test'].hours, null);
});

test('snapshot: вне часов площадка не открыта', () => {
  const { limits } = setup(at(23, 0));
  assert.equal(limits.snapshot()['hh.kz'].open, false);
});

// ---------------------------------------------------------------- поведение как у человека: рост, выходные, разброс, пауза

const DAY = 86400000;
/** Эффективный лимит и выходной на сутки `day` октября, в полдень по UTC+5. */
const st = (limits, name, day, h = 12) => limits.status(name, at(h, 0, day));
/** Понедельник 5 октября 2026: с него считаем недели в тестах. */
const MON = 5;
const weeksOf = (limits, name, weeks) => Array.from({ length: weeks }, (_, w) => Array.from({ length: 7 }, (_, i) => st(limits, name, MON + w * 7 + i).rest));
const restPairs = (days) => days.reduce((n, r, i) => n + (r && days[i - 1] ? 1 : 0), 0);

test('normalizeSites: ramp, restDaysPerWeek, jitter, challengePauseDays разбираются; без них ничего лишнего', () => {
  const out = normalizeSites({ 'a.test': { perDay: 10, ramp: { days: 14, startShare: 0.3 }, restDaysPerWeek: 2, jitter: 0.2, challengePauseDays: 5 }, 'b.test': { perDay: 1 } });
  assert.deepEqual(out['a.test'], { perDay: 10, perHour: null, hours: null, ramp: { days: 14, startShare: 0.3 }, restDaysPerWeek: 2, jitter: 0.2, challengePauseDays: 5 });
  assert.deepEqual(out['b.test'], { perDay: 1, perHour: null, hours: null });
});

test('normalizeSites: невозможные ramp, выходные, jitter и пауза отвергаются', () => {
  const bad = (extra, re) => assert.throws(() => normalizeSites({ 'a.test': { perDay: 5, ...extra } }), re, JSON.stringify(extra));
  bad({ ramp: 14 }, /ramp/);
  bad({ ramp: { days: 0, startShare: 0.3 } }, /ramp/);
  bad({ ramp: { days: 1.5, startShare: 0.3 } }, /ramp/);
  bad({ ramp: { days: 14, startShare: 1.2 } }, /ramp/);
  bad({ ramp: { days: 14, startShare: -0.1 } }, /ramp/);
  bad({ ramp: { days: 14 } }, /ramp/);
  bad({ ramp: { days: 14, startShare: 0.3, extra: 1 } }, /ramp/);
  bad({ restDaysPerWeek: 7 }, /restDaysPerWeek/);
  bad({ restDaysPerWeek: -1 }, /restDaysPerWeek/);
  bad({ restDaysPerWeek: 1.5 }, /restDaysPerWeek/);
  bad({ jitter: 1 }, /jitter/);
  bad({ jitter: -0.1 }, /jitter/);
  bad({ jitter: '0.2' }, /jitter/);
  bad({ challengePauseDays: -1 }, /challengePauseDays/);
  bad({ challengePauseDays: 1.5 }, /challengePauseDays/);
});

test('без новых полей всё как раньше: эффективный лимит равен perDay, выходных и паузы нет', () => {
  const { limits } = setup(at(12));
  const s = limits.status('hh.kz', at(12));
  assert.deepEqual([s.site, s.perDay, s.effective, s.usedDay, s.rest, s.frozenUntil], ['hh.kz', 5, 5, 0, false, null]);
  for (let day = 5; day < 40; day++) assert.deepEqual([st(limits, 'hh.kz', day).effective, st(limits, 'hh.kz', day).rest], [5, false]);
  assert.equal(limits.status('tinder.com', at(12)), null, 'не описанная площадка');
  assert.equal(limits.status('linkedin.com', at(12)).effective, 0, 'perDay 0 остаётся нулём');
});

// ---- рост

const RAMP = { 'ramp.test': { perDay: 20, ramp: { days: 10, startShare: 0.5 } } };

test('ramp: лимит растёт по суткам UTC+5 от первого успешного begin', () => {
  const { limits, clock } = setup(at(23, 50), RAMP);
  assert.equal(limits.status('ramp.test', at(12, 0, 9)).effective, 10, 'пока begin не было, идёт день 0');
  assert.equal(limits.take('ramp.test', 1).ok, true);
  const eff = (day, h = 12) => limits.status('ramp.test', at(h, 0, day)).effective;
  assert.equal(eff(5, 23), 10, 'день 0: половина');
  assert.equal(eff(6, 0), 11, 'после полуночи по UTC+5 уже день 1, хотя прошло десять минут');
  assert.equal(eff(10), 15, 'день 5: 20 × (0,5 + 0,5 × 5/10)');
  assert.equal(eff(15), 20, 'день 10: полный');
  assert.equal(eff(60), 20, 'дальше не растёт');
  clock.t = at(12, 0, 6);
  for (let i = 0; i < 11; i++) assert.equal(limits.take('ramp.test', 1).ok, true, `${i}`);
  assert.deepEqual([limits.take('ramp.test', 1).ok, limits.take('ramp.test', 1).reason], [false, 'day'], 'в день 1 можно 11, а не 20');
});

test('ramp: округление вверх, не меньше 1, без сюрпризов от дробей', () => {
  const { limits } = setup(at(12), {
    'a.test': { perDay: 15, ramp: { days: 14, startShare: 0.3 } },
    'tiny.test': { perDay: 3, ramp: { days: 7, startShare: 0.05 } },
    'one.test': { perDay: 1, ramp: { days: 7, startShare: 0.3 } },
    'float.test': { perDay: 100, ramp: { days: 7, startShare: 0.07 } }, // 100 × 0,07 = 7,000000000000001
    'zero.test': { perDay: 0, ramp: { days: 7, startShare: 0.3 } },
    'flat.test': { perDay: 8, ramp: { days: 5, startShare: 1 } },
  });
  assert.equal(limits.status('a.test', at(12)).effective, 5, '4,5 вверх до 5');
  assert.equal(limits.status('tiny.test', at(12)).effective, 1, '0,15 вверх до 1, а не 0');
  assert.equal(limits.status('one.test', at(12)).effective, 1);
  assert.equal(limits.status('float.test', at(12)).effective, 7, 'не 8');
  assert.equal(limits.status('zero.test', at(12)).effective, 0, 'perDay 0 — закрыто, рост не открывает');
  assert.equal(limits.status('flat.test', at(12)).effective, 8, 'startShare 1 — роста нет');
});

test('ramp: первый успешный begin запоминается в файле и переживает перезапуск', () => {
  const { limits, mem, make, clock } = setup(at(23, 50), RAMP);
  limits.take('ramp.test', 1);
  assert.equal(JSON.parse(mem.files.get('data/limits.json'))._state['ramp.test'].first, at(23, 50));
  clock.t = at(12, 0, 10);
  limits.take('ramp.test', 1); // второй begin первым не становится
  const restarted = make();
  assert.equal(restarted.status('ramp.test', at(12, 0, 10)).effective, 15, 'день 5 от первого begin, а не от второго и не от перезапуска');
});

test('ramp: begin, который вернули (окно не открылось), не считается первым; отказ тоже', () => {
  const { limits, mem, clock } = setup(at(9, 0), { 'late.test': { perDay: 20, hours: '10-21', ramp: { days: 10, startShare: 0.5 } } });
  assert.equal(limits.take('late.test', 1).ok, false, 'вне часов');
  assert.ok(!mem.files.has('data/limits.json') || !JSON.parse(mem.files.get('data/limits.json'))._state, 'отказ ничего не запомнил');
  clock.t = at(10, 0);
  const a = limits.take('late.test', 1);
  limits.refund(a);
  assert.equal(limits.status('late.test', at(12, 0, 20)).effective, 10, 'возвращённый begin не начал рост: день 0');
  clock.t = at(10, 0, 8);
  assert.equal(limits.take('late.test', 1).ok, true);
  assert.equal(limits.status('late.test', at(12, 0, 13)).effective, 15, 'рост пошёл с 8-го числа');
});

// ---- выходные

test('выходные: в каждой неделе (с понедельника) ровно столько, сколько заказано', () => {
  for (const n of [1, 2, 3, 4, 5, 6]) {
    const { limits } = setup(at(12), { 'r.test': { perDay: 5, restDaysPerWeek: n } });
    for (const [w, week] of weeksOf(limits, 'r.test', 12).entries()) assert.equal(week.filter(Boolean).length, n, `restDaysPerWeek ${n}, неделя ${w}`);
  }
  const { limits } = setup(at(12), { 'r.test': { perDay: 5 } });
  assert.equal(weeksOf(limits, 'r.test', 4).flat().filter(Boolean).length, 0, 'по умолчанию выходных нет');
});

test('выходные: два подряд только когда иначе не поместить (в том числе на стыке недель)', () => {
  for (const n of [1, 2, 3]) {
    const { limits } = setup(at(12), { 'r.test': { perDay: 5, restDaysPerWeek: n } });
    assert.equal(restPairs(weeksOf(limits, 'r.test', 30).flat()), 0, `restDaysPerWeek ${n}: смежных выходных быть не должно`);
  }
  const { limits } = setup(at(12), { 'r.test': { perDay: 5, restDaysPerWeek: 4 } }); // 4 из 7 без соседей: только пн, ср, пт, вс
  const days = weeksOf(limits, 'r.test', 30);
  assert.ok(days.every((w) => w.filter(Boolean).length === 4));
  assert.ok(days.every((w) => restPairs(w) <= 1), 'больше одной пары соседей в неделе не бывает');
  const five = setup(at(12), { 'r.test': { perDay: 5, restDaysPerWeek: 5 } }).limits;
  assert.ok(weeksOf(five, 'r.test', 10).every((w) => restPairs(w) >= 1), '5 из 7 без соседей не поместить');
});

test('выходные: одни и те же после перезапуска, в течение недели и при любом порядке запросов; не одинаковые у разных площадок и недель', () => {
  const sites = { 'a.test': { perDay: 5, restDaysPerWeek: 2 }, 'b.test': { perDay: 5, restDaysPerWeek: 2 } };
  const a = setup(at(12), sites).limits, b = setup(at(3), sites).limits;
  const asc = weeksOf(a, 'a.test', 10);
  assert.deepEqual(weeksOf(b, 'a.test', 10), asc, 'новый экземпляр даёт то же');
  const desc = [];
  for (let w = 9; w >= 0; w--) desc[w] = Array.from({ length: 7 }, (_, i) => st(b, 'a.test', MON + w * 7 + i).rest);
  assert.deepEqual(desc, asc, 'порядок запросов не важен');
  for (let day = MON; day < MON + 70; day++) for (const h of [0, 7, 23]) assert.equal(st(a, 'a.test', day, h).rest, asc[Math.floor((day - MON) / 7)][(day - MON) % 7], `${day} ${h}:00`);
  assert.notDeepEqual(weeksOf(a, 'b.test', 10), asc, 'у другой площадки свои дни');
  assert.ok(new Set(asc.map((w) => w.join())).size > 3, 'неделя от недели отличается');
});

test('выходной день: 429 rest_day, ничего не списано, retry_at — начало следующих суток', () => {
  const { limits, clock } = setup(at(12), { 'r.test': { perDay: 5, restDaysPerWeek: 1 } });
  const day = [...Array(14).keys()].map((i) => MON + i).find((d) => st(limits, 'r.test', d).rest);
  clock.t = at(12, 0, day);
  const r = limits.take('r.test', 1);
  assert.deepEqual([r.ok, r.reason, r.retry_at], [false, 'rest_day', at(0, 0, day + 1)]);
  assert.equal(limits.status('r.test', clock.t).usedDay, 0);
  clock.t = at(0, 0, day + 1);
  assert.equal(limits.take('r.test', 1).ok, true, 'на следующие сутки работаем');
});

test('выходной день и часы работы: retry_at — первое открытие окна после выходного', () => {
  const { limits, clock } = setup(at(12), { 'r.test': { perDay: 5, hours: '10-21', restDaysPerWeek: 1 } });
  const day = [...Array(14).keys()].map((i) => MON + i).find((d) => st(limits, 'r.test', d).rest);
  clock.t = at(12, 0, day);
  const r = limits.take('r.test', 1);
  assert.deepEqual([r.reason, r.retry_at], ['rest_day', at(10, 0, day + 1)]);
});

// ---- разброс

test('jitter: лимит дня в [1−j, 1+j] от perDay, округление вверх, не выше perDay × (1+j), у дня свой', () => {
  const { limits } = setup(at(12), { 'j.test': { perDay: 20, jitter: 0.2 }, 'odd.test': { perDay: 7, jitter: 0.2 }, 'one.test': { perDay: 1, jitter: 0.5 } });
  const eff = (name) => Array.from({ length: 90 }, (_, i) => st(limits, name, MON + i).effective);
  const j = eff('j.test');
  assert.ok(j.every((x) => x >= 16 && x <= 24), j.join());
  assert.ok(new Set(j).size >= 5, 'не одинаковые изо дня в день');
  assert.ok(Math.min(...j) <= 17 && Math.max(...j) >= 23, 'разброс использует диапазон');
  const odd = eff('odd.test');
  assert.ok(odd.every((x) => x >= 6 && x <= 8), `7 × 1,2 = 8,4: не больше 8, не меньше ceil(5,6) = 6, а было ${odd.join()}`);
  assert.ok(eff('one.test').every((x) => x === 1), 'при perDay 1 нуля не бывает, а выше 1 не поднимается');
});

test('jitter: детерминирован — сид из площадки и даты; в течение суток и после перезапуска тот же', () => {
  const sites = { 'a.test': { perDay: 20, jitter: 0.3 }, 'b.test': { perDay: 20, jitter: 0.3 } };
  const a = setup(at(12), sites).limits, b = setup(at(1), sites).limits;
  const run = (l, name) => Array.from({ length: 40 }, (_, i) => st(l, name, MON + i).effective);
  assert.deepEqual(run(b, 'a.test'), run(a, 'a.test'));
  assert.notDeepEqual(run(a, 'b.test'), run(a, 'a.test'), 'у другой площадки свой разброс');
  for (const h of [0, 3, 12, 23]) assert.equal(st(a, 'a.test', 9, h).effective, st(a, 'a.test', 9, 12).effective, `в ${h}:00 те же сутки`);
});

test('jitter вместе с ростом: не выше perDay × (1+j), а cost больше этого потолка — never (too_big)', () => {
  const { limits } = setup(at(12), { 'jr.test': { perDay: 20, jitter: 0.2, ramp: { days: 10, startShare: 0.5 } } });
  assert.equal(limits.take('jr.test', 1).ok, true); // рост считается от первого begin
  const eff = Array.from({ length: 40 }, (_, i) => st(limits, 'jr.test', MON + i).effective);
  assert.ok(eff.every((x) => x >= 1 && x <= 24));
  assert.ok(eff[0] <= 12, 'в первый день потолок низкий: 10 × 1,2');
  assert.ok(eff.slice(20).some((x) => x > 20), 'после роста бывает и выше perDay');
  const r = limits.take('jr.test', 25);
  assert.deepEqual([r.ok, r.reason, r.retry_at], [false, 'too_big', null]);
});

test('cost больше сегодняшнего лимита, но влезает позже (рост): отказ day, retry_at — сутки, когда влезет', () => {
  const { limits } = setup(at(12), { 'g.test': { perDay: 20, ramp: { days: 10, startShare: 0.5 } } });
  assert.equal(limits.take('g.test', 1).ok, true); // сегодня день 0: лимит 10, дальше 11, 12, 13...
  const r = limits.take('g.test', 12);
  assert.deepEqual([r.ok, r.reason, r.retry_at], [false, 'day', at(0, 0, 7)], '12 влезет на третьи сутки (день 2: лимит 12)');
});

// ---- пауза после проверки

const FREEZE = { 'hh.kz': { perDay: 5, perHour: 2, hours: '10-21' }, 'f.test': { perDay: 5, challengePauseDays: 2 }, 'g.test': { perDay: 5 } };

test('challenge: площадка замирает до начала суток по UTC+5 + N суток (по умолчанию 3)', () => {
  const { limits, clock } = setup(at(14, 0), FREEZE);
  const c = limits.challenge('g.test', at(14, 0));
  assert.deepEqual([c.ok, c.site, c.until], [true, 'g.test', at(0, 0, 8)]);
  assert.equal(limits.status('g.test', at(14, 0)).frozenUntil, at(0, 0, 8));
  for (const [h, day] of [[14, 5], [23, 5], [12, 6], [23, 7]]) {
    clock.t = at(h, 0, day);
    const r = limits.take('g.test', 1);
    assert.deepEqual([r.ok, r.reason, r.retry_at], [false, 'challenge_pause', at(0, 0, 8)], `${day}.10 ${h}:00`);
  }
  assert.equal(limits.take('f.test', 1).ok, true, 'другие площадки работают');
  clock.t = at(0, 0, 8);
  assert.equal(limits.take('g.test', 1).ok, true, 'ровно в срок пауза кончилась');
  assert.equal(limits.status('g.test', clock.t).frozenUntil, null);
});

test('challenge: своё число суток у площадки; повторная проверка продлевает, а не сокращает', () => {
  const { limits } = setup(at(14, 0), FREEZE);
  assert.equal(limits.challenge('f.test', at(14, 0)).until, at(0, 0, 7), 'challengePauseDays 2');
  assert.equal(limits.challenge('f.test', at(9, 0, 6)).until, at(0, 0, 8), 'позже — дальше');
  assert.equal(limits.challenge('f.test', at(9, 0, 5)).until, at(0, 0, 8), 'более ранняя проверка срок не сокращает');
  assert.equal(limits.status('f.test', at(12, 0, 6)).frozenUntil, at(0, 0, 8));
});

test('challenge: с часами работы retry_at — когда begin реально пройдёт; не описанная площадка — отказ', () => {
  const { limits, clock } = setup(at(14, 0), FREEZE);
  limits.challenge('hh.kz', at(14, 0));
  const r = limits.take('hh.kz', 1);
  assert.deepEqual([r.reason, r.retry_at], ['challenge_pause', at(10, 0, 8)]);
  assert.deepEqual([limits.challenge('tinder.com', at(14, 0)).ok, limits.challenge('tinder.com', at(14, 0)).reason], [false, 'unknown_site']);
  assert.equal(limits.challenge('www.g.test', at(14, 0)).site, 'g.test', 'площадка находится по поддомену, как везде');
  clock.t = at(0, 0, 8);
  assert.equal(limits.take('hh.kz', 1).ok, false, 'пауза кончилась, но до 10:00 окно закрыто');
});

test('challenge: пауза пишется в файл целиком и переживает перезапуск', () => {
  const { limits, mem, make } = setup(at(14, 0), FREEZE);
  limits.challenge('g.test', at(14, 0));
  assert.ok(mem.ops.some((o) => o[0] === 'rename'), 'файл записан без дальнейшего begin');
  assert.equal(JSON.parse(mem.files.get('data/limits.json'))._state['g.test'].frozenUntil, at(0, 0, 8));
  assert.ok(!mem.files.has('data/limits.json.tmp'));
  const restarted = make();
  assert.equal(restarted.status('g.test', at(12, 0, 6)).frozenUntil, at(0, 0, 8));
  const r = restarted.take('g.test', 1);
  assert.deepEqual([r.ok, r.reason], [false, 'challenge_pause']);
});

test('challenge не стирает счётчики, а счётчики — паузу', () => {
  const { limits, mem, make, clock } = setup(at(12, 0), FREEZE);
  limits.take('f.test', 2);
  limits.challenge('f.test', at(12, 0));
  const raw = JSON.parse(mem.files.get('data/limits.json'));
  assert.equal(raw['f.test'].length, 1);
  assert.ok(raw._state['f.test'].frozenUntil);
  clock.t = at(0, 0, 7);
  assert.equal(make().status('f.test', clock.t).usedDay, 0, 'уже другие сутки');
  assert.equal(make().status('f.test', at(13, 0)).usedDay, 2);
});

test('файл счётчиков: испорченное состояние — ошибка, а не молчаливый сброс паузы', () => {
  const mem = memFs();
  const bad = (state) => {
    mem.files.set('data/limits.json', JSON.stringify({ _state: state }));
    assert.throws(() => createLimits({ sites: SITES, file: 'data/limits.json', now: () => at(12), fs: mem }), /limits/, JSON.stringify(state));
  };
  bad('пауза');
  bad({ 'hh.kz': 'пауза' });
  bad({ 'hh.kz': { frozenUntil: 'завтра' } });
  bad({ 'hh.kz': { first: null } });
  mem.files.set('data/limits.json', JSON.stringify({ 'hh.kz': [[at(11), 1]] }));
  assert.equal(createLimits({ sites: SITES, file: 'data/limits.json', now: () => at(12), fs: mem }).status('hh.kz', at(12)).usedDay, 1, 'старый файл без _state читается');
});
