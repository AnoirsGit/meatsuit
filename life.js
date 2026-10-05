#!/usr/bin/env node
/**
 * Прогрев браузера: сам заходит на обычные сайты в случайные часы по Алматы
 * и ведёт себя как читатель. Только читает, ничего не вводит и не нажимает
 * в аккаунтах. Капча или блок: сессия останавливается, прогрев притихает на сутки.
 *
 *   node life.js plan            расписание на сегодня и пример сессии (браузер не нужен)
 *   node life.js now [--dry]     одна сессия прямо сейчас (--dry: показать шаги, не открывая сайты);
 *                                в паузе после капчи или блока не запускается, пока нет --force
 *   node life.js run             по расписанию, пока не остановят (Ctrl+C, SIGTERM: вкладка закрывается)
 *
 * Опции: --config profiles/life.json  --cdp http://127.0.0.1:9222  --data data
 *        --egress profiles/egress.json  --force
 * Браузер должен быть запущен с --remote-debugging-port, к нему подключаемся по CDP.
 * Перед каждой сессией проверяется выход в сеть по egress.json ({"country":"KZ","asn":[64500]});
 * нет файла — в журнале предупреждение, сессия идёт; не совпало — сессия пропускается.
 */
const fs = require('node:fs');
const path = require('node:path');
const human = require('./human.js');
const { normalizeConfig } = require('./life/config.js');
const { startOfLocalDay, localDay, planDay, planWeek, planSession } = require('./life/plan.js');
const { createRunner, createStore, createJournal, loadEgress } = require('./life/runner.js');

const MIN = 60000;

function parseArgs(argv) {
  const opts = { _: [], config: 'profiles/life.json', cdp: process.env.MEATSUIT_CDP || 'http://127.0.0.1:9222', data: 'data', egress: 'profiles/egress.json' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry') opts.dry = true;
    else if (a === '--force') opts.force = true;
    else if (['--config', '--cdp', '--data', '--egress'].includes(a)) opts[a.slice(2)] = argv[++i];
    else opts._.push(a);
  }
  return opts;
}

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

/** Человек в браузере один: темп и повадки сохраняются, чтобы после перезапуска он остался тем же. Испорченный файл заменяется годными повадками. */
function loadPersona(dir) {
  const file = path.join(dir, 'persona.json');
  const persona = human.restorePersona(readJson(file));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(persona, null, 2));
  human.usePersona(persona);
  return persona;
}

const fmt = (ms, tz) => new Date(ms).toLocaleString('ru-RU', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' });

async function connect(cdpUrl) {
  let chromium;
  try { ({ chromium } = require('patchright')); } catch { throw new Error('не установлен patchright: выполните npm install'); }
  const browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0] || await browser.newContext();
  return { openPage: () => context.newPage(), close: () => browser.close() }; // close только отключает нас, браузер живёт
}

/** SIGTERM (docker stop) и Ctrl+C: закрыть вкладку и соединение, потом выйти. Второй сигнал или 5 с без ответа браузера — выход сразу. */
function exitOnSignals(runner) {
  let stopping = false;
  const onSignal = () => {
    if (stopping) process.exit(1);
    stopping = true;
    setTimeout(() => process.exit(1), 5000);
    runner.stop().finally(() => process.exit(0));
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cmd = opts._[0];
  if (!['plan', 'now', 'run'].includes(cmd)) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#!.*\n/, '').replace(/^\/\*\*\n|^ \* ?/gm, ''));
    process.exit(cmd ? 1 : 0);
  }
  const cfg = normalizeConfig(readJson(opts.config) || (() => { throw new Error(`нет конфига ${opts.config}`); })());
  const persona = loadPersona(opts.data);

  if (cmd === 'plan') {
    const now = Date.now();
    const week = planWeek(now, cfg); // пример: настоящий выбор дней делает run и хранит в data/life.json
    const working = week.days.includes(localDay(now, cfg.tz));
    const starts = working ? planDay(startOfLocalDay(now, cfg.tz), cfg) : [];
    console.log(`Алматы сейчас: ${fmt(now, cfg.tz)}; повадки: ${persona.wpm.toFixed(0)} слов в минуту, рука ×${persona.speed.toFixed(2)}`);
    console.log(`Рабочие дни недели ${week.id} (пример): ${week.days.join(', ')}`);
    console.log(`Сегодня: ${working ? 'рабочий' : 'выходной'}`);
    console.log('Старты на сегодня:', starts.map((s) => fmt(s, cfg.tz).split(', ')[1]).join(', ') || 'нет');
    console.log('Пример сессии:');
    for (const s of planSession(cfg)) console.log(`  ${s.kind.padEnd(5)} ${s.url}  ~${(s.budgetMs / MIN).toFixed(1)} мин${s.follow ? `, по ссылкам: ${s.follow}` : ''}`);
    return;
  }

  if (cmd === 'now' && opts.dry) { for (const s of planSession(cfg)) console.log(JSON.stringify(s)); return; }

  const runner = createRunner({
    cfg,
    connect: () => connect(opts.cdp),
    store: createStore({ file: path.join(opts.data, 'life.json') }),
    journal: createJournal({ dir: opts.data }),
    egress: loadEgress({ file: opts.egress }), // неверный файл — ошибка здесь, до всякой сессии
  });
  exitOnSignals(runner);

  if (cmd === 'now') {
    const out = await runner.runNow({ force: opts.force });
    if (out.result === 'paused') {
      console.error(`Пауза до ${fmt(out.until, cfg.tz)} (${cfg.tz}) после капчи или блока: сессия не запущена. Всё равно запустить: node life.js now --force`);
      process.exitCode = 1;
    } else if (out.result === 'error' || out.result === 'egress-wrong') process.exitCode = 1;
    return;
  }

  console.log(`Прогрев по расписанию (${cfg.tz}). Остановить: Ctrl+C.`);
  await runner.loop();
}

main().catch((err) => { console.error(`Ошибка: ${err.message}`); process.exit(1); });
