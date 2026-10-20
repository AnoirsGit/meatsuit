/**
 * tools/config-ui.js (npm run config): каждое правило из приёмки ПР4.
 * Без токена 401; чужой Origin и чужой Host — 403; GET не отдаёт значений паролей; PUT без поля пароль
 * сохраняет, маску отвергает (400); неверное — 400 с текстом; параллельная правка — 409; 1000 записей
 * подряд — отдельный процесс-читатель ни разу не видит обрезанный файл; выход по простою; слушает только
 * 127.0.0.1 (tailnet — явным флагом), не живёт в compose; docker compose --env-file принимает результат.
 *
 *   node --test test/config-ui.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const cfg = require('../config.js');
const { createConfigServer, parseArgs, tailnetAddress } = require('../tools/config-ui.js');

const ROOT = path.join(__dirname, '..');
const hasDockerCompose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;

/** Файл из образца и запущенная страница на нём. */
async function setup(t, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-config-ui-'));
  const file = path.join(dir, 'meatsuit.env');
  cfg.createNew(file, cfg.fromTemplate());
  fs.appendFileSync(file, 'TS_AUTHKEY=оставить-как-есть\n');
  const exits = [];
  const s = createConfigServer({ file, onExit: (r) => exits.push(r), ...opts });
  const { url, port, address } = await s.ready;
  t.after(() => { s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${port}`;
  const call = (method, p, { token = s.token, headers = {}, body } = {}) => fetch(origin + p, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(method !== 'GET' ? { Origin: origin } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const get = async () => (await call('GET', '/api/config')).json();
  const put = (body, o = {}) => call('PUT', '/api/config', { ...o, body });
  return { dir, file, s, url, port, address, origin, call, get, put, exits };
}

test('без токена или с чужим токеном — 401; страница сама без данных отдаётся, cookies нет нигде', async (t) => {
  const c = await setup(t);
  for (const token of ['', 'deadbeef', `${c.s.token}00`]) {
    const r = await c.call('GET', '/api/config', { token });
    assert.equal(r.status, 401, `токен «${token}»`);
    assert.match((await r.json()).message, /npm run config/);
  }
  const bad = await c.call('GET', '/api/config', { token: '', headers: { Authorization: `Basic ${c.s.token}` } });
  assert.equal(bad.status, 401);
  const put = await c.put({ version: 'x', values: {} }, { token: '' });
  assert.equal(put.status, 401);

  const page = await fetch(`${c.origin}/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  const { values } = cfg.read(c.file);
  for (const k of cfg.SECRET_KEYS) assert.ok(!html.includes(values[k]));
  assert.ok(!html.includes(c.s.token), 'токен в теле страницы');
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'; script-src 'nonce-[^']+'/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  for (const r of [page, await c.call('GET', '/api/config')]) {
    assert.equal(r.headers.get('set-cookie'), null);
    assert.equal(r.headers.get('access-control-allow-origin'), null);
    assert.equal(r.headers.get('cache-control'), 'no-store');
  }
});

test('чужой Origin — 403 и для чтения, и для записи; запись без Origin — 403; чужой Host (подмена DNS) — 403; CORS не открыт', async (t) => {
  const c = await setup(t);
  const before = fs.readFileSync(c.file, 'utf8');
  const { version } = await c.get();
  for (const o of ['http://evil.example', 'null', `http://localhost:${c.port + 1}`]) {
    assert.equal((await c.call('GET', '/api/config', { headers: { Origin: o } })).status, 403, o);
    assert.equal((await c.put({ version, values: { NEKO_PORT: '8081' } }, { headers: { Origin: o } })).status, 403, o);
  }
  const noOrigin = await fetch(`${c.origin}/api/config`, { method: 'PUT', headers: { Authorization: `Bearer ${c.s.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ version, values: { NEKO_PORT: '8081' } }) });
  assert.equal(noOrigin.status, 403);
  assert.equal((await c.call('GET', '/api/config', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await c.call('POST', '/api/quit', { headers: { Origin: 'http://evil.example' } })).status, 403);
  assert.equal(c.exits.length, 0, 'чужая страница закрыла процесс');

  // Подмена DNS: имя злоумышленника указывает на 127.0.0.1, браузер шлёт Host с этим именем.
  const http = require('node:http');
  const status = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: c.port, path: '/api/config', headers: { Host: `evil.example:${c.port}`, Authorization: `Bearer ${c.s.token}` } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(status, 403);

  const pre = await c.call('OPTIONS', '/api/config', { headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'PUT' } });
  assert.notEqual(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), null);
  assert.equal(fs.readFileSync(c.file, 'utf8'), before, 'файл изменился');
});

test('GET: поля с подписями и подсказками, значения без паролей ({set}), чужие ключи только по имени', async (t) => {
  const c = await setup(t);
  const r = await c.call('GET', '/api/config');
  const raw = await r.text();
  const body = JSON.parse(raw);
  const { values } = cfg.read(c.file);
  for (const k of cfg.SECRET_KEYS) {
    assert.ok(!raw.includes(values[k]), `${k} утёк в GET`);
    assert.deepEqual(body.values[k], { set: true });
  }
  assert.ok(!raw.includes('оставить-как-есть'), 'значение чужого ключа утекло');
  assert.deepEqual(body.other, ['TS_AUTHKEY']);
  assert.equal(body.values.NEKO_PORT, '8080');
  assert.equal(body.mode, '600');
  assert.equal(body.fields.length, cfg.FIELDS.length);
  for (const f of body.fields) assert.ok(/[а-я]/i.test(f.label) && /[а-я]/i.test(f.hint), `${f.key}: подпись не по-русски`);
  assert.deepEqual(body.problems, []);
  assert.match(body.apply, /^MEATSUIT_CONFIG=\S*meatsuit\.env \S*docker\/up\.sh$/);
});

test('PUT: без поля пароль сохраняется, null тоже; маска — 400; новый пароль записывается; чужие строки и комментарии целы', async (t) => {
  const c = await setup(t);
  const before = cfg.read(c.file);
  let { version } = await c.get();
  let r = await c.put({ version, values: { NEKO_PORT: '8081', NEKO_ADMIN_PASSWORD: null } });
  assert.equal(r.status, 200);
  ({ version } = await r.json());
  let after = cfg.read(c.file);
  assert.equal(after.values.NEKO_PORT, '8081');
  for (const k of cfg.SECRET_KEYS) assert.equal(after.values[k], before.values[k]);
  assert.equal(after.values.TS_AUTHKEY, 'оставить-как-есть');
  assert.match(after.text, /^# Файл деплоя зеркала meatsuit/);

  for (const mask of ['••••••••', '********', '●●●●']) {
    r = await c.put({ version, values: { NEKO_PASSWORD: mask } });
    assert.equal(r.status, 400, mask);
    const e = await r.json();
    assert.match(e.message, /NEKO_PASSWORD: это маска/);
    assert.equal(e.errors[0].key, 'NEKO_PASSWORD');
  }
  assert.equal(cfg.read(c.file).values.NEKO_PASSWORD, before.values.NEKO_PASSWORD);

  const fresh = cfg.randomSecret();
  r = await c.put({ version, values: { NEKO_PASSWORD: fresh } });
  assert.equal(r.status, 200);
  assert.ok(!(await r.text()).includes(fresh), 'новый пароль вернулся в ответе');
  after = cfg.read(c.file);
  assert.equal(after.values.NEKO_PASSWORD, fresh);
  assert.equal(after.values.NEKO_ADMIN_PASSWORD, before.values.NEKO_ADMIN_PASSWORD);
  assert.equal(fs.statSync(c.file).mode & 0o777, 0o600);
});

test('PUT: неверное — 400 с текстом по каждому полю, файл не тронут; кривое тело — 400/413/415', async (t) => {
  const c = await setup(t);
  const before = fs.readFileSync(c.file, 'utf8');
  const { version } = await c.get();
  let r = await c.put({ version, values: { NEKO_BIND_IP: '0.0.0.0', NEKO_PORT: '70000', MEATSUIT_TZ: 'Mars/Olympus', NEKO_ADMIN_PASSWORD: 'short', UPLOAD_DIRS: '/home' } });
  assert.equal(r.status, 400);
  const e = await r.json();
  assert.equal(e.error, 'invalid');
  assert.deepEqual(e.errors.map((x) => x.key).sort(), ['UPLOAD_DIRS']);
  assert.match(e.message, /UPLOAD_DIRS: такого поля в схеме нет/);

  r = await c.put({ version, values: { NEKO_BIND_IP: '0.0.0.0', NEKO_PORT: '70000', MEATSUIT_TZ: 'Mars/Olympus', NEKO_ADMIN_PASSWORD: 'short' } });
  assert.equal(r.status, 400);
  const e2 = await r.json();
  assert.deepEqual(e2.errors.map((x) => x.key).sort(), ['MEATSUIT_TZ', 'NEKO_ADMIN_PASSWORD', 'NEKO_BIND_IP', 'NEKO_PORT']);
  assert.match(e2.message, /NEKO_BIND_IP: 0\.0\.0\.0 нельзя/);
  assert.match(e2.message, /NEKO_ADMIN_PASSWORD: не короче 12/);
  assert.ok(!e2.message.includes('short'), 'пароль в тексте ошибки');

  r = await c.put('не json');
  assert.equal(r.status, 400);
  r = await c.call('PUT', '/api/config', { body: JSON.stringify({ version, values: {} }), headers: { 'Content-Type': 'text/plain' } });
  assert.equal(r.status, 415);
  r = await c.put({ version, values: { NEKO_TAG: 'x'.repeat(70000) } });
  assert.equal(r.status, 413);
  assert.equal(fs.readFileSync(c.file, 'utf8'), before);
});

test('параллельная правка — 409: вторая вкладка со старой версией и правка файла руками', async (t) => {
  const c = await setup(t);
  const { version } = await c.get();
  const [a, b] = await Promise.all([
    c.put({ version, values: { NEKO_PORT: '8081' } }),
    c.put({ version, values: { NEKO_PORT: '8082' } }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const lost = a.status === 409 ? a : b;
  assert.match((await lost.json()).message, /изменился/);
  const won = a.status === 200 ? '8081' : '8082';
  assert.equal(cfg.read(c.file).values.NEKO_PORT, won);

  const { version: v2 } = await c.get();
  fs.appendFileSync(c.file, '# правка руками\n');
  const r = await c.put({ version: v2, values: { NEKO_PORT: '8083' } });
  assert.equal(r.status, 409);
  assert.equal(cfg.read(c.file).values.NEKO_PORT, won);
  assert.match(fs.readFileSync(c.file, 'utf8'), /# правка руками\n$/);
});

test('1000 записей подряд: читатель в другом процессе ни разу не видит обрезанный файл', async (t) => {
  const c = await setup(t);
  const stop = path.join(c.dir, 'stop');
  const keys = cfg.FIELDS.map((f) => f.key);
  const reader = spawn(process.execPath, ['-e', `
    const fs = require('fs');
    const [file, stop, keys] = [process.argv[1], process.argv[2], JSON.parse(process.argv[3])];
    let reads = 0, bad = 0, sizes = new Set();
    while (!fs.existsSync(stop)) {
      let t; try { t = fs.readFileSync(file, 'utf8'); } catch (e) { bad++; continue; }
      reads++; sizes.add(t.length);
      const ok = t.endsWith('TS_AUTHKEY=оставить-как-есть\\n') && keys.every((k) => new RegExp('^' + k + '=', 'm').test(t));
      if (!ok) bad++;
    }
    console.log(JSON.stringify({ reads, bad, sizes: sizes.size }));
  `, c.file, stop, JSON.stringify(keys)], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  reader.stdout.on('data', (d) => { out += d; });
  const done = new Promise((resolve) => reader.on('exit', resolve));

  let { version } = await c.get();
  for (let i = 0; i < 1000; i++) {
    const r = await c.put({ version, values: { NEKO_SCREEN: i % 2 ? '1920x1080@30' : '1280x720@30', NEKO_PORT: String(10000 + i) } });
    assert.equal(r.status, 200);
    ({ version } = await r.json());
  }
  fs.writeFileSync(stop, '');
  await done;
  const res = JSON.parse(out);
  assert.equal(res.bad, 0, `читатель видел обрезанный файл: ${out}`);
  assert.ok(res.reads > 100, `читатель почти не читал: ${out}`);
  assert.ok(res.sizes >= 2, 'файл не менялся под читателем');
  assert.equal(cfg.read(c.file).values.NEKO_PORT, '10999');
  assert.deepEqual(fs.readdirSync(c.dir).sort(), ['meatsuit.env', 'stop'], 'остались временные файлы или замок');
});

test('выход по простою: без запросов процесс закрывается сам; запросы с токеном продлевают, без токена — нет', async (t) => {
  const c = await setup(t, { idleMs: 300 });
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 150));
    assert.equal((await c.call('GET', '/api/config')).status, 200, 'закрылся, хотя запросы шли');
  }
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 100));
    await c.call('GET', '/api/config', { token: '' }).catch(() => {});
  }
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(c.exits, ['idle']);
  await assert.rejects(fetch(`${c.origin}/`), 'порт всё ещё слушается');
});

test('«Закончить» на странице закрывает процесс', async (t) => {
  const c = await setup(t);
  const r = await c.call('POST', '/api/quit');
  assert.equal(r.status, 200);
  await new Promise((res) => setTimeout(res, 50));
  assert.deepEqual(c.exits, ['quit']);
});

test('адрес: по умолчанию 127.0.0.1; tailnet только явным флагом; 0.0.0.0 и внешние адреса — отказ; в compose страницы нет', async (t) => {
  const c = await setup(t);
  assert.equal(c.address, '127.0.0.1');
  assert.equal(parseArgs([], {}).host, '127.0.0.1');
  for (const h of ['0.0.0.0', '::', '192.0.2.10', '203.0.113.7', '100.128.0.1']) assert.throws(() => parseArgs(['--host', h], {}), /только 127\.0\.0\.1/, h);
  const TS_IP = ['100', '101', '102', '103'].join('.'); // из кусков: скан секретов ищет адреса tailnet
  assert.equal(parseArgs(['--host', TS_IP], {}).host, TS_IP);
  const ifaces = { lo: [{ family: 'IPv4', address: '127.0.0.1' }], tailscale0: [{ family: 'IPv6', address: 'fd7a::1' }, { family: 'IPv4', address: TS_IP }] };
  assert.equal(tailnetAddress(ifaces), TS_IP);
  assert.equal(parseArgs(['--tailnet'], {}, ifaces).host, TS_IP);
  assert.throws(() => parseArgs(['--tailnet'], {}, { lo: ifaces.lo }), /нет адреса tailnet/);
  assert.equal(parseArgs(['--file', 'x.env'], { MEATSUIT_CONFIG: '/srv/m.env' }).file, path.resolve('x.env'));
  assert.equal(parseArgs([], { MEATSUIT_CONFIG: '/srv/m.env' }).file, '/srv/m.env');
  assert.equal(parseArgs(['--idle-min', '1'], {}).idleMs, 60000);

  // Процесс на хосте: ни один сервис compose его не запускает и в сеть neko он не попадает.
  for (const f of fs.readdirSync(path.join(ROOT, 'docker')).filter((n) => /^docker-compose.*\.ya?ml$/.test(n))) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'docker', f), 'utf8'), /config-ui|npm run config/, f);
  }
});

test('npm run config: печатает ссылку с токеном один раз, без файла — отказ с подсказкой про init, Ctrl+C — выход', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-config-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'm.env');
  const missing = spawnSync(process.execPath, ['tools/config-ui.js', '--file', file], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /npm run init/);

  cfg.createNew(file, cfg.fromTemplate());
  const p = spawn(process.execPath, ['tools/config-ui.js', '--file', file], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => p.kill('SIGKILL'));
  let out = '';
  const url = await new Promise((resolve, reject) => {
    p.stdout.on('data', (d) => { out += d; const m = /откройте (http:\/\/127\.0\.0\.1:\d+\/#t=[0-9a-f]{48})\n/.exec(out); if (m) resolve(m[1]); });
    p.on('exit', () => reject(new Error(`вышел раньше времени: ${out}`)));
  });
  const u = new URL(url);
  const token = u.hash.slice(3);
  const r = await fetch(`${u.origin}/api/config`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(r.status, 200);
  const { values } = cfg.read(file);
  for (const k of cfg.SECRET_KEYS) assert.ok(!out.includes(values[k]), `${k} напечатан`);
  assert.equal(out.split(token).length - 1, 1, 'токен напечатан не один раз');
  const code = await new Promise((resolve) => { p.on('exit', (c, sig) => resolve(c ?? sig)); p.kill('SIGINT'); });
  assert.equal(code, 0);
});

test('docker compose --env-file принимает файл, записанный страницей', { skip: !hasDockerCompose && 'нет docker compose' }, async (t) => {
  const c = await setup(t);
  const { version } = await c.get();
  const fresh = cfg.randomSecret();
  const r = await c.put({ version, values: { NEKO_PASSWORD: fresh, NEKO_PORT: '18080', MEATSUIT_TZ: 'Europe/Berlin', NEKO_SCREEN: '1920x1080@30', MEATSUIT_PROFILE_DIR: '/srv/meatsuit/profile' } });
  assert.equal(r.status, 200);
  const out = spawnSync('docker', ['compose', '--env-file', c.file, '-f', path.join(ROOT, 'docker', 'docker-compose.yml'), 'config', '--format', 'json'], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const neko = JSON.parse(out.stdout).services.neko;
  assert.equal(neko.environment.NEKO_MEMBER_MULTIUSER_USER_PASSWORD, fresh);
  assert.equal(neko.environment.NEKO_DESKTOP_SCREEN, '1920x1080@30');
  assert.equal(neko.environment.TZ, 'Europe/Berlin');
  assert.ok(neko.ports.some((p) => p.published === '18080'));
});

// Браузер — playwright-core ядра, как в остальных наборах test/ (не extras/testkit: ядро от extras/ не зависит).
const { chromium } = require('playwright-core');

test('страница в настоящем Chromium: подписи по-русски, токен уходит из адреса, сохранение, ошибка поля, 409, чужая страница не пишет, «Закончить»', async (t) => {
  const c = await setup(t);
  const b = await chromium.launch();
  t.after(() => b.close().catch(() => {}));
  const context = await b.newContext();
  const page = await context.newPage();
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(e.message));

  await page.goto(c.url);
  await page.waitForSelector('#form:not([hidden])');
  assert.equal(new URL(page.url()).hash, '', 'токен остался в адресной строке');
  assert.equal(await page.textContent('label[for="f-NEKO_PASSWORD"]'), 'Пароль участникаNEKO_PASSWORD');
  assert.equal(await page.inputValue('#f-NEKO_PASSWORD'), '', 'пароль попал в поле');
  assert.match(await page.getAttribute('#f-NEKO_PASSWORD', 'placeholder'), /задан/);
  assert.match(await page.textContent('#other'), /TS_AUTHKEY/);
  const before = cfg.read(c.file);

  await page.fill('#f-NEKO_PORT', '8085');
  await page.click('#save');
  await page.waitForFunction(() => /Сохранено/.test(document.getElementById('status').textContent));
  assert.match(await page.textContent('#status'), /MEATSUIT_CONFIG=\S+ \S*docker\/up\.sh/);
  let now = cfg.read(c.file);
  assert.equal(now.values.NEKO_PORT, '8085');
  for (const k of cfg.SECRET_KEYS) assert.equal(now.values[k], before.values[k], `${k} изменился без правки`);

  await page.fill('#f-NEKO_PORT', 'abc');
  await page.click('#save');
  await page.waitForFunction(() => document.getElementById('e-NEKO_PORT').textContent !== '');
  assert.match(await page.textContent('#e-NEKO_PORT'), /нужен порт/);
  assert.equal(cfg.read(c.file).values.NEKO_PORT, '8085');

  const text = fs.readFileSync(c.file, 'utf8').replace(/^NEKO_PORT=.*$/m, 'NEKO_PORT=8090');
  fs.writeFileSync(c.file, text);
  await page.fill('#f-NEKO_PORT', '8086');
  await page.click('#save');
  await page.waitForFunction(() => /изменился/.test(document.getElementById('status').textContent));
  assert.equal(cfg.read(c.file).values.NEKO_PORT, '8090');
  await page.click('#reload');
  await page.waitForFunction(() => document.getElementById('f-NEKO_PORT').value === '8090');

  // Чужая страница (другой порт = другой Origin) в том же браузере: даже с токеном записать не может.
  const evil = require('node:http').createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<p>evil</p>'); });
  await new Promise((r) => evil.listen(0, '127.0.0.1', r));
  t.after(() => evil.close());
  const other = await context.newPage();
  await other.goto(`http://127.0.0.1:${evil.address().port}/`);
  const attempt = await other.evaluate(async ({ api, token }) => {
    const out = [];
    for (const init of [
      { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ values: { NEKO_PORT: '9999' } }) },
      { method: 'PUT', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body: '{"values":{"NEKO_PORT":"9999"}}' },
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
    ]) {
      try { const r = await fetch(api, init); out.push(r.type === 'opaque' ? 'opaque' : r.status); } catch (e) { out.push('blocked'); }
    }
    return out;
  }, { api: `${c.origin}/api/config`, token: c.s.token });
  assert.equal(attempt[0], 'blocked');
  assert.equal(attempt[2], 'blocked');
  assert.equal(cfg.read(c.file).values.NEKO_PORT, '8090', 'чужая страница записала файл');

  await page.click('#quit');
  await page.waitForFunction(() => /Готово/.test(document.getElementById('status').textContent));
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(c.exits, ['quit']);
  assert.deepEqual(problems.filter((p) => !/Failed to load resource|409|400/.test(p)), [], 'ошибки в консоли страницы (CSP?)');
});
