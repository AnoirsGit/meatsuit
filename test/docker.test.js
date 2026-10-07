/**
 * Зеркало в Docker без запуска контейнеров: docker/up.sh и то, что docker compose собирает из файлов.
 * Выбор браузера (chrome по умолчанию, brave), свои тома профиля, постоянные имена для вызывающих
 * (контейнер meatsuit-browser, том meatsuit_profile), CDP не публикуется, Tailscale — необязательный профиль.
 * Части с docker compose пропускаются, если его нет; up.sh проверяется и на подставном docker.
 *
 *   node test/docker.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cfg = require('../config.js');

const ROOT = path.join(__dirname, '..');
const DOCKER = path.join(ROOT, 'docker');
const UP = path.join(DOCKER, 'up.sh');
const hasDockerCompose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-docker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Файл деплоя из образца (как после npm run init) с правками поверх. */
function envFile(t, changes = {}, extra = '') {
  const file = path.join(tmpdir(t), 'meatsuit.env');
  cfg.createNew(file, cfg.fromTemplate());
  if (Object.keys(changes).length) cfg.update(file, changes, { version: cfg.read(file).version });
  if (extra) fs.appendFileSync(file, extra);
  return file;
}

/** Окружение процесса без своих MEATSUIT_BROWSER и MEATSUIT_EGRESS (они главнее файла), плюс правки. */
function procEnv(file, env = {}) {
  const out = { ...process.env, ...env, MEATSUIT_CONFIG: file };
  for (const k of ['MEATSUIT_BROWSER', 'MEATSUIT_EGRESS']) if (!(k in env)) delete out[k];
  return out;
}
const up = (file, args, env = {}) => spawnSync('sh', [UP, ...args], { encoding: 'utf8', env: procEnv(file, env) });
/** docker compose config через up.sh: { services, volumes } или падение с текстом compose. */
function model(file, env = {}, ...profiles) {
  const r = up(file, [...profiles.flatMap((p) => ['--profile', p]), 'config', '--format', 'json'], env);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const BROWSERS = {
  chrome: { image: /^ghcr\.io\/m1k1o\/neko\/google-chrome:/, profile: '/home/neko/.config/chrome-meatsuit', volume: 'meatsuit_profile',
    files: { 'chrome.conf': '/etc/neko/supervisord/google-chrome.conf', 'chrome-policies.json': '/etc/opt/chrome/policies/managed/policies.json' } },
  brave: { image: /^ghcr\.io\/m1k1o\/neko\/brave:/, profile: '/home/neko/.config/brave', volume: 'meatsuit_brave_profile',
    files: { 'neko/brave.conf': '/etc/neko/supervisord/brave.conf', 'neko/brave-start.sh': '/etc/neko/brave-start.sh', 'neko/policies.json': '/etc/brave/policies/managed/policies.json' } },
};

for (const [name, b] of Object.entries(BROWSERS)) {
  test(`${name}: образ, свой том профиля, конфиги браузера, постоянные имена, CDP не наружу`, { skip: !hasDockerCompose && 'нет docker compose' }, (t) => {
    const file = envFile(t, name === 'chrome' ? {} : { MEATSUIT_BROWSER: name });
    const m = model(file);
    const neko = m.services.neko;
    assert.match(neko.image, b.image);
    assert.equal(neko.container_name, 'meatsuit-browser');
    assert.equal(neko.hostname, 'meatsuit-browser');
    const prof = neko.volumes.find((v) => v.target === b.profile);
    assert.ok(prof, JSON.stringify(neko.volumes));
    assert.equal(prof.type, 'volume');
    assert.equal(m.volumes[prof.source].name, b.volume);
    for (const [src, target] of Object.entries(b.files)) {
      const v = neko.volumes.find((x) => x.target === target);
      assert.ok(v && v.read_only, `${src} → ${target}`);
      assert.equal(v.source, path.join(DOCKER, src));
      assert.ok(fs.existsSync(v.source), v.source);
    }
    const other = Object.values(BROWSERS).find((x) => x !== b);
    assert.ok(!neko.volumes.some((v) => v.target === other.profile), 'чужой профиль подключён');
    assert.ok(!Object.values(m.volumes).some((v) => v.name === other.volume), 'том чужого браузера в модели');
    assert.ok(!neko.ports.some((p) => p.target === 9222 || p.published === '9222'), 'порт CDP опубликован');
    assert.ok(neko.ports.every((p) => p.host_ip === '127.0.0.1'), JSON.stringify(neko.ports));

    const init = m.services['profile-init'];
    assert.equal(init.image, neko.image, 'профиль отдаёт тот же образ');
    assert.deepEqual(init.entrypoint, ['chown', '1000:1000', '/profile']);
    assert.equal(init.network_mode, 'none');
    assert.equal(init.volumes.find((v) => v.target === '/profile').source, prof.source);
    assert.equal(neko.depends_on['profile-init'].condition, 'service_completed_successfully');
  });
}

test('chrome.conf и compose согласованы: CDP 9222 и та же папка профиля, что в томе', () => {
  const conf = fs.readFileSync(path.join(DOCKER, 'chrome.conf'), 'utf8');
  assert.match(conf, /--remote-debugging-port=9222\b/);
  assert.match(conf, new RegExp(`--user-data-dir=${BROWSERS.chrome.profile}\\s`));
  assert.match(fs.readFileSync(path.join(DOCKER, 'browser-chrome.yml'), 'utf8'), new RegExp(`:${BROWSERS.chrome.profile}\\n`));
  assert.match(fs.readFileSync(path.join(DOCKER, 'neko', 'brave-start.sh'), 'utf8'), /PROFILE=\/home\/neko\/\.config\/brave\n/);
});

test('папка на хосте вместо тома: у обоих браузеров, хозяином её делает profile-init', { skip: !hasDockerCompose && 'нет docker compose' }, (t) => {
  for (const name of Object.keys(BROWSERS)) {
    const file = envFile(t, { MEATSUIT_BROWSER: name, MEATSUIT_PROFILE_DIR: '/srv/meatsuit/profile' });
    const m = model(file);
    const prof = m.services.neko.volumes.find((v) => v.target === BROWSERS[name].profile);
    assert.deepEqual([prof.type, prof.source], ['bind', '/srv/meatsuit/profile'], name);
    assert.equal(m.services['profile-init'].volumes[0].source, '/srv/meatsuit/profile', name);
  }
});

test('Tailscale — необязательный профиль: MEATSUIT_EGRESS=tailscale в файле добавляет egress, порты у tailscale, имя хоста от него', { skip: !hasDockerCompose && 'нет docker compose' }, (t) => {
  const plain = model(envFile(t), {}, 'warmup', 'api');
  assert.ok(!plain.services.tailscale, 'tailscale без MEATSUIT_EGRESS');
  assert.equal(plain.services.life.network_mode, 'service:neko');

  for (const name of Object.keys(BROWSERS)) {
    const file = envFile(t, { MEATSUIT_BROWSER: name }, 'MEATSUIT_EGRESS=tailscale\n');
    const m = model(file, {}, 'warmup', 'api');
    const neko = m.services.neko;
    assert.equal(neko.network_mode, 'service:tailscale', name);
    assert.equal(neko.hostname, undefined, 'своё имя хоста в чужой сети Docker не даёт');
    assert.equal(neko.container_name, 'meatsuit-browser');
    assert.ok(!neko.ports || neko.ports.length === 0);
    const ts = m.services.tailscale;
    assert.ok(ts.ports.some((p) => p.target === 8080) && !ts.ports.some((p) => p.target === 9222));
    for (const s of ['life', 'server']) assert.equal(m.services[s].network_mode, 'service:tailscale', s);
    assert.equal(m.services.neko.depends_on.tailscale.condition, 'service_healthy');
  }
  // и из окружения, как остальные переменные compose
  assert.ok(model(envFile(t), { MEATSUIT_EGRESS: 'tailscale' }).services.tailscale);
});

test('up.sh: без файла и с непонятным MEATSUIT_EGRESS — отказ с подсказкой, docker не зовётся', (t) => {
  const dir = tmpdir(t);
  const r = up(path.join(dir, 'нет.env'), ['config']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /npm run init/);
  const file = envFile(t, {}, 'MEATSUIT_EGRESS=home\n');
  const bad = up(file, ['config']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /MEATSUIT_EGRESS=home не понятен/);
});

test('up.sh на подставном docker: --env-file с путём из MEATSUIT_CONFIG, по умолчанию up -d, свои аргументы как есть', (t) => {
  const bin = tmpdir(t);
  const log = path.join(bin, 'args');
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${log}"\n`, { mode: 0o755 });
  const env = { PATH: `${bin}:${process.env.PATH}` };
  const args = () => fs.readFileSync(log, 'utf8').trimEnd().split('\n');
  const compose = path.join(DOCKER, 'docker-compose.yml');

  const file = envFile(t);
  assert.equal(up(file, [], env).status, 0);
  assert.deepEqual(args(), ['compose', '--env-file', file, '-f', compose, 'up', '-d']);

  assert.equal(up(file, ['logs', '-f', 'neko'], env).status, 0);
  assert.deepEqual(args(), ['compose', '--env-file', file, '-f', compose, 'logs', '-f', 'neko']);

  const eg = envFile(t, {}, 'MEATSUIT_EGRESS=tailscale   # выход через дом\n');
  assert.equal(up(eg, ['--profile', 'warmup', 'up', '-d'], env).status, 0);
  assert.deepEqual(args(), ['compose', '--env-file', eg, '-f', compose, '-f', path.join(DOCKER, 'docker-compose.egress.yml'),
    '--profile', 'egress', '--profile', 'warmup', 'up', '-d']);

  assert.equal(up(eg, [], { ...env, MEATSUIT_EGRESS: 'off' }).status, 0, 'окружение главнее файла, как у compose');
  assert.deepEqual(args(), ['compose', '--env-file', eg, '-f', compose, 'up', '-d']);
});
