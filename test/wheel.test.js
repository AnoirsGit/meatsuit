/**
 * Руль хозяина (wheel.js) и ключ очереди площадки (queueKey в limits.js) — без браузера. Что руль делает с задачами
 * в браузере, проверяет test/parallel.test.js.
 *
 *   node test/wheel.test.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { wheelState, takeWheel, releaseWheel, watcher, WHEEL } = require('../wheel.js');
const { queueKey, queueFile } = require('../limits.js');

const MIN = 60e3;
const NOW = Date.UTC(2026, 10, 8, 12);

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meatsuit-wheel-'));

  // Нет руля — null; взяли — действует до срока; срок вышел — null; битый файл — как нет руля.
  assert.equal(wheelState({ dir, now: NOW }), null);
  assert.deepEqual(takeWheel({ dir, minutes: 30, now: NOW }), { by: 'owner', since: NOW, until: NOW + 30 * MIN });
  assert.deepEqual(wheelState({ dir, now: NOW + 30 * MIN - 1 }), { by: 'owner', since: NOW, until: NOW + 30 * MIN });
  assert.equal(wheelState({ dir, now: NOW + 30 * MIN }), null, 'срок вышел — руль свободен');
  assert.deepEqual(fs.readdirSync(dir), ['wheel.json'], 'временный файл не остаётся');
  fs.writeFileSync(path.join(dir, 'wheel.json'), '{"until":');
  assert.equal(wheelState({ dir, now: NOW }), null, 'битый файл не держит ботов');
  for (const bad of [0, -1, 1441, '5', NaN]) assert.throws(() => takeWheel({ dir, minutes: bad, now: NOW }), /minutes/);
  assert.throws(() => wheelState({}), /нужен dir/);

  // Повторное взятие не укорачивает срок; отдать — released по действующему рулю.
  takeWheel({ dir, minutes: 60, now: NOW });
  assert.equal(takeWheel({ dir, minutes: 5, now: NOW + MIN }).until, NOW + 60 * MIN, 'короче не стал');
  assert.deepEqual(releaseWheel({ dir, now: NOW + MIN }), { released: true });
  assert.deepEqual(releaseWheel({ dir, now: NOW + MIN }), { released: false });
  assert.equal(wheelState({ dir, now: NOW + MIN }), null);

  // Руль хозяина сильнее зеркального: «да» от зеркала его не перепишет, «нет» от зеркала его не снимет.
  takeWheel({ dir, minutes: 60, now: NOW });
  assert.equal(takeWheel({ dir, minutes: 0.5, by: 'mirror', now: NOW + MIN }).by, 'owner');
  assert.deepEqual(releaseWheel({ dir, by: 'mirror', now: NOW + MIN }), { released: false });
  assert.equal(wheelState({ dir, now: NOW + MIN }).by, 'owner');
  releaseWheel({ dir });

  // watcher: ownerPresent «да» — руль by: 'mirror' на mirrorTtlMs, его видит и watcher без ownerPresent (тот же dir);
  // «нет» снимает зеркальный руль; сбой функции — «хозяина нет», руль не ставится. Спрашивает не чаще pollMs.
  WHEEL.pollMs = 0;
  let present = true, calls = 0;
  const wired = watcher({ dir, ownerPresent: async () => { calls++; return { present }; } });
  const plain = watcher({ dir });
  const w = await wired.held();
  assert.equal(w.by, 'mirror');
  assert.ok(w.until > Date.now() && w.until <= Date.now() + WHEEL.mirrorTtlMs);
  assert.equal((await plain.held()).by, 'mirror', 'без ownerPresent руль виден через dir');
  present = false;
  assert.equal(await wired.held(), null);
  assert.equal(await plain.held(), null);
  assert.equal(await watcher({ dir, ownerPresent: async () => true }).held().then((x) => x.by), 'mirror', 'ответ true тоже годится');
  releaseWheel({ dir });
  const broken = watcher({ dir, ownerPresent: async () => { throw new Error('Neko молчит'); } });
  assert.equal(await broken.held(), null, 'сбой ownerPresent — хозяина нет');
  WHEEL.pollMs = 60e3;
  const before = calls;
  const lazy = watcher({ dir, ownerPresent: async () => { calls++; return false; } });
  await lazy.held(); await lazy.held(); await lazy.held();
  assert.equal(calls - before, 1, 'ownerPresent спрашивается не чаще раза в pollMs');
  assert.throws(() => watcher({ dir, ownerPresent: 'да' }), /ownerPresent/);

  // tools/wheel.js: take, статус, give — в той же папке, без браузера.
  const cli = (...a) => spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'wheel.js'), ...a, '--dir', dir], { encoding: 'utf8' });
  let r = cli('take', '15');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /руль у owner до \d\d:\d\d: боты ждут/);
  assert.ok(wheelState({ dir }).until - Date.now() > 14 * MIN);
  assert.match(cli().stdout, /руль у owner/);
  assert.match(cli('give').stdout, /руль отдан/);
  assert.match(cli().stdout, /руль свободен/);
  assert.equal(cli('take', '0').status, 1);
  assert.equal(cli('крути').status, 2);

  // Ключ очереди: поддомены с площадкой вместе (вкладку площадки ищут по поддоменам), разные площадки порознь.
  assert.equal(queueKey('web.telegram.org'), queueKey('telegram.org'));
  assert.equal(queueKey('www.LinkedIn.com'), 'linkedin.com');
  assert.notEqual(queueKey('tinder.com'), queueKey('hh.kz'));
  assert.notEqual(queueKey('a.test'), queueKey('b.test'));
  assert.equal(queueKey('x.y.a.test'), 'a.test');
  assert.equal(queueKey('127.0.0.1'), '127.0.0.1');
  assert.equal(queueKey('x.localhost'), 'localhost');
  assert.equal(queueFile('/s', 'web.telegram.org'), path.join('/s', 'queue', 'telegram.org.lock'));

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('wheel.test: ok');
})().catch((e) => { console.error(e); process.exit(1); });
