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
const { queueKey, queueFile, lock } = require('../limits.js');

const MIN = 60e3;
const NOW = Date.UTC(2026, 10, 8, 12);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meatsuit-wheel-'));

  // Нет руля — null; взяли — действует до срока; срок вышел — null; битый файл — как нет руля.
  assert.equal(wheelState({ dir, now: NOW }), null);
  assert.deepEqual(await takeWheel({ dir, minutes: 30, now: NOW }), { by: 'owner', since: NOW, until: NOW + 30 * MIN });
  assert.deepEqual(wheelState({ dir, now: NOW + 30 * MIN - 1 }), { by: 'owner', since: NOW, until: NOW + 30 * MIN });
  assert.equal(wheelState({ dir, now: NOW + 30 * MIN }), null, 'срок вышел — руль свободен');
  assert.deepEqual(fs.readdirSync(dir), ['wheel.json'], 'временный файл не остаётся');
  fs.writeFileSync(path.join(dir, 'wheel.json'), '{"until":');
  assert.equal(wheelState({ dir, now: NOW }), null, 'битый файл не держит ботов');
  for (const bad of [0, -1, 1441, '5', NaN]) await assert.rejects(takeWheel({ dir, minutes: bad, now: NOW }), /minutes/);
  assert.throws(() => wheelState({}), /нужен dir/);

  // Повторное взятие не укорачивает срок; отдать — released по действующему рулю.
  await takeWheel({ dir, minutes: 60, now: NOW });
  assert.equal((await takeWheel({ dir, minutes: 5, now: NOW + MIN })).until, NOW + 60 * MIN, 'короче не стал');
  assert.deepEqual(await releaseWheel({ dir, now: NOW + MIN }), { released: true });
  assert.deepEqual(await releaseWheel({ dir, now: NOW + MIN }), { released: false });
  assert.equal(wheelState({ dir, now: NOW + MIN }), null);

  // Руль хозяина сильнее зеркального: «да» от зеркала его не перепишет, «нет» от зеркала его не снимет.
  await takeWheel({ dir, minutes: 60, now: NOW });
  assert.equal((await takeWheel({ dir, minutes: 0.5, by: 'mirror', now: NOW + MIN })).by, 'owner');
  assert.deepEqual(await releaseWheel({ dir, by: 'mirror', now: NOW + MIN }), { released: false });
  assert.equal(wheelState({ dir, now: NOW + MIN }).by, 'owner');
  await releaseWheel({ dir });

  // Источников руля зеркала бывает несколько (сервис wheel стека, ownerPresent разных connect): они не спорят. «Нет»
  // одного не снимает руль, который держит «да» другого; руль свободен, когда «нет» сказали все, кто говорил «да»,
  // или их срок вышел. Отданный руками руль (без by) снимает всё.
  const S = 30e3;
  await takeWheel({ dir, by: 'mirror', minutes: S / MIN, source: 'wheel-watch', now: NOW });
  assert.deepEqual(await releaseWheel({ dir, by: 'mirror', source: 'connect:1', now: NOW + 1000 }), { released: false });
  assert.equal(wheelState({ dir, now: NOW + 1000 }).by, 'mirror', '«нет» другого источника сняло руль');
  await takeWheel({ dir, by: 'mirror', minutes: S / MIN, source: 'connect:1', now: NOW + 2000 });
  assert.deepEqual(await releaseWheel({ dir, by: 'mirror', source: 'wheel-watch', now: NOW + 3000 }), { released: false });
  assert.deepEqual(wheelState({ dir, now: NOW + 3000 }), { by: 'mirror', since: NOW, until: NOW + 2000 + S }, 'держит оставшееся «да»');
  assert.deepEqual(await releaseWheel({ dir, by: 'mirror', source: 'connect:1', now: NOW + 4000 }), { released: true });
  assert.equal(wheelState({ dir, now: NOW + 4000 }), null);
  // Чужое «да» истекло — оно уже не держит.
  await takeWheel({ dir, by: 'mirror', minutes: S / MIN, source: 'a', now: NOW });
  await takeWheel({ dir, by: 'mirror', minutes: S / MIN, source: 'b', now: NOW + 20e3 });
  assert.deepEqual(await releaseWheel({ dir, by: 'mirror', source: 'b', now: NOW + 40e3 }), { released: true }, 'истёкшее «да» держит руль');
  // Руками: give снимает и руль зеркала с несколькими источниками.
  await takeWheel({ dir, by: 'mirror', minutes: S / MIN, source: 'a', now: NOW });
  await takeWheel({ dir, by: 'mirror', minutes: S / MIN, source: 'b', now: NOW });
  assert.deepEqual(await releaseWheel({ dir, now: NOW + 1000 }), { released: true });
  assert.equal(wheelState({ dir, now: NOW + 1000 }), null);
  // Два connect одного dir с разными ответами ownerPresent: руль держится, пока хоть один говорит «да».
  WHEEL.pollMs = 0;
  const yes = watcher({ dir, ownerPresent: async () => true });
  const no = watcher({ dir, ownerPresent: async () => false });
  for (let i = 0; i < 3; i++) {
    await yes.held();
    assert.equal((await no.held())?.by, 'mirror', `опрос ${i}: «нет» одного connect сняло «да» другого`);
  }
  WHEEL.pollMs = 2000;
  await releaseWheel({ dir });

  // Прочитать-решить-записать — под коротким замком <dir>/wheel.lock: «да» зеркала (другой процесс) и хозяин с
  // tools/wheel.js не затирают друг друга. Пока замок держит другой, ни взять, ни отдать руль нельзя; после — можно,
  // и замок не остаётся.
  for (const [what, call] of [['takeWheel', () => takeWheel({ dir, minutes: 5 })], ['releaseWheel', () => releaseWheel({ dir })]]) {
    const other = await lock(path.join(dir, 'wheel.lock'), { pollMs: 10 });
    let done = false;
    const pending = call().then((r) => { done = true; return r; });
    await sleep(200);
    assert.equal(done, false, `${what} не ждёт wheel.lock`);
    other();
    await pending;
    assert.equal(done, true);
  }
  assert.equal(wheelState({ dir }), null);
  assert.ok(!fs.existsSync(path.join(dir, 'wheel.lock')), 'wheel.lock остался');

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
  await releaseWheel({ dir });
  const broken = watcher({ dir, ownerPresent: async () => { throw new Error('Neko молчит'); } });
  assert.equal(await broken.held(), null, 'сбой ownerPresent — хозяина нет');
  WHEEL.pollMs = 60e3;
  const before = calls;
  const lazy = watcher({ dir, ownerPresent: async () => { calls++; return false; } });
  await lazy.held(); await lazy.held(); await lazy.held();
  assert.equal(calls - before, 1, 'ownerPresent спрашивается не чаще раза в pollMs');
  assert.throws(() => watcher({ dir, ownerPresent: 'да' }), /ownerPresent/);

  // start(): ownerPresent спрашивается раз в pollMs всё время, пока жив connect, и без задач — простаивающий
  // вызывающий с ownerPresent держит руль и для вызывающих без него; stop() (close, обрыв связи) — больше не спрашивает.
  WHEEL.pollMs = 30;
  let ticks = 0, here = true;
  const idle = watcher({ dir, ownerPresent: async () => { ticks++; return here; } });
  idle.start();
  idle.start(); // второй раз — тот же опрос, не второй
  await sleep(250);
  assert.ok(ticks >= 3 && ticks <= 12, `ownerPresent спросили ${ticks} раз за 250 мс при pollMs 30`);
  assert.equal(wheelState({ dir }).by, 'mirror', 'простаивающий вызывающий не поставил руль');
  here = false;
  await sleep(120);
  assert.equal(wheelState({ dir }), null, '«нет» снимает руль и без задач');
  idle.stop();
  const stoppedAt = ticks;
  await sleep(150);
  assert.equal(ticks, stoppedAt, 'после stop() ownerPresent спрашивают дальше');
  const plainIdle = watcher({ dir });
  plainIdle.start(); plainIdle.stop(); // без ownerPresent спрашивать некого
  // Сбой записи руля в опросе не роняет процесс (некому поймать): строка в stderr, опрос идёт дальше.
  const noDir = path.join(dir, 'файл');
  fs.writeFileSync(noDir, '');
  let failedTicks = 0;
  const errs = [];
  const origErr = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  const bad = watcher({ dir: noDir, ownerPresent: async () => { failedTicks++; return true; } });
  bad.start();
  await sleep(150);
  bad.stop();
  console.error = origErr;
  assert.ok(failedTicks >= 2, 'после сбоя записи опрос остановился');
  assert.ok(errs.length === 1 && /руль/.test(errs[0]), `сбой записи — одна строка в stderr: ${JSON.stringify(errs)}`);
  fs.rmSync(noDir);

  // tools/wheel.js: take, статус, give — в той же папке, без браузера.
  const cli = (...a) => spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'wheel.js'), ...a, '--dir', dir], { encoding: 'utf8' });
  let r = cli('take', '15');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /руль у owner до (\d\d\.\d\d )?\d\d:\d\d: боты ждут/); // у полуночи — с датой
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
