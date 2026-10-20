/**
 * Присутствие хозяина (presence.js): вход в Neko, has_host, повторный вход на 401, кэш, сбои.
 * Сеть подставная: формы ответов списаны с Neko 3.1.6.
 *
 *   node --test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPresence, fromEnv } = require('../presence.js');

/** Подставной Neko: журнал запросов, управляемые ответы. */
function fakeNeko() {
  const n = { calls: [], hasHost: false, hostId: 'owner-1', logins: 0, tokenOk: true, down: false, loginStatus: 200 };
  n.fetch = async (url, init = {}) => {
    const u = new URL(url);
    n.calls.push([init.method || 'GET', u.pathname, init.headers && init.headers.authorization ? 'auth' : 'anon']);
    if (n.down) throw new Error('fetch failed');
    const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
    if (u.pathname === '/api/login') {
      if (n.loginStatus !== 200) return json(n.loginStatus, { message: 'wrong password' });
      n.logins++;
      n.tokenOk = true; // новый вход даёт токен, который Neko принимает
      const body = JSON.parse(init.body);
      return json(200, { id: `${body.username}-x`, token: `tok-${n.logins}`, profile: { name: body.username, is_admin: true }, state: { is_connected: false, is_watching: false } });
    }
    const auth = init.headers && init.headers.authorization;
    if (!auth || !n.tokenOk) return json(401, { message: 'unauthorized' });
    if (u.pathname === '/api/room/control') return json(200, n.hasHost ? { has_host: true, host_id: n.hostId } : { has_host: false });
    if (u.pathname === '/api/sessions') return json(200, [{ id: n.hostId, profile: { name: 'owner', is_admin: false }, state: { is_connected: !n.hostGone, is_watching: !n.hostGone } }]);
    if (u.pathname === '/api/logout') return json(200, {});
    return json(404, {});
  };
  return n;
}

test('без адреса Neko присутствие выключено и ничего не спрашивает', async () => {
  const neko = fakeNeko();
  const p = createPresence({ fetch: neko.fetch });
  assert.deepEqual(await p.check(), { present: false, disabled: true });
  assert.equal(p.enabled, false);
  assert.equal(neko.calls.length, 0);
});

test('входит один раз, спрашивает room/control: нет хоста — не присутствует, есть — присутствует с id', async () => {
  const neko = fakeNeko();
  const clock = { t: 0 };
  const p = createPresence({ url: 'http://neko.test:8080/', username: 'ms', password: 'admin-pass', fetch: neko.fetch, now: () => clock.t, ttlMs: 5000 });
  assert.deepEqual(await p.check(), { present: false });
  assert.deepEqual(neko.calls, [['POST', '/api/login', 'anon'], ['GET', '/api/room/control', 'auth']]);
  neko.hasHost = true;
  assert.deepEqual(await p.check(), { present: false }, 'в пределах ttl отдаётся кэш');
  clock.t = 5001;
  assert.deepEqual(await p.check(), { present: true, hostId: 'owner-1' });
  assert.equal(neko.logins, 1, 'вход повторно не делается');
  assert.deepEqual(await p.check({ force: true }), { present: true, hostId: 'owner-1' });
  assert.deepEqual(p.last(), { present: true, hostId: 'owner-1' });
});

test('хост закрыл зеркало, не отпустив управление: сессия хоста не подключена — хозяина нет', async () => {
  const neko = fakeNeko();
  const p = createPresence({ url: 'http://neko.test', password: 'admin-pass', fetch: neko.fetch, ttlMs: 0 });
  neko.hasHost = true;
  assert.deepEqual(await p.check(), { present: true, hostId: 'owner-1' });
  assert.ok(neko.calls.some((c) => c[1] === '/api/sessions'), 'подключённость хоста не проверялась');
  neko.hostGone = true;
  assert.deepEqual(await p.check(), { present: false, hostId: 'owner-1', stale: true });
  neko.hasHost = false;
  const before = neko.calls.length;
  assert.deepEqual(await p.check(), { present: false });
  assert.ok(!neko.calls.slice(before).some((c) => c[1] === '/api/sessions'), 'без хоста sessions не спрашивается');
});

test('токен перестал приниматься (Neko перезапущен): повторный вход и ответ без ошибки', async () => {
  const neko = fakeNeko();
  const p = createPresence({ url: 'http://neko.test', password: 'admin-pass', fetch: neko.fetch, ttlMs: 0 });
  await p.check();
  neko.tokenOk = false; // Neko перезапущен: старый токен больше не принимает
  const calls = neko.calls.length;
  assert.deepEqual(await p.check(), { present: false });
  assert.deepEqual(neko.calls.slice(calls).map((c) => c[1]), ['/api/room/control', '/api/login', '/api/room/control']);
  assert.equal(neko.logins, 2);
});

test('Neko недоступен или пароль не тот: present false с error, сервис не падает; без пароля — понятная ошибка', async () => {
  const neko = fakeNeko();
  neko.down = true;
  const p = createPresence({ url: 'http://neko.test', password: 'admin-pass', fetch: neko.fetch, ttlMs: 0 });
  const r = await p.check();
  assert.equal(r.present, false);
  assert.match(r.error, /fetch failed/);
  neko.down = false;
  neko.loginStatus = 401;
  const bad = await p.check();
  assert.deepEqual([bad.present, /HTTP 401/.test(bad.error)], [false, true]);
  const noPass = createPresence({ url: 'http://neko.test', fetch: neko.fetch, ttlMs: 0 });
  assert.match((await noPass.check()).error, /NEKO_ADMIN_PASSWORD/);
});

test('одновременные check идут одним запросом; logout снимает сессию и забывает токен', async () => {
  const neko = fakeNeko();
  const p = createPresence({ url: 'http://neko.test', password: 'admin-pass', fetch: neko.fetch, ttlMs: 0 });
  await Promise.all([p.check(), p.check(), p.check()]);
  assert.equal(neko.calls.filter((c) => c[1] === '/api/room/control').length, 1);
  await p.logout();
  assert.deepEqual(neko.calls.at(-1), ['POST', '/api/logout', 'auth']);
  await p.check();
  assert.equal(neko.logins, 2, 'после logout вход заново');
});

test('fromEnv: адрес и пароль из окружения; без адреса выключено', async () => {
  const neko = fakeNeko();
  const p = fromEnv({ MEATSUIT_NEKO_URL: 'http://neko.test', NEKO_ADMIN_PASSWORD: 'admin-pass' }, { fetch: neko.fetch });
  assert.equal(p.enabled, true);
  assert.deepEqual(await p.check(), { present: false });
  assert.equal(fromEnv({}, { fetch: neko.fetch }).enabled, false);
});
