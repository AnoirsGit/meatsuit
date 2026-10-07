/**
 * Подключение без браузера: что require('meatsuit') отдаёт и чего connect() требует до подключения.
 *
 *   node test/api.test.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const meatsuit = require('../index.js');
const { ruleFor } = require('../limits.js');

const ROOT = path.join(__dirname, '..');
const NO_BROWSER = 'http://127.0.0.1:1'; // до подключения дело не доходит: проверки идут раньше

(async () => {
  // Список экспортов — контракт вызывающих (tinder-matcher импортирует имена из CommonJS): не меняется.
  assert.deepEqual(Object.keys(meatsuit), ['connect', 'hands', 'replay', 'signature', 'normalizeName', 'urlPattern',
    'NeedsHuman', 'LimitReached', 'BudgetExceeded', 'BadCommand', 'StaleElement',
    'telegramNotifier', 'createTelegram', 'findChats', 'TelegramError', 'peek']);
  assert.equal(typeof require('../hands.js').validate, 'function', 'meatsuit/hands.js отдаёт validate');

  // Лимиты площадок — у вызывающего: без sitesFile или sites connect падает внятно, браузер не трогает.
  const { connect } = meatsuit;
  await assert.rejects(connect({ cdpUrl: NO_BROWSER }), /нужен sitesFile .* или sites/);
  await assert.rejects(connect({ cdpUrl: NO_BROWSER, sitesFile: path.join(os.tmpdir(), 'нет-такого-sites.json') }), /нет файла лимитов/);
  await assert.rejects(connect({ cdpUrl: NO_BROWSER, sitesFile: 'x.json', sites: {} }), /либо sitesFile, либо sites/);
  await assert.rejects(connect({ cdpUrl: NO_BROWSER, sites: [] }), /sites — объект/);
  assert.ok(!fs.existsSync(path.join(ROOT, 'sites.json')), 'своего sites.json у meatsuit нет, только образец');

  // Образец читается и описывает "*" и закрытую площадку.
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'sites.example.json'), 'utf8'));
  assert.equal(ruleFor(example, 'unknown.example'), example['*']);
  assert.equal(ruleFor(example, 'example.org').perDay, 0);

  // peek: сколько осталось у площадки, без браузера и без траты слота; те же sitesFile|sites и dir, что у connect.
  const { peek } = meatsuit;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meatsuit-peek-'));
  const dir = path.join(tmp, 'state');
  const noon = new Date(2026, 9, 8, 12, 0);
  const H = 3600e3;
  const sitesFile = path.join(tmp, 'sites.json');
  fs.writeFileSync(sitesFile, JSON.stringify({ 'a.test': { perDay: 3, perHour: 2, hours: '10-23' }, 'closed.test': { perDay: 0 }, '*': { perDay: 1 } }));
  // пусто: ничего не потрачено, всё доступно; файла счётчиков peek не создаёт
  assert.deepEqual(peek('a.test', { sitesFile, dir, now: noon }),
    { site: 'a.test', rule: { perDay: 3, perHour: 2, hours: '10-23' }, ok: true, reason: null, usedDay: 0, usedHour: 0, leftDay: 3, leftHour: 2 });
  assert.ok(!fs.existsSync(path.join(dir, 'limits.json')), 'peek ничего не пишет');
  // счётчики в формате task(): записи по хосту, read-only задачи под ключом read:<хост>
  fs.mkdirSync(dir);
  const counters = { 'a.test': [+noon - 20 * H, +noon - 2 * H, +noon - 0.5 * H], 'read:a.test': [+noon - 0.2 * H] };
  fs.writeFileSync(path.join(dir, 'limits.json'), JSON.stringify(counters));
  let st = peek('a.test', { sitesFile, dir, now: noon });
  assert.deepEqual([st.ok, st.usedDay, st.usedHour, st.leftDay, st.leftHour], [false, 2, 2, 1, 0]);
  assert.match(st.reason, /исчерпан лимит на час \(2\)/);
  st = peek('a.test', { sitesFile, dir, now: new Date(+noon + H) }); // через час: часовой лимит освободился
  assert.deepEqual([st.ok, st.reason, st.leftDay, st.leftHour], [true, null, 1, 2]);
  st = peek('a.test', { sitesFile, dir, now: new Date(2026, 9, 8, 23, 30) });
  assert.match(st.reason, /вне часов работы 10-23/);
  assert.equal(st.ok, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'limits.json'), 'utf8')), counters, 'счётчики не тронуты');
  // правило "*", закрытая и неописанная площадка; лимиты объектом вместо файла
  st = peek('other.test', { sitesFile, dir, now: noon });
  assert.deepEqual([st.rule, st.ok, st.leftDay, st.leftHour], [{ perDay: 1 }, true, 1, null]);
  st = peek('closed.test', { sitesFile, dir, now: noon });
  assert.deepEqual([st.ok, st.leftDay], [false, 0]);
  st = peek('x.test', { sites: { 'y.test': { perDay: 5 } }, dir, now: noon });
  assert.deepEqual([st.rule, st.ok, st.leftDay, st.leftHour], [null, false, 0, 0]);
  assert.match(st.reason, /не описана в sites\.json/);
  // ошибки — как у connect: без лимитов, без site, кривое правило — исключение, а не ok: false
  assert.throws(() => peek('a.test', { dir }), /нужен sitesFile .* или sites/);
  assert.throws(() => peek('', { sitesFile, dir }), /peek: нужен site/);
  assert.throws(() => peek('bad.test', { sites: { 'bad.test': { perDay: 1, hours: 'днём' } }, dir, now: noon }), /hours/);
  fs.rmSync(tmp, { recursive: true, force: true });

  // Ядро от extras/ не зависит: ни один модуль корня не грузит оттуда ничего, даже косвенно.
  const extras = path.join(ROOT, 'extras') + path.sep;
  const core = fs.readdirSync(ROOT).filter((f) => f.endsWith('.js'));
  for (const f of core) require(path.join(ROOT, f));
  const leaked = Object.keys(require.cache).filter((k) => k.startsWith(extras));
  assert.deepEqual(leaked, [], 'ядро загрузило модули из extras/');

  // Ядро не читает окружение и не запускается как программа: креды и настройки приносит вызывающий
  // аргументами, программы для человека лежат в tools/.
  for (const f of core) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.doesNotMatch(src, /process\.env/, `${f} читает process.env`);
    assert.doesNotMatch(src, /require\.main === module/, `${f}: CLI место в tools/`);
  }
  assert.ok(!('telegramNotifier' in require('../guard.js')), 'guard.js больше не реэкспортирует telegramNotifier');

  console.log('api.test: ok');
})().catch((e) => { console.error(e); process.exit(1); });
