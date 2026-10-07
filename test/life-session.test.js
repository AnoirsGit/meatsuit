/**
 * Сессия прогрева: как бот читает сайты. Страница и пробы (что на странице)
 * подставлены; руки настоящие, время виртуальное.
 *
 *   node --test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { seeded } = require('../human/random.js');
const { fakePage } = require('../testkit/fakepage.js');
const { runSession, Blocked } = require('../life/session.js');

const okSnapshot = (p) => ({ url: p.url(), title: 'Страница', text: 'слово '.repeat(900), captchaFrame: false });
const mkProbe = (over = {}) => ({
  snapshot: async (p) => okSnapshot(p),
  metrics: async () => ({ textLen: 30000, height: 6000, scrollY: 0, innerH: 720 }),
  links: async () => [],
  settle: async () => {},
  ...over,
});
const read = (url, budgetMs = 60000, follow = 0) => ({ url, kind: 'read', budgetMs, follow });
const gotos = (log) => log.filter((e) => e.op === 'goto').map((e) => e.url);
const story = (href, text = 'Интересная история на тему дня') => {
  const u = new URL(href);
  const raw = u.hostname === 'a.test' || u.hostname === 'c.test' ? u.pathname + u.search : href; // как в разметке: свои ссылки относительные
  return { href, raw, text, target: '', x: 100, y: 300, w: 200, h: 20 };
};

test('чтение: заходит, крутит колесом и остаётся около бюджета времени', async () => {
  const { page, env, log, clock } = fakePage();
  const journal = [];
  await runSession(page, [read('https://a.test/')], { env, probe: mkProbe(), log: (e) => journal.push(e) });

  assert.deepEqual(gotos(log), ['https://a.test/']);
  assert.ok(log.filter((e) => e.op === 'wheel').length >= 3, 'не прокручивал страницу');
  assert.ok(clock.t >= 45000 && clock.t <= 90000, `на сайте ${clock.t} мс при бюджете 60000`);
  const step = journal.find((e) => e.event === 'step');
  assert.deepEqual([step.url, step.kind, step.result], ['https://a.test/', 'read', 'ok']);
  assert.ok(step.ms >= 45000, 'в журнале нет времени');
});

test('короткая страница: не сидит весь бюджет', async () => {
  const { page, env, clock } = fakePage();
  const probe = mkProbe({ metrics: async () => ({ textLen: 400, height: 600, scrollY: 0, innerH: 720 }) });
  await runSession(page, [read('https://a.test/', 120000)], { env, probe, log: () => {} });
  assert.ok(clock.t < 45000, `на короткой странице ${clock.t} мс из 120000`);
});

test('идёт по ссылке своего сайта и не уходит на чужие', async () => {
  const links = [story('https://a.test/story-1'), story('https://other.test/x', 'Чужая ссылка очень длинная')];
  const { page, env, log, state } = fakePage({ anchors: links });
  const probe = mkProbe({ links: async () => links });
  await runSession(page, [read('https://a.test/', 60000, 1)], { env, probe, log: () => {} });

  assert.ok(state.visited.includes('https://a.test/story-1'), 'не пошёл по ссылке');
  assert.ok(state.visited.every((u) => new URL(u).hostname === 'a.test'), `ушёл с сайта: ${state.visited}`);
  assert.ok(log.some((e) => e.op === 'down') && log.some((e) => e.op === 'up'), 'ссылка не кликнута мышью');
});

test('ссылок на экране нет: возвращается вверх и находит их там', async () => {
  const links = [story('https://a.test/story-1')];
  const { page, env, log, state } = fakePage({ anchors: links });
  let calls = 0;
  const probe = mkProbe({ links: async () => (++calls < 2 ? [] : links) });
  await runSession(page, [read('https://a.test/', 40000, 1)], { env, probe, log: () => {} });

  assert.ok(state.visited.includes('https://a.test/story-1'), 'не нашёл ссылку после возврата вверх');
  assert.ok(log.some((e) => e.op === 'wheel' && e.dy < 0), 'не вернулся наверх колесом');
});

test('ссылок нет совсем: ищет не вечно и идёт дальше', async () => {
  const { page, env, log } = fakePage();
  const journal = [];
  await runSession(page, [read('https://a.test/', 40000, 2), read('https://b.test/', 20000)], { env, probe: mkProbe(), log: (e) => journal.push(e) });
  assert.deepEqual(journal.filter((e) => e.event === 'step').map((e) => e.result), ['ok', 'ok']);
  assert.ok(log.filter((e) => e.op === 'wheel' && e.dy < 0).length <= 250, 'бесконечно ищет ссылки');
});

// ---------------------------------------------------------------- всплывающее

const CLOSE_BTN = { ref: 1, name: 'Закрыть', corner: false, x: 700, y: 210, w: 40, h: 30 };
const popupOverlay = (buttons = [CLOSE_BTN], kind = 'dialog') => ({ kind, text: 'Подпишитесь на рассылку', x: 300, y: 200, w: 500, h: 300, buttons });
/** probe.overlays по номеру вызова: calls[i] — ответ на i-й вызов, дальше последний. */
const overlayProbe = (calls, over = {}) => {
  let i = 0;
  return mkProbe({
    overlays: async (p) => (typeof calls === 'function' ? calls(p, i++) : calls[Math.min(i++, calls.length - 1)]),
    boxOf: async (_p, ref) => { for (const o of [].concat(...[].concat(calls).filter(Array.isArray))) for (const b of o.buttons) if (b.ref === ref) return { x: b.x, y: b.y, width: b.w, height: b.h }; return { x: 700, y: 210, width: 40, height: 30 }; },
    ...over,
  });
};

test('всплывающее после открытия сайта закрывается до чтения', async () => {
  const { page, env, log } = fakePage();
  const journal = [];
  await runSession(page, [read('https://a.test/', 30000)], { env, probe: overlayProbe([[popupOverlay()], []]), log: (e) => journal.push(e) });
  assert.ok(journal.some((e) => e.event === 'overlay' && e.result === 'closed'), 'закрытие не записано');
  const click = log.findIndex((e) => e.op === 'down'), wheel = log.findIndex((e) => e.op === 'wheel');
  assert.ok(click >= 0, 'не кликнул по кнопке закрытия');
  assert.ok(wheel === -1 || click < wheel, 'читал под всплывающим, а закрыл после');
});

test('всплывающее, которое нечем закрыть: сайт пропущен, сессия идёт дальше', async () => {
  const stuck = [popupOverlay([{ ref: 5, name: 'Subscribe', corner: false, x: 10, y: 10, w: 80, h: 30 }])];
  const probe = overlayProbe((p) => (p.url() === 'https://a.test/' ? stuck : []));
  const { page, env, log } = fakePage();
  const journal = [];
  await runSession(page, [read('https://a.test/', 20000), read('https://b.test/', 20000)], { env, probe, log: (e) => journal.push(e) });
  assert.deepEqual(journal.filter((e) => e.event === 'step').map((e) => [e.url, e.result, e.reason]),
    [['https://a.test/', 'skipped', 'всплывающее не закрылось'], ['https://b.test/', 'ok', undefined]]);
  assert.ok(!log.some((e) => e.op === 'down'), 'нажал кнопку «Subscribe» (или что-то ещё): на этих страницах кликать было нечего');
});

test('баннер, появившийся посреди чтения, закрывается на следующем проходе', async () => {
  const { page, env } = fakePage();
  const journal = [];
  const probe = overlayProbe((_p, i) => (i === 3 ? [popupOverlay()] : []));
  await runSession(page, [read('https://a.test/', 90000)], { env, probe, log: (e) => journal.push(e) });
  assert.equal(journal.filter((e) => e.event === 'overlay' && e.result === 'closed').length, 1);
});

test('политика cookies берётся из настроек сессии', async () => {
  const reject = { ref: 1, name: 'Отклонить', corner: false, x: 100, y: 500, w: 90, h: 32 };
  const accept = { ref: 2, name: 'Принять', corner: false, x: 600, y: 500, w: 90, h: 32 };
  for (const [consent, want] of [['reject', reject], ['accept', accept]]) {
    const { page, env, log } = fakePage();
    await runSession(page, [read('https://a.test/', 20000)], { env, consent, probe: overlayProbe([[popupOverlay([accept, reject], 'consent')], []]), log: () => {} });
    const down = log.find((e) => e.op === 'down');
    const m = log.filter((e) => e.op === 'move' && e.t <= down.t).pop();
    assert.ok(m.x >= want.x && m.x <= want.x + want.w, `${consent}: клик в x=${m.x}`);
  }
});

test('лишняя вкладка и системный диалог за время сессии закрываются сами', async () => {
  const { page, env } = fakePage();
  await runSession(page, [read('https://a.test/', 20000)], { env, probe: mkProbe(), log: () => {} });
  let closed = false;
  await page.emit('popup', { close: async () => { closed = true; } });
  assert.equal(closed, true);
});

// ---------------------------------------------------------------- маршруты и мелочи

test('мелочи за чтением: при wander=1 бывают и записываются, при wander=0 нет', async () => {
  const links = [story('https://a.test/story-1'), story('https://a.test/story-2', 'Ещё одна история на сегодня')];
  for (const [wander, expect] of [[1, true], [0, false]]) {
    const { page, env } = fakePage({ anchors: links });
    const journal = [];
    await runSession(page, [read('https://a.test/', 90000)], { env, probe: mkProbe({ links: async () => links }), log: (e) => journal.push(e), wander });
    const seen = journal.filter((e) => e.event === 'wander');
    assert.equal(seen.length > 0, expect, `wander=${wander}: ${seen.length} мелочей`);
    if (expect) assert.ok(seen.every((e) => ['scrollUp', 'idle', 'hover', 'away'].includes(e.reason)));
  }
});

test('переход идёт то по меню, то по содержимому; нет меню — по содержимому, нет содержимого — по меню', async () => {
  const nav = { ...story('https://a.test/menu-1', 'Раздел сайта про новости'), zone: 'nav' };
  const content = { ...story('https://a.test/story-1'), zone: 'content' };
  const zones = async (links, seeds) => {
    const out = [];
    for (let seed = 1; seed <= seeds; seed++) {
      const { page, env } = fakePage({ anchors: links });
      const journal = [];
      await runSession(page, [read('https://a.test/', 40000, 1)], { env: { ...env, rnd: seeded(seed) }, probe: mkProbe({ links: async () => links }), log: (e) => journal.push(e), wander: 0 });
      out.push(...journal.filter((e) => e.event === 'follow').map((e) => e.zone));
    }
    return out;
  };
  const both = await zones([nav, content], 80);
  const share = both.filter((z) => z === 'nav').length / both.length;
  assert.ok(share > 0.1 && share < 0.45, `по меню ${(share * 100).toFixed(0)}% из ${both.length}`);
  assert.ok(new Set(await zones([content], 10)).size === 1 && (await zones([content], 10))[0] === 'content');
  assert.deepEqual([...new Set(await zones([nav], 10))], ['nav']);
});

test('после перехода иногда остаётся и идёт дальше, иногда назад, иногда на два шага назад', async () => {
  const links = [story('https://a.test/story-1'), story('https://a.test/story-2', 'Ещё одна история на сегодня')];
  const perRun = [];
  for (let seed = 1; seed <= 120; seed++) {
    const { page, env, log } = fakePage({ anchors: links });
    await runSession(page, [read('https://a.test/', 40000, 1)], { env: { ...env, rnd: seeded(seed) }, probe: mkProbe({ links: async () => links }), log: () => {}, wander: 0 });
    perRun.push(log.filter((e) => e.op === 'back').length);
  }
  const n = (k) => perRun.filter((x) => x === k).length;
  assert.ok(n(0) > 20 && n(1) > 20 && n(2) > 3, `назад: 0×${n(0)}, 1×${n(1)}, 2×${n(2)}`);
  assert.ok(perRun.every((x) => x <= 2), 'больше двух шагов назад');
});

// ---------------------------------------------------------------- поиск

/** Что окажется в поле, если проиграть нажатия: буквы добавляют, Backspace стирает, Shift и Enter не пишут. */
const typedText = (log) => log.filter((e) => e.op === 'kdown').reduce((t, e) => (e.k === 'Backspace' ? t.slice(0, -1) : e.k.length === 1 ? t + e.k : t), '');
const SEARCH_BOX = { ref: 77, name: 'Поиск', x: 400, y: 40, w: 300, h: 32 };
const searchStep = (url, query, follow = 0, budgetMs = 40000) => ({ url, kind: 'search', query, follow, budgetMs });

test('поиск: находит поле, печатает запрос клавишами и жмёт Enter, потом читает результаты', async () => {
  const { page, env, log } = fakePage();
  const journal = [];
  const probe = mkProbe({ searchBox: async () => SEARCH_BOX, boxOf: async () => ({ x: 400, y: 40, width: 300, height: 32 }) });
  await runSession(page, [searchStep('https://wiki.test/', 'docker')], { env, probe, log: (e) => journal.push(e), wander: 0 });

  assert.equal(typedText(log), 'docker', 'в поле напечатано не то');
  const keys = log.filter((e) => e.op === 'kdown').map((e) => e.k);
  assert.equal(keys[keys.length - 1], 'Enter', 'после запроса не нажат Enter');
  const down = log.find((e) => e.op === 'down'), firstKey = log.find((e) => e.op === 'kdown');
  assert.ok(down && down.t < firstKey.t, 'печатал до клика в поле');
  assert.deepEqual(journal.filter((e) => e.event === 'step').map((e) => [e.kind, e.result]), [['search', 'ok']]);
  assert.ok(journal.some((e) => e.event === 'search' && e.reason === 'docker'), 'запрос не записан в журнал');
});

test('поиск: поля нет — сайт пропущен с понятной причиной, ничего не набрано', async () => {
  const { page, env, log } = fakePage();
  const journal = [];
  await runSession(page, [searchStep('https://wiki.test/', 'docker')], { env, probe: mkProbe({ searchBox: async () => null }), log: (e) => journal.push(e), wander: 0 });
  assert.deepEqual(journal.filter((e) => e.event === 'step').map((e) => [e.result, e.reason]), [['skipped', 'нет поля поиска']]);
  assert.ok(!log.some((e) => e.op === 'kdown'));
});

test('поиск: кириллический запрос идёт настоящими клавишами раскладки, поле получает его целиком', async () => {
  const { page, env, log } = fakePage();
  const probe = mkProbe({ searchBox: async () => SEARCH_BOX, boxOf: async () => ({ x: 400, y: 40, width: 300, height: 32 }) });
  await runSession(page, [searchStep('https://wiki.test/', 'Шахматы')], { env, probe, log: () => {}, wander: 0 });
  const cdp = log.filter((e) => e.op === 'cdp' && e.params.type === 'keyDown');
  const typed = cdp.reduce((t, e) => (e.params.key === 'Backspace' ? t.slice(0, -1) : e.params.text ? t + e.params.text : t), '');
  assert.ok(cdp.length >= 6, `клавиш кириллицы ${cdp.length}`);
  assert.ok(typed.length >= 6);
});

test('капча: сессия останавливается, дальше сайты не открываются', async () => {
  const { page, env, log } = fakePage();
  const probe = mkProbe({ snapshot: async (p) => ({ ...okSnapshot(p), captchaFrame: p.url() === 'https://b.test/' }) });
  const steps = [read('https://a.test/', 20000), read('https://b.test/', 20000), read('https://c.test/', 20000)];

  await assert.rejects(runSession(page, steps, { env, probe, log: () => {} }), (e) => e instanceof Blocked && e.reason === 'captcha');
  assert.deepEqual(gotos(log), ['https://a.test/', 'https://b.test/']);
});

test('сайт не открылся: пропускает и идёт дальше', async () => {
  const { page, env, log } = fakePage({ failGoto: ['https://a.test/'] });
  const journal = [];
  await runSession(page, [read('https://a.test/', 20000), read('https://b.test/', 20000)], { env, probe: mkProbe(), log: (e) => journal.push(e) });

  assert.deepEqual(gotos(log), ['https://a.test/', 'https://b.test/']);
  assert.deepEqual(journal.filter((e) => e.event === 'step').map((e) => [e.url, e.result]), [['https://a.test/', 'skipped'], ['https://b.test/', 'ok']]);
});

test('редирект на вход: сайт пропущен, сессия идёт дальше', async () => {
  const { page, env, log } = fakePage();
  const probe = mkProbe({ snapshot: async (p) => (p.url() === 'https://b.test/'
    ? { url: 'https://b.test/login', title: '', text: 'Войти', captchaFrame: false } : okSnapshot(p)) });
  const journal = [];
  await runSession(page, [read('https://b.test/', 20000), read('https://c.test/', 20000)], { env, probe, log: (e) => journal.push(e) });

  assert.deepEqual(gotos(log), ['https://b.test/', 'https://c.test/']);
  assert.equal(journal.find((e) => e.event === 'step').result, 'skipped');
});

test('видео: кликает по ролику и смотрит заданное время', async () => {
  const links = [story('https://c.test/watch?v=abc', 'Как устроен браузер изнутри и почему')];
  const { page, env, log, state, clock } = fakePage({ anchors: links });
  const probe = mkProbe({ links: async () => links });
  await runSession(page, [{ url: 'https://c.test/', kind: 'video', budgetMs: 120000, follow: 0 }], { env, probe, log: () => {} });

  assert.ok(state.visited.includes('https://c.test/watch?v=abc'), 'ролик не открыт');
  assert.ok(log.some((e) => e.op === 'down'), 'не кликнул');
  assert.ok(clock.t >= 95000 && clock.t <= 150000, `смотрел ${clock.t} мс при бюджете 120000`);
});

test('сессия заканчивается при любых случайных значениях: время не зацикливается', async () => {
  for (let seed = 1; seed <= 80; seed++) {
    const links = [story('https://a.test/story-1'), story('https://a.test/story-2', 'Ещё одна история на сегодня')];
    const { page, env, clock } = fakePage({ anchors: links });
    const probe = mkProbe({ links: async () => links });
    const budget = 25000 + seed * 913, journal = [];
    await runSession(page, [read('https://a.test/', budget, seed % 3)], { env: { ...env, rnd: seeded(seed) }, probe, log: (e) => journal.push(e) });
    assert.deepEqual(journal.filter((e) => e.event === 'step').map((e) => [e.result, e.reason]), [['ok', undefined]], `seed ${seed}`);
    assert.ok(clock.t >= 0.5 * budget && clock.t < 3 * budget + 30000, `seed ${seed}: ${clock.t} мс при бюджете ${budget}`);
  }
});

test('короткая страница при заданной персоне не зацикливается на остатке времени', async () => {
  const human = require('../human.js');
  human.usePersona({ speed: 1, tremor: 0.7, wpm: 55, twitch: 0.3 });
  try {
    const { page, env, clock } = fakePage();
    const probe = mkProbe({ metrics: async () => ({ textLen: 400, height: 600, scrollY: 0, innerH: 720 }) });
    const journal = [];
    await runSession(page, [read('https://a.test/', 120000)], { env, probe, log: (e) => journal.push(e) });
    assert.deepEqual(journal.map((e) => [e.result, e.reason]), [['ok', undefined]]);
    assert.ok(clock.t < 45000, `${clock.t} мс`);
  } finally { human.usePersona(null); }
});

test('видео без ссылок на ролики: не падает, просто выходит', async () => {
  const { page, env } = fakePage();
  const journal = [];
  await runSession(page, [{ url: 'https://c.test/', kind: 'video', budgetMs: 60000, follow: 0 }], { env, probe: mkProbe(), log: (e) => journal.push(e) });
  assert.equal(journal.find((e) => e.event === 'step').result, 'ok');
});

// Ссылки видны только после нескольких возвратов вверх: каждый поиск ссылки стоит прокрутки, которой в бюджете сайта нет.
const hiddenLinks = (links) => { let calls = 0; return async () => (++calls % 4 === 0 ? links : []); };

test('у сессии жёсткий срок: возвраты вверх за ссылками не растягивают её далеко за сумму бюджетов', async () => {
  const links = [story('https://a.test/story-1')];
  const steps = [1, 2, 3].map(() => read('https://a.test/', 40000, 2));
  const deadline = 120000 * 1.25 + 3 * 12000; // сумма бюджетов ×1,25 и паузы между сайтами
  for (let seed = 1; seed <= 20; seed++) {
    const { page, env, clock } = fakePage({ anchors: links });
    const probe = mkProbe({ links: hiddenLinks(links) });
    await runSession(page, steps, { env: { ...env, rnd: seeded(seed) }, probe, log: () => {} });
    assert.ok(clock.t <= deadline + 45000, `seed ${seed}: сессия ${clock.t} мс при сроке ${deadline}`); // 45 с — на действие, которое шло в момент срока
  }
});

test('срок вышел: новый сайт не открывается, сессия тихо кончается и сообщает об этом', async () => {
  const { page, env, log } = fakePage();
  const journal = [];
  const steps = [read('https://a.test/', 30000), read('https://b.test/', 30000), read('https://c.test/', 30000)];
  const out = await runSession(page, steps, { env, probe: mkProbe(), log: (e) => journal.push(e), deadlineMs: 20000 });

  assert.deepEqual(gotos(log), ['https://a.test/']);
  assert.deepEqual(journal.filter((e) => e.event === 'step').map((e) => e.result), ['ok']);
  assert.equal(out.cut, true);
});

test('срок не мешает обычной сессии: ничего не обрезано', async () => {
  const { page, env } = fakePage();
  const out = await runSession(page, [read('https://a.test/', 30000), read('https://b.test/', 30000)], { env, probe: mkProbe(), log: () => {} });
  assert.equal(out.cut, false);
});

test('срок ограничивает и просмотр ролика, и возврат вверх за ссылкой', async () => {
  const links = [story('https://c.test/watch?v=abc', 'Как устроен браузер изнутри и почему')];
  const video = fakePage({ anchors: links });
  await runSession(video.page, [{ url: 'https://c.test/', kind: 'video', budgetMs: 300000, follow: 0 }], { env: video.env, probe: mkProbe({ links: async () => links }), log: () => {}, deadlineMs: 60000 });
  assert.ok(video.clock.t < 60000 + 20000, `ролик смотрел ${video.clock.t} мс при сроке 60000`);

  const up = fakePage();
  const out = await runSession(up.page, [read('https://a.test/', 300000, 2)], { env: up.env, probe: mkProbe(), log: () => {}, deadlineMs: 10000 });
  assert.ok(up.clock.t < 10000 + 45000, `${up.clock.t} мс при сроке 10000`);
  assert.equal(out.cut, true);
});

test('ссылка с переводом строки, табуляцией или управляющим символом в href находится и кликается', async () => {
  // Как в разметке (raw) и как их отдаёт a.href (абсолютный адрес без пробельных символов).
  const raws = ['\n  /news/1\n', '\t/news/2', '/news/3\u0001x', '/news/4?q="b"&c=\\d', '  /news/5  ', '/news/6\f', '/\r\n7', '/news/8\u007f', '/news/ё9'];
  for (const raw of raws) {
    const link = { href: 'https://a.test/news/x', raw, text: 'Интересная история на тему дня', target: '', x: 100, y: 300, w: 200, h: 20 };
    const { page, env, state } = fakePage({ anchors: [link] });
    await runSession(page, [read('https://a.test/', 30000, 1)], { env, probe: mkProbe({ links: async () => [link] }), log: () => {} });
    assert.ok(state.visited.includes('https://a.test/news/x'), `не пошёл по ссылке с href ${JSON.stringify(raw)}`);
  }
});

test('фальшивая страница читает селектор по правилам CSS, а не JSON', () => {
  const { readCssString } = require('../testkit/fakepage.js');
  const read1 = (s) => readCssString(s).value;
  assert.equal(read1('"a\\a b"'), 'a\nb'); // \a и один пробел после него — перевод строки
  assert.equal(read1('"a\\9 b"'), 'a\tb');
  assert.equal(read1('"a\\1 b"'), 'a\u0001b');
  assert.equal(read1('"\\n\\t\\u0001"'), 'ntu0001'); // не перевод строки, не табуляция
  assert.equal(read1('"q=\\"b\\" \\\\"'), 'q="b" \\');
  assert.equal(read1('"a\\\nb"'), 'ab'); // обратный слэш и перевод строки — продолжение строки
  assert.equal(read1('"\\0 "'), '�');
  assert.throws(() => readCssString('"a\nb"'), /bad-string/);
  assert.throws(() => readCssString('"не закрыта'), /не закрыта/);
});
