/**
 * Прогрев: расписание по Алматы, состав сессии, время чтения, выбор ссылок,
 * решение планировщика «что делать сейчас». Всё чистые функции.
 *
 *   node --test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { seeded } = require('../human/random.js');
const { startOfLocalDay, localDay, planDay, planSession, readingTime, pickLink, nextAction, deadlineOf , weekDays, weekId, planWeek} = require('../life/plan.js');

const TZ = 'Asia/Almaty';
const H = 3600e3, MIN = 60e3;
const CFG = {
  tz: TZ, hours: [9, 23], sessionsPerDay: [2, 5], minGapMinutes: 60, lateMinutes: 90, cooldownHours: 24,
  session: { minutes: [5, 14], sites: [2, 4] },
  sites: [
    { url: 'https://a.test/', kind: 'read', weight: 3 },
    { url: 'https://b.test/', kind: 'read', weight: 1 },
    { url: 'https://c.test/watch', kind: 'video', weight: 1 },
  ],
};
const runs = (n, fn) => Array.from({ length: n }, (_, i) => fn(seeded(i + 1), i));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const DAY = startOfLocalDay(Date.UTC(2026, 9, 5, 12), TZ); // полночь 5 октября по Алматы

test('сутки считаются по Алматы, а не по UTC', () => {
  assert.equal(DAY, Date.UTC(2026, 9, 4, 19)); // Алматы = UTC+5
  assert.equal(startOfLocalDay(Date.UTC(2026, 9, 5, 20), TZ), Date.UTC(2026, 9, 5, 19)); // 01:00 6 октября
  assert.equal(localDay(Date.UTC(2026, 9, 5, 12), TZ), '2026-10-05');
  assert.equal(localDay(Date.UTC(2026, 9, 5, 20), TZ), '2026-10-06');
});

test('старты дня: сколько заказано, в окне часов, с промежутками и влезает самая длинная сессия', () => {
  for (const s of runs(200, (r) => planDay(DAY, CFG, r))) {
    assert.ok(s.length >= 2 && s.length <= 5, `${s.length} стартов`);
    assert.deepEqual(s, [...s].sort((a, b) => a - b));
    s.forEach((t, i) => {
      assert.ok(t >= DAY + 9 * H, 'старт раньше окна');
      assert.ok(t + 14 * MIN <= DAY + 23 * H, 'сессия не влезает до конца окна');
      if (i) assert.ok(t - s[i - 1] >= 60 * MIN, 'старты ближе часа');
    });
  }
});

test('расписание не по будильнику: время первого старта разное день ото дня', () => {
  const firsts = runs(100, (r) => planDay(DAY, CFG, r)[0]);
  assert.ok(new Set(firsts).size > 40, 'старты повторяются');
});

test('невозможный заказ не зацикливается: берёт сколько влезает', () => {
  const s = planDay(DAY, { ...CFG, hours: [9, 10], sessionsPerDay: [20, 20] }, seeded(1));
  assert.ok(s.length <= 1, `в час влезло ${s.length} сессий`);
});

test('сессия: сайты только из конфига, без повторов подряд, бюджет в заданных минутах', () => {
  const urls = new Set(CFG.sites.map((s) => s.url));
  for (const steps of runs(200, (r) => planSession(CFG, r))) {
    assert.ok(steps.length >= 2 && steps.length <= 4, `${steps.length} сайтов`);
    steps.forEach((s, i) => {
      assert.ok(urls.has(s.url), `сайт вне конфига: ${s.url}`);
      assert.equal(s.kind, CFG.sites.find((x) => x.url === s.url).kind);
      assert.ok(s.budgetMs > 0);
      if (i) assert.notEqual(s.url, steps[i - 1].url, 'один сайт дважды подряд');
    });
    const sum = steps.reduce((t, s) => t + s.budgetMs, 0);
    assert.ok(sum >= 5 * MIN - 5 && sum <= 14 * MIN + 5, `сессия ${(sum / MIN).toFixed(1)} мин`);
  }
});

test('сайты выбираются по весу: тяжёлый попадается чаще лёгкого', () => {
  const count = (url) => runs(400, (r) => planSession(CFG, r)).flat().filter((s) => s.url === url).length;
  assert.ok(count('https://a.test/') > 1.4 * count('https://b.test/'), 'вес не учитывается');
});

test('видео не следует по ссылкам, чтение иногда следует', () => {
  const steps = runs(300, (r) => planSession(CFG, r)).flat();
  assert.ok(steps.filter((s) => s.kind === 'video').every((s) => s.follow === 0));
  assert.ok(steps.some((s) => s.kind === 'read' && s.follow > 0), 'ни разу не пошёл по ссылке');
  assert.ok(steps.some((s) => s.kind === 'read' && s.follow === 0), 'всегда идёт по ссылке');
});

test('время чтения растёт с длиной текста, в пределах от 8 с до 4 мин, и не одинаково', () => {
  const at = (chars) => runs(200, (r) => readingTime(chars, r));
  assert.ok(median(at(30000)) > 2 * median(at(3000)), 'длинный текст читается не дольше короткого');
  for (const chars of [100, 3000, 30000, 3000000]) for (const ms of at(chars)) assert.ok(ms >= 8000 && ms <= 240000, `${chars} знаков: ${ms} мс`);
  assert.ok(new Set(at(3000)).size > 100, 'время чтения постоянно');
});

test('выбор ссылки: только того же сайта, осмысленные, не вход и не покупка', () => {
  const link = (href, text, extra = {}) => ({ href, text, target: '', ...extra });
  const origin = 'https://a.test/news/1';
  const links = [
    link('https://a.test/news/2', 'Другая интересная новость дня'),
    link('https://other.test/x', 'Ссылка на чужой сайт длинная'),
    link('https://a.test/login', 'Войти в личный кабинет сайта'),
    link('https://a.test/cart', 'Корзина покупок и оформление'),
    link('https://a.test/news/3', 'Коротко'),
    link('https://a.test/news/4', 'Ссылка в новой вкладке длинная', { target: '_blank' }),
    link('https://a.test/news/1#comments', 'Комментарии к этой же странице'),
    link('mailto:x@a.test', 'Написать нам письмо на почту'),
    link('https://a.test/subscribe', 'Подпишитесь на нашу рассылку'),
  ];
  const picked = new Set(runs(100, (r) => pickLink(links, origin, r).href));
  assert.deepEqual([...picked], ['https://a.test/news/2']);
  assert.equal(pickLink(links.slice(1), origin, seeded(1)), null);
  assert.equal(pickLink([], origin, seeded(1)), null);
});

test('выбор ссылки на видео: по шаблону адреса', () => {
  const links = [
    { href: 'https://c.test/about', text: 'О проекте и команде сервиса', target: '' },
    { href: 'https://c.test/watch?v=abc', text: 'Как устроен браузер изнутри', target: '' },
  ];
  assert.equal(pickLink(links, 'https://c.test/', seeded(1), { include: /\/watch\?v=/ }).href, 'https://c.test/watch?v=abc');
});

test('планировщик решает, что делать сейчас', () => {
  const state = { day: '2026-10-05', starts: [DAY + 10 * H, DAY + 15 * H, DAY + 20 * H], done: [DAY + 10 * H], pausedUntil: 0 };
  const cases = [
    ['новый день: перепланировать', { ...state, day: '2026-10-04' }, DAY + 12 * H, { type: 'replan' }],
    ['нет состояния: перепланировать', null, DAY + 12 * H, { type: 'replan' }],
    ['до следующего старта ждём', state, DAY + 12 * H, { type: 'wait', until: DAY + 15 * H }],
    ['время пришло', state, DAY + 15 * H + 5 * MIN, { type: 'run', start: DAY + 15 * H }],
    ['опоздали больше допустимого: пропуск', state, DAY + 15 * H + 100 * MIN, { type: 'skip', start: DAY + 15 * H }],
    ['пауза после блока сильнее старта', { ...state, pausedUntil: DAY + 16 * H }, DAY + 15 * H + 5 * MIN, { type: 'wait', until: DAY + 16 * H }],
    ['всё на сегодня сделано: ждём новых суток', { ...state, done: state.starts }, DAY + 21 * H, { type: 'wait', until: DAY + 24 * H }],
  ];
  for (const [name, st, now, want] of cases) assert.deepEqual(nextAction(st, now, CFG), want, name);
});

test('старт ставится так, чтобы сессия с запасом на перерасход (×1,25 и паузы между сайтами) кончилась до конца окна', () => {
  const worst = 14 * MIN * 1.25 + 4 * 12000; // самая длинная сессия по конфигу, дошедшая до срока
  for (const s of runs(300, (r) => planDay(DAY, CFG, r))) {
    for (const t of s) assert.ok(t + worst <= DAY + 23 * H, `старт ${new Date(t).toISOString()}: срок сессии за окном`);
  }
});

test('срок сессии: сумма бюджетов с запасом и паузами между сайтами', () => {
  const steps = [{ budgetMs: 60000 }, { budgetMs: 40000 }];
  assert.equal(deadlineOf(steps), 100000 * 1.25 + 2 * 12000);
});

test('переходов по ссылкам в чтении от 0 до 3, глубокие встречаются реже мелких', () => {
  const reads = runs(800, (r) => planSession(CFG, r)).flat().filter((x) => x.kind === 'read');
  const count = (n) => reads.filter((x) => x.follow === n).length;
  assert.ok(reads.every((x) => x.follow >= 0 && x.follow <= 3), 'вышло за 0–3');
  assert.ok(count(3) > 0, 'трёх переходов подряд не бывает');
  assert.ok(count(0) > count(1) && count(1) > count(2) && count(2) > count(3), [0, 1, 2, 3].map(count).join(' / '));
});

test('выбор ссылки по зоне: меню, содержимое; подвал не берётся', () => {
  const l = (href, text, zone) => ({ href, raw: new URL(href).pathname, text, target: '', zone });
  const links = [
    l('https://a.test/menu1', 'Раздел сайта про новости', 'nav'),
    l('https://a.test/story1', 'Статья про интересные вещи', 'content'),
    l('https://a.test/privacy', 'Политика конфиденциальности сайта', 'footer'),
    l('https://a.test/nozone', 'Ссылка без указания зоны', undefined),
  ];
  const picks = (opts) => new Set(runs(200, (r) => pickLink(links, 'https://a.test/', r, opts).href));
  assert.deepEqual([...picks({ zone: 'nav' })], ['https://a.test/menu1']);
  assert.deepEqual([...picks({ zone: 'content' })].sort(), ['https://a.test/nozone', 'https://a.test/story1']);
  assert.deepEqual([...picks({})].sort(), ['https://a.test/menu1', 'https://a.test/nozone', 'https://a.test/story1']);
  assert.equal(pickLink([links[2]], 'https://a.test/', seeded(1)), null, 'ссылка из подвала выбрана');
});

test('шаг поиска получает один из запросов сайта, остальные виды запроса не имеют', () => {
  const cfg = { ...CFG, sites: [
    { url: 'https://wiki.test/', kind: 'search', weight: 3, queries: ['Алматы', 'Docker', 'Шахматы'] },
    { url: 'https://a.test/', kind: 'read', weight: 3 },
  ] };
  const steps = runs(300, (r) => planSession(cfg, r)).flat();
  const search = steps.filter((x) => x.kind === 'search'), other = steps.filter((x) => x.kind !== 'search');
  assert.ok(search.length > 50 && other.length > 50);
  assert.ok(search.every((x) => ['Алматы', 'Docker', 'Шахматы'].includes(x.query)), 'запрос не из списка');
  assert.equal(new Set(search.map((x) => x.query)).size, 3, 'всегда один и тот же запрос');
  assert.ok(other.every((x) => x.query === undefined));
  assert.ok(search.every((x) => x.follow >= 0 && x.follow <= 3));
});

test('неделя считается по Алматы с понедельника: семь дат и номер по ISO', () => {
  const week = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'];
  assert.deepEqual(weekDays(Date.UTC(2026, 9, 7, 12), TZ), week); // среда
  assert.deepEqual(weekDays(Date.UTC(2026, 9, 5, 0), TZ), week);  // понедельник 05:00 в Алматы
  assert.deepEqual(weekDays(Date.UTC(2026, 9, 11, 18), TZ), week); // воскресенье 23:00 в Алматы
  assert.equal(weekDays(Date.UTC(2026, 9, 11, 20), TZ)[0], '2026-10-12', '01:00 понедельника по Алматы уже новая неделя, хотя по UTC ещё воскресенье');
  assert.equal(weekId(Date.UTC(2026, 9, 7, 12), TZ), '2026-W41');
  assert.equal(weekId(Date.UTC(2026, 9, 11, 20), TZ), '2026-W42');
  assert.equal(weekId(Date.UTC(2026, 0, 1, 12), TZ), '2026-W01'); // четверг 1 января
  assert.equal(weekId(Date.UTC(2027, 0, 1, 12), TZ), '2026-W53', '1 января 2027 (пятница) ещё в 53-й неделе 2026');
});

test('план недели: от daysPerWeek[0] до [1] разных дней этой недели, по порядку, одинаково при том же seed', () => {
  const cfg = { ...CFG, daysPerWeek: [3, 4] };
  const week = weekDays(Date.UTC(2026, 9, 7, 12), TZ);
  const counts = new Set();
  for (const w of runs(200, (r) => planWeek(Date.UTC(2026, 9, 7, 12), cfg, r))) {
    assert.equal(w.id, '2026-W41');
    assert.ok(w.days.length >= 3 && w.days.length <= 4, `${w.days.length} дней`);
    assert.equal(new Set(w.days).size, w.days.length, 'повтор дня');
    assert.ok(w.days.every((d) => week.includes(d)), 'день не из этой недели');
    assert.deepEqual(w.days, [...w.days].sort());
    counts.add(w.days.length);
  }
  assert.deepEqual([...counts].sort(), [3, 4], 'число дней не меняется');
  assert.deepEqual(planWeek(0, cfg, seeded(5)), planWeek(0, cfg, seeded(5)));
  assert.notDeepEqual(planWeek(0, cfg, seeded(5)), planWeek(0, cfg, seeded(6)));
  assert.equal(new Set(runs(200, (r) => planWeek(0, cfg, r).days.join())).size > 10, true, 'недели одинаковы');
});

test('daysPerWeek [7,7] — каждый день, как раньше', () => {
  assert.deepEqual(planWeek(Date.UTC(2026, 9, 7, 12), { ...CFG, daysPerWeek: [7, 7] }, seeded(1)).days, weekDays(Date.UTC(2026, 9, 7, 12), TZ));
});
