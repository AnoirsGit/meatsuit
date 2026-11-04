#!/usr/bin/env node
/**
 * Снять стоп площадки раньше срока (стоп ставит task() после NeedsHuman, см. holds.js):
 *   node tools/release.js tinder.com [--dir /meatsuit/state]
 * Без --dir — MEATSUIT_DIR, иначе ~/.meatsuit. connect() MEATSUIT_DIR не читает: команду с --dir печатает сообщение о стопе. Без браузера. Без площадки — показать стоп всех.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { holdState, releaseHold, clock } = require('../holds.js');

const args = process.argv.slice(2);
const at = args.indexOf('--dir');
const dir = at >= 0 ? args[at + 1] : process.env.MEATSUIT_DIR || path.join(os.homedir(), '.meatsuit');
const site = args.find((a, i) => !a.startsWith('--') && (at < 0 || i !== at + 1));
if (at >= 0 && !dir) { console.error('--dir: нужен путь'); process.exit(1); }

if (!site) {
  let files = [];
  try { files = fs.readdirSync(path.join(dir, 'holds')).filter((f) => f.endsWith('.json')); } catch { /* стопов не было */ }
  const on = files.map((f) => holdState(decodeURIComponent(f.slice(0, -5)), { dir })).filter(Boolean);
  if (!on.length) console.log(`стопов нет (${dir})`);
  for (const h of on) console.log(`${h.site}: стоп до ${clock(h.until)} — ${h.reason}`);
  console.log('снять: node tools/release.js <площадка>');
  process.exit(0);
}
const { released } = releaseHold(site, { dir });
console.log(released ? `${site}: стоп снят` : `${site}: стопа не было (${dir}; стоп в другой папке — укажите её в --dir)`);
