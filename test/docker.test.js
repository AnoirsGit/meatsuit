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
    if (other.volume !== 'meatsuit_profile') assert.ok(!Object.values(m.volumes).some((v) => v.name === other.volume), 'том чужого браузера в модели');
    assert.ok(!neko.ports.some((p) => p.target === 9222 || p.published === '9222'), 'порт CDP опубликован');
    assert.ok(neko.ports.every((p) => p.host_ip === '127.0.0.1'), JSON.stringify(neko.ports));

    const init = m.services['profile-init'];
    assert.equal(init.image, neko.image, 'профиль отдаёт тот же образ');
    assert.deepEqual(init.entrypoint, ['sh', '-c', 'mkdir -p /meatsuit/state && chown 1000:1000 /profile /meatsuit /meatsuit/state']);
    assert.equal(init.network_mode, 'none');
    assert.equal(init.volumes.find((v) => v.target === '/profile').source, prof.source);
    // том вызывающих: meatsuit_profile с папкой state/ — при любом браузере
    const shared = init.volumes.find((v) => v.target === '/meatsuit');
    assert.deepEqual([shared.type, m.volumes[shared.source].name], ['volume', 'meatsuit_profile']);
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

// docker stop: compose ждёт stop_grace_period, но браузер останавливает supervisord внутри Neko и ждёт его только
// stopwaitsecs (по умолчанию 10 с), потом SIGKILL — свежие cookie и входы не успевают лечь на диск.
test('остановка: supervisord ждёт браузер дольше своих 10 с, но меньше stop_grace_period compose', () => {
  const compose = fs.readFileSync(path.join(DOCKER, 'docker-compose.yml'), 'utf8');
  const grace = Number((/stop_grace_period:\s*(\d+)s/.exec(compose) || [])[1]);
  assert.ok(grace > 0, 'у neko нет stop_grace_period в секундах');
  for (const conf of ['chrome.conf', 'neko/brave.conf']) {
    const text = fs.readFileSync(path.join(DOCKER, conf), 'utf8');
    assert.match(text, /^stopsignal=INT$/m, `${conf}: браузер сбрасывает данные по SIGINT`);
    const wait = Number((/^stopwaitsecs=(\d+)$/m.exec(text) || [])[1]);
    assert.ok(wait > 10 && wait < grace, `${conf}: stopwaitsecs=${wait || 'нет'}, нужно больше 10 и меньше ${grace}`);
  }
});

test('папка на хосте вместо тома: у обоих браузеров, хозяином её делает profile-init', { skip: !hasDockerCompose && 'нет docker compose' }, (t) => {
  for (const name of Object.keys(BROWSERS)) {
    const file = envFile(t, { MEATSUIT_BROWSER: name, MEATSUIT_PROFILE_DIR: '/srv/meatsuit/profile' });
    const m = model(file);
    const prof = m.services.neko.volumes.find((v) => v.target === BROWSERS[name].profile);
    assert.deepEqual([prof.type, prof.source], ['bind', '/srv/meatsuit/profile'], name);
    const init = m.services['profile-init'].volumes;
    assert.equal(init.find((v) => v.target === '/profile').source, '/srv/meatsuit/profile', name);
    assert.equal(m.volumes[init.find((v) => v.target === '/meatsuit').source].name, 'meatsuit_profile', 'том вызывающих есть и с папкой на хосте');
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
    // выключатель, затем выбор exit node по списку, затем containerboot
    assert.deepEqual(ts.entrypoint, ['/bin/sh', '/killswitch.sh']);
    assert.deepEqual(ts.command, ['/bin/sh', '/exit-picker.sh', 'launch', '/usr/local/bin/containerboot']);
    assert.ok(ts.volumes.some((v) => v.target === '/exit-picker.sh' && v.read_only && v.source.endsWith(path.join('egress', 'exit-picker.sh'))));
    assert.equal(ts.environment.MEATSUIT_EXIT_NODES, '', 'без списка — как раньше, выход из TS_EXTRA_ARGS');
    assert.match(ts.healthcheck.test.join(' '), /! grep -qx closed \/tmp\/exit-picker\/gate/);
  }
  // и из окружения, как остальные переменные compose
  assert.ok(model(envFile(t), { MEATSUIT_EGRESS: 'tailscale' }).services.tailscale);
  // список exit node и ожидаемый выход доходят до контейнера из файла деплоя
  const listed = model(envFile(t, {}, 'MEATSUIT_EGRESS=tailscale\nMEATSUIT_EXIT_NODES=home-phone,anoir-pc\nMEATSUIT_EXIT_COUNTRY=KZ\nMEATSUIT_EXIT_ASN=64500\n'));
  const env = listed.services.tailscale.environment;
  assert.deepEqual([env.MEATSUIT_EXIT_NODES, env.MEATSUIT_EXIT_COUNTRY, env.MEATSUIT_EXIT_ASN], ['home-phone,anoir-pc', 'KZ', '64500']);
  // тонкая настройка, описанная в egress.md, тоже доходит; без неё — пусто, и скрипт берёт свои значения
  const tuned = model(envFile(t, {}, 'MEATSUIT_EGRESS=tailscale\nMEATSUIT_EXIT_RETURN_AFTER=6\nMEATSUIT_EXIT_PROBE_EVERY=20\n')).services.tailscale.environment;
  assert.deepEqual([tuned.MEATSUIT_EXIT_RETURN_AFTER, tuned.MEATSUIT_EXIT_PROBE_EVERY, tuned.MEATSUIT_EXIT_INTERVAL, tuned.MEATSUIT_EXIT_DOWN_AFTER], ['6', '20', '', '']);
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

// Соседи браузера (network_mode: "container:meatsuit-browser" в чужих проектах) держатся за id контейнера: compose
// записывает в NetworkMode «container:<id>». Пересоздали браузер — они живут в сети старого контейнера, то есть без
// сети, пока их не пересоздать. up.sh после up называет их и печатает команду, но чужие проекты сам не трогает.
test('up.sh после up, пересоздавшего браузер: соседи в сети старого контейнера и команда для каждого', (t) => {
  const bin = tmpdir(t);
  const st = (f) => path.join(bin, f);
  fs.writeFileSync(st('docker'), `#!/bin/sh
case "$1" in
  inspect)
    if [ "$3" = '{{.Id}}' ]; then [ "$4" = meatsuit-browser ] && cat "${st('id')}"; exit 0; fi
    printf '%s\\n' "$@" > "${st('inspect-args')}"; cat "${st('neighbours')}" ;;
  ps) printf 'c1\\nc2\\nc3\\nc4\\nc5\\n' ;;
  compose) printf '%s\\n' "$@" > "${st('compose-args')}"; if [ -f "${st('next-id')}" ]; then cp "${st('next-id')}" "${st('id')}"; fi ;;
esac
exit 0
`, { mode: 0o755 });
  const env = { PATH: `${bin}:${process.env.PATH}` };
  const OLD = 'a'.repeat(64), NEW = 'b'.repeat(64);
  fs.writeFileSync(st('neighbours'), [
    `/jobs-apply|container:${OLD}|jobs|apply|/srv/jobs|/srv/jobs/docker-compose.yml,/srv/jobs/docker-compose.browser.yml|`,
    `/tm-matcher-run-1f2e|container:${OLD}|tm|matcher|/srv/tm/deploy|/srv/tm/deploy/docker-compose.yml|True`,
    `/plain|container:${OLD}|||||`,
    `/other-sidecar|container:${'c'.repeat(64)}|x|y|/srv/x|/srv/x/c.yml|`,
    '/meatsuit-tailscale-1|default|meatsuit|tailscale|/srv/meatsuit/docker|/srv/meatsuit/docker/docker-compose.yml|',
  ].join('\n') + '\n');
  const file = envFile(t);

  // Браузер пересоздан: id сменился.
  fs.writeFileSync(st('id'), `${OLD}\n`);
  fs.writeFileSync(st('next-id'), `${NEW}\n`);
  let r = up(file, ['up', '-d', '--force-recreate'], env);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fs.readFileSync(st('compose-args'), 'utf8').trimEnd().split('\n').slice(-3), ['up', '-d', '--force-recreate']);
  assert.match(r.stderr, /остались без сети/);
  assert.match(r.stderr, /^ {2}jobs-apply: cd \/srv\/jobs && docker compose -p jobs -f \/srv\/jobs\/docker-compose\.yml -f \/srv\/jobs\/docker-compose\.browser\.yml up -d --force-recreate apply$/m);
  assert.match(r.stderr, /^ {2}tm-matcher-run-1f2e: разовый запуск \(compose run\)/m);
  assert.match(r.stderr, /^ {2}plain: не из compose/m);
  assert.doesNotMatch(r.stderr, /other-sidecar|meatsuit-tailscale-1/, 'чужие соседи и сам стек не в списке');
  assert.deepEqual(fs.readFileSync(st('inspect-args'), 'utf8').trimEnd().split('\n').slice(-5), ['c1', 'c2', 'c3', 'c4', 'c5'], 'смотрит и остановленные (ps -a)');

  // Браузер тот же (up без пересоздания): ничего не печатает.
  fs.rmSync(st('next-id'));
  r = up(file, ['up', '-d'], env);
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');

  // Браузера до up не было (первый запуск): сравнивать не с чем, тишина.
  fs.writeFileSync(st('id'), '');
  fs.writeFileSync(st('next-id'), `${NEW}\n`);
  r = up(file, [], env);
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
});
