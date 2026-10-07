/**
 * config.js и npm run init: схема файла деплоя (только зеркало), разбор и запись без потери комментариев,
 * проверка с понятными текстами без значений секретов, атомарная запись 0600, замок и 409 при чужой правке,
 * init на чистом клоне: файл 0600, git status чист, повторный запуск ничего не меняет, пароли не печатаются.
 * Плюс docker compose и sh читают записанный файл так же, как config.js.
 *
 *   node --test test/config.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cfg = require('../config.js');

const ROOT = path.join(__dirname, '..');
const COMPOSE = path.join(ROOT, 'docker', 'docker-compose.yml');

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Полный набор правильных значений. */
function good(over = {}) {
  const v = {};
  for (const f of cfg.FIELDS) v[f.key] = f.type === 'secret' ? cfg.randomSecret() : f.default;
  return { ...v, ...over };
}

const hasDockerCompose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;

test('схема — только зеркало и деплой: порты, браузер, пароли зеркала, профиль; без настроек вызывающего', () => {
  const keys = cfg.FIELDS.map((f) => f.key);
  for (const k of ['NEKO_PASSWORD', 'NEKO_ADMIN_PASSWORD', 'NEKO_PORT', 'NEKO_BIND_IP', 'MEATSUIT_BROWSER', 'NEKO_TAG', 'MEATSUIT_PROFILE_DIR']) assert.ok(keys.includes(k), k);
  for (const k of keys) assert.doesNotMatch(k, /UPLOAD|SITES|LIMIT|TELEGRAM|TOKEN|DIR$(?<!PROFILE_DIR)/, `${k}: настройка вызывающего в файле деплоя`);
  assert.deepEqual(cfg.SECRET_KEYS, ['NEKO_PASSWORD', 'NEKO_ADMIN_PASSWORD']);
  for (const f of cfg.FIELDS) assert.ok(f.label && f.hint && f.group, `${f.key}: нет подписи или подсказки`);
  const { values } = cfg.parse(fs.readFileSync(cfg.TEMPLATE, 'utf8'));
  for (const k of keys) assert.ok(k in values, `${k} нет в docker/.env.example`);
  for (const k of cfg.SECRET_KEYS) assert.equal(values[k], '', `${k} в образце со значением`);
});

test('путь файла: MEATSUIT_CONFIG (и с ~/) или docker/.env; модуль сам окружение не читает', () => {
  assert.equal(cfg.defaultFile({}), path.join(ROOT, 'docker', '.env'));
  assert.equal(cfg.defaultFile({ MEATSUIT_CONFIG: '/srv/m.env' }), '/srv/m.env');
  assert.equal(cfg.defaultFile({ MEATSUIT_CONFIG: '~/Projects/.config/m.env' }), path.join(os.homedir(), 'Projects/.config/m.env'));
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8'), /process\.env/);
});

test('разбор как у compose: кавычки снимаются, комментарий после пробела отрезается, export, последнее определение', () => {
  const { values, other } = cfg.parse([
    '# комментарий', 'NEKO_CPUS=2   # 0 — без потолка', 'export NEKO_PORT=8081', 'NEKO_TAG="3.1.7"', "NEKO_MEM='2g'",
    'NEKO_SCREEN=1x1@1', 'NEKO_SCREEN=1920x1080@30', 'TS_EXTRA_ARGS=--exit-node=x --flag', 'NEKO_PASSWORD=', 'не строка',
  ].join('\n'));
  assert.deepEqual(
    [values.NEKO_CPUS, values.NEKO_PORT, values.NEKO_TAG, values.NEKO_MEM, values.NEKO_SCREEN, values.TS_EXTRA_ARGS, values.NEKO_PASSWORD],
    ['2', '8081', '3.1.7', '2g', '1920x1080@30', '--exit-node=x --flag', ''],
  );
  assert.deepEqual(other, ['TS_EXTRA_ARGS']);
});

test('запись на месте: комментарии, пустые строки, чужие ключи, export и хвостовой комментарий остаются; нового ключа нет — дописывается', () => {
  const before = ['# шапка', '', 'NEKO_CPUS=2   # 0 — без потолка', 'export NEKO_PORT=8080', 'NEKO_TAG="3.1.6"', 'TS_AUTHKEY=оставить как есть', ''].join('\n');
  const after = cfg.render(before, { NEKO_CPUS: '1.5', NEKO_PORT: '8081', NEKO_TAG: '3.1.7', NEKO_MEM: '2g' });
  assert.equal(after, ['# шапка', '', 'NEKO_CPUS=1.5   # 0 — без потолка', 'export NEKO_PORT=8081', 'NEKO_TAG=3.1.7', 'TS_AUTHKEY=оставить как есть', '', '# Память контейнера', 'NEKO_MEM=2g', ''].join('\n'));
  assert.deepEqual(cfg.parse(after).values.NEKO_CPUS, '1.5');
});

test('проверка: правильный набор проходит; каждая ошибка с ключом и понятным текстом', () => {
  assert.deepEqual(cfg.validate(good()), []);
  const cases = {
    NEKO_PASSWORD: ['', 'короткий', 'с пробелом внутри', 'dollar$sign1234', 'кириллица-пароль', 'a'.repeat(129), 'x\nNEKO_PORT=1'],
    NEKO_BIND_IP: ['0.0.0.0', '256.1.1.1', 'localhost', '01.2.3.4', ''],
    NEKO_PORT: ['0', '65536', 'http', '59005', ''],
    MEATSUIT_BROWSER: ['firefox', ''],
    NEKO_TAG: ['-x', 'a b', ''],
    MEATSUIT_PROFILE_DIR: ['relative/dir', '/', '/srv/../etc'],
    MEATSUIT_TZ: ['Mars/Olympus', ''],
    NEKO_SCREEN: ['1280x720', '1280*720@30', ''],
    NEKO_MEM: ['3', '3gb', '0g', ''],
    NEKO_CPUS: ['two', '-1', ''],
  };
  for (const [key, bad] of Object.entries(cases)) {
    for (const v of bad) {
      const errs = cfg.validate(good({ [key]: v }));
      assert.equal(errs.length, 1, `${key}=${JSON.stringify(v)}: ${JSON.stringify(errs)}`);
      assert.equal(errs[0].key, key);
      assert.ok(errs[0].message.length > 5);
      if (cfg.SECRET_KEYS.includes(key) && v.length > 3) assert.ok(!errs[0].message.includes(v), 'пароль попал в текст ошибки');
    }
  }
  for (const v of ['', '/srv/meatsuit/profile']) assert.deepEqual(cfg.validate(good({ MEATSUIT_PROFILE_DIR: v })), []);
  for (const v of ['Europe/Berlin', 'UTC', 'Etc/GMT-5']) assert.deepEqual(cfg.validate(good({ MEATSUIT_TZ: v })), []);
  const same = cfg.randomSecret();
  assert.deepEqual(cfg.validate(good({ NEKO_PASSWORD: same, NEKO_ADMIN_PASSWORD: same })).map((e) => e.key), ['NEKO_ADMIN_PASSWORD']);
  assert.deepEqual(cfg.validate(good({ MEATSUIT_API_PORT: '8080' })).map((e) => e.key), ['MEATSUIT_API_PORT']);
});

test('образец → новый файл: пароли — случайный hex по 32 знака, разные при каждом вызове; остальное — умолчания образца', () => {
  const a = cfg.parse(cfg.fromTemplate()).values, b = cfg.parse(cfg.fromTemplate()).values;
  for (const k of cfg.SECRET_KEYS) {
    assert.match(a[k], /^[0-9a-f]{32}$/);
    assert.notEqual(a[k], b[k]);
  }
  assert.notEqual(a.NEKO_PASSWORD, a.NEKO_ADMIN_PASSWORD);
  assert.deepEqual(cfg.validate(a), []);
  const tpl = fs.readFileSync(cfg.TEMPLATE, 'utf8');
  const strip = (s) => s.replace(/^(NEKO_[A-Z_]*PASSWORD)=.*$/gm, '$1=');
  assert.equal(strip(cfg.fromTemplate()), tpl, 'кроме паролей файл совпадает с образцом: комментарии на месте');
});

test('атомарная запись: права 0600 даже поверх 0644, ссылка остаётся ссылкой, временных файлов не остаётся', (t) => {
  const dir = tmpdir(t);
  const file = path.join(dir, 'm.env');
  fs.writeFileSync(file, 'A=1\n', { mode: 0o644 });
  cfg.writeAtomic(file, 'A=2\n');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(file, 'utf8'), 'A=2\n');

  const real = path.join(dir, 'real.env'), link = path.join(dir, 'link.env');
  fs.writeFileSync(real, 'A=1\n', { mode: 0o600 });
  fs.symlinkSync(real, link);
  cfg.writeAtomic(link, 'A=3\n');
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'ссылку заменили файлом');
  assert.equal(fs.readFileSync(real, 'utf8'), 'A=3\n');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['link.env', 'm.env', 'real.env']);
});

test('createNew: создаёт 0600 (и папку), существующий файл не трогает', (t) => {
  const dir = tmpdir(t);
  const file = path.join(dir, 'deep', 'm.env');
  assert.equal(cfg.createNew(file, 'A=1\n'), true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(cfg.createNew(file, 'A=2\n'), false);
  assert.equal(fs.readFileSync(file, 'utf8'), 'A=1\n');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['m.env']);
});

test('update: секрет без поля остаётся, маска и чужое поле — 400, неверное — 400 со списком, чужая правка — 409', (t) => {
  const dir = tmpdir(t);
  const file = path.join(dir, 'm.env');
  cfg.createNew(file, cfg.fromTemplate());
  const before = cfg.read(file);
  const r = cfg.update(file, { NEKO_PORT: '8081', NEKO_PASSWORD: null }, { version: before.version });
  const after = cfg.read(file);
  assert.equal(r.version, after.version);
  assert.equal(after.values.NEKO_PORT, '8081');
  for (const k of cfg.SECRET_KEYS) assert.equal(after.values[k], before.values[k], `${k} потерялся`);

  const fail = (changes, version, status, re) => assert.throws(() => cfg.update(file, changes, { version }), (e) => {
    assert.equal(e.status, status, e.message);
    assert.match(e.message, re);
    return true;
  });
  fail({ NEKO_ADMIN_PASSWORD: '••••••••' }, after.version, 400, /маска/);
  fail({ NEKO_PASSWORD: '********' }, after.version, 400, /маска/);
  fail({ TELEGRAM_BOT_TOKEN: 'x' }, after.version, 400, /TELEGRAM_BOT_TOKEN: такого поля/);
  fail({ NEKO_PORT: '59001', NEKO_BIND_IP: '0.0.0.0' }, after.version, 400, /NEKO_BIND_IP: .*NEKO_PORT|NEKO_PORT: .*NEKO_BIND_IP/);
  fail({ NEKO_PORT: '8082' }, before.version, 409, /изменился/);
  fail({ NEKO_PORT: '8082' }, undefined, 409, /изменился/);
  assert.equal(cfg.read(file).version, after.version, 'отказ ничего не записал');

  fs.appendFileSync(file, '# правка руками\n');
  fail({ NEKO_PORT: '8083' }, after.version, 409, /изменился/);
});

test('замок: занятый другим процессом — 409; брошенный (старше 30 с) снимается', (t) => {
  const dir = tmpdir(t);
  const file = path.join(dir, 'm.env');
  cfg.createNew(file, cfg.fromTemplate());
  const { version } = cfg.read(file);
  const lock = `${file}.lock`;
  fs.writeFileSync(lock, '');
  assert.throws(() => cfg.update(file, { NEKO_PORT: '8081' }, { version }), (e) => e.status === 409 && e.code === 'locked');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lock, old, old);
  cfg.update(file, { NEKO_PORT: '8081' }, { version });
  assert.equal(fs.existsSync(lock), false, 'замок не снят после записи');
});

/** Чистый «клон»: отслеживаемые и новые файлы дерева в отдельном репозитории с одним коммитом. */
function cleanClone(t) {
  const dir = tmpdir(t);
  const files = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\0').filter(Boolean);
  for (const f of files) {
    if (!fs.existsSync(path.join(ROOT, f))) continue;
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  }
  const git = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, encoding: 'utf8' });
  git('init', '-q'); git('add', '-A'); git('commit', '-q', '--no-verify', '-m', 'clone');
  return { dir, git };
}

test('npm run init на чистом клоне: docker/.env 0600, git status чист; второй запуск ничего не меняет; пароли не печатаются', (t) => {
  const { dir, git } = cleanClone(t);
  const env = { ...process.env };
  delete env.MEATSUIT_CONFIG;
  const run = () => spawnSync(process.execPath, ['tools/init.js'], { cwd: dir, env, encoding: 'utf8' });

  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const file = path.join(dir, 'docker', '.env');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(git('status', '--porcelain').stdout, '', 'git status не чист');
  const { values } = cfg.parse(fs.readFileSync(file, 'utf8'));
  for (const k of cfg.SECRET_KEYS) assert.ok(!(first.stdout + first.stderr).includes(values[k]), `${k} напечатан`);
  assert.match(first.stdout, /создан docker\/\.env \(права 0600\)/);

  const bytes = fs.readFileSync(file), mtime = fs.statSync(file).mtimeMs;
  const second = run();
  assert.equal(second.status, 0);
  assert.match(second.stdout, /уже есть, ничего не меняю/);
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(fs.statSync(file).mtimeMs, mtime);
  for (const k of cfg.SECRET_KEYS) assert.ok(!second.stdout.includes(values[k]));
  assert.equal(git('status', '--porcelain').stdout, '');
});

test('init: MEATSUIT_CONFIG и --file; на старом файле с ошибками только подсказка с ключами, без значений', (t) => {
  const dir = tmpdir(t);
  const { main } = require('../tools/init.js');
  const lines = [];
  const file = path.join(dir, 'cfg', 'meatsuit.env');
  main([], { MEATSUIT_CONFIG: file }, (s) => lines.push(s));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.match(lines.join('\n'), /--env-file/);

  const old = path.join(dir, 'old.env');
  fs.writeFileSync(old, 'NEKO_PASSWORD=short\nNEKO_ADMIN_PASSWORD=\nTELEGRAM_BOT_TOKEN=keep\n', { mode: 0o644 });
  const out = [];
  main(['--file', old], {}, (s) => out.push(s));
  const text = out.join('\n');
  assert.match(text, /уже есть, ничего не меняю/);
  assert.match(text, /NEKO_PASSWORD: не короче 12/);
  assert.match(text, /NEKO_ADMIN_PASSWORD: обязательно/);
  assert.match(text, /права файла 644/);
  assert.ok(!text.includes('short') && !text.includes('keep'));
  assert.equal(fs.readFileSync(old, 'utf8'), 'NEKO_PASSWORD=short\nNEKO_ADMIN_PASSWORD=\nTELEGRAM_BOT_TOKEN=keep\n');
  assert.equal(fs.statSync(old).mode & 0o777, 0o644, 'права тоже не трогает');
});

test('sh (verify.sh делает «.») видит те же значения, что config.js', (t) => {
  const dir = tmpdir(t);
  const file = path.join(dir, 'm.env');
  cfg.createNew(file, cfg.fromTemplate());
  const { version } = cfg.read(file);
  cfg.update(file, { MEATSUIT_PROFILE_DIR: '/srv/meatsuit/profile', MEATSUIT_TZ: 'Europe/Berlin', NEKO_CPUS: '1.5' }, { version });
  const { values } = cfg.read(file);
  const keys = cfg.FIELDS.map((f) => f.key);
  const sh = spawnSync('sh', ['-c', `set -a; . "$1"; set +a; for k in ${keys.join(' ')}; do eval "printf '%s\\n' \\"\\$$k\\""; done`, 'sh', file], { encoding: 'utf8' });
  assert.equal(sh.status, 0, sh.stderr);
  assert.deepEqual(sh.stdout.trimEnd().split('\n'), keys.map((k) => values[k]));
});

test('docker compose --env-file принимает файл из init и после правки; пароли и пояс доходят до Neko', { skip: !hasDockerCompose && 'нет docker compose' }, (t) => {
  const dir = tmpdir(t);
  const file = path.join(dir, 'm.env');
  cfg.createNew(file, cfg.fromTemplate());
  const compose = (...extra) => spawnSync('docker', ['compose', '--env-file', file, '-f', COMPOSE, ...extra, 'config', '--format', 'json'], { encoding: 'utf8' });
  let r = compose();
  assert.equal(r.status, 0, r.stderr);
  let neko = JSON.parse(r.stdout).services.neko;
  let { values } = cfg.read(file);
  assert.equal(neko.environment.NEKO_MEMBER_MULTIUSER_USER_PASSWORD, values.NEKO_PASSWORD);
  assert.equal(neko.environment.NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD, values.NEKO_ADMIN_PASSWORD);
  assert.equal(neko.environment.TZ, 'UTC');
  assert.equal(neko.volumes.find((v) => v.target === '/home/neko/.config/brave').type, 'volume');

  cfg.update(file, { MEATSUIT_PROFILE_DIR: '/srv/meatsuit/profile', NEKO_PORT: '18080', MEATSUIT_TZ: 'Europe/Berlin' }, { version: cfg.read(file).version });
  r = compose();
  assert.equal(r.status, 0, r.stderr);
  neko = JSON.parse(r.stdout).services.neko;
  const prof = neko.volumes.find((v) => v.target === '/home/neko/.config/brave');
  assert.deepEqual([prof.type, prof.source], ['bind', '/srv/meatsuit/profile']);
  assert.equal(neko.environment.TZ, 'Europe/Berlin');
  assert.ok(neko.ports.some((p) => p.published === '18080' && p.host_ip === '127.0.0.1'), JSON.stringify(neko.ports));

  r = compose('-f', path.join(ROOT, 'docker', 'docker-compose.egress.yml'), '--profile', 'egress', '--profile', 'warmup', '--profile', 'api');
  assert.equal(r.status, 0, r.stderr);
});
