/**
 * docker/migrate-profile.sh по-настоящему: свои тома msupgrade-test-<pid>-… и одноразовые контейнеры, после теста удаляются.
 * Отказы (нет тома, тот же том, том у работающего контейнера, непустой том без --force), --plan ничего не меняет;
 * копия: содержимое и ссылки как в источнике, замки Singleton* убраны, владелец 1000:1000, источник не тронут.
 * Без docker или без образа (MEATSUIT_MIGRATE_IMAGE, по умолчанию образ зеркала) части с docker пропускаются:
 * образ тест не скачивает.
 *
 *   node test/migrate-profile.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'docker', 'migrate-profile.sh');
const IMAGE = process.env.MEATSUIT_MIGRATE_IMAGE || 'ghcr.io/m1k1o/neko/google-chrome:3.1.6';
const docker = (...args) => spawnSync('docker', args, { encoding: 'utf8' });
const noDocker = docker('version').status !== 0 ? 'нет docker'
  : docker('image', 'inspect', IMAGE).status !== 0 ? `нет образа ${IMAGE}: docker pull ${IMAGE} или MEATSUIT_MIGRATE_IMAGE` : false;
const migrate = (...args) => spawnSync('sh', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, MEATSUIT_MIGRATE_IMAGE: IMAGE } });

const PREFIX = `msupgrade-test-${process.pid}-${Date.now().toString(36)}`;
let seq = 0;
/** Имена томов и контейнеров теста: после него удаляются сначала контейнеры, потом тома (занятый том не удалить). */
function namer(t) {
  const made = [];
  t.after(() => { for (const n of made) docker('rm', '-f', n); for (const n of made) docker('volume', 'rm', '-f', n); });
  return (kind) => { const n = `${PREFIX}-${++seq}-${kind}`; made.push(n); return n; };
}
/** sh в одноразовом контейнере, том в /v. */
function inVolume(vol, script, readonly = false) {
  const r = docker('run', '--rm', '--network', 'none', '--user', '0:0', '--entrypoint', 'sh',
    '--mount', `type=volume,src=${vol},dst=/v${readonly ? ',readonly' : ''}`, IMAGE, '-c', script);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
/** Что лежит в томе: «uid:gid тип путь [-> ссылка]» по строке, сортировано; содержимое файлов отдельно. */
const listing = (vol) => inVolume(vol, `cd /v && find . -exec stat -c '%u:%g %F %N' {} + | sort`, true).trimEnd().split('\n');
const exists = (vol) => docker('volume', 'inspect', vol).status === 0;

/** Профиль «как от старого зеркала»: часть файлов root, замки от контейнера с другим именем хоста. */
function oldProfile(name) {
  const vol = name('from');
  assert.equal(docker('volume', 'create', vol).status, 0);
  inVolume(vol, `mkdir -p '/v/Default/Local Storage/leveldb' && echo cookie > /v/Default/Cookies &&
    echo token > '/v/Default/Local Storage/leveldb/000003.log' && echo '{}' > '/v/Local State' &&
    ln -s '../Local State' /v/Default/link && ln -s otherhost-66 /v/SingletonLock && ln -s 4242 /v/SingletonCookie &&
    ln -s /tmp/x/SingletonSocket /v/SingletonSocket && chown -R 1000:1000 /v/Default && chown -h 1000:1000 /v/Singleton*`);
  return vol;
}

test('без тома, с лишним флагом или с одним томом дважды — отказ до docker', () => {
  for (const args of [[], ['--nope', 'a'], ['a', 'b', 'c']]) {
    const r = migrate(...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /использование: docker\/migrate-profile\.sh \[--plan\] \[--force\]/);
  }
  const same = migrate('meatsuit_profile');
  assert.equal(same.status, 1);
  assert.match(same.stderr, /один и тот же том meatsuit_profile/);
});

test('нет тома-источника — отказ', { skip: noDocker }, (t) => {
  const name = namer(t);
  const r = migrate(name('missing'), name('to'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /отказ: нет тома msupgrade-test-/);
});

test('--plan ничего не создаёт; копия как в источнике, без замков, владелец 1000:1000, источник не тронут', { skip: noDocker }, (t) => {
  const name = namer(t);
  const from = oldProfile(name);
  const to = name('to');
  const before = listing(from);

  const plan = migrate('--plan', from, to);
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(plan.stdout, new RegExp(`из тома: ${from} — только чтение, не меняется; записей 10,`));
  assert.match(plan.stdout, new RegExp(`в том: +${to} — нет, будет создан`));
  assert.match(plan.stdout, /--plan: ничего не сделано/);
  assert.ok(!exists(to), '--plan создал целевой том');

  const r = migrate(from, to);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`готово: в ${to} записей 7,`));
  const after = listing(to);
  assert.ok(after.every((l) => l.startsWith('1000:1000 ')), after.join('\n'));
  assert.ok(!after.some((l) => /Singleton/.test(l)), 'замки профиля остались');
  // всё, кроме замков и владельца, как в источнике: файлы, папки, ссылки с теми же целями
  const strip = (lines) => lines.filter((l) => !/Singleton/.test(l)).map((l) => l.replace(/^\d+:\d+ /, '')).sort();
  assert.deepEqual(strip(after), strip(before));
  assert.equal(inVolume(to, `cat /v/Default/Cookies '/v/Default/Local Storage/leveldb/000003.log' '/v/Default/link'`, true), 'cookie\ntoken\n{}\n');

  assert.deepEqual(listing(from), before, 'источник изменился');
  assert.ok(before.some((l) => l.startsWith('0:0 ') && l.includes("'./Local State'")), 'в источнике был файл root — проверка chown пуста');
});

test('непустой целевой том: без --force отказ и том не тронут, с --force очищен и заменён', { skip: noDocker }, (t) => {
  const name = namer(t);
  const from = oldProfile(name);
  const to = name('to');
  assert.equal(docker('volume', 'create', to).status, 0);
  inVolume(to, 'mkdir /v/state && echo old > /v/extra');
  const before = listing(to);

  for (const args of [[from, to], ['--plan', from, to]]) {
    const r = migrate(...args);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, new RegExp(`отказ: том ${to} не пуст \\(записей 2\\).*--force`));
    assert.deepEqual(listing(to), before);
  }
  const plan = migrate('--plan', '--force', from, to);
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(plan.stdout, /с --force будет очищен/);
  assert.deepEqual(listing(to), before, '--plan --force тронул том');

  const r = migrate('--force', from, to);
  assert.equal(r.status, 0, r.stderr);
  const after = listing(to);
  assert.ok(!after.some((l) => /extra|state/.test(l)), 'прежнее содержимое осталось');
  assert.ok(after.some((l) => l.includes("'./Default/Cookies'")));
});

test('том у работающего контейнера (источник или цель) — отказ с его именем, внутрь не смотрит', { skip: noDocker }, (t) => {
  const name = namer(t);
  const from = oldProfile(name);
  const to = name('to');
  const sleeper = (vol) => {
    const c = name('busy');
    const r = docker('run', '-d', '--name', c, '--network', 'none', '--entrypoint', 'sleep', '--mount', `type=volume,src=${vol},dst=/v,readonly`, IMAGE, '300');
    assert.equal(r.status, 0, r.stderr);
    return c;
  };

  let c = sleeper(from);
  let r = migrate(from, to);
  assert.equal(r.status, 1);
  assert.match(r.stdout, new RegExp(`из тома: ${from} — подключён к работающим контейнерам: ${c}$`, 'm'));
  assert.match(r.stderr, new RegExp(`отказ: том ${from} подключён к работающим контейнерам: ${c}\\. Остановите`));
  assert.ok(!exists(to), 'при отказе целевой том создан');
  docker('rm', '-f', c);

  assert.equal(docker('volume', 'create', to).status, 0);
  c = sleeper(to);
  r = migrate(from, to);
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`отказ: том ${to} подключён к работающим контейнерам: ${c}\\.`));
  assert.deepEqual(listing(to), ['0:0 directory \'.\''], 'целевой том тронут');
});
