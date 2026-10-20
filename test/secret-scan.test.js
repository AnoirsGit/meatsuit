/**
 * tools/secret-scan.sh: находит секреты и личное по содержимому и по имени файла, не находит учебное
 * и заглушки, не печатает найденные значения, смотрит рабочее дерево, индекс (pre-commit) и историю.
 * Образцы секретов собираются из кусков во время теста, чтобы сам этот файл скан не находил.
 *
 *   node --test test/secret-scan.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCAN = path.join(__dirname, '..', 'tools', 'secret-scan.sh');
const INSTALL = path.join(__dirname, '..', 'tools', 'hooks', 'install.sh');
const j = (...parts) => parts.join('');

function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-scan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => {
    const r = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
    return r;
  };
  git('init', '-q');
  const write = (name, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  };
  const scan = (...args) => spawnSync('sh', [SCAN, ...args], { cwd: dir, encoding: 'utf8' });
  return { dir, git, write, scan };
}

/** Строки находок «файл:строка: правило» без префикса. */
const findings = (r) => r.stdout.split('\n').filter((l) => l.startsWith('secret-scan: ') && !l.includes('чисто')).map((l) => l.slice(13));

const SECRETS = {
  'private-key': j('-----BEGIN ', 'OPENSSH PRIVATE KEY-----'),
  'telegram-bot-token': j('bot = "', '123456789', ':', 'AA', 'x'.repeat(33), '"'),
  'aws-key': j('key: ', 'AKIA', 'ABCDEFGHIJKLMNOP'),
  'github-token': j('ghp_', 'a'.repeat(36)),
  'gitlab-token': j('glpat-', 'a'.repeat(20)),
  'npm-token': j('//registry.npmjs.org/:_authToken=', 'npm_', 'b'.repeat(36)),
  'llm-api-key': j('apiKey: "', 'sk-', 'ant-', 'c'.repeat(30), '"'),
  'slack-token': j('xox', 'b-', '1234567890-abcdef'),
  'google-api-key': j('AIza', 'S'.repeat(35)),
  'stripe-key': j('sk_', 'live_', 'd'.repeat(24)),
  'tailscale-key': j('auth: ', 'tskey-', 'auth-', 'kAbc123DEF456'),
  jwt: j('eyJ', 'hbGciOiJIUzI1NiJ9', '.', 'eyJ', 'zdWIiOiIxMjM0In0', '.', 'abcdefghijklmnop'),
  'neko-password': j('NEKO_ADMIN_', 'PASSWORD=', 'hunter2hunter2'),
  'env-secret': j('DEEPSEEK_API', '_KEY=', 'abcdef0123456789'),
  'tailnet-name': j('open http://my-laptop.tail', '1234', '.ts', '.net:8080'),
  'tailnet-ip': j('NEKO_BIND_IP=', '100.', '101.', '2.3'),
  'real-asn': j('org: "A', 'S', '9198 Some ISP"'),
  'ssh-host': j('ssh ', 'root@', 'homebox'),
};

test('находит каждое правило по содержимому и называет его; значение не печатает', (t) => {
  const r0 = repo(t);
  for (const [rule, text] of Object.entries(SECRETS)) r0.write(`src/${rule}.txt`, `первая строка\n${text}\n`);
  const r = r0.scan();
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const got = findings(r);
  for (const rule of Object.keys(SECRETS)) assert.ok(got.includes(`src/${rule}.txt:2: ${rule}`), `нет находки ${rule}: ${got.join(' | ')}`);
  for (const text of Object.values(SECRETS)) {
    const core = text.replace(/^[^=:]*[=:] ?"?/, '').slice(0, 12);
    assert.ok(!r.stdout.includes(core) && !r.stderr.includes(core), `значение напечатано: ${core}`);
  }
  assert.match(r.stderr, /значения не печатаются/);
});

test('ASN в поле asn: настоящий находит, учебные и частные пропускает', (t) => {
  const r0 = repo(t);
  r0.write('real.json', j('{"country":"DE","as', 'n":[', '64500, ', '9198', ']}\n'));
  r0.write('doc.json', j('{"as', 'n": [64496, 64511, 65551]}\n', 'org: "AS', '64500 Example", "AS', '4200000001"\n'));
  const got = findings(r0.scan());
  assert.deepEqual(got, ['real.json:1: real-asn']);
});

test('не находит заглушки, учебные адреса, ссылки на переменные и служебные адреса', (t) => {
  const r0 = repo(t);
  r0.write('docker/.env.example', 'NEKO_PASSWORD=\nNEKO_ADMIN_PASSWORD=\nTELEGRAM_BOT_TOKEN=\n');
  r0.write('compose.yml', 'NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD: ${NEKO_ADMIN_PASSWORD:?нужен}\n');
  r0.write('docs.md', [
    'NEKO_PASSWORD=<пароль>  или NEKO_PASSWORD=… или NEKO_PASSWORD=$(openssl rand -hex 16)',
    'TOKEN=...   # из clients.json',
    'адрес tailnet хоста (100.x.y.z), диапазон 100.64.0.0/10, служебный DNS 100.100.100.100, чужой 100.200.1.1',
    'ssh user@<сервер>; ssh root@example.com; ssh -p 22 me@203.0.113.7',
    'имена *.ts.net в доках не нужны',
    "const TOKEN = '123456:SECRET-token_abc'; task-abcdefghijklmnopqrstuvwxyz",
    j('integrity sha512-abc/A', 'S1234xyz+def=='),
    'TS_EXTRA_ARGS=--exit-node=<имя узла>',
  ].join('\n'));
  r0.write('profiles/sites.example.json', '{}\n');
  const r = r0.scan();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /secret-scan: чисто \(tree\)/);
});

test('по имени: файлы окружения, личные конфиги, записки агентов, архивы и ключи', (t) => {
  const r0 = repo(t);
  const bad = {
    '.env': 'env-file', 'docker/.env.local': 'env-file', 'profiles/egress.json': 'personal-config', 'profiles/clients.json': 'personal-config',
    'sites.json': 'personal-config', 'jobs.json': 'personal-config', 'extras/life.json': 'personal-config', '.handoff-07/notes.md': 'handoff-notes',
    'backup.tgz': 'archive', 'dump.zip': 'archive', 'id_ed25519': 'key-file', 'certs/server.pem': 'key-file',
  };
  for (const name of Object.keys(bad)) r0.write(name, 'x\n');
  for (const name of ['.env.example', 'docker/.env.example', 'profiles/sites.example.json', 'sites.example.json']) r0.write(name, 'x\n');
  const got = findings(r0.scan()).sort();
  assert.deepEqual(got, Object.entries(bad).map(([f, rule]) => `${f}: ${rule}`).sort());
});

test('игнорируемые файлы (.gitignore) в рабочем дереве не смотрит; отслеживаемые смотрит всегда', (t) => {
  const r0 = repo(t);
  r0.write('.gitignore', 'docker/.env\n');
  r0.write('docker/.env', j('NEKO_', 'PASSWORD=', 'abcdef0123456789abcdef\n'));
  r0.write('new.txt', j('glpat-', 'f'.repeat(20), '\n')); // новый, не игнорируемый
  assert.deepEqual(findings(r0.scan()), ['new.txt:1: gitlab-token']);
  fs.rmSync(path.join(r0.dir, 'new.txt'));
  assert.equal(r0.scan().status, 0);
  r0.git('add', '-f', 'docker/.env');
  const got = findings(r0.scan());
  assert.ok(got.includes('docker/.env: env-file') && got.includes('docker/.env:1: neko-password'), got.join(' | '));
});

test('личные слова из .secret-scan.local: находит без учёта регистра, сам файл не находит', (t) => {
  const r0 = repo(t);
  r0.write('.gitignore', '.secret-scan.local\n');
  r0.write('.secret-scan.local', '# мой город и машины\nGotham\n\nbatcave-pc\n');
  r0.write('docs/notes.md', 'живу в gotham\nсервер BATCAVE-PC\nничего\n');
  const got = findings(r0.scan()).sort();
  assert.deepEqual(got, ['docs/notes.md:1: personal (.secret-scan.local)', 'docs/notes.md:2: personal (.secret-scan.local)']);
});

test('--staged смотрит индекс: незакоммиченное в рабочем дереве не мешает, добавленное ловит', (t) => {
  const r0 = repo(t);
  r0.write('ok.txt', 'ничего\n');
  r0.git('add', 'ok.txt');
  r0.write('ok.txt', j('ghp_', 'e'.repeat(36), '\n')); // правка не добавлена в индекс
  assert.equal(r0.scan('--staged').status, 0);
  r0.git('add', 'ok.txt');
  assert.deepEqual(findings(r0.scan('--staged')), ['ok.txt:1: github-token']);
});

test('--history находит секрет, удалённый из дерева, и личный файл из старого коммита', (t) => {
  const r0 = repo(t);
  r0.write('a.txt', j('xox', 'p-', '1234567890-abcdef\n'));
  r0.write('profiles/life.json', '{}\n');
  r0.git('add', '-A'); r0.git('commit', '-q', '-m', 'one');
  r0.git('rm', '-q', 'a.txt', 'profiles/life.json'); r0.write('b.txt', 'ничего\n'); r0.git('add', '-A'); r0.git('commit', '-q', '-m', 'two');
  assert.equal(r0.scan().status, 0, 'в дереве уже чисто');
  const r = r0.scan('--history');
  assert.equal(r.status, 1);
  const got = findings(r);
  assert.ok(got.some((l) => /^[0-9a-f]{12}:a\.txt:1: slack-token$/.test(l)), got.join(' | '));
  assert.ok(got.includes('profiles/life.json: personal-config'), got.join(' | '));
});

test('хук pre-commit (npm run hooks) не даёт закоммитить секрет и пропускает чистое; чужой хук не трогает', (t) => {
  const r0 = repo(t);
  // В временном репозитории нет tools/: кладём копию скана и хука, как в настоящем клоне.
  fs.mkdirSync(path.join(r0.dir, 'tools', 'hooks'), { recursive: true });
  for (const f of ['secret-scan.sh', 'hooks/pre-commit', 'hooks/install.sh']) fs.copyFileSync(path.join(__dirname, '..', 'tools', f), path.join(r0.dir, 'tools', f));
  const inst = spawnSync('sh', [INSTALL], { cwd: r0.dir, encoding: 'utf8' });
  assert.equal(inst.status, 0, inst.stderr);
  assert.equal(spawnSync('sh', [INSTALL], { cwd: r0.dir, encoding: 'utf8' }).status, 0, 'повторная установка своего хука проходит');

  r0.write('clean.txt', 'ничего\n');
  r0.git('add', '-A');
  const ok = r0.git('commit', '-q', '-m', 'clean');
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);

  r0.write('leak.txt', j('TELEGRAM_BOT_', 'TOKEN=', '42', ':abc\n'));
  r0.git('add', 'leak.txt');
  const bad = r0.git('commit', '-q', '-m', 'leak');
  assert.notEqual(bad.status, 0, 'коммит с секретом прошёл');
  assert.match(bad.stdout + bad.stderr, /leak\.txt:1: telegram-bot-token/); // вывод хука git отдаёт в stderr

  const hook = path.join(r0.dir, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, '#!/bin/sh\necho чужой\n');
  const again = spawnSync('sh', [INSTALL], { cwd: r0.dir, encoding: 'utf8' });
  assert.equal(again.status, 1);
  assert.equal(fs.readFileSync(hook, 'utf8'), '#!/bin/sh\necho чужой\n');
});

test('вне git-репозитория: код 2 и понятное сообщение', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-noscan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = spawnSync('sh', [SCAN], { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(dir) } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /не git-репозиторий/);
});
