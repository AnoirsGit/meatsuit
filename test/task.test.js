/**
 * connect()/task(): отдельное окно, лимит, guard, бюджет, очередь.
 * Настоящий Chromium с портом отладки, как у Neko.
 *
 *   node test/task.test.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { connect, NeedsHuman, LimitReached, BudgetExceeded } = require('../index.js');

const PORT = 9333;
const SITE = 'example.test';
const OK = '<button onclick="document.title=\'clicked\'">Like</button>';
const CAPTCHA = '<p>Verify you are human</p>';

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meatsuit-task-'));
  const sitesFile = path.join(tmp, 'sites.json');
  fs.writeFileSync(sitesFile, JSON.stringify({ [SITE]: { perDay: 100 }, 'limited.test': { perDay: 1 } }));

  // «Мой браузер»: с профилем и портом отладки. Мою вкладку бот трогать не должен.
  const ctx = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
    headless: true, args: [`--remote-debugging-port=${PORT}`],
  });
  const mine = ctx.pages()[0] || (await ctx.newPage());
  await mine.setContent('<title>моя вкладка</title>');

  let html = OK;
  ctx.on('page', (p) => { if (p !== mine) p.setContent(html).catch(() => {}); });

  const notes = [];
  const byEvent = (e) => notes.filter((n) => n.event === e);
  const ms = await connect({ cdpUrl: `http://127.0.0.1:${PORT}`, dir: path.join(tmp, 'state'), sitesFile, notify: async (text, event) => notes.push({ text, event }) });
  const windows = () => ctx.pages().length;
  const settle = () => new Promise((r) => setTimeout(r, 300));

  // 1. Успех: окно отдельное, клик работает, окно закрыто, моя вкладка цела.
  const out = await ms.task('t1', async ({ see, act }) => {
    await act({ cmd: 'wait', ms: 300 }); // act без see() не падает
    const s = await see();
    assert.equal(windows(), 2, 'должно быть отдельное окно');
    await act({ cmd: 'click', id: s.elements[0].id, gen: s.gen });
    return 'done';
  }, { site: SITE });
  assert.equal(out, 'done');
  await settle();
  assert.equal(windows(), 1, 'окно задачи должно закрыться');
  assert.equal(await mine.title(), 'моя вкладка');

  // 2. Лимит: вторая задача не открывает окно.
  await ms.task('t2', async () => 1, { site: 'limited.test' });
  await assert.rejects(ms.task('t2b', async () => 1, { site: 'limited.test' }), LimitReached);
  await assert.rejects(ms.task('t2c', async () => 1, { site: 'unknown.test' }), LimitReached);
  await settle();
  assert.equal(windows(), 1);

  // 3. Капча: NeedsHuman, уведомление, окно остаётся мне.
  html = CAPTCHA;
  await assert.rejects(ms.task('t3', async ({ see }) => { await see(); }, { site: SITE }), NeedsHuman);
  await settle();
  assert.equal(byEvent('needsHuman').length, 1);
  assert.match(byEvent('needsHuman')[0].text, /t3.*капча/);
  assert.equal(byEvent('limit').length, 2, 'отказ по лимиту (площадка с perDay 1 и неизвестная) должен уходить в notify');
  assert.match(byEvent('limit')[0].text, /t2b.*не запущена/);
  assert.equal(byEvent('start').length + byEvent('done').length, 0, 'start/done по умолчанию не шлём');
  assert.equal(windows(), 2, 'окно с капчей должно остаться');
  await ctx.pages().find((p) => p !== mine).close();

  // 4. Бюджет команд: окно закрывается.
  html = OK;
  await assert.rejects(ms.task('t4', async ({ act }) => {
    await act({ cmd: 'wait', ms: 10 });
    await act({ cmd: 'wait', ms: 10 });
  }, { site: SITE, maxCommands: 1 }), BudgetExceeded);
  await settle();
  assert.equal(windows(), 1);

  // 4б. Репетиция (dryRun) квоту не тратит: файл лимитов не меняется, а при исчерпанном лимите всё равно отказ.
  const limitsFile = path.join(tmp, 'state', 'limits.json');
  const stampsBefore = fs.readFileSync(limitsFile, 'utf8');
  await ms.task('t4b', async ({ see }) => { await see(); }, { site: SITE, dryRun: true });
  assert.equal(fs.readFileSync(limitsFile, 'utf8'), stampsBefore, 'dryRun записал отметку в limits.json');
  await assert.rejects(ms.task('t4c', async () => 1, { site: 'limited.test', dryRun: true }), LimitReached);

  // 4d. readOnly: чтение не тратит perDay; запись внутри — тратит задним числом; без флага как раньше.
  const RO = 'ro.test';
  fs.writeFileSync(sitesFile, JSON.stringify({ [SITE]: { perDay: 100 }, 'limited.test': { perDay: 1 }, [RO]: { perDay: 1, perHour: 50 } }));
  const dayLeft = () => (JSON.parse(fs.readFileSync(limitsFile, 'utf8'))[RO] || []).length;
  await ms.task('ro1', async ({ see }) => { await see(); }, { site: RO, readOnly: true });
  await ms.task('ro2', async ({ see }) => { await see(); }, { site: RO, readOnly: true });
  assert.equal(dayLeft(), 0, 'чтение не должно тратить perDay');
  await ms.task('ro3', async ({ see, act }) => { const s = await see(); await act({ cmd: 'click', id: s.elements[0].id, gen: s.gen }); }, { site: RO, readOnly: true });
  assert.equal(dayLeft(), 1, 'запись внутри read-only задачи должна стоить слот');
  await assert.rejects(ms.task('ro4', async () => 1, { site: RO }), LimitReached); // без флага — как раньше
  await ms.task('ro5', async ({ see }) => { await see(); }, { site: RO, readOnly: true }); // а чтение после этого можно

  // 5. Ошибка в задаче не оставляет замок: следующая задача идёт.
  await assert.rejects(ms.task('t5', async () => { throw new Error('boom'); }, { site: SITE }), /boom/);
  assert.ok(byEvent('error').some((n) => /t5.*boom/.test(n.text)), 'сбой в проекте должен уходить в notify');
  assert.ok(byEvent('error').some((n) => /t4.*команд/.test(n.text)), 'бюджет — тоже ошибка');
  assert.equal(await ms.task('t5b', async () => 'ok', { site: SITE }), 'ok');

  // 5b. dryRun: результат act без url не должен принимать за «страница вне площадки».
  const dryRes = await ms.task('t5c', async ({ see, act }) => {
    const s = await see();
    return act({ cmd: 'click', id: s.elements[0].id, gen: s.gen });
  }, { site: SITE, dryRun: true });
  assert.deepEqual(dryRes, { dryRun: true, changed: false });

  // Журнал есть.
  assert.ok(fs.readFileSync(path.join(tmp, 'state', 'journal.jsonl'), 'utf8').includes('"cmd":"click"'));

  // Повадки человека живут в каталоге состояния: connect создал persona.json, а сохранённые не трогает.
  const persona = JSON.parse(fs.readFileSync(path.join(tmp, 'state', 'persona.json'), 'utf8'));
  assert.ok(persona.wpm > 0 && persona.speed > 0 && persona.typoRate >= 0, JSON.stringify(persona));
  const savedDir = path.join(tmp, 'state-persona');
  const saved = { speed: 1.2, tremor: 0.5, twitch: 0.2, wpm: 41, typoRate: 0.015 };
  fs.mkdirSync(savedDir);
  fs.writeFileSync(path.join(savedDir, 'persona.json'), JSON.stringify(saved));
  const msP = await connect({ cdpUrl: `http://127.0.0.1:${PORT}`, dir: savedDir, sitesFile });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(savedDir, 'persona.json'), 'utf8')), saved, 'connect переписал сохранённые повадки');
  await msP.close();

  // Все события, когда попросили: start и done с числом команд.
  const all = [];
  const ms2 = await connect({ cdpUrl: `http://127.0.0.1:${PORT}`, dir: path.join(tmp, 'state'), sitesFile, notifyOn: ['start', 'done'], notify: async (text, event) => all.push({ text, event }) });
  await ms2.task('t6', async ({ act }) => { await act({ cmd: 'wait', ms: 10 }); }, { site: SITE });
  assert.deepEqual(all.map((n) => n.event), ['start', 'done']);
  assert.match(all[1].text, /t6.*завершена.*команд: 1/);

  // Лимиты объектом вместо файла (sites): правило берётся из него, perDay 0 закрывает площадку.
  const ms3 = await connect({ cdpUrl: `http://127.0.0.1:${PORT}`, dir: path.join(tmp, 'state3'), sites: { [SITE]: { perDay: 0 }, 'open.test': { perDay: 1 } } });
  await assert.rejects(ms3.task('t7', async () => 1, { site: SITE }), (e) => e instanceof LimitReached && /perDay 0/.test(e.message));
  assert.equal(await ms3.task('t8', async () => 'ok', { site: 'open.test' }), 'ok');
  await settle();
  assert.equal(windows(), 1, 'окно задачи с sites-объектом закрылось');

  await ms.close();
  await ms2.close();
  await ms3.close();
  await ctx.close();
  console.log('task.test: ok');
})().catch((e) => { console.error(e); process.exit(1); });
