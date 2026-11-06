/**
 * Стоп площадки после NeedsHuman (holds.js): срок, истечение, снятие руками, CLI tools/release.js. Без браузера.
 * В браузере то же проверяет test/task.test.js.
 *
 *   node test/holds.test.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const holds = require('../holds.js');

const H = 3600e3;
const NOW = Date.UTC(2026, 0, 10, 12);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meatsuit-holds-'));

// holdHours: по умолчанию 6, 0 можно (стоп не ставить), остальное — ошибка.
assert.equal(holds.holdHours({}), 6);
assert.equal(holds.holdHours(undefined), 6);
assert.equal(holds.holdHours({ holdHours: 0 }), 0);
assert.equal(holds.holdHours({ holdHours: 1.5 }), 1.5);
for (const bad of [-1, '6', null, NaN, Infinity]) assert.throws(() => holds.holdHours({ holdHours: bad }), /holdHours/);

// Нет стопа — null; 0 часов — стоп не ставится.
assert.equal(holds.holdState('a.test', { dir, now: NOW }), null);
assert.equal(holds.hold('a.test', { dir, reason: 'капча', hours: 0, now: NOW }), null);
assert.equal(holds.holdState('a.test', { dir, now: NOW }), null);

// Поставили: действует до since + hours, на другие площадки не влияет, после срока — null.
const h = holds.hold('a.test', { dir, reason: 'капча', url: 'https://a.test/x', hours: 6, now: NOW });
assert.deepEqual(h, { site: 'a.test', reason: 'капча', url: 'https://a.test/x', since: NOW, until: NOW + 6 * H });
assert.deepEqual(holds.holdState('a.test', { dir, now: NOW + 6 * H - 1 }), h);
assert.equal(holds.holdState('b.test', { dir, now: NOW }), null, 'стоп одной площадки не трогает другую');
assert.equal(holds.holdState('a.test', { dir, now: NOW + 6 * H }), null, 'срок вышел — стопа нет');
assert.deepEqual(fs.readdirSync(path.join(dir, 'holds')), ['a.test.json'], 'временный файл не остаётся');

// Снять руками: был действующий — released true; повторно — false; истёкший — false, файл всё равно убран.
assert.deepEqual(holds.releaseHold('a.test', { dir, now: NOW }), { released: true });
assert.equal(holds.holdState('a.test', { dir, now: NOW }), null);
assert.deepEqual(holds.releaseHold('a.test', { dir, now: NOW }), { released: false });
holds.hold('a.test', { dir, reason: 'капча', hours: 1, now: NOW });
assert.deepEqual(holds.releaseHold('a.test', { dir, now: NOW + 2 * H }), { released: false });
assert.deepEqual(fs.readdirSync(path.join(dir, 'holds')), []);

// Битый файл не держит площадку вечно.
fs.writeFileSync(path.join(dir, 'holds', 'a.test.json'), '{');
assert.equal(holds.holdState('a.test', { dir, now: NOW }), null);
fs.writeFileSync(path.join(dir, 'holds', 'a.test.json'), JSON.stringify({ reason: 'x' }));
assert.equal(holds.holdState('a.test', { dir, now: NOW }), null, 'без until — не стоп');
holds.releaseHold('a.test', { dir });

// clock: сегодня — только время, другой день — с датой.
const today = new Date(2026, 0, 10, 20, 5).getTime();
assert.equal(holds.clock(today, new Date(2026, 0, 10, 14, 0).getTime()), '20:05');
assert.equal(holds.clock(new Date(2026, 0, 11, 3, 15).getTime(), today), '11.01 03:15');

// CLI: список стопов и снятие; dir из --dir.
const cli = (...a) => spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'release.js'), ...a], { encoding: 'utf8', env: { PATH: process.env.PATH } });
assert.match(cli('--dir', dir).stdout, /стопов нет/);
holds.hold('tinder.com', { dir, reason: 'капча', hours: 6 });
assert.match(cli('--dir', dir).stdout, /tinder\.com: стоп до .* — капча/);
let r = cli('tinder.com', '--dir', dir);
assert.equal(r.status, 0, r.stderr);
assert.match(r.stdout, /tinder\.com: стоп снят/);
assert.equal(holds.holdState('tinder.com', { dir }), null);
assert.match(cli('--dir', dir, 'tinder.com').stdout, /стопа не было/);
assert.ok(cli('--dir', dir, 'tinder.com').stdout.includes(`стопа не было (${dir}; `), 'папка видна: стоп мог лежать в другой');
r = cli('--dir');
assert.equal(r.status, 1);
// Без --dir — MEATSUIT_DIR (так команду печатает сообщение о стопе).
holds.hold('tinder.com', { dir, reason: 'капча', hours: 6 });
r = spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'release.js'), 'tinder.com'], { encoding: 'utf8', env: { PATH: process.env.PATH, MEATSUIT_DIR: dir } });
assert.match(r.stdout, /tinder\.com: стоп снят/, r.stdout + r.stderr);
assert.equal(holds.holdState('tinder.com', { dir }), null);

fs.rmSync(dir, { recursive: true, force: true });
console.log('holds.test: ok');
