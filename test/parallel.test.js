/**
 * Один браузер, несколько ботов сразу: очередь своя у площадки, руль хозяина общий.
 * Задачи разных площадок идут одновременно (в одном процессе и из двух процессов), задачи одной площадки и её
 * поддоменов — по одной; каждая работает в своей странице и чужую не трогает (печатают одновременно — каждая в своё
 * поле); руль хозяина (wheel.js) останавливает всех до входа и перед командой, время ожидания в бюджет не входит;
 * ownerPresent одного вызывающего останавливает и другого; замок площадки — свой: занятый держит только её,
 * брошенный забирается; счётчики limits.json общих площадок не теряются, когда задачи пишут их одновременно.
 * Настоящий Chromium с портом отладки, как у Neko.
 *
 *   node test/parallel.test.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const limits = require('../limits.js');

// Сроки очереди короче (30 минут тест ждать не может); подставить до того, как index.js возьмёт lock.
const LOCK = { timeoutMs: 8000 };
const realLock = limits.lock;
limits.lock = (file, o = {}) => realLock(file, { ...o, timeoutMs: Math.min(o.timeoutMs ?? Infinity, LOCK.timeoutMs), pollMs: 20 });
const { connect, LimitReached, BudgetExceeded, FieldMismatch } = require('../index.js');
const human = require('../human.js');
const { takeWheel, releaseWheel, wheelState, WHEEL } = require('../wheel.js');
const { HANG } = require('../supervise.js');
const { chromium } = require('playwright-core');
const { cdpPort } = require('./cdp-port.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const overlap = (x, y) => x.s < y.e && y.s < x.e;
const PAGE = (host) => `<title>${host}</title><textarea aria-label="Сообщение"></textarea>`
  + '<button onclick="document.title=\'нажато\'">Жми</button>';

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meatsuit-parallel-'));
  const state = path.join(tmp, 'state');
  const sitesFile = path.join(tmp, 'sites.json');
  const SITES = ['a.test', 'b.test', 'c.test', 'web.c.test', 'p1.test', 'p2.test', 'p3.test', 'p4.test', 'slow.test'];
  fs.writeFileSync(sitesFile, JSON.stringify({ ...Object.fromEntries(SITES.map((s) => [s, { perDay: 100 }])),
    'sa.test': { perDay: 100, singleTab: true }, 'sb.test': { perDay: 100, singleTab: true } }));

  const ctx = await chromium.launchPersistentContext(path.join(tmp, 'profile'), { headless: true, args: ['--remote-debugging-port=0'] });
  const PORT = await cdpPort(path.join(tmp, 'profile'));
  const cdpUrl = `http://127.0.0.1:${PORT}`;
  await ctx.route(/\.test\//, (r) => r.fulfill({ contentType: 'text/html', body: PAGE(new URL(r.request().url()).hostname) }));
  WHEEL.pollMs = 50;

  const notes = [];
  const ms = await connect({ cdpUrl, dir: state, sitesFile, notify: async (text, event) => { notes.push({ text, event }); } });
  const windows = () => ctx.pages().length;
  const base = windows();
  // Задача, которая просто занимает свою площадку ms миллисекунд: { name, s, e } — когда её функция шла.
  const spans = [];
  const span = (site, name, hold = 700, conn = ms) => conn.task(name, async () => {
    const s = Date.now();
    await sleep(hold);
    const out = { name, s, e: Date.now() };
    spans.push(out);
    return out;
  }, { site });

  try {
    // 1. Разные площадки — одновременно; одна площадка — по очереди; поддомен — та же очередь, что площадка.
    const [a, b] = await Promise.all([span('a.test', 'A'), span('b.test', 'B')]);
    assert.ok(overlap(a, b), `разные площадки должны идти одновременно: ${JSON.stringify([a, b])}`);
    const [a1, a2] = await Promise.all([span('a.test', 'A1'), span('a.test', 'A2')]);
    assert.ok(!overlap(a1, a2), `одна площадка — по одной: ${JSON.stringify([a1, a2])}`);
    const [c, wc] = await Promise.all([span('c.test', 'C'), span('web.c.test', 'WC')]);
    assert.ok(!overlap(c, wc), `web.c.test и c.test — одна очередь: ${JSON.stringify([c, wc])}`);
    assert.ok(fs.existsSync(path.join(state, 'queue')), 'замки площадок — в <dir>/queue/');
    assert.deepEqual(fs.readdirSync(path.join(state, 'queue')), [], 'после задач замков не осталось');
    assert.ok(!fs.existsSync(path.join(state, 'queue.lock')), 'замок всего браузера не создаётся');
    await sleep(300);
    assert.equal(windows(), base, 'окна задач закрыты');

    // 2. Каждая в своей странице. Вкладки площадок sa и sb (singleTab) открыты заранее, площадке a — своё окно;
    // три задачи одновременно печатают каждая в своё поле. Чужую вкладку никто не берёт и не трогает.
    const pa = await ctx.newPage(); await pa.goto('https://sa.test/');
    const pb = await ctx.newPage(); await pb.goto('https://sb.test/');
    await sleep(300); // соединение ядра узнаёт о новых адресах вкладок событием чуть позже
    const typeHere = (site, text, singleTab) => ms.task(`type-${site}`, async ({ see, act }) => {
      if (!singleTab) await act({ cmd: 'goto', url: `https://${site}/` });
      const s = await see();
      const box = s.elements.find((e) => e.role === 'textbox');
      const r = await act({ cmd: 'fill', id: box.id, gen: s.gen, text });
      return { url: (await see()).url, value: r.elements.find((e) => e.role === 'textbox').value };
    }, { site });
    const [ra, rb, rc] = await Promise.all([typeHere('sa.test', 'первая', true), typeHere('sb.test', 'вторая', true), typeHere('a.test', 'третья', false)]);
    assert.deepEqual([ra.url, rb.url, rc.url], ['https://sa.test/', 'https://sb.test/', 'https://a.test/'], 'задача взяла чужую страницу');
    assert.deepEqual([ra.value, rb.value, rc.value], ['первая', 'вторая', 'третья'], 'текст ушёл не в своё поле');
    assert.equal(await pa.inputValue('textarea'), 'первая');
    assert.equal(await pb.inputValue('textarea'), 'вторая');
    assert.ok(!pa.isClosed() && !pb.isClosed(), 'вкладки площадок singleTab остаются');
    await pa.close(); await pb.close();
    await sleep(300);
    assert.equal(windows(), base);

    // 3. Руль у хозяина до входа: задачи обеих площадок не начинаются и окон не открывают; отдал — обе идут.
    takeWheel({ dir: state, minutes: 1 });
    spans.length = 0;
    const both = Promise.all([span('a.test', 'WA', 300), span('b.test', 'WB', 300)]);
    await sleep(500);
    assert.equal(spans.length, 0, 'пока хозяин у руля, задачи не начинаются');
    assert.equal(windows(), base, 'пока хозяин у руля, окна не открываются');
    const gave = Date.now();
    releaseWheel({ dir: state });
    const [wa, wb] = await both;
    assert.ok(wa.s >= gave && wb.s >= gave, 'задачи начались только после того, как хозяин отдал руль');
    assert.ok(overlap(wa, wb), 'после руля разные площадки снова идут вместе');

    // 4. Руль посреди задачи: следующая команда обеих задач ждёт, время ожидания в бюджет не входит,
    // сторож задачи (maxMinutes + HANG.graceMs) за это время не срабатывает.
    HANG.graceMs = 300;
    let go;
    const gate = new Promise((r) => { go = r; });
    let ready = 0;
    const mid = (site) => ms.task(`mid-${site}`, async ({ act }) => {
      await act({ cmd: 'goto', url: `https://${site}/` });
      ready++;
      await gate;
      await act({ cmd: 'wait', ms: 10 });
      return Date.now();
    }, { site, maxMinutes: 0.05 }); // 3 с; хозяин держит руль дольше
    const midRuns = Promise.all([mid('a.test'), mid('b.test')]);
    while (ready < 2) await sleep(20);
    takeWheel({ dir: state, minutes: 1 });
    go();
    await sleep(4000);
    const gave2 = Date.now();
    releaseWheel({ dir: state });
    const [ta, tb] = await midRuns;
    assert.ok(ta >= gave2 && tb >= gave2, 'команды обеих задач ждали руль');
    // Контроль: без руля та же пауза кончается бюджетом — значит, выше его спасло именно время у руля.
    await assert.rejects(ms.task('budget', async ({ act }) => { await sleep(3500); await act({ cmd: 'wait', ms: 10 }); }, { site: 'a.test', maxMinutes: 0.05 }), BudgetExceeded);
    HANG.graceMs = 15 * 60e3;
    await sleep(300);

    // 4б. Руль взяли посреди fill: печать смотрит руль между клавишами не чаще раза в WHEEL.pollMs и обрывается за это
    // окно — LimitReached с .wheel и без before (часть текста набрана), notify 'limit'; поле так и остаётся набранным не
    // целиком, и Enter в него руки не нажимают (FieldMismatch) — недописанное сообщение не уйдёт.
    WHEEL.pollMs = 400;
    human.usePersona({ speed: 1.4, tremor: 0.5, twitch: 0.1, wpm: 60, typoRate: 0 }); // ~200 мс на знак
    const LONG = 'Привет! Это длинное сообщение, его печатают долго';
    let stopped, gate4, stoppedAt;
    const stoppedP = new Promise((r) => { stopped = r; });
    const gate4P = new Promise((r) => { gate4 = r; });
    notes.length = 0;
    const typing = ms.task('mid-type', async ({ see, act }) => {
      await act({ cmd: 'goto', url: 'https://a.test/' });
      const s = await see();
      const err = await act({ cmd: 'fill', id: s.elements.find((e) => e.role === 'textbox').id, gen: s.gen, text: LONG }).then(() => null, (e) => e);
      stoppedAt = Date.now();
      stopped();
      await gate4P; // тест смотрит, что печать стоит, и отдаёт руль
      const s2 = await see();
      const enter = await act({ cmd: 'press', key: 'Enter', id: s2.elements.find((e) => e.role === 'textbox').id, gen: s2.gen }).then(() => null, (e) => e);
      return { err, enter, after: (await see()).elements.find((e) => e.role === 'textbox').value };
    }, { site: 'a.test' });
    let field;
    for (let t = Date.now(); !field && Date.now() - t < 10000; await sleep(20)) field = ctx.pages().find((p) => p.url() === 'https://a.test/');
    assert.ok(field, 'окно задачи не нашлось');
    const valueNow = () => field.inputValue('textarea');
    while ((await valueNow()).length < 5) await sleep(20);
    takeWheel({ dir: state, minutes: 1 });
    const tookAt = Date.now();
    await stoppedP;
    const v1 = await valueNow();
    await sleep(1000);
    const v2 = await valueNow();
    releaseWheel({ dir: state });
    gate4();
    const { err: midErr, enter, after } = await typing;
    assert.ok(midErr instanceof LimitReached && midErr.wheel && midErr.wheel.by === 'owner' && midErr.before === undefined
      && /ввод остановлен/.test(midErr.message), `печать не остановилась рулём: ${midErr}`);
    assert.ok(stoppedAt - tookAt < WHEEL.pollMs + 600, `печать шла ещё ${stoppedAt - tookAt} мс после руля (окно ${WHEEL.pollMs} мс)`);
    assert.equal(v2, v1, 'после остановки бот печатал дальше');
    assert.ok(v1.length >= 5 && v1.length < LONG.length && LONG.startsWith(v1), `в поле ${v1.length} из ${LONG.length}`);
    assert.ok(enter instanceof FieldMismatch && enter.before === true, `Enter в недописанное поле: ${enter}`);
    assert.equal(after, v1, 'Enter дошёл до поля');
    assert.ok(notes.some((n) => n.event === 'limit' && /mid-type.*ввод остановлен/.test(n.text)), JSON.stringify(notes));
    human.usePersona(null);
    WHEEL.pollMs = 50;

    // 5. Хозяин не отпускает руль дольше срока: до входа — LimitReached с полем wheel, окна и слота нет, notify 'limit';
    // посреди задачи — LimitReached с before: true, команда не выполнялась.
    WHEEL.maxWaitMs = 300;
    const limitsFile = path.join(state, 'limits.json');
    const stamps = fs.readFileSync(limitsFile, 'utf8');
    takeWheel({ dir: state, minutes: 1 });
    notes.length = 0;
    let ran = false;
    await assert.rejects(ms.task('late', async () => { ran = true; }, { site: 'a.test' }),
      (e) => e instanceof LimitReached && e.wheel && e.wheel.by === 'owner' && /хозяин взял руль до \d\d:\d\d, ждали/.test(e.message));
    assert.equal(ran, false);
    assert.equal(fs.readFileSync(limitsFile, 'utf8'), stamps, 'слот не потрачен');
    assert.ok(notes.some((n) => n.event === 'limit' && /late.*не запущена.*руль/.test(n.text)), JSON.stringify(notes));
    releaseWheel({ dir: state });
    const title = await ms.task('cut', async ({ see, act }) => {
      await act({ cmd: 'goto', url: 'https://b.test/' });
      const s = await see();
      takeWheel({ dir: state, minutes: 1 });
      const btn = s.elements.find((e) => e.role === 'button');
      const err = await act({ cmd: 'click', id: btn.id, gen: s.gen }).then(() => null, (e) => e);
      assert.ok(err instanceof LimitReached && err.before === true && /команда не выполнена/.test(err.message), String(err));
      releaseWheel({ dir: state });
      return (await see()).title;
    }, { site: 'b.test' });
    assert.equal(title, 'b.test', 'команда, не дождавшаяся руля, не выполнялась');
    WHEEL.maxWaitMs = 30 * 60e3;

    // 6. ownerPresent одного вызывающего держит и другого (тот же dir, своего ownerPresent нет): руль by: 'mirror'.
    let present = true;
    const wired = await connect({ cdpUrl, dir: state, sitesFile, ownerPresent: async () => ({ present }) });
    spans.length = 0;
    const w1 = span('a.test', 'M1', 200, wired);
    await sleep(200);
    assert.equal(wheelState({ dir: state }).by, 'mirror');
    const w2 = span('b.test', 'M2', 200);
    await sleep(400);
    assert.equal(spans.length, 0, 'хозяин в зеркале: не идёт ни тот, кто спрашивает, ни тот, кто нет');
    const away = Date.now();
    present = false;
    const [m1, m2] = await Promise.all([w1, w2]);
    assert.ok(m1.s >= away && m2.s >= away);
    assert.equal(wheelState({ dir: state }), null, '«нет» снимает руль зеркала');
    await wired.close();

    // 7. Замок площадки свой: занятый чужим вызывающим держит только её (LimitReached с ним), другая площадка идёт;
    // брошенный (не обновлялся дольше staleMs) забирается.
    LOCK.timeoutMs = 400;
    const held = await realLock(limits.queueFile(state, 'a.test'), { pollMs: 20, holder: { name: 'cvs-apply', site: 'a.test' } });
    const [busy, free] = await Promise.allSettled([span('a.test', 'busy', 10), span('b.test', 'free', 10)]);
    assert.ok(busy.status === 'rejected' && busy.reason instanceof LimitReached && /очередь a\.test: занята задачей «cvs-apply» \(a\.test\)/.test(busy.reason.message), String(busy.reason));
    assert.equal(free.status, 'fulfilled', 'занятая площадка не держит другую');
    held();
    const stale = limits.queueFile(state, 'b.test');
    fs.writeFileSync(stale, JSON.stringify({ token: 'x', pid: 1, name: 'умерший', site: 'b.test', since: Date.now() - 60e3 }));
    const old = new Date(Date.now() - 60e3);
    fs.utimesSync(stale, old, old);
    LOCK.timeoutMs = 8000;
    const t0 = Date.now();
    await span('b.test', 'after-stale', 10);
    assert.ok(Date.now() - t0 < 3000, 'брошенный замок забирается сразу');
    await ms.close();

    // 8. Два процесса: разные площадки — одновременно, одна площадка — по очереди; счётчики limits.json не теряются,
    // когда четыре процесса пишут их одновременно.
    const child = path.join(tmp, 'child.js');
    fs.writeFileSync(child, `const fs = require('node:fs');
const { connect } = require(${JSON.stringify(path.join(__dirname, '..', 'index.js'))});
const [cdpUrl, dir, sitesFile, site, out, hold] = process.argv.slice(2);
(async () => {
  const ms = await connect({ cdpUrl, dir, sitesFile });
  await ms.task('child-' + site, async () => {
    const s = Date.now();
    await new Promise((r) => setTimeout(r, Number(hold)));
    fs.appendFileSync(out, JSON.stringify({ site, s, e: Date.now() }) + '\\n');
  }, { site });
  await ms.close();
})().catch((e) => { console.error(e); process.exit(1); });
`);
    const runChildren = async (sites, hold) => {
      const out = path.join(tmp, `out-${Date.now()}.jsonl`);
      await Promise.all(sites.map((site) => new Promise((resolve, reject) => {
        const p = spawn(process.execPath, [child, cdpUrl, state, sitesFile, site, out, String(hold)], { stdio: ['ignore', 'ignore', 'pipe'] });
        let err = '';
        p.stderr.on('data', (d) => { err += d; });
        p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${site}: код ${code}: ${err}`))));
      })));
      return fs.readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    };
    const [x, y] = await runChildren(['p1.test', 'p2.test'], 2500);
    assert.ok(overlap(x, y), `два процесса, разные площадки — одновременно: ${JSON.stringify([x, y])}`);
    const [u, v] = await runChildren(['p1.test', 'p1.test'], 800);
    assert.ok(!overlap(u, v), `два процесса, одна площадка — по очереди: ${JSON.stringify([u, v])}`);
    // Гонка без замка состояния ловится не каждый раз (проверено, убрав замок: один прогон из двух), поэтому три круга.
    const four = ['p1.test', 'p2.test', 'p3.test', 'p4.test'];
    for (let round = 0; round < 3; round++) {
      const before = JSON.parse(fs.readFileSync(limitsFile, 'utf8'));
      await runChildren(four, 10);
      const after = JSON.parse(fs.readFileSync(limitsFile, 'utf8'));
      for (const site of four) assert.equal((after[site] || []).length, (before[site] || []).length + 1, `${site}: отметка лимита потерялась`);
      for (const site of ['a.test', 'b.test']) assert.deepEqual(after[site], before[site], `${site}: чужие счётчики изменились`);
    }
    assert.deepEqual(fs.readdirSync(path.join(state, 'queue')), [], 'после процессов замков не осталось');
    assert.ok(!fs.readdirSync(state).some((f) => f.endsWith('.tmp')), 'временные файлы не остались');
  } finally { await ctx.close(); }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('parallel.test: ok');
})().catch((e) => { console.error(e); process.exit(1); });
