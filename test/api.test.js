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
    'telegramNotifier', 'createTelegram', 'findChats', 'TelegramError']);
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

  // Ядро от extras/ не зависит: ни один модуль корня не грузит оттуда ничего, даже косвенно.
  const extras = path.join(ROOT, 'extras') + path.sep;
  const core = fs.readdirSync(ROOT).filter((f) => f.endsWith('.js'));
  for (const f of core) require(path.join(ROOT, f));
  const leaked = Object.keys(require.cache).filter((k) => k.startsWith(extras));
  assert.deepEqual(leaked, [], 'ядро загрузило модули из extras/');

  console.log('api.test: ok');
})().catch((e) => { console.error(e); process.exit(1); });
