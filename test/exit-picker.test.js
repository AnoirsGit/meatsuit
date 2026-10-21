/**
 * Выбор exit node по списку (docker/egress/exit-picker.sh) на подставных tailscale, wget и iptables.
 * Мир — JSON в каталоге теста: узлы tailnet, какой выбран, что видят сервисы-эхо через каждый узел.
 * Настоящего Tailscale и сети тут нет: что tailscale set и проверка через туннель ведут себя так же в контейнере,
 * проверяется только на сервере (docs/egress.md, «Verify»).
 *
 *   node --test test/exit-picker.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'docker', 'egress', 'exit-picker.sh');
const NODE = process.execPath;
const TOOLS = ['cat', 'tr', 'awk', 'sed', 'head', 'cut', 'mkdir', 'rm', 'sleep'];

// Адреса узлов — TEST-NET-1 (RFC 5737): разбору всё равно, а настоящие 100.x тут были бы похожи на утечку.
const PHONE = { ip: '192.0.2.2', dns: 'home-phone.tailnet.example.', host: 'OPPO-A57', online: true, opt: true };
const PC = { ip: '192.0.2.3', dns: 'anoir-pc.tailnet.example.', host: 'anoir-pc', online: true, opt: true };
const LAPTOP = { ip: '192.0.2.4', dns: 'laptop.tailnet.example.', host: 'laptop', online: true, opt: false };
// Документационные номера (RFC 5398): домашний провайдер и мобильный оператор
const HOME = { ipinfo: { ip: '203.0.113.7', country: 'KZ', org: 'AS64500 Home ISP' }, ipwho: { success: true, country_code: 'KZ', connection: { asn: 64500 } } };
const MOBILE = { ipinfo: { ip: '198.51.100.9', country: 'KZ', org: 'AS64501 Mobile' }, ipwho: { success: true, country_code: 'KZ', connection: { asn: 64501 } } };

/** Статус как у tailscale status --json (json.MarshalIndent: ключ на строку), с вложенными объектами для разбора. */
function statusJson(w) {
  const peer = (p) => ({
    ID: 'n' + p.ip, PublicKey: 'nodekey:' + p.ip, HostName: p.host, DNSName: p.dns, OS: 'android', UserID: 1,
    TailscaleIPs: [p.ip, 'fd7a:115c:a1e0::' + p.ip.split('.').pop()], AllowedIPs: [p.ip + '/32'],
    Location: { Country: 'x', City: '{not a brace}' }, Online: p.online, ExitNode: w.selected === p.ip, ExitNodeOption: p.opt, Active: true,
  });
  const st = {
    Version: '1.102.5', BackendState: w.running === false ? 'Starting' : 'Running',
    Self: { ID: 'self', HostName: 'meatsuit', DNSName: 'meatsuit.tailnet.example.', TailscaleIPs: ['192.0.2.1'], Online: true, ExitNode: false, ExitNodeOption: true },
    Peer: Object.fromEntries(w.peers.map((p) => ['nodekey:' + p.ip, peer(p)])),
    User: { 1: { ID: 1, LoginName: 'owner@example.com' } },
  };
  const ex = w.peers.find((p) => p.ip === w.selected);
  if (ex) st.ExitNodeStatus = { ID: 'n' + ex.ip, Online: ex.online, TailscaleIPs: [ex.ip + '/32'] };
  return JSON.stringify(st, null, 2);
}

const FAKES = {
  tailscale: `
const fs = require('fs'); const W = process.env.FAKE_WORLD; const w = JSON.parse(fs.readFileSync(W, 'utf8'));
const a = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, 'tailscale ' + a.join(' ') + '\\n');
if (a[0] === 'status') { process.stdout.write(require(process.env.FAKE_LIB).statusJson(w) + '\\n'); process.exit(0); }
if (a[0] === 'set') { const m = /^--exit-node=(.*)$/.exec(a[1]); w.selected = m[1]; fs.writeFileSync(W, JSON.stringify(w)); process.exit(0); }
process.exit(1);`,
  wget: `
const fs = require('fs'); const w = JSON.parse(fs.readFileSync(process.env.FAKE_WORLD, 'utf8'));
const url = process.argv[process.argv.length - 1];
fs.appendFileSync(process.env.FAKE_LOG, 'wget ' + url + '\\n');
const seen = (w.egress[w.selected] || {})[url.includes('ipinfo') ? 'ipinfo' : 'ipwho'];
if (!seen) process.exit(4);
process.stdout.write(url.includes('ipinfo') ? JSON.stringify(seen, null, 2) : JSON.stringify(seen));`,
  iptables: `
const fs = require('fs'); const f = process.env.FAKE_RULES + '.' + require('path').basename(process.argv[1]);
const rules = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : [];
const [op, chain, ...rest] = process.argv.slice(2); const spec = (op === '-I' ? rest.slice(1) : rest).join(' ');
fs.appendFileSync(process.env.FAKE_LOG, require('path').basename(process.argv[1]) + ' ' + process.argv.slice(2).join(' ') + '\\n');
if (op === '-C') process.exit(rules.includes(spec) ? 0 : 1);
if (op === '-I') rules.unshift(spec);
if (op === '-D') { const i = rules.indexOf(spec); if (i < 0) process.exit(1); rules.splice(i, 1); }
fs.writeFileSync(f, JSON.stringify(rules));`,
};

/** Песочница: каталог с подставными командами и миром; run(mode, env) — запуск скрипта. */
function sandbox(t, world, { ip6 = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-exitpick-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const lib = path.join(dir, 'lib.js');
  fs.writeFileSync(lib, `module.exports.statusJson = ${statusJson.toString()};\n`);
  for (const [name, body] of Object.entries(FAKES)) fs.writeFileSync(path.join(bin, name), `#!${NODE}\n${body}\n`, { mode: 0o755 });
  if (ip6) fs.copyFileSync(path.join(bin, 'iptables'), path.join(bin, 'ip6tables'));
  // PATH — только этот каталог: настоящие iptables и ip6tables системы не должны подвернуться под руку
  for (const tool of TOOLS) {
    const real = spawnSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    assert.ok(real, `нет ${tool}`);
    fs.symlinkSync(real, path.join(bin, tool));
  }
  const files = { world: path.join(dir, 'world.json'), log: path.join(dir, 'log'), rules: path.join(dir, 'rules'), state: path.join(dir, 'state') };
  fs.writeFileSync(files.world, JSON.stringify({ selected: null, egress: {}, ...world }));
  fs.writeFileSync(files.log, '');
  const base = {
    PATH: bin, FAKE_WORLD: files.world, FAKE_LOG: files.log, FAKE_RULES: files.rules, FAKE_LIB: lib,
    EXIT_PICKER_STATE: files.state, EXIT_PICKER_SETTLE: '0', MEATSUIT_EXIT_NODES: 'home-phone,anoir-pc',
  };
  const sb = {
    dir, files,
    run: (args, env = {}) => spawnSync('/bin/sh', [SCRIPT, ...args], { env: { ...base, ...env }, encoding: 'utf8' }),
    world: () => JSON.parse(fs.readFileSync(files.world, 'utf8')),
    edit: (fn) => { const w = sb.world(); fn(w); fs.writeFileSync(files.world, JSON.stringify(w)); },
    peer: (ip, patch) => sb.edit((w) => Object.assign(w.peers.find((p) => p.ip === ip), patch)),
    log: () => fs.readFileSync(files.log, 'utf8').trim().split('\n').filter(Boolean),
    sets: () => sb.log().filter((l) => l.startsWith('tailscale set')),
    rules: (tool = 'iptables') => (fs.existsSync(`${files.rules}.${tool}`) ? JSON.parse(fs.readFileSync(`${files.rules}.${tool}`, 'utf8')) : []),
    gate: () => { try { return fs.readFileSync(path.join(files.state, 'gate'), 'utf8').trim(); } catch { return null; } },
    clearLog: () => fs.writeFileSync(files.log, ''),
  };
  return sb;
}

const PROBE = { MEATSUIT_EXIT_COUNTRY: 'kz', MEATSUIT_EXIT_ASN: '64500' };
const once = (sb, env = {}) => { const r = sb.run(['once'], env); assert.equal(r.status, 0, r.stderr); return r; };
const GATE4 = '-o tailscale0 ! -d 100.64.0.0/10 -m owner ! --uid-owner 0 -m conntrack --ctstate NEW -j REJECT';

test('без проверки: берёт первый узел из списка в сети, по IP, с доступом к LAN; iptables не трогает', (t) => {
  const sb = sandbox(t, { peers: [PHONE, PC] });
  once(sb);
  assert.deepEqual(sb.sets(), ['tailscale set --exit-node=192.0.2.2 --exit-node-allow-lan-access=true']);
  assert.equal(sb.world().selected, PHONE.ip);
  assert.ok(!sb.log().some((l) => l.startsWith('iptables')), 'ворот без проверки нет');
  sb.clearLog();
  once(sb);
  assert.deepEqual(sb.sets(), [], 'уже выбран — повторно не ставит');
});

test('имена: первая часть MagicDNS, полное имя, HostName и 100.x без учёта регистра; узел без exit node и Self не берутся', (t) => {
  for (const name of ['HOME-PHONE', 'home-phone.tailnet.example', 'oppo-a57', '192.0.2.2']) {
    const sb = sandbox(t, { peers: [PC, PHONE] });
    once(sb, { MEATSUIT_EXIT_NODES: `${name},anoir-pc` });
    assert.equal(sb.world().selected, PHONE.ip, name);
  }
  const sb = sandbox(t, { peers: [LAPTOP, PC] });
  const r = once(sb, { MEATSUIT_EXIT_NODES: 'laptop,meatsuit,anoir-pc' });
  assert.equal(sb.world().selected, PC.ip);
  assert.match(r.stderr, /laptop: не предлагает себя как exit node/);
  assert.match(r.stderr, /meatsuit: нет такого узла/);
});

test('Tailscale ещё не вошёл: ничего не делает', (t) => {
  const sb = sandbox(t, { peers: [PHONE, PC], running: false });
  once(sb, PROBE);
  assert.deepEqual(sb.sets(), []);
  assert.equal(sb.gate(), null);
});

test('телефон пропал: уходит на anoir-pc только после MEATSUIT_EXIT_DOWN_AFTER шагов, возвращается после RETURN_AFTER', (t) => {
  const sb = sandbox(t, { peers: [PHONE, PC] });
  const env = { MEATSUIT_EXIT_DOWN_AFTER: '2', MEATSUIT_EXIT_RETURN_AFTER: '3' };
  once(sb, env);
  assert.equal(sb.world().selected, PHONE.ip);
  sb.peer(PHONE.ip, { online: false });
  once(sb, env);
  assert.equal(sb.world().selected, PHONE.ip, 'один шаг офлайн — ещё ждём');
  once(sb, env);
  assert.equal(sb.world().selected, PC.ip, 'второй — запасной');
  sb.peer(PHONE.ip, { online: true });
  once(sb, env);
  once(sb, env);
  assert.equal(sb.world().selected, PC.ip, 'телефон в сети два шага — рано');
  once(sb, env);
  assert.equal(sb.world().selected, PHONE.ip, 'три шага — вернулся на телефон');
});

test('никого нет в сети: exit node не снимается (без него браузер и так без сети), сообщение одно', (t) => {
  const sb = sandbox(t, { peers: [{ ...PHONE, online: false }, { ...PC, online: false }], selected: PC.ip });
  const r1 = once(sb, { MEATSUIT_EXIT_DOWN_AFTER: '1' });
  const r2 = once(sb, { MEATSUIT_EXIT_DOWN_AFTER: '1' });
  assert.deepEqual(sb.sets(), []);
  assert.ok(!sb.log().some((l) => /--exit-node=( |$)/.test(l)), 'никогда не --exit-node= пустой');
  assert.match(r1.stderr, /годного exit node нет/);
  assert.doesNotMatch(r2.stderr, /годного exit node нет/);
});

test('с проверкой: ворота закрыты до проверки, телефон дома (AS64500, KZ) — открыты', (t) => {
  const sb = sandbox(t, { peers: [PHONE, PC], egress: { [PHONE.ip]: HOME, [PC.ip]: HOME } });
  once(sb, PROBE);
  assert.equal(sb.world().selected, PHONE.ip);
  assert.equal(sb.gate(), 'open');
  assert.deepEqual(sb.rules(), []);
  const log = sb.log();
  const iClose = log.findIndex((l) => l.startsWith('iptables -I OUTPUT 1'));
  const iSet = log.findIndex((l) => l.startsWith('tailscale set'));
  const iProbe = log.findIndex((l) => l.startsWith('wget'));
  const iOpen = log.findIndex((l) => l.startsWith('iptables -D OUTPUT'));
  assert.ok(iClose >= 0 && iClose < iSet && iSet < iProbe && iProbe < iOpen, log.join('\n'));
  assert.equal(log[iClose], `iptables -I OUTPUT 1 ${GATE4}`);
});

test('телефон на мобильных данных (чужой AS): бракуется, выход через anoir-pc; без ASN в списке — тоже ok по стране', (t) => {
  const sb = sandbox(t, { peers: [PHONE, PC], egress: { [PHONE.ip]: MOBILE, [PC.ip]: HOME } });
  const r = once(sb, PROBE);
  assert.equal(sb.world().selected, PC.ip);
  assert.equal(sb.gate(), 'open');
  assert.match(r.stderr, /home-phone: wrong \(страна KZ, AS 64501, ipinfo\)/);
  // пока телефон забракован, вернуться на него нельзя, даже если он стабильно в сети
  for (let i = 0; i < 5; i++) once(sb, { ...PROBE, MEATSUIT_EXIT_RETURN_AFTER: '1', MEATSUIT_EXIT_PROBE_EVERY: '10' });
  assert.equal(sb.world().selected, PC.ip);

  const country = sandbox(t, { peers: [PHONE, PC], egress: { [PHONE.ip]: MOBILE } });
  once(country, { MEATSUIT_EXIT_COUNTRY: 'KZ' });
  assert.equal(country.world().selected, PHONE.ip);
  assert.equal(country.gate(), 'open');
});

test('ни один узел не прошёл проверку: ворота закрыты (healthcheck красный), правило первое и для IPv6', (t) => {
  const sb = sandbox(t, { peers: [PHONE, PC], egress: { [PHONE.ip]: MOBILE, [PC.ip]: { ipinfo: { country: 'DE', org: 'AS64502 X' } } } }, { ip6: true });
  const r = once(sb, PROBE);
  assert.equal(sb.gate(), 'closed');
  assert.deepEqual(sb.rules(), [GATE4]);
  assert.deepEqual(sb.rules('ip6tables'), [GATE4.replace('100.64.0.0/10', 'fd7a:115c:a1e0::/48')]);
  assert.match(r.stderr, /годного exit node нет/);
  assert.match(r.stderr, /anoir-pc: wrong \(страна DE/);
});

test('сервис-эхо: ipinfo молчит — ipwho.is; оба молчат или нет провайдера при заданном ASN — unknown, ворота закрыты', (t) => {
  const fallback = sandbox(t, { peers: [PHONE], egress: { [PHONE.ip]: { ipinfo: null, ipwho: HOME.ipwho } } });
  once(fallback, { ...PROBE, MEATSUIT_EXIT_NODES: 'home-phone' });
  assert.equal(fallback.gate(), 'open');

  const silent = sandbox(t, { peers: [PHONE], egress: {} });
  const r = once(silent, { ...PROBE, MEATSUIT_EXIT_NODES: 'home-phone' });
  assert.equal(silent.gate(), 'closed');
  assert.match(r.stderr, /unknown/);

  const noOrg = sandbox(t, { peers: [PHONE], egress: { [PHONE.ip]: { ipinfo: { country: 'KZ' }, ipwho: { success: true, country_code: 'KZ', connection: {} } } } });
  once(noOrg, { ...PROBE, MEATSUIT_EXIT_NODES: 'home-phone' });
  assert.equal(noOrg.gate(), 'closed');
});

test('проверка идёт раз в MEATSUIT_EXIT_PROBE_EVERY шагов; выход сменился посреди — уходит на запасной', (t) => {
  const sb = sandbox(t, { peers: [PHONE, PC], egress: { [PHONE.ip]: HOME, [PC.ip]: HOME } });
  const env = { ...PROBE, MEATSUIT_EXIT_PROBE_EVERY: '3' };
  once(sb, env); // шаг 1: смена + проверка
  sb.clearLog();
  once(sb, env); // шаг 2: без проверки
  assert.ok(!sb.log().some((l) => l.startsWith('wget')));
  sb.edit((w) => { w.egress[PHONE.ip] = MOBILE; }); // Wi-Fi у телефона отвалился, он ушёл в мобильную сеть
  once(sb, env); // шаг 3: проверка, брак
  assert.equal(sb.world().selected, PC.ip);
  assert.equal(sb.gate(), 'open');
});

test('launch: без MEATSUIT_EXIT_NODES — просто exec команды, как раньше; с проверкой — ворота до команды, цикл в фоне', async (t) => {
  const plain = sandbox(t, { peers: [PHONE, PC] });
  const marker = path.join(plain.dir, 'ran');
  const r = plain.run(['launch', '/bin/sh', '-c', `echo ok > "${marker}"`], { MEATSUIT_EXIT_NODES: '' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'ok');
  assert.deepEqual(plain.log(), []);

  const sb = sandbox(t, { peers: [PHONE, PC], egress: { [PHONE.ip]: HOME } });
  const seen = path.join(sb.dir, 'seen');
  const r2 = sb.run(['launch', '/bin/sh', '-c', `cat "${sb.files.rules}.iptables" > "${seen}"`],
    { ...PROBE, EXIT_PICKER_TICKS: '1', MEATSUIT_EXIT_INTERVAL: '0' });
  assert.equal(r2.status, 0, r2.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(seen, 'utf8')), [GATE4], 'команда стартует уже за закрытыми воротами');
  for (let i = 0; i < 100 && sb.gate() !== 'open'; i++) await new Promise((res) => setTimeout(res, 50));
  assert.equal(sb.gate(), 'open', 'фоновый шаг проверил выход и открыл ворота');
  assert.equal(sb.world().selected, PHONE.ip);
});

test('status: таблица узлов, выбранный и ворота', (t) => {
  const sb = sandbox(t, { peers: [PHONE, PC], egress: { [PHONE.ip]: MOBILE, [PC.ip]: HOME } });
  once(sb, PROBE);
  const r = sb.run(['status'], PROBE);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.match(lines[1], /^1\s+home-phone\s+192\.0\.2\.2\s+yes\s+-\s+wrong KZ 64501 ipinfo/);
  assert.match(lines[2], /^2\s+anoir-pc\s+192\.0\.2\.3\s+yes\s+yes\s+ok KZ 64500 ipinfo/);
  assert.equal(lines[3], 'gate: open');
  assert.match(sb.run(['status'], { MEATSUIT_EXIT_NODES: '' }).stdout, /TS_EXTRA_ARGS/);
});
