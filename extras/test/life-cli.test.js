/**
 * node life.js как процесс: пауза после капчи, сбой подключения к браузеру, остановка по сигналу.
 * Первые тесты браузера не требуют (адрес CDP заведомо мёртвый); тест на SIGTERM берёт настоящий
 * Chromium и без patchright или браузера пропускается.
 *
 *   NODE_PATH=…/node_modules node --test test/life-cli.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { localDay } = require('../life/plan.js');
const chromium = require('../testkit/browser-chromium.js');
const { serve } = require('../testkit/browser-site.js');

const LIFE = path.join(__dirname, '..', 'life.js');
const DEAD_CDP = 'http://127.0.0.1:1';
const TZ = 'Etc/GMT-5'; // UTC+5 без перевода часов
const H = 3600e3, MIN = 60e3;

/** Рабочий каталог на тест: конфиг, data/, и сюда же cwd процесса (profiles/egress.json от него не лежит). */
function workdir(site = 'http://127.0.0.1:1/') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meatsuit-lifecli-'));
  const config = path.join(dir, 'life.json');
  fs.writeFileSync(config, JSON.stringify({
    tz: TZ, hours: [0, 24], sessionsPerDay: [1, 1], minGapMinutes: 0, lateMinutes: 90, cooldownHours: 24,
    session: { minutes: [0.1, 0.2], sites: [1, 1] }, sites: [{ url: site }],
  }));
  const data = path.join(dir, 'data');
  fs.mkdirSync(data);
  const journal = () => (fs.existsSync(path.join(data, 'life.jsonl'))
    ? fs.readFileSync(path.join(data, 'life.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const state = () => JSON.parse(fs.readFileSync(path.join(data, 'life.json'), 'utf8'));
  return { dir, config, data, journal, state, writeState: (v) => fs.writeFileSync(path.join(data, 'life.json'), JSON.stringify(v)), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Запустить life.js; ждать выхода не обязательно (child.exited — промис). */
function life(args, { cwd } = {}) {
  const child = spawn(process.execPath, [LIFE, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { stdout: '', stderr: '' };
  child.stdout.on('data', (d) => { out.stdout += d; });
  child.stderr.on('data', (d) => { out.stderr += d; });
  child.exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal, ...out })));
  const killer = setTimeout(() => child.kill('SIGKILL'), 60000);
  child.exited.then(() => clearTimeout(killer));
  return child;
}

async function until(cond, what, ms = 20000) {
  const t0 = Date.now();
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() - t0 > ms) assert.fail(`не дождались: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('now в паузе после капчи: отказ с понятным сообщением, сессия не запускается', async () => {
  const w = workdir();
  try {
    const until1 = Date.now() + 5 * H;
    w.writeState({ day: localDay(Date.now(), TZ), starts: [], done: [], pausedUntil: until1 });
    const r = await life(['now', '--config', w.config, '--data', w.data, '--cdp', DEAD_CDP, '--no-egress-check'], { cwd: w.dir }).exited;
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /[Пп]ауза до/);
    assert.match(r.stderr, /--force/);
    assert.equal(w.journal().some((e) => e.event === 'session-start'), false, 'сессия началась в паузу');
    assert.equal(w.state().pausedUntil, until1, 'пауза изменилась');
  } finally { w.cleanup(); }
});

test('now --force в паузе: запускается (здесь упирается в мёртвый CDP: событие error, а не падение)', async () => {
  const w = workdir();
  try {
    w.writeState({ day: localDay(Date.now(), TZ), starts: [], done: [], pausedUntil: Date.now() + 5 * H });
    const r = await life(['now', '--force', '--config', w.config, '--data', w.data, '--cdp', DEAD_CDP, '--no-egress-check'], { cwd: w.dir }).exited;
    const j = w.journal();
    assert.ok(j.some((e) => e.event === 'session-start'), 'с --force сессия не началась');
    assert.ok(j.some((e) => e.event === 'error'), `нет события error: ${r.stdout}${r.stderr}`);
    assert.doesNotMatch(r.stderr + r.stdout, /\n\s+at /, 'в выводе стек вместо сообщения');
  } finally { w.cleanup(); }
});

test('now при недоступном браузере: событие error в журнале, предупреждение о выходе, код выхода 1', async () => {
  const w = workdir();
  try {
    const r = await life(['now', '--config', w.config, '--data', w.data, '--cdp', DEAD_CDP, '--no-egress-check'], { cwd: w.dir }).exited;
    const j = w.journal();
    assert.ok(j.some((e) => e.event === 'warning' && /выход в сеть не проверяется/.test(e.reason)), 'нет предупреждения про выход в сеть');
    const err = j.find((e) => e.event === 'error');
    assert.ok(err, `нет события error: ${r.stdout}${r.stderr}`);
    assert.match(err.reason, /ECONNREFUSED|patchright/);
    assert.equal(r.code, 1);
  } finally { w.cleanup(); }
});

test('run при недоступном браузере не падает: error в журнале, старт сделан, процесс жив и по SIGTERM выходит кодом 0', async () => {
  const w = workdir();
  try {
    const start = Date.now() - MIN;
    w.writeState({ day: localDay(Date.now(), TZ), starts: [start], done: [] });
    const child = life(['run', '--config', w.config, '--data', w.data, '--cdp', DEAD_CDP, '--no-egress-check'], { cwd: w.dir });
    await until(() => w.journal().some((e) => e.event === 'error'), 'событие error');
    await until(() => w.state().done.includes(start), 'старт отмечен сделанным');
    assert.equal(child.exitCode, null, 'процесс упал после сбоя подключения');
    child.kill('SIGTERM');
    const r = await child.exited;
    assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);
  } finally { w.cleanup(); }
});

test('нет egress.json: now и run отказываются сразу, а с --no-egress-check идут с предупреждением', async () => {
  const w = workdir();
  try {
    const missing = path.join(w.dir, 'нет-такого.json');
    for (const cmd of ['now', 'run']) {
      const r = await life([cmd, '--config', w.config, '--data', w.data, '--cdp', DEAD_CDP, '--egress', missing], { cwd: w.dir }).exited;
      assert.equal(r.code, 1, `${cmd}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /egress\.json|нет-такого/);
      assert.equal(w.journal().some((e) => e.event === 'session-start'), false);
    }
    const r = await life(['now', '--config', w.config, '--data', w.data, '--cdp', DEAD_CDP, '--egress', missing, '--no-egress-check'], { cwd: w.dir }).exited;
    assert.equal(w.journal().some((e) => e.event === 'warning' && /не проверяется/.test(e.reason)), true, `${r.stdout}${r.stderr}`);
    assert.equal(w.journal().some((e) => e.event === 'session-start'), true, 'с --no-egress-check сессия должна стартовать (браузера нет, упадёт на подключении)');
  } finally { w.cleanup(); }
});

test('неверный egress.json: now отказывается сразу с понятным сообщением, а не идёт без проверки', async () => {
  const w = workdir();
  try {
    const egress = path.join(w.dir, 'egress.json');
    fs.writeFileSync(egress, '{"country":"Kazakhstan"}');
    const r = await life(['now', '--config', w.config, '--data', w.data, '--cdp', DEAD_CDP, '--egress', egress], { cwd: w.dir }).exited;
    assert.equal(r.code, 1);
    assert.match(r.stderr, /country/);
    assert.equal(w.journal().some((e) => e.event === 'session-start'), false);
  } finally { w.cleanup(); }
});

test('испорченный persona.json (пустой объект, wpm 0, мусор): повадки заменяются годными, а не NaN и Infinity', async () => {
  for (const junk of ['{}', '{"wpm":0,"speed":"fast"}', 'не json', '[1,2]']) {
    const w = workdir();
    try {
      fs.writeFileSync(path.join(w.data, 'persona.json'), junk);
      const r = await life(['plan', '--config', w.config, '--data', w.data], { cwd: w.dir }).exited;
      assert.equal(r.code, 0, r.stderr);
      assert.doesNotMatch(r.stdout, /NaN|Infinity/, junk);
      const saved = JSON.parse(fs.readFileSync(path.join(w.data, 'persona.json'), 'utf8'));
      assert.ok(saved.wpm >= 20 && saved.wpm <= 150 && saved.speed >= 0.5 && saved.speed <= 2, `${junk} → ${JSON.stringify(saved)}`);
    } finally { w.cleanup(); }
  }
});

test('plan показывает рабочие дни недели и «сегодня: выходной/рабочий»; при дне каждый день все семь', async () => {
  const w = workdir();
  try {
    const cfg = JSON.parse(fs.readFileSync(w.config, 'utf8'));
    fs.writeFileSync(w.config, JSON.stringify({ ...cfg, daysPerWeek: [2, 2] }));
    const r = await life(['plan', '--config', w.config, '--data', w.data], { cwd: w.dir }).exited;
    assert.equal(r.code, 0, r.stderr);
    const line = r.stdout.split('\n').find((l) => l.startsWith('Рабочие дни недели'));
    assert.ok(line, `нет строки про дни недели:\n${r.stdout}`);
    assert.equal((line.match(/\d{4}-\d{2}-\d{2}/g) || []).length, 2, line);
    assert.match(r.stdout, /Сегодня: (рабочий|выходной)/);

    fs.writeFileSync(w.config, JSON.stringify({ ...cfg, daysPerWeek: [7, 7] }));
    const all = await life(['plan', '--config', w.config, '--data', w.data], { cwd: w.dir }).exited;
    assert.equal((all.stdout.split('\n').find((l) => l.startsWith('Рабочие дни недели')).match(/\d{4}-\d{2}-\d{2}/g) || []).length, 7);
    assert.match(all.stdout, /Сегодня: рабочий/);
  } finally { w.cleanup(); }
});

const skip = chromium.unavailable();

test('SIGTERM посреди сессии: вкладка закрыта, процесс вышел, браузер остался', { skip }, async () => {
  const slow = await serve({ '/': { body: '<p>медленная страница</p>', delay: 40000 } }); // goto висит, пока не остановят
  const w = workdir(`${slow.origin}/`);
  const browser = await chromium.launch();
  try {
    const pages = async () => (await (await fetch(`${browser.cdpUrl}/json/list`)).json()).filter((t) => t.type === 'page');
    const before = (await pages()).length;
    const child = life(['now', '--config', w.config, '--data', w.data, '--cdp', browser.cdpUrl, '--no-egress-check'], { cwd: w.dir });
    await until(async () => (await pages()).length === before + 1, 'вкладка сессии открылась');
    await until(() => slow.hits.length > 0 || w.journal().some((e) => e.event === 'session-start'), 'сессия идёт');
    child.kill('SIGTERM');
    const r = await Promise.race([child.exited, new Promise((resolve) => setTimeout(() => resolve({ code: 'завис' }), 8000))]);
    assert.equal(r.code, 0, `процесс не вышел за 8 с: ${r.stdout || ''}${r.stderr || ''}`);
    await until(async () => (await pages()).length === before, 'вкладка закрылась в браузере', 3000); // список вкладок у браузера обновляется не мгновенно
    assert.ok(w.journal().some((e) => e.event === 'stopped'), 'остановка не записана');
  } finally {
    await browser.stop();
    await slow.close();
    w.cleanup();
  }
});
