/**
 * Раздельный бюджет площадки: чтения и записи (readsPerHour, readsPerDay в sites.json). С ними задача стартует слотом
 * чтения, а первая команда записи берёт слот записи (perHour и perDay) до своего выполнения; без readsPerHour — ровно
 * как раньше (perHour на все задачи, perDay на записи, readOnly). Сначала чистые функции limits.js с подставным
 * временем, потом настоящие задачи в Chromium: чтения не тратят записи, отказ записи не доходит до страницы, дневные
 * потолки, четыре процесса под state.lock, dryRun, peek с обоими бюджетами, прежнее поведение без readsPerHour.
 *
 *   node test/budgets.test.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const limits = require('../limits.js');
const { LimitReached } = limits;

const H = 3600e3;
const at = (h, m = 0, d = 8) => new Date(2026, 10, d, h, m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meatsuit-budgets-'));

  // 1. Правило: readsPerHour и readsPerDay — числа ≥ 0; readsPerDay без readsPerHour — ошибка, а не молча мимо.
  assert.equal(limits.readBudget({ perDay: 1, perHour: 2 }), null, 'без readsPerHour бюджет один, как раньше');
  assert.equal(limits.readBudget(undefined), null);
  assert.deepEqual(limits.readBudget({ readsPerHour: 3, readsPerDay: 5 }), { perHour: 3, perDay: 5 });
  assert.deepEqual(limits.readBudget({ readsPerHour: 30 }), { perHour: 30, perDay: null });
  for (const bad of [{ readsPerHour: -1 }, { readsPerHour: '30' }, { readsPerHour: Infinity }, { readsPerDay: 5 }, { readsPerHour: 3, readsPerDay: NaN }]) {
    assert.throws(() => limits.readBudget(bad), (e) => !(e instanceof LimitReached) && /readsPer/.test(e.message), JSON.stringify(bad));
  }

  // 2. Старт — слот чтения: perHour записей он не тратит. Чтения кончились — LimitReached с budget 'read' и freeAt
  // (когда освободится). Запись — свой бюджет perHour и perDay, отказ — budget 'write'. Слот чтения после записи не
  // возвращается: чтение было.
  const SPLIT = { readsPerHour: 3, readsPerDay: 5, perHour: 1, perDay: 2, hours: '9-23' };
  const fs1 = path.join(tmp, 'split.json');
  const t0 = at(12);
  const min = (n) => new Date(+t0 + n * 60e3);
  for (let i = 0; i < 3; i++) limits.reserve('s', SPLIT, fs1, min(i));
  assert.equal(read(fs1)['read:s'].length, 3);
  assert.equal((read(fs1).s || []).length, 0, 'чтение потратило запись');
  assert.throws(() => limits.reserve('s', SPLIT, fs1, min(3)),
    (e) => e instanceof LimitReached && e.budget === 'read' && e.message === 's: исчерпан лимит чтений на час (3)' && e.freeAt === +t0 + H);
  assert.throws(() => limits.reserve('s', SPLIT, fs1, min(3), { readOnly: true }), /чтений на час/, 'readOnly при раздельном бюджете — то же чтение');
  limits.chargeWrite('s', SPLIT, fs1, min(3));
  assert.deepEqual(read(fs1).s, [+min(3)]);
  assert.equal(read(fs1)['read:s'].length, 3, 'слот чтения вернули после записи');
  assert.throws(() => limits.chargeWrite('s', SPLIT, fs1, min(4)),
    (e) => e instanceof LimitReached && e.budget === 'write' && e.message === 's: исчерпан лимит записей на час (1)' && e.freeAt === +min(3) + H);
  limits.chargeWrite('s', SPLIT, fs1, new Date(+min(3) + H)); // через час — снова можно
  // Дневной потолок записей: freeAt — следующее открытие часов работы после полуночи (9:00 завтра).
  assert.throws(() => limits.chargeWrite('s', SPLIT, fs1, at(15)),
    (e) => e.budget === 'write' && e.message === 's: исчерпан лимит записей на сегодня (2)' && e.freeAt === +at(9, 0, 9));
  // Дневной потолок чтений: ещё два чтения в другие часы — пять за день, шестое — отказ до завтра.
  limits.reserve('s', SPLIT, fs1, at(14));
  limits.reserve('s', SPLIT, fs1, at(16));
  assert.throws(() => limits.reserve('s', SPLIT, fs1, at(18)),
    (e) => e.budget === 'read' && e.message === 's: исчерпан лимит чтений на сегодня (5)' && e.freeAt === +at(9, 0, 9));
  // Часы работы и perDay: 0 — для обоих видов, как раньше.
  assert.throws(() => limits.reserve('s2', SPLIT, path.join(tmp, 's2.json'), at(8)), (e) => e.budget === 'read' && /вне часов работы 9-23/.test(e.message) && e.freeAt === +at(9));
  assert.throws(() => limits.chargeWrite('s2', SPLIT, path.join(tmp, 's2.json'), at(23, 30)), (e) => e.budget === 'write' && /вне часов/.test(e.message) && e.freeAt === +at(9, 0, 9));
  assert.throws(() => limits.reserve('s3', { ...SPLIT, perDay: 0 }, path.join(tmp, 's3.json'), at(12)), (e) => /perDay 0/.test(e.message) && e.freeAt === null);
  assert.throws(() => limits.reserve('s4', { readsPerHour: 0 }, path.join(tmp, 's4.json'), at(12)), (e) => e.budget === 'read' && /чтений на час \(0\)/.test(e.message) && e.freeAt === null);
  assert.ok(!fs.existsSync(path.join(tmp, 's2.json')), 'отказ записал отметку');

  // status при раздельном бюджете: прежние поля (ok/reason — стартует ли задача, used*/left* — то, что считают perDay и
  // perHour, то есть записи) и два новых — reads и writes, у каждого ok, reason, used/left за час и день, freeAt.
  const fs5 = path.join(tmp, 'status.json');
  fs.writeFileSync(fs5, JSON.stringify({ q: [+at(11, 30)], 'read:q': [+at(11, 10), +at(11, 40), +at(11, 50)] }));
  assert.deepEqual(limits.status('q', SPLIT, fs5, at(12)), {
    ok: false, reason: 'q: исчерпан лимит чтений на час (3)', usedDay: 1, usedHour: 1, leftDay: 1, leftHour: 0,
    reads: { ok: false, reason: 'q: исчерпан лимит чтений на час (3)', usedHour: 3, usedDay: 3, leftHour: 0, leftDay: 2, freeAt: +at(12, 10) },
    writes: { ok: false, reason: 'q: исчерпан лимит записей на час (1)', usedHour: 1, usedDay: 1, leftHour: 0, leftDay: 1, freeAt: +at(12, 30) },
  });
  const later = limits.status('q', SPLIT, fs5, at(12, 45));
  assert.deepEqual([later.ok, later.reads.ok, later.reads.leftHour, later.reads.freeAt, later.writes.ok, later.writes.freeAt], [true, true, 2, null, true, null]);
  assert.deepEqual(limits.status('q', { readsPerHour: 30 }, fs5, at(12)).writes, { ok: true, reason: null, usedHour: 1, usedDay: 1, leftHour: null, leftDay: null, freeAt: null });

  // 3. Без readsPerHour — ровно как раньше: те же отметки в файле, тот же вид status (без reads и writes), те же тексты
  // и поля ошибок (без budget и freeAt). Так считает и cvs (outreach/apply-sites.json: perDay, perHour, hours, codeLogin).
  const LEGACY = { perDay: 2, perHour: 3, hours: '9-23', maxCommands: 40, maxMinutes: 10 };
  const fl = path.join(tmp, 'legacy.json');
  limits.reserve('l', LEGACY, fl, at(12)); // полный слот
  limits.reserve('l', LEGACY, fl, at(12, 5), { readOnly: true }); // чтение: только perHour
  limits.charge('l', LEGACY, fl, at(12, 5)); // запись в нём: слот полный задним числом
  assert.deepEqual(read(fl), { l: [+at(12), +at(12, 5)], 'read:l': [] });
  assert.deepEqual(limits.status('l', LEGACY, fl, at(12, 10)), { ok: false, reason: 'l: исчерпан лимит на сегодня (2)', usedDay: 2, usedHour: 2, leftDay: 0, leftHour: 1 });
  assert.throws(() => limits.reserve('l', LEGACY, fl, at(12, 10)), (e) => e instanceof LimitReached && e.message === 'l: исчерпан лимит на сегодня (2)' && !('budget' in e) && !('freeAt' in e));
  limits.reserve('l', LEGACY, fl, at(12, 10), { readOnly: true });
  assert.throws(() => limits.reserve('l', LEGACY, fl, at(12, 11), { readOnly: true }), (e) => e.message === 'l: исчерпан лимит на час (3)' && !('budget' in e));
  assert.throws(() => limits.chargeWrite('l', LEGACY, fl, at(12, 11)), (e) => !(e instanceof LimitReached) && /readsPerHour/.test(e.message), 'chargeWrite без раздельного бюджета — ошибка кода');

  // 4. Настоящие задачи. Страница пишет в заголовок, дошла ли клавиша или клик.
  const { chromium } = require('playwright-core');
  const { cdpPort } = require('./cdp-port.js');
  const { connect, peek } = require('../index.js');
  const sitesFile = path.join(tmp, 'sites.json');
  const BIG = { readsPerHour: 100, readsPerDay: 1000, perHour: 100, perDay: 1000 };
  fs.writeFileSync(sitesFile, JSON.stringify({
    'rw.test': { readsPerHour: 10, readsPerDay: 50, perHour: 1, perDay: 5 },
    'day.test': { readsPerHour: 10, readsPerDay: 2, perHour: 10, perDay: 1 },
    'legacy.test': { perDay: 3, perHour: 10 },
    ...Object.fromEntries(['p1.test', 'p2.test', 'p3.test', 'p4.test'].map((s) => [s, BIG])),
  }));
  const PAGE = '<title>чисто</title><textarea aria-label="Сообщение" onkeydown="document.title=\'клавиша\'"></textarea>'
    + '<button onclick="document.title=\'клик\'">Жми</button>';
  const ctx = await chromium.launchPersistentContext(path.join(tmp, 'profile'), { headless: true, args: ['--remote-debugging-port=0'] });
  const cdpUrl = `http://127.0.0.1:${await cdpPort(path.join(tmp, 'profile'))}`;
  await ctx.route(/\.test\//, (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE }));
  const state = path.join(tmp, 'state');
  const limitsFile = path.join(state, 'limits.json');
  const notes = [];
  const ms = await connect({ cdpUrl, dir: state, sitesFile, notify: async (text, event) => { notes.push({ text, event }); } });
  const count = (site) => { const all = fs.existsSync(limitsFile) ? read(limitsFile) : {}; return { reads: (all[`read:${site}`] || []).length, writes: (all[site] || []).length }; };
  const look = (site) => ms.task(`look-${site}`, async ({ see, act }) => { await act({ cmd: 'goto', url: `https://${site}/` }); return (await see()).title; }, { site });
  const write = (site, extra = {}) => ms.task(`write-${site}`, async ({ see, act }) => {
    await act({ cmd: 'goto', url: `https://${site}/` });
    const s = await see();
    const box = s.elements.find((e) => e.role === 'textbox');
    const f = await act({ cmd: 'fill', id: box.id, gen: s.gen, text: 'привет' }).then((r) => ({ r }), (e) => ({ e }));
    const fill = f.e || null;
    const cur = f.r && !f.r.dryRun ? f.r : s; // отказ записи снимок не меняет: номера прежние
    const btn = cur.elements.find((e) => e.role === 'button');
    const click = await act({ cmd: 'click', id: btn.id, gen: cur.gen }).then(() => null, (e) => e); // после отказа — повтор записи
    const after = await see();
    return { fill, click, title: after.title, value: after.elements.find((e) => e.role === 'textbox').value };
  }, { site, ...extra });

  try {
    // Чтения не тратят записи: три задачи только смотрят — три слота чтения, ноль записей; peek показывает оба бюджета.
    for (let i = 0; i < 3; i++) assert.equal(await look('rw.test'), 'чисто');
    assert.deepEqual(count('rw.test'), { reads: 3, writes: 0 });
    let st = peek('rw.test', { sitesFile, dir: state });
    assert.deepEqual([st.ok, st.reads.leftHour, st.reads.leftDay, st.writes.leftHour, st.writes.leftDay, st.writes.ok], [true, 7, 47, 1, 5, true]);
    assert.equal(st.leftHour, 1, 'leftHour — по perHour, а он теперь только про записи');
    // Задача с записью: слот чтения на старте, слот записи — на первой команде записи (один за задачу).
    const w1 = await write('rw.test');
    assert.deepEqual([w1.fill, w1.click, w1.title, w1.value], [null, null, 'клик', 'привет']);
    assert.deepEqual(count('rw.test'), { reads: 4, writes: 1 }, 'запись стоила один слот записи, слот чтения остался');
    // Записи на час кончились: следующая задача стартует (чтения есть), а запись — LimitReached до команды (before,
    // budget 'write', freeAt), и до страницы не дошло ничего — ни клавиша, ни клик при повторе. Читать можно дальше.
    notes.length = 0;
    const w2 = await write('rw.test');
    assert.ok(w2.fill instanceof LimitReached && w2.fill.before === true && w2.fill.budget === 'write'
      && w2.fill.message === 'rw.test: исчерпан лимит записей на час (1)' && w2.fill.freeAt > Date.now() + 50 * 60e3, String(w2.fill));
    assert.ok(w2.click instanceof LimitReached && w2.click.budget === 'write', `повтор записи после отказа прошёл: ${w2.click}`);
    assert.deepEqual([w2.title, w2.value], ['чисто', ''], 'отказанная запись дошла до страницы');
    assert.deepEqual(count('rw.test'), { reads: 5, writes: 1 });
    assert.ok(notes.some((n) => n.event === 'limit' && /write-rw\.test.*запись не выполнена.*записей на час/.test(n.text)), JSON.stringify(notes));
    st = peek('rw.test', { sitesFile, dir: state });
    assert.deepEqual([st.ok, st.writes.ok, st.writes.leftHour], [true, false, 0]);
    assert.equal(st.writes.freeAt, w2.fill.freeAt);
    // dryRun не тратит ничего, даже с командой записи.
    const before = fs.readFileSync(limitsFile, 'utf8');
    const dry = await write('rw.test', { dryRun: true });
    assert.deepEqual([dry.fill, dry.click], [null, null]);
    assert.equal(fs.readFileSync(limitsFile, 'utf8'), before, 'dryRun потратил слот');

    // Дневные потолки: readsPerDay 2 и perDay 1. Первая задача пишет; вторая читает, но запись — отказ «на сегодня»;
    // третья не стартует (чтения дня кончились): LimitReached с budget 'read', окна нет, notify 'limit'.
    const d1 = await write('day.test');
    assert.equal(d1.fill, null);
    const d2 = await write('day.test');
    assert.ok(d2.fill instanceof LimitReached && d2.fill.budget === 'write' && /записей на сегодня \(1\)/.test(d2.fill.message), String(d2.fill));
    assert.equal(d2.title, 'чисто');
    const pages = ctx.pages().length;
    notes.length = 0;
    await assert.rejects(look('day.test'), (e) => e instanceof LimitReached && e.budget === 'read' && /чтений на сегодня \(2\)/.test(e.message) && e.before === undefined);
    assert.equal(ctx.pages().length, pages, 'окно открылось без слота чтения');
    assert.ok(notes.some((n) => n.event === 'limit' && /не запущена/.test(n.text)), JSON.stringify(notes));
    assert.deepEqual(count('day.test'), { reads: 2, writes: 1 });

    // Без readsPerHour — как раньше: задача без readOnly тратит полный слот на старте, readOnly — чтение, запись в нём —
    // слот полный задним числом; peek того же вида, что раньше (без reads и writes).
    await look('legacy.test');
    assert.deepEqual(count('legacy.test'), { reads: 0, writes: 1 });
    await ms.task('legacy-ro', async ({ see, act }) => { await act({ cmd: 'goto', url: 'https://legacy.test/' }); await see(); }, { site: 'legacy.test', readOnly: true });
    assert.deepEqual(count('legacy.test'), { reads: 1, writes: 1 });
    const lw = await write('legacy.test', { readOnly: true });
    assert.equal(lw.fill, null);
    assert.deepEqual(count('legacy.test'), { reads: 1, writes: 2 }, 'readOnly с записью: слот чтения стал полным');
    assert.deepEqual(Object.keys(peek('legacy.test', { sitesFile, dir: state })), ['site', 'rule', 'ok', 'reason', 'usedDay', 'usedHour', 'leftDay', 'leftHour']);

    // Образец sites.example.json: площадка с раздельным бюджетом (значения владельца для чата знакомств) читается peek.
    const ex = peek('chat.example.net', { sitesFile: path.join(__dirname, '..', 'sites.example.json'), dir: path.join(tmp, 'empty') });
    assert.deepEqual([ex.reads.leftHour, ex.reads.leftDay, ex.writes.leftHour, ex.writes.leftDay], [30, 250, 6, 20]);
    await ms.close();

    // Четыре процесса пишут чтения и записи своих площадок в один limits.json одновременно: ни одна отметка не теряется
    // (state.lock). Три круга: гонка без замка ловится не каждый раз.
    const child = path.join(tmp, 'child.js');
    fs.writeFileSync(child, `const { connect } = require(${JSON.stringify(path.join(__dirname, '..', 'index.js'))});
const [cdpUrl, dir, sitesFile, site] = process.argv.slice(2);
(async () => {
  const ms = await connect({ cdpUrl, dir, sitesFile });
  await ms.task('child-' + site, async ({ see, act }) => {
    await act({ cmd: 'goto', url: 'https://' + site + '/' });
    const s = await see();
    await act({ cmd: 'click', id: s.elements.find((e) => e.role === 'button').id, gen: s.gen });
  }, { site });
  await ms.close();
})().catch((e) => { console.error(e); process.exit(1); });
`);
    const four = ['p1.test', 'p2.test', 'p3.test', 'p4.test'];
    for (let round = 1; round <= 3; round++) {
      await Promise.all(four.map((site) => new Promise((resolve, reject) => {
        const p = spawn(process.execPath, [child, cdpUrl, state, sitesFile, site], { stdio: ['ignore', 'ignore', 'pipe'] });
        let err = '';
        p.stderr.on('data', (d) => { err += d; });
        p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${site}: код ${code}: ${err}`))));
      })));
      for (const site of four) assert.deepEqual(count(site), { reads: round, writes: round }, `${site}, круг ${round}: отметка потерялась`);
    }
    assert.deepEqual(count('rw.test'), { reads: 5, writes: 1 }, 'чужие счётчики изменились');
    await sleep(100);
  } finally { await ctx.close(); }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('budgets.test: ok');
})().catch((e) => { console.error(e); process.exit(1); });
