#!/usr/bin/env node
/**
 * Хозяин у руля (wheel.js): пока руль взят, боты этого dir не начинают задачи и не жмут — все площадки сразу.
 *   node tools/wheel.js take [минуты] [--dir /meatsuit/state]   взять руль (по умолчанию на 60 минут)
 *   node tools/wheel.js give [--dir …]                          отдать
 *   node tools/wheel.js [--dir …]                               у кого руль и до скольки
 * Без --dir — MEATSUIT_DIR, иначе ~/.meatsuit (connect() MEATSUIT_DIR не читает: dir у ботов — их аргумент). Без браузера.
 */
const os = require('node:os');
const path = require('node:path');
const { wheelState, takeWheel, releaseWheel } = require('../wheel.js');
const { clock } = require('../holds.js');

const args = process.argv.slice(2);
const at = args.indexOf('--dir');
const dir = at >= 0 ? args[at + 1] : process.env.MEATSUIT_DIR || path.join(os.homedir(), '.meatsuit');
if (at >= 0 && !dir) { console.error('--dir: нужен путь'); process.exit(1); }
const [cmd, arg] = args.filter((a, i) => !a.startsWith('--') && (at < 0 || i !== at + 1));

const show = (w) => (w ? `руль у ${w.by === 'mirror' ? 'хозяина в зеркале' : w.by} до ${clock(w.until)}: боты ждут` : 'руль свободен: боты работают');

(async () => {
  if (cmd === 'take') {
    const minutes = arg === undefined ? 60 : Number(arg);
    try { console.log(show(await takeWheel({ dir, minutes }))); }
    catch (e) { console.error(e.message); process.exit(1); }
  } else if (cmd === 'give') {
    const { released } = await releaseWheel({ dir });
    console.log(released ? 'руль отдан: боты работают' : `руль и так был свободен (${dir}; руль в другой папке — укажите её в --dir)`);
  } else if (cmd === undefined) {
    console.log(`${show(wheelState({ dir }))} (${dir})`);
  } else {
    console.error('использование: node tools/wheel.js [take [минуты] | give] [--dir <папка состояния>]');
    process.exit(2);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
