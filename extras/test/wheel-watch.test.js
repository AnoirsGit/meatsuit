/**
 * Руль от зеркала (wheel-watch.js): пока хозяин держит управление в Neko, руль ботов (<dir>/wheel.json, wheel.js ядра)
 * взят и продлевается; ушёл — снят, а ручной руль не трогается никогда. Сеть подставная (формы ответов Neko 3.1.6,
 * как в presence.test.js), время подставное, dir — временная папка. Последний тест — сам процесс с настоящим HTTP
 * на 127.0.0.1: конфиг, SIGTERM.
 *
 *   node --test test/wheel-watch.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createPresence } = require('../presence.js');
const { createWheelWatch } = require('../wheel-watch.js');
const { wheelState, takeWheel, WHEEL } = require('../../wheel.js');

const MIN = 60e3;
const NOW = Date.UTC(2026, 10, 8, 12);
const TTL = WHEEL.mirrorTtlMs;
const PASS = 'admin-pass-0123456789';
const CLI = path.join(__dirname, '..', 'wheel-watch.js');

/** Подставной Neko: has_host, сессия хоста, сбой сети, отказ во входе (как в presence.test.js). */
function fakeNeko() {
  const n = { calls: [], hasHost: false, hostGone: false, down: false, downMessage: 'fetch failed', loginStatus: 200 };
  n.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const auth = init.headers && init.headers.authorization;
    n.calls.push([init.method || 'GET', u.pathname, auth ? 'auth' : 'anon']);
    if (n.down) throw new Error(n.downMessage);
    const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
    if (u.pathname === '/api/login') return n.loginStatus === 200 ? json(200, { token: 'tok-1' }) : json(n.loginStatus, { message: 'wrong password' });
    if (!auth) return json(401, {});
    if (u.pathname === '/api/room/control') return json(200, n.hasHost ? { has_host: true, host_id: 'owner-1' } : { has_host: false });
    if (u.pathname === '/api/sessions') return json(200, [{ id: 'owner-1', state: { is_connected: !n.hostGone } }]);
    if (u.pathname === '/api/logout') return json(200, {});
    return json(404, {});
  };
  return n;
}

function setup(t, { dir } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-wheel-watch-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  dir = dir ? dir(tmp) : tmp;
  const neko = fakeNeko();
  const clock = { t: NOW };
  const lines = [];
  const presence = createPresence({ url: 'http://neko.test:8080', password: PASS, fetch: neko.fetch, now: () => clock.t });
  const watch = createWheelWatch({ dir, presence, now: () => clock.t, log: (l) => lines.push(l), hide: [PASS] });
  const tick = async (ms = 2500) => { clock.t += ms; return watch.step(); };
  const state = () => wheelState({ dir, now: clock.t });
  return { dir, neko, clock, lines, watch, tick, state, file: path.join(dir, 'wheel.json') };
}

test('хозяин у руля в зеркале: руль by mirror на WHEEL.mirrorTtlMs, каждый опрос продлевает; в журнале одна строка', async (t) => {
  const s = setup(t);
  s.neko.hasHost = true;
  assert.equal((await s.watch.step()).state, 'present');
  assert.deepEqual(s.state(), { by: 'mirror', since: NOW, until: NOW + TTL });
  for (let i = 1; i <= 20; i++) {
    await s.tick();
    assert.deepEqual(s.state(), { by: 'mirror', since: NOW, until: s.clock.t + TTL }, `опрос ${i}`);
  }
  assert.ok(TTL >= 30e3 && TTL <= 45e3, `короткий срок: ${TTL} мс`);
  assert.equal(s.lines.length, 1, s.lines.join('\n'));
  assert.match(s.lines[0], /управлени/);
});

test('сервис wheel и ownerPresent какого-то connect не спорят: «нет» одного не снимает «да» другого', async (t) => {
  const { releaseWheel, takeWheel: take } = require('../../wheel.js');
  const s = setup(t);
  s.neko.hasHost = true;
  await s.watch.step();
  // connect, у которого ownerPresent ответил «нет» (или бросил — для ядра это «нет»), отдаёт свой руль зеркала.
  assert.deepEqual(await releaseWheel({ dir: s.dir, by: 'mirror', source: 'connect:1', now: s.clock.t + 100 }), { released: false });
  assert.equal(s.state().by, 'mirror', 'ownerPresent «нет» сняло руль, который держит сервис');
  // Наоборот: connect держит «да», сервис видит, что хозяина нет, — руль остаётся за connect.
  await take({ dir: s.dir, by: 'mirror', minutes: TTL / MIN, source: 'connect:1', now: s.clock.t + 200 });
  s.neko.hasHost = false;
  await s.tick();
  assert.equal(s.state()?.by, 'mirror', 'сервис снял руль, который держит connect');
  assert.match(s.lines.at(-1), /хозяин не держит управление/);
});

test('хозяин ушёл: руль зеркала снят сразу; Neko замолчал — руль не продлевается и кончается сам', async (t) => {
  const s = setup(t);
  s.neko.hasHost = true;
  await s.watch.step();
  s.neko.hasHost = false;
  assert.equal((await s.tick()).state, 'absent');
  assert.equal(s.state(), null, 'руль зеркала снят');
  assert.equal(fs.existsSync(s.file), false);

  s.neko.hasHost = true;
  await s.tick();
  const { until } = s.state();
  s.neko.down = true; // Neko не отвечает: «не знаю», а не «нет» — руль не снимается и не продлевается
  for (let i = 0; i < 11; i++) {
    assert.equal((await s.tick()).state, 'error');
    if (s.clock.t < until) assert.equal(s.state().until, until, 'не продлён');
  }
  s.clock.t = until - 1;
  assert.equal(s.state().by, 'mirror');
  s.clock.t = until;
  assert.equal(s.state(), null, 'кончился сам через WHEEL.mirrorTtlMs после последнего «да»');
});

test('ручной длинный руль зеркало не трогает: by, since и until те же, файл тот же', async (t) => {
  const s = setup(t);
  const manual = await takeWheel({ dir: s.dir, minutes: 60, now: NOW - MIN });
  const before = fs.readFileSync(s.file, 'utf8');
  s.neko.hasHost = true;
  for (let i = 0; i < 10; i++) assert.equal((await s.tick()).state, 'present');
  assert.deepEqual(s.state(), manual);
  assert.equal(fs.readFileSync(s.file, 'utf8'), before);
  assert.match(s.lines.join('\n'), /руками/, 'в журнале сказано, что руль ручной');
});

test('ручной руль зеркало не снимает никогда: ни «нет», ни хост без сессии, ни короткий, который зеркало продлило', async (t) => {
  const s = setup(t);
  const manual = await takeWheel({ dir: s.dir, minutes: 60, now: NOW });
  for (const [hasHost, hostGone] of [[false, false], [true, true]]) {
    Object.assign(s.neko, { hasHost, hostGone });
    for (let i = 0; i < 3; i++) assert.equal((await s.tick()).state, 'absent');
    assert.deepEqual(s.state(), manual, `has_host ${hasHost}, сессия хоста подключена: ${!hostGone}`);
  }

  // Короткий ручной руль, хозяин в зеркале дольше его срока: зеркало держит его (как ядро для ownerPresent),
  // но руль остаётся ручным, и «нет» его не снимает — он сам кончается через WHEEL.mirrorTtlMs.
  fs.rmSync(s.file);
  const short = await takeWheel({ dir: s.dir, minutes: 1, now: s.clock.t });
  Object.assign(s.neko, { hasHost: true, hostGone: false });
  for (let i = 0; i < 40; i++) await s.tick(); // 100 с, дольше минуты
  const held = s.state();
  assert.deepEqual(held, { by: 'owner', since: short.since, until: s.clock.t + TTL });
  s.neko.hasHost = false;
  await s.tick();
  assert.deepEqual(s.state(), held, '«нет» ручной руль не снял');
  s.clock.t = held.until;
  assert.equal(s.state(), null);

  // Руль, взятый под другим именем (не 'mirror'), тоже чужой.
  const other = await takeWheel({ dir: s.dir, minutes: 5, by: 'cron', now: s.clock.t });
  await s.tick();
  assert.deepEqual(s.state(), other);
});

test('хост закрыл зеркало, не отпустив управление (сессия не подключена): хозяина нет, руль не берётся, взятый снят', async (t) => {
  const s = setup(t);
  Object.assign(s.neko, { hasHost: true, hostGone: true });
  assert.equal((await s.watch.step()).state, 'absent');
  assert.equal(s.state(), null, 'руль не взят');
  assert.ok(s.neko.calls.some((c) => c[1] === '/api/sessions'), 'подключённость хоста не проверялась');

  s.neko.hostGone = false;
  await s.tick();
  assert.equal(s.state().by, 'mirror');
  s.neko.hostGone = true;
  assert.equal((await s.tick()).state, 'absent');
  assert.equal(s.state(), null, 'руль зеркала снят');
  assert.match(s.lines.at(-1), /отключ/);
});

test('сбои не роняют опрос и не засоряют журнал: строка на смену состояния, пароля в журнале нет', async (t) => {
  const s = setup(t);
  s.neko.down = true;
  for (let i = 0; i < 20; i++) assert.equal((await s.tick()).state, 'error');
  assert.equal(s.lines.length, 1, s.lines.join('\n'));
  assert.match(s.lines[0], /Neko/);
  s.neko.down = false;
  s.neko.loginStatus = 401; // другая ошибка — то же состояние
  for (let i = 0; i < 5; i++) assert.equal((await s.tick()).state, 'error');
  assert.equal(s.lines.length, 1, 'смена текста ошибки — не новая строка');
  s.neko.loginStatus = 200;
  for (let i = 0; i < 5; i++) assert.equal((await s.tick()).state, 'absent');
  assert.equal(s.lines.length, 2, 'Neko снова отвечает — одна строка');
  s.neko.downMessage = `connect ECONNREFUSED ${PASS}`;
  s.neko.down = true;
  await s.tick();
  assert.equal(s.lines.length, 3);
  assert.ok(!s.lines.join('\n').includes(PASS), 'пароль в журнале');

  // Руль не записать (на месте папки файл): step не бросает, одна строка, потом опросы идут дальше.
  const bad = setup(t, { dir: (tmp) => { const f = path.join(tmp, 'not-a-dir'); fs.writeFileSync(f, ''); return f; } });
  bad.neko.hasHost = true;
  for (let i = 0; i < 5; i++) assert.equal((await bad.tick()).state, 'wheel-error');
  assert.equal(bad.lines.length, 1, bad.lines.join('\n'));
  assert.match(bad.lines[0], /руль/);
});

test('run: опрос раз в everyMs; stop() дожидается опроса, выходит из Neko и руль не отпускает', async (t) => {
  const s = setup(t);
  s.neko.hasHost = true;
  const sleeps = [];
  await s.watch.run({ everyMs: 2500, sleep: async (ms) => { sleeps.push(ms); s.clock.t += ms; if (sleeps.length === 3) s.watch.stop(); } });
  assert.deepEqual(sleeps, [2500, 2500, 2500]);
  assert.equal(s.neko.calls.filter((c) => c[1] === '/api/room/control').length, 3);
  assert.deepEqual(s.neko.calls.at(-1), ['POST', '/api/logout', 'auth']);
  assert.equal(s.state().by, 'mirror', 'перезапуск контейнера не должен отпускать ботов: руль кончится сам');
});

/** Тот же подставной Neko по настоящему HTTP на 127.0.0.1. */
async function nekoServer(t, neko) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const r = await neko.fetch(`http://127.0.0.1${req.url}`, { method: req.method, headers: req.headers, body });
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(await r.json()));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

function runCli(args, env) {
  const child = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, TZ: 'UTC', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { stdout: '', stderr: '', code: undefined };
  child.stdout.on('data', (c) => { out.stdout += c; });
  child.stderr.on('data', (c) => { out.stderr += c; });
  out.exited = new Promise((r) => child.on('exit', (code, signal) => { out.code = code; out.signal = signal; r(out); }));
  out.child = child;
  return out;
}

async function until(fn, ms = 10e3) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error('не дождались');
}

test('процесс: без адреса, пароля или папки — одна строка и код 2, пароль не печатается; SIGTERM — чистый выход', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-wheel-watch-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [env, re] of [
    [{ NEKO_ADMIN_PASSWORD: PASS }, /MEATSUIT_NEKO_URL/],
    [{ MEATSUIT_NEKO_URL: 'http://127.0.0.1:9' }, /NEKO_ADMIN_PASSWORD/],
    [{ MEATSUIT_NEKO_URL: 'http://127.0.0.1:9', NEKO_ADMIN_PASSWORD: PASS, MEATSUIT_DIR: path.join(dir, 'нет') }, /нет папки/],
  ]) {
    const r = await runCli([], env).exited;
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, re);
    assert.equal(r.stderr.trim().split('\n').length, 1, r.stderr);
    assert.ok(!(r.stdout + r.stderr).includes(PASS));
  }

  const neko = fakeNeko();
  neko.hasHost = true;
  const url = await nekoServer(t, neko);
  const p = runCli(['--dir', dir, '--every', '0.05'], { MEATSUIT_NEKO_URL: `${url}/`, NEKO_ADMIN_PASSWORD: PASS });
  t.after(() => p.child.kill('SIGKILL'));
  await until(() => wheelState({ dir }));
  assert.equal(wheelState({ dir }).by, 'mirror');
  const polls = neko.calls.length;
  await until(() => neko.calls.length > polls + 4); // опросы идут
  p.child.kill('SIGTERM');
  const r = await p.exited;
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(neko.calls.at(-1), ['POST', '/api/logout', 'auth'], 'вышел из Neko');
  assert.ok(wheelState({ dir }), 'руль остался и кончится сам');
  assert.ok(!(r.stdout + r.stderr).includes(PASS), 'пароль в выводе');
  assert.ok(r.stdout.trim().split('\n').length <= 3, `строк на смену состояния, не на опрос:\n${r.stdout}`);
});
